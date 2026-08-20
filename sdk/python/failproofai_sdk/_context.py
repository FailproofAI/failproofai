"""Ambient run identity, carried on contextvars.

Before this module the SDK had no ambient session: every `event.*` call took
`session_id` and `agent_id` as required keyword arguments and nothing propagated
them. Threading both through every function that might emit an event is what makes
instrumentation sprawl into a diff nobody wants to review.

Two contextvars carry it instead. Read them through `current()`, or let
`failproofai_sdk._events` fall back to them when a caller omits the identity.

Why a tuple and not a list
--------------------------
`_AGENT_STACK` holds a **tuple**. A `ContextVar[list]` is shared *by reference*
across tasks and threads, so `.append()` in one task mutates the value every other
task sees — which is exactly the cross-run event mixing contextvars are here to
prevent, wearing a contextvars costume. It passes every single-threaded test.
Push is `set(stack + (aid,))`; pop is `reset(token)`.

There is deliberately no `_AGENT_ID` var: the top of the stack *is* the current
agent id, so the two cannot drift apart, and `parent_id` is `stack[-2]`.
"""

import contextvars
import functools
import logging
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

# The agent_id used when events are emitted with a session bound but no agent
# scope. "main" is the convention the skill and the reference integration already
# teach, so an un-scoped event lands somewhere sensible rather than raising.
DEFAULT_AGENT_ID = "main"

_SESSION_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "failproofai_sdk_session_id", default=None
)
_AGENT_STACK: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "failproofai_sdk_agent_stack", default=()
)


@dataclass(frozen=True, slots=True)
class Identity:
    """The run identity in scope. Never None — check `session_id is None` instead."""

    session_id: str | None
    agent_id: str | None
    parent_id: str | None
    depth: int


def current() -> Identity:
    """The identity bound to the current context.

    `failproofai_sdk.current().session_id is None` means nothing is bound — either no
    scope was entered, or this is a fresh thread that did not inherit one (see
    `propagate`).
    """
    stack = _AGENT_STACK.get()
    return Identity(
        session_id=_SESSION_ID.get(),
        agent_id=stack[-1] if stack else None,
        parent_id=stack[-2] if len(stack) >= 2 else None,
        depth=len(stack),
    )


def session_id() -> str | None:
    """The bound session id, or None. Hot path — allocates no Identity."""
    return _SESSION_ID.get()


def agent_id() -> str:
    """The current agent id, falling back to DEFAULT_AGENT_ID."""
    stack = _AGENT_STACK.get()
    return stack[-1] if stack else DEFAULT_AGENT_ID


def parent_agent_id() -> str | None:
    """The enclosing agent id, or None at depth 0 or 1."""
    stack = _AGENT_STACK.get()
    return stack[-2] if len(stack) >= 2 else None


def bind_session(sid: str) -> contextvars.Token:
    return _SESSION_ID.set(sid)


def push_agent(aid: str) -> contextvars.Token:
    return _AGENT_STACK.set(_AGENT_STACK.get() + (aid,))


def reset(token: contextvars.Token | None) -> None:
    """Restore a contextvar to its pre-`set` value, tolerating a cross-context token.

    `ContextVar.reset()` raises `ValueError: Token was created in a different
    Context` when the token was minted in another thread *or another asyncio task*.
    That happens when a scope is entered in one task and exited in another, which is
    the caller's bug — but an observability library's correct response is a debug
    line, not an exception raised on top of whatever they were already doing.
    """
    if token is None:
        return
    try:
        token.var.reset(token)
    except ValueError:
        logger.debug(
            "failproofai_sdk: context token reset across contexts; identity left as-is",
            exc_info=True,
        )


Snapshot = tuple[str | None, tuple[str, ...]]


def snapshot() -> Snapshot:
    """Capture the identity *values* currently bound."""
    return (_SESSION_ID.get(), _AGENT_STACK.get())


def restore(snap: Snapshot) -> tuple[contextvars.Token, contextvars.Token]:
    """Bind a snapshot into the calling context."""
    sid, stack = snap
    return (_SESSION_ID.set(sid), _AGENT_STACK.set(stack))


def discard(tokens: tuple[contextvars.Token, contextvars.Token] | None) -> None:
    if tokens is None:
        return
    for token in reversed(tokens):
        reset(token)


def propagate(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap `fn` so it runs with the identity bound *right now*.

        pool.submit(failproofai_sdk.propagate(work), x)
        pool.map(failproofai_sdk.propagate(work), items)
        threading.Thread(target=failproofai_sdk.propagate(work)).start()
        loop.run_in_executor(None, failproofai_sdk.propagate(work), x)

    contextvars propagate into asyncio tasks automatically but **not into new
    threads** — a thread starts with an empty context, so without this every event
    a worker emits is dropped (or, since this change, raises TypeError).

    This deliberately snapshots *values* rather than doing
    `functools.partial(contextvars.copy_context().run, fn)`. A `Context` object
    cannot be entered by two threads at once (`RuntimeError: cannot enter context:
    ... is already entered`), so the copy_context form crashes the caller's worker
    on any reuse — `pool.map`, a retried submit. Mutations made inside `ctx.run`
    also persist in that Context, so a reused one leaks the previous call's agent
    stack into the next.
    """
    snap = snapshot()

    @functools.wraps(fn)
    def _failproofai_propagated(*args: Any, **kwargs: Any) -> Any:
        tokens = restore(snap)
        try:
            return fn(*args, **kwargs)
        finally:
            discard(tokens)

    return _failproofai_propagated
