from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from uuid import UUID, uuid5

import pytest

from failproofai_sdk.evaluator import (
    Assignment,
    ClaimRequest,
    EvalResult,
    EvalSelection,
    Evaluator,
    EvaluatorAPIError,
    EvaluatorClient,
    HeartbeatRequest,
    HeartbeatRun,
    PlanRequest,
    ResultItem,
    ResultKind,
    ResultRequest,
    Score,
    TerminalRunStatus,
    WorkerConfig,
    WorkerRuntime,
)

_NAMESPACE = UUID("4d592d9c-aed4-4f07-9b2d-e14963399df6")


class ProtocolState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.base_url = ""
        self.instances = {
            "customer-a-token": ("instance-customer-a", "customer", "org-a"),
            "customer-b-token": ("instance-customer-b", "customer", "org-b"),
            "managed-token": ("instance-managed", "managed", None),
        }
        self.registrations: dict[str, dict] = {}
        self.assignments: dict[str, dict] = {}
        self.runs: dict[str, dict] = {}
        self.result_attempts = 0
        self.result_commits = 0
        self.last_result_body: dict | None = None
        self.drop_first_result_response = False

    def add_assignment(self, name: str, *, token: str, org: str) -> str:
        assignment_id = str(uuid5(_NAMESPACE, name))
        self.assignments[assignment_id] = {
            "token": token,
            "org": org,
            "status": "available",
            "worker_id": None,
            "lease_generation": 0,
            "expired": False,
            "session_id": f"session-{name}",
            "session_revision_id": f"revision-{name}",
        }
        return assignment_id

    def expire(self, assignment_id: str) -> None:
        with self.lock:
            self.assignments[assignment_id]["expired"] = True


