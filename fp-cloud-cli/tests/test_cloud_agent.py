import json
import re
from io import StringIO

import httpx
import pytest
import respx
from rich.console import Console

from fp_cli import output
from fp_cli.app import app

BASE = "http://dash.test"
RESULT = {"columns": [{"name": "total", "type": "UInt64"}], "rows": [[42]]}


def sse(events):
    return "".join("data: " + json.dumps(e) + "\n\n" for e in events)


@pytest.mark.parametrize("json_mode,approve,tty,input_text,decision", [
    (True, False, False, "", "reject"),
    (True, True, False, "", "approve"),
    (False, False, False, "", "reject"),
    (False, False, True, "y\n", "approve"),
    (False, False, True, "n\n", "reject"),
])
def test_ask_artifacts_and_approvals(logged_in, runner, monkeypatch, json_mode, approve, tty, input_text, decision):
    events = [
        {"type": "ui-action", "action": "open_artifact", "artifact": {"title": "Event total", "sql": "SELECT count()"}},
        {"type": "ask-user", "callId": "ask_1", "kind": "approval", "question": "Disable alert?", "details": "alert a1"},
        {"type": "ask-user-answered", "callId": "ask_1", "decision": decision},
        {"type": "text-delta", "text": "Here is the result."},
        {"type": "done"},
    ]
    # Patch the exact guard used by the command; CliRunner's stdin is otherwise non-TTY.
    import sys
    monkeypatch.setattr(sys.stdin, "isatty", lambda: tty)
    # Runner replaces stdin during invocation, so patch the module's sys proxy instead.
    from fp_cli.commands import agent_cmds
    class Stdin:
        def isatty(self):
            return tty
    class Sys:
        stdin = Stdin()
        stdout = sys.stdout
    monkeypatch.setattr(agent_cmds, "sys", Sys())
    with respx.mock as mock:
        stream = mock.post(f"{BASE}/api/agent/chat").respond(200, text=sse(events), headers={"content-type": "text/event-stream"})
        query = mock.post(f"{BASE}/api/queries/run").respond(200, json=RESULT)
        answer = mock.post(f"{BASE}/api/agent/answer").respond(204)
        mock.post(f"{BASE}/api/agent/conversations").respond(200, json={"id": "c1"})
        saved = mock.put(f"{BASE}/api/agent/conversations/c1/messages").respond(204)
        result = runner.invoke(app, [*(["--json"] if json_mode else []), "agent", "ask", "Count events",
                                    *(["--approve"] if approve else [])], input=input_text)
    assert result.exit_code == 0, result.output
    assert json.loads(answer.calls[0].request.content) == {"callId": "ask_1", "decision": decision}
    assert query.called
    assert json.loads(stream.calls[0].request.content)["pageActions"] == [{"action": "open_artifact"}, {"action": "home"}]
    assert json.loads(saved.calls[0].request.content)["messages"][-1]["content"]["artifacts"][0]["sql"] == "SELECT count()"
    if json_mode:
        data = json.loads(result.stdout)
        assert data["answer"] == "Here is the result."
        assert data["artifacts"][0]["result"] == RESULT
    else:
        assert "EVENT TOTAL" in result.output
        assert "42" in result.output
        assert result.stdout.index("failproof ai v") < result.stdout.index("EVENT TOTAL")
        if tty:
            assert "alert a1" in result.output
            assert "Approve this change" in result.output


def test_home_blocks(logged_in, runner):
    stream = sse([{"type": "ui-action", "action": "home", "home": {"op": "replace", "blocks": [
        {"key": "n", "kind": "stats", "title": "Count", "sql": "SELECT 42"},
        {"key": "note", "kind": "note", "title": "Summary", "text": "All good"},
    ]}}, {"type": "done"}])
    with respx.mock as mock:
        mock.post(f"{BASE}/api/agent/chat").respond(200, text=stream)
        query = mock.post(f"{BASE}/api/queries/run").respond(200, json=RESULT)
        mock.post(f"{BASE}/api/agent/conversations").respond(200, json={"id": "c1"})
        mock.put(f"{BASE}/api/agent/conversations/c1/messages").respond(204)
        result = runner.invoke(app, ["--json", "agent", "ask", "Summarize"])
    assert result.exit_code == 0, result.output
    assert query.call_count == 1
    assert len(json.loads(result.stdout)["artifacts"]) == 2


