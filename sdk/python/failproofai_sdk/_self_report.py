"""Self Reports: a tool the agent calls when it is stuck.

The agent decides when to call it, from the tool's description alone. A call is
recorded as a `self_report` event on the agent's session and the tool answers
`Recorded.` — it never unblocks anything or changes a decision.

    import failproofai_sdk as fp

    tools = [fp.openai_tool(), *my_tools]          # or anthropic_tool()
    ...
    if fp.is_self_report_tool(call.name):
        result = fp.handle_tool_call(call.name, call.arguments)   # "Recorded."

Ready-made framework tools live next to each adapter, e.g.
`from failproofai_sdk.integrations.langchain import self_report_tool`.

Categories and extra guidance come from `$FAILPROOFAI_HOME/self-report.json`
(written by the FailproofAI daemon from the org's Cloud setting, or by
`failproofai self-report enable`). When the file is missing, unreadable, or says
the feature is off, the defaults below are used: a developer who added this tool
to their agent asked for it explicitly, so it always has a usable spec.

Stdlib only, like the rest of the core (`tests/test_zero_dependencies.py`).
"""

from __future__ import annotations

import copy
import json
import logging
import re
from pathlib import Path
from typing import Any

from failproofai_sdk import _runtime
from failproofai_sdk._events import clip_report_text
from failproofai_sdk._resolver import failproofai_home

logger = logging.getLogger(__name__)

__all__ = [
    "TOOL_NAME",
    "RESULT",
    "DEFAULT_CATEGORIES",
    "self_report",
    "self_report_spec",
    "describe",
    "load_settings",
    "settings_path",
    "openai_tool",
    "openai_responses_tool",
    "anthropic_tool",
    "handle_tool_call",
    "is_self_report_tool",
]

#: The SDK tool's name. The coding-agent MCP tool is `report` on server
#: `failproofai`; `is_self_report_tool` recognises every spelling of both.
TOOL_NAME = "failproofai_report"

#: The tool's result text, exactly. Nothing else is ever returned to the model.
RESULT = "Recorded."

#: Used when no org categories are configured. An org's own list REPLACES these.
DEFAULT_CATEGORIES: tuple[dict[str, str], ...] = (
    {"name": "looping", "description": "You keep repeating the same or circular steps without making progress."},
    {"name": "cannot_do_request", "description": "The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating."},
    {"name": "invalid_tool_or_credential", "description": "A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected."},
    {"name": "missing_context", "description": "Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions."},
    {"name": "repeated_tool_failure", "description": "A command or tool failed on several distinct attempts and is blocking you. A single error is not enough."},
    {"name": "task_failure", "description": "You genuinely tried and could not complete the task. Not for refusals or policy blocks."},
)

_PREAMBLE = (
    "Report to FailproofAI that you are stuck. Call this only when you are blocked and cannot "
    "make progress on your own; do not call it for normal work, clarifying questions or a "
    "single error. One call per distinct problem.\n"
    "Reporting does not unblock you and changes no decision: afterwards, work around the "
    "problem or tell the user what is blocking you. There is no need to mention this report "
    "to the user."
)

_DETAIL_DESCRIPTION = "One factual sentence: what is blocking you."

_NAME_PATTERN = r"[a-z][a-z0-9_]{0,63}"  # compiled on first use: nothing runs at import
_MAX_CATEGORIES = 32
_MAX_DESCRIPTION = 500
_MAX_GUIDANCE = 2000

