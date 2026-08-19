"""CrewAI adapter — written against crewai 1.15.8 (2026-07-29), floor 1.13.0.

    import failproofai_sdk, crewai
    failproofai_sdk.instrument("crewai")
    crew.kickoff()

Everything here is a translation table over `crewai.events`. Identity,
correlation, payload budgets and the never-raise policy live in `_core`.

Five things about CrewAI that this file is shaped by, each verified against the
installed package rather than recalled:

1. **The module is `crewai.events`, not `crewai.utilities.events`.** The old
   shim was removed in 1.0.0.

2. **Handlers are keyed by EXACT type, with no MRO walk**
   (`event_bus._sync_handlers.get(type(event))`), so there is no `BaseEvent`
   catch-all to register. Every event class is registered individually, which
   is also what makes the anti-drift test possible.

3. **Our handlers are `async def`, and that is a correctness requirement, not a
   style choice.** `CrewAIEventsBus.emit()` dispatches *sync* handlers onto a
   ten-worker `ThreadPoolExecutor`; with more than one worker, submission order
   is not execution order. Measured on this version, 500 events through a sync
   handler come back **out of order every single run**, while the same 500
   through an async handler are strictly ordered — async handlers are scheduled
   with `run_coroutine_threadsafe` onto one background event loop, and
   `call_soon_threadsafe` is FIFO. Out-of-order handling would break two of the
   four rendering invariants at once: a `tool_result` could be written before
   its `tool_use`, and an `agent_start` before the root's. Keep these `async`.
   They must also never `await` anything, or that ordering guarantee is gone.

4. **`BaseEvent` already carries the span tree** — `event_id`,
   `parent_event_id`, and `started_event_id` on every `*Completed`/`*Failed`
   event. Verified populated on tool, LLM, agent, task and crew events here, so
   nesting is *read*, never reconstructed. (A per-`(role, tool)` LIFO is kept as
   a fallback for the case where the pairing stack has been unwound by an
   exception — that does happen, see 5.)

5. **CrewAI's own agent executor emits `FlowStartedEvent`/`FlowFinishedEvent`
   with `flow_name="AgentExecutor"`, nested inside every single
   `agent_execution_started`.** Mapping flow events to agents unconditionally —
   which is what the obvious reading of the API suggests — would put a spurious
   `AgentExecutor` agent inside every agent execution, doubling the span tree and
   poisoning the `agent_id` facet. A flow whose parent is an agent execution is
   therefore a pass-through link, not an agent. Its `flow_finished` is also
   *missing* when the agent's LLM call raises, so it can never be relied on to
   close anything.

`agent_id` is the crew name or the agent **role** — `LowCardinality(String)`,
the primary dashboard facet. CrewAI's `agent.id` is a UUID and goes to
`fw_agent_id`, never here.
"""

import json
import logging
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

from failproofai_sdk.integrations import _compat
from failproofai_sdk.integrations._core import (
    RunTracker,
    framework_fields,
    fw_fields,
    ms,
    normalize_agent_id,
    safe,
    truncate,
)

logger = logging.getLogger("failproofai_sdk.integrations")

__all__ = ["adapter", "FailproofAICrewListener"]

NAME = "crewai"
DIST = "crewai"

# 1.13.0 is the release where `started_event_id` and a normalized `usage` dict
# are both present; below it the span tree has to be reconstructed by hand.
MIN_VERSION = "1.13.0"
# Ceiling: without one, a clean build a year from now pulls the next major, the
# event classes shift, and this adapter stops recording while raising nothing.
BELOW_VERSION = "2"

_INSTALL_HINT = (
    "failproofai_sdk: cannot instrument 'crewai' because 'crewai.events' is not importable. "
    "Install it with:  pip install 'failproofai_sdk[crewai]'  (or install crewai>=1.13 directly). "
    "Note that the events package moved: it is 'crewai.events', not "
    "'crewai.utilities.events', which was removed in crewai 1.0.0."
)

try:  # only ever executed by `instrument("crewai")` — `import failproofai_sdk` never gets here
    from crewai.events import event_types as _ct
    from crewai.events.base_event_listener import BaseEventListener
    from crewai.events.event_bus import crewai_event_bus
except ImportError as _exc:  # pragma: no cover - exercised by uninstalling crewai
    raise ImportError(_INSTALL_HINT) from _exc


# ---------------------------------------------------------------------------
# The translation table
# ---------------------------------------------------------------------------

