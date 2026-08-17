"""
Tests for the failproofai_sdk SDK.

Unit tests use EventNamespace with a mock writer (no disk I/O).
Integration tests use configure() + real tmpdir + flush_now().
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

import failproofai_sdk
from failproofai_sdk._events import EventNamespace
from failproofai_sdk._schema import (
    AgentEndEvent,
    AgentPauseEvent,
    AgentResumeEvent,
    AgentStartEvent,
    ErrorEvent,
    HookCompletedEvent,
    HookTriggeredEvent,
    HumanInputEvent,
    HumanInterruptEvent,
    HumanPauseEvent,
    HumanWaitEvent,
    ModelRequestEvent,
    ModelResponseEvent,
    ToolResultEvent,
    ToolUseEvent,
)
from failproofai_sdk._writer import EventWriter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class MockWriter:
    """Collects submitted entries without touching disk."""

    def __init__(self):
        self.entries: list[dict] = []

    def submit(self, entry: dict) -> None:
        self.entries.append(entry)

    def last(self) -> dict:
        return self.entries[-1]


@pytest.fixture()
def mock_writer():
    return MockWriter()


@pytest.fixture()
def ns(mock_writer):
    return EventNamespace(mock_writer)


# ---------------------------------------------------------------------------
# Reserved field validation
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("reserved", ["timestamp", "type"])
def test_reserved_fields_raise_via_extra(ns, reserved):
    # timestamp and type aren't in the explicit signature so they land in **fields and hit our validator
    with pytest.raises(ValueError, match="Reserved field"):
        ns.agent_start(session_id="s1", agent_id="a1", **{reserved: "bad"})


@pytest.mark.parametrize("reserved", ["session_id", "agent_id"])
def test_reserved_fields_blocked_by_signature(ns, reserved):
    # session_id and agent_id are explicit params; Python raises TypeError on duplicate keyword
    with pytest.raises(TypeError):
        ns.agent_start(session_id="s1", agent_id="a1", **{reserved: "bad"})


# ---------------------------------------------------------------------------
# duration_ms rejection on paired end events
# ---------------------------------------------------------------------------

def test_tool_result_rejects_duration_ms(ns):
    with pytest.raises(ValueError, match="duration_ms"):
        ns.tool_result(session_id="s1", agent_id="a1", tool_name="t", tool_call_id="tc1", duration_ms=99)


def test_hook_completed_rejects_duration_ms(ns):
    with pytest.raises(ValueError, match="duration_ms"):
        ns.hook_completed(session_id="s1", agent_id="a1", hook_name="h", hook_id="hid1", duration_ms=99)


# ---------------------------------------------------------------------------
# Null field omission
# ---------------------------------------------------------------------------

def test_null_fields_omitted_tool_use(ns, mock_writer):
    ns.tool_use(session_id="s1", agent_id="a1", tool_name="search", tool_call_id="tc1")
    d = mock_writer.last()
    assert "input" not in d


def test_null_fields_omitted_model_request(ns, mock_writer):
    ns.model_request(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    for f in ("model", "messages", "system", "tools"):
        assert f not in d


def test_null_fields_omitted_model_response(ns, mock_writer):
    ns.model_response(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    for f in ("model", "stop_reason", "input_tokens", "output_tokens", "content", "role"):
        assert f not in d


def test_model_request_fields_captured(ns, mock_writer):
    messages = [{"role": "user", "content": "hello"}]
    tools = [{"name": "search", "input_schema": {"type": "object"}}]
    ns.model_request(
        session_id="s1", agent_id="a1", model="claude-opus-4-6",
        messages=messages, system="You are helpful.", tools=tools,
    )
    d = mock_writer.last()
    assert d["messages"] == messages
    assert d["system"] == "You are helpful."
    assert d["tools"] == tools


def test_model_response_content_as_string(ns, mock_writer):
    ns.model_response(
        session_id="s1", agent_id="a1",
        content="plain text completion", role="assistant",
    )
    d = mock_writer.last()
    assert d["content"] == "plain text completion"
    assert d["role"] == "assistant"


def test_model_response_content_as_blocks(ns, mock_writer):
    blocks = [
        {"type": "text", "text": "I'll search..."},
        {"type": "tool_use", "id": "toolu_01", "name": "search", "input": {"q": "x"}},
    ]
    ns.model_response(session_id="s1", agent_id="a1", content=blocks, role="assistant")
    d = mock_writer.last()
    assert d["content"] == blocks
    assert d["role"] == "assistant"


def test_null_fields_omitted_agent_start(ns, mock_writer):
    ns.agent_start(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    assert "goal" not in d
    assert "parent_id" not in d


def test_null_fields_omitted_error(ns, mock_writer):
    ns.error(session_id="s1", agent_id="a1", error_type="ValueError", message="oops")
    d = mock_writer.last()
    assert "traceback" not in d


# ---------------------------------------------------------------------------
# Field ordering
# ---------------------------------------------------------------------------

def test_field_ordering(ns, mock_writer):
    ns.agent_start(session_id="s1", agent_id="a1", goal="do stuff")
    d = mock_writer.last()
    keys = list(d.keys())
    assert keys[0] == "timestamp"
    assert keys[1] == "session_id"
    assert keys[2] == "agent_id"
    assert keys[3] == "type"


def test_custom_fields_at_end(ns, mock_writer):
    ns.agent_end(session_id="s1", agent_id="a1", outcome="success", message="done", custom_key="val")
    d = mock_writer.last()
    keys = list(d.keys())
    assert keys.index("message") > keys.index("outcome")
    assert keys.index("custom_key") > keys.index("outcome")
    assert d["message"] == "done"
    assert d["custom_key"] == "val"


# ---------------------------------------------------------------------------
# Auto duration computation
# ---------------------------------------------------------------------------

def test_tool_use_result_duration(ns, mock_writer):
    ns.tool_use(session_id="s1", agent_id="a1", tool_name="search", tool_call_id="tc1")
    time.sleep(0.01)
    ns.tool_result(session_id="s1", agent_id="a1", tool_name="search", tool_call_id="tc1", output="ok")
    d = mock_writer.last()
    assert "duration_ms" in d
    assert d["duration_ms"] >= 10.0  # at least 10ms


def test_hook_triggered_completed_duration(ns, mock_writer):
    ns.hook_triggered(session_id="s1", agent_id="a1", hook_name="pre_tool_use", hook_id="hid1")
    time.sleep(0.01)
    ns.hook_completed(session_id="s1", agent_id="a1", hook_name="pre_tool_use", hook_id="hid1", outcome="success")
    d = mock_writer.last()
    assert "duration_ms" in d
    assert d["duration_ms"] >= 10.0


# ---------------------------------------------------------------------------
# Missing correlation ID → duration_ms absent
# ---------------------------------------------------------------------------

def test_tool_result_without_prior_tool_use(ns, mock_writer):
    ns.tool_result(session_id="s1", agent_id="a1", tool_name="search", tool_call_id="no-prior")
    d = mock_writer.last()
    assert "duration_ms" not in d


def test_hook_completed_without_prior_triggered(ns, mock_writer):
    ns.hook_completed(session_id="s1", agent_id="a1", hook_name="h", hook_id="no-prior", outcome="success")
    d = mock_writer.last()
    assert "duration_ms" not in d


# ---------------------------------------------------------------------------
# All 9 event types — type field smoke test
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("method,kwargs,expected_type", [
    ("tool_use",        {"tool_name": "t", "tool_call_id": "c1"},         "tool_use"),
    ("tool_result",     {"tool_name": "t", "tool_call_id": "c2"},         "tool_result"),
    ("model_request",   {},                                                "model_request"),
    ("model_response",  {},                                                "model_response"),
    ("agent_start",     {},                                                "agent_start"),
    ("agent_end",       {},                                                "agent_end"),
    ("hook_triggered",  {"hook_name": "h", "hook_id": "hid"},             "hook_triggered"),
    ("hook_completed",  {"hook_name": "h", "hook_id": "hid2"},            "hook_completed"),
    ("error",           {"error_type": "ValueError", "message": "oops"},  "error"),
    ("human_wait",      {"input_id": "inp1"},                             "human_wait"),
    ("human_input",     {"input_id": "inp2"},                             "human_input"),
    ("human_pause",     {},                                                "human_pause"),
    ("human_interrupt", {},                                                "human_interrupt"),
    ("agent_pause",     {"pause_id": "p1"},                               "agent_pause"),
    ("agent_resume",    {"pause_id": "p2"},                               "agent_resume"),
])
def test_event_types(ns, mock_writer, method, kwargs, expected_type):
    getattr(ns, method)(session_id="s1", agent_id="a1", **kwargs)
    assert mock_writer.last()["type"] == expected_type


# ---------------------------------------------------------------------------
# Schema to_dict directly — field values
# ---------------------------------------------------------------------------

def test_tool_use_schema():
    e = ToolUseEvent(
        timestamp="2026-03-31T14:22:01.123456Z",
        session_id="run-abc",
        agent_id="planner",
        tool_name="web_search",
        tool_call_id="toolu_01",
        input={"query": "test"},
    )
    d = e.to_dict()
    assert d["type"] == "tool_use"
    assert d["tool_name"] == "web_search"
    assert d["input"] == {"query": "test"}


def test_tool_result_with_duration_schema():
    e = ToolResultEvent(
        timestamp="2026-03-31T14:22:02.456789Z",
        session_id="run-abc",
        agent_id="planner",
        tool_name="web_search",
        tool_call_id="toolu_01",
        output={"results": ["x"]},
        duration_ms=1333.6,
    )
    d = e.to_dict()
    assert d["duration_ms"] == 1333.6
    assert d["output"] == {"results": ["x"]}
    assert "error" not in d


def test_error_schema():
    e = ErrorEvent(
        timestamp="2026-03-31T14:22:08.500000Z",
        session_id="run-abc",
        agent_id="planner",
        error_type="TimeoutError",
        message="timed out",
        traceback="Traceback...",
    )
    d = e.to_dict()
    assert d["error_type"] == "TimeoutError"
    assert d["traceback"] == "Traceback..."


# ---------------------------------------------------------------------------
# Human-in-the-loop event tests
# ---------------------------------------------------------------------------

def test_human_input_rejects_duration_ms(ns):
    with pytest.raises(ValueError, match="duration_ms"):
        ns.human_input(session_id="s1", agent_id="a1", input_id="inp1", duration_ms=99)


def test_human_wait_input_duration(ns, mock_writer):
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1")
    time.sleep(0.01)
    ns.human_input(session_id="s1", agent_id="a1", input_id="inp1", response="approved")
    d = mock_writer.last()
    assert "duration_ms" in d
    assert d["duration_ms"] >= 10.0
    assert d["response"] == "approved"


def test_human_input_without_prior_wait(ns, mock_writer):
    ns.human_input(session_id="s1", agent_id="a1", input_id="no-prior")
    d = mock_writer.last()
    assert "duration_ms" not in d


# ---------------------------------------------------------------------------
# Agent pause / resume event tests
# ---------------------------------------------------------------------------

def test_agent_resume_rejects_duration_ms(ns):
    with pytest.raises(ValueError, match="duration_ms"):
        ns.agent_resume(session_id="s1", agent_id="a1", pause_id="p1", duration_ms=99)


def test_agent_pause_resume_duration(ns, mock_writer):
    ns.agent_pause(session_id="s1", agent_id="a1", pause_id="p1", reason="waiting_for_user")
    time.sleep(0.01)
    ns.agent_resume(session_id="s1", agent_id="a1", pause_id="p1")
    d = mock_writer.last()
    assert d["type"] == "agent_resume"
    assert d["pause_id"] == "p1"
    assert "duration_ms" in d
    assert d["duration_ms"] >= 10.0


def test_agent_resume_without_prior_pause(ns, mock_writer):
    ns.agent_resume(session_id="s1", agent_id="a1", pause_id="no-prior")
    d = mock_writer.last()
    assert d["type"] == "agent_resume"
    assert d["pause_id"] == "no-prior"
    assert "duration_ms" not in d


def test_agent_pause_fields(ns, mock_writer):
    ns.agent_pause(session_id="s1", agent_id="a1", pause_id="p1", reason="user_requested", user_id="usr_9")
    d = mock_writer.last()
    assert d["type"] == "agent_pause"
    assert d["pause_id"] == "p1"
    assert d["reason"] == "user_requested"
    assert d["user_id"] == "usr_9"


def test_agent_pause_null_fields_omitted(ns, mock_writer):
    ns.agent_pause(session_id="s1", agent_id="a1", pause_id="p1")
    d = mock_writer.last()
    assert d["pause_id"] == "p1"
    assert "reason" not in d
    assert "user_id" not in d


def test_agent_pause_resume_cross_namespace_link():
    # Pause in one EventNamespace ("process"), resume in another: the in-memory
    # _pending map does not carry over, so duration_ms is absent — but the
    # shared pause_id still links the two events for downstream pairing.
    w1, w2 = MockWriter(), MockWriter()
    EventNamespace(w1).agent_pause(session_id="s1", agent_id="a1", pause_id="cross-1")
    EventNamespace(w2).agent_resume(session_id="s1", agent_id="a1", pause_id="cross-1")
    pause_d, resume_d = w1.last(), w2.last()
    assert pause_d["type"] == "agent_pause" and pause_d["pause_id"] == "cross-1"
    assert resume_d["type"] == "agent_resume" and resume_d["pause_id"] == "cross-1"
    assert "duration_ms" not in resume_d  # no in-process pending → no auto-duration


def test_agent_pause_id_isolated_from_tool_call_id(ns, mock_writer):
    # A pause_id equal to a tool_call_id must NOT cross-link in the shared
    # _pending map (pause keys are namespaced), else resume would steal the
    # tool's start time and emit a bogus duration.
    ns.tool_use(session_id="s1", agent_id="a1", tool_name="t", tool_call_id="x1")
    ns.agent_resume(session_id="s1", agent_id="a1", pause_id="x1")
    d = mock_writer.last()
    assert d["type"] == "agent_resume"
    assert "duration_ms" not in d


def test_agent_pause_resume_schema():
    p = AgentPauseEvent(
        timestamp="2026-07-15T10:00:00.000000Z", session_id="s", agent_id="a",
        pause_id="p1", reason="waiting_for_user",
    )
    pd = p.to_dict()
    assert pd["type"] == "agent_pause"
    assert pd["pause_id"] == "p1"
    assert pd["reason"] == "waiting_for_user"
    assert "user_id" not in pd  # None-dropped

    r = AgentResumeEvent(
        timestamp="2026-07-15T10:05:00.000000Z", session_id="s", agent_id="a",
        pause_id="p1", duration_ms=300000.0,
    )
    rd = r.to_dict()
    assert rd["type"] == "agent_resume"
    assert rd["pause_id"] == "p1"
    assert rd["duration_ms"] == 300000.0


def test_human_wait_options_in_output(ns, mock_writer):
    ns.human_wait(
        session_id="s1", agent_id="a1", input_id="inp1",
        prompt="Choose an action", options=["approve", "reject", "defer"],
    )
    d = mock_writer.last()
    assert d["options"] == ["approve", "reject", "defer"]
    assert d["prompt"] == "Choose an action"
    assert d["input_id"] == "inp1"


def test_human_wait_no_options_omitted(ns, mock_writer):
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1")
    d = mock_writer.last()
    assert "options" not in d
    assert "prompt" not in d
    assert "reason" not in d


def test_null_fields_omitted_human_pause(ns, mock_writer):
    ns.human_pause(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    assert "reason" not in d
    assert "user_id" not in d


def test_null_fields_omitted_human_interrupt(ns, mock_writer):
    ns.human_interrupt(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    assert "reason" not in d
    assert "user_id" not in d
    assert "at_step" not in d


def test_human_pause_fields(ns, mock_writer):
    ns.human_pause(session_id="s1", agent_id="a1", reason="user_requested", user_id="usr_42")
    d = mock_writer.last()
    assert d["type"] == "human_pause"
    assert d["reason"] == "user_requested"
    assert d["user_id"] == "usr_42"


def test_human_interrupt_fields(ns, mock_writer):
    ns.human_interrupt(
        session_id="s1", agent_id="a1",
        reason="output_incorrect", user_id="usr_42", at_step="tool_use:web_search",
    )
    d = mock_writer.last()
    assert d["type"] == "human_interrupt"
    assert d["reason"] == "output_incorrect"
    assert d["at_step"] == "tool_use:web_search"
    assert d["user_id"] == "usr_42"


def test_human_wait_schema():
    e = HumanWaitEvent(
        timestamp="2026-05-11T10:00:00.000000Z",
        session_id="run-abc",
        agent_id="planner",
        input_id="inp-01",
        prompt="Do you approve?",
        options=["approve", "reject"],
    )
    d = e.to_dict()
    assert d["type"] == "human_wait"
    assert d["input_id"] == "inp-01"
    assert d["prompt"] == "Do you approve?"
    assert d["options"] == ["approve", "reject"]
    assert "reason" not in d


def test_human_input_schema():
    e = HumanInputEvent(
        timestamp="2026-05-11T10:00:05.000000Z",
        session_id="run-abc",
        agent_id="planner",
        input_id="inp-01",
        response="approve",
        duration_ms=5000.0,
    )
    d = e.to_dict()
    assert d["type"] == "human_input"
    assert d["input_id"] == "inp-01"
    assert d["response"] == "approve"
    assert d["duration_ms"] == 5000.0


def test_human_wait_input_id_in_base_dict(ns, mock_writer):
    # input_id must appear before environment in field ordering
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1")
    keys = list(mock_writer.last().keys())
    assert keys.index("input_id") < keys.index("environment")


def test_human_input_input_id_in_base_dict(ns, mock_writer):
    ns.human_input(session_id="s1", agent_id="a1", input_id="inp1")
    keys = list(mock_writer.last().keys())
    assert keys.index("input_id") < keys.index("environment")


def test_human_wait_custom_fields(ns, mock_writer):
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1", tenant="acme")
    d = mock_writer.last()
    assert d["tenant"] == "acme"


def test_human_interrupt_pending_cleared_after_human_input(ns, mock_writer):
    # Emit wait then input twice with same input_id — second input should have no duration
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1")
    ns.human_input(session_id="s1", agent_id="a1", input_id="inp1")
    ns.human_input(session_id="s1", agent_id="a1", input_id="inp1")
    d = mock_writer.last()
    assert "duration_ms" not in d


def test_environment_in_human_events(ns, mock_writer):
    import failproofai_sdk._environment as env_mod
    env_mod.set_environment("production")
    ns.human_wait(session_id="s1", agent_id="a1", input_id="inp1")
    ns.human_input(session_id="s1", agent_id="a1", input_id="inp1")
    ns.human_pause(session_id="s1", agent_id="a1")
    ns.human_interrupt(session_id="s1", agent_id="a1")
    for entry in mock_writer.entries[-4:]:
        assert entry["environment"] == "production"


def test_pending_dict_is_bounded(ns):
    """Orphaned tool_use calls (no matching tool_result) must not grow
    `_pending` without bound — at the cap, the oldest entry is evicted FIFO."""
    from failproofai_sdk._events import _PENDING_CAP, _tool_key

    for i in range(_PENDING_CAP + 50):
        ns.tool_use(
            session_id="s1",
            agent_id="a1",
            tool_name="t",
            tool_call_id=f"call-{i}",
        )
    assert len(ns._pending) == _PENDING_CAP
    # Earliest IDs were evicted.
    assert _tool_key("call-0") not in ns._pending
    assert _tool_key("call-49") not in ns._pending
    # Most-recent IDs are still tracked.
    assert _tool_key(f"call-{_PENDING_CAP + 49}") in ns._pending


# ---------------------------------------------------------------------------
# EventWriter — file writing integration tests
# ---------------------------------------------------------------------------

def test_writer_creates_jsonl_file(tmp_path):
    import failproofai_sdk._resolver as resolver
    original = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        writer = EventWriter(flush_interval=60)  # won't auto-flush during test
        writer.submit({"timestamp": "t", "session_id": "s1", "agent_id": "a1", "type": "agent_start"})
        writer.flush_now()

        events_dir = tmp_path / "events"
        jsonl_files = list(events_dir.glob("*.jsonl"))
        assert len(jsonl_files) == 1

        lines = jsonl_files[0].read_text().strip().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["type"] == "agent_start"
    finally:
        resolver.set_base_dir(original)


def test_writer_no_tmp_files_after_flush(tmp_path):
    import failproofai_sdk._resolver as resolver
    original = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        writer = EventWriter(flush_interval=60)
        writer.submit({"timestamp": "t", "session_id": "s1", "agent_id": "a1", "type": "tool_use"})
        writer.flush_now()

        events_dir = tmp_path / "events"
        tmp_files = list(events_dir.glob("*.tmp"))
        assert tmp_files == []
    finally:
        resolver.set_base_dir(original)


def test_writer_multiple_events_in_one_file(tmp_path):
    import failproofai_sdk._resolver as resolver
    original = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        writer = EventWriter(flush_interval=60)
        for i in range(5):
            writer.submit({"timestamp": "t", "session_id": "s1", "agent_id": "a1", "type": "model_request", "i": i})
        writer.flush_now()

        events_dir = tmp_path / "events"
        jsonl_files = list(events_dir.glob("*.jsonl"))
        assert len(jsonl_files) == 1
        lines = jsonl_files[0].read_text().strip().splitlines()
        assert len(lines) == 5
    finally:
        resolver.set_base_dir(original)


def test_writer_coerces_unserializable_payload_values(tmp_path):
    import failproofai_sdk._resolver as resolver
    original = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        writer = EventWriter(flush_interval=60)
        value = datetime(2026, 7, 17, 12, 34, 56, tzinfo=timezone.utc)
        writer.submit({"timestamp": "t", "session_id": "s1", "agent_id": "a1", "type": "tool_result", "output": value})
        writer.flush_now()

        path = next((tmp_path / "events").glob("*.jsonl"))
        assert json.loads(path.read_text())["output"] == str(value)
        assert writer._thread.is_alive()
    finally:
        resolver.set_base_dir(original)


def test_writer_requeues_batch_after_write_failure(monkeypatch):
    writer = EventWriter(flush_interval=60)
    entries = [{"i": 1}, {"i": 2}]
    for entry in entries:
        writer.submit(entry)

    monkeypatch.setattr(writer, "_write_batch", lambda _entries: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        writer.flush_now()
    assert list(writer._queue) == entries


def test_writer_no_flush_when_empty(tmp_path):
    import failproofai_sdk._resolver as resolver
    original = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        writer = EventWriter(flush_interval=60)
        writer.flush_now()  # nothing in queue

        events_dir = tmp_path / "events"
        assert not events_dir.exists() or list(events_dir.glob("*")) == []
    finally:
        resolver.set_base_dir(original)


# ---------------------------------------------------------------------------
# configure() integration
# ---------------------------------------------------------------------------

def test_configure_custom_base_dir(tmp_path):
    failproofai_sdk.configure(base_dir=tmp_path, flush_interval=60)
    failproofai_sdk.event.agent_start(session_id="s1", agent_id="a1", goal="test configure")
    failproofai_sdk._writer.flush_now()

    events_dir = tmp_path / "events"
    jsonl_files = list(events_dir.glob("*.jsonl"))
    assert len(jsonl_files) == 1
    parsed = json.loads(jsonl_files[0].read_text().strip().splitlines()[0])
    assert parsed["goal"] == "test configure"


# ---------------------------------------------------------------------------
# atexit flush — events must survive process exit without explicit flush_now()
# ---------------------------------------------------------------------------

def test_atexit_flushes_on_process_exit(tmp_path):
    import subprocess
    import sys
    script = f"""