#: Every spelling the report tool reaches a host under (case-insensitive,
#: exact): the SDK name (also OpenCode's), and the MCP tool `report` on server
#: `failproofai` as each agent prefixes it: Claude Code, Codex, Pi, Factory and
#: Devin `mcp__failproofai__report`, Factory's matcher form
#: `failproofai___report`, Hermes and Antigravity `mcp_failproofai_report`,
#: OpenClaw and Goose `failproofai__report`, Copilot CLI (likely, unverified)
#: `failproofai-report` / `failproofai/report`, plus other server-qualified forms.
#: The CLI and the TypeScript SDK test the same list against the repository's
#: test-fixtures/self-report/tool-names.golden.txt.
TOOL_SPELLINGS: tuple[str, ...] = (
    "mcp__failproofai__report",
    "failproofai___report",
    "failproofai__report",
    "failproofai_report",
    "failproofai.report",
    "failproofai/report",
    "failproofai:report",
    "mcp_failproofai_report",
    "mcp__failproofai_report",
    "mcp:failproofai:report",
    "mcp:failproofai/report",
    "failproofai-report",
)
_TOOL_NAMES = frozenset(TOOL_SPELLINGS)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def settings_path() -> Path:
    """`$FAILPROOFAI_HOME/self-report.json` (default `~/.failproofai/self-report.json`)."""
    return failproofai_home() / "self-report.json"


def _valid_category(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    name, description = entry.get("name"), entry.get("description")
    return (
        isinstance(name, str)
        and re.fullmatch(_NAME_PATTERN, name) is not None
        and isinstance(description, str)
        and 1 <= len(description) <= _MAX_DESCRIPTION
    )


def _clean_categories(raw: Any) -> list[dict[str, str]] | None:
    """`raw` as a clean category list, or None when it is not a valid one.

    All or nothing: 1-32 entries, every name `^[a-z][a-z0-9_]{0,63}$` and
    unique, every description 1-500 chars. Anything else means the defaults —
    the same rule the MCP server and the TypeScript SDK apply.
    """
    if not isinstance(raw, list) or not 1 <= len(raw) <= _MAX_CATEGORIES:
        return None
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not _valid_category(entry) or entry["name"] in seen:
            return None  # one bad entry invalidates the list: defaults, as every reader does
        seen.add(entry["name"])
        out.append({"name": entry["name"], "description": entry["description"]})
    return out


def load_settings() -> dict[str, Any]:
    """The effective settings: `{"enabled", "categories", "guidance"}`.

    Read fresh on every call (the file is tiny, and the daemon rewrites it when
    the org changes its categories). Missing or unparsable file: disabled, with
    the default categories. File present but disabled: the default categories
    and no guidance — the org's list only applies while the org has it on.
    """
    result: dict[str, Any] = {
        "enabled": False,
        "categories": [dict(c) for c in DEFAULT_CATEGORIES],
        "guidance": None,
    }
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return result
    if not isinstance(data, dict) or data.get("enabled") is not True:
        return result
    result["enabled"] = True
    categories = _clean_categories(data.get("categories"))
    if categories:
        result["categories"] = categories
    guidance = data.get("guidance")
    if isinstance(guidance, str) and guidance and len(guidance) <= _MAX_GUIDANCE:
        result["guidance"] = guidance  # over the limit: dropped, never cut mid-sentence
    return result


# ---------------------------------------------------------------------------
# The spec
# ---------------------------------------------------------------------------

def describe(categories: Any, guidance: str | None = None) -> str:
    """The tool description. Identical text in every FailproofAI implementation."""
    lines = [_PREAMBLE, "", "Categories:"]
    lines.extend(f"- {c['name']}: {c['description']}" for c in categories)
    text = "\n".join(lines)
    if guidance:
        text += "\n\n" + guidance
    return text


def _input_schema(names: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": names},
            "detail": {"type": "string", "description": _DETAIL_DESCRIPTION},
        },
        "required": ["category", "detail"],
        "additionalProperties": False,
    }


def self_report_spec(
    *,
    categories: list[dict[str, str]] | None = None,
    guidance: str | None = None,
) -> dict[str, Any]:
    """`{"name", "description", "input_schema"}` for the report tool.

    Built from `self-report.json`, or the defaults. Pass `categories` (and
    optionally `guidance`) to override both explicitly; an invalid list raises
    `ValueError` rather than shipping a tool the model cannot call correctly.
    """
    if categories is None:
        settings = load_settings()
        cats = settings["categories"]
        if guidance is None:
            guidance = settings["guidance"]
    else:
        cats = _clean_categories(categories)
        if cats is None:
            raise ValueError(
                "categories must be a non-empty list (at most 32) of "
                '{"name": <^[a-z][a-z0-9_]{0,63}$>, "description": <1-500 chars>} with unique names'
            )
    if guidance is not None and not isinstance(guidance, str):
        raise TypeError(f"guidance must be a str or None, got {type(guidance).__name__}")
    return {
        "name": TOOL_NAME,
        "description": describe(cats, guidance),
        "input_schema": _input_schema([c["name"] for c in cats]),
    }