@pytest.mark.parametrize("json_mode", [False, True])
def test_brief(logged_in, runner, json_mode):
    with respx.mock as mock:
        route = mock.post(f"{BASE}/api/agent/home-brief").respond(200, json={
            "greeting": "Hello", "summary": "Healthy", "blocks": [{"title": "Events", "sql": "SELECT count()"}]})
        mock.post(f"{BASE}/api/queries/run").respond(200, json=RESULT)
        result = runner.invoke(app, [*(["--json"] if json_mode else []), "agent", "brief", "--range", "7d"])
    assert result.exit_code == 0, result.output
    assert "Healthy" in result.output
    assert json.loads(route.calls[0].request.content) == {"range": "7d"}


@pytest.mark.parametrize("argv,path,response", [
    (["policies", "author", "Prevent force push"], "/api/agent/policy-author", "stream"),
    (["policies", "backtest", "{file}"], "/api/agent/policy-backtest", {"matched": 3}),
    (["policies", "candidacy", "--issue", "i1"], "/api/agent/policy-candidacy", {"candidate": True}),
])
def test_policy_commands(logged_in, runner, tmp_path, argv, path, response):
    file = tmp_path / "policy.mjs"
    file.write_text("export default {}")
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{BASE}/api/issues/i1").respond(200, json={"id": "i1", "title": "Force pushes"})
        if response == "stream":
            route = mock.post(f"{BASE}{path}").respond(200, text=sse([{"type": "done", "result": {"source": "policy"}}]))
        else:
            route = mock.post(f"{BASE}{path}").respond(200, json=response)
        result = runner.invoke(app, ["--json", *[v.format(file=file) for v in argv]])
    assert result.exit_code == 0, result.output
    assert route.called
    json.loads(result.stdout)
    if argv[1] == "author":
        assert json.loads(route.calls[0].request.content)["issue"]["title"] == "Prevent force push"
    elif argv[1] == "backtest":
        assert json.loads(route.calls[0].request.content) == {"source": "export default {}"}


@pytest.mark.parametrize("argv", [
    ["policies", "author", "Prevent force push"], ["policies", "backtest", "p1"],
    ["policies", "candidacy", "--issue", "i1"], ["agent", "brief"],
])
def test_session_only(logged_in, runner, argv):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", "--api-key", "key", *argv])
        assert not mock.calls
    assert result.exit_code == 2
    assert "needs a signed-in session" in result.stdout


@pytest.mark.parametrize("argv", [
    ["policies", "author", "Prevent force push"], ["policies", "backtest", "p1"],
    ["policies", "candidacy", "--issue", "i1"], ["agent", "brief"], ["agent", "ask", "Hello"],
])
def test_404(logged_in, runner, argv):
    with respx.mock as mock:
        mock.route().respond(404, json={"error": "unknown route"})
        result = runner.invoke(app, ["--json", *argv])
    assert result.exit_code == 6, result.output
    assert "not available on this FailproofAI Cloud yet" in result.stdout


