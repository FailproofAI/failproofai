"""Async worker state machine for Evaluator v2."""

from __future__ import annotations

import asyncio
import concurrent.futures
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
    DEFAULT_POLL_INTERVAL_SECONDS,
    MAX_CLAIM_CAPACITY,
    MAX_ERROR_MESSAGE_BYTES,
    MAX_WORKER_ID_BYTES,
    Assignment,
    AssignmentDefinition,
    ClaimRequest,
    EvalSelection,
    ExecutionMode,
    HeartbeatRequest,
    HeartbeatRun,
    PlanRequest,
    RegisterRequest,
    ResultRequest,
    SkippedEval,
    TerminalRunStatus,
)
from failproofai_sdk.evaluator.source import (
    EvaluationTimeout,
    UnsafeEvaluatorSource,
    compile_condition,
    compile_evaluator,
    source_checksum,
)

logger = logging.getLogger("failproofai_sdk.evaluator")

# A synchronous evaluator (or condition) that overruns its timeout cannot be
# cancelled: the executor thread runs the customer function to completion no
# matter what `asyncio.wait_for` does, because CPython cannot interrupt a running
# thread. To stop one such orphaned thread from starving live capacity, the eval
# executor is sized with headroom OVER the concurrency limit — the semaphore, not
# the thread pool, stays the real bound on how many evaluations run at once. This
# is a finite cushion, not a cure: a permanently-blocked synchronous evaluator
# invoked once per session leaks one thread per session, and no fixed pool
# survives that. `sync_evaluations_orphaned` and a warning make the offending
# evaluator findable; prefer `async def` evaluators (cooperatively cancellable) or
# managed PYTHON evaluators (subprocess-isolated, hard-killed) for long or
# untrusted work.
_EVAL_EXECUTOR_ORPHAN_HEADROOM = 8

# Reserved out of the lease for the plan request (and network jitter) so the
# pre-plan condition phase always leaves time to submit the plan before the lease
# expires. See `WorkerRuntime._condition_phase_deadline`.
_CONDITION_PHASE_SAFETY_MARGIN_SECONDS = 5.0

# Fallback wall-clock bound for an evaluation whose definition declares no
# `timeout_seconds`. A LOCAL (customer-authored) eval is a plain coroutine/thread
# with no sandbox backstop, so without this an eval that hangs — a wedged
# `await`, an unbounded judge HTTP call — runs forever, permanently wedging its
# worker slot and holding the assignment lease. Matches the storage contract's
# 5-minute per-eval default. (Managed evals are additionally hard-capped inside
# the fork sandbox, so this is only their outer bound.)
DEFAULT_EVAL_TIMEOUT_SECONDS = 300.0


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _deferred_managed_eval(source: str, timeout_seconds: int | None, eval_key: str):
    """Compile server-authored source lazily, at invocation time.

    Compilation can reject unsafe or malformed source (``UnsafeEvaluatorSource``).
    Building the definition with this thunk instead of a pre-compiled function
    routes that failure through the same per-run ``try/except`` that turns any
    evaluation error into a bounded ``FAILED`` result — so a poison definition
    dead-letters cleanly as one failed run instead of raising out of assignment
    setup, crashing the task, and forcing the whole assignment to be reclaimed
    and retried until its attempt budget is exhausted.
    """

    def evaluate(session: Any) -> Any:
        return compile_evaluator(
            source, timeout_seconds=timeout_seconds, eval_key=eval_key
        )(session)

    return evaluate


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


