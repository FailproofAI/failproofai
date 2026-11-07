"""The agent assistant (SSE)."""

from __future__ import annotations

import json

import httpx
import respx

from fp_cli.app import app

BASE = "http://dash.test"


def _sse(events) -> httpx.Response:
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in events)
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


# --- agent ------------------------------------------------------------------


@respx.mock
def test_agent_health(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "llm_configured": True, "default_model": "claude-x"})
    )
    result = runner.invoke(app, ["--json", "agent", "health"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["enabled"] is True


@respx.mock
def test_agent_models_lists_allowlist(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "models": ["m-default", "m-fast"], "defaultModel": "m-default"})
    )
    result = runner.invoke(app, ["--json", "agent", "models"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["models"] == ["m-default", "m-fast"]
    assert data["default_model"] == "m-default"


@respx.mock
def test_agent_chats_list(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [{"id": "c1", "title": "hi", "message_count": 2, "updated_at": "t"}]})
    )
    result = runner.invoke(app, ["--json", "agent", "chats"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["chats"][0]["id"] == "c1"


@respx.mock
def test_agent_ask_new_chat_creates_persists_and_returns_id(logged_in, runner):
    respx.post(f"{BASE}/api/agent/chat").mock(
        return_value=_sse([
            {"type": "text-delta", "text": "Hello "},
            {"type": "tool-start", "tool": "run_query", "toolCallId": "1"},
            {"type": "text-delta", "text": "world"},
            {"type": "done"},
        ])
    )
    create = respx.post(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"id": "c9", "title": "New conversation"})
    )
    put = respx.put(f"{BASE}/api/agent/conversations/c9/messages").mock(return_value=httpx.Response(200, json={}))
    patch = respx.patch(f"{BASE}/api/agent/conversations/c9").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "agent", "ask", "hi there"])  # message is positional now
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["answer"] == "Hello world"
    assert data["tools"] == ["run_query"]
    assert data["chat_id"] == "c9"  # the new chat id is surfaced
    assert create.called            # no --chat ⇒ a new chat was created
    # persisted [user, assistant] in the shared {role, content:{text}} shape
    assert json.loads(put.calls.last.request.content)["messages"] == [
        {"role": "user", "content": {"text": "hi there"}},
        {"role": "assistant", "content": {"text": "Hello world"}},
    ]
    assert json.loads(create.calls.last.request.content)["title"] == "hi there"  # titled at creation


@respx.mock
def test_agent_ask_interactive_aborts_without_creating_chat(logged_in, runner):
    # No conversation routes are mocked — if a chat were created, respx would error.
    respx.post(f"{BASE}/api/agent/chat").mock(
        return_value=_sse([
            {"type": "text-delta", "text": "let me check"},
            {"type": "ask-user", "callId": "x", "kind": "approval", "question": "ok to run?", "allowText": True},
        ])
    )
    result = runner.invoke(app, ["agent", "ask", "do it"])
    assert result.exit_code == 1  # clean abort, no orphan chat


@respx.mock
def test_agent_ask_not_configured_503(logged_in, runner):
    respx.post(f"{BASE}/api/agent/chat").mock(return_value=httpx.Response(503, json={"error": "assistant not configured"}))
    result = runner.invoke(app, ["agent", "ask", "hi"])
    assert result.exit_code == 1  # ApiError surfaced; no chat created


@respx.mock
def test_agent_ask_chat_continues_existing_thread(logged_in, runner):
    # --chat resolves via the chat list first, then loads the thread by full id.
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [{"id": "c1", "title": "perf review", "message_count": 2}]})
    )
    respx.get(f"{BASE}/api/agent/conversations/c1").mock(
        return_value=httpx.Response(200, json={"title": "perf review", "messages": [
            {"role": "user", "content": {"text": "earlier q"}},
            {"role": "assistant", "content": {"text": "earlier a"}},
        ]})
    )
    chat = respx.post(f"{BASE}/api/agent/chat").mock(
        return_value=_sse([{"type": "text-delta", "text": "follow up"}, {"type": "done"}])
    )
    put = respx.put(f"{BASE}/api/agent/conversations/c1/messages").mock(return_value=httpx.Response(200, json={}))
    patch = respx.patch(f"{BASE}/api/agent/conversations/c1").mock(return_value=httpx.Response(200, json={}))
    create = respx.post(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"id": "cNEW"}))
    result = runner.invoke(app, ["--json", "agent", "ask", "and now?", "--chat", "c1"])
    assert result.exit_code == 0, result.output
    # prior thread + new user turn sent to the agent for context
    sent = json.loads(chat.calls.last.request.content)["messages"]
    assert len(sent) == 3 and sent[-1] == {"role": "user", "content": {"text": "and now?"}}
    # persisted = history + user + assistant; existing title NOT overwritten; no new chat made
    saved = json.loads(put.calls.last.request.content)["messages"]
    assert len(saved) == 4 and saved[-1] == {"role": "assistant", "content": {"text": "follow up"}}
    assert not patch.called
    assert not create.called
    assert json.loads(result.stdout)["chat_id"] == "c1"


