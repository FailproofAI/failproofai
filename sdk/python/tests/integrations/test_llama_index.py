"""The LlamaIndex adapter, against the real framework and a stub model.

No network, no API key, no mock of our own code: every assertion below reads
the **JSONL the writer actually produced** after driving a real
`FunctionAgent` / `Workflow`. Asserting on mock call args would happily pass
against an adapter that emits nothing the ingest pipeline can use.

The single highest-value test in the file is
`test_our_overrides_still_exist_on_the_framework_base_classes`. Every other
test here can stay green while the adapter is completely dead: if upstream
renames `prepare_to_exit_span`, our override is never called, the span handler
records nothing, and a fake-based suite notices nothing at all.
"""

import asyncio
import inspect
import json
import os
from dataclasses import fields as dataclass_fields
from typing import Any, List, Sequence

import pytest

import failproofai_sdk
from failproofai_sdk import _runtime, _schema
from failproofai_sdk.integrations import _compat, _core

# `pytest.importorskip` is fail-open: misspell the module and every leg skips
# while CI stays green having tested nothing. The framework CI leg sets
# AGENTEYE_TESTS_REQUIRE_FRAMEWORKS=1, which turns the skip into a hard error.
if os.environ.get("AGENTEYE_TESTS_REQUIRE_FRAMEWORKS", "").strip().lower() in {"1", "true", "yes"}:
    import llama_index.core  # noqa: F401
else:
    pytest.importorskip("llama_index.core", reason="llama-index-core is not installed")

from llama_index.core.base.llms.types import (  # noqa: E402
    ChatMessage,
    ChatResponse,
    ChatResponseAsyncGen,
    ChatResponseGen,
    CompletionResponse,
    CompletionResponseAsyncGen,
    CompletionResponseGen,
    LLMMetadata,
    MessageRole,
)
from llama_index.core.llms.callbacks import llm_chat_callback, llm_completion_callback  # noqa: E402
from llama_index.core.llms.function_calling import FunctionCallingLLM  # noqa: E402
from llama_index.core.tools import ToolSelection  # noqa: E402
from llama_index.core.tools.types import BaseTool  # noqa: E402
from pydantic import Field, PrivateAttr  # noqa: E402

from failproofai_sdk.integrations import llama_index as adapter_module  # noqa: E402

pytestmark = pytest.mark.framework


# ---------------------------------------------------------------------------
# A stub function-calling model. Real FunctionAgent, fake LLM.
# ---------------------------------------------------------------------------

