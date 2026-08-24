"""Tests for session() / agent() / tool_call().

The exception table in `_scopes.agent` is the contract most likely to be broken
by a well-meaning refactor, so every row of it has a test *and* every test
asserts event ORDER, not just presence: the dashboard closes the agent span at
`agent_end`, so an `error` emitted after it is attributed to nothing.
"""

import asyncio
from datetime import datetime, timezone

import pytest

import failproofai_sdk
import failproofai_sdk._context as _context
import failproofai_sdk._runtime as _runtime


def indexes(entries, event_type):
    return [i for i, e in enumerate(entries) if e["type"] == event_type]


def only(entries, event_type):
    matches = [e for e in entries if e["type"] == event_type]
    assert len(matches) == 1, f"expected one {event_type}, got {len(matches)}"
    return matches[0]


# ---------------------------------------------------------------------------
# session()
# ---------------------------------------------------------------------------

def test_session_emits_no_events(events):
    with failproofai_sdk.session("s-1"):
        pass
    assert events.entries == []


def test_session_binds_agent_id_without_emitting(events):
    with failproofai_sdk.session("s-1", agent_id="worker"):
        _runtime.event.agent_start()
    entry = only(events.entries, "agent_start")
    assert entry["session_id"] == "s-1"
    assert entry["agent_id"] == "worker"


# ---------------------------------------------------------------------------
# agent() — happy path
# ---------------------------------------------------------------------------

def test_agent_brackets_the_run(events):
    with failproofai_sdk.agent("planner", session_id="s-1", goal="find it"):
        pass
    assert events.types() == ["agent_start", "agent_end"]
    start, end = events.entries
    assert start["agent_id"] == "planner"
    assert start["goal"] == "find it"
    assert "parent_id" not in start
    assert end["outcome"] == "success"


def test_agent_generates_a_session_id(events):
    with failproofai_sdk.agent("planner") as ident:
        assert len(ident.session_id) == 32
    assert events.entries[0]["session_id"] == ident.session_id


def test_agent_custom_outcome_and_summary(events):
    with failproofai_sdk.agent("a", session_id="s", outcome="partial", summary="did half"):
        pass
    end = only(events.entries, "agent_end")
    assert end["outcome"] == "partial"
    assert end["summary"] == "did half"


def test_agent_extra_fields_land_on_agent_start(events):
    with failproofai_sdk.agent("a", session_id="s", framework="langgraph", fw_node="retrieve"):
        pass
    start = only(events.entries, "agent_start")
    assert start["framework"] == "langgraph"
    assert start["fw_node"] == "retrieve"


def test_agent_default_id_is_main(events):
    with failproofai_sdk.agent(session_id="s"):
        pass
    assert events.entries[0]["agent_id"] == "main"


# ---------------------------------------------------------------------------
# Nesting and parent_id
# ---------------------------------------------------------------------------

def test_parent_ids_follow_the_stack(events):
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.agent("b"):
            with failproofai_sdk.agent("c"):
                assert failproofai_sdk.current().depth == 3
                assert failproofai_sdk.current().parent_id == "b"

    starts = [e for e in events.entries if e["type"] == "agent_start"]
    assert [e["agent_id"] for e in starts] == ["a", "b", "c"]
    assert "parent_id" not in starts[0]
    assert starts[1]["parent_id"] == "a"
    assert starts[2]["parent_id"] == "b"


def test_explicit_parent_none_forces_a_root_span(events):
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.agent("b", parent_id=None):
            pass
    start_b = [e for e in events.entries if e["type"] == "agent_start"][1]
    assert "parent_id" not in start_b


def test_explicit_parent_string_overrides(events):
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.agent("b", parent_id="somewhere-else"):
            pass
    start_b = [e for e in events.entries if e["type"] == "agent_start"][1]
    assert start_b["parent_id"] == "somewhere-else"