import failproofai_sdk
import failproofai_sdk._resolver as resolver
from pathlib import Path
resolver.set_base_dir(Path(r'{tmp_path}'))
failproofai_sdk.event.agent_start(session_id='s1', agent_id='a1')
# intentionally no flush_now() — atexit must handle it
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    events_dir = tmp_path / "events"
    jsonl_files = list(events_dir.glob("*.jsonl"))
    assert len(jsonl_files) == 1
    parsed = json.loads(jsonl_files[0].read_text().strip().splitlines()[0])
    assert parsed["type"] == "agent_start"


# ---------------------------------------------------------------------------
# Timestamp format
# ---------------------------------------------------------------------------

def test_timestamp_format(ns, mock_writer):
    ns.agent_start(session_id="s1", agent_id="a1")
    d = mock_writer.last()
    ts = d["timestamp"]
    # ISO 8601 with microsecond precision, UTC: 2026-04-01T12:34:56.789012Z
    assert ts.endswith("Z")
    assert "T" in ts
    # Must be parseable
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(ts.rstrip("Z") + "+00:00")
    assert dt.tzinfo is not None


# ---------------------------------------------------------------------------
# Base dir resolution — set_base_dir() > $AGENTEYE_HOME > ~/.agenteye
# ---------------------------------------------------------------------------

