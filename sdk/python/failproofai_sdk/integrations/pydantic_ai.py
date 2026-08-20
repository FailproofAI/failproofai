"""Failproof AI adapter for Pydantic AI, built on `AbstractCapability`.

Written against **pydantic-ai-slim 2.20.0** (2026-07-29), read out of the
installed package rather than from memory. Every v1 tutorial is wrong for this
version: `Agent(instrument=...)` was **removed in 2.0.0b1**, and
`opentelemetry-api` became a core, non-optional dependency of pydantic-ai-slim.

Why the capability protocol and not an OTel span processor
----------------------------------------------------------
`pydantic_ai.capabilities.AbstractCapability` is a full middleware protocol —
`wrap_run`, `wrap_model_request`, `wrap_tool_execute` and friends — and
Pydantic's own `Instrumentation` capability is just another consumer of it with
no privileged access. So `capabilities=[FailproofAI()]`:

* hands us typed `RunContext` / `ModelResponse` / `RunUsage` objects instead of
  stringly-typed span attributes;
* needs no OTel **SDK** on the user's machine (only the API package, which is
  already a hard dependency);
* cannot double-count against the user's own tracing, because we are a sibling
  of `Instrumentation` rather than a second exporter on the same spans.

The OTel route would additionally have had to read **both** `gen_ai.usage.*`
(model spans) and `gen_ai.aggregated_usage.*` (run spans) — the latter is a
Pydantic extension that every existing vendor silently drops, which is how
agent-run token counts come out as zero elsewhere. We read `RunUsage` directly
and the question does not arise.

Adapter shape
-------------
This is **Shape A** end to end: every capability hook is a wrapper whose start
and end sit in one frame, so the adapter can bind Failproof AI identity onto
contextvars for the duration of a run (`failproofai_sdk.session(...)`) and nested
`agent.run()` calls — an agent invoked from inside another agent's tool — nest
themselves with no bookkeeping. `RunTracker` still owns the id/parent/session
resolution and every emit, so `framework` / `framework_version` /
`integration_version` land on **every** event, including `agent_end`.

One thing Shape A does **not** give you here, and `_open_runs` is the whole of
what this module keeps to cover it: a leaf hook can return *after* the run hook
that contains it. Cancellation is the reliable case — the graph awaits a
`gather` of tool tasks, so the run body unwinds the moment that future is
cancelled while each tool task's own `CancelledError` lands a loop iteration
later. `_close_spans` therefore closes whatever leaves are still open before
`agent_end`, and `_claim_span` / `_claim_run` make the late handler (and a
concurrent `uninstall()`) a no-op rather than a duplicate.

How it installs
---------------
There is no supported global capability default in 2.20: `Agent.instrument_all()`
sets `Agent._instrument_default`, which is consulted *only* for the built-in
`Instrumentation` capability, and the one real auto-injection list
(`pydantic_ai.agent._AUTO_INJECT_CAPABILITY_TYPES`) is a private module
constant. So `install()` wraps the public `Agent.__init__` and appends our
capability to its keyword-only `capabilities=` argument, saving the original
function object through `_core.Patcher` so `uninstall()` restores exactly that
object.

Consequence, and it is worth knowing: an `Agent` **constructed while
instrumented keeps the capability object forever** — we cannot retro-remove
ourselves from an already-built agent. `uninstall()` therefore also flips a
module-level flag that makes every hook a straight pass-through, so an agent
built before `uninstrument()` stops recording rather than recording into a
half-dismantled adapter. By the same token, agents constructed *before*
`instrument()` are not instrumented; construct them after, or pass
`capabilities=[FailproofAI()]` yourself.

What is deliberately not captured
---------------------------------
* **Graph nodes** (`UserPromptNode`, `ModelRequestNode`, `CallToolsNode`) get no
  events. They are Pydantic AI's own loop machinery, not user-authored steps —
  unlike a LangGraph node, which is a `hook_*` pair because the user wrote it.
  Everything a node does that is worth seeing is already covered by the model
  and tool spans, and `wrap_node_run` would double the row count for nothing.
  Not overriding it also keeps `AbstractCapability.has_wrap_node_run` False.
* **`wrap_run_event_stream`** is not overridden either, and that one is a
  landmine: overriding it makes `agent.run()` switch itself into streaming mode.
  Per-token events are forbidden anyway (a 500-token response would be 500
  stored rows against a 5-lane rail).
"""

