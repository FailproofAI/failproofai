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
        # A bound method's repr is `<... at 0xADDR>` — a live heap pointer. These
        # methods stay allowlisted (real evals CALL them), but referencing one as a
        # bare VALUE only serves to stringify that repr, so it is now rejected at
        # COMPILE — the disclosure is closed at its source, not at the output.
        "session.events[0].payload.get",
        "''.join",
        "'x'.encode",
        "'a,b'.split",
    ],
)
def test_bare_bound_method_reference_is_rejected_at_compile(inner):
    for field in (
        f'EvalResult(score=Score(1.0), reasoning=str({inner}))',
        f'EvalResult(score=Score(1.0), summary=str({inner}))',
        f'EvalResult(score=Score(1.0, display_value=str({inner})))',
        f'EvalResult(score=Score(1.0), labels=(str({inner}),))',
    ):
        with pytest.raises(UnsafeEvaluatorSource, match="only to call it"):
            compile_evaluator(field)


def test_heap_pointer_output_guard_bypasses_are_closed_at_compile():
    # An adversarial-review finding: the output-boundary regex was anchored on `<`,
    # so a managed source could keep the address while reshaping the wrapper text —
    # str(...).replace("<",""), an f-string, or %-formatting all coerce a bound
    # method at a point the old scan missed. Each needs a BARE bound-method
    # reference, which the compile-time call-site rule now rejects outright.
    bypasses = [
        # str(...).replace("<","") strips the old regex's `<` anchor.
        'EvalResult(score=Score(1.0), reasoning=str(dict().get).replace("<", ""))',
        # f-strings coerce at the C level, past the `str` global.
        'EvalResult(score=Score(1.0), reasoning=f"{session.events[0].payload.get}")',
        # %-formatting coerces at the C level too.
        'EvalResult(score=Score(1.0), reasoning="%s" % session.events[0].payload.get)',
    ]
    for src in bypasses:
        with pytest.raises(UnsafeEvaluatorSource, match="only to call it"):
            compile_evaluator(src)


def test_called_methods_and_data_attributes_still_stringify():
    # The call-site rule blocks only BARE method references. Calling methods and
    # reading data attributes (both pointer-free) must still work — including the
    # f-string and %-formatting paths — so legitimate evaluations are unaffected.
    reasoning_call = compile_evaluator(
        'EvalResult(score=Score(1.0), '
        'reasoning=str(session.events[0].payload.get("tool_name")))'
    )(Session())
    assert reasoning_call.reasoning == "search"

    fstring = compile_evaluator(
        'EvalResult(score=Score(1.0), reasoning=f"n={session.event_count}")'
    )(Session())
    assert fstring.reasoning == "n=3"

    percent = compile_evaluator(
        'EvalResult(score=Score(1.0), reasoning="pct=%d" % (session.event_count * 10))'
    )(Session())
    assert percent.reasoning == "pct=30"


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
    # `10**9`, matching the evaluator bomb above, NOT `10**8`.
    #
    # The property under test is "a CPU bomb in a condition is stopped by the
    # sandbox budget", and the bomb has to be big enough that it cannot finish
    # inside that budget on ANY machine the suite runs on. At 10**8 it was only
    # ~1.35 CPU-seconds against a 1-second budget — a 1.35x margin — so on a fast
    # runner the sum simply completed and nothing timed out. It failed exactly
    # that way on CI under Python 3.14, which is faster here than 3.13 (1.35s vs
    # 1.44s measured), while passing locally: a machine-speed coin flip, not a
    # real signal about the sandbox.
    #
    # 10**9 restores the ~13x margin the evaluator twin already had. It costs no
    # extra wall-clock: the sandbox kills the child at its budget either way, so
    # a bigger bomb only widens the gap between "killed" and "could have
    # finished". Do not shrink it back.
    condition = compile_condition("sum(range(10**9)) > 0", timeout_seconds=1)
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


def test_oversized_result_is_rejected_before_it_crosses_back():
    # A result with far more than the 25-item limit must be rejected INSIDE the
    # sandbox (via result_items), so a huge result can never be serialized and
    # shipped back to OOM the worker (SEC-001).
    src = (
        "EvalResult(score=Score(1.0), "
        "metrics={'m' + str(i): float(i) for i in range(200)})"
    )
    with pytest.raises(ValueError, match="at most"):
        compile_evaluator(src, eval_key="q")(Session())


def test_sandbox_slot_wait_counts_against_the_timeout(monkeypatch):
    # SEC-001: acquiring a concurrency slot must count against the wall-clock budget.
    # `asyncio.wait_for` only cancels the awaiter, so a run that blocked UNBOUNDED on
    # a busy slot would still launch a sandbox after its caller was reported timed
    # out — 28 threads could queue behind 4 long sandboxes and starve the worker.
    # With one slot and three 1s compute bombs, all three must resolve within ~one
    # budget (the holder is killed at ~1s; the two queued behind it exhaust their
    # budget waiting and time out WITHOUT ever spawning a child), not three serialized
    # budgets (~3s).
    import threading
    import time as _time

    from failproofai_sdk.evaluator import source as _source

    monkeypatch.setattr(_source, "_SANDBOX_SLOTS", threading.Semaphore(1))
    bomb = compile_evaluator(
        "EvalResult(score=Score(1.0), reasoning=str(sum(range(10**9))))",
        timeout_seconds=1,
    )
    session = Session()
    errors: list[str] = []

    def run():
        try:
            bomb(session)
        except Exception as error:  # noqa: BLE001
            errors.append(type(error).__name__)

    threads = [threading.Thread(target=run) for _ in range(3)]
    started = _time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)
    elapsed = _time.monotonic() - started

    assert errors == ["EvaluationTimeout"] * 3, errors
    # Bounded by ~one budget, NOT three serialized ones — proving the queued runs
    # timed out on slot acquisition instead of each waiting then running in turn.
    assert elapsed < 2.5, f"queued sandboxes were not bounded by the timeout: {elapsed:.2f}s"


def test_allocation_bomb_is_bounded_by_the_per_sandbox_memory_limit():
    # A ~1.6 GiB allocation exceeds the per-sandbox RLIMIT_AS and is killed, so it
    # cannot exhaust the worker even wrapped in an otherwise-valid result. With the
    # concurrent-sandbox cap this also bounds the aggregate across concurrent runs.
    src = "EvalResult(score=Score(1.0 if len([0] * 200000000) >= 0 else 0.0))"
    with pytest.raises((EvaluationTimeout, MemoryError)):
        compile_evaluator(src, timeout_seconds=5)(Session())


def test_sandbox_fails_closed_when_kernel_resource_limits_are_unavailable(monkeypatch):
    # SEC-001: on a platform without the stdlib ``resource`` module (e.g. Windows),
    # the sandbox child cannot install RLIMIT_CPU / RLIMIT_AS on itself, so managed
    # source must be refused BEFORE any child is spawned rather than run unbounded.
    import failproofai_sdk.evaluator.source as source

    monkeypatch.setattr(source, "_resource", None)

    def _no_spawn(*args, **kwargs):
        raise AssertionError("a sandbox child must not be started when limits are unavailable")

    monkeypatch.setattr(source.subprocess, "Popen", _no_spawn)

    with pytest.raises(EvaluationSandboxUnavailable):
        source.compile_evaluator("EvalResult(score=Score(1.0))")(Session())
