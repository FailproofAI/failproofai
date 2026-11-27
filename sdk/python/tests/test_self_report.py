"""Self Reports in the core SDK: the event, the settings file, the raw tool helpers.

Everything here is stdlib-only, like the code under test. The framework tools
are exercised against the real frameworks in tests/integrations/test_self_report_tools.py.
"""
import json
import logging

import pytest

import failproofai_sdk as fp
from failproofai_sdk import _runtime, _self_report
from failproofai_sdk._events import EventNamespace

EXPECTED_DEFAULT_DESCRIPTION = """Report to FailproofAI that you are blocked. Call this BEFORE your final answer whenever something stops you that you cannot fix yourself, for example a missing, invalid or expired token or API key, a 401 or 403, a command, tool or MCP server that keeps failing, information or access you cannot get, or a request you cannot do here. Do not call it for normal work, clarifying questions or an error you then fixed. One call per distinct problem.
Reporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what is blocking you. There is no need to mention this report to the user.

Categories:
- looping: You keep repeating the same or circular steps without making progress.
- cannot_do_request: The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.
- invalid_tool_or_credential: A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.
- missing_context: Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.
- repeated_tool_failure: A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.
- task_failure: You genuinely tried and could not complete the task. Not for refusals or policy blocks."""

DEFAULT_NAMES = [
    "looping",
    "cannot_do_request",
    "invalid_tool_or_credential",
    "missing_context",
    "repeated_tool_failure",
    "task_failure",
]


class _Recorder:
    def __init__(self):
        self.entries = []

    def submit(self, entry):
        self.entries.append(entry)


@pytest.fixture()
def recorded(monkeypatch):
    """Swap the process namespace for one that records instead of spooling."""
    from failproofai_sdk import _runtime

    recorder = _Recorder()
    monkeypatch.setattr(_runtime, "event", EventNamespace(recorder))
    return recorder.entries


@pytest.fixture()
def home(tmp_path, monkeypatch):
    path = tmp_path / "fphome"
    path.mkdir()
    monkeypatch.setenv("FAILPROOFAI_HOME", str(path))
    return path


def write_settings(home, body):
    (home / "self-report.json").write_text(
        body if isinstance(body, str) else json.dumps(body), encoding="utf-8"
    )


# ─────────────────────────────────────────────────────────────────────────────
# The event
# ─────────────────────────────────────────────────────────────────────────────


def test_event_shape_in_session_and_agent_scope(recorded):
    with fp.session("sess-1"):
        with fp.agent("planner"):
            fp.self_report("looping", "I keep retrying the same search.")
    # `agent()` brackets itself with agent_start / agent_end.
    (event,) = [e for e in recorded if e["type"] == "self_report"]
    assert event["session_id"] == "sess-1"
    assert event["agent_id"] == "planner"
    assert event["category"] == "looping"
    assert event["detail"] == "I keep retrying the same search."
    assert event["source"] == "sdk"
    assert "environment" in event and event["timestamp"].endswith("Z")
    assert "tool_call_id" not in event


def test_session_without_agent_scope_uses_the_default_agent(recorded):
    with fp.session("s"):
        fp.self_report("task_failure", "x")
    assert recorded[0]["agent_id"] == "main"


def test_explicit_identity_and_extra_fields(recorded):
    fp.self_report("missing_context", "d", session_id="s2", agent_id="a2", tool_call_id="call_9", run="r1")
    event = recorded[0]
    assert (event["session_id"], event["agent_id"], event["tool_call_id"], event["run"]) == (
        "s2", "a2", "call_9", "r1",
    )


def test_nothing_bound_is_filed_as_unattributed_with_one_warning(recorded, monkeypatch, caplog):
    from failproofai_sdk import _events

    monkeypatch.setattr(_events, "_warned_unattributed", False)
    with caplog.at_level(logging.WARNING, logger="failproofai_sdk"):
        fp.self_report("looping", "x")
        fp.self_report("looping", "y")
    assert [(e["session_id"], e["agent_id"]) for e in recorded] == [
        ("unattributed", "main"), ("unattributed", "main"),
    ]
    assert len([r for r in caplog.records if "unattributed" in r.getMessage()]) == 1