import dataclasses
import logging
import threading
import time
import traceback as _traceback
import uuid
from typing import Any

import failproofai_sdk
from failproofai_sdk._scopes import _is_cancellation
from failproofai_sdk.integrations import _compat, _core
from failproofai_sdk.integrations._core import (
    RunTracker,
    framework_fields,
    fw_fields,
    ms,
    normalize_agent_id,
    safe,
)

logger = logging.getLogger("failproofai_sdk.integrations")

NAME = "pydantic_ai"
MODULE = "pydantic_ai"
DIST = "pydantic-ai-slim"
EXTRA = "pydantic-ai"

# 2.0 is a CAPABILITY floor, not a guess: it is the release that removed
# `Agent(instrument=...)` and introduced `AbstractCapability` — the entire
# surface this module is built on. The ceiling is deliberate: without one, a
# clean build after the next major shifts the hook names and this adapter stops
# recording while raising nothing at all.
MIN_VERSION = "2.0"
BELOW_VERSION = "3"
_VERSION_REASON = "2.0 removed Agent(instrument=...) and added the capabilities middleware protocol"

# This module is only ever imported by `instrument("pydantic_ai")`, so a
# module-level framework import is fine here and nowhere else — `import failproofai_sdk`
# still pulls in zero third-party packages. `require_module` first so the failure
# is the tier-1 ImportError carrying the literal install command, rather than a
# bare `No module named 'pydantic_ai'`.
_compat.require_module("pydantic_ai.capabilities", dist=DIST, extra=EXTRA)

from pydantic_ai.capabilities import (  # noqa: E402  (deliberately after the probe)
    AbstractCapability,
    CapabilityOrdering,
)

# One tracker for the process. `base_fields` is what puts `framework` on every
# single event this adapter emits, agent_end and error included.
_tracker = RunTracker(NAME, base_fields=framework_fields(NAME, DIST))

# Flipped by install()/uninstall(). Agents built while instrumented keep the
# capability instance, so this flag — not the patch — is what actually stops the
# recording. Read on every hook, written only under the registry lock.
_enabled = False
_capability: "FailproofAI | None" = None
_patcher = _core.Patcher()


# ---------------------------------------------------------------------------
# Control flow that is not failure
# ---------------------------------------------------------------------------

def _control_flow_types() -> tuple:
    """Exceptions Pydantic AI raises to *steer* a run, not to report a failure.

    Resolved by name at import time and tolerant of every one of them being
    absent: this list is exactly the kind of thing a minor release renames, and
    a missing name must degrade to "treat it as an error" rather than to an
    `AttributeError` inside the customer's run.

    `ModelRetry` / `ToolRetryError` / `ToolFailedError` are **not** here on
    purpose. They mean an attempt genuinely failed and the model was asked to
    try again, which is exactly what a tool span's `error` field is for; the run
    itself still ends `success` if the retry works.
    """
    import pydantic_ai.exceptions as exceptions

    found = []
    for name in (
        "SkipToolExecution",
        "SkipToolValidation",
        "SkipModelRequest",
        "CallDeferred",
        "ApprovalRequired",
    ):
        candidate = getattr(exceptions, name, None)
        if isinstance(candidate, type) and issubclass(candidate, BaseException):
            found.append(candidate)
    return tuple(found)


_CONTROL_FLOW = _control_flow_types()


def _is_control_flow(exc: BaseException) -> bool:
    return _is_cancellation(type(exc)) or isinstance(exc, _CONTROL_FLOW)


def _describe(exc: BaseException) -> str:
    text = str(exc)
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


_TRACEBACK_MARKER = "[older frames truncated]…\n"


def _format_traceback(exc: BaseException) -> str:
    """The traceback, trimmed from the FRONT if it is too long.

    Every truncation in `_core` keeps the head, which is exactly wrong here: a
    traceback's last line is the exception itself, and Pydantic AI's async graph
    stack is comfortably longer than the 8KB field limit. Keeping the head would
    ship 8KB of framework frames and drop the one line anybody reads.
    """
    text = "".join(_traceback.format_exception(type(exc), exc, exc.__traceback__))
    if len(text) <= _core.FIELD_LIMIT:
        return text
    tail = text[-(_core.FIELD_LIMIT - len(_TRACEBACK_MARKER)):]
    return _TRACEBACK_MARKER + tail


# ---------------------------------------------------------------------------
# Reading the framework's objects
# ---------------------------------------------------------------------------