class StubLLM(FunctionCallingLLM):
    """Replays a script of tool calls, then answers. Never touches a network."""

    model: str = "stub-model-1"
    script: List[Any] = Field(default_factory=list)
    final: str = "done"
    _turn: int = PrivateAttr(default=0)

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(
            model_name=self.model, is_chat_model=True, is_function_calling_model=True
        )

    def _next(self) -> ChatResponse:
        turn = self._turn
        self._turn += 1
        if turn < len(self.script):
            name, kwargs = self.script[turn]
            message = ChatMessage(
                role=MessageRole.ASSISTANT,
                content="",
                additional_kwargs={
                    "tool_calls": [{"id": f"call_{turn}", "name": name, "kwargs": kwargs}]
                },
            )
        else:
            message = ChatMessage(role=MessageRole.ASSISTANT, content=self.final)
        return ChatResponse(
            message=message,
            raw={"usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}},
        )

    @llm_chat_callback()
    def chat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        return self._next()

    @llm_chat_callback()
    async def achat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        return self._next()

    @llm_chat_callback()
    def stream_chat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponseGen:
        def gen():
            yield self._next()

        return gen()

    @llm_chat_callback()
    async def astream_chat(
        self, messages: Sequence[ChatMessage], **kwargs: Any
    ) -> ChatResponseAsyncGen:
        async def gen():
            yield self._next()

        return gen()

    @llm_completion_callback()
    def complete(self, prompt: str, formatted: bool = False, **kwargs: Any) -> CompletionResponse:
        return CompletionResponse(text=self.final)

    @llm_completion_callback()
    async def acomplete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponse:
        return CompletionResponse(text=self.final)

    @llm_completion_callback()
    def stream_complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponseGen:
        def gen():
            yield CompletionResponse(text=self.final, delta=self.final)

        return gen()

    @llm_completion_callback()
    async def astream_complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponseAsyncGen:
        async def gen():
            yield CompletionResponse(text=self.final, delta=self.final)

        return gen()

    def _prepare_chat_with_tools(
        self,
        tools: Sequence["BaseTool"],
        user_msg: Any = None,
        chat_history: Any = None,
        verbose: bool = False,
        allow_parallel_tool_calls: bool = False,
        tool_required: bool = False,
        **kwargs: Any,
    ) -> dict:
        messages = list(chat_history or [])
        if user_msg is not None:
            messages.append(
                ChatMessage(role=MessageRole.USER, content=user_msg)
                if isinstance(user_msg, str)
                else user_msg
            )
        return {"messages": messages, **kwargs}

    def get_tool_calls_from_response(
        self, response: ChatResponse, error_on_no_tool_call: bool = True, **kwargs: Any
    ) -> List[ToolSelection]:
        calls = response.message.additional_kwargs.get("tool_calls", [])
        if not calls and error_on_no_tool_call:
            raise ValueError("no tool calls")
        return [
            ToolSelection(tool_id=c["id"], tool_name=c["name"], tool_kwargs=c["kwargs"])
            for c in calls
        ]


def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


def boom(x: int) -> int:
    """Always raises."""
    raise RuntimeError("tool exploded")


async def _await(awaitable):
    return await awaitable


def drive(coro_factory):
    """Run a workflow from sync test code.

    `Workflow.run()` schedules tasks eagerly, so it must be *called* with a
    loop already running — `asyncio.run(workflow.run())` raises
    "no running event loop" before the adapter ever sees anything.
    """

    async def _main():
        return await coro_factory()

    return asyncio.run(_main())


def run_agent(agent, prompt: str) -> str:
    return str(drive(lambda: agent.run(prompt)))


def run_workflow(workflow, **kwargs) -> str:
    return str(drive(lambda: workflow.run(**kwargs)))


def calculator(llm, **kwargs):
    from llama_index.core.agent.workflow import FunctionAgent

    kwargs.setdefault("tools", [add])
    kwargs.setdefault("streaming", False)
    return FunctionAgent(name="calc", description="does math", llm=llm, **kwargs)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def instrumented(tmp_path):
    """Instrument for one test, then put everything back.

    The flush interval is enormous on purpose: the writer names files with
    millisecond resolution, so two automatic flushes inside the same
    millisecond overwrite each other. Tests flush once, explicitly, at the end.
    """
    _core.set_strict(False)
    _compat.set_strict_integrations(False)
    _core.reset_failures()
    _runtime.writer.set_flush_interval(3600)
    assert failproofai_sdk.instrument("llama_index") == ("llama_index",)
    try:
        yield adapter_module.adapter
    finally:
        failproofai_sdk.uninstrument("llama_index")
        _core.set_strict(None)
        _compat.set_strict_integrations(None)
        _core.reset_failures()


@pytest.fixture()
def instrumented_without_steps(tmp_path):
    """`instrumented`, with the workflow-step hooks switched off.

    Spelled out rather than parameterising the fixture above: `instrumented` is
    used by nearly every test in this file, and a signature change there is a
    change to all of them.
    """
    _core.set_strict(False)
    _compat.set_strict_integrations(False)
    _core.reset_failures()
    _runtime.writer.set_flush_interval(3600)
    assert failproofai_sdk.instrument("llama_index", steps=False) == ("llama_index",)
    try:
        yield adapter_module.adapter
    finally:
        failproofai_sdk.uninstrument("llama_index")
        _core.set_strict(None)
        _compat.set_strict_integrations(None)
        _core.reset_failures()


@pytest.fixture(autouse=True)
def _isolate_writer_queue():
    """Start and end every test with an empty writer queue.

    The queue is process-global while `base_dir` is per-test, so events a test
    never flushed are written into the NEXT test's directory the first time
    anything flushes — which reads as a mystery second session id and is
    exactly the kind of cross-test bleed this suite exists to rule out.
    """
    _runtime.writer._queue.clear()
    yield
    _runtime.writer._queue.clear()


@pytest.fixture(autouse=True)
def _no_silent_adapter_failure(request):
    """Fail the test if the adapter swallowed an exception.

    `safe()` exists so a bug costs one log line instead of the process — which
    also means a broken adapter passes every behavioural test that only checks
    "the run finished". This makes that invisible failure visible in the suite.
    """
    yield
    if _EXPECTS_FAILURE in request.node.name:
        return
    assert not _core._disabled, f"adapter self-disabled a call site: {_core._disabled}"
    assert not _core._failures, f"adapter swallowed exceptions: {_core._failures}"


# pyproject sets `--strict-markers`, so a bespoke marker is not available here:
# the two tests that deliberately make the adapter fail are named instead.
_EXPECTS_FAILURE = "raises_on_every_call"


def read_events(tmp_path) -> list[dict]:
    _runtime.writer.flush_now()
    rows: list[dict] = []
    for path in sorted((tmp_path / "events").glob("*.jsonl")):
        rows.extend(json.loads(line) for line in path.read_text().splitlines() if line)
    return rows


def types_of(events: list[dict]) -> list[str]:
    return [event["type"] for event in events]


def only(events: list[dict], kind: str) -> list[dict]:
    return [event for event in events if event["type"] == kind]


# The exact sequence a one-tool FunctionAgent turn produces. Written out rather
# than computed: a change here should require a human to look at it.
ONE_TOOL_SEQUENCE = [
    "agent_start",
    "hook_triggered",  # init_run
    "hook_completed",
    "hook_triggered",  # setup_agent
    "hook_completed",
    "hook_triggered",  # run_agent_step
    "model_request",
    "model_response",
    "hook_completed",
    "hook_triggered",  # parse_agent_output
    "hook_completed",
    "hook_triggered",  # call_tool
    "tool_use",
    "tool_result",
    "hook_completed",
    "hook_triggered",  # aggregate_tool_results
    "hook_completed",
    "hook_triggered",  # setup_agent
    "hook_completed",
    "hook_triggered",  # run_agent_step
    "model_request",
    "model_response",
    "hook_completed",
    "hook_triggered",  # parse_agent_output
    "hook_completed",
    "agent_end",
]


# ---------------------------------------------------------------------------
# The representative run
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("streaming", [False, True], ids=["blocking", "streaming"])
def test_exact_event_sequence_for_a_one_tool_run(instrumented, tmp_path, streaming):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    agent = calculator(llm, streaming=streaming)
    assert str(run_agent(agent, "what is 2+3?")) == "5"

    events = read_events(tmp_path)
    # Streaming produces the same shape: the model span exits the instant the
    # generator is created, so the response is parked and closed by
    # LLMChatEndEvent rather than by the span.
    assert types_of(events) == ONE_TOOL_SEQUENCE


def test_the_root_agent_start_is_the_sessions_first_event(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 1, "b": 1})], final="2")
    run_agent(calculator(llm), "1+1?")

    events = read_events(tmp_path)
    # `agent_sessions.agent_id = any(...)` over an ORDER BY (session_id, ts)
    # table returns the FIRST agent_id by time. If anything preceded the root
    # agent_start the sessions list would name a workflow step instead.
    assert events[0]["type"] == "agent_start"
    assert events[0]["agent_id"] == "calc"
    assert {event["session_id"] for event in events} == {events[0]["session_id"]}


def test_every_event_carries_the_framework_triple(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 1, "b": 1})], final="2")
    run_agent(calculator(llm), "1+1?")

    for event in read_events(tmp_path):
        assert event["framework"] == "llama_index"
        assert event["framework_version"]
        assert event["integration_version"]


def test_agent_ids_are_readable_names_not_span_ids(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 1, "b": 1})], final="2")
    run_agent(calculator(llm), "1+1?")

    for event in read_events(tmp_path):
        agent_id = event["agent_id"]
        # agent_id is LowCardinality(String) and the global dashboard facet; a
        # span id in it fills the filter dropdown with one entry per run.
        assert agent_id == "calc"
        assert "-" not in agent_id and len(agent_id) < 32