def test_base_dir_from_env_var(monkeypatch, tmp_path):
    import failproofai_sdk._resolver as resolver
    monkeypatch.setattr(resolver, "_base_dir", None)
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path))
    assert resolver.get_base_dir() == tmp_path


def test_set_base_dir_overrides_env_var(monkeypatch, tmp_path):
    import failproofai_sdk._resolver as resolver
    other = tmp_path / "explicit"
    monkeypatch.setattr(resolver, "_base_dir", None)
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "from-env"))
    resolver.set_base_dir(other)
    try:
        assert resolver.get_base_dir() == other
    finally:
        resolver.set_base_dir(None)


def test_default_when_neither_set(monkeypatch):
    import failproofai_sdk._resolver as resolver
    monkeypatch.setattr(resolver, "_base_dir", None)
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    assert resolver.get_base_dir() == Path.home() / ".agenteye"


def test_writer_uses_env_var_base_dir(monkeypatch, tmp_path):
    """End-to-end: SDK writer respects AGENTEYE_HOME for events/ path."""
    import failproofai_sdk._resolver as resolver
    monkeypatch.setattr(resolver, "_base_dir", None)
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path))
    writer = EventWriter(flush_interval=60)
    writer.submit({"timestamp": "t", "session_id": "s1", "agent_id": "a1", "type": "agent_start"})
    writer.flush_now()

    jsonl_files = list((tmp_path / "events").glob("*.jsonl"))
    assert len(jsonl_files) == 1


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_environment():
    """Reset the global environment state between every test."""
    import failproofai_sdk._environment as env_mod
    original = env_mod._environment
    yield
    env_mod._environment = original


