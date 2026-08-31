from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest

from failproofai_sdk.evaluator import (
    AssignmentDefinition,
    ClaimResponse,
    ConditionResult,
    DefinitionsResponse,
    EvalResult,
    Evaluator,
    EvaluatorAPIError,
    ExecutionMode,
    HeartbeatResponse,
    PlannedRun,
    PlanResponse,
    RegisterResponse,
    ResultKind,
    Score,
    SessionTranscript,
    WorkerConfig,
    WorkerRuntime,
    source_checksum,
)

FIXTURE = Path(__file__).parent / "fixtures" / "evaluator_v2" / "contract.json"


def _samples():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["samples"]


class FakeClient:
    def __init__(self):
        samples = _samples()
        self.assignment = ClaimResponse.from_wire(
            samples["claim_response"]
        ).assignments[0]
        self.assignment = replace(self.assignment, definitions_url="")
        self.session = SessionTranscript.from_wire(samples["transcript_response"])
        self.register_requests = []
        self.claim_requests = []
        self.plans = []
        self.submissions = []
        self.heartbeats = []

    def register(self, request):
        self.register_requests.append(request)
        return RegisterResponse.from_wire(_samples()["register_response"])

    def claim(self, request):
        self.claim_requests.append(request)
        return ClaimResponse(assignments=(self.assignment,))

    def transcript(self, assignment, *, worker_id):
        assert assignment == self.assignment
        assert worker_id == "worker-test"
        return self.session

    def plan(self, assignment_id, request):
        self.plans.append(request)
        return PlanResponse(
            assignment_id=assignment_id,
            assignment_status="planned" if request.selected else "skipped",
            runs=tuple(
                PlannedRun(f"run-{item.eval_key}", item.eval_key, item.eval_version)
                for item in request.selected
            ),
        )

    def submit_result(self, run_id, request):
        self.submissions.append((run_id, request))

    def heartbeat(self, request):
        self.heartbeats.append(request)
        return HeartbeatResponse(
            lease_expires_at="2026-08-28T12:02:30.000000Z",
            accepted_run_ids=tuple(item.evaluation_run_id for item in request.runs),
        )


def _runtime(evaluator, client):
    return WorkerRuntime(
        evaluator,
        WorkerConfig(
            server_url="https://cloud.example",
            credential="secret",
            worker_id="worker-test",
            max_concurrency=2,
        ),
        client=client,
    )


def test_managed_definition_is_fetched_verified_and_executed():
    source = "EvalResult(score=Score(0.75, passed=True), summary='hosted')"

    class HostedClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.assignment = replace(
                self.assignment,
                definitions_url=f"/v1/evaluator/assignments/{self.assignment.assignment_id}/definitions",
            )

        def definitions(self, assignment, *, worker_id):
            assert assignment == self.assignment
            assert worker_id == "worker-test"
            return DefinitionsResponse(
                assignment_id=assignment.assignment_id,
                catalog_revision="sha256:hosted",
                definitions=(
                    AssignmentDefinition(
                        eval_key="hosted_quality",
                        display_name="Hosted quality",
                        eval_version="1",
                        result_kind=ResultKind.SCORE,
                        execution_mode=ExecutionMode.PYTHON,
                        source_checksum=source_checksum(None, source),
                    ),
                ),
            )

        def plan(self, assignment_id, request):
            self.plans.append(request)
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="planned",
                runs=(
                    PlannedRun(
                        "run-hosted",
                        "hosted_quality",
                        "1",
                        execution_mode=ExecutionMode.PYTHON,
                        evaluator_source=source,
                        source_checksum=source_checksum(None, source),
                        timeout_seconds=1,
                    ),
                ),
            )

    client = HostedClient()
    asyncio.run(
        _runtime(Evaluator(name="managed", version="1"), client).process_assignment(
            client.assignment
        )
    )

    assert len(client.submissions) == 1
    run_id, result = client.submissions[0]
    assert run_id == "run-hosted"
    assert result.status.value == "succeeded"
    assert result.summary == "hosted"
    assert result.results[0].numeric_value == 0.75


