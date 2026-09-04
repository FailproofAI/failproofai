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
