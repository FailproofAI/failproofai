from __future__ import annotations

import pytest

from failproofai_sdk.evaluator import EvalResult, Score
from failproofai_sdk.evaluator.protocol import SessionTranscript, TranscriptEvent
from failproofai_sdk.evaluator.source import (
    MAX_AST_NODES,
    MAX_EVALUATOR_SOURCE_BYTES,
    MAX_POW_EXPONENT,
    MAX_SANDBOX_TIMEOUT_SECONDS,
    EvaluationSandboxUnavailable,
    EvaluationTimeout,
    UnsafeEvaluatorSource,
    _clamp_budget,
    compile_condition,
    compile_evaluator,
    source_checksum,
)


def Session(event_count: int = 3) -> SessionTranscript:
    """A real, serializable transcript — managed evals now run in a subprocess and
    the transcript crosses the boundary via `to_wire`, so a dummy object won't do.
    Each event carries a dict payload (so `events[0].payload.get` is reachable)."""
    events = tuple(
        TranscriptEvent(
            id=f"e{i}",
            ts="2026-08-28T12:00:00.000000Z",
            event_type="tool_use",
            payload={"k": "v", "tool_name": "search"},
        )
        for i in range(event_count)
    )
    return SessionTranscript(
        assignment_id="a",
        session_id="s",
        session_revision_id="r",
        agent_id="agent",
        environment="test",
        started_at="2026-08-28T12:00:00.000000Z",
        ended_at="2026-08-28T12:00:01.000000Z",
        event_count=event_count,
        events=events,
    )


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


@pytest.mark.parametrize(
    "source",
    [
        # `str.format` / `str.format_map` traverse a format string's field spec
        # at the C level, reaching attributes the AST dunder guard never sees.
        # These reached real `__builtins__` before the denylist landed.
        '"{0.__class__.__init__.__globals__[__builtins__][__import__]}".format(session)',
        '"{0.__class__}".format(session)',
        'str.format("{0.__class__}", session)',
        '"{a.__class__}".format_map({"a": session})',
        # A reasoning string is where a leak would surface — block it there too.
        'EvalResult(score=Score(0.5), reasoning="{0.__class__}".format(session))',
    ],
)
def test_restricted_expressions_reject_format_string_traversal(source):
    with pytest.raises(UnsafeEvaluatorSource):
        compile_evaluator(source)


@pytest.mark.parametrize(
    "source",
    [
        # Generator/frame/code introspection reaches the eval globals and, via
        # dict.update on them, could poison a shared namespace. None of these
        # attribute names start with "_", so only the default-deny allowlist
        # stops them.
        "EvalResult(score=Score(0.5), reasoning=str((x for x in [1]).gi_frame.f_globals))",
        "EvalResult(score=Score(0.5), reasoning=str((x for x in [1]).gi_code))",
        'EvalResult(score=Score(0.5), reasoning=str((x for x in [1]).gi_frame.f_globals.update({"P": 1})))',
        # `mro` is a public method on the type metaclass; it reaches `object`.
        "EvalResult(score=Score(0.5), reasoning=str(str.mro()[-1]))",
        "EvalResult(score=Score(0.5), reasoning=str(int.mro()))",
        # A live function's identity would leak a heap pointer (ASLR defeat).
        "EvalResult(score=Score(0.5), reasoning=str(EvalResult.result_items))",
    ],
)
def test_restricted_expressions_reject_introspection_attributes(source):
    with pytest.raises(UnsafeEvaluatorSource, match="attribute"):
        compile_evaluator(source)


def test_no_reachable_construct_leaks_a_heap_pointer_repr():
    # An object's default repr (`<... object at 0x...>`) leaks a live host heap
    # address (ASLR/memory-layout disclosure) if coerced into a result field.
    # Generator expressions are rejected at compile; `enumerate` is not bound, so
    # it raises NameError at run time and becomes a bounded failed run instead of
    # a disclosure. Either way, a pointer must never reach a result string.
    import re

    from failproofai_sdk.evaluator.source import _SAFE_GLOBALS

    with pytest.raises(UnsafeEvaluatorSource, match="GeneratorExp"):
        compile_evaluator("EvalResult(score=Score(1.0), reasoning=str((x for x in [1])))")

    evaluate = compile_evaluator(
        "EvalResult(score=Score(1.0), reasoning=str(enumerate([1])))"
    )
    with pytest.raises(NameError):
        evaluate(Session())

    # No value bound into the evaluation namespace reprs to a heap pointer.
    pointer = re.compile(r"0x[0-9a-fA-F]+")
    leaky = {
        name: repr(value)
        for name, value in _SAFE_GLOBALS.items()
        if name != "__builtins__" and pointer.search(repr(value))
    }
    assert leaky == {}