def test_managed_definition_that_fails_to_compile_dead_letters_as_one_failed_run():
    # Unsafe/malformed server-authored source is rejected by the sandbox at
    # compile time. That rejection must surface as a single bounded FAILED run,
    # NOT as an exception out of assignment setup that crashes the task and
    # forces the whole assignment to be reclaimed and retried.
    unsafe = (
        'EvalResult(score=Score(1.0), '
        'reasoning="{0.__class__}".format(session))'
    )

    class HostedClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.assignment = replace(
                self.assignment,
                definitions_url=f"/v1/evaluator/assignments/{self.assignment.assignment_id}/definitions",
            )

        def definitions(self, assignment, *, worker_id):
            return DefinitionsResponse(
                assignment_id=assignment.assignment_id,
                catalog_revision="sha256:hosted",
                definitions=(
                    AssignmentDefinition(
                        eval_key="hosted_quality",
                        display_name="Hosted quality",
                        eval_version="1",
                        result_kind=ResultKind.SCORE,
                        execution_mode=ExecutionMode.PYTHON,
                        source_checksum=source_checksum(None, unsafe),
                    ),
                ),
            )

        def plan(self, assignment_id, request):
            self.plans.append(request)
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="planned",
                runs=(
                    PlannedRun(
                        "run-hosted",
                        "hosted_quality",
                        "1",
                        execution_mode=ExecutionMode.PYTHON,
                        evaluator_source=unsafe,
                        source_checksum=source_checksum(None, unsafe),
                        timeout_seconds=1,
                    ),
                ),
            )

    client = HostedClient()
    # Must NOT raise — the poison definition is contained to its own run.
    asyncio.run(
        _runtime(Evaluator(name="managed", version="1"), client).process_assignment(
            client.assignment
        )
    )

    assert len(client.submissions) == 1
    run_id, result = client.submissions[0]
    assert run_id == "run-hosted"
    assert result.status.value == "failed"
    assert result.error_code == "eval_error"
    # Nothing derived from the rejected source may be reported.
    assert result.results == ()
    assert result.summary is None


def test_managed_condition_governs_even_when_a_local_key_collides():
    # COR-001: `local` is keyed on (eval_key, eval_version) alone, so a managed
    # (PYTHON) definition can collide with a local one the worker also registered.
    # The server's managed condition must decide applicability — NOT the matching
    # local condition. Here the local condition returns True and the managed
    # `condition_source` is "False": the definition must be recorded as skipped
    # (condition_false) and the managed evaluator source must never run.
    source = "EvalResult(score=Score(1.0), summary='should never run')"

    evaluator = Evaluator(name="managed", version="1")

    @evaluator.eval("hosted_quality", version="1", when=lambda session: True)
    def hosted_quality(session):  # a colliding LOCAL definition, condition True
        return EvalResult(score=Score(1.0, passed=True), summary="local")

    class HostedClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.assignment = replace(
                self.assignment,
                definitions_url=f"/v1/evaluator/assignments/{self.assignment.assignment_id}/definitions",
            )

        def definitions(self, assignment, *, worker_id):
            return DefinitionsResponse(
                assignment_id=assignment.assignment_id,
                catalog_revision="sha256:hosted",
                definitions=(
                    AssignmentDefinition(
                        eval_key="hosted_quality",
                        display_name="Hosted quality",
                        eval_version="1",
                        result_kind=ResultKind.SCORE,
                        execution_mode=ExecutionMode.PYTHON,
                        condition_source="False",
                        source_checksum=source_checksum("False", source),
                        timeout_seconds=1,
                    ),
                ),
            )

    client = HostedClient()
    asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))

    # The server's managed condition (False) wins over the local one (True):
    # recorded as skipped, nothing selected, and no managed run submitted.
    assert client.plans[0].selected == ()
    assert {(item.eval_key, item.reason_code) for item in client.plans[0].skipped} == {
        ("hosted_quality", "condition_false"),
    }
    assert client.submissions == []


