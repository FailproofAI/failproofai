from __future__ import annotations

import asyncio
import math

import pytest

from failproofai_sdk.evaluator import (
    Assertion,
    EvalResult,
    Evaluator,
    Metric,
    ResultKind,
    Score,
)


def test_catalog_is_stable_across_registration_order():
    first = Evaluator(name="acme", version="2026.08.1")
    second = Evaluator(name="acme", version="2026.08.1")

    @first.eval("zeta_check", version="1", labels=["z", "a"])
    def first_zeta(session):
        return EvalResult(score=Score(1))

    @first.eval("alpha_check", version="1")
    def first_alpha(session):
        return EvalResult(score=Score(1))

    @second.eval("alpha_check", version="1")
    def second_alpha(session):
        return EvalResult(score=Score(1))

    @second.eval("zeta_check", version="1", labels=["a", "z"])
    def second_zeta(session):
        return EvalResult(score=Score(1))

    assert first.catalog_revision == second.catalog_revision
    assert [item.eval_key for item in first.catalog()] == ["alpha_check", "zeta_check"]


def test_duplicate_eval_keys_are_rejected_even_when_versions_differ():
    evaluator = Evaluator(name="acme", version="1")

    @evaluator.eval("quality", version="1")
    def quality_v1(session):
        return EvalResult(score=Score(1))

    with pytest.raises(ValueError, match="duplicate eval key"):

        @evaluator.eval("quality", version="2")
        def quality_v2(session):
            return EvalResult(score=Score(1))


@pytest.mark.parametrize("value", [-0.01, 1.01, math.nan, math.inf])
def test_scores_are_finite_ratios(value):
    with pytest.raises(ValueError):
        Score(value)


def test_result_presentation_fields_are_bounded_before_networking():
    with pytest.raises(ValueError, match="unit is 65 bytes"):
        Metric(1, unit="u" * 65)
    with pytest.raises(ValueError, match="display value is 257 bytes"):
        Score(1, display_value="x" * 257)
    with pytest.raises(ValueError, match="description is 1001 bytes"):
        Assertion(True, description="x" * 1001)


def test_eval_result_expands_to_typed_long_form_rows():
    result = EvalResult(
        score=Score(0.75, passed=True, unit="ratio"),
        metrics={"call_count": Metric(4, unit="calls")},
        assertions={"had_output": Assertion(True)},
        reasoning="Three useful calls out of four.",
        labels=("tools",),
    )

    items = result.result_items("tool_efficiency")
    assert [item.result_kind for item in items] == [
        ResultKind.SCORE,
        ResultKind.METRIC,
        ResultKind.ASSERTION,
    ]
    assert items[0].reasoning == "Three useful calls out of four."
    assert items[1].numeric_value == 4
    assert items[2].bool_value is True


def test_empty_eval_result_is_rejected_when_serialized():
    with pytest.raises(ValueError, match="must contain"):
        EvalResult().result_items("quality")


def test_result_keys_must_be_unique_across_kinds():
    result = EvalResult(score=Score(1), metrics={"quality": 1})
    with pytest.raises(ValueError, match="result keys must be unique"):
        result.result_items("quality")


def test_sync_and_async_functions_share_one_call_path():
    async def async_eval(session):
        return EvalResult(score=Score(1))

    def sync_eval(session):
        return EvalResult(score=Score(0.5))

    async def exercise():
        sync_result = await Evaluator.call(sync_eval, None)
        async_result = await Evaluator.call(async_eval, None)
        return sync_result, async_result

    sync_result, async_result = asyncio.run(exercise())
    assert sync_result.score.value == 0.5
    assert async_result.score.value == 1


def test_keys_are_machine_safe_and_versions_are_explicit():
    evaluator = Evaluator(name="acme", version="1")
    with pytest.raises(ValueError, match="must match"):
        evaluator.eval("Not Safe", version="1")
    with pytest.raises(ValueError, match="must not be empty"):
        evaluator.eval("safe", version="")
