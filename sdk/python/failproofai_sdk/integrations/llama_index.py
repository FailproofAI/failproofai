"""LlamaIndex adapter — written against llama-index-core 0.14.23 (2026-07-29).

    import failproofai_sdk
    from llama_index.core.agent.workflow import FunctionAgent

    failproofai_sdk.instrument("llama_index")
    await FunctionAgent(name="researcher", tools=[...], llm=llm).run("...")

Everything is registered on the **root dispatcher** (`get_dispatcher()` with no
argument). Child dispatchers propagate upward, so one handler pair on the root
sees every span and every event in the process — no per-object wiring, no call
site changes.

What most tutorials (and several shipping vendors) get wrong here
-----------------------------------------------------------------
Each of these was verified against the installed package, not recalled:

1. ``llama_index.core.instrumentation`` is a **shim** over the separately
   released ``llama-index-instrumentation`` distribution. Import through the
   ``llama_index.core`` path anyway — it is the stable name.

2. **The classic agent events are dead.** ``AgentRunStepStartEvent``,
   ``AgentChatWithStepStartEvent`` and ``AgentToolCallEvent`` still *import*,
   but nothing has emitted them since the 0.13.0 agent rewrite, so an adapter
   built on them records nothing and raises nothing. Agent structure now lives
   in the **workflow** stream, and we reach the typed objects through the span
   handler: a workflow step span carries its input event in
   ``bound_args.arguments["ev"]`` and hands back its output event as the span
   ``result``. That is where ``AgentInput`` / ``AgentSetup`` / ``AgentOutput`` /
   ``ToolCall`` / ``ToolCallResult`` actually are.

3. **The dispatcher swallows handler exceptions** with a bare
   ``except BaseException: pass`` **and no logging** (verified in
   ``llama_index_instrumentation.dispatcher``). A bug in a handler is therefore
   completely invisible. Every entry point below is wrapped in ``_core.safe``,
   whose whole job is to log the thing the dispatcher would have eaten.

4. **Never read ``event.model_dict["model"]``.** PR #22130 (shipped in 0.14.23)
   replaced ``to_dict()`` with ``to_payload()`` and the ``"model"`` key is gone;
   reading it yields ``None`` silently. Traceloop and MLflow are broken on this
   today. We read ``instance.metadata.model_name`` off the LLM span instead, and
   only fall back to ``model_dict.get("model_name")``.

5. ``new_span`` takes **``parent_span_id``** while ``span_enter`` takes
   ``parent_id``. Getting that wrong gives a flat trace with no error.

6. Teardown needs **in-place slice assignment** — ``add_span_handler`` does
   ``self.span_handlers += [h]``, so a plain ``=`` rebinds a pydantic field and
   other handlers can be lost.

Mapping
-------
============================  ==========================================
LlamaIndex                    Failproof AI
============================  ==========================================
``Workflow.run`` root span    session + ``agent_start``/``agent_end``
nested ``Workflow.run`` span  nested ``agent_start``/``agent_end``
workflow step span            ``hook_triggered``/``hook_completed``
                              (``trigger_event="workflow_step"``)
``LLMChatStart/EndEvent``     ``model_request``/``model_response``
                              (``request_id=event.span_id``)
``FunctionTool.call`` span    ``tool_use``/``tool_result``
``RetrievalStart/EndEvent``   ``tool_use``/``tool_result``, output summarized
embeddings                    nothing, unless ``embeddings=True``
``WaitingForEvent`` drop      ``human_wait``+``agent_pause``, then
                              ``agent_resume``+``human_input`` on retry
============================  ==========================================

``agent_id`` is the ``FunctionAgent.name`` when there is one and the workflow
class name otherwise — never a span id. It is a ``LowCardinality`` column and
the primary dashboard facet; a uuid in it poisons that facet permanently.

Token fidelity is genuinely lower on LlamaIndex than on the other frameworks
-----------------------------------------------------------------------------
There is no standard usage field. We try ``response.raw["usage"]``, then
``raw["usage_metadata"]``, then ``response.additional_kwargs``, calling
``model_dump()`` first when ``raw`` is a pydantic model. The top-level
``input_tokens``/``output_tokens`` are set **only** when a key we recognise is
present; the raw dict always ships as ``usage`` so the server and the dashboard
can both fall back to it. A model integration that names its counters something
new will show a populated ``usage`` and blank token columns — that is the
honest outcome, and much better than a confident wrong number.

Known gap: human-in-the-loop is only visible when the wait happens **inside a
tool**. ``ctx.wait_for_event`` in a plain workflow step is caught by the runtime
before it reaches the dispatcher, so that step simply exits with ``None`` and
re-runs later; there is no signal to key a pause on. The FunctionAgent pattern
(the one LlamaIndex documents) waits inside a tool and is captured.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from failproofai_sdk.integrations import _compat, _core

FRAMEWORK = "llama_index"
DIST = "llama-index-core"
EXTRA = "llamaindex"

# 0.14.23 is a CAPABILITY floor, not a guess: it is the release where
# `to_payload()` replaced `to_dict()` (PR #22130) and where the workflow event
# stream carries the typed agent events this adapter reads. Below it, model
# names and agent structure both go missing.
MIN_VERSION = "0.14.23"
BELOW_VERSION = "0.15"

# "{ClassName}.{method}-{uuid4}" — the dispatcher's span id format.
_SPAN_ID = re.compile(
    r"^(?P<cls>[^.]+)\.(?P<method>.+)"
    r"-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# LLM methods worth an event. `_`-prefixed methods (`_prepare_chat_with_tools`)
# are framework plumbing and are ignored everywhere.
_LLM_METHODS = frozenset(
    {
        "chat",
        "achat",
        "stream_chat",
        "astream_chat",
        "complete",
        "acomplete",
        "stream_complete",
        "astream_complete",
        "predict",
        "apredict",
    }
)

_SUMMARY_LIMIT = 512
_MAX_SPANS = 20_000
_MAX_NODES_IN_SUMMARY = 5

# Token key aliases, widest first. LlamaIndex normalises nothing, so this is the
# union of what the popular model integrations actually put in `raw`.
_INPUT_TOKEN_KEYS = (
    "prompt_tokens",
    "input_tokens",
    "inputTokens",
    "prompt_token_count",
    "promptTokenCount",
)
_OUTPUT_TOKEN_KEYS = (
    "completion_tokens",
    "output_tokens",
    "outputTokens",
    "candidates_token_count",
    "candidatesTokenCount",
)


# ---------------------------------------------------------------------------
# Helpers — no framework import in any of these
# ---------------------------------------------------------------------------

def _span_parts(span_id: str) -> tuple[str, str]:
    """`("FunctionAgent", "run")` from a dispatcher span id. Never raises."""
    match = _SPAN_ID.match(span_id or "")
    if match is None:
        text = str(span_id or "")
        head = text.rsplit("-", 5)[0] if "-" in text else text
        cls, _, method = head.partition(".")
        return cls, method or head
    return match.group("cls"), match.group("method")


def _summarize(value: Any, limit: int = _SUMMARY_LIMIT) -> str | None:
    """A short, human-readable rendering. `None` in, `None` out."""
    if value is None:
        return None
    try:
        text = str(value)
    except Exception:
        text = repr(value)
    if not text:
        # Several workflow events override `__str__` to return the response
        # text, which is empty on a pure tool-call turn — and a free-form
        # `Event(prefix="ok?")` keeps its payload in `_data`, so both `str()`
        # and `repr()` render it as `InputRequiredEvent()`. An empty string in
        # the dashboard reads as "we captured nothing".
        try:
            data = getattr(value, "_data", None)
            if isinstance(data, dict) and data:
                text = f"{type(value).__name__}({data})"
            else:
                text = repr(value)
        except Exception:
            text = type(value).__name__
    return _core.truncate(text, limit)


def _as_dict(value: Any) -> dict | None:
    """A dict view of a pydantic model, a dict, or nothing."""
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump()
        except Exception:
            return None
        return dumped if isinstance(dumped, dict) else None
    return None


def _first_int(source: dict, keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        # Bedrock hands back list-valued counts on some models.
        if isinstance(value, (list, tuple)) and len(value) == 1:
            inner = value[0]
            if isinstance(inner, int) and not isinstance(inner, bool):
                return inner
    return None


def extract_usage(response: Any) -> tuple[dict | None, int | None, int | None]:
    """`(usage_dict, input_tokens, output_tokens)` from a ChatResponse.

    Deliberately conservative: the token ints are returned **only** when a key
    we recognise is present. Everything found ships as `usage` regardless, so a
    model whose counters we cannot name still reports something the server's
    summary and the dashboard can fall back to.
    """
    if response is None:
        return None, None, None
    raw = _as_dict(getattr(response, "raw", None)) or {}
    additional = getattr(response, "additional_kwargs", None)
    additional = additional if isinstance(additional, dict) else {}

    usage: dict | None = None
    for candidate in (raw.get("usage"), raw.get("usage_metadata"), additional.get("usage")):
        as_dict = _as_dict(candidate)
        if as_dict:
            usage = as_dict
            break
    if usage is None and any(k in additional for k in _INPUT_TOKEN_KEYS + _OUTPUT_TOKEN_KEYS):
        usage = {
            k: v for k, v in additional.items() if k in _INPUT_TOKEN_KEYS + _OUTPUT_TOKEN_KEYS
        }
    if not usage:
        return None, None, None
    return usage, _first_int(usage, _INPUT_TOKEN_KEYS), _first_int(usage, _OUTPUT_TOKEN_KEYS)


def _messages(items: Any) -> list[dict] | None:
    """ChatMessages -> the list-of-dicts `model_request(messages=...)` wants."""
    if not isinstance(items, (list, tuple)):
        return None
    out: list[dict] = []
    for item in items:
        role = getattr(item, "role", None)
        out.append(
            {
                "role": getattr(role, "value", None) or str(role or "user"),
                "content": _summarize(getattr(item, "content", None) or ""),
            }
        )
    return out or None


def summarize_nodes(nodes: Any) -> dict:
    """A retrieval result small enough to store.

    Retrieved documents are the largest strings in the process and the payload
    is not a promoted column, so querying it means `JSONExtract` over the whole
    blob. We keep the count, the scores and a prefix of the top few.
    """
    items = list(nodes) if isinstance(nodes, (list, tuple)) else []
    top = []
    for node in items[:_MAX_NODES_IN_SUMMARY]:
        inner = getattr(node, "node", node)
        text = None
        getter = getattr(inner, "get_content", None)
        if callable(getter):
            try:
                text = getter()
            except Exception:
                text = None
        if text is None:
            text = getattr(inner, "text", None)
        top.append(
            {
                "id": _summarize(getattr(inner, "node_id", None), 128),
                "score": getattr(node, "score", None),
                "text": _core.truncate(str(text or ""), 200),
            }
        )
    return {"num_nodes": len(items), "top": top}


def _error_text(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def _is_waiting(exc: BaseException | None) -> bool:
    """True for the runtime's `WaitingForEvent` — a PAUSE, never an error.

    Name-based on purpose. `WaitingForEvent` lives in
    `workflows.runtime.types.results`, is not re-exported from
    `workflows.errors`, and has moved before; an `isinstance` against an import
    that quietly failed would go always-False and turn every human-in-the-loop
    pause into a red error event, which is exactly the failure this adapter
    exists to avoid.
    """
    if exc is None:
        return False
    return any(cls.__name__ == "WaitingForEvent" for cls in type(exc).__mro__)


def _is_cancellation(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    names = {cls.__name__ for cls in type(exc).__mro__}
    return bool(names & {"CancelledError", "GeneratorExit"})


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Span:
    span_id: str
    parent_id: str | None
    run_id: str | None  # the enclosing agent span, or None if we never saw one
    kind: str  # agent | step | tool | model | retrieval | embedding | other
    cls: str  # the class half of the span id
    name: str  # the method half
    started: float


@dataclass
class _Leaf:
    """An emitted opener with no closer yet. Invariant 4 lives here."""

    kind: str  # tool | model | retrieval | embedding
    span_id: str
    parent_id: str | None
    name: str
    call_id: str
    started: float
    model: str | None = None


@dataclass
class _Run:
    span_id: str
    agent_id: str
    open_leaves: dict[str, _Leaf] = field(default_factory=dict)
    pauses: dict[str, str] = field(default_factory=dict)  # waiter_id -> pause_id
    used_tool_ids: dict[str, int] = field(default_factory=dict)
    errors: int = 0


class _State:
    """Everything the two handlers share. One lock, no contextvars.

    A span's start and its end are separate dispatcher calls that may land on
    different tasks, so `ContextVar.reset(token)` is unusable here (it raises
    across tasks as well as threads). Identity therefore comes from
    `_core.RunTracker`, which passes `session_id=`/`agent_id=` explicitly.
    """

    def __init__(self, **options: Any) -> None:
        self.embeddings = bool(options.get("embeddings", False))
        self.steps = bool(options.get("steps", True))
        self.capture_messages = bool(options.get("capture_messages", True))
        self.stale_after = float(options.get("stale_after", 600.0))
        self.reaper_interval = float(options.get("reaper_interval", 30.0))

        self.tracker = _core.RunTracker(
            FRAMEWORK,
            base_fields=_core.framework_fields(FRAMEWORK, DIST),
        )
        self._lock = threading.RLock()
        self._spans: dict[str, _Span] = {}
        self._runs: dict[str, _Run] = {}
        # Per-instance, NOT class attributes: two _State objects (an
        # install/uninstall cycle, or a test) must not share a span table.
        self._step_inputs: dict[str, Any] = {}
        self._model_names: dict[str, str] = {}
        # span_id -> the run that owns its open leaf. A parked streaming span
        # has already EXITED (and been forgotten from `_spans`) by the time its
        # LLMChatEndEvent arrives, so the leaf cannot be found by walking the
        # span tree — without this, every streaming model_response would be
        # deferred to teardown and report the whole run as its duration.
        self._leaf_run: dict[str, str] = {}
        self._stop = threading.Event()
        self._reaper: threading.Thread | None = None

    # -- bookkeeping ------------------------------------------------------

    def _remember(self, span: _Span) -> None:
        while len(self._spans) >= _MAX_SPANS:
            self._spans.pop(next(iter(self._spans)), None)
        self._spans[span.span_id] = span

    def _run_of(self, span_id: str | None) -> _Run | None:
        if span_id is None:
            return None
        span = self._spans.get(span_id)
        if span is None or span.run_id is None:
            return None
        return self._runs.get(span.run_id)

    def _tool_call_id(self, run: _Run | None, raw_id: str | None, span_id: str) -> str:
        """The framework's own tool id, kept verbatim where it is unambiguous.

        Passing the framework id through unchanged is what makes our events line
        up with the customer's provider logs. But a human-in-the-loop tool is
        re-run with the *same* `tool_id` after the human answers, and two pairs
        sharing a `tool_call_id` in one session would pair wrongly, so a repeat
        gets a `#n` suffix rather than a collision.
        """
        if not raw_id:
            return span_id
        if run is None:
            return raw_id
        seen = run.used_tool_ids.get(raw_id, 0)
        run.used_tool_ids[raw_id] = seen + 1
        return raw_id if seen == 0 else f"{raw_id}#{seen}"

    # -- spans ------------------------------------------------------------

    def span_enter(
        self,
        span_id: str,
        bound_args: Any,
        instance: Any,
        parent_span_id: str | None,
        tags: dict | None,
    ) -> None:
        cls_name, method = _span_parts(span_id)
        arguments = getattr(bound_args, "arguments", None) or {}
        kind = self._classify(method, instance, parent_span_id)

        with self._lock:
            # Link every span, including the ones we emit nothing for: a chain
            # of "other" spans between a leaf and its agent must not break
            # identity resolution.
            self.tracker.link(span_id, parent_span_id)
            parent = self._spans.get(parent_span_id) if parent_span_id else None
            run_id = span_id if kind == "agent" else (parent.run_id if parent else None)
            self._remember(
                _Span(
                    span_id=span_id,
                    parent_id=parent_span_id,
                    run_id=run_id,
                    kind=kind,
                    cls=cls_name,
                    name=method,
                    started=time.monotonic(),
                )
            )
            if kind == "agent":
                self._start_agent(span_id, parent_span_id, instance, cls_name, arguments)
            elif kind == "step":
                self._start_step(span_id, parent_span_id, method, arguments)
            elif kind == "tool":
                self._start_tool(span_id, parent_span_id, instance, arguments)
            elif kind == "model":
                # The model leaf opens on LLMChatStartEvent, not here — the
                # event is what carries the messages. All we need from the span
                # is the model NAME, which the event no longer has (see the
                # `to_payload()` note at the top).
                pass

    def span_exit(self, span_id: str, bound_args: Any, instance: Any, result: Any) -> None:
        with self._lock:
            span = self._spans.pop(span_id, None)
            if span is None:
                return
            if span.kind == "agent":
                self._end_agent(span, result=result, outcome="success")
            elif span.kind == "step":
                self._end_step(span, result=result)
            elif span.kind == "tool":
                self._close_leaf(span, output=result)
            # A streaming LLM span exits the moment the generator is created,
            # long before the stream is consumed. Its model leaf stays parked
            # until LLMChatEndEvent, teardown, or the reaper.

    def span_drop(self, span_id: str, bound_args: Any, instance: Any, err: BaseException | None) -> None:
        with self._lock:
            span = self._spans.pop(span_id, None)
            if span is None:
                return
            if _is_waiting(err):
                self._pause(span, err)
                return
            cancelled = _is_cancellation(err)
            if span.kind == "agent":
                self._end_agent(
                    span,
                    result=None,
                    outcome="cancelled" if cancelled else "failed",
                    error=None if cancelled else err,
                )
            elif span.kind == "step":
                self._end_step(span, result=None, error=None if cancelled else err)
            else:
                self._close_leaf(span, output=None, error=None if cancelled else err)

    def _classify(self, method: str, instance: Any, parent_span_id: str | None) -> str:
        if method.startswith("_"):
            return "other"
        bases = _bases()
        workflow = bases.get("Workflow")
        if workflow is not None and isinstance(instance, workflow) and method == "run":
            # Root or nested: a compiled sub-workflow is a nested agent, which
            # is what the framework itself calls it.
            return "agent"
        if parent_span_id is None and instance is not None:
            # Any other top-level instrumented call — `query_engine.query()`,
            # a bare `llm.chat()` — opens the session and becomes its root
            # agent, named after its class. The alternative is emitting leaves
            # with no open agent above them, and the dashboard answers that by
            # synthesizing a root span that stays `ongoing` forever.
            return "agent"
        if instance is None:
            # A workflow step: the runtime wraps the step function, so there is
            # no instance, and its parent is the workflow run span. Checking the
            # parent (rather than the `llamaindex.step.*` tags) is what keeps
            # this precise — those tags are inherited by every child span,
            # including the LLM call inside the step.
            parent = self._spans.get(parent_span_id) if parent_span_id else None
            if parent is not None and parent.kind == "agent":
                return "step"
            return "other"
        for kind, key in (
            ("tool", "BaseTool"),
            ("model", "BaseLLM"),
            ("retrieval", "BaseRetriever"),
            ("embedding", "BaseEmbedding"),
        ):
            base = bases.get(key)
            if base is not None and isinstance(instance, base):
                if kind == "model" and method not in _LLM_METHODS:
                    return "other"
                return kind
        return "other"

    # -- agents -----------------------------------------------------------

    def _start_agent(
        self,
        span_id: str,
        parent_span_id: str | None,
        instance: Any,
        cls_name: str,
        arguments: dict,
    ) -> None:
        # `FunctionAgent.name` when there is one, the class name otherwise.
        # Never the span id: `agent_id` is a LowCardinality column and the
        # global dashboard facet.
        raw_name = getattr(instance, "name", None)
        label = raw_name if isinstance(raw_name, str) and raw_name else cls_name
        start_event = arguments.get("start_event")
        goal = getattr(start_event, "user_msg", None) or _summarize(start_event)

        identity = self.tracker.start_agent(
            span_id,
            agent_id=label,
            parent_key=parent_span_id,
            goal=goal,
            **_core.fw_fields(
                span_id=span_id,
                workflow=cls_name,
                agent_name=raw_name if isinstance(raw_name, str) else None,
            ),
        )
        # `start_agent` always returns a real `agent_id` (it normalizes and falls
        # back to the default); the `| None` is only on the shared `Identity`.
        self._runs[span_id] = _Run(
            span_id=span_id, agent_id=identity.agent_id or _core.DEFAULT_AGENT_ID
        )

    def _end_agent(
        self,
        span: _Span,
        *,
        result: Any,
        outcome: str,
        error: BaseException | None = None,
    ) -> None:
        run = self._runs.pop(span.span_id, None)
        if run is not None:
            # Invariant 4: `agent_end` force-closes open pauses but NOT open
            # tools or models. A run that dies holding one leaves the session
            # `ongoing` forever.
            self._close_all_leaves(run, reason="run_ended")
            if error is not None and run.errors == 0:
                # Nothing below us reported this, so the run itself owns it.
                # If a leaf already did, a second event would double-count on
                # `sessionSummary.errorCount`.
                self.tracker.emit(
                    "error",
                    span.span_id,
                    parent_key=span.parent_id,
                    error_type=type(error).__name__,
                    message=str(error) or type(error).__name__,
                    **_core.fw_fields(span_id=span.span_id),
                )
        elif error is not None:
            self.tracker.emit(
                "error",
                span.span_id,
                parent_key=span.parent_id,
                error_type=type(error).__name__,
                message=str(error) or type(error).__name__,
            )
        summary = _summarize(getattr(result, "result", None) if result is not None else None)
        self.tracker.end_agent(
            span.span_id,
            outcome=outcome,
            summary=summary,
            **_core.fw_fields(span_id=span.span_id),
        )

    # -- steps ------------------------------------------------------------

    def _start_step(self, span_id: str, parent_span_id: str | None, method: str, arguments: dict) -> None:
        if not self.steps:
            return
        incoming = arguments.get("ev")
        self.tracker.emit(
            "hook_triggered",
            span_id,
            parent_key=parent_span_id,
            hook_name=method,
            hook_id=span_id,
            trigger_event="workflow_step",
            input=_summarize(incoming),
            **_core.fw_fields(
                step=method,
                input_event=type(incoming).__name__ if incoming is not None else None,
                agent_name=getattr(incoming, "current_agent_name", None),
            ),
        )

    def _end_step(self, span: _Span, *, result: Any, error: BaseException | None = None) -> None:
        if not self.steps:
            return
        run = self._runs.get(span.run_id) if span.run_id else None
        if error is not None and run is not None:
            run.errors += 1
        self.tracker.emit(
            "hook_completed",
            span.span_id,
            parent_key=span.parent_id,
            hook_name=span.name,
            hook_id=span.span_id,
            outcome="failed" if error is not None else "success",
            output=_summarize(result),
            error=_error_text(error) if error is not None else None,
            **_core.fw_fields(
                step=span.name,
                output_event=type(result).__name__ if result is not None else None,
                agent_name=getattr(result, "current_agent_name", None),
            ),
        )

    # -- tools ------------------------------------------------------------

    def _start_tool(self, span_id: str, parent_span_id: str | None, instance: Any, arguments: dict) -> None:
        run = self._run_of(span_id)
        metadata = getattr(instance, "metadata", None)
        tool_name = getattr(metadata, "name", None) or type(instance).__name__

        # The enclosing `call_tool` step carries the typed `ToolCall`, which is
        # where the LLM's own tool id lives. Reusing it keeps our events lined
        # up with the provider's.
        raw_id = None
        parent = self._spans.get(parent_span_id) if parent_span_id else None
        if parent is not None and parent.kind == "step":
            raw_id = getattr(self._step_input(parent_span_id), "tool_id", None)
        call_id = self._tool_call_id(run, raw_id, span_id)

        # A resumed run announces itself by re-entering the tool that paused,
        # so `agent_resume`/`human_input` go out BEFORE this attempt's
        # `tool_use` — that keeps the paused window (which the graph measures
        # from `agent_pause` to `agent_resume`) free of the retry.
        if run is not None and run.pauses:
            self._resume(run, span_id, parent_span_id)

        kwargs = arguments.get("kwargs")
        self._open_leaf(
            run,
            _Leaf(
                kind="tool",
                span_id=span_id,
                parent_id=parent_span_id,
                name=tool_name,
                call_id=call_id,
                started=time.monotonic(),
            ),
        )
        self.tracker.emit(
            "tool_use",
            span_id,
            parent_key=parent_span_id,
            tool_name=tool_name,
            tool_call_id=call_id,
            input=kwargs if isinstance(kwargs, dict) else None,
            **_core.fw_fields(span_id=span_id, tool_id=raw_id),
        )

    def _step_input(self, span_id: str | None) -> Any:
        """The typed workflow event a step was invoked with.

        This is the whole point of reading the span handler rather than the
        (dead) agent events: `bound_args.arguments["ev"]` on a step span is the
        real `ToolCall` / `AgentInput` / `AgentOutput` object.
        """
        return self._step_inputs.get(span_id) if span_id else None

    # -- leaves -----------------------------------------------------------

    def _open_leaf(self, run: _Run | None, leaf: _Leaf) -> None:
        if run is not None:
            run.open_leaves[leaf.span_id] = leaf
            self._leaf_run[leaf.span_id] = run.span_id

    def _take_leaf(self, span_id: str) -> tuple[_Run | None, _Leaf | None]:
        """Detach an open leaf by span id, wherever its run is."""
        run = self._runs.get(self._leaf_run.pop(span_id, "") or "")
        if run is None:
            return None, None
        return run, run.open_leaves.pop(span_id, None)

    def _close_leaf(
        self,
        span: _Span,
        *,
        output: Any,
        error: BaseException | None = None,
    ) -> None:
        run, leaf = self._take_leaf(span.span_id)
        if leaf is None:
            return
        if error is not None and run is not None:
            run.errors += 1
        self._emit_leaf_close(
            leaf,
            output=output,
            error=_error_text(error) if error is not None else None,
        )

    def _emit_leaf_close(
        self,
        leaf: _Leaf,
        *,
        output: Any,
        error: str | None,
        reason: str | None = None,
    ) -> None:
        if leaf.kind == "model":
            usage, input_tokens, output_tokens = extract_usage(output)
            message = getattr(output, "message", None)
            content = getattr(message, "content", None)
            if content is None:
                content = getattr(output, "text", None)
            self.tracker.emit(
                "model_response",
                leaf.span_id,
                parent_key=leaf.parent_id,
                model=leaf.model,
                request_id=leaf.call_id,
                role=getattr(getattr(message, "role", None), "value", None),
                content=_summarize(content),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                usage=usage,
                error=error,
                # Invariant 3: ALWAYS an int. `durationOf` prefers the closing
                # event's value over end-start, which is what keeps model
                # durations right even when the dashboard's FIFO pairing
                # brackets the wrong pair. A float silently NULLs the column.
                duration_ms=_core.ms(time.monotonic() - leaf.started),
                **_core.fw_fields(span_id=leaf.span_id, closed_by=reason),
            )
            return
        # tool / retrieval / embedding all close as a tool_result. `duration_ms`
        # is auto-computed from the pending `tool_call_id` and is REJECTED if we
        # pass it, so it is deliberately absent here.
        payload: Any
        if leaf.kind == "retrieval":
            payload = summarize_nodes(output) if error is None else None
        else:
            payload = _summarize(getattr(output, "content", None) or output)
        self.tracker.emit(
            "tool_result",
            leaf.span_id,
            parent_key=leaf.parent_id,
            tool_name=leaf.name,
            tool_call_id=leaf.call_id,
            output=payload,
            error=error,
            **_core.fw_fields(span_id=leaf.span_id, closed_by=reason),
        )

    def _close_all_leaves(self, run: _Run, *, reason: str) -> None:
        for leaf in list(run.open_leaves.values()):
            run.open_leaves.pop(leaf.span_id, None)
            self._leaf_run.pop(leaf.span_id, None)
            self._emit_leaf_close(leaf, output=None, error=None, reason=reason)

    # -- human in the loop -------------------------------------------------

    def _pause(self, span: _Span, err: BaseException | None) -> None:
        """A `WaitingForEvent` drop: the run is waiting on a human.

        Both pairs are emitted, in this order, because neither alone is enough:
        only `agent_pause`/`agent_resume` feeds the graph's paused time, and
        only `human_wait`/`human_input` carries the prompt and the pending-human
        badge.
        """
        run = self._runs.get(span.run_id) if span.run_id else None
        waiter = getattr(err, "add", None)
        waiter_id = getattr(waiter, "waiter_id", None) or uuid.uuid4().hex
        prompt = _summarize(getattr(waiter, "waiter_event", None))
        pause_id = f"{waiter_id}:{uuid.uuid4().hex[:8]}"

        # The tool that paused will be re-run from scratch when the human
        # answers, so close its leaf now rather than leaving it open forever.
        # This is honest: LlamaIndex really does call the tool twice.
        if run is not None:
            self._leaf_run.pop(span.span_id, None)
            leaf = run.open_leaves.pop(span.span_id, None)
            if leaf is not None:
                self._emit_leaf_close(leaf, output=None, error=None, reason="human_wait")
            run.pauses[pause_id] = waiter_id

        self.tracker.emit(
            "human_wait",
            span.span_id,
            parent_key=span.parent_id,
            input_id=pause_id,
            prompt=prompt,
            reason="workflow is waiting for a human response",
            **_core.fw_fields(waiter_id=waiter_id, span_id=span.span_id),
        )
        self.tracker.emit(
            "agent_pause",
            span.span_id,
            parent_key=span.parent_id,
            pause_id=pause_id,
            reason="human_input",
            **_core.fw_fields(waiter_id=waiter_id),
        )

    def _resume(self, run: _Run, span_id: str, parent_id: str | None) -> None:
        for pause_id, waiter_id in list(run.pauses.items()):
            run.pauses.pop(pause_id, None)
            self.tracker.emit(
                "agent_resume",
                span_id,
                parent_key=parent_id,
                pause_id=pause_id,
                reason="human_input",
                **_core.fw_fields(waiter_id=waiter_id),
            )
            # `response` is left unset: the human's answer arrives as a
            # `HumanResponseEvent` sent straight into the workflow context,
            # which never reaches the dispatcher. It surfaces on the paired
            # `tool_result` instead.
            self.tracker.emit(
                "human_input",
                span_id,
                parent_key=parent_id,
                input_id=pause_id,
                **_core.fw_fields(waiter_id=waiter_id),
            )

    # -- dispatcher events -------------------------------------------------

    def model_start(self, span_id: str, messages: Any, model_dict: Any, prompt: Any = None) -> None:
        with self._lock:
            span = self._spans.get(span_id)
            run = self._run_of(span_id)
            parent_id = span.parent_id if span is not None else None
            model = self._model_name(span_id, model_dict)
            self._open_leaf(
                run,
                _Leaf(
                    kind="model",
                    span_id=span_id,
                    parent_id=parent_id,
                    name=model or "llm",
                    call_id=span_id,
                    started=time.monotonic(),
                    model=model,
                ),
            )
            self.tracker.emit(
                "model_request",
                span_id,
                parent_key=parent_id,
                model=model,
                # `request_id` is the LLM span id. It is what pairs the two
                # model events in the dashboard's detail panel; no SDK set it
                # before this work, so nothing was pairing.
                request_id=span_id,
                messages=_messages(messages) if self.capture_messages else None,
                system=_summarize(prompt) if self.capture_messages else None,
                **_core.fw_fields(span_id=span_id),
            )

    def model_end(self, span_id: str, response: Any, error: str | None = None) -> None:
        with self._lock:
            run, leaf = self._take_leaf(span_id)
            if leaf is None:
                return
            if error is not None and run is not None:
                run.errors += 1
            self._emit_leaf_close(leaf, output=response, error=error)

    def retrieval_start(self, span_id: str, query: Any) -> None:
        with self._lock:
            span = self._spans.get(span_id)
            run = self._run_of(span_id)
            parent_id = span.parent_id if span is not None else None
            name = span.cls if span is not None else "retriever"
            self._open_leaf(
                run,
                _Leaf(
                    kind="retrieval",
                    span_id=span_id,
                    parent_id=parent_id,
                    name=name,
                    call_id=span_id,
                    started=time.monotonic(),
                ),
            )
            self.tracker.emit(
                "tool_use",
                span_id,
                parent_key=parent_id,
                tool_name=name,
                tool_call_id=span_id,
                input={"query": _summarize(query)},
                **_core.fw_fields(span_id=span_id, kind="retrieval"),
            )

    def retrieval_end(self, span_id: str, nodes: Any) -> None:
        with self._lock:
            _run, leaf = self._take_leaf(span_id)
            if leaf is None:
                return
            self._emit_leaf_close(leaf, output=nodes, error=None)

    def exception(self, span_id: str | None, exc: Any) -> None:
        """`ExceptionEvent` — close whatever leaf that span owns.

        No standalone `error` event: the span that owns the failure reports it,
        and the enclosing agent reports it once more only if nothing below it
        did.
        """
        if span_id is None:
            return
        with self._lock:
            run, leaf = self._take_leaf(span_id)
            if leaf is None:
                return
            if run is not None:
                run.errors += 1
            text = _error_text(exc) if isinstance(exc, BaseException) else str(exc)
            self._emit_leaf_close(leaf, output=None, error=text)

    def _model_name(self, span_id: str, model_dict: Any) -> str | None:
        """`instance.metadata.model_name`, captured when the span opened.

        NOT `model_dict["model"]`: `to_payload()` replaced `to_dict()` in
        0.14.23 and that key no longer exists, so reading it returns None
        silently — the bug Traceloop and MLflow are shipping today.
        """
        name = self._model_names.get(span_id)
        if name:
            return name
        if isinstance(model_dict, dict):
            candidate = model_dict.get("model_name")
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    # -- reaper ------------------------------------------------------------

    def sweep(self) -> int:
        """Close leaves nobody is going to close. Returns how many.

        A streaming response that is never consumed produces an
        `LLMChatStartEvent` with no end, and its span has already exited. Left
        alone that is an open `model_request` and a session the dashboard shows
        as `ongoing` forever.
        """
        closed = 0
        cutoff = time.monotonic() - self.stale_after
        with self._lock:
            for run in list(self._runs.values()):
                for leaf in list(run.open_leaves.values()):
                    if leaf.started > cutoff:
                        continue
                    run.open_leaves.pop(leaf.span_id, None)
                    self._leaf_run.pop(leaf.span_id, None)
                    self._emit_leaf_close(leaf, output=None, error=None, reason="stale")
                    closed += 1
        return closed

    def start_reaper(self) -> None:
        if self.reaper_interval <= 0 or self._reaper is not None:
            return
        thread = threading.Thread(
            target=self._reap_loop, name="failproofai_sdk-llamaindex-reaper", daemon=True
        )
        self._reaper = thread
        thread.start()

    def _reap_loop(self) -> None:
        while not self._stop.wait(self.reaper_interval):
            _core.call_safely(self.sweep, (), {}, "llama_index.reaper")

    def shutdown(self) -> None:
        """Close everything still open, then stop the reaper. Never raises."""
        self._stop.set()
        with self._lock:
            for run in list(self._runs.values()):
                self._close_all_leaves(run, reason="uninstrument")
            for span_id in list(self._runs):
                self.tracker.end_agent(span_id, outcome="cancelled")
            self._runs.clear()
            self._spans.clear()
            self._leaf_run.clear()
            self._step_inputs.clear()
            self._model_names.clear()
            self.tracker.reset()
        thread = self._reaper
        self._reaper = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)


# ---------------------------------------------------------------------------
# Framework base classes, imported once and only when asked
# ---------------------------------------------------------------------------

_BASES: dict[str, Any] = {}


def _bases() -> dict[str, Any]:
    """The isinstance targets used to classify a span.

    `isinstance` rather than a class-name string: a rename lands as a hard
    ImportError at `instrument()` time instead of a classifier that quietly
    stops matching. Each import is individually optional, because a partial
    LlamaIndex install should cost one span kind, not the adapter.
    """
    if _BASES:
        return _BASES
    targets = {
        "Workflow": ("llama_index.core.workflow", "Workflow"),
        "BaseTool": ("llama_index.core.tools.types", "BaseTool"),
        "BaseLLM": ("llama_index.core.base.llms.base", "BaseLLM"),
        "BaseRetriever": ("llama_index.core.base.base_retriever", "BaseRetriever"),
        "BaseEmbedding": ("llama_index.core.base.embeddings.base", "BaseEmbedding"),
    }
    import importlib

    for key, (module_name, attribute) in targets.items():
        try:
            _BASES[key] = getattr(importlib.import_module(module_name), attribute)
        except Exception:
            _compat.warn(
                f"failproofai_sdk: llama_index could not resolve {module_name}.{attribute}; "
                f"spans of that kind will be recorded as untyped.",
                key=f"llama_index:base:{key}",
            )
            _BASES[key] = None
    return _BASES


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

# The dispatcher dispatches on the concrete event class, so these names ARE the
# API. `test_llama_index.py` asserts every one of them still exists in the
# framework's event modules — a rename would otherwise leave this table looking
# perfectly healthy while recording nothing.
MODEL_START_EVENTS = ("LLMChatStartEvent", "LLMCompletionStartEvent")
MODEL_END_EVENTS = ("LLMChatEndEvent", "LLMCompletionEndEvent", "StreamChatEndEvent")
MODEL_ERROR_EVENTS = ("StreamChatErrorEvent",)
RETRIEVAL_START_EVENTS = ("RetrievalStartEvent",)
RETRIEVAL_END_EVENTS = ("RetrievalEndEvent",)
EMBEDDING_START_EVENTS = ("EmbeddingStartEvent",)
EMBEDDING_END_EVENTS = ("EmbeddingEndEvent",)
EXCEPTION_EVENTS = ("ExceptionEvent",)

_HANDLED_EVENTS = (
    MODEL_START_EVENTS
    + MODEL_END_EVENTS
    + MODEL_ERROR_EVENTS
    + RETRIEVAL_START_EVENTS
    + RETRIEVAL_END_EVENTS
    + EMBEDDING_START_EVENTS
    + EMBEDDING_END_EVENTS
    + EXCEPTION_EVENTS
)

_CLASSES: dict[str, Any] = {}


def handler_classes() -> tuple[Any, Any]:
    """`(FailproofAIEventHandler, FailproofAISpanHandler)`, built on first use.

    They subclass framework base classes, so they cannot exist at module import
    time — and `import failproofai_sdk` must stay free of LlamaIndex. Memoised so
    repeated install/uninstall cycles do not rebuild pydantic models.
    """
    if _CLASSES:
        return _CLASSES["event"], _CLASSES["span"]

    from llama_index_instrumentation.event_handlers.base import BaseEventHandler
    from llama_index_instrumentation.span_handlers.base import BaseSpanHandler
    from pydantic import PrivateAttr

    class FailproofAIEventHandler(BaseEventHandler):
        """Model, retrieval and embedding events.

        `handle` is wrapped in `_core.safe` because the dispatcher's own
        `except BaseException: pass` has NO logging: without this, a bug here is
        undetectable in production.
        """

        _state: Any = PrivateAttr(default=None)

        def __init__(self, state: Any = None, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self._state = state

        @classmethod
        def class_name(cls) -> str:
            return "FailproofAIEventHandler"

        @_core.safe
        def handle(self, event: Any, **kwargs: Any) -> None:
            state = self._state
            if state is None:
                return
            name = type(event).__name__
            span_id = getattr(event, "span_id", None)
            if span_id is None:
                return
            if name in MODEL_START_EVENTS:
                state.model_start(
                    span_id,
                    getattr(event, "messages", None),
                    getattr(event, "model_dict", None),
                    prompt=getattr(event, "prompt", None),
                )
            elif name in MODEL_END_EVENTS:
                state.model_end(span_id, getattr(event, "response", None))
            elif name in MODEL_ERROR_EVENTS:
                state.model_end(
                    span_id, None, error=_summarize(getattr(event, "exception", None)) or name
                )
            elif name in RETRIEVAL_START_EVENTS:
                state.retrieval_start(span_id, getattr(event, "str_or_query_bundle", None))
            elif name in RETRIEVAL_END_EVENTS:
                state.retrieval_end(span_id, getattr(event, "nodes", None))
            elif state.embeddings and name in EMBEDDING_START_EVENTS:
                state.retrieval_start(span_id, "embedding")
            elif state.embeddings and name in EMBEDDING_END_EVENTS:
                state.retrieval_end(span_id, getattr(event, "embeddings", None))
            elif name in EXCEPTION_EVENTS:
                state.exception(span_id, getattr(event, "exception", None))

    class FailproofAISpanHandler(BaseSpanHandler):
        """The span tree: agents, workflow steps, tools, retrievers.

        Note `new_span` takes **`parent_span_id`** while the dispatcher's
        `span_enter` takes `parent_id`. Declaring the wrong one here gives a
        flat trace and no error at all.

        Every override returns a truthy value so the base class's `span_exit`
        can `del self.open_spans[id_]` — returning `None` from
        `prepare_to_exit_span` deliberately LEAKS the entry (that is how the
        framework parks streaming spans), and returning it from `new_span` would
        make the matching `del` raise.
        """

        _state: Any = PrivateAttr(default=None)

        def __init__(self, state: Any = None, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self._state = state

        @classmethod
        def class_name(cls) -> str:
            return "FailproofAISpanHandler"

        @_core.safe
        def new_span(
            self,
            id_: str,
            bound_args: Any,
            instance: Any = None,
            parent_span_id: str | None = None,
            tags: dict | None = None,
            **kwargs: Any,
        ) -> str:
            state = self._state
            if state is not None:
                arguments = getattr(bound_args, "arguments", None) or {}
                if "ev" in arguments:
                    state._step_inputs[id_] = arguments["ev"]
                metadata = getattr(instance, "metadata", None)
                model_name = getattr(metadata, "model_name", None)
                if isinstance(model_name, str) and model_name:
                    state._model_names[id_] = model_name
                state.span_enter(id_, bound_args, instance, parent_span_id, tags)
            return id_

        @_core.safe
        def prepare_to_exit_span(
            self,
            id_: str,
            bound_args: Any,
            instance: Any = None,
            result: Any = None,
            **kwargs: Any,
        ) -> str | None:
            state = self._state
            if state is not None:
                state.span_exit(id_, bound_args, instance, result)
                state._step_inputs.pop(id_, None)
                state._model_names.pop(id_, None)
            # Truthy tells the base class to `del self.open_spans[id_]`, which
            # raises if `new_span` never stored it (it returns None when
            # `safe()` swallowed an exception). Returning None here parks the
            # span instead — the framework's own mechanism, not a leak.
            return id_ if id_ in self.open_spans else None

        @_core.safe
        def prepare_to_drop_span(
            self,
            id_: str,
            bound_args: Any,
            instance: Any = None,
            err: BaseException | None = None,
            **kwargs: Any,
        ) -> str | None:
            state = self._state
            if state is not None:
                state.span_drop(id_, bound_args, instance, err)
                state._step_inputs.pop(id_, None)
                state._model_names.pop(id_, None)
            return id_ if id_ in self.open_spans else None

    _CLASSES["event"] = FailproofAIEventHandler
    _CLASSES["span"] = FailproofAISpanHandler
    return FailproofAIEventHandler, FailproofAISpanHandler


# ---------------------------------------------------------------------------
# The adapter
# ---------------------------------------------------------------------------

class _LlamaIndexAdapter:
    """Registered as `llama_index`; see `failproofai_sdk.integrations.__init__`."""

    name = FRAMEWORK
    module = "llama_index"

    def __init__(self) -> None:
        self.state: _State | None = None
        self._handlers: tuple[Any, Any] | None = None

    def install(self, **options: Any) -> None:
        instrumentation = _compat.require_module(
            "llama_index.core.instrumentation", dist=DIST, extra=EXTRA
        )
        _compat.check_version(
            FRAMEWORK,
            DIST,
            minimum=MIN_VERSION,
            below=BELOW_VERSION,
            reason="0.14.23 replaced to_dict() with to_payload() and is the first "
            "release whose workflow spans carry the typed agent events",
        )
        if not _compat.probe(
            FRAMEWORK, "get_dispatcher", lambda: instrumentation.get_dispatcher
        ):
            return

        state = _State(**options)
        event_cls, span_cls = handler_classes()
        event_handler = event_cls(state=state)
        span_handler = span_cls(state=state)

        # The ROOT dispatcher. Child dispatchers propagate upward, so one
        # registration here sees the whole process.
        dispatcher = instrumentation.get_dispatcher()
        dispatcher.add_event_handler(event_handler)
        dispatcher.add_span_handler(span_handler)

        self.state = state
        self._handlers = (event_handler, span_handler)
        state.start_reaper()

    def uninstall(self) -> None:
        handlers = self._handlers
        self._handlers = None
        state = self.state
        self.state = None
        if handlers is not None:
            try:
                import llama_index.core.instrumentation as instrumentation

                dispatcher = instrumentation.get_dispatcher()
                ours = set(id(handler) for handler in handlers)
                # IN-PLACE slice assignment. `add_span_handler` does
                # `self.span_handlers += [h]`, so a plain `=` rebinds the
                # pydantic field and can drop handlers added by someone else.
                dispatcher.event_handlers[:] = [
                    handler for handler in dispatcher.event_handlers if id(handler) not in ours
                ]
                dispatcher.span_handlers[:] = [
                    handler for handler in dispatcher.span_handlers if id(handler) not in ours
                ]
            except Exception:
                _core.logger.warning(
                    "failproofai_sdk: could not detach the llama_index handlers", exc_info=True
                )
        if state is not None:
            # Close every open leaf and agent before we stop listening: a run
            # abandoned mid-flight would otherwise render `ongoing` forever.
            _core.call_safely(state.shutdown, (), {}, "llama_index.shutdown")


adapter = _LlamaIndexAdapter()

install: Callable[..., None] = adapter.install
uninstall: Callable[..., None] = adapter.uninstall