def test_two_assignments_share_the_bounded_sync_eval_pool_and_keep_heartbeating():
    evaluator = Evaluator(name="parallel", version="1")
    lock = threading.Lock()
    active = 0
    peak = 0

    def measured(_session):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.04)
        with lock:
            active -= 1
        return EvalResult(score=Score(1))

    for index in range(5):
        evaluator.eval(
            f"eval_{index}",
            version="1",
            when=lambda session, index=index: (
                index < 3 if session.session_id == "session-a" else index >= 3
            ),
        )(measured)

    class ParallelClient(FakeClient):
        def transcript(self, assignment, *, worker_id):
            assert worker_id == "worker-test"
            return replace(
                self.session,
                assignment_id=assignment.assignment_id,
                session_id=assignment.session_id,
                session_revision_id=assignment.session_revision_id,
            )

    client = ParallelClient()
    first = replace(
        client.assignment,
        assignment_id="assignment-a",
        session_id="session-a",
        session_revision_id="revision-a",
    )
    second = replace(
        client.assignment,
        assignment_id="assignment-b",
        session_id="session-b",
        session_revision_id="revision-b",
    )
    runtime = _runtime(evaluator, client)
    runtime._heartbeat_interval = 0.01

    async def exercise():
        await asyncio.gather(
            runtime.process_assignment(first), runtime.process_assignment(second)
        )

    asyncio.run(exercise())

    assert peak == 2
    assert len(client.submissions) == 5
    assert client.heartbeats


def test_condition_failures_are_isolated_and_plan_is_declared_first():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("selected", version="1", when=lambda session: True)
    def selected(session):
        return EvalResult(score=Score(1))

    @evaluator.eval("not_applicable", version="1", when=lambda session: False)
    def not_applicable(session):
        return EvalResult(score=Score(1))

    def broken_condition(session):
        raise RuntimeError("condition exploded")

    @evaluator.eval("broken_condition", version="1", when=broken_condition)
    def never_runs(session):
        raise AssertionError("must not run")

    client = FakeClient()
    asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))

    assert len(client.plans) == 1
    assert [item.eval_key for item in client.plans[0].selected] == ["selected"]
    assert {(item.eval_key, item.reason_code) for item in client.plans[0].skipped} == {
        ("not_applicable", "condition_false"),
        ("broken_condition", "condition_error"),
    }
    assert [run_id for run_id, _ in client.submissions] == ["run-selected"]


def test_condition_can_supply_a_stable_skip_reason():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval(
        "retrieval_only",
        version="1",
        when=lambda session: ConditionResult(False, "no_retrieval_events"),
    )
    def retrieval_only(session):
        raise AssertionError("must not run")

    client = FakeClient()
    asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))
    assert client.plans[0].skipped[0].reason_code == "no_retrieval_events"


def test_one_eval_failure_does_not_block_another_result():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("fails", version="1")
    def fails(session):
        raise RuntimeError("secret details should be bounded")

    @evaluator.eval("succeeds", version="1")
    async def succeeds(session):
        await asyncio.sleep(0)
        return EvalResult(score=Score(0.8), summary="good")

    client = FakeClient()
    asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))

    by_run = {run_id: request for run_id, request in client.submissions}
    assert by_run["run-fails"].status.value == "failed"
    assert by_run["run-fails"].error_code == "eval_error"
    assert by_run["run-fails"].results == ()
    assert by_run["run-succeeds"].status.value == "succeeded"
    assert by_run["run-succeeds"].results[0].result_kind == ResultKind.SCORE


def test_timeout_is_submitted_as_a_terminal_run():
    evaluator = Evaluator(name="test", version="1")
    cancelled = []

    @evaluator.eval(
        "slow",
        version="1",
        timeout_seconds=0.01,
        on_cancel=lambda session: cancelled.append(session.session_revision_id),
    )
    async def slow(session):
        await asyncio.sleep(1)
        return EvalResult(score=Score(1))

    client = FakeClient()
    asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))
    request = client.submissions[0][1]
    assert request.status.value == "timed_out"
    assert request.error_code == "eval_timeout"
    assert cancelled == [client.assignment.session_revision_id]


def test_lost_lease_cancels_local_execution():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("slow", version="1")
    async def slow(session):
        await asyncio.sleep(1)
        return EvalResult(score=Score(1))

    class LeaseLostClient(FakeClient):
        def heartbeat(self, request):
            raise EvaluatorAPIError(
                status=409,
                code="lease_lost",
                message="gone",
                retryable=False,
            )

    client = LeaseLostClient()
    runtime = _runtime(evaluator, client)
    runtime._heartbeat_interval = 0.01
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(runtime.process_assignment(client.assignment))
    assert client.submissions == []