@respx.mock
def test_agent_ask_rejects_unknown_model(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "models": ["m-default", "m-fast"], "defaultModel": "m-default"})
    )
    chat = respx.post(f"{BASE}/api/agent/chat").mock(return_value=_sse([{"type": "done"}]))
    result = runner.invoke(app, ["agent", "ask", "hi", "--model", "bogus-model"])
    assert result.exit_code == 2  # BadParameter — validated against the allowlist before chatting
    assert not chat.called


@respx.mock
def test_agent_ask_accepts_allowlisted_model_and_forwards_it(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "models": ["m-default", "m-fast"], "defaultModel": "m-default"})
    )
    respx.post(f"{BASE}/api/agent/chat").mock(return_value=_sse([{"type": "text-delta", "text": "ok"}, {"type": "done"}]))
    respx.post(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"id": "c9"}))
    respx.put(f"{BASE}/api/agent/conversations/c9/messages").mock(return_value=httpx.Response(200, json={}))
    respx.patch(f"{BASE}/api/agent/conversations/c9").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "agent", "ask", "hi", "--model", "m-fast"])
    assert result.exit_code == 0, result.output
    chat_calls = [c for c in respx.calls if c.request.url.path == "/api/agent/chat"]
    assert json.loads(chat_calls[-1].request.content)["model"] == "m-fast"  # chosen model forwarded


# --- agent: redesigned UI (render assertions; the JSON contracts above are unchanged) ---


@respx.mock
def test_agent_health_renders_configured_card(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "llm_configured": True,
                                               "default_model": "claude-x", "models": ["claude-x", "claude-fast"]})
    )
    result = runner.invoke(app, ["agent", "health"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "assistant" in out and "configured" in out and "claude-x" in out


@respx.mock
def test_agent_health_renders_not_configured(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": False, "llm_configured": False})
    )
    result = runner.invoke(app, ["agent", "health"])
    assert result.exit_code == 0, result.output
    assert "not configured" in result.stdout


@respx.mock
def test_agent_models_renders_default_marker(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(
        return_value=httpx.Response(200, json={"enabled": True, "models": ["m-default", "m-fast"], "defaultModel": "m-default"})
    )
    result = runner.invoke(app, ["agent", "models"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "models" in out and "m-default" in out and "m-fast" in out and "default" in out


@respx.mock
def test_agent_models_empty_is_calm_and_notes_unconfigured(logged_in, runner):
    respx.get(f"{BASE}/api/agent/health").mock(return_value=httpx.Response(200, json={"enabled": False}))
    result = runner.invoke(app, ["agent", "models"])
    assert result.exit_code == 0, result.output
    assert "no models reported" in result.stdout
    assert "isn't configured" in (result.stderr or "")


@respx.mock
def test_agent_chats_renders_table(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [
            {"id": "c1", "title": "perf review", "message_count": 4, "updated_at": "2026-06-27T10:00:00Z"},
        ]})
    )
    result = runner.invoke(app, ["agent", "chats"])
    assert result.exit_code == 0, result.output
    assert "chats" in result.stdout and "perf review" in result.stdout
    assert "chat-id" in result.stdout and "c1" in result.stdout  # full chat-id column by default
    assert "open one with" not in (result.stderr or "")           # footer removed


@respx.mock
def test_agent_chats_empty_is_calm(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"conversations": []}))
    result = runner.invoke(app, ["agent", "chats"])
    assert result.exit_code == 0, result.output
    assert "no chats" in result.stdout


@respx.mock
def test_agent_show_renders_thread(logged_in, runner):
    # show resolves the (short) id via the chat list, then loads the thread by full id.
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [{"id": "c1", "title": "perf review", "message_count": 2}]})
    )
    respx.get(f"{BASE}/api/agent/conversations/c1").mock(
        return_value=httpx.Response(200, json={"title": "perf review", "messages": [
            {"role": "user", "content": {"text": "why slow"}},
            {"role": "assistant", "content": "because cache"},  # str-or-{text}: both extracted
        ]})
    )
    result = runner.invoke(app, ["agent", "show", "c1"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "perf review" in out and "you" in out and "assistant" in out
    assert "why slow" in out and "because cache" in out


@respx.mock
def test_agent_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"conversations": []}))
    result = runner.invoke(app, ["agent", "show", "ghost"])
    assert result.exit_code == 6
    assert "chat not found" in (result.stderr or result.output)


