"""Async worker state machine for Evaluator v2."""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from failproofai_sdk import __version__
from failproofai_sdk.evaluator.authoring import (
    ConditionResult,
    EvalDefinition,
    EvalResult,
    Evaluator,
)
from failproofai_sdk.evaluator.client import EvaluatorAPIError, EvaluatorClient
from failproofai_sdk.evaluator.protocol import (
    MAX_CLAIM_CAPACITY,
    MAX_CLAIM_WAIT_SECONDS,
    MAX_WORKER_ID_BYTES,
    Assignment,
    ClaimRequest,
    EvalSelection,
    HeartbeatRequest,
    HeartbeatRun,
    PlanRequest,
    RegisterRequest,
    ResultRequest,
    SkippedEval,
    TerminalRunStatus,
)

logger = logging.getLogger("failproofai_sdk.evaluator")


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


@dataclass(frozen=True)
class WorkerConfig:
    server_url: str
    credential: str
    worker_id: str
    max_concurrency: int = 1
    claim_wait_seconds: int = 20
    request_timeout_seconds: int = 30
    drain_timeout_seconds: int = 60

    @classmethod
    def from_env(cls) -> WorkerConfig:
        server_url = os.environ.get("FAILPROOFAI_EVALUATOR_URL", "").strip()
        credential = os.environ.get("FAILPROOFAI_EVALUATOR_TOKEN", "").strip()
        if not server_url:
            raise ValueError("FAILPROOFAI_EVALUATOR_URL is required")
        if not credential:
            raise ValueError("FAILPROOFAI_EVALUATOR_TOKEN is required")
        worker_id = os.environ.get("FAILPROOFAI_EVALUATOR_WORKER_ID", "").strip()
        if not worker_id:
            worker_id = f"{socket.gethostname()}-{os.getpid()}"
        if len(worker_id.encode("utf-8")) > MAX_WORKER_ID_BYTES:
            raise ValueError(
                f"FAILPROOFAI_EVALUATOR_WORKER_ID exceeds {MAX_WORKER_ID_BYTES} bytes"
            )
        if any(ord(character) < 32 or ord(character) == 127 for character in worker_id):
            raise ValueError(
                "FAILPROOFAI_EVALUATOR_WORKER_ID must not contain control characters"
            )
        config = cls(
            server_url=server_url,
            credential=credential,
            worker_id=worker_id,
            max_concurrency=_positive_int("FAILPROOFAI_EVALUATOR_CONCURRENCY", 1),
            claim_wait_seconds=_positive_int(
                "FAILPROOFAI_EVALUATOR_CLAIM_WAIT_SECONDS", 20
            ),
            request_timeout_seconds=_positive_int(
                "FAILPROOFAI_EVALUATOR_REQUEST_TIMEOUT_SECONDS", 30
            ),
            drain_timeout_seconds=_positive_int(
                "FAILPROOFAI_EVALUATOR_DRAIN_TIMEOUT_SECONDS", 60
            ),
        )
        if config.max_concurrency > MAX_CLAIM_CAPACITY:
            raise ValueError(
                f"FAILPROOFAI_EVALUATOR_CONCURRENCY exceeds {MAX_CLAIM_CAPACITY}"
            )
        if config.claim_wait_seconds > MAX_CLAIM_WAIT_SECONDS:
            raise ValueError(
                "FAILPROOFAI_EVALUATOR_CLAIM_WAIT_SECONDS exceeds "
                f"{MAX_CLAIM_WAIT_SECONDS}"
            )
        if config.request_timeout_seconds <= config.claim_wait_seconds:
            raise ValueError(
                "FAILPROOFAI_EVALUATOR_REQUEST_TIMEOUT_SECONDS must exceed "
                "FAILPROOFAI_EVALUATOR_CLAIM_WAIT_SECONDS"
            )
        return config