def test_partial_heartbeat_acceptance_cancels_only_the_fenced_run():
    evaluator = Evaluator(name="test", version="1")

    class PartialHeartbeatClient(FakeClient):
        def heartbeat(self, request):
            self.heartbeats.append(request)
            return HeartbeatResponse(
                lease_expires_at="2026-08-28T12:02:30.000000Z",
                accepted_run_ids=(request.runs[0].evaluation_run_id,),
            )

    client = PartialHeartbeatClient()
    runtime = _runtime(evaluator, client)
    runtime._heartbeat_interval = 0.01

    async def exercise():
        first = asyncio.create_task(asyncio.sleep(60))
        second = asyncio.create_task(asyncio.sleep(60))
        heartbeat = asyncio.create_task(
            runtime._heartbeat(
                client.assignment, {"run-first": first, "run-second": second}
            )
        )
        while not client.heartbeats:
            await asyncio.sleep(0.001)
        for _ in range(100):
            if second.done():
                break
            await asyncio.sleep(0.001)
        assert first.done() is False
        assert second.cancelled() is True
        heartbeat.cancel()
        first.cancel()
        await asyncio.gather(first, second, heartbeat, return_exceptions=True)

    asyncio.run(exercise())


def test_transcript_revision_must_match_the_claimed_assignment():
    evaluator = Evaluator(name="test", version="1")
    client = FakeClient()
    client.session = SessionTranscript.from_wire(
        {
            **_samples()["transcript_response"],
            "session_revision_id": "different-revision",
        }
    )

    with pytest.raises(RuntimeError, match="revision does not match"):
        asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))
    assert client.plans == []


def test_server_cannot_add_a_run_when_every_eval_was_skipped():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("skipped", version="1", when=lambda session: False)
    def skipped(session):
        raise AssertionError("must not run")

    class UnexpectedRunClient(FakeClient):
        def plan(self, assignment_id, request):
            self.plans.append(request)
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="skipped",
                runs=(PlannedRun("run-injected", "skipped", "1"),),
            )

    client = UnexpectedRunClient()
    with pytest.raises(RuntimeError, match="unrequested evaluation run"):
        asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))
    assert client.submissions == []


def test_server_plan_must_match_assignment_and_include_each_new_selected_eval():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("selected", version="1")
    def selected(session):
        return EvalResult(score=Score(1))

    class WrongAssignmentClient(FakeClient):
        def plan(self, assignment_id, request):
            return PlanResponse(
                assignment_id="another-assignment",
                assignment_status="planned",
                runs=(PlannedRun("run-selected", "selected", "1"),),
            )

    wrong_assignment = WrongAssignmentClient()
    with pytest.raises(RuntimeError, match="different assignment"):
        asyncio.run(
            _runtime(evaluator, wrong_assignment).process_assignment(
                wrong_assignment.assignment
            )
        )

    class WrongStatusClient(FakeClient):
        def plan(self, assignment_id, request):
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="skipped",
                runs=(PlannedRun("run-selected", "selected", "1"),),
            )

    wrong_status = WrongStatusClient()
    with pytest.raises(RuntimeError, match="inconsistent assignment status"):
        asyncio.run(
            _runtime(evaluator, wrong_status).process_assignment(
                wrong_status.assignment
            )
        )

    class OmittedRunClient(FakeClient):
        def plan(self, assignment_id, request):
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="planned",
                runs=(),
            )

    omitted = OmittedRunClient()
    with pytest.raises(RuntimeError, match="omitted a selected evaluation run"):
        asyncio.run(_runtime(evaluator, omitted).process_assignment(omitted.assignment))

    class ReplayedPlanClient(FakeClient):
        def plan(self, assignment_id, request):
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="planned",
                runs=(),
                idempotent_replay=True,
            )

    replayed = ReplayedPlanClient()
    asyncio.run(_runtime(evaluator, replayed).process_assignment(replayed.assignment))
    assert replayed.submissions == []