# event class name -> translator method name. One entry per class, because the
# bus does no MRO walk. Ordered as the dashboard reads them: structure, then
# leaves.
TABLE: tuple[tuple[str, str], ...] = (
    # --- structure: these become agent_start / agent_end -------------------
    ("CrewKickoffStartedEvent", "on_crew_started"),
    ("CrewKickoffCompletedEvent", "on_crew_completed"),
    ("CrewKickoffFailedEvent", "on_crew_failed"),
    ("FlowStartedEvent", "on_flow_started"),
    ("FlowFinishedEvent", "on_flow_finished"),
    ("AgentExecutionStartedEvent", "on_agent_started"),
    ("AgentExecutionCompletedEvent", "on_agent_completed"),
    ("AgentExecutionErrorEvent", "on_agent_error"),
    # --- structure we deliberately do NOT turn into spans ------------------
    # A CrewAI Task is a subset of the agent execution that runs it; emitting
    # both would double every row and render them as siblings. The task is
    # recorded as a link so its children still find the crew above them, and
    # its id/name ride along on the agent's own events as fw_task_*.
    ("TaskStartedEvent", "on_task_started"),
    ("TaskCompletedEvent", "on_task_finished"),
    ("TaskFailedEvent", "on_task_finished"),
    # --- framework machinery around the agent: hook pairs ------------------
    ("MethodExecutionStartedEvent", "on_method_started"),
    ("MethodExecutionFinishedEvent", "on_method_finished"),
    ("MethodExecutionFailedEvent", "on_method_failed"),
    ("LLMGuardrailStartedEvent", "on_guardrail_started"),
    ("LLMGuardrailCompletedEvent", "on_guardrail_completed"),
    # --- things the agent calls: tool pairs --------------------------------
    ("ToolUsageStartedEvent", "on_tool_started"),
    ("ToolUsageFinishedEvent", "on_tool_finished"),
    ("ToolUsageErrorEvent", "on_tool_error"),
    ("MemoryQueryStartedEvent", "on_store_started"),
    ("MemoryQueryCompletedEvent", "on_store_finished"),
    ("MemoryQueryFailedEvent", "on_store_failed"),
    ("MemorySaveStartedEvent", "on_store_started"),
    ("MemorySaveCompletedEvent", "on_store_finished"),
    ("MemorySaveFailedEvent", "on_store_failed"),
    ("MemoryRetrievalStartedEvent", "on_store_started"),
    ("MemoryRetrievalCompletedEvent", "on_store_finished"),
    ("MemoryRetrievalFailedEvent", "on_store_failed"),
    ("KnowledgeQueryStartedEvent", "on_store_started"),
    ("KnowledgeQueryCompletedEvent", "on_store_finished"),
    ("KnowledgeQueryFailedEvent", "on_store_failed"),
    ("KnowledgeRetrievalStartedEvent", "on_store_started"),
    ("KnowledgeRetrievalCompletedEvent", "on_store_finished"),
    ("KnowledgeSearchQueryFailedEvent", "on_store_failed"),
    # --- model calls -------------------------------------------------------
    ("LLMCallStartedEvent", "on_llm_started"),
    ("LLMCallCompletedEvent", "on_llm_completed"),
    ("LLMCallFailedEvent", "on_llm_failed"),
    # A streaming chunk emits NOTHING. A 500-token response would otherwise be
    # 500 stored rows and 500 rail rows against a five-lane cap. It is
    # folded into fw_chunks / fw_ttft_ms / fw_streamed on the model_response.
    ("LLMStreamChunkEvent", "on_llm_chunk"),
)

# Memory and knowledge operations are retrieval calls the agent makes, so they
# are tools, named for the surface they hit rather than the class that fired.
STORE_TOOLS: dict[str, str] = {
    "MemoryQueryStartedEvent": "memory.query",
    "MemoryQueryCompletedEvent": "memory.query",
    "MemoryQueryFailedEvent": "memory.query",
    "MemorySaveStartedEvent": "memory.save",
    "MemorySaveCompletedEvent": "memory.save",
    "MemorySaveFailedEvent": "memory.save",
    "MemoryRetrievalStartedEvent": "memory.retrieve",
    "MemoryRetrievalCompletedEvent": "memory.retrieve",
    "MemoryRetrievalFailedEvent": "memory.retrieve",
    "KnowledgeQueryStartedEvent": "knowledge.query",
    "KnowledgeQueryCompletedEvent": "knowledge.query",
    "KnowledgeQueryFailedEvent": "knowledge.query",
    "KnowledgeRetrievalStartedEvent": "knowledge.search",
    "KnowledgeRetrievalCompletedEvent": "knowledge.search",
    "KnowledgeSearchQueryFailedEvent": "knowledge.search",
}

# Flow names CrewAI uses for its own internal machinery. Belt and braces on top
# of the structural check in `on_flow_started` — the structural one is the rule,
# this is the fallback if a future release re-parents the executor flow.
INTERNAL_FLOW_NAMES = frozenset({"AgentExecutor"})

# Node kinds. "crew"/"flow"/"agent" are real Failproof AI agents; the rest are
# links that exist so a child can find the agent above it.
_AGENT_KINDS = frozenset({"crew", "flow", "agent"})

_MAX_NODES = 20_000
_MAX_LEAVES = 10_000
_MAX_STREAMS = 1_000


class _Node:
    """One CrewAI span, as far as we care about it."""

    __slots__ = ("kind", "parent", "task", "agent_id")

    def __init__(self, kind, parent, task=None, agent_id=None):
        self.kind = kind
        self.parent = parent
        self.task = task  # (task_id, task_name), inherited from the parent
        self.agent_id = agent_id