def test_backtest_published_policy_uses_latest_version(logged_in, runner):
    with respx.mock as mock:
        mock.get(f"{BASE}/api/enforcement/policies").respond(200, json=[
            {"id": "p1", "version": 1, "source": "old"},
            {"id": "p1", "version": 2, "source": "new"},
        ])
        route = mock.post(f"{BASE}/api/agent/policy-backtest").respond(200, json={"matched": 1})
        result = runner.invoke(app, ["--json", "policies", "backtest", "p1"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls[0].request.content) == {"source": "new"}


@pytest.mark.parametrize("json_mode", [False, True])
@pytest.mark.parametrize("failure,exit_code", [("404", 6), ("network", 3)])
def test_approval_answer_failure_is_clean(logged_in, runner, json_mode, failure, exit_code):
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{BASE}/api/agent/chat").respond(200, text=sse([
            {"type": "ask-user", "kind": "approval", "callId": "ask_1", "question": "Disable alert?"},
            {"type": "text-delta", "text": "Must not reach this answer."},
            {"type": "done"},
        ]))
        answer = mock.post(f"{BASE}/api/agent/answer")
        if failure == "404":
            answer.respond(404, json={"error": "unknown route"})
        else:
            answer.mock(side_effect=httpx.ConnectError("connection refused"))
        saved = mock.post(f"{BASE}/api/agent/conversations").respond(200, json={"id": "c1"})
        result = runner.invoke(app, [*(["--json"] if json_mode else []), "agent", "ask", "Hello", "--approve"])
    assert result.exit_code == exit_code, result.output
    assert answer.called and not saved.called
    assert "Traceback" not in result.output
    assert "Must not reach this answer" not in result.output
    if json_mode:
        data = json.loads(result.stdout)
        assert data["exit_code"] == exit_code
        message = data["error"]
    else:
        assert len(result.stderr.strip().splitlines()) == 1
        message = result.stderr
    assert "Assistant approval answer failed" in message
    assert "delivery unconfirmed" in message
    if failure == "404":
        assert "not available on this FailproofAI Cloud yet" in message


@pytest.mark.parametrize("failure,exit_code", [("404", 6), ("network", 3)])
def test_approval_failure_restores_terminal_status(logged_in, runner, monkeypatch, failure, exit_code):
    # The suite defaults to TERM=dumb, which suppresses live cursor control.
    monkeypatch.setenv("TERM", "xterm-256color")
    capture = StringIO()
    terminal = Console(file=capture, force_terminal=True, color_system="truecolor", width=200)
    original_configure = output.configure

    def configure_terminal(**kwargs):
        original_configure(**kwargs)
        monkeypatch.setattr(output, "_stderr", terminal)

    monkeypatch.setattr(output, "configure", configure_terminal)
    with respx.mock as mock:
        mock.post(f"{BASE}/api/agent/chat").respond(200, text=sse([
            {"type": "ask-user", "kind": "approval", "callId": "ask_1", "question": "Disable alert?"},
        ]))
        answer = mock.post(f"{BASE}/api/agent/answer")
        if failure == "404":
            answer.respond(404, json={"error": "unknown route"})
        else:
            answer.mock(side_effect=httpx.ConnectError("connection refused"))
        result = runner.invoke(app, ["agent", "ask", "Hello", "--approve"])
    assert result.exit_code == exit_code, result.output
    rendered = capture.getvalue()
    assert terminal._live_stack == []
    assert "\x1b[?25l" in rendered
    assert rendered.rfind("\x1b[?25h") > rendered.rfind("\x1b[?25l")
    assert rendered.index("Assistant approval answer failed") > rendered.rfind("\x1b[?25h")
    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", rendered)
    assert plain.count("Assistant approval answer failed") == 1
    assert "Traceback" not in plain


@pytest.mark.parametrize("json_mode", [False, True])
def test_ask_api_key_uses_session_only_wording(logged_in, runner, json_mode):
    with respx.mock as mock:
        result = runner.invoke(app, [
            "--api-key", "key", *(["--json"] if json_mode else []),
            "agent", "ask", "Hello",
        ])
        assert not mock.calls
    assert result.exit_code == 2, result.output
    expected = "`fp agent ask` needs a signed-in session: run `fp login`"
    if json_mode:
        assert json.loads(result.stdout)["error"] == expected
    else:
        assert expected in result.stderr
        assert len(result.stderr.strip().splitlines()) == 1


def test_artifact_header_precedes_title_once(capsys):
    from fp_cli.commands.agent_cmds import render_artifact
    output.configure(no_color=True)
    render_artifact({"title": "First artifact", "result": RESULT})
    render_artifact({"title": "Second artifact", "result": RESULT})
    rendered = capsys.readouterr().out
    assert rendered.count("failproof ai v") == 1
    assert rendered.index("failproof ai v") < rendered.index("FIRST ARTIFACT") < rendered.index("SECOND ARTIFACT")