def test_server_plan_rejects_duplicate_run_ids():
    evaluator = Evaluator(name="test", version="1")
    evaluator.eval("first", version="1")(lambda session: EvalResult(score=Score(1)))
    evaluator.eval("second", version="1")(lambda session: EvalResult(score=Score(1)))

    class DuplicateRunClient(FakeClient):
        def plan(self, assignment_id, request):
            return PlanResponse(
                assignment_id=assignment_id,
                assignment_status="planned",
                runs=(
                    PlannedRun("same-run", "first", "1"),
                    PlannedRun("same-run", "second", "1"),
                ),
            )

    client = DuplicateRunClient()
    with pytest.raises(RuntimeError, match="duplicate evaluation run id"):
        asyncio.run(_runtime(evaluator, client).process_assignment(client.assignment))
    assert client.submissions == []


def test_register_advertises_the_deterministic_catalog():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("quality", version="7")
    def quality(session):
        return EvalResult(score=Score(1))

    client = FakeClient()
    runtime = _runtime(evaluator, client)
    asyncio.run(runtime.register())
    request = client.register_requests[0]
    assert request.catalog_revision == evaluator.catalog_revision
    assert request.definitions[0].eval_version == "7"
    assert runtime._heartbeat_interval == 30


def test_runtime_readiness_tracks_registration_contact_and_shutdown(monkeypatch):
    evaluator = Evaluator(name="test", version="1")
    runtime = _runtime(evaluator, FakeClient())

    assert runtime.is_ready() is False
    assert runtime.metrics() == {}

    asyncio.run(runtime.register())
    assert runtime.is_ready() is True
    assert runtime.metrics() == {"registration_success": 1}

    last_contact = runtime._last_server_contact
    assert last_contact is not None
    monkeypatch.setattr(time, "monotonic", lambda: last_contact + 121)
    assert runtime.is_ready() is False

    monkeypatch.setattr(time, "monotonic", lambda: last_contact)
    runtime.stop()
    assert runtime.is_ready() is False


def test_runtime_metrics_count_claims_conditions_and_outcomes():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("selected", version="1", when=lambda session: True)
    def selected(session):
        return EvalResult(score=Score(1))

    @evaluator.eval("skipped", version="1", when=lambda session: False)
    def skipped(session):
        raise AssertionError("must not run")

    runtime = _runtime(evaluator, FakeClient())

    async def exercise():
        await runtime.register()
        return await runtime.run_once()

    assert asyncio.run(exercise()) == 1
    assert runtime.metrics() == {
        "assignments_claimed": 1,
        "conditions_selected": 1,
        "conditions_skipped": 1,
        "registration_success": 1,
        "runs_succeeded": 1,
    }


def test_runtime_metrics_count_registration_failure():
    evaluator = Evaluator(name="test", version="1")

    class BrokenClient(FakeClient):
        def register(self, request):
            raise EvaluatorAPIError(
                status=503,
                code="unavailable",
                message="try later",
                retryable=True,
            )

    runtime = _runtime(evaluator, BrokenClient())
    with pytest.raises(EvaluatorAPIError):
        asyncio.run(runtime.register())
    assert runtime.is_ready() is False
    assert runtime.metrics() == {"registration_failure": 1}


def test_invalid_registration_response_does_not_make_runtime_ready():
    evaluator = Evaluator(name="test", version="1")

    class InvalidTimingClient(FakeClient):
        def register(self, request):
            return RegisterResponse(
                evaluator_instance_id="instance",
                evaluator_kind=self._kind(),
                heartbeat_interval_seconds=120,
                lease_duration_seconds=120,
                poll_interval_seconds=10,
                claim_limit=1,
            )

        @staticmethod
        def _kind():
            from failproofai_sdk.evaluator import EvaluatorKind

            return EvaluatorKind.CUSTOMER

    runtime = _runtime(evaluator, InvalidTimingClient())
    with pytest.raises(RuntimeError, match="invalid evaluator timing"):
        asyncio.run(runtime.register())
    assert runtime.is_ready() is False
    assert runtime.metrics() == {"registration_failure": 1}