def test_the_open_tool_use_for_this_call_wins_over_the_ambient_agent(recorded):
    with fp.session("s-tools"):
        with fp.agent("worker"):
            _runtime.event.tool_use(tool_name="failproofai_report", tool_call_id="call_7")
        # reported from a different agent scope, same session: the tool's agent wins
        fp.self_report("looping", "d", tool_call_id="call_7")
    (report,) = [e for e in recorded if e["type"] == "self_report"]
    assert (report["session_id"], report["agent_id"]) == ("s-tools", "worker")


def test_the_open_tool_use_resolves_a_report_with_nothing_bound(recorded):
    _runtime.event.tool_use(session_id="s-open", agent_id="a-open",
                      tool_name="failproofai_report", tool_call_id="call_8")
    fp.self_report("looping", "by id", tool_call_id="call_8")
    fp.self_report("looping", "by tool name")  # no id: newest open report-tool call
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [(r["session_id"], r["agent_id"]) for r in reports] == [("s-open", "a-open")] * 2
    # A report with no id takes the matched call's id.
    assert [r["tool_call_id"] for r in reports] == ["call_8", "call_8"]


def test_the_callers_tool_call_id_beats_the_matched_calls(recorded):
    _runtime.event.tool_use(session_id="s-own", agent_id="a", tool_name="failproofai_report", tool_call_id="adapter-id")
    fp.self_report("looping", "d", tool_call_id="model-id")
    with fp.session("s-none"):
        fp.self_report("looping", "no open call")
    first, second = [e for e in recorded if e["type"] == "self_report"]
    assert (first["session_id"], first["tool_call_id"]) == ("s-own", "model-id")
    assert second["session_id"] == "s-none" and "tool_call_id" not in second


def test_a_closed_or_foreign_session_tool_use_is_not_used(recorded):
    _runtime.event.tool_use(session_id="s-a", agent_id="a", tool_name="failproofai_report", tool_call_id="c1")
    _runtime.event.tool_result(session_id="s-a", agent_id="a", tool_name="failproofai_report", tool_call_id="c1")
    _runtime.event.tool_use(session_id="s-other", agent_id="b", tool_name="failproofai_report", tool_call_id="c2")
    with fp.session("s-mine"):
        fp.self_report("looping", "d", tool_call_id="c1")
        fp.self_report("looping", "d", tool_call_id="c2")
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [r["session_id"] for r in reports] == ["s-mine", "s-mine"]


def test_two_sessions_reusing_one_call_id_keep_their_own_open_calls(recorded):
    ev = _runtime.event
    ev.tool_use(session_id="s-1", agent_id="a-1", tool_name="failproofai_report", tool_call_id="call_0")
    ev.tool_use(session_id="s-2", agent_id="a-2", tool_name="failproofai_report", tool_call_id="call_0")
    # Each session's report finds its own call, not the other's.
    with fp.session("s-1"):
        fp.self_report("looping", "one", tool_call_id="call_0")
    with fp.session("s-2"):
        fp.self_report("looping", "two", tool_call_id="call_0")
    # Closing s-1's call leaves s-2's open.
    ev.tool_result(session_id="s-1", agent_id="a-1", tool_name="failproofai_report", tool_call_id="call_0")
    with fp.session("s-2"):
        fp.self_report("looping", "after", tool_call_id="call_0")
    with fp.session("s-1"):
        fp.self_report("looping", "closed", tool_call_id="call_0")
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [(r["detail"], r["session_id"], r["agent_id"]) for r in reports] == [
        ("one", "s-1", "a-1"), ("two", "s-2", "a-2"), ("after", "s-2", "a-2"), ("closed", "s-1", "main"),
    ]


