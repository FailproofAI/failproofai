"""FailproofAI Cloud assistant (Claude) from the CLI: agent health / models / chats / ask / show / rename / delete.

Every ``ask`` is saved to a **chat**: with ``--chat <id>`` it continues that chat, without it a
new chat is started and its short id printed (so you can continue it). ``chats`` lists them;
``show`` / ``rename`` / ``delete`` manage one; ``models`` lists the models you can pass to
``ask --model``.

Chats are referenced by a **short chat-id** — the first 8 chars (the segment before the UUID's
first ``-``) shown in ``agent chats``. The CLI resolves that prefix back to the full chat against
your chat list (so the server/dashboard keep the full id intact); a prefix that matches none → a
``chat not found`` box, one that matches several → an ``ambiguous`` box. If the assistant asks for
interactive input mid-turn, ``ask`` aborts cleanly rather than hang.
"""

from __future__ import annotations

import sys
from typing import Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, deny_in_key_mode, require_auth
from ..errors import NotFoundError
from . import _write

# The assistant has NO server route at all: `/agent/chat` and `/agent/health` are
# implemented by the dashboard itself, and the conversation routes are per-human
# (keyed by actor) and deliberately excluded from the versioned API. So there is
# nothing for an API key to call here — refuse before opening a connection.
_KEY_MODE_REASON = (
    "the assistant runs in the dashboard and its chats belong to a person — there is "
    "no API route behind it for a key to call"
)

# The server's default title for a freshly-created chat; we auto-title from the first
# question only while the title is still this (so an explicit one is kept).
_DEFAULT_TITLE = "New conversation"


def _text_of(content: object) -> str:
    """Extract the display text from a stored message ``content`` — mirrors the
    dashboard's `textOf` so CLI and dashboard render the same thread identically."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def _title_from_question(question: str) -> str:
    """A short, single-line chat title derived from the first question."""
    collapsed = " ".join(question.split())
    if not collapsed:
        return _DEFAULT_TITLE
    return collapsed[:57] + "…" if len(collapsed) > 60 else collapsed


def _models_of(health: dict) -> list:
    """The model allowlist from an agent-health payload (handles list or single shapes)."""
    models = health.get("models")
    if isinstance(models, list) and models:
        return [str(m) for m in models]
    one = health.get("default_model") or health.get("defaultModel") or health.get("model")
    return [str(one)] if one else []


def _default_model_of(health: dict) -> Optional[str]:
    return health.get("default_model") or health.get("defaultModel") or health.get("model")


def _is_configured(health: dict) -> bool:
    """Whether the assistant is usable on this deployment — ``enabled`` AND (``llm_configured``
    when the server reports it; absent → assume configured if enabled)."""
    enabled = bool(health.get("enabled"))
    llm = health.get("llm_configured")
    return enabled and (llm if isinstance(llm, bool) else True)


def _validate_model(cctx, model: str) -> None:
    """Reject a ``--model`` that isn't on the deployment's allowlist. Skips the check when
    the deployment reports no models (lets the server decide / fall back)."""
    models = _models_of(api.agent_health(cctx))
    if models and model not in models:
        raise typer.BadParameter(
            f"model not found {model!r}; available: {', '.join(models)} (see `fp agent models`).",
            param_hint="--model",
        )


def _resolve_chat_or_exit(state: AppState, cctx, handle: str) -> dict:
    """Resolve a chat by its short id PREFIX (the first-8 ``chat-id`` shown in ``agent chats``) or
    a full id, matching against the chat list. Returns the matched chat summary (full ``id`` +
    ``title`` + ``message_count``). None → boxed ``chat not found`` (exit 6); more than one → boxed
    ``ambiguous`` (exit 2). Resolving via the list also avoids fetching a non-existent id directly
    (which the server answers with a 500). Shared by show / rename / delete / ask --chat."""
    chats = api.list_conversations(cctx)
    exact = [c for c in chats if str(c.get("id")) == handle]
    matches = exact or [c for c in chats if str(c.get("id", "")).startswith(handle)]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise NotFoundError(
            f"chat not found: {handle}", hint="run `fp agent chats` to list them"
        )
    ids = [str(c.get("id")) for c in matches]
    raise click.UsageError(
        f"ambiguous chat id: {handle} — matches {len(ids)}; use a longer prefix or the full id"
    )


def agent_health(ctx: typer.Context) -> None:
    """Show whether the assistant is configured on this deployment.

    Needs `agent:use`. With `--json`: `{enabled, llm_configured?, model?, models?, default_model?}`.

    Example:

    * `fp --json agent health`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    data = api.agent_health(cctx)
    if state.json:
        output.emit_json(data)
        return
    output.render_agent_health(
        configured=_is_configured(data),
        default_model=_default_model_of(data),
        model_count=len(_models_of(data)),
    )


