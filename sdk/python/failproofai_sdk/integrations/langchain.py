"""LangChain + LangGraph adapter.

Written against **langchain-core 1.5.2** and **langgraph 1.2.10** (2026-07-29),
and every claim below was read out of those installed packages rather than
recalled. Where this file disagrees with the LangChain docs or with another
vendor's integration, the disagreement is deliberate and the reason is in the
comment next to it.

How it attaches
---------------
`langchain_core.tracers.context.register_configure_hook` is public, documented,
and survived the 0.x -> 1.x rewrite. `CallbackManager.configure` injects the
handler into **every** callback manager it builds, so no call site changes::

    failproofai_sdk.instrument("langchain")
    graph.invoke(...)                 # already recorded

Four consequences of that hook shape drive the code:

* with the ``env_var`` form a **fresh handler is constructed per callback
  manager** — many times per run — so ``FailproofAITracer.__init__`` is zero-arg
  and cheap and **all** cross-callback state lives in the module-level
  ``_STATE``;
* ``inheritable=True`` is required or child runs never see it;
* there is **no deregister API** (``_configure_hooks`` is append-only and
  private), so ``uninstall()`` clears the ContextVar and unsets the env var;
* we do **not** patch ``BaseCallbackManager.__init__``. OpenInference and
  Traceloop do, and ``BaseCallbackManager.merge()`` builds a new manager with
  handlers already passed in, so their ``isinstance`` dedup misses and the
  handler is added twice. That is a real duplicate-event bug; MLflow patches
  ``merge`` as well to work around it. The configure hook has no such hole.

Why `BaseTracer`
----------------
`BaseTracer` assembles the run tree and hands over `Run` objects with inputs,
outputs, metadata and timings already collected — two override points instead of
twenty hand-correlated callbacks. `langchain_core.tracers.schemas.Run` *is*
`langsmith.RunTree`. We also subclass `langgraph.callbacks.GraphCallbackHandler`
(under try/except: it is new in langgraph 1.2) for first-class interrupt/resume.

`run_inline = True` is not optional. `AsyncCallbackManager` dispatches sync
handlers through `run_in_executor` unless a handler sets it, and that hop can
**reorder callbacks** — which scrambles timestamp order and breaks every pairing
in this file. `writer.submit()` is a `deque.append`, so inline on the event loop
is safe. `raise_error` is normally False: LangChain already firewalls handler
exceptions in `handle_event`, and so does `_core.safe`. It follows
`FAILPROOFAI_SDK_STRICT`, because that same firewall otherwise swallows the exception
`safe()` re-raises under strict and the escape hatch does nothing here.

The mapping
-----------
=========================== ==========================================
LangChain / LangGraph       Failproof AI
=========================== ==========================================
root run (no parent)        ``agent_start`` / ``agent_end``
LangGraph node              ``hook_triggered`` / ``hook_completed``
compiled subgraph           nested ``agent_start`` (``root/node``)
tool run                    ``tool_use`` / ``tool_result``
retriever run               ``tool_use`` / ``tool_result`` (summarised)
chat model / LLM run        ``model_request`` / ``model_response``
``interrupt()``             ``human_wait`` + ``agent_pause``
``Command(resume=...)``     ``agent_resume`` + ``human_input``
intermediate chains         *nothing* (see ``include_chains``)
=========================== ==========================================

**A LangGraph node is a hook, not a nested agent.** `agent_id` is a
`LowCardinality(String)` column and the primary facet on every dashboard
surface, and `agent_sessions.agent_id = any(...)` returns the first `agent_id`
by time — so promoting `retrieve`, `grade_documents` and `should_continue` to
agents would both drown the facet and label the session with a random node.
Hook spans render structurally identically, and `/hooks` becomes a per-node
latency page for free.

Corrections to received wisdom, both verified here
--------------------------------------------------
1. **`thread_id` IS available to callbacks** on this stack. langchain-core's
   `ensure_config` stopped promoting `configurable` into `metadata`, which is
   what every "thread_id is None" report is about — but langgraph 1.2 re-adds it
   in `langgraph._internal._config` via ``_PROPAGATE_TO_METADATA`` =
   {thread_id, checkpoint_id, checkpoint_ns, task_id, run_id, assistant_id,
   graph_id}. So `metadata["thread_id"]` is populated and is a good default
   session key. It is still only the *fourth* resolution step, because a
   `thread_id` is a conversation, not necessarily a run.
2. **`GraphCallbackHandler.on_interrupt` does NOT fire for a handler installed
   through `register_configure_hook`.** `Pregel.stream` builds the lifecycle
   manager with `get_sync_graph_callback_manager_for_config(config)`, which
   reads the **raw** ``config["callbacks"]`` — the configure hooks never touch
   it — and then gates the whole feature on
   ``has_graph_lifecycle_callbacks=bool(manager.handlers)``. So we wrap that
   factory (see `_install_graph_callbacks`) to attach the handler to the manager
   it returns. If the wrap does not apply, the exception-path fallback below
   still produces the full HITL pair; only the resume event needs the wrap, and
   that has its own fallback too.

Control flow is not failure
---------------------------
LangGraph's runnable does ``except BaseException as e: run_manager
.on_chain_error(e); raise`` with no special case for interrupts, so **every**
HITL pause arrives as an error callback. Reporting it would paint a red error
plus ``agent_end(outcome="failed")`` on every human approval. Any
`langgraph.errors.GraphBubbleUp` subclass — `GraphInterrupt`, `NodeInterrupt`,
`ParentCommand`, `GraphDrained` — is therefore treated as control flow.
"""

import contextvars
import dataclasses
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Iterable

from failproofai_sdk import _context
from failproofai_sdk.integrations import _compat, _core
from failproofai_sdk.integrations._core import (
    Patcher,
    RunTracker,
    framework_fields,
    fw_fields,
    ms,
    normalize_agent_id,
    safe,
    truncate,
)

logger = logging.getLogger("failproofai_sdk.integrations")

NAME = "langchain"
MODULE = "langchain_core"
DIST = "langchain-core"
EXTRA = "langchain"
ENV_VAR = "FAILPROOFAI_SDK_TRACE_LANGCHAIN"

# The documented escape hatch for session stitching:
#     graph.invoke(x, config={"metadata": {"failproofai_sdk_session_id": sid}})
SESSION_METADATA_KEY = "failproofai_sdk_session_id"

# Checked in order after the explicit key above. `thread_id` is last because a
# thread is a *conversation*; two turns on one thread are two runs, and a user
# who wants them merged has said so with one of the earlier keys.
SESSION_METADATA_FALLBACKS = ("session_id", "conversation_id", "thread_id")

# LangSmith's convention for "machinery, not user-visible work". We demote these
# rather than dropping them: they never become a span, but they stay in the
# parent chain so their children still find the agent above them.
HIDDEN_TAG = "langsmith:hidden"

_FIELD_LIMIT = 2048  # inputs/outputs are graph state; the per-event budget is not the only guard


# ---------------------------------------------------------------------------
# Framework imports
# ---------------------------------------------------------------------------
# This module is only ever imported by `instrument("langchain")`, so importing
# the framework at module scope is fine — `import failproofai_sdk` never gets here.
# `require_module` turns a missing install into an ImportError carrying the
# literal install command.
_compat.require_module(MODULE, dist=DIST, extra=EXTRA)

from langchain_core.tracers.base import BaseTracer  # noqa: E402
from langchain_core.tracers.context import register_configure_hook  # noqa: E402

try:  # langgraph >= 1.2 only
    from langgraph.callbacks import GraphCallbackHandler as _GraphCallbackHandler
except ImportError:  # pragma: no cover - exercised on langgraph < 1.2 / absent
    _GraphCallbackHandler = None

try:
    from langgraph.errors import GraphBubbleUp as _GraphBubbleUp
except ImportError:  # pragma: no cover
    _GraphBubbleUp = None

try:  # `Command` tells a resume from a fresh turn; `Interrupt` derives a pause id
    from langgraph.types import Command as _Command
    from langgraph.types import Interrupt as _Interrupt
except ImportError:  # pragma: no cover
    _Command = None
    _Interrupt = None

# Name-based fallback for the case where `langgraph.errors` moved. Getting this
# wrong is expensive and silent (a red error on every human approval), so it is
# worth a belt-and-braces check rather than a bare `isinstance`.
_CONTROL_FLOW_NAMES = frozenset(
    {"GraphBubbleUp", "GraphInterrupt", "NodeInterrupt", "ParentCommand", "GraphDrained"}
)