def test_with_nothing_bound_open_calls_in_two_sessions_are_not_guessed(recorded):
    ev = _runtime.event
    ev.tool_use(session_id="s-x", agent_id="a-x", tool_name="failproofai_report", tool_call_id="cx")
    ev.tool_use(session_id="s-y", agent_id="a-y", tool_name="failproofai_report", tool_call_id="cy")
    ev.tool_use(session_id="s-y", agent_id="a-y", tool_name="failproofai_report", tool_call_id="shared")
    ev.tool_use(session_id="s-x", agent_id="a-x", tool_name="failproofai_report", tool_call_id="shared")
    fp.self_report("looping", "no id")             # newest of two sessions: no guess
    fp.self_report("looping", "shared id", tool_call_id="shared")  # id open in two sessions
    fp.self_report("looping", "unique id", tool_call_id="cy")      # one candidate: used
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [(r["detail"], r["session_id"]) for r in reports] == [
        ("no id", "unattributed"), ("shared id", "unattributed"), ("unique id", "s-y"),
    ]


def test_an_id_open_in_two_sessions_never_falls_back_to_the_tool_name(recorded):
    ev = _runtime.event
    # The id is open in two sessions (on another tool); a report call is open in a third.
    ev.tool_use(session_id="s-1", agent_id="a-1", tool_name="search", tool_call_id="dup")
    ev.tool_use(session_id="s-2", agent_id="a-2", tool_name="search", tool_call_id="dup")
    ev.tool_use(session_id="s-3", agent_id="a-3", tool_name="failproofai_report", tool_call_id="r3")
    fp.self_report("looping", "ambiguous id", tool_call_id="dup")
    fp.self_report("looping", "unknown id", tool_call_id="model-id")  # no call has it: name fallback
    fp.self_report("looping", "no id")
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [(r["detail"], r["session_id"], r.get("tool_call_id")) for r in reports] == [
        ("ambiguous id", "unattributed", "dup"),
        ("unknown id", "s-3", "model-id"),
        ("no id", "s-3", "r3"),
    ]


def test_an_explicit_session_infers_the_call_id_only_from_one_call_of_its_agent(recorded):
    ev = _runtime.event
    ev.tool_use(session_id="s", agent_id="planner", tool_name="failproofai_report", tool_call_id="p-1")
    ev.tool_use(session_id="s", agent_id="worker", tool_name="failproofai_report", tool_call_id="w-1")
    fp.self_report("looping", "planner", session_id="s", agent_id="planner")
    fp.self_report("looping", "worker", session_id="s", agent_id="worker")
    fp.self_report("looping", "nobody", session_id="s", agent_id="other")
    # A second open report call for the worker: two candidates, no guess.
    ev.tool_use(session_id="s", agent_id="worker", tool_name="failproofai_report", tool_call_id="w-2")
    fp.self_report("looping", "worker twice", session_id="s", agent_id="worker")
    with fp.agent("planner"):
        fp.self_report("looping", "ambient agent", session_id="s")
    reports = [e for e in recorded if e["type"] == "self_report"]
    assert [(r["detail"], r["agent_id"], r.get("tool_call_id")) for r in reports] == [
        ("planner", "planner", "p-1"),
        ("worker", "worker", "w-1"),
        ("nobody", "other", None),
        ("worker twice", "worker", None),
        ("ambient agent", "planner", "p-1"),
    ]


def test_detail_cut_at_a_surrogate_boundary_has_no_lone_surrogate(recorded):
    fp.self_report("looping", "a" * 1999 + "\U0001F600 and more", session_id="s")
    fp.self_report("lo\ud83dping", "x\ud83d", session_id="s")
    first, second = recorded
    assert first["detail"] == "a" * 1999 + "\U0001F600"
    assert (second["category"], second["detail"]) == ("lo\ufffdping", "x\ufffd")
    # Encodable as strict UTF-8, which is what the collector reads.
    json.dumps(second, ensure_ascii=False).encode("utf-8")