def openai_tool(**overrides: Any) -> dict[str, Any]:
    """The tool for OpenAI Chat Completions `tools=[...]`."""
    spec = self_report_spec(**overrides)
    return {
        "type": "function",
        "function": {
            "name": spec["name"],
            "description": spec["description"],
            "parameters": spec["input_schema"],
        },
    }


def openai_responses_tool(**overrides: Any) -> dict[str, Any]:
    """The tool for the OpenAI Responses API `tools=[...]` (flat function shape).

    `strict: True`, as the TypeScript SDK's `openaiResponsesTool()`: the schema
    already meets strict mode (every property required, no extra properties).
    """
    spec = self_report_spec(**overrides)
    return {
        "type": "function",
        "name": spec["name"],
        "description": spec["description"],
        "parameters": spec["input_schema"],
        "strict": True,
    }


def anthropic_tool(**overrides: Any) -> dict[str, Any]:
    """The tool for the Anthropic Messages API `tools=[...]`."""
    return copy.deepcopy(self_report_spec(**overrides))


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

def self_report(category: str, detail: str | None = "", **fields: Any) -> None:
    """Record a `self_report` event in the current session and agent scope.

    Same writer as every `event.*` method. `session_id=` / `agent_id=` may be
    passed; otherwise the open `tool_use` for this call, then the enclosing
    `failproofai_sdk.session()` / `agent()` scope, and with nothing bound the
    report is filed under `"unattributed"` (one warning) rather than raising.
    The event carries `source: "sdk"`.
    """
    _runtime.event.self_report(category, detail, **fields)


def is_self_report_tool(name: Any, server: Any = None) -> bool:
    """True for the report tool under any of its names.

    Use it to hide the call from your UI or transcript: `failproofai_report`
    (this SDK), and the MCP tool as agents spell it (`mcp__failproofai__report`,
    `mcp_failproofai_report`, `failproofai__report`, ...). `server` is for
    hosts that name an MCP tool and its server separately (Cursor's
    `tool_name` + `mcp_server_name`): a bare `report` matches only when the
    server is `failproofai`.
    """
    if not isinstance(name, str):
        return False
    lower = name.strip().lower()
    if lower in _TOOL_NAMES:
        return True
    return (
        isinstance(server, str)
        and server.strip().lower() == "failproofai"
        and lower in ("report", "mcp:report")
    )


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


# Other names a model uses for an argument when it calls the tool without
# loading its schema (seen live: `summary` and `sentence` for `detail`). The
# first non-empty one is used when the real argument is missing or empty;
# unknown keys are ignored. The same list as the CLI and the daemon:
# test-fixtures/self-report/arg-aliases.json.
ARG_ALIASES: dict[str, tuple[str, ...]] = {
    "category": ("type", "kind"),
    "detail": ("summary", "sentence", "message", "description", "reason", "text", "details"),
}


def _first_text(arguments: dict, key: str) -> str:
    for name in (key, *ARG_ALIASES[key]):
        text = _coerce_text(arguments.get(name))
        if text:
            return text
    return ""


def parse_arguments(arguments: Any) -> tuple[str, str]:
    """`(category, detail)` from a model's tool-call arguments. Never raises.

    Accepts a dict or a JSON string (OpenAI sends a string, Anthropic a dict).
    A string that is not a JSON object is kept whole as the detail, so a model
    that fumbled the arguments still leaves a readable report. A missing or
    empty argument falls back to its first non-empty alias (`ARG_ALIASES`).
    """
    if isinstance(arguments, (str, bytes, bytearray)):
        text = arguments.decode("utf-8", "replace") if not isinstance(arguments, str) else arguments
        if not text.strip():
            arguments = {}
        else:
            try:
                arguments = json.loads(text)
            except ValueError:
                return "", clip_report_text(text)
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        return "", clip_report_text(_coerce_text(arguments))
    return _first_text(arguments, "category"), _first_text(arguments, "detail")