@respx.mock
def test_agent_show_not_found_json(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"conversations": []}))
    result = runner.invoke(app, ["--json", "agent", "show", "ghost"])
    assert result.exit_code == 6
    assert "chat not found" in json.loads(result.stdout)["error"]


@respx.mock
def test_agent_rename_renders_card_and_keeps_json(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [{"id": "c1", "title": "old name", "message_count": 0}]})
    )
    patch = respx.patch(f"{BASE}/api/agent/conversations/c1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["agent", "rename", "c1", "--title", "new name"])
    assert result.exit_code == 0, result.output
    err = result.stderr or ""
    assert "chat renamed" in err and "new name" in err and "was old name" in err
    assert json.loads(patch.calls.last.request.content)["title"] == "new name"
    # JSON contract unchanged (now the full resolved id)
    result2 = runner.invoke(app, ["--json", "agent", "rename", "c1", "--title", "x"])
    assert json.loads(result2.stdout) == {"id": "c1", "title": "x"}


@respx.mock
def test_agent_rename_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"conversations": []}))
    result = runner.invoke(app, ["agent", "rename", "ghost", "--title", "x"])
    assert result.exit_code == 6
    assert "chat not found" in (result.stderr or result.output)


@respx.mock
def test_agent_delete_yes_renders_and_keeps_json(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(
        return_value=httpx.Response(200, json={"conversations": [{"id": "c1", "title": "perf review", "message_count": 1}]})
    )
    delete = respx.delete(f"{BASE}/api/agent/conversations/c1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["agent", "delete", "c1", "--yes"])
    assert result.exit_code == 0, result.output
    err = result.stderr or ""
    assert "deleted chat" in err and "perf review" in err
    assert delete.called
    # JSON contract (now also carries the title)
    result2 = runner.invoke(app, ["--json", "agent", "delete", "c1", "--yes"])
    body = json.loads(result2.stdout)
    assert body["deleted"] is True and body["id"] == "c1" and body["title"] == "perf review"


@respx.mock
def test_agent_delete_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"conversations": []}))
    result = runner.invoke(app, ["agent", "delete", "ghost", "--yes"])
    assert result.exit_code == 6
    assert "chat not found" in (result.stderr or result.output)


@respx.mock
def test_agent_ask_answer_to_stdout_chrome_to_stderr(logged_in, runner):
    respx.post(f"{BASE}/api/agent/chat").mock(
        return_value=_sse([
            {"type": "tool-start", "tool": "run_query"},
            {"type": "text-delta", "text": "the answer"},
            {"type": "done"},
        ])
    )
    respx.post(f"{BASE}/api/agent/conversations").mock(return_value=httpx.Response(200, json={"id": "c9"}))
    respx.put(f"{BASE}/api/agent/conversations/c9/messages").mock(return_value=httpx.Response(200, json={}))
    respx.patch(f"{BASE}/api/agent/conversations/c9").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["agent", "ask", "q"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == "the answer"  # piped (non-tty) → ONLY the raw answer on stdout
    err = result.stderr or ""
    assert "used tool: run_query" in err
    assert "new chat" in err and "fp agent ask --chat c9" in err


@respx.mock
def test_agent_ask_assistant_error_clean_exit_1(logged_in, runner):
    respx.post(f"{BASE}/api/agent/chat").mock(
        return_value=_sse([{"type": "error", "message": "model overloaded"}])
    )
    result = runner.invoke(app, ["agent", "ask", "q"])
    assert result.exit_code == 1
    assert "✗" in (result.stderr or "") and "model overloaded" in (result.stderr or "")