def _run_key(ctx: Any) -> Any:
    """A stable per-run key. `run_id` is set for every real run; the fallback
    only matters for a synthetic `RunContext` that is not backed by one."""
    run_id = getattr(ctx, "run_id", None)
    return ("pydantic_ai.run", run_id if run_id else id(ctx))


def _agent_name(ctx: Any) -> str:
    """`agent_id` must stay low-cardinality and human readable.

    Pydantic AI infers `Agent.name` from the assigning call frame on the first
    run, so this is normally the variable name (`weather_agent`).
    `normalize_agent_id` turns anything id-shaped — or nothing at all — into
    `main` and the real id rides in `fw_run_id`.
    """
    agent = getattr(ctx, "agent", None)
    return normalize_agent_id(getattr(agent, "name", None))


def _text(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def _model_name(model: Any) -> str | None:
    return getattr(model, "model_name", None) if model is not None else None


def _render_part(part: Any, capture_content: bool) -> dict:
    out: dict[str, Any] = {"part_kind": getattr(part, "part_kind", None) or type(part).__name__}
    tool_name = getattr(part, "tool_name", None)
    if tool_name:
        out["tool_name"] = tool_name
    tool_call_id = getattr(part, "tool_call_id", None)
    if tool_call_id:
        out["tool_call_id"] = tool_call_id
    if capture_content:
        content = getattr(part, "content", None)
        if content is None:
            content = getattr(part, "args", None)
        if content is not None:
            out["content"] = content
    return out


# Pydantic AI hands `wrap_model_request` the WHOLE conversation on every step,
# so shipping it verbatim makes a 30-step run quadratic in payload size — and
# these are prompts, i.e. the largest strings in the process. `truncate` caps
# each string, but nothing caps the count, so the tail is capped here. The head
# of a long conversation is the least interesting part of a model request.
_MESSAGE_LIMIT = 20


def _render_messages(messages: Any, capture_content: bool) -> "tuple[list[dict] | None, int]":
    """(rendered tail, number of older messages omitted)."""
    if not messages:
        return None, 0
    messages = list(messages)
    omitted = max(len(messages) - _MESSAGE_LIMIT, 0)
    return [
        {
            "kind": getattr(message, "kind", None),
            "parts": [_render_part(p, capture_content) for p in getattr(message, "parts", ()) or ()],
        }
        for message in messages[omitted:]
    ], omitted


def _render_tools(params: Any, capture_content: bool) -> list[dict] | None:
    tools: list[dict] = []
    for group in ("function_tools", "output_tools", "native_tools"):
        for tool in getattr(params, group, None) or ():
            entry: dict[str, Any] = {
                "name": getattr(tool, "name", None) or type(tool).__name__,
                "kind": group,
            }
            if capture_content:
                description = getattr(tool, "description", None)
                if description:
                    entry["description"] = description
            tools.append(entry)
    return tools or None


# `RunUsage` renamed `request_tokens`/`response_tokens` to
# `input_tokens`/`output_tokens` in 2.0. Reading the new names only is correct
# for the declared floor, and the anti-drift test asserts they still exist.
_USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "requests",
    "tool_calls",
)


def _usage_dict(usage: Any) -> dict | None:
    """The normalized `usage` blob. Both `event_summary.rs` and
    `sessionSummary.ts` fall back to it when the top-level ints are absent."""
    if usage is None:
        return None
    out = {}
    for key in _USAGE_KEYS:
        value = getattr(usage, key, None)
        if isinstance(value, int) and not isinstance(value, bool) and value:
            out[key] = value
    return out or None