class ProtocolServer:
    def __init__(self, state: ProtocolState) -> None:
        self.state = state
        handler = _handler_for(state)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        state.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> ProtocolServer:  # noqa: PYI034 - Python 3.10 lacks Self
        self.thread.start()
        return self

    def __exit__(self, *_args) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def _handler_for(state: ProtocolState):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            token = self._token()
            if token not in state.instances:
                self._error(401, "invalid_credentials", False)
                return
            body = self._body()
            path = urlsplit(self.path).path
            if path == "/v1/evaluator/workers/register":
                state.registrations[token] = body
                instance_id, kind, _org = state.instances[token]
                self._json(
                    200,
                    {
                        "protocol_version": "2",
                        "evaluator_instance_id": instance_id,
                        "evaluator_kind": kind,
                        "heartbeat_interval_seconds": 30,
                        "lease_duration_seconds": 120,
                        "poll_interval_seconds": 10,
                        "claim_limit": body["max_concurrency"],
                        "disabled_definitions": [],
                    },
                )
                return
            if path == "/v1/evaluator/assignments/claim":
                self._claim(token, body)
                return
            if path.endswith("/plan"):
                self._plan(token, path.split("/")[-2], body)
                return
            if path == "/v1/evaluator/runs/heartbeat":
                self._heartbeat(token, body)
                return
            if path.endswith("/result"):
                self._result(token, path.split("/")[-2], body)
                return
            self._error(404, "assignment_not_found", False)

        def do_GET(self) -> None:
            token = self._token()
            if token not in state.instances:
                self._error(401, "invalid_credentials", False)
                return
            path = urlsplit(self.path).path
            if path.endswith("/transcript"):
                self._transcript(token, path.split("/")[-2])
                return
            self._error(404, "assignment_not_found", False)

        def _claim(self, token: str, body: dict) -> None:
            claimed = []
            with state.lock:
                for assignment_id, item in state.assignments.items():
                    if len(claimed) >= body["capacity"]:
                        break
                    if item["token"] != token:
                        continue
                    if item["status"] in {"leased", "planned"} and not item["expired"]:
                        continue
                    if item["status"] not in {"available", "leased", "planned"}:
                        continue
                    item["status"] = "leased"
                    item["expired"] = False
                    item["worker_id"] = body["worker_id"]
                    item["lease_generation"] += 1
                    claimed.append(self._assignment_wire(assignment_id, item))
            self._json(200, {"protocol_version": "2", "assignments": claimed})

        def _transcript(self, token: str, assignment_id: str) -> None:
            item = self._leased_assignment(
                token,
                assignment_id,
                self.headers.get("X-FailproofAI-Worker-Id"),
                self.headers.get("X-FailproofAI-Lease-Generation"),
            )
            if item is None:
                return
            self._json(
                200,
                {
                    "schema_version": "2",
                    "assignment_id": assignment_id,
                    "session_id": item["session_id"],
                    "session_revision_id": item["session_revision_id"],
                    "agent_id": "agent-e2e",
                    "environment": "test",
                    "started_at": "2026-08-28T12:00:00.000000Z",
                    "ended_at": "2026-08-28T12:00:01.000000Z",
                    "event_count": 1,
                    "events": [
                        {
                            "id": "event-1",
                            "ts": "2026-08-28T12:00:00.500000Z",
                            "event_type": "model_response",
                            "payload": {"content": "done"},
                        }
                    ],
                },
            )

        def _plan(self, token: str, assignment_id: str, body: dict) -> None:
            item = self._leased_assignment(
                token, assignment_id, body["worker_id"], body["lease_generation"]
            )
            if item is None:
                return
            runs = []
            with state.lock:
                for selected in body["selected"]:
                    run_id = str(
                        uuid5(
                            _NAMESPACE,
                            f"{assignment_id}:{selected['eval_key']}:{selected['eval_version']}",
                        )
                    )
                    run = state.runs.setdefault(
                        run_id,
                        {
                            "token": token,
                            "assignment_id": assignment_id,
                            "worker_id": body["worker_id"],
                            "lease_generation": body["lease_generation"],
                            "submission_id": None,
                            "checksum": None,
                        },
                    )
                    if run["submission_id"] is None:
                        run["worker_id"] = body["worker_id"]
                        run["lease_generation"] = body["lease_generation"]
                    runs.append(
                        {
                            "evaluation_run_id": run_id,
                            "execution_mode": "local",
                            **selected,
                        }
                    )
                item["status"] = "planned" if runs else "skipped"
            self._json(
                200,
                {
                    "protocol_version": "2",
                    "assignment_id": assignment_id,
                    "assignment_status": item["status"],
                    "runs": runs,
                },
            )

        def _heartbeat(self, token: str, body: dict) -> None:
            accepted = []
            with state.lock:
                for requested in body["runs"]:
                    run = state.runs.get(requested["evaluation_run_id"])
                    assignment = (
                        state.assignments.get(run["assignment_id"])
                        if run is not None
                        else None
                    )
                    if (
                        run is not None
                        and assignment is not None
                        and run["token"] == token
                        and run["worker_id"] == body["worker_id"]
                        and run["lease_generation"] == body["lease_generation"]
                        and assignment["worker_id"] == body["worker_id"]
                        and assignment["lease_generation"] == body["lease_generation"]
                        and not assignment["expired"]
                    ):
                        accepted.append(requested["evaluation_run_id"])
            if not accepted:
                self._error(409, "lease_lost", False)
                return
            self._json(
                200,
                {
                    "protocol_version": "2",
                    "lease_expires_at": "2026-08-28T12:02:30.000000Z",
                    "accepted_run_ids": accepted,
                },
            )

        def _result(self, token: str, run_id: str, body: dict) -> None:
            with state.lock:
                run = state.runs.get(run_id)
                if run is None or run["token"] != token:
                    self._error(404, "run_not_found", False)
                    return
                if (
                    run["worker_id"] != body["worker_id"]
                    or run["lease_generation"] != body["lease_generation"]
                ):
                    self._error(409, "lease_lost", False)
                    return
                checksum = hashlib.sha256(
                    json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                if run["submission_id"] is not None:
                    if (
                        run["submission_id"] != body["submission_id"]
                        or run["checksum"] != checksum
                    ):
                        self._error(409, "submission_conflict", False)
                        return
                    replay = True
                else:
                    run["submission_id"] = body["submission_id"]
                    run["checksum"] = checksum
                    state.result_commits += 1
                    state.last_result_body = body
                    replay = False
                state.result_attempts += 1
                drop = state.drop_first_result_response and state.result_attempts == 1
            if drop:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self._json(
                200,
                {
                    "protocol_version": "2",
                    "evaluation_run_id": run_id,
                    "submission_id": body["submission_id"],
                    "status": "committed",
                    "idempotent_replay": replay,
                    "result_count": len(body["results"]),
                    "result_checksum": checksum,
                },
            )

        def _leased_assignment(
            self,
            token: str,
            assignment_id: str,
            worker_id: str | None,
            generation: str | int | None,
        ) -> dict | None:
            with state.lock:
                item = state.assignments.get(assignment_id)
                if item is None or item["token"] != token:
                    self._error(404, "assignment_not_found", False)
                    return None
                try:
                    generation = int(generation) if generation is not None else None
                except ValueError:
                    generation = None
                if (
                    item["status"] != "leased"
                    or item["expired"]
                    or item["worker_id"] != worker_id
                    or item["lease_generation"] != generation
                ):
                    self._error(409, "lease_lost", False)
                    return None
                return item

        def _assignment_wire(self, assignment_id: str, item: dict) -> dict:
            return {
                "assignment_id": assignment_id,
                "lease_generation": item["lease_generation"],
                "lease_expires_at": "2026-08-28T12:02:00.000000Z",
                "session_id": item["session_id"],
                "session_revision_id": item["session_revision_id"],
                "agent_id": "agent-e2e",
                "environment": "test",
                "trigger_reason": "agent_end",
                "event_count": 1,
                "transcript_url": (
                    f"{state.base_url}/v1/evaluator/assignments/"
                    f"{assignment_id}/transcript"
                ),
            }

        def _token(self) -> str | None:
            value = self.headers.get("Authorization", "")
            return (
                value.removeprefix("Bearer ") if value.startswith("Bearer ") else None
            )

        def _body(self) -> dict:
            size = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(size))

        def _error(self, status: int, code: str, retryable: bool) -> None:
            self._json(
                status,
                {
                    "protocol_version": "2",
                    "error": {
                        "code": code,
                        "message": code.replace("_", " "),
                        "retryable": retryable,
                        "request_id": "request-e2e",
                    },
                },
            )

        def _json(self, status: int, value: dict) -> None:
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            return

    return Handler