def test_environment_defaults_to_dev(ns, mock_writer):
    import failproofai_sdk._environment as env_mod
    env_mod._environment = None
    ns.agent_start(session_id="s1", agent_id="a1")
    assert mock_writer.last()["environment"] == "dev"


def test_environment_from_configure(tmp_path, mock_writer):
    import failproofai_sdk._environment as env_mod
    env_mod.set_environment("staging")
    ns = EventNamespace(mock_writer)
    ns.agent_start(session_id="s1", agent_id="a1")
    assert mock_writer.last()["environment"] == "staging"


def test_environment_from_env_var(ns, mock_writer, monkeypatch):
    import failproofai_sdk._environment as env_mod
    env_mod._environment = None
    monkeypatch.setenv("AGENTEYE_ENVIRONMENT", "production")
    ns.agent_start(session_id="s1", agent_id="a1")
    assert mock_writer.last()["environment"] == "production"


def test_configure_overrides_env_var(ns, mock_writer, monkeypatch):
    import failproofai_sdk._environment as env_mod
    monkeypatch.setenv("AGENTEYE_ENVIRONMENT", "production")
    env_mod.set_environment("staging")
    ns.agent_start(session_id="s1", agent_id="a1")
    assert mock_writer.last()["environment"] == "staging"


def test_environment_is_reserved(ns):
    with pytest.raises(ValueError, match="Reserved field"):
        ns.agent_start(session_id="s1", agent_id="a1", environment="bad")


