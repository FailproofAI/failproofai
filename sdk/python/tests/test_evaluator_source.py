from __future__ import annotations

import pytest

from failproofai_sdk.evaluator import EvalResult, Score
from failproofai_sdk.evaluator.source import (
    MAX_EVALUATOR_SOURCE_BYTES,
    UnsafeEvaluatorSource,
    compile_condition,
    compile_evaluator,
    source_checksum,
)


class Session:
    event_count = 3


def test_restricted_expressions_can_evaluate_conditions_and_results():
    assert compile_condition("session.event_count > 0")(Session()) is True
    result = compile_evaluator("EvalResult(score=Score(0.75, passed=True))")(
        Session()
    )
    assert isinstance(result, EvalResult)
    assert result.score == Score(0.75, passed=True)


@pytest.mark.parametrize(
    "source",
    [
        "__import__('os').system('id')",
        "session.__class__",
        "(lambda: 1)()",
        "[x for x in ().__class__.__base__.__subclasses__()]",
    ],
)
def test_restricted_expressions_reject_escape_primitives(source):
    with pytest.raises(UnsafeEvaluatorSource):
        compile_evaluator(source)


def test_restricted_expressions_reject_statements_and_oversized_source():
    with pytest.raises(UnsafeEvaluatorSource, match="one expression"):
        compile_evaluator("import os")
    with pytest.raises(UnsafeEvaluatorSource, match="exceeds"):
        compile_evaluator("x" * (MAX_EVALUATOR_SOURCE_BYTES + 1))


def test_result_and_condition_types_are_checked_at_runtime():
    with pytest.raises(TypeError, match="EvalResult"):
        compile_evaluator("True")(Session())
    with pytest.raises(TypeError, match="bool or ConditionResult"):
        compile_condition("1")(Session())


def test_source_checksum_covers_condition_and_evaluator_together():
    base = source_checksum(None, "EvalResult()")
    assert base == source_checksum(None, "EvalResult()")
    assert base != source_checksum("True", "EvalResult()")
    assert base != source_checksum(None, "EvalResult(summary='changed')")