def test_model_requests_and_responses_pair_on_request_id(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    events = read_events(tmp_path)
    requests = only(events, "model_request")
    responses = only(events, "model_response")
    assert len(requests) == len(responses) == 2
    assert [r["request_id"] for r in requests] == [r["request_id"] for r in responses]
    assert len({r["request_id"] for r in requests}) == 2

    for response in responses:
        # Invariant 3: an int, always. The server stores duration_ms as a u32
        # and its JSON parser drops floats, so a float silently NULLs it.
        assert isinstance(response["duration_ms"], int)
        assert not isinstance(response["duration_ms"], bool)
        assert response["model"] == "stub-model-1"


def test_model_name_comes_from_metadata_not_the_gutted_model_dict(instrumented, tmp_path):
    llm = StubLLM(script=[], final="hi")
    run_agent(calculator(llm), "hi")

    events = read_events(tmp_path)
    assert {e["model"] for e in only(events, "model_request")} == {"stub-model-1"}
    # `to_payload()` replaced `to_dict()` in 0.14.23 and the "model" key is gone.
    start_payload = llm.to_payload()
    assert "model" not in start_payload


def test_tokens_are_extracted_and_the_raw_usage_dict_ships_too(instrumented, tmp_path):
    llm = StubLLM(script=[], final="hi")
    run_agent(calculator(llm), "hi")

    response = only(read_events(tmp_path), "model_response")[0]
    assert response["input_tokens"] == 11
    assert response["output_tokens"] == 7
    # Both event_summary.rs and sessionSummary.ts fall back to `usage`.
    assert response["usage"]["total_tokens"] == 18


def test_tool_use_and_tool_result_pair_and_carry_a_duration(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    events = read_events(tmp_path)
    uses = only(events, "tool_use")
    results = only(events, "tool_result")
    assert len(uses) == len(results) == 1
    assert uses[0]["tool_call_id"] == results[0]["tool_call_id"] == "call_0"
    assert uses[0]["tool_name"] == results[0]["tool_name"] == "add"
    assert uses[0]["input"] == {"a": 2, "b": 3}
    assert results[0]["output"] == "5"
    assert isinstance(results[0]["duration_ms"], int)


def test_tool_call_id_is_the_frameworks_own_id(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    use = only(read_events(tmp_path), "tool_use")[0]
    # Passing the framework's id through verbatim is what makes our events line
    # up with the customer's provider logs.
    assert use["tool_call_id"] == "call_0"
    assert use["fw_tool_id"] == "call_0"


def test_workflow_steps_become_hooks_not_agents(instrumented, tmp_path):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    events = read_events(tmp_path)
    hooks = only(events, "hook_triggered")
    names = [hook["hook_name"] for hook in hooks]
    assert names[:3] == ["init_run", "setup_agent", "run_agent_step"]
    assert all(hook["trigger_event"] == "workflow_step" for hook in hooks)
    # Steps as agents would drown the agent_id facet with `parse_agent_output`.
    assert {e["agent_id"] for e in events} == {"calc"}
    for completed in only(events, "hook_completed"):
        assert isinstance(completed["duration_ms"], int)


# ---------------------------------------------------------------------------
# Rendering invariants
# ---------------------------------------------------------------------------

def assert_rendering_invariants(events: list[dict]) -> None:
    """The four properties that make the dashboard draw the session correctly."""
    assert events, "no events at all"
    assert events[0]["type"] == "agent_start", "invariant 2: root agent_start must be first"

    open_agents: dict[str, int] = {}
    open_leaves: dict[tuple[str, str], int] = {}
    for event in events:
        kind = event["type"]
        agent_id = event["agent_id"]
        if kind == "agent_start":
            open_agents[agent_id] = open_agents.get(agent_id, 0) + 1
        else:
            # Invariant 1: an event under an agent_id with no open agent_start
            # makes executionGraph synthesize a root span that stays `ongoing`.
            assert open_agents.get(agent_id, 0) > 0, f"{kind} under a closed agent {agent_id!r}"
        if kind == "agent_end":
            open_agents[agent_id] -= 1
        elif kind == "tool_use":
            open_leaves[("tool", event["tool_call_id"])] = 1
        elif kind == "tool_result":
            tool_leaf = open_leaves.pop(("tool", event["tool_call_id"]), None)
            assert tool_leaf, "unpaired tool_result"
        elif kind == "model_request":
            open_leaves[("model", event["request_id"])] = 1
        elif kind == "model_response":
            model_leaf = open_leaves.pop(("model", event["request_id"]), None)
            assert model_leaf, "unpaired model_response"
            assert isinstance(event["duration_ms"], int), "invariant 3"
        elif kind == "hook_triggered":
            open_leaves[("hook", event["hook_id"])] = 1
        elif kind == "hook_completed":
            hook_leaf = open_leaves.pop(("hook", event["hook_id"]), None)
            assert hook_leaf, "unpaired hook_completed"

    assert not any(open_agents.values()), f"agents left open: {open_agents}"
    # Invariant 4: agent_end force-closes open pauses but NOT tools or models,
    # so a leaf left open renders the session `ongoing` forever.
    assert not open_leaves, f"leaves left open: {sorted(open_leaves)}"


@pytest.mark.parametrize("streaming", [False, True], ids=["blocking", "streaming"])
def test_rendering_invariants_hold_for_a_normal_run(instrumented, tmp_path, streaming):
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm, streaming=streaming), "2+3?")
    assert_rendering_invariants(read_events(tmp_path))


def test_rendering_invariants_hold_when_a_tool_fails(instrumented, tmp_path):
    llm = StubLLM(script=[("boom", {"x": 1})], final="recovered")
    agent = calculator(llm, tools=[boom])
    run_agent(agent, "blow up")
    assert_rendering_invariants(read_events(tmp_path))


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

def test_a_failing_tool_is_reported_on_the_tool_and_not_double_counted(instrumented, tmp_path):
    llm = StubLLM(script=[("boom", {"x": 1})], final="recovered")
    result = run_agent(calculator(llm, tools=[boom]), "blow up")
    assert str(result) == "recovered"

    events = read_events(tmp_path)
    result_event = only(events, "tool_result")[0]
    assert result_event["error"] == "RuntimeError: tool exploded"
    # The span that owns the failure reports it. A standalone `error` event
    # would double-count on sessionSummary.errorCount.
    assert only(events, "error") == []
    # The agent recovered, so the run did not fail.
    assert only(events, "agent_end")[0]["outcome"] == "success"


def test_a_failing_workflow_step_reports_once_and_fails_the_agent(instrumented, tmp_path):
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Bad(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            raise ValueError("workflow blew up")

    with pytest.raises(ValueError):
        run_workflow(Bad(timeout=5))

    events = read_events(tmp_path)
    completed = only(events, "hook_completed")[0]
    assert completed["outcome"] == "failed"
    assert completed["error"] == "ValueError: workflow blew up"
    assert only(events, "error") == [], "the step owns this failure; do not count it twice"
    assert only(events, "agent_end")[0]["outcome"] == "failed"
    assert_rendering_invariants(events)


def test_a_run_level_failure_nobody_owns_gets_one_error_event(instrumented, tmp_path):
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Slow(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            await asyncio.sleep(5)
            return StopEvent(result="never")

    with pytest.raises(Exception):
        run_workflow(Slow(timeout=0.3))

    events = read_events(tmp_path)
    errors = only(events, "error")
    # Nothing below the run reported the timeout, so exactly one standalone
    # `error` carries it — and it comes strictly BEFORE agent_end, because the
    # graph closes the agent span at agent_end and an error after it is
    # attributed to nothing.
    assert len(errors) == 1
    assert errors[0]["error_type"] == "WorkflowTimeoutError"
    assert types_of(events).index("error") < types_of(events).index("agent_end")
    assert only(events, "agent_end")[0]["outcome"] == "failed"
    assert_rendering_invariants(events)


def test_a_failed_agent_end_says_what_killed_the_run(instrumented, tmp_path):
    """`outcome="failed"` is not a reason, and `summary` is a promoted column.

    The failing step's `hook_completed` does carry the error, but that is
    payload-only — and with `steps=False` it is not emitted at all, which leaves
    a failed run with its cause recorded precisely nowhere.
    """
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Bad(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            raise ValueError("workflow blew up")

    with pytest.raises(ValueError):
        run_workflow(Bad(timeout=5))

    end = only(read_events(tmp_path), "agent_end")[0]
    assert end["outcome"] == "failed"
    assert end["summary"] == "ValueError: workflow blew up"


def test_a_timed_out_agent_end_says_what_killed_the_run(instrumented, tmp_path):
    """Same promise on the other failure path, where there IS an error event."""
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Slow(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            await asyncio.sleep(5)
            return StopEvent(result="never")

    with pytest.raises(Exception):
        run_workflow(Slow(timeout=0.3))

    end = only(read_events(tmp_path), "agent_end")[0]
    assert end["outcome"] == "failed"
    assert end["summary"].startswith("WorkflowTimeoutError:")


def test_a_translator_that_raises_on_every_call_does_not_break_the_run(
    instrumented, tmp_path, monkeypatch, caplog
):
    """The whole failure policy, proved rather than asserted.

    This also covers the LlamaIndex-specific hazard: the dispatcher wraps every
    handler call in `except BaseException: pass` **with no logging**, so an
    adapter bug is invisible unless we log it ourselves.
    """
    state = instrumented.state

    def explode(*args, **kwargs):
        raise RuntimeError("translator is broken")

    monkeypatch.setattr(type(state), "span_enter", explode)
    monkeypatch.setattr(type(state), "span_exit", explode)
    monkeypatch.setattr(type(state), "span_drop", explode)
    monkeypatch.setattr(type(state), "model_start", explode)
    monkeypatch.setattr(type(state), "model_end", explode)

    caplog.set_level("WARNING", logger="failproofai_sdk.integrations")
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    assert str(run_agent(calculator(llm), "2+3?")) == "5"

    logged = " ".join(record.getMessage() for record in caplog.records)
    # BOTH handlers, named individually: the span handler alone satisfying this
    # would let an unwrapped `handle()` through, and the event handler is where
    # every model event comes from.
    # Match the qualname exactly: `.handle` alone is a substring of
    # `.handler_classes`, which appears in every site name in this module.
    assert "FailproofAISpanHandler.new_span" in logged, (
        "the span handler swallowed its exception silently"
    )
    assert "FailproofAIEventHandler.handle" in logged, (
        "the EVENT handler swallowed its exception without logging — the "
        "dispatcher already does that for us, with no traceback and no name"
    )
    _core.reset_failures()


def test_strict_mode_still_cannot_take_the_run_down(instrumented, tmp_path, monkeypatch):
    """FAILPROOFAI_SDK_STRICT re-raises out of `safe()` — and the dispatcher eats it.

    Worth pinning: strict mode is a debugging switch, not a way to make an
    instrumented LlamaIndex application fail fast. Anyone reaching for it to
    "make errors loud in prod" should read this test first.
    """
    state = instrumented.state
    _core.set_strict(True)

    def explode(*args, **kwargs):
        raise RuntimeError("translator is broken")

    monkeypatch.setattr(type(state), "span_enter", explode)
    llm = StubLLM(script=[], final="ok")
    assert str(run_agent(calculator(llm), "hi")) == "ok"


# ---------------------------------------------------------------------------
# Human in the loop
# ---------------------------------------------------------------------------

def test_human_in_the_loop_emits_both_pairs(instrumented, tmp_path):
    from llama_index.core.workflow import Context, HumanResponseEvent, InputRequiredEvent

    async def ask_human(ctx: Context, question: str) -> str:
        """Ask the human a question."""
        answer = await ctx.wait_for_event(
            HumanResponseEvent,
            waiter_id="ask",
            waiter_event=InputRequiredEvent(prefix=question),
        )
        return answer.response

    async def converse() -> str:
        llm = StubLLM(script=[("ask_human", {"question": "ok?"})], final="the human said yes")
        agent = calculator(llm, tools=[ask_human])
        handler = agent.run("ask them")
        async for event in handler.stream_events():
            if isinstance(event, InputRequiredEvent):
                handler.ctx.send_event(HumanResponseEvent(response="yes"))
        return str(await handler)

    assert asyncio.run(converse()) == "the human said yes"

    events = read_events(tmp_path)
    kinds = types_of(events)
    # Both pairs, in this order. Only agent_pause/agent_resume feeds the
    # graph's paused time; only human_wait/human_input carries the prompt and
    # the pending-human badge. Neither alone is sufficient.
    assert kinds.index("human_wait") < kinds.index("agent_pause")
    assert kinds.index("agent_pause") < kinds.index("agent_resume")
    assert kinds.index("agent_resume") < kinds.index("human_input")

    wait = only(events, "human_wait")[0]
    pause = only(events, "agent_pause")[0]
    resume = only(events, "agent_resume")[0]
    given = only(events, "human_input")[0]
    assert wait["input_id"] == pause["pause_id"] == resume["pause_id"] == given["input_id"]
    assert wait["prompt"] and "ok?" in wait["prompt"]
    assert isinstance(resume["duration_ms"], int)
    assert isinstance(given["duration_ms"], int)
    assert_rendering_invariants(events)


def test_a_paused_tool_does_not_collide_with_its_retry(instrumented, tmp_path):
    """LlamaIndex re-runs a paused tool from scratch, reusing its tool_id.

    Two `tool_use`/`tool_result` pairs sharing one `tool_call_id` in a session
    would pair wrongly and report a nonsense duration, so the retry is suffixed.
    """
    from llama_index.core.workflow import Context, HumanResponseEvent, InputRequiredEvent

    async def ask_human(ctx: Context, question: str) -> str:
        """Ask the human a question."""
        answer = await ctx.wait_for_event(
            HumanResponseEvent,
            waiter_id="ask",
            waiter_event=InputRequiredEvent(prefix=question),
        )
        return answer.response

    async def converse() -> None:
        llm = StubLLM(script=[("ask_human", {"question": "ok?"})], final="done")
        handler = calculator(llm, tools=[ask_human]).run("ask them")
        async for event in handler.stream_events():
            if isinstance(event, InputRequiredEvent):
                handler.ctx.send_event(HumanResponseEvent(response="yes"))
        await handler

    asyncio.run(converse())

    events = read_events(tmp_path)
    ids = [event["tool_call_id"] for event in only(events, "tool_use")]
    assert ids == ["call_0", "call_0#1"]
    assert [e["tool_call_id"] for e in only(events, "tool_result")] == ids
    assert only(events, "tool_result")[0]["fw_closed_by"] == "human_wait"


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------

def test_a_nested_workflow_becomes_a_nested_agent(instrumented, tmp_path):
    from llama_index.core.workflow import Event, StartEvent, StopEvent, Workflow, step

    class Mid(Event):
        payload: str

    class Inner(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            return StopEvent(result="inner-done")

    class Outer(Workflow):
        @step
        async def first(self, ev: StartEvent) -> Mid:
            return Mid(payload="hi")

        @step
        async def second(self, ev: Mid) -> StopEvent:
            return StopEvent(result=str(await Inner(timeout=5).run()))

    assert str(run_workflow(Outer(timeout=5))) == "inner-done"

    events = read_events(tmp_path)
    starts = only(events, "agent_start")
    assert [start["agent_id"] for start in starts] == ["Outer", "Inner"]
    assert "parent_id" not in starts[0]
    assert starts[1]["parent_id"] == "Outer"
    assert len({event["session_id"] for event in events}) == 1
    assert_rendering_invariants(events)


# ---------------------------------------------------------------------------
# AgentWorkflow handoffs
#
# `AgentWorkflow` does NOT run its agents as nested workflows: there is one
# `AgentWorkflow.run` span and the agents are steps inside it. Read off the span
# tree alone a two-agent crew is one flat `agent_id="AgentWorkflow"` and the
# handoff is invisible, so the adapter keys nested agents off the
# `current_agent_name` the runtime puts on every AgentInput/AgentSetup/
# AgentOutput instead.
# ---------------------------------------------------------------------------

HANDOFF_TO_ANALYST = ("handoff", {"to_agent": "analyst", "reason": "over to you"})
HANDOFF_TO_RESEARCHER = ("handoff", {"to_agent": "researcher", "reason": "back to you"})


def crew(researcher_llm, analyst_llm, *, handoff_back=False):
    """A real two-agent `AgentWorkflow` — the API LlamaIndex documents."""
    from llama_index.core.agent.workflow import AgentWorkflow, FunctionAgent

    researcher = FunctionAgent(
        name="researcher",
        description="looks numbers up",
        tools=[add],
        llm=researcher_llm,
        streaming=False,
        can_handoff_to=["analyst"],
    )
    analyst = FunctionAgent(
        name="analyst",
        description="does the maths",
        tools=[add],
        llm=analyst_llm,
        streaming=False,
        # `None` here would mean "may hand off to anyone", which loops.
        can_handoff_to=["researcher"] if handoff_back else [],
    )
    return AgentWorkflow(agents=[researcher, analyst], root_agent="researcher")


def test_an_agent_workflow_handoff_is_two_nested_agents_not_one_flat_one(
    instrumented, tmp_path
):
    """The names a customer facets by are `researcher` and `analyst`.

    Flattened, every event in the session carries `agent_id="AgentWorkflow"` and
    the two agents are distinguishable only by a payload extra, which
    `agent_id`-keyed surfaces cannot group by at all.
    """
    workflow = crew(
        StubLLM(script=[("add", {"a": 1, "b": 1}), HANDOFF_TO_ANALYST]),
        StubLLM(script=[("add", {"a": 2, "b": 3})], final="5"),
    )
    assert str(run_workflow(workflow, user_msg="add things")) == "5"

    events = read_events(tmp_path)
    starts = only(events, "agent_start")
    assert [start["agent_id"] for start in starts] == [
        "AgentWorkflow",
        "researcher",
        "analyst",
    ]
    assert "parent_id" not in starts[0]
    assert starts[1]["parent_id"] == "AgentWorkflow"
    assert starts[2]["parent_id"] == "AgentWorkflow"
    assert len({event["session_id"] for event in events}) == 1

    # Sticky, and this is the subtle half: `ToolCall` carries no
    # `current_agent_name`, so a `call_tool` step has to keep whichever agent
    # asked for the tool.
    assert [(e["agent_id"], e["tool_name"]) for e in only(events, "tool_use")] == [
        ("researcher", "add"),
        ("researcher", "handoff"),
        ("analyst", "add"),
    ]
    assert {e["agent_id"] for e in only(events, "model_request")} == {
        "researcher",
        "analyst",
    }
    assert_rendering_invariants(events)


def test_a_standalone_function_agent_does_not_nest_inside_itself(instrumented, tmp_path):
    """The guard on the rule above, and the reason it is `name != agent_id`.

    A standalone `FunctionAgent.run` drives those same `AgentWorkflow` steps
    with its OWN name in `current_agent_name`. Without the guard every
    single-agent run would open a `calc` nested inside a `calc` — doubling the
    agent count on every LlamaIndex session in the product.
    """
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    events = read_events(tmp_path)
    assert [start["agent_id"] for start in only(events, "agent_start")] == ["calc"]
    assert types_of(events) == ONE_TOOL_SEQUENCE
    assert_rendering_invariants(events)


def test_a_handoff_back_opens_the_first_agent_again_as_a_second_turn(
    instrumented, tmp_path
):
    """A -> B -> A: two turns for `researcher`, each opened and closed on its own.

    The nested agent is keyed per turn rather than per name. Reusing the key of
    the `researcher` we already ended would collide in the tracker, and one of
    the two `agent_start`s would never be closed.
    """
    workflow = crew(
        StubLLM(script=[HANDOFF_TO_ANALYST], final="done"),
        StubLLM(script=[HANDOFF_TO_RESEARCHER]),
        handoff_back=True,
    )
    assert str(run_workflow(workflow, user_msg="round trip")) == "done"

    events = read_events(tmp_path)
    assert [start["agent_id"] for start in only(events, "agent_start")] == [
        "AgentWorkflow",
        "researcher",
        "analyst",
        "researcher",
    ]
    # Inner-first, and every open closed: the invariant check below fails on an
    # agent left open, which is what a key collision would produce.
    assert [end["agent_id"] for end in only(events, "agent_end")] == [
        "researcher",
        "analyst",
        "researcher",
        "AgentWorkflow",
    ]
    assert_rendering_invariants(events)


def test_sub_agents_are_still_attributed_with_the_step_hooks_off(
    instrumented_without_steps, tmp_path
):
    """`steps=False` drops the hook pairs, not the agents.

    The sub-agent is resolved when the step span OPENS, which is a different
    code path from the `hook_triggered` the option suppresses — so it is worth
    proving rather than assuming.
    """
    workflow = crew(
        StubLLM(script=[HANDOFF_TO_ANALYST]),
        StubLLM(script=[("add", {"a": 2, "b": 3})], final="5"),
    )
    assert str(run_workflow(workflow, user_msg="add things")) == "5"

    events = read_events(tmp_path)
    assert only(events, "hook_triggered") == []
    assert only(events, "hook_completed") == []
    assert [start["agent_id"] for start in only(events, "agent_start")] == [
        "AgentWorkflow",
        "researcher",
        "analyst",
    ]
    assert [(e["agent_id"], e["tool_name"]) for e in only(events, "tool_use")] == [
        ("researcher", "handoff"),
        ("analyst", "add"),
    ]
    assert_rendering_invariants(events)


def test_two_concurrent_runs_do_not_mix(instrumented, tmp_path):
    """Two overlapping runs, one process, one dispatcher, no contextvars.

    The whole reason `RunTracker` passes `session_id=` explicitly instead of
    reading a contextvar: a start and its end are separate dispatcher calls,
    and interleaved runs would otherwise attribute events to whichever run
    happened to touch the variable last.
    """

    async def both():
        left = calculator(StubLLM(script=[("add", {"a": 1, "b": 1})], final="2"))
        right = calculator(StubLLM(script=[("add", {"a": 3, "b": 4})], final="7"))
        return await asyncio.gather(left.run("1+1?"), right.run("3+4?"))

    answers = {str(answer) for answer in asyncio.run(both())}
    assert answers == {"2", "7"}

    events = read_events(tmp_path)
    sessions = {event["session_id"] for event in events}
    assert len(sessions) == 2

    for session in sessions:
        rows = [event for event in events if event["session_id"] == session]
        assert types_of(rows) == ONE_TOOL_SEQUENCE
        assert_rendering_invariants(rows)
        # Each session saw exactly one of the two tool calls, whole.
        inputs = [event["input"] for event in rows if event["type"] == "tool_use"]
        assert inputs in ([{"a": 1, "b": 1}], [{"a": 3, "b": 4}])


def test_a_retrieval_becomes_a_tool_with_a_summarized_output(instrumented, tmp_path):
    from llama_index.core.base.base_retriever import BaseRetriever
    from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Fake(BaseRetriever):
        def _retrieve(self, query_bundle: QueryBundle):
            return [
                NodeWithScore(node=TextNode(text="x" * 5000, id_=f"n{i}"), score=1.0)
                for i in range(12)
            ]

    class Rag(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            return StopEvent(result=f"{len(Fake().retrieve('what?'))} nodes")

    assert str(run_workflow(Rag(timeout=5))) == "12 nodes"

    events = read_events(tmp_path)
    use = only(events, "tool_use")[0]
    result = only(events, "tool_result")[0]
    assert use["tool_name"] == "Fake"
    assert use["input"] == {"query": "what?"}
    assert use["fw_kind"] == "retrieval"
    # Retrieved documents are the largest strings in the process and the
    # payload is not a promoted column: summarize, never ship them whole.
    assert result["output"]["num_nodes"] == 12
    assert len(result["output"]["top"]) == 5
    assert len(result["output"]["top"][0]["text"]) <= 200
    assert_rendering_invariants(events)


def test_embeddings_are_off_by_default(instrumented, tmp_path):
    assert instrumented.state.embeddings is False


def test_no_event_carries_an_extra_that_shadows_a_declared_field(instrumented, tmp_path):
    """`_schema._build()` merges extras LAST, at the top level.

    So an extra called `tool_name`, `model`, `outcome` or `input_tokens`
    silently overwrites the declared field — changing the promoted the events store
    column and the server's computed summary while every test still passes.
    """
    llm = StubLLM(script=[("add", {"a": 2, "b": 3})], final="5")
    run_agent(calculator(llm), "2+3?")

    by_type = {}
    for name, obj in vars(_schema).items():
        if name.endswith("Event") and hasattr(obj, "__dataclass_fields__"):
            kind = "".join("_" + c.lower() if c.isupper() else c for c in name[:-5]).lstrip("_")
            by_type[kind] = {f.name for f in dataclass_fields(obj)} - {"extra_fields"}

    for event in read_events(tmp_path):
        declared = by_type[event["type"]] | {"type", "environment"}
        extras = set(event) - declared
        assert not (extras & _core.FORBIDDEN_EXTRAS), f"{event['type']} shadows {extras}"
        for key in extras:
            assert key.startswith("fw_") or key in _core.ALLOWED_TOP_LEVEL, (
                f"{event['type']} carries un-namespaced extra {key!r}"
            )


# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

def test_uninstrument_detaches_only_our_handlers(tmp_path):
    from llama_index.core.instrumentation import get_dispatcher
    from llama_index_instrumentation.event_handlers.base import BaseEventHandler

    class Foreign(BaseEventHandler):
        def handle(self, event, **kwargs):
            return None

    dispatcher = get_dispatcher()
    foreign = Foreign()
    dispatcher.add_event_handler(foreign)
    before_events = list(dispatcher.event_handlers)
    before_spans = list(dispatcher.span_handlers)
    try:
        failproofai_sdk.instrument("llama_index")
        assert len(dispatcher.event_handlers) == len(before_events) + 1
        assert len(dispatcher.span_handlers) == len(before_spans) + 1
        failproofai_sdk.uninstrument("llama_index")
        # In-place slice assignment: `add_span_handler` does `+= [h]`, so a
        # plain `=` rebinds the pydantic field and can drop someone else's.
        assert list(dispatcher.event_handlers) == before_events
        assert list(dispatcher.span_handlers) == before_spans
        assert foreign in dispatcher.event_handlers
    finally:
        dispatcher.event_handlers[:] = [h for h in dispatcher.event_handlers if h is not foreign]


ROOT_SPAN = "Empty.run-11111111-1111-4111-8111-111111111111"
TOOL_SPAN = "FunctionTool.acall-22222222-2222-4222-8222-222222222222"
LLM_SPAN = "StubLLM.astream_chat-44444444-4444-4444-8444-444444444444"


def _bound_args():
    """A real `inspect.BoundArguments`, which is what the dispatcher passes."""

    def target(a=None, b=None):
        return None

    return inspect.signature(target).bind()


def _empty_workflow():
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    class Empty(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            return StopEvent(result="ok")

    return Empty()


def _fake_tool():
    class _Metadata:
        name = "adder"

    class _Tool(BaseTool):
        metadata = _Metadata()

        def __call__(self, *args, **kwargs):
            return None

    return _Tool()


def _open_a_run_holding_a_tool(state):
    """Drive the real span handler to a run with one leaf still open.

    Synthetic span ids, real handler, real base class: this is the state a
    process is in when a run dies mid-tool, which no cooperative workflow will
    produce on demand.
    """
    _, span_cls = adapter_module.handler_classes()
    handler = span_cls(state=state)
    bound = _bound_args()
    handler.span_enter(id_=ROOT_SPAN, bound_args=bound, instance=_empty_workflow(), parent_id=None)
    handler.span_enter(id_=TOOL_SPAN, bound_args=bound, instance=_fake_tool(), parent_id=ROOT_SPAN)
    assert state._runs[ROOT_SPAN].open_leaves, "the tool leaf should be open"
    return handler, bound


def test_a_run_that_ends_holding_an_open_tool_closes_it(instrumented, tmp_path):
    """Invariant 4, at the run boundary.

    `agent_end` force-closes open *pauses* but not tools or models, so a run
    that finishes while a leaf is open leaves the session `ongoing` forever —
    and nothing else in the suite notices, because a cooperative workflow
    always closes its own leaves.
    """
    state = instrumented.state
    handler, bound = _open_a_run_holding_a_tool(state)

    handler.span_exit(id_=ROOT_SPAN, bound_args=bound, instance=None, result=None)

    events = read_events(tmp_path)
    assert types_of(events) == ["agent_start", "tool_use", "tool_result", "agent_end"]
    assert only(events, "tool_result")[0]["fw_closed_by"] == "run_ended"
    assert only(events, "agent_end")[0]["outcome"] == "success"
    assert_rendering_invariants(events)


def test_shutdown_closes_every_leaf_a_dead_run_left_open(instrumented, tmp_path):
    """Same invariant at the uninstrument boundary: nothing is left dangling."""
    state = instrumented.state
    _open_a_run_holding_a_tool(state)

    failproofai_sdk.uninstrument("llama_index")

    events = read_events(tmp_path)
    assert types_of(events) == ["agent_start", "tool_use", "tool_result", "agent_end"]
    assert only(events, "tool_result")[0]["fw_closed_by"] == "uninstrument"
    assert only(events, "agent_end")[0]["outcome"] == "cancelled"
    assert_rendering_invariants(events)


def test_the_reaper_closes_a_stale_parked_stream(instrumented, tmp_path):
    """A streaming response nobody consumes never gets an LLMChatEndEvent.

    Its span has already exited, so nothing else will ever close it: without
    the sweep the model_request stays open and the session reads `ongoing`
    forever.
    """
    state = instrumented.state
    event_cls, span_cls = adapter_module.handler_classes()
    spans = span_cls(state=state)
    events_handler = event_cls(state=state)

    from llama_index.core.instrumentation.events.llm import LLMChatStartEvent

    bound = _bound_args()
    spans.span_enter(id_=ROOT_SPAN, bound_args=bound, instance=_empty_workflow(), parent_id=None)
    spans.span_enter(id_=LLM_SPAN, bound_args=bound, instance=StubLLM(), parent_id=ROOT_SPAN)
    events_handler.handle(
        LLMChatStartEvent(span_id=LLM_SPAN, messages=[], additional_kwargs={}, model_dict={})
    )
    # The span exits the instant the generator is created; nobody consumes it.
    spans.span_exit(id_=LLM_SPAN, bound_args=bound, instance=None, result=iter([]))

    assert state._leaf_run.get(LLM_SPAN) == ROOT_SPAN
    state.stale_after = 0.0
    assert state.sweep() == 1
    assert state.sweep() == 0

    response = only(read_events(tmp_path), "model_response")[0]
    assert response["fw_closed_by"] == "stale"
    assert isinstance(response["duration_ms"], int)


# ---------------------------------------------------------------------------
# Cancellation
#
# `handler.cancel_run()` does NOT drop the run span. The runtime catches its own
# `WorkflowCancelledByUser` and exits the span cleanly, with `result=None` and
# no error — "so it shows as OK rather than ERROR in traces". Read off the span
# alone, a user pressing stop is indistinguishable from a completed run, which
# is why the adapter listens for `SpanCancelledEvent`.
# ---------------------------------------------------------------------------

def _cancel_a_run_mid_step() -> None:
    """Cancel a real run while a step is in flight, the way a stop button does."""
    from llama_index.core.workflow import StartEvent, StopEvent, Workflow, step

    started = asyncio.Event()

    class Slow(Workflow):
        @step
        async def go(self, ev: StartEvent) -> StopEvent:
            started.set()
            await asyncio.sleep(30)
            return StopEvent(result="never")

    async def _main() -> None:
        handler = Slow(timeout=30).run()
        await asyncio.wait_for(started.wait(), timeout=5)
        await handler.cancel_run()
        with pytest.raises(BaseException):
            await handler

    asyncio.run(_main())


def test_a_cancelled_run_is_not_reported_as_a_success(instrumented, tmp_path):
    """Reporting a cancellation as success inflates the completion rate.

    `cancelled` is deliberately not `failed` either: the server counts only
    `error|failed|timeout|rejected` as a failure, and a stop button is neither.
    """
    _cancel_a_run_mid_step()

    events = read_events(tmp_path)
    assert only(events, "agent_end")[0]["outcome"] == "cancelled"
    # A cancellation is not an error, so nothing may report one.
    assert only(events, "error") == []
    assert_rendering_invariants(events)


def test_a_step_cancelled_mid_flight_is_not_reported_as_a_success(
    instrumented, tmp_path
):
    """Same signal one level down: the step exits with `result=None`, no error."""
    _cancel_a_run_mid_step()

    completed = only(read_events(tmp_path), "hook_completed")
    assert completed, "the in-flight step still has to close"
    assert [hook["outcome"] for hook in completed] == ["cancelled"]


# ---------------------------------------------------------------------------
# Structural anti-drift — the one that catches a silently dead adapter
# ---------------------------------------------------------------------------

def _our_overrides(cls, base) -> set[str]:
    return {
        name
        for name in vars(cls)
        if not name.startswith("__")
        and inspect.isroutine(getattr(cls, name, None))
        and hasattr(base, name)
    }


def _named_params(func) -> set[str]:
    return {
        name
        for name, parameter in inspect.signature(func).parameters.items()
        if name not in {"self", "cls"}
        and parameter.kind
        not in (inspect.Parameter.VAR_KEYWORD, inspect.Parameter.VAR_POSITIONAL)
    }


def test_our_overrides_still_exist_on_the_framework_base_classes():
    """If upstream renames a callback, our override becomes DEAD CODE.

    It is never called, nothing raises, and every other test in this file still
    passes because they exercise the adapter through our own objects. This is
    the only test that notices.
    """
    from llama_index_instrumentation.event_handlers.base import BaseEventHandler
    from llama_index_instrumentation.span_handlers.base import BaseSpanHandler

    event_cls, span_cls = adapter_module.handler_classes()

    for cls, base, expected in (
        (event_cls, BaseEventHandler, {"handle"}),
        (span_cls, BaseSpanHandler, {"new_span", "prepare_to_exit_span", "prepare_to_drop_span"}),
    ):
        overrides = _our_overrides(cls, base)
        assert expected <= overrides, f"{cls.__name__} no longer overrides {expected - overrides}"
        for name in overrides:
            ours = getattr(cls, name)
            theirs = getattr(base, name, None)
            assert inspect.isroutine(theirs), f"{base.__name__}.{name} is gone"
            missing = _named_params(ours) - _named_params(theirs)
            assert not missing, (
                f"{cls.__name__}.{name} declares {sorted(missing)}, which "
                f"{base.__name__}.{name} no longer accepts by name"
            )


def test_the_span_enter_to_new_span_kwarg_rename_still_holds():
    """`span_enter(parent_id=...)` calls `new_span(parent_span_id=...)`.

    Declaring the wrong one is not an error — it lands in `**kwargs`, every
    parent comes through as None, and the whole trace renders flat.
    """
    from llama_index_instrumentation.span_handlers.base import BaseSpanHandler

    assert "parent_id" in _named_params(BaseSpanHandler.span_enter)
    assert "parent_span_id" in _named_params(BaseSpanHandler.new_span)
    assert "parent_span_id" not in _named_params(BaseSpanHandler.span_enter)

    _, span_cls = adapter_module.handler_classes()
    assert "parent_span_id" in _named_params(span_cls.new_span)


def test_every_dispatcher_event_class_we_dispatch_on_still_exists():
    """We dispatch on the event's class NAME, so these names are the API.

    A rename upstream leaves the table below looking perfectly healthy while
    the adapter records nothing at all.
    """
    import importlib

    modules = [
        importlib.import_module(f"llama_index.core.instrumentation.events.{name}")
        for name in ("llm", "chat_engine", "retrieval", "embedding", "exception")
    ]
    for name in adapter_module._HANDLED_EVENTS:
        assert any(hasattr(module, name) for module in modules), (
            f"{name} no longer exists in llama_index.core.instrumentation.events"
        )


def test_the_cancel_event_we_dispatch_on_still_exists_where_we_expect_it():
    """`CANCEL_EVENTS` has no other guard in this file, by construction.

    Every other name we dispatch on lives under
    `llama_index.core.instrumentation.events.*`, which the test above walks.
    This one is dispatched by the workflows RUNTIME, so that test cannot see it
    — and if it is renamed or moved, nothing raises: cancelled runs quietly go
    back to being reported as successes.
    """
    import importlib

    from llama_index.core.instrumentation.events.base import BaseEvent

    module = importlib.import_module("workflows.runtime.types.step_function")
    for name in adapter_module.CANCEL_EVENTS:
        cls = getattr(module, name, None)
        assert cls is not None, f"{name} is gone from {module.__name__}"
        assert issubclass(cls, BaseEvent), f"{name} is no longer a dispatcher event"
        # We match on the class name and pair the mark with the span_exit behind
        # it using `span_id`, which the dispatcher stamps from the active span.
        assert cls.class_name() == name
        assert "span_id" in cls.model_fields

    # And the exception that path exists to serve, which `cancel_run()` raises.
    from workflows.errors import WorkflowCancelledByUser

    assert issubclass(WorkflowCancelledByUser, BaseException)


@pytest.mark.parametrize(
    ("module", "event", "attributes"),
    [
        ("llm", "LLMChatStartEvent", ("messages", "model_dict")),
        ("llm", "LLMChatEndEvent", ("messages", "response")),
        ("retrieval", "RetrievalStartEvent", ("str_or_query_bundle",)),
        ("retrieval", "RetrievalEndEvent", ("nodes",)),
        ("exception", "ExceptionEvent", ("exception",)),
    ],
)
def test_the_event_attributes_we_read_still_exist(module, event, attributes):
    import importlib

    cls = getattr(importlib.import_module(f"llama_index.core.instrumentation.events.{module}"), event)
    for attribute in attributes:
        assert attribute in cls.model_fields, f"{event}.{attribute} is gone"


def test_the_waiting_for_event_signal_still_looks_like_we_think_it_does():
    """HITL hinges on a name match: `WaitingForEvent` is a pause, not an error.

    It is not exported from `workflows.errors` and has moved before, so we
    match on the class name. If it is renamed, every human-in-the-loop pause
    becomes a red error event and a failed run.
    """
    from workflows.runtime.types.results import AddWaiter, WaitingForEvent

    assert WaitingForEvent.__name__ == "WaitingForEvent"
    assert issubclass(WaitingForEvent, Exception)
    assert "waiter_id" in AddWaiter.model_fields
    assert "waiter_event" in AddWaiter.model_fields
    assert adapter_module._is_waiting(WaitingForEvent.__new__(WaitingForEvent)) is True
    assert adapter_module._is_waiting(RuntimeError("nope")) is False


def test_the_dispatcher_surface_we_register_on_still_exists():
    from llama_index.core.instrumentation import get_dispatcher

    dispatcher = get_dispatcher()
    assert dispatcher.name == "root", "get_dispatcher() must return the ROOT dispatcher"
    assert callable(dispatcher.add_event_handler)
    assert callable(dispatcher.add_span_handler)
    # Child dispatchers propagate upward; that is why one registration is enough.
    assert get_dispatcher("llama_index.core.something").propagate is True


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------

def test_the_registry_reaches_this_adapter_by_all_its_spellings():
    from failproofai_sdk.integrations import _canonical

    for spelling in ("llama_index", "llamaindex", "llama-index", "LlamaIndex"):
        assert _canonical(spelling) == "llama_index"


def test_instrumenting_twice_is_a_no_op(tmp_path):
    from failproofai_sdk.integrations import active

    try:
        assert failproofai_sdk.instrument("llama_index") == ("llama_index",)
        assert failproofai_sdk.instrument("llama_index") == ()
        assert "llama_index" in active()
    finally:
        failproofai_sdk.uninstrument("llama_index")


def test_uninstrumenting_something_that_was_never_installed_is_a_no_op():
    assert failproofai_sdk.uninstrument("llama_index") == ()


def test_the_adapter_joins_a_hand_written_agent_scope(instrumented, tmp_path):
    """The interop story: adapter events land in the ambient session.

    `RunTracker.identity()` falls back to `failproofai_sdk.current()`, so mixing the
    manual API with an adapter produces one tree rather than two.
    """
    llm = StubLLM(script=[], final="5")
    with failproofai_sdk.agent("planner", goal="do maths") as identity:
        run_agent(calculator(llm), "2+3?")
        session_id = identity.session_id

    events = read_events(tmp_path)
    assert {event["session_id"] for event in events} == {session_id}
    starts = only(events, "agent_start")
    assert [start["agent_id"] for start in starts] == ["planner", "calc"]
    assert starts[1]["parent_id"] == "planner"