class _Leaf:
    """An emitted-but-unclosed leaf span: a tool, a model call, a hook.

    `agent_end` force-closes open *pauses* but not tools, models or humans, so a
    run that dies mid-tool leaves the session `ongoing` forever. Every open leaf
    is remembered here and closed when the span that owns it ends.
    """

    __slots__ = ("method", "key", "parent_key", "match", "started", "fields")

    def __init__(self, method, key, parent_key, match, started, fields):
        self.method = method
        self.key = key
        self.parent_key = parent_key
        self.match = match  # for the LIFO fallback when started_event_id is absent
        self.started = started
        self.fields = fields


class _CrewAIAdapter:
    """The object `failproofai_sdk.integrations` loads as `adapter`."""

    name = NAME
    module = "crewai"

    def __init__(self) -> None:
        # RLock: teardown resolves parents while already holding it.
        self._lock = threading.RLock()
        self._tracker: RunTracker | None = None
        self._listener: "FailproofAICrewListener | None" = None
        self._nodes: "OrderedDict[str, _Node]" = OrderedDict()
        self._leaves: "OrderedDict[str, _Leaf]" = OrderedDict()
        self._streams: "OrderedDict[str, list]" = OrderedDict()
        self._roots: list[str] = []
        self._session_id: str | None = None

    # -- install / uninstall ------------------------------------------------

    def install(self, **options: Any) -> None:
        """Register the listener on the module-level `crewai_event_bus`.

        `options` is whatever was passed to `failproofai_sdk.instrument()`, and the same
        dict reaches every adapter, so unknown keys are ignored rather than
        raising a TypeError that would take out the other frameworks.
        """
        _compat.check_version(
            NAME,
            DIST,
            minimum=MIN_VERSION,
            below=BELOW_VERSION,
            reason="started_event_id on *Completed events, and a normalized usage dict",
        )
        self._session_id = options.get("session_id")
        self._tracker = RunTracker(
            NAME,
            base_fields=framework_fields(NAME, DIST),
        )
        # Must be kept alive in a module-level global. `BaseEventListener` holds
        # no reference back from the bus other than the bound handlers, so a
        # listener that goes out of scope keeps "working" only by accident.
        self._listener = FailproofAICrewListener(self)

    def uninstall(self) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.teardown()
        # A run that is still open when the customer uninstruments would render
        # `ongoing` forever. Close it, then forget everything.
        self._close_everything(outcome="cancelled")
        with self._lock:
            self._nodes.clear()
            self._leaves.clear()
            self._streams.clear()
            self._roots.clear()
        if self._tracker is not None:
            self._tracker.reset()
        self._tracker = None

    # -- bookkeeping --------------------------------------------------------

    def _note(self, event_id, parent, kind, task=None, agent_id=None) -> None:
        with self._lock:
            while len(self._nodes) >= _MAX_NODES:
                self._nodes.pop(next(iter(self._nodes)), None)
            inherited = task
            if inherited is None and parent is not None:
                node = self._nodes.get(parent)
                inherited = node.task if node is not None else None
            self._nodes[event_id] = _Node(kind, parent, inherited, agent_id)

    def _parent_key(self, parent_event_id, *, allow_root_fallback: bool = True):
        """Which run a child should hang off.

        CrewAI's `parent_event_id` comes off a contextvar scope stack, and a
        `ThreadPoolExecutor` does not copy contextvars — so an `async_execution`
        task's events arrive with `parent_event_id=None`. Falling back to the
        open root keeps those events inside the session instead of minting a
        second one, which is the failure that splits one run into many.

        Root-capable events (`crew_kickoff_started`, `flow_started`) pass
        `allow_root_fallback=False`: for them a missing parent genuinely means
        "this is the top".
        """
        with self._lock:
            if parent_event_id is not None and parent_event_id in self._nodes:
                return parent_event_id
            if allow_root_fallback and self._roots:
                return self._roots[-1]
            return None

    def _task_of(self, event):
        """(task_id, task_name) for an event, from the event or its ancestors."""
        task_id = getattr(event, "task_id", None)
        task_name = getattr(event, "task_name", None)
        if task_id or task_name:
            return (task_id, task_name)
        with self._lock:
            node = self._nodes.get(getattr(event, "parent_event_id", None))
            return node.task if node is not None else None

    # -- leaf spans ---------------------------------------------------------

    def _open_leaf(self, method, key, parent_key, match, started, fields) -> None:
        with self._lock:
            while len(self._leaves) >= _MAX_LEAVES:
                self._leaves.pop(next(iter(self._leaves)), None)
            self._leaves[key] = _Leaf(method, key, parent_key, match, started, fields)

    def _pop_leaf(self, start_id, match):
        """The open leaf this ending event closes.

        `started_event_id` is the authority — it is populated on every
        `*Completed`/`*Failed` event on this version. The `match` scan is the
        documented fallback for the case where the scope stack was unwound by an
        exception before the ending event was emitted: last-opened wins, which is
        the right answer for a nested retry.
        """
        with self._lock:
            if start_id is not None:
                leaf = self._leaves.pop(start_id, None)
                if leaf is not None:
                    return leaf
            for key in reversed(self._leaves):
                if self._leaves[key].match == match:
                    return self._leaves.pop(key)
        return None

    def _descends_from(self, node_id, ancestor) -> bool:
        seen = set()
        key = node_id
        while key is not None and key not in seen:
            if key == ancestor:
                return True
            seen.add(key)
            node = self._nodes.get(key)
            key = node.parent if node is not None else None
        return False

    def _close_span(self, node_id, *, outcome, summary=None, **fields) -> None:
        """End an agent span, after closing everything still open beneath it."""
        tracker = self._tracker
        if tracker is None or node_id is None:
            return
        with self._lock:
            leaves = [
                leaf
                for leaf in reversed(list(self._leaves.values()))
                if self._descends_from(leaf.parent_key, node_id)
            ]
            for leaf in leaves:
                self._leaves.pop(leaf.key, None)
            descendants = [
                key
                for key in reversed(tracker.open_agents())
                if key != node_id and self._descends_from(key, node_id)
            ]
        for leaf in leaves:
            self._force_close(leaf)
        for key in descendants:
            tracker.end_agent(key, outcome="cancelled", **fw_fields(closed_by="teardown"))
        tracker.end_agent(node_id, outcome=outcome, summary=summary, **fields)
        with self._lock:
            self._roots = [key for key in self._roots if key != node_id]
            for key in [k for k in self._nodes if self._descends_from(k, node_id)]:
                self._nodes.pop(key, None)

    def _force_close(self, leaf) -> None:
        """Close a leaf whose framework never reported an end."""
        tracker = self._tracker
        if tracker is None:
            return
        fields = dict(leaf.fields)
        fields.update(fw_fields(incomplete=True, closed_by="teardown"))
        if leaf.method == "hook_completed":
            fields["outcome"] = "cancelled"
        if leaf.method == "model_response":
            # Invariant: EVERY model_response carries an int duration_ms, including
            # the ones we synthesize. Without it the dashboard shows no duration
            # for exactly the calls that went wrong.
            fields["duration_ms"] = ms(datetime.now(timezone.utc) - leaf.started)
        tracker.emit(leaf.method, leaf.key, parent_key=leaf.parent_key, **fields)

    def _close_everything(self, *, outcome: str) -> None:
        for node_id in list(reversed(self._roots)):
            self._close_span(node_id, outcome=outcome)
        tracker = self._tracker
        if tracker is None:
            return
        with self._lock:
            leaves = list(reversed(list(self._leaves.values())))
            self._leaves.clear()
        for leaf in leaves:
            self._force_close(leaf)
        tracker.close_open_agents(outcome=outcome)

    # -- crew ---------------------------------------------------------------

    @safe
    def on_crew_started(self, source, event) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        # A fresh uuid4 per kickoff, NOT crew.id: crew.id is stable across
        # kickoffs, so reusing it would merge every run of the same crew into one
        # never-ending session. RunTracker mints it when no parent and no
        # ambient scope supply one.
        parent = self._parent_key(event.parent_event_id, allow_root_fallback=False)
        agent_id = normalize_agent_id(getattr(event, "crew_name", None), default="crew")
        tracker.start_agent(
            event.event_id,
            agent_id=agent_id,
            parent_key=parent,
            session_id=self._session_id if parent is None else None,
            goal=_first_text(getattr(event, "inputs", None)),
            **fw_fields(
                kind="crew",
                crew_name=getattr(event, "crew_name", None),
                inputs=getattr(event, "inputs", None),
                event_id=event.event_id,
            ),
        )
        self._note(event.event_id, parent, "crew", agent_id=agent_id)
        with self._lock:
            if parent is None:
                self._roots.append(event.event_id)

    @safe
    def on_crew_completed(self, source, event) -> None:
        self._close_span(
            self._crew_key(event),
            outcome="success",
            summary=_text(getattr(event, "output", None)),
            **fw_fields(total_tokens=getattr(event, "total_tokens", None)),
        )

    @safe
    def on_crew_failed(self, source, event) -> None:
        # The error is reported on the span that OWNS it. No standalone `error`
        # event: `sessionSummary.errorCount` counts both, so emitting one here
        # would double-count every failed crew.
        self._close_span(
            self._crew_key(event),
            outcome="failed",
            summary=_text(getattr(event, "error", None)),
            **fw_fields(error=_text(getattr(event, "error", None))),
        )

    def _crew_key(self, event):
        """The crew span this ending event closes.

        `started_event_id` is set explicitly by `Crew._finish_execution`, so it
        is reliable; the root fallback exists because a session left with an open
        root `agent_start` renders `ongoing` forever, which is the single worst
        outcome available here.
        """
        with self._lock:
            node_id = getattr(event, "started_event_id", None)
            if node_id is not None and node_id in self._nodes:
                return node_id
            return self._roots[-1] if self._roots else None

    # -- flows --------------------------------------------------------------

    @safe
    def on_flow_started(self, source, event) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        parent_id = getattr(event, "parent_event_id", None)
        with self._lock:
            parent_node = self._nodes.get(parent_id) if parent_id else None
        internal = (parent_node is not None and parent_node.kind == "agent") or (
            getattr(event, "flow_name", None) in INTERNAL_FLOW_NAMES
        )
        if internal:
            # CrewAI's own agent executor. Link it so the LLM and tool events
            # underneath resolve to the agent, but emit nothing: it is not a
            # flow the user wrote, and its flow_finished is missing entirely
            # when the agent's LLM call raises.
            parent = self._parent_key(parent_id)
            tracker.link(event.event_id, parent)
            self._note(event.event_id, parent, "flow_internal")
            return
        parent = self._parent_key(parent_id, allow_root_fallback=False)
        agent_id = normalize_agent_id(getattr(event, "flow_name", None), default="flow")
        tracker.start_agent(
            event.event_id,
            agent_id=agent_id,
            parent_key=parent,
            session_id=self._session_id if parent is None else None,
            goal=_first_text(getattr(event, "inputs", None)),
            **fw_fields(
                kind="flow",
                flow_name=getattr(event, "flow_name", None),
                inputs=getattr(event, "inputs", None),
                event_id=event.event_id,
            ),
        )
        self._note(event.event_id, parent, "flow", agent_id=agent_id)
        with self._lock:
            if parent is None:
                self._roots.append(event.event_id)

    @safe
    def on_flow_finished(self, source, event) -> None:
        node_id = event.started_event_id
        with self._lock:
            node = self._nodes.get(node_id) if node_id else None
            if node is not None and node.kind == "flow_internal":
                self._nodes.pop(node_id, None)
                return
            if node is None:
                return
        self._close_span(
            node_id, outcome="success", summary=_text(getattr(event, "result", None))
        )

    # -- tasks: recorded, never emitted -------------------------------------

    @safe
    def on_task_started(self, source, event) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        parent = self._parent_key(event.parent_event_id)
        tracker.link(event.event_id, parent)
        task = (getattr(event, "task_id", None), getattr(event, "task_name", None))
        self._note(event.event_id, parent, "task", task=task)

    @safe
    def on_task_finished(self, source, event) -> None:
        with self._lock:
            self._nodes.pop(event.started_event_id, None)

    # -- agents -------------------------------------------------------------

    @safe
    def on_agent_started(self, source, event) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        agent = getattr(event, "agent", None)
        parent = self._parent_key(event.parent_event_id)
        # `event.agent_role` is None on this event (only the tool and LLM events
        # get it filled in), so the role comes off the agent object. The UUID in
        # `agent.id` must never reach agent_id.
        role = getattr(event, "agent_role", None) or getattr(agent, "role", None)
        agent_id = normalize_agent_id(role, default="agent")
        task = self._task_of(event) or (None, None)
        tracker.start_agent(
            event.event_id,
            agent_id=agent_id,
            parent_key=parent,
            goal=_text(getattr(agent, "goal", None)),
            **fw_fields(
                kind="agent",
                agent_id=str(getattr(agent, "id", "")) or None,
                agent_role=role,
                task_id=task[0],
                task_name=task[1],
                tools=_tool_names(getattr(event, "tools", None)),
                allow_delegation=getattr(agent, "allow_delegation", None),
                event_id=event.event_id,
            ),
        )
        self._note(event.event_id, parent, "agent", task=task, agent_id=agent_id)

    @safe
    def on_agent_completed(self, source, event) -> None:
        self._close_span(
            event.started_event_id,
            outcome="success",
            summary=_text(getattr(event, "output", None)),
        )

    @safe
    def on_agent_error(self, source, event) -> None:
        self._close_span(
            event.started_event_id,
            outcome="failed",
            summary=_text(getattr(event, "error", None)),
            **fw_fields(error=_text(getattr(event, "error", None))),
        )

    # -- flow methods and guardrails: hook pairs ----------------------------

    @safe
    def on_method_started(self, source, event) -> None:
        self._hook_start(
            event,
            hook_name=getattr(event, "method_name", None) or "flow_method",
            trigger_event="flow_method",
            input=_dictify(getattr(event, "params", None)),
            extra=fw_fields(flow_name=getattr(event, "flow_name", None)),
        )

    @safe
    def on_method_finished(self, source, event) -> None:
        self._hook_end(event, outcome="success", output=_text(getattr(event, "result", None)))

    @safe
    def on_method_failed(self, source, event) -> None:
        self._hook_end(
            event, outcome="failed", error=_text(getattr(event, "error", None))
        )

    @safe
    def on_guardrail_started(self, source, event) -> None:
        self._hook_start(
            event,
            hook_name=getattr(event, "guardrail_name", None) or "guardrail",
            trigger_event="guardrail",
            input=None,
            extra=fw_fields(
                guardrail_type=getattr(event, "guardrail_type", None),
                retry_count=getattr(event, "retry_count", None),
            ),
        )

    @safe
    def on_guardrail_completed(self, source, event) -> None:
        # "rejected" is in the server's failure vocabulary
        # (error|failed|timeout|rejected), so a tripped guardrail paints red
        # rather than reading as a successful hook that happened to say no.
        passed = bool(getattr(event, "success", False))
        self._hook_end(
            event,
            outcome="success" if passed else "rejected",
            output=_text(getattr(event, "result", None)),
            error=_text(getattr(event, "error", None)),
            extra=fw_fields(retry_count=getattr(event, "retry_count", None)),
        )

    def _hook_start(self, event, *, hook_name, trigger_event, input, extra) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        parent = self._parent_key(event.parent_event_id)
        fields = dict(
            hook_name=hook_name,
            hook_id=event.event_id,
            trigger_event=trigger_event,
            input=input,
            **extra,
        )
        tracker.emit("hook_triggered", event.event_id, parent_key=parent, **fields)
        self._open_leaf(
            "hook_completed",
            event.event_id,
            parent,
            ("hook", hook_name),
            event.timestamp,
            {"hook_name": hook_name, "hook_id": event.event_id},
        )

    def _hook_end(self, event, *, outcome, output=None, error=None, extra=None) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        leaf = self._pop_leaf(event.started_event_id, ("hook", _hook_name_of(event)))
        if leaf is None:
            return
        # duration_ms is auto-computed by the SDK from the hook_triggered we
        # emitted, and is hard-rejected from callers on hook_completed.
        tracker.emit(
            "hook_completed",
            leaf.key,
            parent_key=leaf.parent_key,
            hook_name=leaf.fields["hook_name"],
            hook_id=leaf.fields["hook_id"],
            outcome=outcome,
            output=output,
            error=error,
            **(extra or {}),
        )

    # -- tools --------------------------------------------------------------

    @safe
    def on_tool_started(self, source, event) -> None:
        self._tool_start(
            event,
            tool_name=getattr(event, "tool_name", None) or "tool",
            input=_dictify(getattr(event, "tool_args", None)),
            extra=fw_fields(
                tool_class=getattr(event, "tool_class", None),
                run_attempts=getattr(event, "run_attempts", None),
                agent_role=getattr(event, "agent_role", None),
                agent_id=getattr(event, "agent_id", None),
            ),
        )

    @safe
    def on_tool_finished(self, source, event) -> None:
        self._tool_end(
            event,
            output=_text(getattr(event, "output", None)),
            error=None,
            extra=fw_fields(
                from_cache=getattr(event, "from_cache", None),
                run_attempts=getattr(event, "run_attempts", None),
            ),
        )

    @safe
    def on_tool_error(self, source, event) -> None:
        # A tool failure the agent loop catches and retries is not a run-level
        # error, so it is reported on the tool_result and nowhere else.
        self._tool_end(
            event,
            output=None,
            error=_text(getattr(event, "error", None)) or "tool failed",
            extra=fw_fields(run_attempts=getattr(event, "run_attempts", None)),
        )

    @safe
    def on_store_started(self, source, event) -> None:
        name = STORE_TOOLS.get(type(event).__name__, "memory")
        self._tool_start(
            event,
            tool_name=name,
            input=_dictify(getattr(event, "query", None) or getattr(event, "value", None)),
            extra=fw_fields(limit=getattr(event, "limit", None), store=name),
        )

    @safe
    def on_store_finished(self, source, event) -> None:
        results = (
            getattr(event, "results", None)
            or getattr(event, "memory_content", None)
            or getattr(event, "retrieved_knowledge", None)
        )
        self._tool_end(
            event,
            output=truncate(results),
            error=None,
            extra=fw_fields(
                query_time_ms=getattr(event, "query_time_ms", None),
                save_time_ms=getattr(event, "save_time_ms", None),
                retrieval_time_ms=getattr(event, "retrieval_time_ms", None),
            ),
        )

    @safe
    def on_store_failed(self, source, event) -> None:
        self._tool_end(
            event,
            output=None,
            error=_text(getattr(event, "error", None)) or "store operation failed",
            extra={},
        )

    def _tool_start(self, event, *, tool_name, input, extra) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        parent = self._parent_key(event.parent_event_id)
        # tool_call_id is CrewAI's own event_id, verbatim: it is a uuid4, so it
        # cannot collide inside `_pending`, and it lines our rows up with the
        # framework's own logs.
        tracker.emit(
            "tool_use",
            event.event_id,
            parent_key=parent,
            tool_name=tool_name,
            tool_call_id=event.event_id,
            input=input,
            **extra,
        )
        self._open_leaf(
            "tool_result",
            event.event_id,
            parent,
            ("tool", getattr(event, "agent_role", None), tool_name),
            event.timestamp,
            {"tool_name": tool_name, "tool_call_id": event.event_id},
        )

    def _tool_end(self, event, *, output, error, extra) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        name = getattr(event, "tool_name", None) or STORE_TOOLS.get(
            type(event).__name__, "tool"
        )
        leaf = self._pop_leaf(
            event.started_event_id, ("tool", getattr(event, "agent_role", None), name)
        )
        if leaf is None:
            return
        # duration_ms is hard-rejected on tool_result and is computed by the SDK
        # from the tool_use we emitted a moment ago.
        tracker.emit(
            "tool_result",
            leaf.key,
            parent_key=leaf.parent_key,
            tool_name=leaf.fields["tool_name"],
            tool_call_id=leaf.fields["tool_call_id"],
            output=output,
            error=error,
            **extra,
        )

    # -- model calls --------------------------------------------------------

    @safe
    def on_llm_started(self, source, event) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        parent = self._parent_key(event.parent_event_id)
        call_id = getattr(event, "call_id", None) or event.event_id
        task = self._task_of(event) or (None, None)
        tracker.emit(
            "model_request",
            event.event_id,
            parent_key=parent,
            model=getattr(event, "model", None),
            messages=_messages(getattr(event, "messages", None)),
            tools=_listify(getattr(event, "tools", None)),
            request_id=call_id,
            **fw_fields(
                call_id=call_id,
                temperature=getattr(event, "temperature", None),
                max_tokens=getattr(event, "max_tokens", None),
                stream=getattr(event, "stream", None),
                task_id=task[0],
                task_name=task[1],
            ),
        )
        self._open_leaf(
            "model_response",
            event.event_id,
            parent,
            ("llm", call_id),
            event.timestamp,
            {"model": getattr(event, "model", None), "request_id": call_id},
        )

    @safe
    def on_llm_completed(self, source, event) -> None:
        usage = getattr(event, "usage", None)
        input_tokens, output_tokens, normalized = _tokens(usage)
        self._model_end(
            event,
            content=_text(getattr(event, "response", None)),
            stop_reason=getattr(event, "finish_reason", None),
            error=None,
            extra=dict(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                usage=normalized or None,
                **fw_fields(
                    usage_raw=usage if isinstance(usage, dict) else None,
                    response_id=getattr(event, "response_id", None),
                    call_type=_enum_value(getattr(event, "call_type", None)),
                ),
            ),
        )

    @safe
    def on_llm_failed(self, source, event) -> None:
        # Reported on the model_response, which is why `error` was added to that
        # event: a failed LLM call otherwise paints the row red but not the span.
        self._model_end(
            event,
            content=None,
            stop_reason="error",
            error=_text(getattr(event, "error", None)) or "llm call failed",
            extra={},
        )

    def _model_end(self, event, *, content, stop_reason, error, extra) -> None:
        tracker = self._tracker
        if tracker is None:
            return
        call_id = getattr(event, "call_id", None)
        leaf = self._pop_leaf(event.started_event_id, ("llm", call_id))
        if leaf is None:
            return
        stream = self._pop_stream(call_id)
        fields = dict(extra)
        if stream is not None:
            chunks, first_ts = stream
            fields.update(
                fw_fields(
                    streamed=True,
                    chunks=chunks,
                    ttft_ms=ms(first_ts - leaf.started) if first_ts is not None else None,
                )
            )
        # duration_ms is NOT guarded on model_response, and `durationOf` prefers
        # the closing event's value over end-start — which is what keeps model
        # durations honest even when the dashboard's FIFO pairing brackets the
        # wrong pair. It must be an int: the server's JSON parser drops floats
        # and would silently NULL the column.
        tracker.emit(
            "model_response",
            leaf.key,
            parent_key=leaf.parent_key,
            model=getattr(event, "model", None) or leaf.fields["model"],
            request_id=leaf.fields["request_id"],
            content=content,
            stop_reason=stop_reason,
            error=error,
            duration_ms=ms(event.timestamp - leaf.started),
            **fields,
        )

    @safe
    def on_llm_chunk(self, source, event) -> None:
        """Emits nothing. Counts chunks and stamps time-to-first-token, once."""
        key = getattr(event, "call_id", None) or getattr(event, "parent_event_id", None)
        if key is None:
            return
        with self._lock:
            entry = self._streams.get(key)
            if entry is None:
                while len(self._streams) >= _MAX_STREAMS:
                    self._streams.pop(next(iter(self._streams)), None)
                self._streams[key] = [1, event.timestamp]
            else:
                entry[0] += 1

    def _pop_stream(self, call_id):
        if call_id is None:
            return None
        with self._lock:
            entry = self._streams.pop(call_id, None)
        return (entry[0], entry[1]) if entry else None