def _client(state: ProtocolState, token: str) -> EvaluatorClient:
    return EvaluatorClient(
        base_url=state.base_url,
        credential=token,
        max_retries=2,
        sleeper=lambda _seconds: None,
    )


def _claim(client: EvaluatorClient, worker_id: str):
    return client.claim(
        ClaimRequest(
            worker_id=worker_id,
            catalog_revision="sha256:" + "a" * 64,
            capacity=1,
        )
    )


def test_real_http_worker_survives_lost_result_response_without_duplicate_commit():
    state = ProtocolState()
    state.add_assignment("runtime", token="customer-a-token", org="org-a")
    state.drop_first_result_response = True
    evaluator = Evaluator(name="e2e", version="1")

    @evaluator.eval("completion_present", version="1")
    def completion_present(session):
        return EvalResult(score=Score(float(bool(session.events))))

    with ProtocolServer(state):
        runtime = WorkerRuntime(
            evaluator,
            WorkerConfig(
                server_url=state.base_url,
                credential="customer-a-token",
                worker_id="worker-a",
            ),
            client=_client(state, "customer-a-token"),
        )

        async def run():
            await runtime.register()
            return await runtime.run_once()

        assert asyncio.run(run()) == 1

        run_id = next(iter(state.runs))
        committed = ResultRequest.from_wire(state.last_result_body)
        replay = runtime.client.submit_result(run_id, committed)
        assert replay.idempotent_replay is True

        with pytest.raises(EvaluatorAPIError) as caught:
            runtime.client.submit_result(
                run_id,
                replace(committed, summary="different content"),
            )
        assert caught.value.code == "submission_conflict"

    assert state.result_attempts == 3
    assert state.result_commits == 1
    assert len(state.runs) == 1
    assert next(iter(state.runs.values()))["submission_id"] is not None
    assert runtime.metrics()["runs_succeeded"] == 1


def test_two_workers_racing_receive_one_unique_lease():
    state = ProtocolState()
    assignment_id = state.add_assignment("race", token="customer-a-token", org="org-a")
    with ProtocolServer(state):
        first = _client(state, "customer-a-token")
        second = _client(state, "customer-a-token")
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda pair: _claim(*pair),
                    [(first, "worker-a"), (second, "worker-b")],
                )
            )

    claimed = [item for response in responses for item in response.assignments]
    assert [item.assignment_id for item in claimed] == [assignment_id]
    assert state.assignments[assignment_id]["lease_generation"] == 1