def agent_models(ctx: typer.Context) -> None:
    """List the assistant models available on this deployment.

    Needs `agent:use`. The choices (and the default) come from the agent service's
    allowlist; pass any of them to `agent ask --model <name>`. With `--json`:
    `{"models": [...], "default_model": "..."}`.

    Example:

    * `fp agent models`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    data = api.agent_health(cctx)
    models = _models_of(data)
    default = _default_model_of(data)
    if state.json:
        output.emit_json({"models": models, "default_model": default})
        return
    output.render_agent_models(models, default_model=default)
    if not models:
        output.agent_unconfigured_note()


def agent_chats(
    ctx: typer.Context,
) -> None:
    """List your saved chats in a boxed table, newest first.

    Shows `chat-id · title · messages · updated` — `chat-id` is the SHORT id (the first 8 chars; a
    prefix the `agent show`/`rename`/`delete`/`ask --chat` commands resolve), and `updated` is the
    chat's last-activity age. Needs `agent:use`. With `--json`: `{"chats": [{id, title, updated_at,
    message_count}]}` (full id).

    Example:

    * `fp agent chats`
    * `fp --json agent chats`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    chats = api.list_conversations(cctx)
    if state.json:
        output.emit_json({"chats": chats})
        return
    output.render_agent_chats(chats)


def agent_show(
    ctx: typer.Context,
    chat_id: str = typer.Argument(..., metavar="CHAT_ID", help="Chat id — the short one from `agent chats` (a prefix) or a full id."),
) -> None:
    """Show a chat as a readable thread — its title, then each turn (`you` / `assistant`).

    Pass the **short chat-id** from `agent chats` (the first 8 chars; the CLI resolves the prefix
    to the full chat) or a full id. Not-found → a `chat not found` error box, exit 6. Needs
    `agent:use`. With `--json`: `{title, messages: [...]}`.

    Example:

    * `fp agent show 07854990`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    chat = _resolve_chat_or_exit(state, cctx, chat_id)  # short prefix → the full chat
    data = api.get_conversation(cctx, chat["id"])
    if state.json:
        output.emit_json(data)
        return
    output.render_agent_show(title=data.get("title"), messages=data.get("messages", []) or [], chat_id=chat["id"])


def agent_rename(
    ctx: typer.Context,
    chat_id: str = typer.Argument(..., metavar="CHAT_ID", help="Chat id (short prefix or full)."),
    title: str = typer.Option(..., "--title", help="New title for the chat."),
) -> None:
    """Rename a chat, referenced by its **short chat-id** (a prefix) or full id.

    Not-found → a `chat not found` error box, exit 6. Needs `agent:use`. With `--json`:
    `{"id": "<full id>", "title": "<title>"}`.

    Example:

    * `fp agent rename 07854990 --title "page walkthrough"`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    chat = _resolve_chat_or_exit(state, cctx, chat_id)  # validates + gives the full id + old title
    old_title = chat.get("title")
    api.rename_conversation(cctx, chat["id"], title)
    _write.record_action("agent_chat_renamed", resource="conversation", success=True)
    if state.json:
        output.emit_json({"id": chat["id"], "title": title})
    else:
        output.render_agent_renamed(chat_id=chat["id"], title=title, old_title=old_title)


def agent_delete(
    ctx: typer.Context,
    chat_id: str = typer.Argument(..., metavar="CHAT_ID", help="Chat id to delete (short prefix or full)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Delete a chat, referenced by its **short chat-id** (a prefix) or full id. Cannot be undone.

    Shows an amber preview, then confirms. Not-found → a `chat not found` error box, exit 6. Needs
    `agent:use`. With `--json`: `{"deleted": true, "id": "<full id>", "title": "<title>"}` (or
    `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp agent delete 07854990`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    cctx = require_auth(state)
    chat = _resolve_chat_or_exit(state, cctx, chat_id)  # validates + powers the preview
    title = chat.get("title") or chat["id"]
    message_count = chat.get("message_count") or 0
    if _write.should_prompt(state, yes):
        output.render_agent_delete_preview(title=title, message_count=message_count, chat_id=chat["id"])
        if not output.confirm_agent_delete():
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.print_cancelled("nothing deleted")
            return
    api.delete_conversation(cctx, chat["id"])
    _write.record_action("agent_chat_deleted", resource="conversation", success=True, destructive=True)
    if state.json:
        output.emit_json({"deleted": True, "id": chat["id"], "title": title})
    else:
        output.agent_deleted(title)


def agent_ask(
    ctx: typer.Context,
    message: Optional[str] = typer.Argument(None, metavar="MESSAGE", help="Your question (or pipe it on stdin)."),
    chat: Optional[str] = typer.Option(None, "--chat", help="Continue this chat — its short id from `agent chats` (a prefix) or full id. Omit to start a NEW chat (its id is printed)."),
    model: Optional[str] = typer.Option(None, "--model", help="Model to use (see `agent models`)."),
    page_context: Optional[str] = typer.Option(None, "--page-context", help="Optional context string to ground the answer."),
) -> None:
    """Ask the assistant a question — every ask is saved to a chat.

    Pass the question as the **positional MESSAGE** (or pipe it on stdin). Needs `agent:use`.

    * **No `--chat`** → starts a **new chat**, answers, persists, and prints the new chat's short
      id (continue it with `--chat <short id>`); the first question auto-titles the chat.
    * **`--chat <id>`** → continues that chat (short prefix or full id): its prior thread is sent
      for context and this turn is appended. Chats also show up in the dashboard assistant.

    The answer renders in a boxed `assistant` card (interactively); when piped it's the raw answer
    on **stdout** (a clean payload). A brand-new chat is created only once an answer lands — if the
    assistant needs interactive input it aborts (exit 1) and leaves no empty chat. With `--json`:
    `{answer, tools, interrupted, error, chat_id}`.

    Examples:

    * `fp agent ask "which agents errored most in the last day?"`
    * `fp agent ask "and how about the last week?" --chat 07854990`
    * `fp agent ask "summarize p95 latency" --model claude-opus-4-7`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "agent", _KEY_MODE_REASON)
    if not message:
        message = sys.stdin.read().strip() if not sys.stdin.isatty() else typer.prompt("question", err=True)
    if not message:
        raise typer.BadParameter("Provide a question as the MESSAGE argument or on stdin.")
    cctx = require_auth(state)
    if model is not None:
        _validate_model(cctx, model)

    # Continuing a chat → resolve the (short) handle to a full id and load its prior thread;
    # a new chat starts empty (and is created only on success, so a failed ask leaves no orphan).
    full_chat_id: Optional[str] = None
    prior = []
    if chat:
        full_chat_id = _resolve_chat_or_exit(state, cctx, chat)["id"]
        prior = api.get_conversation(cctx, full_chat_id).get("messages", []) or []
    thread = [
        {"role": str(m.get("role", "user")), "content": {"text": _text_of(m.get("content"))}}
        for m in prior
    ]
    thread.append({"role": "user", "content": {"text": message}})

    # The reply streams server-side (an LLM turn + tool calls can take many seconds); show a
    # themed spinner on stderr so the CLI doesn't look hung. No-op under --json / non-TTY.
    with output.thinking("thinking…", enabled=not state.json):
        result = api.agent_chat_oneshot(
            cctx, messages=thread, conversation_id=full_chat_id, page_context=page_context, model=model
        )

    chat_id = full_chat_id
    if not result.get("interrupted") and not result.get("error"):
        if chat_id is None:
            # New chat: set the question-derived title at creation (one POST) instead of
            # create-with-empty-title then a follow-up rename PATCH.
            chat_id = (api.create_conversation(cctx, title=_title_from_question(message)) or {}).get("id")
        if chat_id:
            full = thread + [{"role": "assistant", "content": {"text": result.get("answer", "")}}]
            api.replace_messages(cctx, chat_id, full)
            if full_chat_id is not None and not prior:
                # Continuing a chat that had no messages yet → title it from this first question
                # (a brand-new chat is already titled at create_conversation above).
                api.rename_conversation(cctx, chat_id, _title_from_question(message))

    _write.record_action(
        "agent_chat", resource="conversation",
        success=not result.get("interrupted"),
        mode="continue" if chat else "new",
    )
    if state.json:
        output.emit_json({**result, "chat_id": chat_id})
    else:
        for tool in result.get("tools", []):
            output.agent_tool_used(tool)
        answer = result.get("answer", "")
        if sys.stdout.isatty():
            output.render_agent_answer(answer, model=model)   # boxed assistant card
        else:
            print(answer)                                     # raw answer → stdout (pipeable)
        if chat_id and not chat:                              # a fresh chat was created
            output.render_agent_new_chat(chat_id)
    if result.get("interrupted"):
        output.agent_error(f"the assistant needs interactive input ({result.get('error')}); not supported in the CLI")
        raise typer.Exit(code=1)
    if result.get("error"):
        output.agent_error(f"assistant error: {result.get('error')}")
        raise typer.Exit(code=1)


_AGENT_GROUP_HELP = """Chat with the FailproofAI Cloud assistant (Claude) about your org's observability data.

`ask` a question — each ask is saved to a **chat**. Continue a chat with `--chat <short id>`
(the first 8 chars shown in `agent chats`). The assistant can read your sessions, events,
evaluations, alerts, keys, and saved queries — scoped to your org.

**Subcommands:** `health` · `models` · `chats` · `ask` · `show` · `rename` · `delete`

**Examples:**

* `fp agent health` — is the assistant configured on this deployment?
* `fp agent models` — which models can I pass to `ask --model`?
* `fp agent ask "which agents errored most in the last day?"` — ask (starts a new chat)
* `fp agent ask "and the last week?" --chat 07854990` — continue a chat by its short id
* `fp agent chats` — list your chats (with their short ids)
* `fp agent show 07854990` — read a chat's full thread
* `fp agent rename 07854990 --title "latency dig"` · `fp agent delete 07854990`
"""


def register(app: typer.Typer) -> None:
    agent = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help=_AGENT_GROUP_HELP,
    )
    # Order: discover (health/models) → list (chats) → use (ask) → manage one (show/rename/delete).
    agent.command("health", epilog=GLOBALS_EPILOG)(agent_health)
    agent.command("models", epilog=GLOBALS_EPILOG)(agent_models)
    agent.command("chats", epilog=GLOBALS_EPILOG)(agent_chats)
    agent.command("ask", epilog=GLOBALS_EPILOG)(agent_ask)
    agent.command("show", epilog=GLOBALS_EPILOG)(agent_show)
    agent.command("rename", epilog=GLOBALS_EPILOG)(agent_rename)
    agent.command("delete", epilog=GLOBALS_EPILOG)(agent_delete)
    app.add_typer(agent, name="agent")