def test_written_to_the_spool_by_the_real_writer(tmp_path):
    with fp.session("disk"):
        fp.self_report("looping", "on disk")
    fp._writer.flush_now()
    rows = [
        json.loads(line)
        for p in sorted((tmp_path / "events").glob("*.jsonl"))
        for line in p.read_text().splitlines()
        if line.strip()
    ]
    reports = [r for r in rows if r["type"] == "self_report"]
    assert reports and reports[-1]["detail"] == "on disk" and reports[-1]["source"] == "sdk"


def test_detail_is_truncated_and_none_becomes_empty(recorded):
    fp.self_report("looping", "x" * 5000, session_id="s")
    fp.self_report("looping", None, session_id="s")
    assert len(recorded[0]["detail"]) == 2000
    assert recorded[1]["detail"] == ""


def test_unknown_category_is_recorded_as_is(recorded):
    fp.self_report("not_a_configured_one", "d", session_id="s")
    assert recorded[0]["category"] == "not_a_configured_one"


@pytest.mark.parametrize("name", ["timestamp", "type", "environment", "source"])
def test_reserved_and_sdk_owned_fields_are_rejected(recorded, name):
    with pytest.raises(ValueError):
        fp.self_report("looping", "d", session_id="s", **{name: "x"})


def test_wrong_types_are_rejected(recorded):
    with pytest.raises(TypeError):
        fp.self_report(None, "d", session_id="s")
    with pytest.raises(TypeError):
        fp.self_report("looping", 5, session_id="s")
    with pytest.raises(TypeError):
        fp.self_report("looping", "d", session_id="s", tool_call_id=7)


def test_event_namespace_method_is_the_same_event():
    recorder = _Recorder()
    EventNamespace(recorder).self_report("looping", "d", session_id="s", agent_id="a")
    assert recorder.entries[0]["type"] == "self_report"


# ─────────────────────────────────────────────────────────────────────────────
# Settings and the spec
# ─────────────────────────────────────────────────────────────────────────────


def test_missing_file_gives_the_defaults(home):
    spec = fp.self_report_spec()
    assert spec["name"] == "failproofai_report"
    assert spec["description"] == EXPECTED_DEFAULT_DESCRIPTION
    assert spec["input_schema"] == {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": DEFAULT_NAMES},
            "detail": {"type": "string", "description": "One factual sentence: what is blocking you."},
        },
        "required": ["category", "detail"],
        "additionalProperties": False,
    }
    assert _self_report.load_settings()["enabled"] is False


def test_settings_path_follows_failproofai_home(home):
    assert _self_report.settings_path() == home / "self-report.json"


ORG = {
    "version": 1,
    "enabled": True,
    "source": "cloud",
    "categories": [
        {"name": "billing_blocked", "description": "A payment step is refused."},
        {"name": "looping", "description": "Going in circles."},
    ],
    "guidance": "Report billing problems at once.",
    "mcp": {"port": 4319, "url": "http://127.0.0.1:4319/mcp"},
    "updatedAt": "2026-11-25T10:00:00Z",
}


def test_enabled_file_replaces_categories_and_appends_guidance(home):
    write_settings(home, ORG)
    spec = fp.self_report_spec()
    assert spec["input_schema"]["properties"]["category"]["enum"] == ["billing_blocked", "looping"]
    assert spec["description"].endswith(
        "Categories:\n- billing_blocked: A payment step is refused.\n- looping: Going in circles."
        "\n\nReport billing problems at once."
    )


def test_settings_are_reread_on_every_call(home):
    assert "billing_blocked" not in fp.self_report_spec()["description"]
    write_settings(home, ORG)
    assert "billing_blocked" in fp.self_report_spec()["description"]