def test_expired_lease_is_reclaimed_and_stale_worker_is_fenced():
    state = ProtocolState()
    assignment_id = state.add_assignment(
        "reclaim", token="customer-a-token", org="org-a"
    )
    with ProtocolServer(state):
        client = _client(state, "customer-a-token")
        first = _claim(client, "worker-a").assignments[0]
        plan = client.plan(
            assignment_id,
            PlanRequest(
                worker_id="worker-a",
                lease_generation=first.lease_generation,
                selected=(EvalSelection("quality", "1"),),
            ),
        )
        state.expire(assignment_id)
        second = _claim(client, "worker-b").assignments[0]

        assert second.lease_generation == first.lease_generation + 1
        with pytest.raises(EvaluatorAPIError) as caught:
            client.transcript(first, worker_id="worker-a")
        assert caught.value.code == "lease_lost"
        assert caught.value.retryable is False

        with pytest.raises(EvaluatorAPIError) as caught:
            client.heartbeat(
                HeartbeatRequest(
                    worker_id="worker-a",
                    lease_generation=first.lease_generation,
                    runs=(HeartbeatRun(plan.runs[0].evaluation_run_id, "running"),),
                )
            )
        assert caught.value.code == "lease_lost"


def test_replacement_worker_finishes_after_forced_worker_loss():
    state = ProtocolState()
    assignment_id = state.add_assignment(
        "forced-worker-loss", token="customer-a-token", org="org-a"
    )
    result_sample = ResultRequest(
        submission_id=str(uuid5(_NAMESPACE, "forced-worker-loss-result")),
        worker_id="worker-a",
        lease_generation=1,
        status=TerminalRunStatus.SUCCEEDED,
        started_at="2026-08-28T12:00:10.000000Z",
        finished_at="2026-08-28T12:00:10.100000Z",
        duration_ms=100,
        summary="Replacement worker completed the evaluation.",
        results=(
            ResultItem(
                result_key="quality",
                result_kind=ResultKind.SCORE,
                numeric_value=1.0,
            ),
        ),
        error_code=None,
        error_message=None,
    )

    with ProtocolServer(state):
        client = _client(state, "customer-a-token")
        first = _claim(client, "worker-a").assignments[0]
        first_plan = client.plan(
            assignment_id,
            PlanRequest(
                worker_id="worker-a",
                lease_generation=first.lease_generation,
                selected=(EvalSelection("quality", "1"),),
            ),
        )

        # Worker A disappears after planning. Its lease expires and worker B
        # reclaims the same logical assignment and deterministic run.
        state.expire(assignment_id)
        second = _claim(client, "worker-b").assignments[0]
        second_plan = client.plan(
            assignment_id,
            PlanRequest(
                worker_id="worker-b",
                lease_generation=second.lease_generation,
                selected=(EvalSelection("quality", "1"),),
            ),
        )
        assert (
            second_plan.runs[0].evaluation_run_id
            == first_plan.runs[0].evaluation_run_id
        )

        stale_result = replace(
            result_sample,
            worker_id="worker-a",
            lease_generation=first.lease_generation,
        )
        with pytest.raises(EvaluatorAPIError) as caught:
            client.submit_result(first_plan.runs[0].evaluation_run_id, stale_result)
        assert caught.value.code == "lease_lost"

        replacement_result = replace(
            result_sample,
            worker_id="worker-b",
            lease_generation=second.lease_generation,
        )
        committed = client.submit_result(
            second_plan.runs[0].evaluation_run_id, replacement_result
        )
        assert committed.status == "committed"
        assert committed.idempotent_replay is False

    assert state.result_attempts == 1
    assert state.result_commits == 1


def test_customer_tenants_are_isolated_and_managed_worker_coexists():
    state = ProtocolState()
    customer_id = state.add_assignment(
        "customer", token="customer-a-token", org="org-a"
    )
    managed_id = state.add_assignment("managed", token="managed-token", org="org-b")
    with ProtocolServer(state):
        customer_a = _client(state, "customer-a-token")
        customer_b = _client(state, "customer-b-token")
        managed = _client(state, "managed-token")

        customer_assignment = _claim(customer_a, "worker-a").assignments[0]
        assert customer_assignment.assignment_id == customer_id
        assert _claim(customer_b, "worker-b").assignments == ()
        assert (
            _claim(managed, "worker-managed").assignments[0].assignment_id == managed_id
        )

        stolen = Assignment(
            assignment_id=customer_assignment.assignment_id,
            lease_generation=customer_assignment.lease_generation,
            lease_expires_at=customer_assignment.lease_expires_at,
            session_id=customer_assignment.session_id,
            session_revision_id=customer_assignment.session_revision_id,
            agent_id=customer_assignment.agent_id,
            environment=customer_assignment.environment,
            trigger_reason=customer_assignment.trigger_reason,
            event_count=customer_assignment.event_count,
            transcript_url=customer_assignment.transcript_url,
        )
        with pytest.raises(EvaluatorAPIError) as caught:
            customer_b.transcript(stolen, worker_id="worker-a")
        assert caught.value.status == 404
        assert caught.value.code == "assignment_not_found"