@pytest.mark.parametrize(
    "inner",
    [
        # A bound method's repr leaks the underlying object's heap pointer, and
        # these methods are allowlisted (needed by real evals) so they cannot be
        # removed. The OUTPUT guard rejects the disclosure wherever it rides out.
        "session.events[0].payload.get",
        "''.join",
        "'x'.encode",
        "'a,b'.split",
    ],
)
def test_object_repr_pointer_disclosure_is_rejected_at_the_output(inner):
    for field in (
        f'EvalResult(score=Score(1.0), reasoning=str({inner}))',
        f'EvalResult(score=Score(1.0), summary=str({inner}))',
        f'EvalResult(score=Score(1.0, display_value=str({inner})))',
        f'EvalResult(score=Score(1.0), labels=(str({inner}),))',
    ):
        evaluate = compile_evaluator(field)
        with pytest.raises(UnsafeEvaluatorSource, match="object repr"):
            evaluate(Session())


def test_each_evaluation_gets_isolated_globals_so_it_cannot_poison_the_next():
    # Even setting aside the allowlist, one evaluation must not be able to leave
    # state behind for the next. Compiling and running twice must not share a
    # mutable namespace.
    from failproofai_sdk.evaluator.source import _fresh_globals

    first = _fresh_globals()
    second = _fresh_globals()
    assert first is not second
    assert first["__builtins__"] is not second["__builtins__"]
    first["__poison__"] = "leaked"
    assert "__poison__" not in second


def test_format_denylist_does_not_block_legitimate_string_methods():
    # The fix is a targeted denylist of `format`/`format_map`, not a ban on all
    # string methods — ordinary evaluations must still compile and run.
    evaluate = compile_evaluator(
        'EvalResult(score=Score(0.9, passed=True), '
        'reasoning="tools=" + str(session.event_count).upper())'
    )
    result = evaluate(Session())
    assert result.reasoning == "tools=3"


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


# --- SEC-001: managed source cannot exhaust the worker (killable-fork sandbox) ---


def test_compute_bomb_is_killed_within_its_budget():
    # `sum(range(10**9))` would burn CPU for ~20s in-process, uncancellable — a
    # CPU-bound loop (not a big allocation) so the wall-clock/CPU budget is what
    # stops it, deterministically, rather than the memory ceiling. The forked
    # sandbox kills it at its budget.
    import time as _time

    evaluate = compile_evaluator(
        "EvalResult(score=Score(1.0), reasoning=str(sum(range(10**9))))",
        timeout_seconds=1,
    )
    started = _time.monotonic()
    with pytest.raises(EvaluationTimeout):
        evaluate(Session())
    assert _time.monotonic() - started < 5  # bounded by the ~1s budget, not ~20s


def test_condition_compute_bomb_is_also_bounded():
    condition = compile_condition("sum(range(10**8)) > 0", timeout_seconds=1)
    with pytest.raises(EvaluationTimeout):
        condition(Session())


def test_literal_pow_exponent_bomb_is_rejected_at_compile():
    with pytest.raises(UnsafeEvaluatorSource, match="exponent"):
        compile_evaluator(f"EvalResult(score=Score(10 ** {MAX_POW_EXPONENT + 1}))")
    # A small constant exponent stays allowed.
    result = compile_evaluator(
        "EvalResult(score=Score(1.0), reasoning=str(2 ** 3))"
    )(Session())
    assert result.reasoning == "8"


def test_oversized_expression_is_rejected_at_compile():
    huge = "[" + ",".join("1" for _ in range(MAX_AST_NODES)) + "]"
    with pytest.raises(UnsafeEvaluatorSource, match="too large"):
        compile_evaluator(f"EvalResult(score=Score(len({huge}) / len({huge})))")


def test_normal_managed_eval_survives_the_fork_boundary():
    # A session-dependent result must round-trip out of the forked child intact.
    result = compile_evaluator(
        "EvalResult(score=Score(1.0 if session.event_count > 0 else 0.0), "
        "reasoning=str(session.event_count))"
    )(Session())
    assert isinstance(result, EvalResult)
    assert result.score.value == 1.0
    assert result.reasoning == "3"


def test_sandbox_fails_closed_without_a_serializable_transcript():
    # The transcript crosses into the subprocess via `to_wire`. A session that
    # can't be serialized cannot be sandboxed, so refuse rather than run unbounded.
    class NotATranscript:
        event_count = 1

    with pytest.raises(EvaluationSandboxUnavailable):
        compile_evaluator("EvalResult(score=Score(1.0))")(NotATranscript())


def test_server_timeout_cannot_exceed_the_hard_ceiling():
    # SEC-001: a large server-provided timeout must not remove the execution bound.
    assert _clamp_budget(10**9) == float(MAX_SANDBOX_TIMEOUT_SECONDS)
    assert _clamp_budget(0) == 30.0
    assert _clamp_budget(None) == 30.0
    assert _clamp_budget(5) == 5.0