def test_disabled_file_still_builds_the_default_spec(home):
    write_settings(home, {**ORG, "enabled": False})
    spec = fp.self_report_spec()
    assert spec["description"] == EXPECTED_DEFAULT_DESCRIPTION


@pytest.mark.parametrize("body", ["{not json", "[]", '"x"', ""])
def test_unparsable_file_gives_the_defaults(home, body):
    write_settings(home, body)
    assert fp.self_report_spec()["description"] == EXPECTED_DEFAULT_DESCRIPTION


@pytest.mark.parametrize(
    "categories",
    [
        [],
        None,
        "looping",
        [{"name": "Bad Name", "description": "x"}, {"name": "ok_one", "description": "fine"}],
        [{"name": "ok_one", "description": "fine"}, {"name": "ok_one", "description": "dupe"}],
        [{"name": "ok_one", "description": ""}],
        [{"name": "ok_one", "description": "x" * 501}],
        [{"name": f"c{i}", "description": "d"} for i in range(33)],
    ],
    ids=["empty", "null", "string", "bad-name", "duplicate", "empty-desc", "long-desc", "33"],
)
def test_an_invalid_category_list_means_all_six_defaults(home, categories):
    write_settings(home, {**ORG, "categories": categories})
    assert fp.self_report_spec()["input_schema"]["properties"]["category"]["enum"] == DEFAULT_NAMES


def test_guidance_over_2000_chars_is_dropped_not_cut(home):
    write_settings(home, {**ORG, "guidance": "g" * 2001})
    assert fp.self_report_spec()["description"].endswith("- looping: Going in circles.")
    write_settings(home, {**ORG, "guidance": "g" * 2000})
    assert fp.self_report_spec()["description"].endswith("\n\n" + "g" * 2000)


def test_explicit_categories_override_the_file(home):
    write_settings(home, ORG)
    spec = fp.self_report_spec(categories=[{"name": "mine", "description": "Mine."}])
    assert spec["input_schema"]["properties"]["category"]["enum"] == ["mine"]
    assert "Report billing problems" not in spec["description"]
    with pytest.raises(ValueError):
        fp.self_report_spec(categories=[{"name": "BAD", "description": "x"}])
    with pytest.raises(ValueError):
        fp.self_report_spec(categories=[])


def test_describe_matches_the_contract_layout():
    text = _self_report.describe([{"name": "a", "description": "A."}], "Extra.")
    assert text.endswith("\n\nCategories:\n- a: A.\n\nExtra.")
    assert _self_report.describe([{"name": "a", "description": "A."}], None).endswith("- a: A.")


# ─────────────────────────────────────────────────────────────────────────────
# Raw helpers
# ─────────────────────────────────────────────────────────────────────────────


def test_openai_chat_tool_shape(home):
    tool = fp.openai_tool()
    spec = fp.self_report_spec()
    assert tool == {
        "type": "function",
        "function": {"name": spec["name"], "description": spec["description"], "parameters": spec["input_schema"]},
    }


def test_openai_responses_tool_shape(home):
    tool = fp.openai_responses_tool()
    spec = fp.self_report_spec()
    assert tool == {
        "type": "function",
        "name": spec["name"],
        "description": spec["description"],
        "parameters": spec["input_schema"],
        "strict": True,
    }
    # Strict mode holds: every property required, nothing else allowed.
    params = tool["parameters"]
    assert set(params["required"]) == set(params["properties"])
    assert params["additionalProperties"] is False


def test_anthropic_tool_shape(home):
    assert fp.anthropic_tool() == fp.self_report_spec()
    assert set(fp.anthropic_tool()) == {"name", "description", "input_schema"}


@pytest.mark.parametrize(
    "name",
    [
        "failproofai_report",
        "mcp__failproofai_local__report",
        "failproofai_local__report",
        "failproofai_local.report",
        "failproofai_local/report",
        "failproofai_local-report",
    ],
)
def test_is_self_report_tool_accepts_every_spelling(name):
    assert fp.is_self_report_tool(name)


