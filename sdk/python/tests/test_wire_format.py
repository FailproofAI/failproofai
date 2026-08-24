"""The bytes on disk are the product. This file freezes them.

Everything downstream — the daemon that uploads the batch, the ingest handler
that promotes fields into indexed columns, the dedup key computed over the
whole payload — consumes exactly the JSON this module produces, and none of it
is generated from a shared schema. There is no build step that would notice a
renamed key, no type that spans the boundary, and no non-2xx response when a
field goes missing: ingest returns 200 and the column is simply NULL.

So the assertions here are deliberately literal. A golden line per event type,
compared byte for byte, including key ORDER — because `dedup.rs` hashes the
canonical form of the payload, and a reordering that looks cosmetic here stops
retried batches collapsing against rows already stored, which shows up as
silent duplicate events rather than an error.

If one of these fails, the question is never "how do I update the golden". It
is "what did I just change about the wire format, and who else has to change
with me".
"""
import json
from dataclasses import dataclass, fields as dataclass_fields
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from pathlib import Path
from uuid import UUID

import pytest

from failproofai_sdk import _schema

TS = "2026-01-02T03:04:05.678901Z"
BASE = dict(timestamp=TS, session_id="sess-1", agent_id="agent-1")

# Every event type, fully populated, serialized exactly as `_writer` serializes it.
GOLDEN = {
    "tool_use": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "tool_use", "tool_name": "bash", "tool_call_id": "tc-1", "environment": "prod", "input": {"cmd": "ls"}}',
    "tool_result": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "tool_result", "tool_name": "bash", "tool_call_id": "tc-1", "environment": "prod", "output": "ok", "duration_ms": 12}',
    "model_request": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "model_request", "environment": "prod", "model": "claude-opus-5", "messages": [{"role": "user"}], "system": "sys", "tools": [{"name": "t"}], "request_id": "req-1"}',
    "model_response": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "model_response", "environment": "prod", "model": "claude-opus-5", "stop_reason": "end_turn", "input_tokens": 10, "output_tokens": 20, "content": "hi", "role": "assistant", "request_id": "req-1"}',
    "agent_start": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "agent_start", "environment": "prod", "goal": "do it", "parent_id": "p-1"}',
    "agent_end": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "agent_end", "environment": "prod", "outcome": "success", "summary": "done"}',
    "agent_pause": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "agent_pause", "pause_id": "p-1", "environment": "prod", "reason": "quota", "user_id": "u-1"}',
    "agent_resume": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "agent_resume", "pause_id": "p-1", "environment": "prod", "duration_ms": 34, "reason": "ok", "user_id": "u-1"}',
    "hook_triggered": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "hook_triggered", "hook_name": "pre", "hook_id": "h-1", "environment": "prod", "trigger_event": "PreToolUse", "input": {"a": 1}}',
    "hook_completed": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "hook_completed", "hook_name": "pre", "hook_id": "h-1", "environment": "prod", "outcome": "allow", "output": "o", "duration_ms": 56}',
    "error": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "error", "error_type": "ValueError", "message": "boom", "environment": "prod", "traceback": "tb"}',
    "human_wait": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "human_wait", "input_id": "i-1", "environment": "prod", "prompt": "ok?", "options": ["y", "n"], "reason": "approval"}',
    "human_input": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "human_input", "input_id": "i-1", "environment": "prod", "response": "y", "duration_ms": 78}',
    "human_pause": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "human_pause", "environment": "prod", "reason": "lunch", "user_id": "u-1"}',
    "human_interrupt": '{"timestamp": "2026-01-02T03:04:05.678901Z", "session_id": "sess-1", "agent_id": "agent-1", "type": "human_interrupt", "environment": "prod", "reason": "stop", "user_id": "u-1", "at_step": "3"}',
}


