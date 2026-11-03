"""Context-manager scopes: `session()`, `agent()`, `tool_call()`.

These are the ergonomic surface over `failproofai_sdk.event.*`. Each one binds run
identity onto the contextvars in `failproofai_sdk._context` so that everything emitted
inside the block — including code that has never heard of the SDK's identity
arguments — lands on the right session and agent.

Why classes and not `@contextlib.contextmanager`
------------------------------------------------
A `@contextmanager` generator supports `with` only. An agent framework is
half-async, so the same scope has to work under `async with` too, and
`@asynccontextmanager` would mean a second, separately-maintained copy of the
body. These are plain classes with `__enter__`/`__exit__` **and**
`__aenter__`/`__aexit__`, where the async pair delegates to the sync pair. No
scope awaits anything — `writer.submit()` is a `deque.append` — so the delegation
is not a lie, and `async with` provably produces byte-identical events.

The namespace is reached as `_runtime.event` (attribute lookup at call time, not
a `from ... import event` binding) both to avoid importing `failproofai_sdk` from inside
`failproofai_sdk` and so tests can swap in a recording namespace.
"""

import contextvars
import sys
import traceback as _traceback
import uuid
from typing import Any, Literal

from failproofai_sdk import _context
from failproofai_sdk import _runtime


class _Auto:
    """Sentinel for `agent(parent_id=...)`.

    `parent_id` has three states and `None` is a meaningful one of them, so the
    default cannot be `None`:

    * `AUTO`   — infer the enclosing agent from the context stack (the default);
    * `None`   — force a root span, emitting no `parent_id` at all;
    * `"str"`  — use this id verbatim.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "AUTO"


AUTO = _Auto()


def _is_cancellation(exc_type: type) -> bool:
    """True for `asyncio.CancelledError` / `GeneratorExit`.

    A cancellation is not a failure: it must not emit an `error` event, or every
    cancelled run pollutes the Errors surface. `asyncio` is looked up through
    `sys.modules` rather than imported, so `import failproofai_sdk` stays cheap — if
    `asyncio` was never imported, nothing in the process can have raised its
    `CancelledError`.
    """
    if issubclass(exc_type, GeneratorExit):
        return True
    asyncio = sys.modules.get("asyncio")
    return asyncio is not None and issubclass(exc_type, asyncio.CancelledError)


def _describe(exc_type: type, exc: BaseException | None) -> str:
    text = str(exc) if exc is not None else ""
    return f"{exc_type.__name__}: {text}" if text else exc_type.__name__


class session:
    """Bind a session id (and optionally an agent id) for the enclosing block.

        with failproofai_sdk.session() as sid:
            failproofai_sdk.event.agent_start(agent_id="main", goal="...")

    Emits **no events** — it is identity only. `agent()` is what brackets a run
    with `agent_start`/`agent_end`.

    `session_id=None` reuses an already-bound session if there is one, and
    otherwise generates `uuid4().hex`. That inheritance is what lets a nested
    scope stay inside one run instead of splitting it into two sessions.
    """

    __slots__ = (
        "_requested",
        "_agent_id",
        "id",
        "_sid_token",
        "_agent_token",
        "_entry_session_id",
    )

    def __init__(self, session_id: str | None = None, *, agent_id: str | None = None) -> None:
        self._requested = session_id
        self._agent_id = agent_id
        self.id: str | None = None
        self._sid_token: "contextvars.Token | None" = None
        self._agent_token: "contextvars.Token | None" = None
        self._entry_session_id: str | None = None

    def _enter(self) -> str:
        sid = self._requested or _context.session_id() or uuid.uuid4().hex
        self.id = sid
        self._entry_session_id = _context.session_id()
        self._sid_token = _context.bind_session(sid)
        if self._agent_id is not None:
            self._agent_token = _context.push_agent(self._agent_id)
        return sid

    def _exit(self) -> None:
        # Unwind in reverse, and unconditionally: a scope that leaks an agent
        # frame misattributes every later event in the process. Repair by value
        # when the token is foreign — see `agent._unwind` for why that happens
        # to ordinary code.
        if not _context.reset(self._agent_token) and self._agent_id is not None:
            _context.discard_agent(self._agent_id)
        if not _context.reset(self._sid_token):
            _context.restore_session(self._entry_session_id)
        self._agent_token = None
        self._sid_token = None

    def __enter__(self) -> str:
        return self._enter()

    # `Literal[False]`, not `bool`: a `__exit__` typed `bool` tells every caller's
    # type checker this scope MIGHT swallow the exception. It never does.
    def __exit__(self, exc_type, exc, tb) -> Literal[False]:
        self._exit()
        return False

    async def __aenter__(self) -> str:
        return self._enter()

    async def __aexit__(self, exc_type, exc, tb) -> Literal[False]:
        self._exit()
        return False


class agent:
    """Bracket a run (or a sub-run) with `agent_start` / `agent_end`.

        with failproofai_sdk.agent("planner", goal=question):
            ...

    `agent_id` is positional on purpose. It is the one argument integrators type
    on every single call site, and the rest of the SDK's keyword-only discipline
    exists to stop *identity* arguments being passed by accident — which is not a
    risk here.

    Keep `agent_id` low-cardinality (a node/role name, never a UUID): it is a
    `LowCardinality(String)` column and the primary facet across every session.

    `**fields` are attached to `agent_start` only; `agent_end` carries `outcome`
    and `summary`.

    Exit semantics, which are the whole point of the class:

    | exception                       | events            | outcome     |
    |---------------------------------|-------------------|-------------|
    | none                            | `agent_end`       | `outcome=`  |
    | `Exception`                     | `error`, then end | `"failed"`  |
    | `KeyboardInterrupt`/`SystemExit`| `error`, then end | `"failed"`  |
    | `CancelledError`/`GeneratorExit`| `agent_end` only  | `"cancelled"`|

    `error` strictly *before* `agent_end`, because the dashboard closes the agent
    span at `agent_end` and anything after it is attributed to nothing. The
    literal is `"failed"`, never `"failure"` — only `error|failed|timeout|rejected`
    count as a failure server-side. The exception is always re-raised.

    **Do not span a `yield` in an async generator with this.** Async generators
    have no context of their own, so the identity binds in the CONSUMER's
    context — and when the consumer stops early (`break` out of `async for`)
    asyncio finalizes the generator from a separate task, so `__aexit__` runs
    somewhere the binding is unreachable. `agent_end` is still emitted correctly,
    but the consumer keeps a frame for a span that has already closed, and the
    library cannot remove it from there: `ContextVar.set` in the finalizer's task
    does not reach the context the value lives in. `_context.reset` warns once
    when it happens. Pass `session_id=`/`agent_id=` explicitly on the events
    inside a streaming generator instead of wrapping the `yield` in a scope.
    """

    __slots__ = (
        "agent_id",
        "_requested_sid",
        "_goal",
        "_parent_id",
        "_outcome",
        "_summary",
        "_fields",
        "session_id",
        "_sid_token",
        "_agent_token",
        "_entry_session_id",
    )

    def __init__(
        self,
        agent_id: str = "main",
        *,
        session_id: str | None = None,
        goal: str | None = None,
        parent_id: "str | None | _Auto" = AUTO,
        outcome: str | None = "success",
        summary: str | None = None,
        **fields: Any,
    ) -> None:
        self.agent_id = agent_id
        self._requested_sid = session_id
        self._goal = goal
        self._parent_id = parent_id
        self._outcome = outcome
        self._summary = summary
        self._fields = fields
        self.session_id: str | None = None
        self._sid_token: "contextvars.Token | None" = None
        self._agent_token: "contextvars.Token | None" = None
        self._entry_session_id: str | None = None

    def _enter(self) -> _context.Identity:
        sid = self._requested_sid or _context.session_id() or uuid.uuid4().hex
        self.session_id = sid

        if isinstance(self._parent_id, _Auto):
            # Only inherit within the SAME session. An explicit `session_id=`
            # that differs from the ambient one is the documented way to start a
            # NEW run, and the enclosing agent does not exist in it — the span
            # tree is keyed by session, so the child rendered as a root with a
            # dangling parent, or got grafted onto whatever agent in its own
            # session happened to share the id. The ordinary long-lived-server
            # shape reached it directly:
            #
            #     with agent("server", session_id="boot"):
            #         for rid in requests:
            #             with agent("handler", session_id=rid):  # parent="server"
            #
            # A caller who genuinely wants a cross-session link can still pass
            # `parent_id=` explicitly.
            parent = _context.current().agent_id if sid == _context.session_id() else None
        else:
            parent = self._parent_id

        self._entry_session_id = _context.session_id()
        self._sid_token = _context.bind_session(sid)
        self._agent_token = _context.push_agent(self.agent_id)
        try:
            _runtime.event.agent_start(
                session_id=sid,
                agent_id=self.agent_id,
                goal=self._goal,
                parent_id=parent,
                **self._fields,
            )
        except BaseException:
            # A rejected agent_start (a reserved **field, say) must not leave a
            # half-entered scope behind: `__exit__` never runs if `__enter__`
            # raises.
            self._unwind()
            raise
        return _context.current()

    def _unwind(self) -> None:
        # `reset` tolerates a cross-context token, but tolerating it is not the
        # same as undoing it: the frame this scope pushed stays on the caller's
        # stack forever. An `agent()` scope inside an ASYNC GENERATOR reaches
        # that without anyone doing anything unusual — async generators have no
        # context of their own, so the binding lands in the CONSUMER's context,
        # and when the consumer stops early (`break` out of `async for`) asyncio
        # finalizes the generator from a SEPARATE task. `__aexit__` therefore
        # runs somewhere the token is foreign, the reset is swallowed with a
        # debug line, and the consumer is left holding a span that has already
        # closed: the next unrelated request is emitted as its child, in a
        # different session, and the stack grows by one on every repetition.
        #
        # So fall back to repairing the values directly. `reset` reports whether
        # it managed the token-based restore; when it did not, remove exactly
        # this scope's own frame and put the session back to what it was.
        if not _context.reset(self._agent_token):
            _context.discard_agent(self.agent_id)
        if not _context.reset(self._sid_token):
            _context.restore_session(self._entry_session_id)
        self._agent_token = None
        self._sid_token = None

    def _exit(self, exc_type, exc, tb) -> bool:
        try:
            if exc_type is None:
                outcome = self._outcome
            elif _is_cancellation(exc_type):
                outcome = "cancelled"
            else:
                outcome = "failed"
                _runtime.event.error(
                    session_id=self.session_id,
                    agent_id=self.agent_id,
                    error_type=exc_type.__name__,
                    message=str(exc) if exc is not None else "",
                    traceback="".join(_traceback.format_exception(exc_type, exc, tb)),
                )
            _runtime.event.agent_end(
                session_id=self.session_id,
                agent_id=self.agent_id,
                outcome=outcome,
                summary=self._summary,
            )
        finally:
            # In `finally` so the stack is intact even if emission itself blew
            # up. A leaked frame is worse than a lost event.
            self._unwind()
        return False

    def __enter__(self) -> _context.Identity:
        return self._enter()

    def __exit__(self, exc_type, exc, tb) -> bool:
        return self._exit(exc_type, exc, tb)

    async def __aenter__(self) -> _context.Identity:
        return self._enter()

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return self._exit(exc_type, exc, tb)


class ToolCall:
    """The handle `tool_call()` yields. Set `.output`; read `.id`."""

    __slots__ = ("_id", "output")

    def __init__(self, tool_call_id: str) -> None:
        self._id = tool_call_id
        self.output: Any = None

    @property
    def id(self) -> str:
        """The correlation id on both the `tool_use` and the `tool_result`."""
        return self._id

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ToolCall(id={self._id!r})"


class tool_call:
    """Bracket a tool invocation with `tool_use` / `tool_result`.

        with failproofai_sdk.tool_call("web_search", input={"q": q}) as t:
            t.output = search(q)

    `tool_call_id` defaults to `uuid4().hex`. Identity comes from the enclosing
    scope; if nothing is bound, the underlying `event.tool_use()` raises the
    usual `TypeError` naming the fix.

    On failure this emits `tool_result(error="TypeName: msg")` and **no `error`
    event**. A tool failure the agent loop catches is not a run-level error, and
    one that propagates is reported exactly once, by the enclosing `agent()`.
    Cancellation closes the leaf with no `error` string at all, for the same
    reason `agent()` does not mark it failed.
    """

    __slots__ = ("tool_name", "_requested_id", "_input", "_fields", "_box", "_sid", "_aid")

    def __init__(
        self,
        tool_name: str,
        *,
        tool_call_id: str | None = None,
        input: dict | None = None,
        **fields: Any,
    ) -> None:
        self.tool_name = tool_name
        self._requested_id = tool_call_id
        self._input = input
        self._fields = fields
        self._box: ToolCall | None = None
        self._sid: str | None = None
        self._aid: str | None = None

    def _enter(self) -> ToolCall:
        # Resolve once, at entry: a tool that pushes its own scope inside must
        # not make the closing tool_result land on a different agent_id.
        self._sid = _context.session_id()
        self._aid = _context.agent_id()
        box = ToolCall(self._requested_id or uuid.uuid4().hex)
        self._box = box
        _runtime.event.tool_use(
            session_id=self._sid,
            agent_id=self._aid,
            tool_name=self.tool_name,
            tool_call_id=box.id,
            input=self._input,
            **self._fields,
        )
        return box

    def _exit(self, exc_type, exc, tb) -> bool:
        assert self._box is not None
        error = None
        if exc_type is not None and not _is_cancellation(exc_type):
            error = _describe(exc_type, exc)
        _runtime.event.tool_result(
            session_id=self._sid,
            agent_id=self._aid,
            tool_name=self.tool_name,
            tool_call_id=self._box.id,
            output=self._box.output,
            error=error,
        )
        return False

    def __enter__(self) -> ToolCall:
        return self._enter()

    def __exit__(self, exc_type, exc, tb) -> bool:
        return self._exit(exc_type, exc, tb)

    async def __aenter__(self) -> ToolCall:
        return self._enter()

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return self._exit(exc_type, exc, tb)