@pytest.mark.parametrize(
    "name", ["report", "MCP:report", "bash", "mcp__other__report", "failproofai_report_x", "other-report", "failproofai-reports", "", None, 3]
)
def test_is_self_report_tool_rejects_others(name):
    assert not fp.is_self_report_tool(name)


def test_handle_tool_call_with_a_json_string(recorded):
    with fp.session("s"):
        out = fp.handle_tool_call(
            "failproofai_report", '{"category": "looping", "detail": "stuck"}', tool_call_id="call_1"
        )
    assert out == "Recorded."
    assert recorded[0]["category"] == "looping"
    assert recorded[0]["detail"] == "stuck"
    assert recorded[0]["tool_call_id"] == "call_1"


def test_handle_tool_call_with_a_dict_and_explicit_identity(recorded):
    out = fp.handle_tool_call(
        "mcp__failproofai_local__report", {"category": "x", "detail": "y"}, session_id="s", agent_id="a"
    )
    assert out == "Recorded."
    assert (recorded[0]["session_id"], recorded[0]["agent_id"]) == ("s", "a")


@pytest.mark.parametrize(
    "arguments,expected",
    [
        (None, ("", "")),
        ("", ("", "")),
        ({}, ("", "")),
        ('{"category": "looping"}', ("looping", "")),
        ("not json at all", ("", "not json at all")),
        ('["a"]', ("", "['a']")),
        ({"category": 5, "detail": None}, ("5", "")),
    ],
)
def test_handle_tool_call_tolerates_bad_arguments(recorded, arguments, expected):
    assert fp.handle_tool_call("failproofai_report", arguments, session_id="s") == "Recorded."
    assert (recorded[0]["category"], recorded[0]["detail"]) == expected


def test_handle_tool_call_keeps_an_aliased_detail(recorded):
    out = fp.handle_tool_call(
        "failproofai_report", '{"kind": "looping", "sentence": "same fix again", "extra": 1}', session_id="s"
    )
    assert out == "Recorded."
    assert (recorded[0]["category"], recorded[0]["detail"]) == ("looping", "same fix again")


def test_framework_calls_keep_a_detail_passed_through_raw(recorded):
    out = _self_report.record_framework_call(
        "looping", "", session_id="s", extra_args={"summary": "retrying the same edit", "other": 1}
    )
    assert out == "Recorded."
    assert (recorded[0]["category"], recorded[0]["detail"]) == ("looping", "retrying the same edit")


def test_handle_tool_call_with_nothing_bound_records_unattributed(recorded):
    assert fp.handle_tool_call("failproofai_report", {"category": "looping", "detail": "x"}) == "Recorded."
    assert recorded[0]["session_id"] == "unattributed"


def test_handle_tool_call_never_raises_into_the_agent(recorded, caplog):
    with caplog.at_level(logging.WARNING, logger="failproofai_sdk"):
        # an invalid explicit id is refused by the event method; the helper swallows it
        assert fp.handle_tool_call("failproofai_report", {"category": "looping"}, session_id="  ") == "Recorded."
    assert recorded == []
    assert any("not recorded" in r.getMessage() for r in caplog.records)


def test_handle_tool_call_refuses_another_tool():
    with pytest.raises(ValueError, match="not the FailproofAI report tool"):
        fp.handle_tool_call("bash", {})


def test_importing_the_package_reads_no_settings(monkeypatch):
    """The settings file is read when a spec is built, never at import."""
    import subprocess
    import sys

    code = (
        "import builtins, pathlib\n"
        "orig = pathlib.Path.read_text\n"
        "def guard(self, *a, **k):\n"
        "    assert self.name != 'self-report.json', 'read at import'\n"
        "    return orig(self, *a, **k)\n"
        "pathlib.Path.read_text = guard\n"
        "import failproofai_sdk\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