_warned_unbound = False


def record_tool_call(arguments: Any, **fields: Any) -> str:
    """Record a report from a model's tool call and return `"Recorded."`.

    Never raises into the agent loop. A report that cannot be recorded (a
    writer fault, an invalid explicit id) is logged (once at WARNING, then at
    DEBUG) and the model still gets `Recorded.`: the tool's contract is that it
    changes nothing, and a raise here would turn a stuck agent into a crashed one.
    """
    global _warned_unbound
    category, detail = parse_arguments(arguments)
    try:
        self_report(category, detail, **fields)
    except Exception as exc:  # noqa: BLE001 - see docstring
        level = logging.DEBUG if _warned_unbound else logging.WARNING
        _warned_unbound = True
        logger.log(
            level,
            "failproofai_sdk: a self report was not recorded (%s).",
            exc,
        )
    return RESULT


def handle_tool_call(
    name: str,
    arguments: Any = None,
    *,
    session_id: str | None = None,
    agent_id: str | None = None,
    tool_call_id: str | None = None,
) -> str:
    """Handle a report tool call from a raw model API. Returns `"Recorded."`.

        for call in message.tool_calls:
            if fp.is_self_report_tool(call.function.name):
                out = fp.handle_tool_call(call.function.name, call.function.arguments,
                                          tool_call_id=call.id)

    `arguments` may be a dict or a JSON string. Raises `ValueError` only when
    `name` is not the report tool, so a dispatcher bug is loud; recording itself
    never raises (see `record_tool_call`).
    """
    if not is_self_report_tool(name):
        raise ValueError(
            f"{name!r} is not the FailproofAI report tool; check is_self_report_tool(name) first"
        )
    fields: dict[str, Any] = {}
    if session_id is not None:
        fields["session_id"] = session_id
    if agent_id is not None:
        fields["agent_id"] = agent_id
    if tool_call_id:
        fields["tool_call_id"] = str(tool_call_id)
    return record_tool_call(arguments, **fields)


# ---------------------------------------------------------------------------
# Shared by the framework tools in `integrations/<framework>.py`
# ---------------------------------------------------------------------------

def record_framework_call(
    category: Any,
    detail: Any,
    *,
    identity: Any = None,
    session_id: str | None = None,
    agent_id: str | None = None,
    tool_call_id: Any = None,
    fields: dict | None = None,
    extra_args: dict | None = None,
) -> str:
    """Record one framework tool call and return `"Recorded."`. Never raises.

    Identity, most explicit first: the `session_id` / `agent_id` the developer
    gave the tool factory; then `identity`, which the adapter resolved from the
    framework's own run tree (so the report lands on the agent that made the
    call even when no `failproofai_sdk.session()` is open); then what
    `event.self_report` resolves itself (the open `tool_use` for the call, the
    ambient scope, else `"unattributed"`).
    """
    out: dict[str, Any] = dict(fields or {})
    if session_id is None and identity is not None and getattr(identity, "session_id", None):
        session_id = identity.session_id
        if agent_id is None:
            agent_id = getattr(identity, "agent_id", None)
    if session_id is not None:
        out["session_id"] = session_id
    if agent_id is not None:
        out["agent_id"] = agent_id
    if tool_call_id:
        out["tool_call_id"] = str(tool_call_id)
    # `extra_args`: any other arguments the framework passed through raw, so
    # an aliased detail (`summary`, `sentence`, ...) is not lost.
    arguments = {k: v for k, v in (extra_args or {}).items() if isinstance(k, str)}
    arguments.update(category=category, detail=detail)
    return record_tool_call(arguments, **out)


def framework_signature(names: list[str]):
    """`(category: Literal[...], detail: str)` annotations for frameworks that
    derive a tool's JSON schema from a Python signature. Stdlib only: the enum
    comes from `typing.Literal`, which every framework's pydantic understands."""
    from typing import Literal

    return {"category": Literal[tuple(names)], "detail": str, "return": str}  # type: ignore[valid-type]