def test_nested_agent_inherits_the_session(events):
    with failproofai_sdk.agent("a", session_id="s-outer"):
        with failproofai_sdk.agent("b"):
            pass
    assert {e["session_id"] for e in events.entries} == {"s-outer"}


def test_stack_unwinds_after_an_exception_through_three_scopes(events):
    class Boom(Exception):
        pass

    try:
        with failproofai_sdk.agent("a", session_id="s"):
            with failproofai_sdk.agent("b"):
                with failproofai_sdk.agent("c"):
                    raise Boom("deep")
    except Boom as exc:
        assert str(exc) == "deep"
    else:
        pytest.fail("Boom was not raised")

    assert failproofai_sdk.current().depth == 0
    assert _context.snapshot() == (None, ())
    # Each level reports the failure on its own span, innermost first.
    assert events.types() == [
        "agent_start", "agent_start", "agent_start",
        "error", "agent_end",
        "error", "agent_end",
        "error", "agent_end",
    ]
    ends = [e for e in events.entries if e["type"] == "agent_end"]
    assert [e["agent_id"] for e in ends] == ["c", "b", "a"]


def test_stack_unwinds_even_when_emission_fails(events, monkeypatch):
    real_agent_end = _runtime.event.agent_end

    def explode(**kwargs):
        if kwargs.get("agent_id") == "b":
            raise RuntimeError("writer is down")
        return real_agent_end(**kwargs)

    monkeypatch.setattr(_runtime.event, "agent_end", explode)

    with failproofai_sdk.agent("a", session_id="s"):
        with pytest.raises(RuntimeError, match="writer is down"):
            with failproofai_sdk.agent("b"):
                pass
        assert failproofai_sdk.current().agent_id == "a"
        assert failproofai_sdk.current().depth == 1


def test_failed_agent_start_does_not_leave_a_frame(events):
    with pytest.raises(ValueError, match="Reserved field"):
        with failproofai_sdk.agent("a", session_id="s", timestamp="nope"):
            pass
    assert _context.snapshot() == (None, ())


# ---------------------------------------------------------------------------
# The exception table — one test per row, asserting order
# ---------------------------------------------------------------------------

def test_no_exception_emits_only_agent_end(events):
    with failproofai_sdk.agent("a", session_id="s"):
        pass
    assert events.types() == ["agent_start", "agent_end"]
    assert only(events.entries, "agent_end")["outcome"] == "success"