def _boolean(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


@dataclass(frozen=True)
class WorkerConfig:
    server_url: str
    credential: str
    worker_id: str
    max_concurrency: int = 1
    request_timeout_seconds: int = 30
    drain_timeout_seconds: int = 60
    allow_insecure_http: bool = False

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
            request_timeout_seconds=_positive_int(
                "FAILPROOFAI_EVALUATOR_REQUEST_TIMEOUT_SECONDS", 30
            ),
            drain_timeout_seconds=_positive_int(
                "FAILPROOFAI_EVALUATOR_DRAIN_TIMEOUT_SECONDS", 60
            ),
            allow_insecure_http=_boolean(
                "FAILPROOFAI_EVALUATOR_ALLOW_INSECURE_HTTP"
            ),
        )
        if config.max_concurrency > MAX_CLAIM_CAPACITY:
            raise ValueError(
                f"FAILPROOFAI_EVALUATOR_CONCURRENCY exceeds {MAX_CLAIM_CAPACITY}"
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
            allow_insecure_http=config.allow_insecure_http,
        )
        self._stopping = asyncio.Event()
        self._active: set[asyncio.Task[None]] = set()
        self._heartbeat_interval = 30
        self._poll_interval = DEFAULT_POLL_INTERVAL_SECONDS
        self._claim_limit = config.max_concurrency
        self._lease_duration = 120
        self._disabled_definitions: set[str] = set()
        self._eval_semaphore = asyncio.Semaphore(config.max_concurrency)
        # Headroom over the semaphore so a timed-out-but-still-running synchronous
        # evaluator (an unkillable orphaned thread) does not immediately starve
        # live capacity — the semaphore remains the true concurrency bound. See
        # `_EVAL_EXECUTOR_ORPHAN_HEADROOM`.
        self._eval_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=config.max_concurrency + _EVAL_EXECUTOR_ORPHAN_HEADROOM,
            thread_name_prefix="failproof-eval",
        )
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
        self._poll_interval = response.poll_interval_seconds
        self._lease_duration = response.lease_duration_seconds
        self._claim_limit = min(self.config.max_concurrency, response.claim_limit)
        if (
            self._heartbeat_interval <= 0
            or self._poll_interval <= 0
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
        retry_delay = 1.0
        try:
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
                    delay = (
                        float(self._lease_duration)
                        if error.status is None
                        else retry_delay
                    )
                    await self._wait_or_stop(delay)
                    retry_delay = min(retry_delay * 2.0, 30.0)
                    continue
                retry_delay = 1.0
                assignments = self._validated_assignments(
                    response.assignments, capacity
                )
                for assignment in assignments:
                    task = asyncio.create_task(self.process_assignment(assignment))
                    self._active.add(task)
                self._increment("assignments_claimed", len(assignments))
                if not assignments:
                    # Normal short poll: the server returns immediately, so when
                    # nothing is queued we wait the advertised interval before
                    # polling again instead of hot-looping. When work IS returned
                    # we loop straight back to drain any backlog up to capacity.
                    await self._wait_or_stop(float(self._poll_interval))
        finally:
            await self.drain()
            self._eval_executor.shutdown(wait=False, cancel_futures=True)

    async def run_once(self) -> int:
        """Claim once and finish the returned assignments; useful for jobs/tests."""
        response = await self._call_client(
            self.client.claim,
            ClaimRequest(
                worker_id=self.config.worker_id,
                catalog_revision=self.evaluator.catalog_revision,
                capacity=self._claim_limit,
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
        try:
            session = await self._call_client(
                self.client.transcript,
                assignment,
                worker_id=self.config.worker_id,
            )
        except EvaluatorAPIError as error:
            if error.code == "transcript_too_large":
                # The session transcript exceeds the hard ceiling. No runs are
                # planned yet, so there is nothing to submit a per-run result for,
                # and the error is non-retryable — re-raising would only wedge the
                # poll loop and burn the assignment's whole retry budget against a
                # transcript that can never shrink. Log and return; the server
                # terminalizes the assignment as `too_large`.
                logger.warning(
                    "assignment %s transcript is too large to evaluate; skipping",
                    assignment.assignment_id,
                )
                self._increment("transcripts_too_large")
                return
            raise
        if session.session_revision_id != assignment.session_revision_id:
            raise RuntimeError("transcript session revision does not match assignment")

        descriptors = await self._assignment_definitions(assignment)
        # Every descriptor the assignment carries, keyed for reconstruction: on an
        # idempotent replay the server re-serves the first attempt's run set, which
        # may include a run this attempt's re-derived plan would have skipped.
        descriptor_by_key = {
            (item.eval_key, item.eval_version): item for item in descriptors
        }
        selected: list[tuple[AssignmentDefinition, EvalDefinition | None]] = []
        skipped: list[SkippedEval] = []
        local_definitions = {
            (item.eval_key, item.eval_version): item
            for item in self.evaluator.definitions
        }
        # The assignment lease is fixed at claim time and cannot be renewed until
        # the plan is submitted (the server only extends a lease for a *planned*
        # assignment with running runs). A slow condition phase can therefore burn
        # the whole lease and get the plan fenced as lease_lost, so every
        # condition is bounded by the lease it must leave time to plan within.
        condition_deadline = self._condition_phase_deadline(assignment)
        for descriptor in descriptors:
            local = local_definitions.get(
                (descriptor.eval_key, descriptor.eval_version)
            )
            if descriptor.execution_mode is ExecutionMode.LOCAL and local is None:
                raise RuntimeError("server requested a definition absent from this worker")
            if descriptor.eval_key in self._disabled_definitions:
                skipped.append(self._skipped_descriptor(descriptor, "disabled_by_server"))
                self._increment("conditions_skipped")
                continue
            try:
                # Whose condition decides applicability follows the execution mode,
                # mirroring the evaluator branch below (`run.execution_mode`): a LOCAL
                # definition's condition is client-authored (`local.condition`); a
                # PYTHON (managed) definition's is server-authored and MUST govern even
                # when the worker also registered the same key/version locally. Keying
                # `local` on `(eval_key, eval_version)` alone means a managed def can
                # collide with a local one; selecting `local.condition` there would let
                # a matching local condition override the server's managed rule and run
                # the managed evaluator against the operator's intent (COR-001).
                # Compile INSIDE the try: a managed condition the sandbox rejects
                # (unsafe/malformed source) must dead-letter as `condition_error`,
                # not raise out of the plan loop and strand the whole assignment
                # until its retry budget is exhausted.
                managed_condition_source: str | None = None
                if descriptor.execution_mode is ExecutionMode.LOCAL:
                    condition_function = local.condition if local is not None else None
                elif descriptor.condition_source:
                    # Compiled below, once the lease budget is known, so the
                    # sandbox subprocess is bounded by whatever lease remains.
                    managed_condition_source = descriptor.condition_source
                    condition_function = None
                else:
                    condition_function = None
                if condition_function is None and managed_condition_source is None:
                    # No condition to run — applicable by default, no lease spent.
                    selected.append((descriptor, local))
                    continue
                budget = self._condition_budget(
                    condition_deadline, descriptor.timeout_seconds
                )
                if budget <= 0.0:
                    # Not enough lease left to evaluate this condition and still
                    # submit the plan in time; skip it (and, as the loop proceeds,
                    # every later condition) rather than do work the server will
                    # fence as lease_lost and reclaim in a loop.
                    skipped.append(
                        self._skipped_descriptor(descriptor, "lease_exhausted")
                    )
                    self._increment("conditions_skipped")
                    self._increment("conditions_lease_exhausted")
                    continue
                if managed_condition_source is not None:
                    condition_function = compile_condition(
                        managed_condition_source,
                        timeout_seconds=budget,
                    )
                condition = await asyncio.wait_for(
                    self._invoke(condition_function, session), timeout=budget
                )
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
                skipped.append(self._skipped_descriptor(descriptor, "condition_error"))
                self._increment("conditions_skipped")
                continue
            if applicable:
                selected.append((descriptor, local))
                self._increment("conditions_selected")
            else:
                skipped.append(self._skipped_descriptor(descriptor, reason_code))
                self._increment("conditions_skipped")

        plan = await self._call_client(
            self.client.plan,
            assignment.assignment_id,
            PlanRequest(
                worker_id=self.config.worker_id,
                lease_generation=assignment.lease_generation,
                selected=tuple(
                    EvalSelection(item.eval_key, item.eval_version)
                    for item, _local in selected
                ),
                skipped=tuple(skipped),
            ),
        )
        if plan.assignment_id != assignment.assignment_id:
            raise RuntimeError("server returned a plan for a different assignment")
        # On an idempotent replay the server's status is authoritative: this
        # attempt may have selected a different set than the first, so a mismatch
        # against our own `selected` is expected, not an error.
        if not plan.idempotent_replay:
            expected_status = "planned" if selected else "skipped"
            if plan.assignment_status != expected_status:
                raise RuntimeError("server returned an inconsistent assignment status")

        definitions = {
            (item.eval_key, item.eval_version): (item, local)
            for item, local in selected
        }
        run_definitions: list[tuple[str, EvalDefinition]] = []
        run_ids: set[str] = set()
        for run in plan.runs:
            if run.evaluation_run_id in run_ids:
                raise RuntimeError("server returned a duplicate evaluation run id")
            run_ids.add(run.evaluation_run_id)
            run_key = (run.eval_key, run.eval_version)
            selected_definition = definitions.pop(run_key, None)
            if selected_definition is None:
                # On an idempotent replay the server's run set is AUTHORITATIVE —
                # it re-serves the first attempt's runs even for a definition this
                # attempt's condition phase would have skipped. Reconstruct the
                # definition from the assignment's descriptors rather than raising
                # and dead-lettering an assignment that could otherwise never
                # converge (the divergence-abort bug).
                if plan.idempotent_replay:
                    replay_descriptor = descriptor_by_key.get(run_key)
                    if replay_descriptor is not None:
                        selected_definition = (
                            replay_descriptor,
                            local_definitions.get(run_key),
                        )
                if selected_definition is None:
                    raise RuntimeError("server returned an unrequested evaluation run")
            descriptor, local = selected_definition
            if run.execution_mode is not descriptor.execution_mode:
                raise RuntimeError("server changed the evaluation execution mode")
            if run.execution_mode is ExecutionMode.LOCAL:
                if local is None:
                    raise RuntimeError("local evaluation definition is unavailable")
                definition = local
            else:
                if not run.evaluator_source or not run.source_checksum:
                    raise RuntimeError("server omitted managed evaluation source")
                expected = source_checksum(
                    descriptor.condition_source, run.evaluator_source
                )
                if expected != run.source_checksum or (
                    descriptor.source_checksum
                    and descriptor.source_checksum != run.source_checksum
                ):
                    raise RuntimeError("managed evaluation source checksum mismatch")
                definition = EvalDefinition(
                    eval_key=descriptor.eval_key,
                    display_name=descriptor.display_name,
                    eval_version=descriptor.eval_version,
                    result_kind=descriptor.result_kind,
                    labels=descriptor.labels,
                    function=_deferred_managed_eval(
                        run.evaluator_source,
                        run.timeout_seconds or descriptor.timeout_seconds,
                        descriptor.eval_key,
                    ),
                    condition=None,
                    on_cancel=None,
                    timeout_seconds=run.timeout_seconds or descriptor.timeout_seconds,
                )
            run_definitions.append((run.evaluation_run_id, definition))
        if definitions and not plan.idempotent_replay:
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
        # A synchronous evaluator runs in the executor thread; if it overruns the
        # wall-clock timeout below, the thread cannot be cancelled and is orphaned.
        sync_function = not inspect.iscoroutinefunction(definition.function)
        try:
            invocation = self._invoke(definition.function, session)
            # Always bound the evaluation. A definition with no declared
            # timeout_seconds falls back to DEFAULT_EVAL_TIMEOUT_SECONDS rather
            # than awaiting unbounded — an unbounded local eval that hangs would
            # wedge its worker slot and hold the lease forever.
            eval_timeout = (
                definition.timeout_seconds
                if definition.timeout_seconds is not None
                else DEFAULT_EVAL_TIMEOUT_SECONDS
            )
            result = await asyncio.wait_for(invocation, timeout=eval_timeout)
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
        except (asyncio.TimeoutError, EvaluationTimeout) as timeout_error:
            # asyncio.TimeoutError: the awaiter hit the wall-clock. EvaluationTimeout:
            # the forked managed sandbox was killed by its CPU/memory/time budget —
            # the real, thread-uncancellable case. Both are a timed-out run.
            await self._cancel_hook(definition, session)
            if isinstance(timeout_error, asyncio.TimeoutError) and sync_function:
                # The awaiter gave up while a SYNCHRONOUS evaluator was still
                # running in the executor. CPython cannot interrupt that thread,
                # so it is now orphaned — it runs to completion (or forever)
                # holding a worker thread. Count it and name the evaluator so a
                # hung one is findable; the executor's headroom keeps this one
                # orphan from immediately starving live capacity.
                self._increment("sync_evaluations_orphaned")
                logger.warning(
                    "synchronous evaluation exceeded its timeout and cannot be "
                    "cancelled; its worker thread is orphaned until it returns",
                    extra={
                        "assignment_id": assignment.assignment_id,
                        "eval_key": definition.eval_key,
                    },
                )
            items = ()
            status = TerminalRunStatus.TIMED_OUT
            summary = None
            error_code = "eval_timeout"
            error_message = "evaluation exceeded its configured timeout"
        except asyncio.CancelledError:
            await self._cancel_hook(definition, session)
            raise
        except UnsafeEvaluatorSource as error:
            # Surface the REASON for a rejected server-authored definition.
            #
            # This is deliberately narrower than the generic handler below.
            # UnsafeEvaluatorSource is raised by our own validator before any
            # customer source executes, and its message is SDK-authored text
            # about the source's shape ("evaluator_source must be one
            # expression", "contains disallowed syntax: Assign") — it embeds no
            # transcript content, so it is safe to send back over the wire.
            #
            # Without this the author saw only "evaluation raised
            # UnsafeEvaluatorSource" on every session, with no way to learn what
            # was wrong: the server accepts any source that passes its size and
            # key checks, so a definition that can never run is published
            # successfully and then fails silently and permanently.
            items = ()
            status = TerminalRunStatus.FAILED
            summary = None
            error_code = "eval_error"
            detail = str(error).strip()
            error_message = (
                f"evaluator source rejected: {detail}"
                if detail
                else "evaluator source rejected by the sandbox validator"
            )
            encoded = error_message.encode("utf-8")
            if len(encoded) > MAX_ERROR_MESSAGE_BYTES:
                error_message = encoded[:MAX_ERROR_MESSAGE_BYTES].decode(
                    "utf-8", "ignore"
                )
        except Exception as error:  # noqa: BLE001 - converts customer eval failures
            # Type name ONLY on the wire. A customer eval's exception text can
            # quote the transcript it was reading, and this field is persisted
            # and shown in the dashboard, so the message itself is not repeated
            # there. But log the FULL traceback LOCALLY: this runs on the
            # customer's own pod over their own data, and without it an author
            # whose eval raises sees only "evaluation raised HTTPError" in the
            # dashboard and nothing at all in their pod logs — no way to debug
            # their own eval.
            logger.warning(
                "evaluation %r raised %s; reported to the server as a failed run",
                definition.eval_key,
                type(error).__name__,
                exc_info=True,
            )
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
        # Beat IMMEDIATELY, before the first sleep. The pre-plan condition phase
        # may have consumed most of the claim-time lease, and the server only
        # renews a planned assignment's lease on heartbeat — so sleeping a full
        # interval here can let the lease expire before the first renewal, after
        # the runs have already started, cancelling every one of them. The first
        # beat renews the lease the moment the runs are live.
        first = True
        while True:
            if not first:
                await asyncio.sleep(self._heartbeat_interval)
            first = False
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
            except Exception as error:  # noqa: BLE001 - keep lease renewal alive
                logger.warning(
                    "evaluator heartbeat error",
                    extra={
                        "assignment_id": assignment.assignment_id,
                        "error_type": type(error).__name__,
                    },
                )
                self._increment("heartbeat_failures")

    def _condition_phase_deadline(self, assignment: Assignment) -> float:
        """Monotonic-clock reading by which the pre-plan condition phase must end.

        The real `lease_expires_at` is used when it is in the future (production);
        a past or unparseable value (clock skew, or a replayed transcript in a
        test) falls back to the negotiated lease duration measured from now, so
        the bound never fires spuriously on a stale deadline.
        """
        remaining = float(self._lease_duration)
        try:
            expires = datetime.fromisoformat(
                assignment.lease_expires_at.replace("Z", "+00:00")
            )
            parsed = (expires - datetime.now(timezone.utc)).total_seconds()
            if parsed > 0:
                remaining = parsed
        except (ValueError, AttributeError):
            pass
        return time.monotonic() + remaining

    def _condition_budget(
        self, deadline: float, timeout_seconds: int | None
    ) -> float:
        """Seconds a single condition may run: the lease left before the
        plan-submission margin, capped by the definition's own timeout."""
        remaining = (
            deadline - time.monotonic() - _CONDITION_PHASE_SAFETY_MARGIN_SECONDS
        )
        if timeout_seconds is not None:
            remaining = min(remaining, float(timeout_seconds))
        return remaining

    async def _invoke(self, function, session):
        if inspect.iscoroutinefunction(function):
            return await function(session)
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(self._eval_executor, function, session)
        if inspect.isawaitable(result):
            return await result
        return result

    @staticmethod
    def _skipped(definition: EvalDefinition, reason: str) -> SkippedEval:
        return SkippedEval(definition.eval_key, definition.eval_version, reason)

    @staticmethod
    def _skipped_descriptor(
        definition: AssignmentDefinition, reason: str
    ) -> SkippedEval:
        return SkippedEval(definition.eval_key, definition.eval_version, reason)

    async def _assignment_definitions(
        self, assignment: Assignment
    ) -> tuple[AssignmentDefinition, ...]:
        if assignment.definitions_url:
            response = await self._call_client(
                self.client.definitions,
                assignment,
                worker_id=self.config.worker_id,
            )
            if response.assignment_id != assignment.assignment_id:
                raise RuntimeError("server returned definitions for another assignment")
            return response.definitions
        return tuple(
            AssignmentDefinition(
                eval_key=item.eval_key,
                display_name=item.display_name,
                eval_version=item.eval_version,
                result_kind=item.result_kind,
                labels=item.labels,
            )
            for item in self.evaluator.definitions
        )

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