def _token(usage: Any, key: str) -> int | None:
    value = getattr(usage, key, None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _tool_output(result: Any) -> Any:
    """What the tool actually produced, unwrapped and JSON-shaped.

    Two lossy renderings happen without this, and `tool_result.output` is the
    single most-read field in a tool loop:

    * A tool may return `ToolReturn`, an **envelope** — `return_value` is what
      goes back to the model, `content` is an extra user-prompt part and
      `metadata` is deliberately never shown to the model at all. The envelope
      has no JSON shape, so it rendered as
      `ToolReturn(return_value={'answer': 42}, content=…, metadata=…)`: the
      answer buried inside a repr, next to a field the model never saw.
    * A tool returning a Pydantic model or a dataclass — the documented way to
      return structured data — rendered as `Weather(city='Faro', celsius=21)`
      rather than `{"city": "Faro", "celsius": 21}`, so nothing downstream can
      read a field out of it.

    `_core.truncate` reprs an object with "no JSON shape", which is the right
    default for an arbitrary object and wrong for these: they have one, and this
    module is the only place that knows it. It is unwrapped with the object's
    own `model_dump` / `dataclasses.asdict` rather than `pydantic_core`, because
    this package declares no runtime dependencies and `tests/test_zero_dependencies.py`
    reads the AST — a guarded import would still be an import. Anything else is
    handed through untouched, and every failure falls back to the original value,
    which `truncate` then reprs exactly as it does today.
    """
    value = getattr(result, "return_value", result) if _is_tool_return(result) else result
    if value is None or isinstance(value, (str, bytes, bool, int, float, list, tuple, dict)):
        return value
    if _is_base_model(value):
        for mode in ("json", None):
            try:
                return value.model_dump(mode=mode) if mode else value.model_dump()
            except Exception:
                continue
        return value
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        try:
            return dataclasses.asdict(value)
        except Exception:
            return value
    return value


def _is_tool_return(value: Any) -> bool:
    return getattr(value, "kind", None) == "tool-return" and hasattr(value, "return_value")


def _is_base_model(value: Any) -> bool:
    """Duck-typed: `model_dump` alone also matches a TypedDict helper or a mock."""
    return hasattr(value, "model_dump") and hasattr(value, "model_fields_set")


# ---------------------------------------------------------------------------
# Per-hook state
# ---------------------------------------------------------------------------

class _RunState:
    __slots__ = ("key", "scope", "spans", "closed")

    def __init__(self, key: Any) -> None:
        self.key = key
        self.scope: Any = None
        # Leaf spans this run has opened and not yet closed, newest last. This
        # exists because a leaf can outlive its own run — see `_close_spans`.
        self.spans: dict[int, "_SpanState"] = {}
        self.closed = False


class _SpanState:
    __slots__ = ("key", "kind", "correlation_id", "started", "extra", "managed")

    def __init__(
        self, key: Any, kind: str, correlation_id: str, extra: dict | None = None
    ) -> None:
        self.key = key
        self.kind = kind
        self.correlation_id = correlation_id
        # perf_counter, not wall clock: a clock adjustment mid-run would
        # otherwise produce a negative duration.
        self.started = time.perf_counter()
        self.extra = extra or {}
        # True once this span is registered against a live run, i.e. once the
        # run's teardown is able to close it instead of us.
        self.managed = False

    def elapsed_ms(self) -> int:
        return ms(time.perf_counter() - self.started)


# Runs whose `wrap_run` frame is still open, keyed by `_run_key`. The adapter is
# otherwise stateless — this table exists for one reason, and it is the whole of
# `_close_spans` below: a leaf can outlive the run that opened it.
_open_runs: "dict[Any, _RunState]" = {}
_runs_lock = threading.Lock()

# Bounded for the same reason `RunTracker` is: a `wrap_run` coroutine that is
# garbage-collected before it resumes runs neither of its end branches, and an
# unbounded table of those is a leak in a long-lived server. FIFO — dicts keep
# insertion order.
_MAX_OPEN_RUNS = 10_000


def _register_run(state: _RunState) -> None:
    with _runs_lock:
        while len(_open_runs) >= _MAX_OPEN_RUNS:
            _open_runs.pop(next(iter(_open_runs)), None)
        _open_runs[state.key] = state


def _claim_run(state: _RunState) -> bool:
    """True for the first caller to close this run; False for every later one.

    Two things close a run — `wrap_run`'s own end, and `uninstall()` tearing
    down mid-flight — and both must be able to go first. Without this, an
    `uninstrument()` called while a run is in flight emitted `agent_end`
    (`cancelled`) and the run then emitted a second `agent_end` (`success`)
    against a span the dashboard had already closed.
    """
    with _runs_lock:
        _open_runs.pop(state.key, None)
        if state.closed:
            return False
        state.closed = True
        return True


def _register_span(span: _SpanState) -> None:
    with _runs_lock:
        run = _open_runs.get(span.key)
        if run is not None:
            run.spans[id(span)] = span
            span.managed = True


def _claim_span(span: _SpanState) -> bool:
    """True if this caller owns the span's closing event.

    False only when the run's teardown already emitted it. A span that was never
    registered against a run (its `wrap_run` never opened one) is unmanaged and
    always closes itself, so an adapter half-failure loses no leaf.
    """
    if not span.managed:
        return True
    with _runs_lock:
        run = _open_runs.get(span.key)
        if run is None:
            return False
        return run.spans.pop(id(span), None) is not None


def _close_spans(state: _RunState, exc: "BaseException | None") -> None:
    """Close every leaf this run opened and did not close, newest first.

    A leaf can outlive its own run, and on the cancellation path it reliably
    does. `asyncio.wait_for` cancels the caller's task; the graph is awaiting
    a `gather` of tool tasks, so the run body unwinds as soon as that future
    is cancelled while each tool task's own `CancelledError` is delivered on
    a later loop iteration. `wrap_run` therefore returns *before*
    `wrap_tool_execute` does, and the same is true of `wrap_model_request`
    when the cancellation lands inside the provider call. Measured against
    pydantic-ai 2.32: a `wait_for` timeout produced `agent_end` at
    `.565709` and the matching `tool_result` at `.566689`, and a timeout
    during a model request put `model_response` after `agent_end` too — the
    one thing every other emit in this file is careful never to do, because
    the dashboard closes the agent span at `agent_end` and anything after it
    is attributed to nothing. Worse, the ambient identity the late leaf
    resolves through is unbound by then in some interleavings, and the event
    is dropped outright: a `tool_use` with no `tool_result` at all.

    So the run closes them, `_claim_span` stops the real handler emitting a
    duplicate when it finally unwinds, and `fw_incomplete` says the leaf did
    not report its own outcome.
    """
    with _runs_lock:
        pending = list(state.spans.values())
        state.spans.clear()
    if not pending:
        return
    # A cancellation is not a failure, exactly as on `agent_end`.
    error = None if exc is None or _is_control_flow(exc) else _describe(exc)
    for span in reversed(pending):
        if span.kind == "tool":
            _tracker.emit(
                "tool_result",
                None,
                parent_key=span.key,
                tool_name=span.extra.get("tool_name"),
                tool_call_id=span.correlation_id,
                error=error,
                **fw_fields(incomplete=True),
            )
        else:
            _tracker.emit(
                "model_response",
                None,
                parent_key=span.key,
                model=span.extra.get("model"),
                role="assistant",
                request_id=span.correlation_id,
                error=error,
                duration_ms=span.elapsed_ms(),
                **fw_fields(incomplete=True, streaming=span.extra.get("streaming")),
            )


def _close_open_runs() -> None:
    """Close every run this adapter still has open, newest first.

    Teardown, not a hot path: `uninstall()` is the only caller. Each run's
    leaves close before its `agent_end`, and `_claim_run` makes the run's own
    `wrap_run` frame a no-op when it eventually unwinds.
    """
    with _runs_lock:
        states = list(_open_runs.values())
    for state in reversed(states):
        _core.call_safely(_close_run, (state,), {}, f"{__name__}.uninstall")


def _close_run(state: _RunState) -> None:
    if not _claim_run(state):
        return
    _close_spans(state, None)
    _tracker.end_agent(state.key, outcome="cancelled")


# ---------------------------------------------------------------------------
# The capability
# ---------------------------------------------------------------------------

class FailproofAI(AbstractCapability):
    """Record a Pydantic AI agent run into Failproof AI.

        from failproofai_sdk.integrations.pydantic_ai import FailproofAI
        agent = Agent("openai:gpt-5.6-sol", capabilities=[FailproofAI()])

    or, for every agent constructed from now on::

        failproofai_sdk.instrument("pydantic_ai")

    Event mapping:

    | Pydantic AI          | Failproof AI                                |
    |----------------------|-------------------------------------------|
    | `wrap_run`           | `agent_start` / `agent_end` (+ `error`)   |
    | `wrap_model_request` | `model_request` / `model_response`        |
    | `wrap_tool_execute`  | `tool_use` / `tool_result`                |
    | graph nodes          | nothing — see the module docstring        |

    `session_id` is the run's `conversation_id` (a conversation spanning several
    runs is one Failproof AI session, which is the point), unless a hand-written
    `failproofai_sdk.session(...)` / `failproofai_sdk.agent(...)` is already open — that always
    wins, so mixing the manual API with this adapter produces one tree, not two.
    """

    def __init__(
        self,
        *,
        capture_content: bool = True,
        session_id: str | None = None,
        id: str | None = None,
    ) -> None:
        # `AbstractCapability` is a `@dataclass(init=False)`, so it contributes
        # class-level defaults (`id`, `defer_loading`, …) and no `__init__` to
        # chain to; assigning the ones we care about is the supported pattern.
        self.capture_content = capture_content
        self.session_id = session_id
        self.id = id

    def get_ordering(self) -> CapabilityOrdering:
        """Outermost, so our spans bracket every other capability's work.

        The built-in `Instrumentation` declares the same tier; ties break on the
        user's list order, which is fine — we are not exchanging state with it.
        """
        return CapabilityOrdering(position="outermost")

    # -- run --------------------------------------------------------------

    async def wrap_run(self, ctx, *, handler):
        if not _enabled:
            return await handler()
        state = self._begin_run(ctx)
        try:
            result = await handler()
        except BaseException as exc:
            # Note the structure: the framework's call sits in exactly one
            # `try`, whose only job is to re-raise. Everything of ours is
            # outside it and inside `safe()`, so nothing we do can change what
            # the run returns or raises.
            self._end_run(state, None, exc)
            raise
        self._end_run(state, result, None)
        return result

    @safe
    def _begin_run(self, ctx) -> _RunState:
        key = _run_key(ctx)
        ambient = failproofai_sdk.current()
        # An already-bound session wins. Handing `start_agent` an explicit
        # session_id would otherwise split a hand-written outer scope's run into
        # a second session.
        session_id = self.session_id or (
            None if ambient.session_id else (getattr(ctx, "conversation_id", None) or getattr(ctx, "run_id", None))
        )
        identity = _tracker.start_agent(
            key,
            agent_id=_agent_name(ctx),
            session_id=session_id,
            goal=_text(getattr(ctx, "prompt", None)) if self.capture_content else None,
            **fw_fields(
                run_id=getattr(ctx, "run_id", None),
                conversation_id=getattr(ctx, "conversation_id", None),
                model=_model_name(getattr(ctx, "model", None)),
                metadata=getattr(ctx, "metadata", None),
            ),
        )
        state = _RunState(key)
        _register_run(state)
        try:
            scope = failproofai_sdk.session(identity.session_id, agent_id=identity.agent_id)
            scope.__enter__()
            state.scope = scope
        except Exception:  # pragma: no cover - two contextvar sets cannot fail
            # Deliberately not re-raised: the agent is already open, and the
            # state we return is what closes it. A lost contextvar binding costs
            # nesting for a nested run; a lost `agent_end` costs a session that
            # renders `ongoing` forever.
            logger.debug("failproofai_sdk: could not bind pydantic-ai run identity", exc_info=True)
        return state

    @safe
    def _end_run(self, state: "_RunState | None", result: Any, exc: "BaseException | None") -> None:
        if state is None:
            return
        if not _claim_run(state):
            # `uninstall()` tore this run down already and emitted its agent_end.
            # A second one would close a span the dashboard has already closed.
            if state.scope is not None:
                state.scope.__exit__(None, None, None)
                state.scope = None
            return
        try:
            # Strictly before agent_end, for the same reason the `error` event
            # below is: the dashboard closes the agent span at agent_end.
            _core.call_safely(_close_spans, (state, exc), {}, f"{__name__}.close_spans")
            usage = _usage_dict(getattr(result, "usage", None)) if result is not None else None
            if exc is None:
                outcome = "success"
                summary = _text(getattr(result, "output", None)) if self.capture_content else None
            elif _is_control_flow(exc):
                # A cancellation is not an error: it must not pollute the Errors
                # surface, so no `error` event and `outcome="cancelled"`.
                outcome, summary = "cancelled", None
            else:
                outcome, summary = "failed", None
                # Strictly BEFORE agent_end — the dashboard closes the agent span
                # at agent_end and anything after it is attributed to nothing.
                # This is the one place a standalone `error` event is right: the
                # failure escaped the run, so no leaf span owns it. A tool or
                # model failure that the loop recovered from is reported only on
                # its own span and never reaches here.
                _tracker.emit(
                    "error",
                    state.key,
                    error_type=type(exc).__name__,
                    message=str(exc),
                    traceback=_format_traceback(exc),
                )
            # "failed", never "failure": the server counts only
            # error|failed|timeout|rejected as a failure.
            _tracker.end_agent(state.key, outcome=outcome, summary=summary, usage=usage)
        finally:
            if state.scope is not None:
                state.scope.__exit__(None, None, None)
                state.scope = None

    # -- model ------------------------------------------------------------

    async def wrap_model_request(self, ctx, *, request_context, handler):
        if not _enabled:
            return await handler(request_context)
        state = self._begin_model(ctx, request_context)
        try:
            response = await handler(request_context)
        except BaseException as exc:
            self._end_model(ctx, state, None, exc)
            raise
        self._end_model(ctx, state, response, None)
        return response

    @safe
    def _begin_model(self, ctx, request_context) -> _SpanState:
        # `request_id` is generated here and carried onto the response. The
        # dashboard pairs model events FIFO per agent_id when it is absent, which
        # mis-pairs the moment two model calls overlap.
        state = _SpanState(_run_key(ctx), "model", uuid.uuid4().hex)
        model = getattr(request_context, "model", None)
        state.extra["model"] = _model_name(model)
        # Carried onto the response because that is the event `duration_ms`
        # rides on — see the note there.
        state.extra["streaming"] = getattr(request_context, "streaming", None)
        _register_span(state)
        messages, omitted = _render_messages(
            getattr(request_context, "messages", None), self.capture_content
        )
        _tracker.emit(
            "model_request",
            None,
            parent_key=state.key,
            model=state.extra["model"],
            system=getattr(model, "system", None),
            messages=messages,
            tools=_render_tools(
                getattr(request_context, "model_request_parameters", None), self.capture_content
            ),
            request_id=state.correlation_id,
            **fw_fields(
                run_step=getattr(ctx, "run_step", None),
                streaming=getattr(request_context, "streaming", None),
                model_id=getattr(request_context, "model_id", None),
                messages_omitted=omitted or None,
            ),
        )
        return state

    @safe
    def _end_model(self, ctx, state: "_SpanState | None", response: Any, exc: "BaseException | None") -> None:
        if state is None or not _claim_span(state):
            return
        usage = getattr(response, "usage", None) if response is not None else None
        error = None
        if exc is not None and not _is_control_flow(exc):
            error = _describe(exc)
        _tracker.emit(
            "model_response",
            None,
            parent_key=state.key,
            model=_model_name(response) or state.extra.get("model"),
            stop_reason=getattr(response, "finish_reason", None),
            input_tokens=_token(usage, "input_tokens"),
            output_tokens=_token(usage, "output_tokens"),
            content=(
                [_render_part(p, True) for p in getattr(response, "parts", ()) or ()]
                if response is not None and self.capture_content
                else None
            ),
            role="assistant",
            request_id=state.correlation_id,
            error=error,
            # Always an int, always present. `duration_ms` is not guarded on
            # model_response and the dashboard prefers the closing event's value
            # over end-start, which is what keeps model durations honest even
            # when FIFO pairing brackets the wrong pair. A float would silently
            # NULL the column.
            #
            # On a STREAMED request this number is the whole `async with
            # agent.run_stream(...)` block, consumer included, and not the model
            # call: Pydantic AI hands `wrap_model_request`'s handler its
            # `ModelResponse` only once the caller leaves that block, and
            # `after_model_request` fires later still (measured: 818.7ms vs
            # 317.6ms for the drain). There is no earlier hook — `stream_text`
            # is the caller's own loop and `wrap_run_event_stream` cannot be
            # overridden here without switching `agent.run()` into streaming
            # mode. Measured against the gateway, 1.5s of `asyncio.sleep` in the
            # consumer moved a 3294ms response to 4677ms. So the number cannot
            # be made honest, only made *identifiable*: `fw_streaming` rides on
            # the response as well as the request, so a latency percentile can
            # exclude the rows where it is true rather than quietly averaging
            # somebody's UI render time into the model's p95.
            duration_ms=state.elapsed_ms(),
            usage=_usage_dict(usage),
            **fw_fields(
                provider=getattr(response, "provider_name", None),
                provider_response_id=getattr(response, "provider_response_id", None),
                run_step=getattr(ctx, "run_step", None),
                streaming=state.extra.get("streaming"),
            ),
        )

    # -- tools ------------------------------------------------------------

    async def wrap_tool_execute(self, ctx, *, call, tool_def, args, handler):
        if not _enabled:
            return await handler(args)
        state = self._begin_tool(ctx, call, tool_def, args)
        try:
            result = await handler(args)
        except BaseException as exc:
            self._end_tool(state, None, exc)
            raise
        self._end_tool(state, result, None)
        return result

    @safe
    def _begin_tool(self, ctx, call, tool_def, args) -> _SpanState:
        # The framework's own id, verbatim: it is what appears in the provider's
        # logs, and inventing a synthetic one would destroy that correspondence.
        # `duration_ms` on tool_result is auto-computed by the SDK from this key,
        # so tool_use and tool_result must agree on it exactly.
        tool_call_id = getattr(call, "tool_call_id", None) or uuid.uuid4().hex
        tool_name = getattr(call, "tool_name", None) or getattr(tool_def, "name", None) or "tool"
        state = _SpanState(_run_key(ctx), "tool", tool_call_id, {"tool_name": tool_name})
        _register_span(state)
        _tracker.emit(
            "tool_use",
            None,
            parent_key=state.key,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            input=args if self.capture_content and isinstance(args, dict) else None,
            **fw_fields(
                tool_kind=getattr(tool_def, "kind", None),
                run_step=getattr(ctx, "run_step", None),
            ),
        )
        return state

    @safe
    def _end_tool(self, state: "_SpanState | None", result: Any, exc: "BaseException | None") -> None:
        if state is None or not _claim_span(state):
            return
        error = None
        if exc is not None and not _is_control_flow(exc):
            error = _describe(exc)
        # No `error` event here, ever. A tool failure the agent loop catches is
        # not a run-level error, and one that escapes is reported exactly once,
        # by `_end_run`.
        _tracker.emit(
            "tool_result",
            None,
            parent_key=state.key,
            tool_name=state.extra.get("tool_name"),
            tool_call_id=state.correlation_id,
            output=_tool_output(result) if self.capture_content else None,
            error=error,
        )


# ---------------------------------------------------------------------------
# install / uninstall
# ---------------------------------------------------------------------------

def _inject(kwargs: dict) -> None:
    capability = _capability
    if capability is None:
        return
    existing = kwargs.get("capabilities")
    items = list(existing) if existing else []
    if any(isinstance(item, FailproofAI) for item in items):
        # Somebody passed `capabilities=[FailproofAI()]` explicitly. Theirs wins;
        # two of us would double every event.
        return
    items.append(capability)
    kwargs["capabilities"] = items


def _wrap_init(original):
    """`Agent.__init__` with our capability appended to `capabilities=`.

    Not `_core.wrap_callable`: that shape deliberately cannot touch the wrapped
    callable's arguments (its whole guarantee is that the user's call is
    untouched), and injecting a capability is precisely an argument mutation.
    The `Patcher` still owns the save/restore and the "somebody patched on top
    of us" check, so the install discipline is unchanged.
    """

    def _failproofai_agent_init(self, *args, **kwargs):
        _core.call_safely(_inject, (kwargs,), {}, f"{__name__}.Agent.__init__")
        return original(self, *args, **kwargs)

    _failproofai_agent_init.__name__ = getattr(original, "__name__", "__init__")
    _failproofai_agent_init.__qualname__ = getattr(original, "__qualname__", "Agent.__init__")
    _failproofai_agent_init.__doc__ = getattr(original, "__doc__", None)
    return _failproofai_agent_init


class _Adapter:
    name = NAME
    module = MODULE

    def install(self, **options: Any) -> None:
        """Append `FailproofAI()` to every `Agent` constructed from now on.

        Unknown options are ignored rather than rejected: `failproofai_sdk.instrument()`
        with no framework name fans the same `**options` out to every detected
        adapter, so a keyword meant for LangChain must not take this one down.
        """
        global _enabled, _capability

        _compat.check_version(
            NAME, DIST, minimum=MIN_VERSION, below=BELOW_VERSION, reason=_VERSION_REASON
        )

        from pydantic_ai import Agent

        _capability = FailproofAI(
            capture_content=bool(options.get("capture_content", True)),
            session_id=options.get("session_id"),
        )
        _patcher.patch(Agent, "__init__", _wrap_init(Agent.__init__))
        _enabled = True

    def uninstall(self) -> None:
        global _enabled, _capability

        _enabled = False
        _capability = None
        _patcher.restore_all()
        # Close every agent still open, so a session torn down mid-run does not
        # render `ongoing` forever. Runs this adapter opened go through
        # `_close_run` — leaves first, and `_claim_run` so the run's own
        # `wrap_run` frame does not emit a second `agent_end` when it finally
        # unwinds. `close_open_agents()` stays as the backstop for a key that
        # reached the tracker without reaching `_open_runs`.
        _close_open_runs()
        _tracker.close_open_agents()
        _tracker.reset()


adapter = _Adapter()
install = adapter.install
uninstall = adapter.uninstall