def test_exception_emits_error_before_agent_end(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            raise ValueError("nope")
    except ValueError as exc:
        assert str(exc) == "nope"
    else:
        pytest.fail("ValueError was not raised")

    types = events.types()
    assert types.index("error") < types.index("agent_end")
    err = only(events.entries, "error")
    assert err["error_type"] == "ValueError"
    assert err["message"] == "nope"
    assert "ValueError: nope" in err["traceback"]
    end = only(events.entries, "agent_end")
    # "failed", never "failure": only error|failed|timeout|rejected count as a
    # failure server-side.
    assert end["outcome"] == "failed"


def _assert_failed_base_exception(events, expected_type):
    types = events.types()
    assert types.index("error") < types.index("agent_end")
    assert only(events.entries, "agent_end")["outcome"] == "failed"
    assert only(events.entries, "error")["error_type"] == expected_type.__name__


def test_keyboard_interrupt_is_reported_as_failed(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            raise KeyboardInterrupt()
    except KeyboardInterrupt:
        pass
    else:
        pytest.fail("KeyboardInterrupt was not raised")
    _assert_failed_base_exception(events, KeyboardInterrupt)


def test_system_exit_is_reported_as_failed(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            raise SystemExit()
    except SystemExit:
        pass
    else:
        pytest.fail("SystemExit was not raised")
    _assert_failed_base_exception(events, SystemExit)


def _assert_cancelled_without_error(events):
    assert events.types() == ["agent_start", "agent_end"]
    assert only(events.entries, "agent_end")["outcome"] == "cancelled"


def test_cancelled_error_is_not_an_error(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            raise asyncio.CancelledError()
    except asyncio.CancelledError:
        pass
    else:
        pytest.fail("CancelledError was not raised")
    _assert_cancelled_without_error(events)


def test_generator_exit_is_not_an_error(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            raise GeneratorExit()
    except GeneratorExit:
        pass
    else:
        pytest.fail("GeneratorExit was not raised")
    _assert_cancelled_without_error(events)


def test_real_task_cancellation_is_reported_as_cancelled(events):
    async def main():
        started = asyncio.Event()

        async def body():
            async with failproofai_sdk.agent("a", session_id="s"):
                started.set()
                await asyncio.sleep(60)

        task = asyncio.create_task(body())
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            cancelled_result = await task
            pytest.fail(f"cancelled task returned {cancelled_result!r}")

    asyncio.run(main())
    assert events.types() == ["agent_start", "agent_end"]
    assert only(events.entries, "agent_end")["outcome"] == "cancelled"


# ---------------------------------------------------------------------------
# tool_call()
# ---------------------------------------------------------------------------

def test_tool_call_pairs_and_carries_output(events):
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.tool_call("web_search", input={"q": "x"}) as t:
            t.output = {"hits": 3}
            call_id = t.id

    assert events.types() == ["agent_start", "tool_use", "tool_result", "agent_end"]
    use = only(events.entries, "tool_use")
    res = only(events.entries, "tool_result")
    assert use["tool_call_id"] == res["tool_call_id"] == call_id
    assert use["input"] == {"q": "x"}
    assert res["output"] == {"hits": 3}
    assert "error" not in res
    assert isinstance(res["duration_ms"], int)


def test_tool_call_id_is_read_only():
    box = failproofai_sdk._scopes.ToolCall("abc")
    assert box.id == "abc"
    with pytest.raises(AttributeError):
        box.id = "other"
    # __slots__: no stray attributes
    with pytest.raises(AttributeError):
        box.whatever = 1


def test_tool_call_accepts_an_explicit_id(events):
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.tool_call("t", tool_call_id="run-42") as t:
            assert t.id == "run-42"
    assert only(events.entries, "tool_use")["tool_call_id"] == "run-42"


def test_tool_call_failure_emits_tool_result_error_and_no_error_event(events):
    with failproofai_sdk.agent("a", session_id="s"):
        try:
            with failproofai_sdk.tool_call("t"):
                raise TypeError("bad arg")
        except TypeError as exc:
            assert str(exc) == "bad arg"
        else:
            pytest.fail("TypeError was not raised")

    # No `error` event from the tool: an exception the agent loop catches is
    # not a run-level error.
    assert events.types() == ["agent_start", "tool_use", "tool_result", "agent_end"]
    assert only(events.entries, "tool_result")["error"] == "TypeError: bad arg"
    assert only(events.entries, "agent_end")["outcome"] == "success"


def test_propagating_tool_failure_is_reported_exactly_once(events):
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            with failproofai_sdk.tool_call("t"):
                raise TypeError("bad arg")
    except TypeError as exc:
        assert str(exc) == "bad arg"
    else:
        pytest.fail("TypeError was not raised")

    assert events.types() == [
        "agent_start", "tool_use", "tool_result", "error", "agent_end",
    ]
    assert len(indexes(events.entries, "error")) == 1
    types = events.types()
    assert types.index("error") < types.index("agent_end")


def test_tool_call_uses_the_enclosing_agent_id(events):
    with failproofai_sdk.agent("outer", session_id="s"):
        with failproofai_sdk.agent("inner"):
            with failproofai_sdk.tool_call("t"):
                pass
    use = only(events.entries, "tool_use")
    res = only(events.entries, "tool_result")
    assert use["agent_id"] == res["agent_id"] == "inner"


def test_tool_call_without_a_session_raises_naming_the_fix(events):
    with pytest.raises(TypeError, match="propagate"):
        with failproofai_sdk.tool_call("t"):
            pass


def test_awkward_payload_does_not_break_the_scope(events):
    """A non-JSON-serialisable output must not stop `agent_end` landing.

    Coercion happens in the writer (`json.dumps(default=str)`), so the scope
    itself must pass the object through untouched and still close the span.
    """
    value = datetime(2026, 7, 29, 12, 0, 0, tzinfo=timezone.utc)
    with failproofai_sdk.agent("a", session_id="s"):
        with failproofai_sdk.tool_call("t") as call:
            call.output = value

    assert events.types() == ["agent_start", "tool_use", "tool_result", "agent_end"]
    assert only(events.entries, "tool_result")["output"] is value


def test_awkward_payload_survives_the_real_writer(tmp_path):
    """The end-to-end version: through the actual JSONL writer, on disk."""
    import json

    from failproofai_sdk._events import EventNamespace
    from failproofai_sdk._writer import EventWriter

    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)
    original = _runtime.event
    _runtime.event = namespace
    try:
        with failproofai_sdk.agent("a", session_id="s"):
            with failproofai_sdk.tool_call("t") as call:
                call.output = datetime(2026, 7, 29, 12, 0, 0, tzinfo=timezone.utc)
        writer.flush_now()
    finally:
        _runtime.event = original

    path = next((tmp_path / "events").glob("*.jsonl"))
    parsed = [json.loads(line) for line in path.read_text().splitlines()]
    assert [e["type"] for e in parsed] == [
        "agent_start", "tool_use", "tool_result", "agent_end",
    ]
    assert parsed[2]["output"] == "2026-07-29 12:00:00+00:00"


# ---------------------------------------------------------------------------
# `async with` parity — the same body, both syntaxes, byte-identical dicts
# ---------------------------------------------------------------------------

def _scrub(entries):
    """Drop the only fields that legitimately differ between two runs."""
    return [{k: v for k, v in e.items() if k not in ("timestamp", "duration_ms")} for e in entries]


def _sync_body():
    with failproofai_sdk.agent("planner", session_id="s-parity", goal="g", fw_node="n"):
        with failproofai_sdk.agent("worker"):
            with failproofai_sdk.tool_call("search", tool_call_id="tc-1", input={"q": "x"}) as t:
                t.output = ["a", "b"]


async def _async_body():
    async with failproofai_sdk.agent("planner", session_id="s-parity", goal="g", fw_node="n"):
        async with failproofai_sdk.agent("worker"):
            async with failproofai_sdk.tool_call("search", tool_call_id="tc-1", input={"q": "x"}) as t:
                t.output = ["a", "b"]


def _sync_failing():
    with pytest.raises(ValueError):
        with failproofai_sdk.agent("planner", session_id="s-parity"):
            with failproofai_sdk.tool_call("search", tool_call_id="tc-1"):
                raise ValueError("nope")


async def _async_failing():
    with pytest.raises(ValueError):
        async with failproofai_sdk.agent("planner", session_id="s-parity"):
            async with failproofai_sdk.tool_call("search", tool_call_id="tc-1"):
                raise ValueError("nope")


@pytest.mark.parametrize(
    "sync_body,async_body",
    [(_sync_body, _async_body), (_sync_failing, _async_failing)],
    ids=["happy", "failing"],
)
def test_async_with_is_identical_to_with(events, sync_body, async_body):
    sync_body()
    sync_entries = _scrub(events.entries)
    events.entries.clear()

    asyncio.run(async_body())
    async_entries = _scrub(events.entries)

    # `traceback` embeds the frame that raised, which differs by construction.
    for entry in sync_entries + async_entries:
        entry.pop("traceback", None)

    assert sync_entries == async_entries
    assert sync_entries  # not vacuously equal


def test_async_session_binds_and_unbinds(events):
    async def main():
        async with failproofai_sdk.session("s-async") as sid:
            assert sid == "s-async"
            assert failproofai_sdk.current().session_id == "s-async"

    asyncio.run(main())
    assert failproofai_sdk.current().session_id is None