def test_lost_claim_response_waits_out_the_lease_before_claiming_again():
    evaluator = Evaluator(name="test", version="1")

    class LostResponseClient(FakeClient):
        def claim(self, request):
            self.claim_requests.append(request)
            raise EvaluatorAPIError(
                status=None,
                code="transport_error",
                message="response lost",
                retryable=True,
            )

    runtime = _runtime(evaluator, LostResponseClient())
    waits = []

    async def stop_after_wait(seconds):
        waits.append(seconds)
        runtime.stop()

    runtime._wait_or_stop = stop_after_wait
    asyncio.run(runtime.run_forever())

    assert waits == [120.0]
    assert len(runtime.client.claim_requests) == 1
    assert runtime.metrics() == {
        "claim_failures": 1,
        "registration_success": 1,
    }


def test_idle_claim_waits_the_advertised_poll_interval_before_polling_again():
    # Normal short polling: an empty claim returns immediately (no long-poll), so
    # the worker sleeps the server-advertised poll_interval_seconds — 10 in the
    # fixture register response — instead of hot-looping. The claim request also no
    # longer carries a wait_seconds field.
    evaluator = Evaluator(name="test", version="1")

    class IdleClient(FakeClient):
        def claim(self, request):
            self.claim_requests.append(request)
            return ClaimResponse(assignments=())

    runtime = _runtime(evaluator, IdleClient())
    waits = []

    async def stop_after_wait(seconds):
        waits.append(seconds)
        runtime.stop()

    runtime._wait_or_stop = stop_after_wait
    asyncio.run(runtime.run_forever())

    assert waits == [10.0]
    assert len(runtime.client.claim_requests) == 1
    assert not hasattr(runtime.client.claim_requests[0], "wait_seconds")


def test_nonretryable_claim_failure_stops_the_worker():
    evaluator = Evaluator(name="test", version="1")

    class RejectedClaimClient(FakeClient):
        def claim(self, request):
            self.claim_requests.append(request)
            raise EvaluatorAPIError(
                status=409,
                code="catalog_mismatch",
                message="register again with the current catalog",
                retryable=False,
            )

    runtime = _runtime(evaluator, RejectedClaimClient())
    with pytest.raises(EvaluatorAPIError, match="catalog_mismatch"):
        asyncio.run(runtime.run_forever())
    assert len(runtime.client.claim_requests) == 1
    assert runtime.metrics() == {
        "claim_failures": 1,
        "registration_success": 1,
    }


@pytest.mark.parametrize(
    ("assignments", "message"),
    [
        (lambda item: (item, item), "duplicate assignments"),
        (
            lambda item: tuple(
                replace(item, assignment_id=f"assignment-{index}") for index in range(3)
            ),
            "more assignments than requested",
        ),
    ],
)
def test_claim_response_cannot_exceed_capacity_or_repeat_work(assignments, message):
    evaluator = Evaluator(name="test", version="1")

    class InvalidClaimClient(FakeClient):
        def claim(self, request):
            return ClaimResponse(assignments=assignments(self.assignment))

    runtime = _runtime(evaluator, InvalidClaimClient())
    with pytest.raises(RuntimeError, match=message):
        asyncio.run(runtime.run_once())
    assert runtime.metrics() == {}


def test_register_applies_server_claim_limit_and_disabled_definitions():
    evaluator = Evaluator(name="test", version="1")

    @evaluator.eval("disabled", version="1")
    def disabled(session):
        raise AssertionError("disabled eval must not run")

    class RestrictedClient(FakeClient):
        def register(self, request):
            self.register_requests.append(request)
            return RegisterResponse(
                evaluator_instance_id="instance",
                evaluator_kind=self._kind(),
                heartbeat_interval_seconds=10,
                lease_duration_seconds=120,
                poll_interval_seconds=10,
                claim_limit=1,
                disabled_definitions=("disabled",),
            )

        @staticmethod
        def _kind():
            from failproofai_sdk.evaluator import EvaluatorKind

            return EvaluatorKind.CUSTOMER

    client = RestrictedClient()
    runtime = _runtime(evaluator, client)

    async def exercise():
        await runtime.register()
        await runtime.run_once()

    asyncio.run(exercise())
    assert runtime._claim_limit == 1
    assert client.claim_requests[0].capacity == 1
    assert client.plans[0].selected == ()
    assert client.plans[0].skipped[0].reason_code == "disabled_by_server"