class WorkerRuntime:
    def __init__(
        self,
        evaluator: Evaluator,
        config: WorkerConfig,
        *,
        client: EvaluatorClient | None = None,
    ) -> None:
        self.evaluator = evaluator
        self.config = config
        self.client = client or EvaluatorClient(
            base_url=config.server_url,
            credential=config.credential,
            timeout_seconds=config.request_timeout_seconds,
        )
        self._stopping = asyncio.Event()
        self._active: set[asyncio.Task[None]] = set()
        self._heartbeat_interval = 30
        self._claim_limit = config.max_concurrency
        self._lease_duration = 120
        self._disabled_definitions: set[str] = set()
        self._eval_semaphore = asyncio.Semaphore(config.max_concurrency)
        self._registered = False
        self._last_server_contact: float | None = None
        self._metric_lock = threading.Lock()
        self._metrics: dict[str, int] = {}

    async def register(self) -> None:
        try:
            response = await self._call_client(
                self.client.register,
                RegisterRequest(
                    worker_id=self.config.worker_id,
                    sdk_version=__version__,
                    catalog_revision=self.evaluator.catalog_revision,
                    max_concurrency=self.config.max_concurrency,
                    definitions=self.evaluator.catalog(),
                ),
            )
        except Exception:
            self._increment("registration_failure")
            raise
        self._heartbeat_interval = response.heartbeat_interval_seconds
        self._lease_duration = response.lease_duration_seconds
        self._claim_limit = min(self.config.max_concurrency, response.claim_limit)
        if (
            self._heartbeat_interval <= 0
            or self._lease_duration <= self._heartbeat_interval
            or self._claim_limit <= 0
        ):
            self._increment("registration_failure")
            raise RuntimeError(
                "server returned invalid evaluator timing or claim limits"
            )
        self._disabled_definitions = set(response.disabled_definitions)
        self._registered = True
        self._increment("registration_success")

    async def run_forever(self) -> None:
        await self.register()
        while not self._stopping.is_set():
            self._reap_finished()
            capacity = self._claim_limit - len(self._active)
            if capacity <= 0:
                await self._wait_for_progress()
                continue
            try:
                response = await self._call_client(
                    self.client.claim,
                    ClaimRequest(
                        worker_id=self.config.worker_id,
                        catalog_revision=self.evaluator.catalog_revision,
                        capacity=capacity,
                        wait_seconds=self.config.claim_wait_seconds,
                    ),
                )
            except EvaluatorAPIError as error:
                self._increment("claim_failures")
                logger.warning(
                    "evaluator claim failed",
                    extra={"code": error.code, "retryable": error.retryable},
                )
                if not error.retryable:
                    raise
                # With a transport error the server may have committed the
                # lease while its response was lost. Waiting out that lease is
                # what prevents a blind second claim from exceeding capacity.
                await self._wait_or_stop(
                    float(self._lease_duration) if error.status is None else 1.0
                )
                continue
            assignments = self._validated_assignments(response.assignments, capacity)
            for assignment in assignments:
                task = asyncio.create_task(self.process_assignment(assignment))
                self._active.add(task)
            self._increment("assignments_claimed", len(assignments))

        await self.drain()

    async def run_once(self) -> int:
        """Claim once and finish the returned assignments; useful for jobs/tests."""
        response = await self._call_client(
            self.client.claim,
            ClaimRequest(
                worker_id=self.config.worker_id,
                catalog_revision=self.evaluator.catalog_revision,
                capacity=self._claim_limit,
                wait_seconds=self.config.claim_wait_seconds,
            ),
        )
        assignments = self._validated_assignments(
            response.assignments, self._claim_limit
        )
        self._increment("assignments_claimed", len(assignments))
        await asyncio.gather(*(self.process_assignment(item) for item in assignments))
        return len(assignments)

    def stop(self) -> None:
        self._stopping.set()

    async def drain(self) -> None:
        self._reap_finished()
        if not self._active:
            return
        done, pending = await asyncio.wait(
            self._active, timeout=self.config.drain_timeout_seconds
        )
        for task in done:
            self._consume_task(task)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._active.clear()

    async def process_assignment(self, assignment: Assignment) -> None:
        session = await self._call_client(
            self.client.transcript,
            assignment,
            worker_id=self.config.worker_id,
        )
        if session.session_revision_id != assignment.session_revision_id:
            raise RuntimeError("transcript session revision does not match assignment")

        selected: list[EvalDefinition] = []
        skipped: list[SkippedEval] = []
        for definition in self.evaluator.definitions:
            if definition.eval_key in self._disabled_definitions:
                skipped.append(self._skipped(definition, "disabled_by_server"))
                self._increment("conditions_skipped")
                continue
            if definition.condition is None:
                selected.append(definition)
                continue
            try:
                condition = await self._invoke(definition.condition, session)
                if isinstance(condition, ConditionResult):
                    applicable = condition.applicable
                    reason_code = condition.reason_code
                elif isinstance(condition, bool):
                    applicable = condition
                    reason_code = "condition_false"
                else:
                    raise TypeError("condition must return bool or ConditionResult")
            except Exception as error:  # noqa: BLE001 - isolates customer condition code
                logger.warning(
                    "evaluator condition failed",
                    extra={
                        "assignment_id": assignment.assignment_id,
                        "error_type": type(error).__name__,
                    },
                )
                skipped.append(self._skipped(definition, "condition_error"))
                self._increment("conditions_skipped")
                continue
            if applicable:
                selected.append(definition)
                self._increment("conditions_selected")
            else:
                skipped.append(self._skipped(definition, reason_code))
                self._increment("conditions_skipped")

        plan = await self._call_client(
            self.client.plan,
            assignment.assignment_id,
            PlanRequest(
                worker_id=self.config.worker_id,
                lease_generation=assignment.lease_generation,
                selected=tuple(
                    EvalSelection(item.eval_key, item.eval_version) for item in selected
                ),
                skipped=tuple(skipped),
            ),
        )
        if plan.assignment_id != assignment.assignment_id:
            raise RuntimeError("server returned a plan for a different assignment")
        expected_status = "planned" if selected else "skipped"
        if plan.assignment_status != expected_status:
            raise RuntimeError("server returned an inconsistent assignment status")

        definitions = {(item.eval_key, item.eval_version): item for item in selected}
        run_definitions: list[tuple[str, EvalDefinition]] = []
        run_ids: set[str] = set()
        for run in plan.runs:
            if run.evaluation_run_id in run_ids:
                raise RuntimeError("server returned a duplicate evaluation run id")
            run_ids.add(run.evaluation_run_id)
            definition = definitions.pop((run.eval_key, run.eval_version), None)
            if definition is None:
                raise RuntimeError("server returned an unrequested evaluation run")
            run_definitions.append((run.evaluation_run_id, definition))
        if definitions:
            raise RuntimeError("server omitted a selected evaluation run")

        tasks = {
            run_id: asyncio.create_task(
                self._execute_run(assignment, run_id, definition, session)
            )
            for run_id, definition in run_definitions
        }
        heartbeat = asyncio.create_task(self._heartbeat(assignment, tasks))
        try:
            outcomes = await asyncio.gather(*tasks.values(), return_exceptions=True)
            for outcome in outcomes:
                if isinstance(outcome, BaseException):
                    raise outcome
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)

    async def _execute_run(
        self,
        assignment: Assignment,
        run_id: str,
        definition: EvalDefinition,
        session: Any,
    ) -> None:
        async with self._eval_semaphore:
            await self._execute_run_in_slot(assignment, run_id, definition, session)

    async def _execute_run_in_slot(
        self,
        assignment: Assignment,
        run_id: str,
        definition: EvalDefinition,
        session: Any,
    ) -> None:
        started_at = _utc_now()
        started = time.monotonic()
        try:
            invocation = self._invoke(definition.function, session)
            result = (
                await asyncio.wait_for(invocation, timeout=definition.timeout_seconds)
                if definition.timeout_seconds is not None
                else await invocation
            )
            if not isinstance(result, EvalResult):
                raise TypeError("evaluation must return EvalResult")
            items = result.result_items(definition.eval_key)
            if not any(
                item.result_key == definition.eval_key
                and item.result_kind == definition.result_kind
                for item in items
            ):
                raise ValueError(
                    "evaluation result does not contain its declared primary result"
                )
            status = TerminalRunStatus.SUCCEEDED
            summary = result.summary
            error_code = None
            error_message = None
        except asyncio.TimeoutError:
            await self._cancel_hook(definition, session)
            items = ()
            status = TerminalRunStatus.TIMED_OUT
            summary = None
            error_code = "eval_timeout"
            error_message = "evaluation exceeded its configured timeout"
        except asyncio.CancelledError:
            await self._cancel_hook(definition, session)
            raise
        except Exception as error:  # noqa: BLE001 - converts customer eval failures
            items = ()
            status = TerminalRunStatus.FAILED
            summary = None
            error_code = "eval_error"
            error_message = f"evaluation raised {type(error).__name__}"

        request = ResultRequest(
            submission_id=str(uuid4()),
            worker_id=self.config.worker_id,
            lease_generation=assignment.lease_generation,
            status=status,
            started_at=started_at,
            finished_at=_utc_now(),
            duration_ms=max(0, round((time.monotonic() - started) * 1_000)),
            summary=summary,
            results=items,
            error_code=error_code,
            error_message=error_message,
        )
        await self._call_client(self.client.submit_result, run_id, request)
        self._increment(f"runs_{status.value}")

    async def _cancel_hook(self, definition: EvalDefinition, session: Any) -> None:
        if definition.on_cancel is None:
            return
        try:
            await self._invoke(definition.on_cancel, session)
        except Exception as error:  # noqa: BLE001 - cancellation hooks are customer code
            logger.warning(
                "evaluator cancellation hook failed",
                extra={"error_type": type(error).__name__},
            )

    async def _heartbeat(
        self,
        assignment: Assignment,
        tasks: dict[str, asyncio.Task[None]],
    ) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval)
            active = tuple(
                HeartbeatRun(evaluation_run_id=run_id, state="running")
                for run_id, task in tasks.items()
                if not task.done()
            )
            if not active:
                return
            try:
                response = await self._call_client(
                    self.client.heartbeat,
                    HeartbeatRequest(
                        worker_id=self.config.worker_id,
                        lease_generation=assignment.lease_generation,
                        runs=active,
                    ),
                )
                accepted = set(response.accepted_run_ids)
                for run_id, task in tasks.items():
                    if not task.done() and run_id not in accepted:
                        task.cancel()
            except EvaluatorAPIError as error:
                if error.code == "lease_lost":
                    self._increment("leases_lost")
                    for task in tasks.values():
                        task.cancel()
                    return
                logger.warning(
                    "evaluator heartbeat failed",
                    extra={
                        "assignment_id": assignment.assignment_id,
                        "code": error.code,
                    },
                )
                self._increment("heartbeat_failures")

    @staticmethod
    async def _invoke(function, session):
        if inspect.iscoroutinefunction(function):
            return await function(session)
        result = await asyncio.to_thread(function, session)
        if inspect.isawaitable(result):
            return await result
        return result

    @staticmethod
    def _skipped(definition: EvalDefinition, reason: str) -> SkippedEval:
        return SkippedEval(definition.eval_key, definition.eval_version, reason)

    def _reap_finished(self) -> None:
        done = {task for task in self._active if task.done()}
        self._active.difference_update(done)
        for task in done:
            self._consume_task(task)

    @staticmethod
    def _validated_assignments(
        assignments: tuple[Assignment, ...], capacity: int
    ) -> tuple[Assignment, ...]:
        if len(assignments) > capacity:
            raise RuntimeError("server returned more assignments than requested")
        assignment_ids = [item.assignment_id for item in assignments]
        if len(assignment_ids) != len(set(assignment_ids)):
            raise RuntimeError("server returned duplicate assignments")
        return assignments

    @staticmethod
    def _consume_task(task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("evaluator assignment failed")

    async def _wait_for_progress(self) -> None:
        if not self._active:
            return
        stop_task = asyncio.create_task(self._stopping.wait())
        try:
            await asyncio.wait(
                (*self._active, stop_task), return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            if not stop_task.done():
                stop_task.cancel()
                await asyncio.gather(stop_task, return_exceptions=True)

    async def _wait_or_stop(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _call_client(self, function, *args, **kwargs):
        result = await asyncio.to_thread(function, *args, **kwargs)
        self._last_server_contact = time.monotonic()
        return result

    def _increment(self, name: str, amount: int = 1) -> None:
        with self._metric_lock:
            self._metrics[name] = self._metrics.get(name, 0) + amount

    def metrics(self) -> dict[str, int]:
        with self._metric_lock:
            return dict(self._metrics)

    def is_ready(self) -> bool:
        if (
            self._stopping.is_set()
            or not self._registered
            or self._last_server_contact is None
        ):
            return False
        return time.monotonic() - self._last_server_contact <= max(
            float(self._lease_duration), 60.0
        )
