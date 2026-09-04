"""Regression tests for Evaluator v2 PR-review fixes.

Covers: control-character rejection in bounded result text, reasoning carried on
non-score primary results, and the object-repr guard no longer false-rejecting
ordinary hex literals.
"""
from __future__ import annotations

import pytest

from failproofai_sdk.evaluator.authoring import EvalResult, Metric, Score
from failproofai_sdk.evaluator.source import _forbid_object_reprs, UnsafeEvaluatorSource


def test_bounded_rejects_c0_control_characters():
    # NUL / ESC in reasoning would be accepted by the SDK but rejected by the
    # server with a non-retryable 422, silently losing a successful eval.
    with pytest.raises(ValueError):
        EvalResult(score=Score(1.0, passed=True), reasoning="bad\x00value")
    with pytest.raises(ValueError):
        EvalResult(score=Score(1.0, passed=True), summary="esc\x1b[31m")


def test_bounded_keeps_tab_newline_cr():
    r = EvalResult(score=Score(1.0, passed=True), reasoning="line one\nline\ttwo\r")
    items = r.result_items("q")
    assert items[0].reasoning == "line one\nline\ttwo\r"


def test_reasoning_carried_on_metric_primary():
    # A metric-kind eval's primary result is the metric whose key == eval_key.
    r = EvalResult(metrics={"latency": Metric(12.0)}, reasoning="slow tail")
    items = {i.result_key: i for i in r.result_items("latency")}
    assert items["latency"].reasoning == "slow tail"


def test_reasoning_not_smeared_onto_secondary_metrics():
    r = EvalResult(
        score=Score(1.0, passed=True),
        metrics={"aux": Metric(3.0)},
        reasoning="about the score",
    )
    items = {i.result_key: i for i in r.result_items("q")}
    assert items["q"].reasoning == "about the score"
    assert items["aux"].reasoning is None


def test_object_repr_guard_allows_plain_hex_literals():
    # A hex colour / digest in result text must not be mistaken for a pointer repr.
    assert _forbid_object_reprs("summary", "background 0xFFFFFF, sha 0xdeadbeef1234") == (
        "background 0xFFFFFF, sha 0xdeadbeef1234"
    )


def test_object_repr_guard_still_rejects_pointer_reprs():
    with pytest.raises(UnsafeEvaluatorSource):
        _forbid_object_reprs("summary", "<foo.Bar object at 0x7f9c1a2b3c4d>")
    # ...even with the leading '<' stripped (the reshape bypass).
    with pytest.raises(UnsafeEvaluatorSource):
        _forbid_object_reprs("summary", "foo.Bar object at 0x7f9c1a2b3c4d>")


# ---- runtime fixes (Section 1/2 of the follow-up review) --------------------
import asyncio
from dataclasses import replace

from failproofai_sdk.evaluator import (
    ClaimResponse, EvaluatorAPIError, PlannedRun, PlanResponse, SessionTranscript,
    WorkerConfig, WorkerRuntime,
)
from failproofai_sdk.evaluator import RegisterResponse, HeartbeatResponse
import json as _json
from pathlib import Path as _Path


def _samples_fx():
    return _json.loads(
        (_Path(__file__).parent / "fixtures" / "evaluator_v2" / "contract.json").read_text()
    )["samples"]


class _FakeClient:
    def __init__(self):
        s = _samples_fx()
        self.assignment = replace(
            ClaimResponse.from_wire(s["claim_response"]).assignments[0],
            definitions_url="",
        )
        self.session = SessionTranscript.from_wire(s["transcript_response"])
        self.plans, self.submissions, self.heartbeats = [], [], []

    def transcript(self, assignment, *, worker_id):
        return self.session

    def plan(self, assignment_id, request):
        self.plans.append(request)
        return PlanResponse(
            assignment_id=assignment_id,
            assignment_status="planned" if request.selected else "skipped",
            runs=tuple(
                PlannedRun(f"run-{i.eval_key}", i.eval_key, i.eval_version)
                for i in request.selected
            ),
        )

    def submit_result(self, run_id, request):
        self.submissions.append((run_id, request))

    def heartbeat(self, request):
        self.heartbeats.append(request)
        return HeartbeatResponse(
            lease_expires_at="2026-08-28T12:02:30.000000Z",
            accepted_run_ids=tuple(r.evaluation_run_id for r in request.runs),
        )


def _rt(evaluator, client):
    return WorkerRuntime(
        evaluator,
        WorkerConfig(server_url="https://cloud.example", credential="x",
                     worker_id="worker-test", max_concurrency=2),
        client=client,
    )


def test_transcript_too_large_skips_assignment_without_crashing():
    from failproofai_sdk.evaluator import Evaluator, EvalResult, Score
    ev = Evaluator(name="t", version="1")
    ev.eval("quality", version="1")(lambda s: EvalResult(score=Score(1.0, passed=True)))

    class TooLarge(_FakeClient):
        def transcript(self, assignment, *, worker_id):
            raise EvaluatorAPIError(
                status=413, code="transcript_too_large",
                message="transcript exceeds 26214400 bytes", retryable=False,
            )

    c = TooLarge()
    # returns cleanly — no plan, no submission, no exception
    asyncio.run(_rt(ev, c).process_assignment(c.assignment))
    assert c.plans == [] and c.submissions == []


def test_idempotent_replay_runs_a_definition_this_attempt_skipped():
    from failproofai_sdk.evaluator import Evaluator, EvalResult, Score, ConditionResult
    ev = Evaluator(name="t", version="1")

    @ev.eval("quality", version="1", when=lambda s: ConditionResult(False, "nope"))
    def quality(session):
        return EvalResult(score=Score(1.0, passed=True))

    class ReplaySkipped(_FakeClient):
        def plan(self, assignment_id, request):
            # This attempt selected nothing, but the server replays the first
            # attempt's run for the now-skipped eval.
            return PlanResponse(
                assignment_id=assignment_id, assignment_status="planned",
                runs=(PlannedRun("run-quality", "quality", "1"),),
                idempotent_replay=True,
            )

    c = ReplaySkipped()
    asyncio.run(_rt(ev, c).process_assignment(c.assignment))
    assert [rid for rid, _ in c.submissions] == ["run-quality"]