def test_worker_config_requires_dedicated_credentials(monkeypatch):
    monkeypatch.delenv("FAILPROOFAI_EVALUATOR_URL", raising=False)
    monkeypatch.delenv("FAILPROOFAI_EVALUATOR_TOKEN", raising=False)
    with pytest.raises(ValueError, match="URL is required"):
        WorkerConfig.from_env()


def test_register_rejects_non_positive_poll_interval():
    # The worker adopts the server-advertised poll_interval_seconds (normal short
    # polling — there is no long-poll wait). A non-positive interval would make the
    # claim loop hot-spin, so registration must refuse it.
    evaluator = Evaluator(name="test", version="1")

    class ZeroPollClient(FakeClient):
        def register(self, request):
            return RegisterResponse(
                evaluator_instance_id="instance",
                evaluator_kind=self._kind(),
                heartbeat_interval_seconds=30,
                lease_duration_seconds=120,
                poll_interval_seconds=0,
                claim_limit=1,
            )

        @staticmethod
        def _kind():
            from failproofai_sdk.evaluator import EvaluatorKind

            return EvaluatorKind.CUSTOMER

    runtime = _runtime(evaluator, ZeroPollClient())
    with pytest.raises(RuntimeError, match="invalid evaluator timing"):
        asyncio.run(runtime.register())
    assert runtime.is_ready() is False


def test_worker_config_rejects_header_control_characters(monkeypatch):
    monkeypatch.setenv("FAILPROOFAI_EVALUATOR_URL", "https://cloud.example")
    monkeypatch.setenv("FAILPROOFAI_EVALUATOR_TOKEN", "secret")
    monkeypatch.setenv("FAILPROOFAI_EVALUATOR_WORKER_ID", "worker\nforged")
    with pytest.raises(ValueError, match="control characters"):
        WorkerConfig.from_env()


def test_graceful_drain_cancels_work_after_the_configured_deadline():
    evaluator = Evaluator(name="test", version="1")
    client = FakeClient()
    runtime = WorkerRuntime(
        evaluator,
        WorkerConfig(
            server_url="https://cloud.example",
            credential="secret",
            worker_id="worker-test",
            drain_timeout_seconds=1,
        ),
        client=client,
    )
    cancelled = False

    async def exercise():
        nonlocal cancelled

        async def active_work():
            nonlocal cancelled
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled = True
                raise

        task = asyncio.create_task(active_work())
        runtime._active.add(task)
        await asyncio.sleep(0)
        runtime.config = WorkerConfig(
            server_url=runtime.config.server_url,
            credential=runtime.config.credential,
            worker_id=runtime.config.worker_id,
            drain_timeout_seconds=0,
        )
        await runtime.drain()

    asyncio.run(exercise())
    assert cancelled is True
    assert runtime._active == set()


def test_stop_interrupts_capacity_wait_and_enters_drain():
    runtime = _runtime(Evaluator(name="test", version="1"), FakeClient())

    async def exercise():
        blocker = asyncio.Event()
        work = asyncio.create_task(blocker.wait())
        runtime._active.add(work)
        await asyncio.sleep(0)

        runtime.stop()
        await asyncio.wait_for(runtime._wait_for_progress(), timeout=0.1)

        assert work.done() is False
        work.cancel()
        await asyncio.gather(work, return_exceptions=True)

    asyncio.run(exercise())


def test_eval_execution_respects_process_concurrency():
    evaluator = Evaluator(name="test", version="1")
    active = 0
    peak = 0

    async def measured(session):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return EvalResult(score=Score(1))

    evaluator.eval("first", version="1")(measured)
    evaluator.eval("second", version="1")(measured)
    client = FakeClient()
    runtime = WorkerRuntime(
        evaluator,
        WorkerConfig(
            server_url="https://cloud.example",
            credential="secret",
            worker_id="worker-test",
            max_concurrency=1,
        ),
        client=client,
    )
    asyncio.run(runtime.process_assignment(client.assignment))
    assert peak == 1
    DefinitionsResponse,
    ExecutionMode,