def _events():
    """One fully-populated instance of every event dataclass."""
    s = _schema
    return {
        "tool_use": s.ToolUseEvent(**BASE, tool_name="bash", tool_call_id="tc-1", input={"cmd": "ls"}),
        "tool_result": s.ToolResultEvent(**BASE, tool_name="bash", tool_call_id="tc-1", output="ok", error=None, duration_ms=12),
        "model_request": s.ModelRequestEvent(**BASE, model="claude-opus-5", messages=[{"role": "user"}], system="sys", tools=[{"name": "t"}], request_id="req-1"),
        "model_response": s.ModelResponseEvent(**BASE, model="claude-opus-5", stop_reason="end_turn", input_tokens=10, output_tokens=20, content="hi", role="assistant", request_id="req-1"),
        "agent_start": s.AgentStartEvent(**BASE, goal="do it", parent_id="p-1"),
        "agent_end": s.AgentEndEvent(**BASE, outcome="success", summary="done"),
        "agent_pause": s.AgentPauseEvent(**BASE, pause_id="p-1", reason="quota", user_id="u-1"),
        "agent_resume": s.AgentResumeEvent(**BASE, pause_id="p-1", duration_ms=34, reason="ok", user_id="u-1"),
        "hook_triggered": s.HookTriggeredEvent(**BASE, hook_name="pre", hook_id="h-1", trigger_event="PreToolUse", input={"a": 1}),
        "hook_completed": s.HookCompletedEvent(**BASE, hook_name="pre", hook_id="h-1", outcome="allow", output="o", error=None, duration_ms=56),
        "error": s.ErrorEvent(**BASE, error_type="ValueError", message="boom", traceback="tb"),
        "human_wait": s.HumanWaitEvent(**BASE, input_id="i-1", prompt="ok?", options=["y", "n"], reason="approval"),
        "human_input": s.HumanInputEvent(**BASE, input_id="i-1", response="y", duration_ms=78),
        "human_pause": s.HumanPauseEvent(**BASE, reason="lunch", user_id="u-1"),
        "human_interrupt": s.HumanInterruptEvent(**BASE, reason="stop", user_id="u-1", at_step="3"),
    }


@pytest.fixture(autouse=True)
def _fixed_environment(monkeypatch):
    """Pin `environment`, which every event stamps from module state."""
    monkeypatch.setenv("AGENTEYE_ENVIRONMENT", "prod")
    from failproofai_sdk import _environment

    monkeypatch.setattr(_environment, "_environment", None)


@pytest.mark.parametrize("event_type", sorted(GOLDEN))
def test_serialized_line_is_byte_for_byte_frozen(event_type):
    """Key names, key ORDER, and value encoding — all of it is the contract."""
    event = _events()[event_type]
    # Exactly how `_writer._write_batch` serializes: default=str, no sort_keys.
    line = json.dumps(event.to_dict(), default=str)
    assert line == GOLDEN[event_type]


def test_every_schema_dataclass_has_a_golden():
    """A new event type must arrive with its wire format frozen, not after.

    Without this, adding a dataclass and forgetting the golden leaves the new
    type's bytes unpinned — and the parametrized test above passes, because it
    iterates the goldens rather than the schema.
    """
    import dataclasses
    import inspect

    declared = {
        name
        for name, obj in inspect.getmembers(_schema, inspect.isclass)
        if dataclasses.is_dataclass(obj) and name.endswith("Event")
    }
    covered = {type(e).__name__ for e in _events().values()}
    assert declared == covered, (
        f"schema dataclasses without a golden line: {sorted(declared - covered)}. "
        "Add the event to _events() and GOLDEN before shipping it — the wire "
        "format is the one thing nothing downstream will tell you about."
    )
    assert len(GOLDEN) == len(declared)


def test_type_string_matches_the_key_it_is_registered_under():
    """`type` is a free string at ingest — no enum, no allowlist, anywhere.

    A typo ingests with HTTP 200 and `accepted: 1`, then never matches a filter.
    This is the only place that spelling is checked.
    """
    for event_type, event in _events().items():
        assert event.to_dict()["type"] == event_type


def test_none_valued_fields_are_omitted_not_serialized_as_null():
    """Absent means absent. `null` would overwrite a promoted column with NULL."""
    event = _schema.ToolResultEvent(
        **BASE, tool_name="bash", tool_call_id="tc-1", output=None, error=None, duration_ms=None
    )
    payload = event.to_dict()
    for absent in ("output", "error", "duration_ms"):
        assert absent not in payload
    assert "null" not in json.dumps(payload)


def test_the_five_always_present_keys_are_always_present():
    """ingest.rs rejects a line missing any of the first four; the fifth is filtered on."""
    for event in _events().values():
        payload = event.to_dict()
        for required in ("timestamp", "session_id", "agent_id", "type", "environment"):
            assert required in payload, f"{type(event).__name__} is missing {required}"