def _is_control_flow(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if _GraphBubbleUp is not None and isinstance(exc, _GraphBubbleUp):
        return True
    return any(cls.__name__ in _CONTROL_FLOW_NAMES for cls in type(exc).__mro__)


if _GraphCallbackHandler is not None:
    _GraphBase: Any = _GraphCallbackHandler
else:  # pragma: no cover - only on langgraph < 1.2

    class _GraphBase:  # type: ignore[no-redef]
        """Stand-in so the two lifecycle overrides always have a home.

        Deliberately **not** registered anywhere: langgraph's dispatch is an
        `isinstance(h, GraphCallbackHandler)` filter, so on an older langgraph
        these methods are simply never called, which is the correct behaviour.
        """

        def on_interrupt(self, event: Any) -> Any: ...

        def on_resume(self, event: Any) -> Any: ...


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class _Options:
    """Everything `instrument("langchain", ...)` accepts."""

    session_id: str | None = None
    include_chains: frozenset = frozenset()
    capture_content: bool = True
    graph_callbacks: bool = True


@dataclasses.dataclass
class _Session:
    """One Failproof AI session, which may outlive a single `.invoke()`.

    It has to: a human-in-the-loop graph runs `invoke()`, interrupts, and is
    resumed by a *second* `invoke()` minutes later. Both are the same session
    and the same root agent, and the agent stays open across the gap so that
    `agent_pause` -> `agent_resume` measures the wait (which is the only thing
    that feeds the dashboard's `pausedMs`).
    """

    session_id: str
    agent_key: str
    agent_id: str
    open_pauses: dict = dataclasses.field(default_factory=dict)
    reported_error: bool = False


@dataclasses.dataclass
class _RemoteResume:
    """Bookkeeping for a resume whose pause was opened in ANOTHER process.

    Set on the ROOT `_RunInfo` only, and only when this process has no open
    pause of its own to close — i.e. exactly the deployment shape where the
    interrupt was served by one worker and the approval by another. See
    `_close_remote_pause` for how the pause id is recovered.
    """

    value: Any = None
    # checkpoint-ns tuple -> the `langgraph_step` of the first node seen at that
    # level. Only that first superstep re-runs interrupted tasks; everything
    # after it is ordinary downstream work.
    levels: dict = dataclasses.field(default_factory=dict)
    # The deepest level langgraph has told us is resuming. A subgraph host node
    # sits at a shallower level than the task that actually interrupted.
    deepest: tuple | None = None
    done: set = dataclasses.field(default_factory=set)


@dataclasses.dataclass
class _RunInfo:
    """What we need about a LangChain run after its start callback returns."""

    id: str
    parent: str | None
    name: str
    run_type: str
    started: datetime = dataclasses.field(default_factory=_now)
    hidden: bool = False
    kind: str = ""  # "" | "root" | "node" | "tool" | "retriever" | "model" | "chain"
    # Set only on a ROOT run that is itself a leaf — a bare `llm.invoke()`, a
    # standalone tool. Such a run is both the session's agent and a model/tool
    # call, and it needs both pairs. See `_start_root`.
    leaf_kind: str = ""
    root: str | None = None
    session: _Session | None = None
    node: str | None = None
    tool_call_id: str | None = None
    model: str | None = None
    messages: list | None = None
    ttft_ms: int | None = None
    chunks: int = 0
    remote: _RemoteResume | None = None  # root only


class _State:
    """All cross-callback state, module level on purpose.

    The `env_var` form of `register_configure_hook` constructs a **new**
    `FailproofAITracer` per callback manager, so anything kept on `self` would be
    lost between a start and its end. Nothing here touches contextvars either:
    `ContextVar.reset(token)` raises across asyncio tasks as well as threads, so
    a surface whose start and end are separate calls can never hold a token.
    """

    MAX_RUNS = 10_000
    MAX_SESSIONS = 1_000

    def __init__(self) -> None:
        # RLock because a handler body can re-enter through a nested helper.
        self.lock = threading.RLock()
        # The kill switch `uninstall()` needs and neither of its two other
        # levers actually provides. A configure hook cannot be deregistered, so
        # removal is "make the hook produce nothing" — but clearing the
        # ContextVar only reaches contexts derived from the one calling
        # `uninstall()`, and unsetting the env var is skipped whenever the
        # process already had it set (`self._set_env` is False then, so we do
        # not clobber somebody else's environment). Either hole leaves
        # `_configure` constructing a live zero-arg tracer per callback manager
        # — VERIFIED: with FAILPROOFAI_SDK_TRACE_LANGCHAIN=1 exported before
        # `instrument()`, every event was still recorded after `uninstrument()`.
        # Checked at the two entry points that gate everything else: no
        # `_RunInfo` is registered, so `_on_end`, `_count_token`,
        # `_on_interrupt` and `_on_resume` all fall out on their own lookups.
        self.enabled = False
        self.options = _Options()
        self.tracker = RunTracker(NAME, base_fields=_base_fields())
        self.runs: dict[str, _RunInfo] = {}
        self.sessions: dict[str, _Session] = {}
        # run_id -> the LLMResult / exception stashed by a public callback for
        # the `_end_trace` that follows it.
        self.responses: dict[str, Any] = {}
        self.errors: dict[str, BaseException] = {}

    def reset(self) -> None:
        with self.lock:
            self.tracker.reset()
            self.runs.clear()
            self.sessions.clear()
            self.responses.clear()
            self.errors.clear()

    def evict(self) -> None:
        """Caller holds the lock. FIFO; dicts keep insertion order.

        Orphaned entries are normal, not exceptional: a cancelled stream, a
        crashed node, a framework that skipped an end callback. Unbounded, each
        of these dicts is a memory leak in a long-lived server.
        """
        for table, cap in (
            (self.runs, self.MAX_RUNS),
            (self.sessions, self.MAX_SESSIONS),
            (self.responses, self.MAX_RUNS),
            (self.errors, self.MAX_RUNS),
        ):
            while len(table) >= cap:
                table.pop(next(iter(table)), None)


def _base_fields() -> dict:
    fields = framework_fields(NAME, DIST)
    version = _compat.version_string("langgraph")
    if version:
        fields["fw_langgraph_version"] = version
    return fields


_STATE = _State()


# ---------------------------------------------------------------------------
# Small readers over the Run object
# ---------------------------------------------------------------------------

def _meta(run: Any) -> dict:
    meta = getattr(run, "metadata", None)
    return dict(meta) if isinstance(meta, dict) else {}


def _extra(run: Any) -> dict:
    extra = getattr(run, "extra", None)
    return extra if isinstance(extra, dict) else {}


def _tags(run: Any) -> list:
    tags = getattr(run, "tags", None)
    return list(tags) if tags else []


def _shrink(value: Any) -> Any:
    """Payload discipline for the big three: inputs, outputs, graph state."""
    if not _STATE.options.capture_content:
        return None
    return truncate(value, _FIELD_LIMIT)


# A run of one of these types is a leaf — a model call, a tool call, a
# retrieval. It is never the LangGraph node's *own* run. Verified against
# langgraph 1.2.11: whatever you hand `add_node` (a function, a Runnable, a
# `BaseTool`, a compiled subgraph), the node's own run is always a **chain**
# run tagged `graph:step:N`, and the thing you passed runs as a child of it.
_LEAF_RUN_TYPES = frozenset({"llm", "chat_model", "tool", "retriever"})

# LangChain tags every step of a `RunnableSequence` `seq:step:N`. LangGraph tags
# a node's own run `graph:step:N`. Only the second is a node.
_INNER_STEP_TAG = "seq:step:"


def _node_of(run: Any, meta: dict) -> str | None:
    """The LangGraph node name **iff this run is the node's own run**.

    Every inner Runnable inherits `langgraph_node` from the node that contains
    it, so the metadata alone matches the node, the chat model inside it, the
    tool it called and each conditional-edge function. `run.name` is exactly the
    `kwargs["name"] or serialized["name"]` the callback was given, and only the
    node's own run has it equal to `langgraph_node`. Verified against
    langgraph 1.2.10: an inner `cond`/`fan` edge function reports
    `name="cond"` with `langgraph_node="act"` and is correctly excluded.

    The name alone is not enough, because **the name is the user's to choose on
    both sides**. Two collisions were verified on langgraph 1.2.11, and each one
    silently deleted the most valuable event in the trace:

    * ``add_node("lookup_population", ToolNode([lookup_population]))`` — naming a
      node after the tool it runs, which is the obvious thing to do — made the
      *tool's* run match too. It was recorded as a second node visit, so
      `tool_use`/`tool_result` were never emitted: the arguments, the result and
      the LLM's `tool_call_id` all vanished, and `/tools` showed the call had
      never happened.
    * ``add_node("ChatOpenAI", ...)`` did the same to the chat model run:
      no `model_request`/`model_response`, so the model name, both token counts
      and the latency were dropped while the trace still looked populated.
    * an inner Runnable carrying `run_name` equal to the node key produced
      **two** `hook_triggered`/`hook_completed` pairs for one node visit, which
      doubles that node's visit count and halves its apparent latency.

    So the run must also be shaped like a node's own run: a non-leaf run type,
    and not an inner step of a `RunnableSequence`. Both are *exclusions* — if
    langgraph ever stops emitting `seq:step:` tags this degrades to the old
    duplicate span rather than to no spans at all, which is the safe direction
    for a check that gates `hook_triggered` **and** `_ensure_subgraph_agent`.
    """
    node = meta.get("langgraph_node")
    if not node or node != (getattr(run, "name", None) or ""):
        return None
    if str(getattr(run, "run_type", "") or "") in _LEAF_RUN_TYPES:
        return None
    if any(str(tag).startswith(_INNER_STEP_TAG) for tag in _tags(run)):
        return None
    return str(node)


def _ns_parts(meta: dict) -> list:
    """`langgraph_checkpoint_ns` split into its `name:uuid` segments.

    For a top-level node this is one segment (`plan:uuid`); for a node inside a
    compiled subgraph it is `child:uuid|sub_step:uuid`. The number of segments
    beyond the first is the subgraph nesting depth, and the leading segments
    name the subgraphs — which is how nested agents get their ids without
    having to recognise a compiled `Pregel` from a `Run` object.
    """
    ns = meta.get("langgraph_checkpoint_ns")
    if not ns or not isinstance(ns, str):
        return []
    return ns.split("|")


# ---------------------------------------------------------------------------
# Session resolution
# ---------------------------------------------------------------------------

def _resolve_session_id(run: Any, meta: dict) -> str:
    """Pick the session id for a root run.

    In order:

    1. ``instrument("langchain", session_id=...)`` — an explicit override wins.
    2. ``config={"metadata": {"failproofai_sdk_session_id": ...}}`` — the documented
       per-call key.
    3. the ambient `failproofai_sdk.session()` / `failproofai_sdk.agent()` scope, so a
       hand-written outer bracket and the adapter produce **one** session.
    4. ``metadata["session_id" | "conversation_id" | "thread_id"]``.
    5. the root run id.

    Never synthesised from scratch: a made-up id splits one run into many
    sessions, which is a silent wrong answer rather than a loud one.
    """
    if _STATE.options.session_id:
        return str(_STATE.options.session_id)
    explicit = meta.get(SESSION_METADATA_KEY)
    if explicit:
        return str(explicit)
    ambient = _context.session_id()
    if ambient:
        return ambient
    for key in SESSION_METADATA_FALLBACKS:
        value = meta.get(key)
        if value:
            return str(value)
    return str(getattr(run, "id", "")) or _context.DEFAULT_AGENT_ID


# ---------------------------------------------------------------------------
# Emission helpers
# ---------------------------------------------------------------------------

def _emit(method: str, info: _RunInfo, **fields: Any) -> None:
    _STATE.tracker.emit(method, info.id, parent_key=info.parent, **fields)


def _emit_on_agent(session: _Session, method: str, **fields: Any) -> None:
    _STATE.tracker.emit(method, session.agent_key, **fields)


def _fw_common(run: Any, info: _RunInfo, meta: dict) -> dict:
    """The `fw_*` extras every event from this adapter carries.

    Namespaced, and that is a **safety** rule rather than a style one:
    `_schema._build()` merges extra fields last, so an extra called `tool_name`,
    `model` or `outcome` silently overwrites the declared field and therefore
    the promoted column. `_core.guard_extras` is the backstop;
    `fw_fields` is how we stay away from the edge.
    """
    return fw_fields(
        run_id=info.id,
        parent_run_id=info.parent,
        node=info.node or meta.get("langgraph_node"),
        step=meta.get("langgraph_step"),
        checkpoint_ns=meta.get("langgraph_checkpoint_ns"),
        thread_id=meta.get("thread_id"),
        tags=_tags(run) or None,
        hidden=True if info.hidden else None,
    )


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

def _on_start(run: Any) -> None:
    state = _STATE
    if not state.enabled:
        return
    rid = str(run.id)
    parent = str(run.parent_run_id) if getattr(run, "parent_run_id", None) else None
    meta = _meta(run)

    with state.lock:
        state.evict()
        info = _RunInfo(
            id=rid,
            parent=parent,
            name=str(getattr(run, "name", "") or ""),
            run_type=str(getattr(run, "run_type", "") or ""),
            hidden=HIDDEN_TAG in _tags(run),
        )
        state.runs[rid] = info
        # Every run is linked, span or not. This is what lets a tool three
        # Runnables deep still find the agent above it: `RunTracker.identity`
        # walks the link chain, and an intermediate chain that emits nothing
        # would otherwise break the walk.
        state.tracker.link(rid, parent)

        if parent is None:
            _start_root(run, info, meta)
            return

        holder = state.runs.get(parent)
        info.root = holder.root if holder is not None else None
        info.session = holder.session if holder is not None else None

        node = _node_of(run, meta)
        if node is not None:
            info.kind = "node"
            info.node = node
            _start_node(run, info, meta)
            return

        if info.run_type in ("llm", "chat_model"):
            info.kind = "model"
            _start_model(run, info, meta)
            return
        if info.run_type == "tool":
            info.kind = "tool"
            _start_tool(run, info, meta)
            return
        if info.run_type == "retriever":
            info.kind = "retriever"
            _start_retriever(run, info, meta)
            return

        # Everything else — RunnableSequence, prompt templates, output parsers,
        # conditional-edge functions, the compiled-subgraph Pregel run itself.
        # Emitting these would bury the timeline under machinery, so they are
        # linked and otherwise invisible unless explicitly allowlisted.
        if info.name and info.name in state.options.include_chains and not info.hidden:
            info.kind = "chain"
            _emit(
                "hook_triggered",
                info,
                hook_name=info.name,
                hook_id=info.id,
                trigger_event="pipeline",
                input=_shrink(getattr(run, "inputs", None)),
                **_fw_common(run, info, meta),
            )


def _start_root(run: Any, info: _RunInfo, meta: dict) -> None:
    """The root run becomes the session's agent — and its **first** event.

    `agent_sessions.agent_id = any(...)` resolves to the first `agent_id` by
    time over `ORDER BY (session_id, ts, ...)`, so anything emitted before this
    would name the session after a node. The dashboard also parents every leaf
    to the open agent with the same `agent_id` and **synthesises a
    never-ending root span** when there is none, so this must not be skipped.
    """
    state = _STATE
    info.kind = "root"
    info.root = info.id
    session_id = _resolve_session_id(run, meta)

    existing = state.sessions.get(session_id)
    if (
        existing is not None
        and existing.open_pauses
        and existing.agent_key in state.tracker.open_agents()
        and _is_continuation(run)
    ):
        # A resume: the previous `.invoke()` interrupted, we deliberately did
        # not close its agent, and this is the continuation. Reuse the identity
        # instead of opening a second root span for the same logical run.
        #
        # `open_pauses` is the whole test, and leaving it out was a silent
        # data-loss bug rather than a cosmetic one. "The session's agent is
        # still open" is ALSO true of two roots that merely OVERLAP IN TIME
        # under one session id — `.batch()` (langchain-core opens one root run
        # per input), a top-level `RunnableParallel` of chains, or two web
        # requests carrying the same conversation id. Those were read as
        # resumes: the second root got no `agent_start` at all, its work was
        # relabelled with the first root's `agent_id`, the first root to finish
        # closed the shared agent, and every event the other root emitted after
        # that resolved to nothing and was DROPPED — a real model call, with
        # its tokens and its latency, gone with one "could not resolve a
        # session" line at WARNING. A run that is genuinely paused always has an
        # open pause: `_end_root` returns without `agent_end` exactly when
        # `session.open_pauses` is non-empty, which is the only way the agent
        # stays open past its root, and `_suspend` is the only thing that fills
        # it. So this distinguishes the two cases precisely.
        #
        # `_is_continuation` is the second half of that test and it is not
        # redundant: an open pause bounds how long the window lasts, but it
        # does not close it. A HITL turn can sit paused on a human for
        # **minutes**, and any other run that happens to carry the same session
        # id during that window — a second web request on one conversation id,
        # a background summariser, a different graph entirely — was read as the
        # approval. VERIFIED against langgraph 1.2.11: the second run got no
        # `agent_start`, its nodes were folded into the paused run's span, and
        # the adapter emitted `agent_resume` + `human_input` for a human who
        # had answered nothing — `human_input.response` empty, the pause closed,
        # and the paused run's `agent_end` reporting `success`. On a product
        # whose whole job is to gate an action on human approval, fabricating
        # the approval is the worst wrong answer available. LangGraph only ever
        # continues an interrupted thread through `Command(...)` or a `None`
        # input; a fresh state dict is a NEW turn, not an answer.
        info.session = existing
        state.tracker.link(info.id, existing.agent_key)
        _resume(existing, run)
        return

    identity = state.tracker.start_agent(
        info.id,
        agent_id=normalize_agent_id(info.name, "agent"),
        session_id=session_id,
        goal=_goal_of(run),
        **_fw_common(run, info, meta),
    )
    session = _Session(
        session_id=identity.session_id or session_id,
        agent_key=info.id,
        agent_id=identity.agent_id or "agent",
    )
    info.session = session
    state.sessions[session.session_id] = session

    # This is a resume, but nothing in THIS process is paused — so the pause was
    # opened somewhere else. That is not an edge case, it is the deployment
    # shape: one worker serves the request that interrupts, a human answers
    # minutes later, and whichever worker picks up that request resumes against
    # the shared checkpointer. Before this, such a resume emitted no
    # `agent_resume` and no `human_input` at all, so the `human_wait` and
    # `agent_pause` from the first process stayed open FOREVER — every
    # cross-process approval left its session reporting "still waiting on a
    # human" after the human had answered, and `pausedMs` never closed.
    # `_close_remote_pause` recovers the id the other process used.
    answer = _resume_values(run)
    if answer is not None:
        info.remote = _RemoteResume(value=answer)

    # A root run that is ITSELF a leaf still has to be recorded as one.
    #
    # `ChatOpenAI(...).invoke(...)` outside any graph is a single run with no
    # parent and `run_type="chat_model"`. Handled only as a root it produced an
    # `agent_start`/`agent_end` pair and NOTHING ELSE — no `model_request`, no
    # `model_response`, so the model name, both token counts and the latency of
    # a direct model call were dropped on the floor, silently, while the trace
    # still looked populated. Direct `.invoke()` is not an edge case: a
    # classifier, a summariser, a one-shot rewrite are all shaped like this.
    #
    # The agent span stays (the dashboard parents leaves to an open agent with
    # the same `agent_id` and synthesises a never-ending root span when there is
    # none), so this is purely additive: the same run now emits its leaf pair
    # INSIDE its own agent span.
    starter = _ROOT_LEAF_STARTERS.get(info.run_type)
    if starter is not None:
        info.leaf_kind = _LEAF_KIND_OF[info.run_type]
        starter(run, info, meta)


def _goal_of(run: Any) -> str | None:
    inputs = getattr(run, "inputs", None)
    if not _STATE.options.capture_content or inputs is None:
        return None
    if isinstance(inputs, dict):
        messages = inputs.get("messages")
        if isinstance(messages, (list, tuple)) and messages:
            content = getattr(messages[-1], "content", None)
            if isinstance(content, str) and content:
                return truncate(content, 512)
    return truncate(str(inputs), 512)


def _start_node(run: Any, info: _RunInfo, meta: dict) -> None:
    """A LangGraph node -> `hook_triggered`.

    Also the point at which a compiled **subgraph** becomes a nested agent: a
    node whose checkpoint namespace is more than one segment deep is running
    inside one, and its parent run *is* the subgraph's Pregel run (verified on
    langgraph 1.2.10). Deriving it here means we never have to recognise a
    `Pregel` from a `Run`, and it nests to arbitrary depth for free.
    """
    parts = _ns_parts(meta)
    if len(parts) > 1 and info.parent is not None:
        _ensure_subgraph_agent(info, parts[:-1])

    remote = _remote_of(info)
    if remote is not None:
        # First node seen at this level wins: langgraph re-runs the interrupted
        # tasks in the level's first superstep and nothing else (VERIFIED on
        # 1.2.11 — a sibling that had already succeeded in the same superstep
        # does NOT re-run), so anything at a later step is downstream work.
        remote.levels.setdefault(tuple(parts[:-1]), meta.get("langgraph_step"))

    if info.hidden:
        return
    _emit(
        "hook_triggered",
        info,
        hook_name=info.node,
        hook_id=info.id,
        trigger_event="graph_node",
        input=_shrink(getattr(run, "inputs", None)),
        **_fw_common(run, info, meta),
    )


def _ensure_subgraph_agent(info: _RunInfo, prefix: list) -> None:
    state = _STATE
    key = info.parent
    if key is None or key in state.tracker.open_agents():
        return
    holder = state.runs.get(key)
    session = info.session
    if holder is None or session is None:
        return
    names = [part.split(":", 1)[0] for part in prefix if part]
    agent_id = "/".join([session.agent_id, *names])
    state.tracker.start_agent(
        key,
        agent_id=agent_id,
        parent_key=holder.parent,
        session_id=session.session_id,
        **fw_fields(run_id=key, subgraph=names[-1] if names else None, kind="subgraph"),
    )
    holder.kind = "subgraph"
    holder.session = session


def _start_tool(run: Any, info: _RunInfo, meta: dict) -> None:
    # The LLM-issued id when there is one, so our events line up with the
    # provider's logs and with the `tool_calls` on the assistant message. It
    # arrives in the `on_tool_start` kwargs and `_create_tool_run` parks the
    # whole kwargs dict in `run.extra`.
    info.tool_call_id = str(_extra(run).get("tool_call_id") or info.id)
    if info.hidden:
        return
    _emit(
        "tool_use",
        info,
        tool_name=info.name or "tool",
        tool_call_id=info.tool_call_id,
        input=_shrink(getattr(run, "inputs", None)),
        **_fw_common(run, info, meta),
    )


def _start_retriever(run: Any, info: _RunInfo, meta: dict) -> None:
    info.tool_call_id = info.id
    if info.hidden:
        return
    inputs = getattr(run, "inputs", None)
    query = inputs.get("query") if isinstance(inputs, dict) else inputs
    _emit(
        "tool_use",
        info,
        tool_name="retriever:%s" % (info.name or "retriever"),
        tool_call_id=info.tool_call_id,
        input={"query": truncate(query, _FIELD_LIMIT)} if _STATE.options.capture_content else None,
        **_fw_common(run, info, meta),
    )


def _start_model(run: Any, info: _RunInfo, meta: dict) -> None:
    info.model = _model_name(run, info, meta)
    messages = _STATE.responses.pop("messages:" + info.id, None)
    if messages is None:
        messages = _prompts_as_messages(getattr(run, "inputs", None))
    info.messages = messages
    if info.hidden:
        return
    _emit(
        "model_request",
        info,
        # The correlation id the dashboard's detail panel pairs on. No SDK ever
        # set it before, which is why `executionGraph` falls back to FIFO
        # pairing per agent_id and concurrent calls mis-pair.
        request_id=info.id,
        model=info.model,
        messages=messages if _STATE.options.capture_content else None,
        tools=_tools_of(run),
        **_fw_common(run, info, meta),
    )


def _model_name(run: Any, info: _RunInfo, meta: dict) -> str:
    """`ls_model_name` first, then the invocation params, then the class name.

    `ls_model_name` is the LangSmith standard key and is what a real provider
    integration sets. It is **absent** on the fake chat models used in tests and
    on some community integrations, so the fallbacks are load-bearing rather
    than defensive padding.
    """
    name = meta.get("ls_model_name")
    if name:
        return str(name)
    params = _extra(run).get("invocation_params")
    if isinstance(params, dict):
        for key in ("model_name", "model", "model_id", "deployment_name"):
            value = params.get(key)
            if value:
                return str(value)
    return info.name or "unknown"


def _tools_of(run: Any) -> list | None:
    params = _extra(run).get("invocation_params")
    if not isinstance(params, dict):
        return None
    tools = params.get("tools")
    if isinstance(tools, (list, tuple)) and tools:
        return truncate(list(tools), _FIELD_LIMIT)
    return None


def _prompts_as_messages(inputs: Any) -> list | None:
    """Text-completion runs arrive as `{"prompts": [...]}`.

    Chat runs are captured from `on_chat_model_start`, where the real
    `BaseMessage` objects are still available — `_create_chat_model_run`
    flattens them to `"System: ...\\nHuman: ..."` strings before they reach the
    `Run`, which would lose the roles.
    """
    if not isinstance(inputs, dict):
        return None
    prompts = inputs.get("prompts")
    if isinstance(prompts, (list, tuple)):
        return [{"role": "user", "content": truncate(p, _FIELD_LIMIT)} for p in prompts]
    return None


_ROLES = {"human": "user", "ai": "assistant", "system": "system", "tool": "tool"}


def _normalize_messages(batches: Any) -> list | None:
    if not batches:
        return None
    batch = batches[-1] if isinstance(batches[-1], (list, tuple)) else batches
    out = []
    for message in batch:
        kind = str(getattr(message, "type", "") or "")
        entry: dict = {
            "role": _ROLES.get(kind, kind or "user"),
            "content": truncate(getattr(message, "content", ""), _FIELD_LIMIT),
        }
        calls = getattr(message, "tool_calls", None)
        if calls:
            entry["tool_calls"] = truncate(list(calls), _FIELD_LIMIT)
        out.append(entry)
    return out


# A root run whose own `run_type` is one of these is a leaf as well as the
# session's agent. Keyed by LangChain's `run_type` string.
_LEAF_KIND_OF = {
    "llm": "model",
    "chat_model": "model",
    "tool": "tool",
    "retriever": "retriever",
}
_ROOT_LEAF_STARTERS = {
    "llm": _start_model,
    "chat_model": _start_model,
    "tool": _start_tool,
    "retriever": _start_retriever,
}


# ---------------------------------------------------------------------------
# End
# ---------------------------------------------------------------------------

def _on_end(run: Any) -> None:
    state = _STATE
    rid = str(run.id)
    with state.lock:
        info = state.runs.get(rid)
        exc = state.errors.pop(rid, None)
        response = state.responses.pop(rid, None)
        if info is None:
            return
        meta = _meta(run)

        if info.kind == "root":
            # Close the leaf pair first when the root was also a leaf: the
            # dashboard closes the agent span at `agent_end`, so a
            # `model_response` emitted after it is attributed to nothing.
            if info.leaf_kind:
                _ROOT_LEAF_ENDERS[info.leaf_kind](run, info, meta, exc, response)
                # ...and the leaf pair we just closed OWNS the failure, exactly
                # as it does for a nested tool or model run (see the matching
                # line at the bottom of this function). Without this, a failing
                # `tool.invoke()` or `llm.invoke()` at the top level reported
                # the same exception twice — once as `tool_result.error` and
                # again as a standalone `error` event — so one failure counted
                # as two on `sessionSummary.errorCount`, while the identical
                # failure one Runnable deeper counted as one.
                if info.session is not None and not _is_control_flow(exc) and (
                    exc is not None or getattr(run, "error", None)
                ):
                    info.session.reported_error = True
            _end_root(run, info, meta, exc)
            return

        state.runs.pop(rid, None)

        if info.kind == "subgraph" or rid in state.tracker.open_agents():
            state.tracker.end_agent(
                rid,
                outcome=_outcome(run, exc),
                summary=_error_text(run, exc),
            )
        elif info.hidden:
            pass
        elif info.kind == "node" or info.kind == "chain":
            _end_hook(run, info, meta, exc)
        elif info.kind == "tool":
            _end_tool(run, info, meta, exc)
        elif info.kind == "retriever":
            _end_retriever(run, info, meta, exc)
        elif info.kind == "model":
            _end_model(run, info, meta, exc, response)

        if info.kind == "node":
            # Strictly BEFORE the `_suspend` below: a node that answers one
            # interrupt and immediately raises the next must close the old pause
            # before opening the new one, and on langgraph 1.2 both carry the
            # same id (it is derived from the task's namespace, not the call).
            _close_remote_pause(info, meta)

        # The exception-path HITL fallback, deliberately outside the span
        # handling above so that it still fires for a `langsmith:hidden` node
        # and for a subgraph that bubbled the interrupt up. `_suspend` dedups on
        # `Interrupt.id`, so this and `on_interrupt` cannot double-emit.
        interrupts = _interrupts_of(exc)
        if interrupts and info.session is not None:
            _suspend(info.session, interrupts)
        if exc is not None and not _is_control_flow(exc) and info.session is not None:
            # The span that owns this failure has reported it. The root must not
            # report it again, or `sessionSummary.errorCount` counts one failure
            # twice — once on the leaf and once as a standalone `error` event.
            info.session.reported_error = True


def _outcome(run: Any, exc: BaseException | None) -> str:
    if _is_control_flow(exc):
        return "paused"
    if exc is not None or getattr(run, "error", None):
        return "failed"
    return "success"


def _error_text(run: Any, exc: BaseException | None) -> str | None:
    """The error as a short string, never the whole stacktrace.

    `run.error` is `repr(exc)` plus the formatted traceback, which is a fine
    thing to keep on the `traceback` field of an `error` event and a terrible
    thing to put in `tool_result.error`, where the dashboard renders it inline.
    """
    if _is_control_flow(exc):
        return None
    if exc is not None:
        return truncate("%s: %s" % (type(exc).__name__, exc), _FIELD_LIMIT)
    error = getattr(run, "error", None)
    if error:
        return truncate(str(error).splitlines()[0], _FIELD_LIMIT)
    return None


def _error_message(run: Any, exc: BaseException | None) -> str | None:
    """`_error_text` minus the type prefix, for the `error` event only.

    `error` is the one event that carries `error_type` as its OWN field, and the
    server builds the row's `summary` as ``"<error_type>: <message>"``. Feeding
    it `_error_text` — which prefixes the type because `tool_result.error` and
    `agent_end.summary` have nowhere else to say it — rendered every entry on
    the Errors surface as ``ValueError: ValueError: denominator must be
    non-zero``. The CrewAI, LlamaIndex and Pydantic AI adapters all pass a bare
    `str(exc)` here; this makes the fourth agree with them.
    """
    if _is_control_flow(exc):
        return None
    if exc is not None:
        return truncate(str(exc), _FIELD_LIMIT) or type(exc).__name__
    error = getattr(run, "error", None)
    if error:
        return truncate(str(error).splitlines()[0], _FIELD_LIMIT)
    return None


def _end_hook(run: Any, info: _RunInfo, meta: dict, exc: BaseException | None) -> None:
    _emit(
        "hook_completed",
        info,
        hook_name=info.node or info.name,
        hook_id=info.id,
        # `"paused"` for a GraphInterrupt: the node did not fail, it stopped to
        # ask a human. `"failed"`, never `"failure"` — the server only counts
        # error|failed|timeout|rejected.
        outcome=_outcome(run, exc),
        output=_shrink(getattr(run, "outputs", None)),
        error=_error_text(run, exc),
        **_fw_common(run, info, meta),
    )


def _end_tool(run: Any, info: _RunInfo, meta: dict, exc: BaseException | None) -> None:
    outputs = getattr(run, "outputs", None)
    output = outputs.get("output") if isinstance(outputs, dict) else outputs
    output, failed = _tool_output(output)
    _emit(
        "tool_result",
        info,
        tool_name=info.name or "tool",
        tool_call_id=info.tool_call_id or info.id,
        output=_shrink(output),
        error=_error_text(run, exc) or failed,
        **_fw_common(run, info, meta),
    )


def _tool_output(output: Any) -> tuple:
    """The tool's actual result, plus an error string when it failed quietly.

    A tool invoked the way every modern tool loop invokes one — handed the
    LLM's `ToolCall` dict rather than a bare argument dict, which is what
    `bind_tools` produces and what the docs show — returns a **`ToolMessage`**,
    not a string. `truncate` has no JSON shape for one, so it fell back to
    `repr` and the single most-read field in a tool loop rendered as
    ``ToolMessage(content='37000000', name='lookup_population', tool_call_id=…)``
    instead of ``37000000``.

    `status` is the second half. A `ToolMessage` carries `status="error"` when
    the tool failed but the framework converted the exception into a message
    for the model instead of raising — `run.error` is empty on that path, so the
    failure had NO representation at all: `is_error` 0, a green span, and the
    text of the exception sitting in an output field nobody filters on.
    """
    if getattr(output, "type", None) != "tool":
        return output, None
    content = getattr(output, "content", None)
    failed = None
    if getattr(output, "status", None) == "error":
        failed = truncate(content if isinstance(content, str) else str(content), _FIELD_LIMIT)
    return content, failed


def _end_retriever(run: Any, info: _RunInfo, meta: dict, exc: BaseException | None) -> None:
    _emit(
        "tool_result",
        info,
        tool_name="retriever:%s" % (info.name or "retriever"),
        tool_call_id=info.tool_call_id or info.id,
        output=_summarize_documents(getattr(run, "outputs", None)),
        error=_error_text(run, exc),
        **_fw_common(run, info, meta),
    )


def _summarize_documents(outputs: Any) -> dict | None:
    """`{"n": ..., "sources": [...]}` — never the document text.

    A retriever that returns twenty 4KB chunks would otherwise put 80KB of
    prose into one event, on every hop of every RAG loop. None of it is a
    promoted column, so querying it means `JSONExtract` over the payload, which
    has already caused a memory blowup in the events store in this product.
    """
    if not isinstance(outputs, dict):
        return None
    docs = outputs.get("documents")
    if not isinstance(docs, (list, tuple)):
        return None
    sources = []
    for index, doc in enumerate(docs[:10]):
        meta = getattr(doc, "metadata", None) or {}
        source = meta.get("source") or meta.get("id") or meta.get("file_path")
        sources.append(truncate(str(source) if source else "doc[%d]" % index, 256))
    return {"n": len(docs), "sources": sources}


def _end_model(
    run: Any, info: _RunInfo, meta: dict, exc: BaseException | None, response: Any
) -> None:
    usage = _usage(response)
    content, role, stop_reason = _completion(response)
    if exc is not None:
        stop_reason = "error"
    extras = _fw_common(run, info, meta)
    if info.chunks:
        extras.update(fw_fields(streamed=True, chunks=info.chunks, ttft_ms=info.ttft_ms))
    _emit(
        "model_response",
        info,
        request_id=info.id,
        model=info.model,
        stop_reason=stop_reason,
        content=content if _STATE.options.capture_content else None,
        role=role,
        input_tokens=usage.get("input_tokens") if usage else None,
        output_tokens=usage.get("output_tokens") if usage else None,
        # Shipped as a dict as well: both `event_summary.rs` and
        # `sessionSummary.ts` fall back to `payload.usage` for tokens.
        usage=usage or None,
        error=_error_text(run, exc),
        # ALWAYS set, and always an `int`. `duration_ms` is not guarded on
        # `model_response`, and `durationOf` prefers the closing event's value
        # over end-minus-start — which is what keeps model durations honest even
        # though the execution graph pairs model events FIFO per agent_id. A
        # float would silently NULL the promoted u32 column.
        duration_ms=_duration_ms(run),
        **extras,
    )


def _duration_ms(run: Any) -> int:
    start = getattr(run, "start_time", None)
    if start is None:
        return 0
    # `_errored_llm_run` does not set `end_time`, unlike every other errored
    # path, so an errored model call would report a 0ms duration without this.
    end = getattr(run, "end_time", None) or _now()
    return ms(end - start)


def _usage(response: Any) -> dict:
    """Normalise token counts across the three shapes providers actually use.

    Primary is `usage_metadata` on the message — the LangChain-standard shape
    since 0.3 and the only one that carries cache/reasoning detail. The two
    fallbacks are OpenAI's `prompt_tokens`/`completion_tokens` and Anthropic's
    `input_tokens`/`output_tokens`, both of which arrive under `llm_output`.
    """
    if response is None:
        return {}
    message = _first_message(response)
    data = getattr(message, "usage_metadata", None)
    if isinstance(data, dict) and data:
        usage = {
            "input_tokens": data.get("input_tokens"),
            "output_tokens": data.get("output_tokens"),
            "total_tokens": data.get("total_tokens"),
        }
        for key in ("input_token_details", "output_token_details"):
            if data.get(key):
                usage[key] = dict(data[key])
        return {k: v for k, v in usage.items() if v is not None}

    output = getattr(response, "llm_output", None)
    if not isinstance(output, dict):
        return {}
    raw = output.get("token_usage") or output.get("usage") or {}
    if not isinstance(raw, dict):
        return {}
    # Built as an explicitly `int`-valued dict rather than filtered in place:
    # the `isinstance` filter narrows at runtime but not for a type checker, and
    # the arithmetic below is the kind of thing that must not be `Any`.
    counts: dict[str, int] = {
        name: value
        for name, value in (
            ("input_tokens", raw.get("prompt_tokens", raw.get("input_tokens"))),
            ("output_tokens", raw.get("completion_tokens", raw.get("output_tokens"))),
            ("total_tokens", raw.get("total_tokens")),
        )
        if isinstance(value, int) and not isinstance(value, bool)
    }
    if counts and "total_tokens" not in counts:
        counts["total_tokens"] = counts.get("input_tokens", 0) + counts.get("output_tokens", 0)
    return counts


def _first_generation(response: Any) -> Any:
    generations = getattr(response, "generations", None)
    if not generations:
        return None
    first = generations[0]
    if isinstance(first, (list, tuple)):
        return first[0] if first else None
    return first


def _first_message(response: Any) -> Any:
    generation = _first_generation(response)
    return getattr(generation, "message", None) if generation is not None else None


def _completion(response: Any) -> tuple:
    generation = _first_generation(response)
    if generation is None:
        return None, None, None
    message = getattr(generation, "message", None)
    content = getattr(message, "content", None)
    if content is None:
        content = getattr(generation, "text", None)
    info = getattr(generation, "generation_info", None) or {}
    stop = info.get("finish_reason") or info.get("stop_reason")
    if not stop and message is not None:
        response_meta = getattr(message, "response_metadata", None) or {}
        stop = response_meta.get("finish_reason") or response_meta.get("stop_reason")
    role = "assistant" if message is not None else None
    return truncate(content, _FIELD_LIMIT), role, stop


def _end_root(run: Any, info: _RunInfo, meta: dict, exc: BaseException | None) -> None:
    state = _STATE
    session = info.session
    state.runs.pop(info.id, None)
    _close_open_leaves(info.id)
    if session is None:
        return

    if session.open_pauses:
        # Interrupted, waiting on a human. Deliberately no `agent_end`: closing
        # the agent here would force-close the open pause (the graph does that
        # at `agent_end`), zeroing the one interval that measures how long the
        # human took. The agent is closed by the resuming `.invoke()`.
        return

    failed = exc is not None and not _is_control_flow(exc)
    if not failed and getattr(run, "error", None) and not _is_control_flow(exc):
        failed = True

    if failed and not session.reported_error:
        # Nothing below reported this failure, so nobody owns it — a standalone
        # `error` event is the only way it reaches the Errors surface. Strictly
        # before `agent_end`: the graph closes the agent span at `agent_end`,
        # so an error after it is attributed to nothing.
        _emit_on_agent(
            session,
            "error",
            error_type=type(exc).__name__ if exc is not None else "RunError",
            message=_error_message(run, exc) or "run failed",
            traceback=truncate(str(getattr(run, "error", "") or ""), _core.FIELD_LIMIT) or None,
            **_fw_common(run, info, meta),
        )

    state.tracker.end_agent(
        session.agent_key,
        outcome="failed" if failed else "success",
        summary=_error_text(run, exc) if failed else None,
        **_fw_common(run, info, meta),
    )
    state.sessions.pop(session.session_id, None)


# Mirrors `_ROOT_LEAF_STARTERS`. `_end_tool`/`_end_retriever` take no response
# argument, so they are adapted to one signature here rather than at the call
# site — a mismatch would be swallowed by `safe()` and read as "no events".
_ROOT_LEAF_ENDERS = {
    "model": _end_model,
    "tool": lambda run, info, meta, exc, response: _end_tool(run, info, meta, exc),
    "retriever": lambda run, info, meta, exc, response: _end_retriever(run, info, meta, exc),
}


def _close_open_leaves(root_id: str) -> None:
    """Close every leaf still open under this root. Caller holds the lock.

    `agent_end` force-closes open *pauses* but not tools, models or humans, so a
    run that dies mid-tool leaves the session `ongoing` forever. Closing them
    here is what keeps that invariant true when a framework skips an end
    callback — which happens on a hard cancellation, a killed stream, or a
    handler that was disabled part-way through by the failure policy.
    """
    state = _STATE
    stale = [i for i in state.runs.values() if i.root == root_id and i.id != root_id]
    for info in reversed(stale):
        state.runs.pop(info.id, None)
        if info.hidden or not info.kind:
            continue
        marker = fw_fields(incomplete=True)
        try:
            if info.kind == "tool" or info.kind == "retriever":
                _emit(
                    "tool_result",
                    info,
                    tool_name=info.name or "tool",
                    tool_call_id=info.tool_call_id or info.id,
                    **marker,
                )
            elif info.kind in ("node", "chain"):
                _emit(
                    "hook_completed",
                    info,
                    hook_name=info.node or info.name,
                    hook_id=info.id,
                    outcome="cancelled",
                    **marker,
                )
            elif info.kind == "model":
                _emit(
                    "model_response",
                    info,
                    request_id=info.id,
                    model=info.model,
                    stop_reason="incomplete",
                    duration_ms=ms(_now() - info.started),
                    **marker,
                )
            elif info.kind == "subgraph":
                state.tracker.end_agent(info.id, outcome="cancelled", **marker)
        except Exception:  # pragma: no cover - teardown must never raise
            logger.debug("failproofai_sdk: could not close open span %s", info.id, exc_info=True)


# ---------------------------------------------------------------------------
# Human in the loop
# ---------------------------------------------------------------------------

def _interrupts_of(exc: BaseException | None) -> tuple:
    """The `Interrupt`s carried by a `GraphInterrupt`, if this is one.

    `GraphInterrupt.__init__` does `super().__init__(interrupts)`, so
    `exc.args[0]` is the sequence. `ParentCommand` and `GraphDrained` are also
    `GraphBubbleUp` but carry a `Command` / a reason string, so the duck-typed
    `.value` check is what keeps them out.
    """
    if not _is_control_flow(exc):
        return ()
    args = getattr(exc, "args", ()) or ()
    if not args:
        return ()
    candidates = args[0]
    if not isinstance(candidates, (list, tuple)):
        return ()
    return tuple(c for c in candidates if hasattr(c, "value"))


def _suspend(session: _Session, interrupts: Iterable) -> None:
    """`human_wait` + `agent_pause`, one pair per `Interrupt`, in that order.

    **Both** pairs are required and neither is redundant: only
    `agent_pause` -> `agent_resume` feeds the graph's `pausedMs` (without it the
    session reports `ongoing` and inflates its active duration by the whole
    human wait), and only `human_wait` -> `human_input` carries the prompt, the
    response and the `pendingHuman` count.
    """
    for index, interrupt in enumerate(interrupts):
        pause_id = str(getattr(interrupt, "id", None) or "%s:%d" % (session.agent_key, index))
        if pause_id in session.open_pauses:
            continue
        prompt, options = _prompt_of(getattr(interrupt, "value", None))
        session.open_pauses[pause_id] = prompt
        _emit_on_agent(
            session,
            "human_wait",
            input_id=pause_id,
            prompt=prompt,
            options=options,
            reason="langgraph_interrupt",
            **fw_fields(interrupt_id=pause_id, kind="interrupt"),
        )
        _emit_on_agent(
            session,
            "agent_pause",
            pause_id=pause_id,
            reason="langgraph_interrupt",
            **fw_fields(interrupt_id=pause_id),
        )


def _prompt_of(value: Any) -> tuple:
    if isinstance(value, dict):
        prompt = value.get("prompt") or value.get("question") or value.get("message")
        options = value.get("options")
        if not isinstance(options, (list, tuple)):
            options = None
        else:
            options = [str(o) for o in options]
        if prompt is not None:
            return truncate(str(prompt), _FIELD_LIMIT), options
        return truncate(str(value), _FIELD_LIMIT), options
    return truncate(str(value), _FIELD_LIMIT) if value is not None else None, None


def _resume(session: _Session, run: Any) -> None:
    """`agent_resume` + `human_input`, in that order, one pair per open pause."""
    if not session.open_pauses:
        return
    answers = _resume_values(run)
    for pause_id, prompt in list(session.open_pauses.items()):
        session.open_pauses.pop(pause_id, None)
        _emit_on_agent(
            session,
            "agent_resume",
            pause_id=pause_id,
            reason="langgraph_resume",
            **fw_fields(interrupt_id=pause_id),
        )
        _emit_on_agent(
            session,
            "human_input",
            input_id=pause_id,
            response=_answer_for(answers, pause_id),
            **fw_fields(interrupt_id=pause_id, prompt=prompt),
        )


_MISSING = object()


def _steering_value(run: Any) -> Any:
    """The object `.invoke()` was called with, when it was **not** fresh state.

    Verified on langgraph 1.2.11: a fresh turn arrives as the state mapping
    itself (``{'trail': []}``), while anything that is not a mapping is wrapped
    under a single ``input`` key — ``{'input': Command(resume='yes')}`` for a
    resume, ``{'input': None}`` for ``invoke(None, config)``. So the presence of
    that key is what separates "steering an existing checkpointed run" from
    "starting a new one", and it is a *positive* test rather than a guess at
    which state schemas happen to look like a Command.
    """
    inputs = getattr(run, "inputs", None)
    if isinstance(inputs, dict):
        return inputs.get("input", _MISSING)
    return inputs if inputs is not None else _MISSING


def _is_continuation(run: Any) -> bool:
    """True when this root run continues an interrupted thread.

    LangGraph has exactly two of these — ``Command(...)`` and ``None`` — and
    both are shaped unlike fresh state (see `_steering_value`). Everything else
    starts a new run even when it lands on a thread that is mid-interrupt: a
    fresh input discards the pending tasks rather than answering them.
    """
    value = _steering_value(run)
    if value is _MISSING:
        return False
    if value is None:
        return True
    if _Command is not None and isinstance(value, _Command):
        return True
    # Duck-typed fallback for a moved/renamed `Command`.
    return all(hasattr(value, name) for name in ("resume", "goto", "update"))


def _resume_values(run: Any) -> Any:
    """The value handed to `Command(resume=...)`, read off the root run's input.

    On a resume, langgraph calls `on_chain_start` with the `Command` itself as
    the input, so the human's answer is available to us without any cooperation
    from the caller. `Command(resume={interrupt_id: value})` (the multi-
    interrupt form) is handled by `_answer_for`.
    """
    value = _steering_value(run)
    return getattr(value, "resume", None) if value is not _MISSING else None


def _answer_for(answers: Any, pause_id: str) -> str | None:
    if answers is None:
        return None
    if isinstance(answers, dict) and pause_id in answers:
        return truncate(str(answers[pause_id]), _FIELD_LIMIT)
    return truncate(str(answers), _FIELD_LIMIT)


def _session_for_run(run_id: Any) -> _Session | None:
    info = _STATE.runs.get(str(run_id)) if run_id is not None else None
    return info.session if info is not None else None


# ---------------------------------------------------------------------------
# Human in the loop, resumed by a DIFFERENT PROCESS
# ---------------------------------------------------------------------------
#
# Everything above assumes the process that paused is the process that resumes,
# because it keys the pause on the `Interrupt` object it saw. Real HITL is not
# shaped like that: the interrupt is served by one worker, a human answers
# minutes or hours later, and any worker may pick that request up. The resuming
# process has no `_Session`, no `open_pauses`, and langgraph's `GraphResumeEvent`
# carries a checkpoint id but no interrupt ids — so there was nothing to
# correlate on and the pause simply stayed open forever.
#
# It is recoverable, exactly, because `Interrupt.id` is not random. langgraph
# 1.2's `interrupt()` builds it with `Interrupt.from_ns(value, ns)`, i.e.
# `xxh3_128(checkpoint_ns)` — a pure function of the interrupted task's
# namespace. That namespace is `metadata["langgraph_checkpoint_ns"]`, which this
# adapter already reads on every node run, and it is **byte-identical across the
# two invocations** (VERIFIED on langgraph 1.2.11: `approve:49c9e42f-…` in both
# the interrupting and the resuming process, hashing to the id the first process
# reported). So the resuming process can reconstruct the id the pausing process
# used without any shared state at all.
#
# The remaining question is *which* node re-ran because it was interrupted, and
# langgraph answers that too, in two parts:
#
# * `on_resume` fires once per Pregel level, in order, each naming the level's
#   checkpoint namespace, and always **before** the node runs at that level. An
#   interrupt inside a subgraph therefore produces `ns=()` then
#   `ns=('child:…',)`, and the deepest of those is the graph that actually
#   paused — which is how the subgraph HOST node (a normal node at the shallower
#   level) is excluded.
# * only the level's first superstep re-runs interrupted tasks. A sibling that
#   had already succeeded in that superstep does not re-run at all, and
#   downstream nodes are at later steps.
#
# Deliberately decided at node **end** rather than start: a subgraph host node
# starts before the deeper `on_resume` that unmasks it, so at start time it is
# indistinguishable from the interrupted task. The cost is that `agent_resume`
# lands after the resumed node's own body, which adds that node's duration to
# the measured wait — a rounding error against a human, and the only alternative
# is guessing.


def _remote_of(info: _RunInfo) -> _RemoteResume | None:
    """The `_RemoteResume` of this run's root, if the root is one."""
    root = _STATE.runs.get(info.root) if info.root else None
    return root.remote if root is not None else None


def _interrupt_id_of(ns: str) -> str | None:
    if _Interrupt is None or not ns:
        return None
    try:
        return str(_Interrupt.from_ns(None, ns).id)
    except Exception:  # pragma: no cover - a future langgraph changing the shape
        logger.debug("failproofai_sdk: could not derive an interrupt id", exc_info=True)
        return None


def _close_remote_pause(info: _RunInfo, meta: dict) -> None:
    """`agent_resume` + `human_input` for a pause this process never opened."""
    remote = _remote_of(info)
    session = info.session
    if remote is None or session is None or remote.deepest is None:
        return
    parts = _ns_parts(meta)
    level = tuple(parts[:-1])
    if level != remote.deepest:
        return
    if meta.get("langgraph_step") != remote.levels.get(level):
        return
    pause_id = _interrupt_id_of(meta.get("langgraph_checkpoint_ns") or "")
    if pause_id is None or pause_id in remote.done:
        return
    remote.done.add(pause_id)
    marker = fw_fields(interrupt_id=pause_id, resumed_elsewhere=True)
    _emit_on_agent(
        session, "agent_resume", pause_id=pause_id, reason="langgraph_resume", **marker
    )
    _emit_on_agent(
        session,
        "human_input",
        input_id=pause_id,
        response=_answer_for(remote.value, pause_id),
        **marker,
    )


# ---------------------------------------------------------------------------
# The handler
# ---------------------------------------------------------------------------

class FailproofAITracer(BaseTracer, _GraphBase):
    """The single sync handler. Zero-arg, cheap, and stateless by design.

    Every override is one of two shapes:

    * ``_start_trace`` / ``_end_trace`` — call `super()` and hand the assembled
      `Run` to a module-level translator wrapped in `_core.safe`. `super()` is
      called **unconditionally and outside** our own work, so a bug in the
      translator can never skip LangChain's own bookkeeping.
    * ``on_*`` — stash the one thing the `Run` object does not preserve (the
      exception object, the `LLMResult`, the un-flattened chat messages), then
      delegate. These exist because `Run.error` is a formatted traceback rather
      than the exception, and we need `isinstance(exc, GraphBubbleUp)` to tell a
      human-approval pause from a failure.

    Nothing here holds a contextvar token: `ContextVar.reset()` raises across
    tasks as well as threads, and every one of these callbacks can land on a
    different task from the one that opened the run.
    """

    # Non-negotiable. See the module docstring: without it AsyncCallbackManager
    # dispatches us through run_in_executor and can reorder our callbacks.
    run_inline = True

    @property
    def raise_error(self) -> bool:  # type: ignore[override]
        """False normally; True under FAILPROOFAI_SDK_STRICT.

        Normally False so an adapter bug can never take down the customer's
        graph: LangChain catches, logs and swallows handler exceptions, and
        `_core.safe` does the same one layer further in.

        But that firewall also made `FAILPROOFAI_SDK_STRICT=1` inert *specifically
        here*. `safe()` re-raises under strict, and LangChain's `handle_event`
        then caught it and logged "Error in FailproofAITracer.<cb> callback", so
        the fault never reached the caller and the escape hatch silently did
        nothing on the one adapter people are most likely to debug. Following
        strict mode restores it. Read per callback by LangChain, so toggling
        the env var takes effect without re-instrumenting.
        """
        return _core.strict()

    def _persist_run(self, run: Any) -> None:
        """Required by `BaseTracer`; we stream, so there is nothing to persist."""

    def _start_trace(self, run: Any) -> None:
        super()._start_trace(run)
        _on_start(run)

    def _end_trace(self, run: Any) -> None:
        _on_end(run)
        super()._end_trace(run)

    def on_chat_model_start(
        self,
        serialized: dict,
        messages: list,
        *,
        run_id: Any,
        tags: list | None = None,
        parent_run_id: Any = None,
        metadata: dict | None = None,
        name: str | None = None,
        **kwargs: Any,
    ) -> Any:
        _stash_messages(run_id, messages)
        return super().on_chat_model_start(
            serialized,
            messages,
            run_id=run_id,
            tags=tags,
            parent_run_id=parent_run_id,
            metadata=metadata,
            name=name,
            **kwargs,
        )

    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> Any:
        _stash(run_id, response)
        return super().on_llm_end(response, run_id=run_id, **kwargs)

    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        _stash_error(run_id, error)
        return super().on_llm_error(error, run_id=run_id, **kwargs)

    def on_chain_error(
        self, error: BaseException, *, inputs: dict | None = None, run_id: Any, **kwargs: Any
    ) -> Any:
        _stash_error(run_id, error)
        return super().on_chain_error(error, inputs=inputs, run_id=run_id, **kwargs)

    def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        _stash_error(run_id, error)
        return super().on_tool_error(error, run_id=run_id, **kwargs)

    def on_retriever_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        _stash_error(run_id, error)
        return super().on_retriever_error(error, run_id=run_id, **kwargs)

    def _on_llm_new_token(self, run: Any, token: Any, chunk: Any) -> None:
        """Folded into the closing `model_response`. **Never** an event.

        A 500-token response would otherwise be 500 stored rows and 500 rail
        rows against a five-lane cap. Langfuse uses this callback only to stamp
        time-to-first-token; so do we.
        """
        _count_token(run)

    def on_interrupt(self, event: Any) -> None:
        _on_interrupt(event)

    def on_resume(self, event: Any) -> None:
        _on_resume(event)


# The translators, each individually guarded. `safe()` catches `Exception` and
# **not** `BaseException`: `CancelledError`, `KeyboardInterrupt` and
# `SystemExit` are BaseExceptions, and swallowing them here would silently break
# cancellation in every instrumented async application.
_on_start = safe(_on_start)
_on_end = safe(_on_end)


@safe
def _stash(run_id: Any, response: Any) -> None:
    with _STATE.lock:
        _STATE.responses[str(run_id)] = response


@safe
def _stash_messages(run_id: Any, messages: Any) -> None:
    # The one stash `_on_end` does not clean up after itself: it pops `rid` and
    # `messages:` is a different key, drained only by `_start_model`. So it is
    # the one that has to honour the kill switch too, or a torn-down adapter
    # grows a dict forever.
    if not _STATE.enabled:
        return
    with _STATE.lock:
        _STATE.responses["messages:" + str(run_id)] = _normalize_messages(messages)


@safe
def _stash_error(run_id: Any, error: BaseException) -> None:
    with _STATE.lock:
        _STATE.errors[str(run_id)] = error


@safe
def _count_token(run: Any) -> None:
    with _STATE.lock:
        info = _STATE.runs.get(str(run.id))
        if info is None:
            return
        info.chunks += 1
        if info.ttft_ms is None:
            start = getattr(run, "start_time", None)
            info.ttft_ms = ms(_now() - start) if start is not None else 0


@safe
def _on_interrupt(event: Any) -> None:
    with _STATE.lock:
        session = _session_for_run(getattr(event, "run_id", None))
        if session is None:
            return
        _suspend(session, getattr(event, "interrupts", ()) or ())


@safe
def _on_resume(event: Any) -> None:
    # Two jobs. The first is normally a no-op: the resuming root run starts
    # *before* langgraph drains its lifecycle queue, so `_start_root` has
    # already closed a pause this process opened. That is here for the ordering
    # not holding in some future version, and `_resume` returns immediately when
    # there is nothing open.
    #
    # The second is load-bearing, and is the only signal that separates the
    # subgraph HOST node from the task that actually paused: this event names
    # the Pregel level that is resuming, and fires once per level, deepest last.
    with _STATE.lock:
        info = _STATE.runs.get(str(getattr(event, "run_id", None) or ""))
        if info is None:
            return
        # `_remote_of` resolves through `info.root`, which a root run sets to
        # its own id, so this covers both the root's event and a subgraph's.
        remote = _remote_of(info)
        if remote is not None:
            level = tuple(getattr(event, "checkpoint_ns", ()) or ())
            if remote.deepest is None or len(level) >= len(remote.deepest):
                remote.deepest = level
        if info.session is not None:
            _resume(info.session, None)


# ---------------------------------------------------------------------------
# Install / uninstall
# ---------------------------------------------------------------------------

_HANDLER_VAR: contextvars.ContextVar = contextvars.ContextVar(
    "failproofai_langchain_handler", default=None
)

_hook_lock = threading.Lock()
_hook_registered = False

# The instance `install()` created, kept outside the ContextVar so that a worker
# thread — which starts with a fresh context and therefore an empty var — can
# still find it. `_configure` itself does not need this (it constructs a fresh
# zero-arg handler from the env var), but the graph-lifecycle wrap does, because
# langgraph filters on `isinstance`, not on a class.
_ACTIVE_HANDLER: Any = None


def _register_hook() -> None:
    """`register_configure_hook` exactly once per process.

    `_configure_hooks` is a module-level list with no removal API, so calling
    this twice means two entries — and although `_configure`'s `isinstance`
    dedup would keep the handler count at one, the list would grow on every
    `instrument()`/`uninstrument()` cycle in a reloading dev server.
    """
    global _hook_registered
    with _hook_lock:
        if _hook_registered:
            return
        register_configure_hook(_HANDLER_VAR, True, FailproofAITracer, ENV_VAR)
        _hook_registered = True


@safe
def _attach_graph_handler(manager: Any) -> None:
    handler = _HANDLER_VAR.get() or _ACTIVE_HANDLER
    if handler is None or manager is None:
        return
    handlers = getattr(manager, "handlers", None)
    if handlers is None or any(isinstance(h, FailproofAITracer) for h in handlers):
        return
    manager.add_handler(handler, True)


def _install_graph_callbacks(patcher: Patcher) -> bool:
    """Make `on_interrupt`/`on_resume` reach a globally-installed handler.

    Verified on langgraph 1.2.10: `Pregel.stream` calls
    `get_sync_graph_callback_manager_for_config(config)`, which filters the
    **raw** `config["callbacks"]` for `GraphCallbackHandler` instances. A
    handler injected by `register_configure_hook` is never in there — the hook
    runs inside `CallbackManager.configure`, which builds a *different*
    manager — so without this wrap the lifecycle callbacks are dead code for
    every user who did not pass the handler by hand. Worse, langgraph gates the
    feature entirely on `has_graph_lifecycle_callbacks=bool(manager.handlers)`.

    We patch the names as they are bound in `langgraph.pregel.main` (a
    `from ... import`, so patching `langgraph.callbacks` would have no effect)
    and only when they are still the same objects, so a refactor upstream
    degrades to "no lifecycle callbacks" rather than to a wrong patch.
    """
    import langgraph.callbacks as lgcb
    import langgraph.pregel.main as pmain

    names = (
        "get_sync_graph_callback_manager_for_config",
        "get_async_graph_callback_manager_for_config",
    )
    for name in names:
        bound = getattr(pmain, name, None)
        if bound is None or bound is not getattr(lgcb, name, None):
            return False
    for name in names:
        original = getattr(pmain, name)
        patcher.patch(
            pmain,
            name,
            # `wrap_callable` is the structural guarantee: the original call is
            # the only thing inside the try, and `_attach_graph_handler` runs
            # outside it and inside `call_safely`. The manager is mutated in
            # place, so nothing about the returned object changes.
            _core.wrap_callable(original, after=lambda _ctx, manager: _attach_graph_handler(manager)),
        )
    return True


class _Adapter:
    """The object `failproofai_sdk.integrations` looks for as `adapter`."""

    name = NAME
    module = MODULE

    def __init__(self) -> None:
        self._patcher = Patcher()
        self._handler: FailproofAITracer | None = None
        self._set_env = False

    def install(self, **options: Any) -> None:
        _compat.check_version(
            NAME,
            DIST,
            minimum="1.4.7",
            below="2",
            reason="langgraph 1.2's own floor; earlier cores lack the metadata this adapter reads",
        )
        _compat.check_version(NAME, "langgraph", minimum="1.2", below="2", reason="GraphCallbackHandler")

        _STATE.options = _read_options(options)
        _STATE.reset()
        _STATE.tracker = RunTracker(NAME, base_fields=_base_fields())
        _STATE.enabled = True

        global _ACTIVE_HANDLER
        _register_hook()
        self._handler = FailproofAITracer()
        _ACTIVE_HANDLER = self._handler
        _HANDLER_VAR.set(self._handler)
        # The ContextVar only reaches contexts derived from this one, so a
        # worker thread started later would not see it. The env var is what
        # covers those: `_configure` constructs a fresh zero-arg handler when
        # the var is empty, which is safe precisely because all state is in
        # `_STATE` rather than on the instance.
        if ENV_VAR not in os.environ:
            os.environ[ENV_VAR] = "1"
            self._set_env = True

        if _STATE.options.graph_callbacks and _GraphCallbackHandler is not None:
            if _compat.probe(NAME, "graph_lifecycle_callbacks", lambda: _install_graph_callbacks(self._patcher)):
                logger.debug("failproofai_sdk: langgraph interrupt/resume callbacks wired")

    def uninstall(self) -> None:
        # There is no deregister API for a configure hook — `_configure_hooks`
        # is append-only and private — so removal is "make the hook produce
        # nothing": flip the kill switch, clear the ContextVar, unset the env
        # var. The switch goes FIRST and is the only one of the three that
        # cannot be routed around (see `_State.enabled`); it is flipped before
        # `_close_everything()` because that path emits through the tracker
        # directly and never re-enters `_on_start`.
        global _ACTIVE_HANDLER
        _STATE.enabled = False
        _ACTIVE_HANDLER = None
        _HANDLER_VAR.set(None)
        if self._set_env:
            os.environ.pop(ENV_VAR, None)
            self._set_env = False
        self._patcher.restore_all()
        self._handler = None
        _close_everything()
        _STATE.reset()
        _STATE.options = _Options()


def _read_options(options: dict) -> _Options:
    include = options.get("include_chains") or ()
    if isinstance(include, str):
        include = (include,)
    unknown = set(options) - {"session_id", "include_chains", "capture_content", "graph_callbacks"}
    if unknown:
        # Not fatal: `instrument()` with no name installs every detected
        # adapter with the same **options, so an option meant for CrewAI
        # legitimately arrives here.
        logger.debug("failproofai_sdk: langchain adapter ignoring options %s", sorted(unknown))
    return _Options(
        session_id=options.get("session_id"),
        include_chains=frozenset(str(name) for name in include),
        capture_content=bool(options.get("capture_content", True)),
        graph_callbacks=bool(options.get("graph_callbacks", True)),
    )


def _close_everything() -> None:
    """Close every span still open at teardown, leaves before agents."""
    with _STATE.lock:
        roots = {info.root for info in _STATE.runs.values() if info.root}
        for root in roots:
            _close_open_leaves(root)
        _STATE.tracker.close_open_agents(outcome="cancelled")


adapter = _Adapter()