# ---------------------------------------------------------------------------
# The listener
# ---------------------------------------------------------------------------

class FailproofAICrewListener(BaseEventListener):
    """Registers one handler per event class on the module-level bus.

    `BaseEventListener.__init__` is what performs the registration (it calls
    `setup_listeners` with the `crewai_event_bus` singleton), so constructing
    the instance *is* the install step — and the instance has to be kept alive
    by the adapter or it is garbage collected and silently stops working.

    Every handler is `async def` for the ordering reason in the module
    docstring, and does nothing but call a `safe`-wrapped translator, so a bug
    in this file can never take down the customer's crew.
    """

    def __init__(self, adapter: _CrewAIAdapter) -> None:
        self._adapter = adapter
        self._registered: list[tuple[type, Any]] = []
        super().__init__()

    def setup_listeners(self, crewai_event_bus) -> None:
        for class_name, method_name in TABLE:
            event_class = getattr(_ct, class_name, None)
            if event_class is None:
                # Tier 3: one missing event class disables one hook, never the
                # whole adapter — the other 90% of the events are still correct.
                _compat.probe(NAME, class_name, lambda: False)
                continue
            handler = self._make_handler(getattr(self._adapter, method_name), method_name)
            crewai_event_bus.register_handler(event_class, handler)
            self._registered.append((event_class, handler))

    @staticmethod
    def _make_handler(translator, method_name):
        async def _failproofai_handler(source, event):
            translator(source, event)

        _failproofai_handler.__name__ = f"failproofai_{method_name}"
        _failproofai_handler.__qualname__ = f"failproofai_sdk.crewai.{method_name}"
        return _failproofai_handler

    def teardown(self) -> None:
        """`crewai_event_bus.off()` for everything `setup_listeners` added."""
        for event_class, handler in self._registered:
            try:
                crewai_event_bus.off(event_class, handler)
            except Exception:  # pragma: no cover - teardown must never raise
                logger.warning(
                    "failproofai_sdk: could not unregister the crewai handler for %s",
                    getattr(event_class, "__name__", event_class),
                    exc_info=True,
                )
        self._registered.clear()

    def handlers(self) -> tuple[tuple[type, Any], ...]:
        """(event class, handler) pairs currently registered. For tests."""
        return tuple(self._registered)


# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------

def _text(value) -> "str | None":
    if value is None:
        return None
    if isinstance(value, str):
        return truncate(value)
    raw = getattr(value, "raw", None)
    return truncate(raw if isinstance(raw, str) else str(value))


def _first_text(mapping) -> "str | None":
    """A goal string for a crew or flow, from whatever inputs it was given."""
    if isinstance(mapping, dict):
        for value in mapping.values():
            if isinstance(value, str) and value.strip():
                return truncate(value)
    return None


def _dictify(value) -> "dict | None":
    """`input=` is declared `dict | None`; a bare string would break the shape.

    CrewAI hands `tool_args` over as the raw JSON string the model produced, so
    it is decoded when it decodes: an object in the payload is queryable with
    `payload_key_expr`, a JSON-string-inside-a-string is not.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return truncate(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("{"):
            try:
                decoded = json.loads(stripped)
            except ValueError:
                decoded = None
            if isinstance(decoded, dict):
                return truncate(decoded)
        return {"input": truncate(value)}
    return {"input": truncate(str(value))}


def _listify(value) -> "list | None":
    if value is None:
        return None
    return truncate(list(value) if isinstance(value, (list, tuple)) else [value])


def _messages(value) -> "list | None":
    """`messages=` is declared `list[dict]`; CrewAI also allows a bare string."""
    if value is None:
        return None
    if isinstance(value, str):
        return [{"role": "user", "content": truncate(value)}]
    return _listify(value)


def _tool_names(tools) -> "list | None":
    if not tools:
        return None
    return [getattr(tool, "name", None) or type(tool).__name__ for tool in tools]


def _enum_value(value):
    return getattr(value, "value", value) if value is not None else None


def _hook_name_of(event) -> "str | None":
    return (
        getattr(event, "method_name", None)
        or getattr(event, "guardrail_name", None)
        or "guardrail"
    )


# The usage dict is whatever the provider returned, so both spellings are in the
# wild and neither is guaranteed. Reading only one of them reports zero tokens
# for half the providers, at HTTP 200, forever.
_INPUT_KEYS = ("prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
_OUTPUT_KEYS = ("completion_tokens", "output_tokens", "completionTokens", "outputTokens")
_TOTAL_KEYS = ("total_tokens", "totalTokens")


def _tokens(usage):
    """(input_tokens, output_tokens, normalized_usage_dict)."""
    if not isinstance(usage, dict):
        return None, None, {}
    input_tokens = _count(usage, _INPUT_KEYS)
    output_tokens = _count(usage, _OUTPUT_KEYS)
    total = _count(usage, _TOTAL_KEYS)
    if total is None and (input_tokens is not None or output_tokens is not None):
        total = (input_tokens or 0) + (output_tokens or 0)
    normalized = {}
    for key, value in (
        ("input_tokens", input_tokens),
        ("output_tokens", output_tokens),
        ("total_tokens", total),
    ):
        if value is not None:
            normalized[key] = value
    return input_tokens, output_tokens, normalized


def _count(usage, keys):
    for key in keys:
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


adapter = _CrewAIAdapter()