def test_every_declared_field_appears_in_its_golden():
    """A golden that omits a field does not freeze that field.

    `_events()` claims "one fully-populated instance of every event dataclass"
    and left `request_id` unset on both model events — a real field, emitted by
    all four framework adapters, and the one `_schema.py` singles out as
    "appended LAST in `_build`'s ordered list … `test_wire_format.py` freezes
    those bytes, and the dedup key hashes them". Its key name and its POSITION
    were unpinned, so reordering it would have changed the content hash of every
    `model_request` carrying one — retried batches stop collapsing against rows
    already stored, and duplicates appear — with this whole file green.

    `test_every_schema_dataclass_has_a_golden` compares dataclass NAMES only, so
    it cannot see this.
    """
    missing = []
    for name, event in _events().items():
        payload = json.loads(GOLDEN[name])
        for f in dataclass_fields(event):
            if f.name in {"extra_fields", "timestamp", "session_id", "agent_id"}:
                continue
            if getattr(event, f.name) is None:
                continue
            if f.name not in payload:
                missing.append(f"{name}.{f.name}")
    assert not missing, (
        "these fields are set on the fixture but absent from the frozen golden, "
        f"so their name and position on the wire are unpinned: {sorted(missing)}"
    )


def test_custom_fields_are_merged_last_and_overwrite_a_schema_key_in_place():
    """Extras land last — and an extra that COLLIDES overwrites the declared value.

    Named for what `_build` actually does. It used to be called
    `..._cannot_shadow_a_schema_key` and only ever passed two novel names, so the
    invariant its name promised was never exercised and is false: `_build` ends
    with `result.update(extra)`, so an extra wins its slot outright.

    `integrations/_core.guard_extras` (via `FORBIDDEN_EXTRAS`) is the sole
    mitigation and covers only the ADAPTER path; a direct `event.*` call with a
    colliding custom field reaches this. Frozen here so the behaviour is at least
    known, and so tightening it later is a deliberate change with a test to
    update rather than a surprise.
    """
    event = _schema.AgentStartEvent(**BASE, goal="g", extra_fields={"trace_id": "abc", "cost": 0.5})
    payload = event.to_dict()
    assert payload["trace_id"] == "abc"
    assert payload["cost"] == 0.5
    # Insertion order: schema keys first, extras appended.
    assert list(payload)[-2:] == ["trace_id", "cost"]

    # The collision case, which the old name denied could happen.
    shadowed = _schema.ToolUseEvent(
        **BASE, tool_name="bash", tool_call_id="tc-1", extra_fields={"tool_name": 12345}
    ).to_dict()
    assert shadowed["tool_name"] == 12345, (
        "if this now keeps the declared value, `_build` was tightened — update "
        "this test and say so; the change is a good one"
    )


class _Colour(Enum):
    RED = "red"


@dataclass
class _Unserializable:
    x: int


@pytest.mark.parametrize(
    "value",
    [
        datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        date(2026, 1, 2),
        UUID("12345678-1234-5678-1234-567812345678"),
        Decimal("1.25"),
        Path("/tmp/x"),
        _Colour.RED,
        _Unserializable(x=1),
        {1, 2, 3},
        b"bytes",
    ],
)
def test_unserializable_payload_values_are_coerced_never_dropped(value):
    """`default=str` exists so one exotic value cannot kill the whole batch.

    The writer serializes a batch as a single string. Without the coercion, one
    `Decimal` in one event raises inside `_write_batch`, the batch is requeued,
    and the next flush raises on the same value — the queue never drains again
    and every subsequent event in the process is lost too.
    """
    event = _schema.AgentStartEvent(**BASE, extra_fields={"v": value})
    line = json.dumps(event.to_dict(), default=str)
    assert json.loads(line)["v"] == str(value)


def test_duration_ms_is_serialized_as_an_integer():
    """A float here silently NULLs the column: the server's `as_u64()` drops it."""
    for name in ("tool_result", "agent_resume", "hook_completed", "human_input"):
        payload = _events()[name].to_dict()
        assert isinstance(payload["duration_ms"], int)
        assert not isinstance(payload["duration_ms"], bool)
        assert "." not in json.dumps(payload["duration_ms"])


def test_a_batch_is_newline_delimited_with_a_trailing_newline():
    """The daemon splits on newlines and POSTs the bytes verbatim as x-ndjson."""
    events = [e.to_dict() for e in list(_events().values())[:3]]
    content = "\n".join(json.dumps(e, default=str) for e in events) + "\n"

    assert content.endswith("\n")
    lines = content.split("\n")[:-1]
    assert len(lines) == 3
    for line in lines:
        assert "\n" not in line
        json.loads(line)


def test_no_payload_value_can_smuggle_a_newline_into_the_batch():
    """One raw newline in a value would split one event into two malformed lines.

    `json.dumps` escapes it, and ingest counts unparseable lines as `skipped`
    while still returning 200 — so a regression here is silent partial loss.
    """
    event = _schema.ErrorEvent(
        **BASE, error_type="E", message="line one\nline two\r\nline three", traceback=None
    )
    line = json.dumps(event.to_dict(), default=str)
    assert "\n" not in line
    assert json.loads(line)["message"] == "line one\nline two\r\nline three"