def test_environment_field_ordering(ns, mock_writer):
    import failproofai_sdk._environment as env_mod
    env_mod.set_environment("qa")
    ns.agent_start(session_id="s1", agent_id="a1", goal="test")
    keys = list(mock_writer.last().keys())
    assert keys.index("environment") > keys.index("type")
    assert keys.index("environment") < keys.index("goal")


def test_environment_in_all_event_types(ns, mock_writer):
    import failproofai_sdk._environment as env_mod
    env_mod.set_environment("canary")
    ns.agent_start(session_id="s1", agent_id="a1")
    ns.tool_use(session_id="s1", agent_id="a1", tool_name="t", tool_call_id="tc1")
    ns.error(session_id="s1", agent_id="a1", error_type="E", message="m")
    for entry in mock_writer.entries:
        assert entry["environment"] == "canary"


def test_environment_integration(tmp_path):
    import failproofai_sdk._resolver as resolver
    import failproofai_sdk._environment as env_mod
    original_dir = resolver._base_dir
    try:
        resolver.set_base_dir(tmp_path)
        env_mod.set_environment("integration-test")
        writer = EventWriter(flush_interval=60)
        ns = EventNamespace(writer)
        ns.agent_start(session_id="s1", agent_id="a1")
        writer.flush_now()

        events_dir = tmp_path / "events"
        jsonl_files = list(events_dir.glob("*.jsonl"))
        assert len(jsonl_files) == 1
        parsed = json.loads(jsonl_files[0].read_text().strip().splitlines()[0])
        assert parsed["environment"] == "integration-test"
    finally:
        resolver.set_base_dir(original_dir)
