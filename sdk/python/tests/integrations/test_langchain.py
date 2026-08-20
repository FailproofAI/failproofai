"""The LangChain / LangGraph adapter, against the real framework.

Everything here runs a **real** graph on a **fake** chat model
(`GenericFakeChatModel` — no network, no key, deterministic) and then reads the
JSONL the writer actually produced. Nothing asserts on mock call arguments: the
whole failure mode this adapter exists inside is "the events looked right in a
mock and were wrong on disk".

Two of these tests are worth more than the rest put together:

* `test_every_override_still_exists_on_its_framework_base` — if upstream renames
  a callback, our override becomes **dead code that is never called** and every
  behavioural test below still passes, because they only ever assert on events
  we did emit. Reflection over the class is the only thing that catches it.
* `test_the_node_filter_still_matches_real_langgraph_metadata` — the same
  problem one layer down. The node/inner-runnable filter is a string comparison
  against `metadata["langgraph_node"]`; if that key moves, every node silently
  stops being a hook and the timeline just gets shorter.
"""

import inspect
import json
import logging
import operator
import os
from typing import Annotated, TypedDict

import pytest

import failproofai_sdk
from failproofai_sdk.integrations import _compat, _core

pytestmark = pytest.mark.framework

# `importorskip` is fail-open: misspell the module and every test here skips
# while CI stays green having tested nothing. The framework CI leg sets this
# env var, which turns the skip into an import error.
if os.environ.get("AGENTEYE_TESTS_REQUIRE_FRAMEWORKS"):
    import langchain_core  # noqa: F401
    import langgraph  # noqa: F401
else:
    pytest.importorskip("langchain_core")
    pytest.importorskip("langgraph")

from langchain_core.documents import Document  # noqa: E402
from langchain_core.language_models.fake_chat_models import (  # noqa: E402
    FakeListChatModel,
    GenericFakeChatModel,
)
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: E402
from langchain_core.retrievers import BaseRetriever  # noqa: E402
from langchain_core.runnables import RunnableConfig, RunnableLambda  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from langgraph.prebuilt import ToolNode  # noqa: E402
from langgraph.types import Command, Send, interrupt  # noqa: E402

from failproofai_sdk.integrations import langchain as adapter  # noqa: E402

WATCHED_LOGGERS = ("failproofai_sdk.integrations", "langchain_core.callbacks.manager")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

class _Sink(logging.Handler):
    """Collects anything the adapter (or LangChain) swallowed.

    LangChain firewalls handler exceptions in `handle_event` — it catches, logs
    a WARNING and carries on — and `_core.safe` does the same one layer in. So a
    broken translator produces a **green test** and a log line. This turns that
    log line into a failure, which is the only way these tests mean anything.
    """

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.records = []
        self.allow = False

    def emit(self, record):
        self.records.append(record)


@pytest.fixture(autouse=True)
def sink():
    handler = _Sink()
    loggers = [logging.getLogger(name) for name in WATCHED_LOGGERS]
    for logger in loggers:
        logger.addHandler(handler)
    try:
        yield handler
    finally:
        for logger in loggers:
            logger.removeHandler(handler)
    if not handler.allow and handler.records:
        pytest.fail(
            "instrumentation failure was swallowed and only logged:\n"
            + "\n".join(handler.format(r) for r in handler.records)
        )


@pytest.fixture(autouse=True)
def _adapter_state(monkeypatch, tmp_path):
    import shutil

    from failproofai_sdk import _runtime

    monkeypatch.delenv("FAILPROOFAI_SDK_STRICT", raising=False)
    monkeypatch.delenv("FAILPROOFAI_SDK_STRICT_INTEGRATIONS", raising=False)
    monkeypatch.delenv(adapter.ENV_VAR, raising=False)
    _core.set_strict(None)
    _compat.set_strict_integrations(None)
    _core.reset_failures()
    _compat.reset_warnings()
    # Instrumentation is process-global and `instrument()` with no argument
    # installs every *detected* framework — so another test file that
    # auto-detected can leave this adapter active, and `instrument("langchain")`
    # would then correctly return () and this file would test nothing.
    failproofai_sdk.uninstrument()
    # The writer's own thread must not flush while a test is running: filenames
    # have millisecond resolution, so two flushes in the same millisecond
    # clobber each other and the test reads half its events.
    _runtime.writer.set_flush_interval(3600)
    # A previous test can legitimately emit *after* it read its events —
    # `uninstrument()` closes spans that were still open, which is the point.
    # Drain and discard those before this test starts, or they land in this
    # test's directory and every assertion about "the first agent_end" is wrong.
    _runtime.writer.flush_now()
    shutil.rmtree(tmp_path / "events", ignore_errors=True)
    yield
    failproofai_sdk.uninstrument()
    _runtime.writer.flush_now()
    _core.reset_failures()
    _compat.reset_warnings()
    _core.set_strict(None)
    _compat.set_strict_integrations(None)


@pytest.fixture()
def instrumented():
    assert failproofai_sdk.instrument("langchain") == ("langchain",)
    yield
    failproofai_sdk.uninstrument("langchain")


def read_events(tmp_path):
    """Flush and read what actually reached disk, in emission order."""
    failproofai_sdk._writer.flush_now()
    rows = []
    for path in sorted((tmp_path / "events").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def types_of(rows):
    return [row["type"] for row in rows]


def only(rows, *kinds):
    return [row for row in rows if row["type"] in kinds]


# ---------------------------------------------------------------------------
# Graphs
# ---------------------------------------------------------------------------

@tool
def adder(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


@tool
def exploder(x: int) -> int:
    """Always fails."""
    raise RuntimeError("tool boom")


class State(TypedDict):
    messages: Annotated[list, operator.add]
    vals: Annotated[list, operator.add]
    answer: str
    n: int


def tool_calling_message(**kwargs):
    return AIMessage(
        "planned",
        tool_calls=[{"name": "adder", "args": {"a": 1, "b": 2}, "id": "call_abc"}],
        usage_metadata={"input_tokens": 11, "output_tokens": 5, "total_tokens": 16},
        **kwargs,
    )


def fake_model(*messages):
    return GenericFakeChatModel(messages=iter(list(messages)))


def subgraph():
    sg = StateGraph(State)
    sg.add_node("sub_step", lambda state: {"vals": ["sub"]})
    sg.add_edge(START, "sub_step")
    sg.add_edge("sub_step", END)
    return sg.compile(name="child_graph")


def build_graph(*, model=None, checkpointer=None, name="root_graph"):
    """plan -> tools -> child(subgraph) -> fan-out -> ask(interrupt) -> END."""
    model = model or fake_model(tool_calling_message(), AIMessage("again"))

    def plan(state):
        reply = model.invoke(state["messages"])
        return {"messages": [reply], "n": state["n"] + 1, "vals": ["plan"]}

    def fan(state):
        return [Send("worker", {"i": i}) for i in range(2)]

    def ask(state):
        return {"answer": str(interrupt({"prompt": "approve?", "options": ["y", "n"]}))}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("tools", ToolNode([adder]))
    graph.add_node("child", subgraph())
    graph.add_node("worker", lambda state: {"vals": ["w"]})
    graph.add_node("ask", ask)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "tools")
    graph.add_edge("tools", "child")
    graph.add_conditional_edges("child", fan, ["worker"])
    graph.add_edge("worker", "ask")
    graph.add_edge("ask", END)
    return graph.compile(name=name, checkpointer=checkpointer)


def build_simple(nodes, *, name="simple", checkpointer=None, edges=None):
    graph = StateGraph(State)
    previous = START
    for node_name, fn in nodes:
        graph.add_node(node_name, fn)
        graph.add_edge(previous, node_name)
        previous = node_name
    graph.add_edge(previous, END)
    return graph.compile(name=name, checkpointer=checkpointer)


def empty_state(**kwargs):
    base = {"messages": [HumanMessage("hi")], "vals": [], "answer": "", "n": 0}
    base.update(kwargs)
    return base


def build_looping(model):
    """plan -> check -> (plan | END). Exercises a node visited more than once."""

    def plan(state):
        model.invoke(state["messages"])
        return {"n": state["n"] + 1, "vals": ["plan"]}

    def check(state):
        return {"vals": ["check"]}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("check", check)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "check")
    graph.add_conditional_edges(
        "check", lambda s: "plan" if s["n"] < 3 else END, {"plan": "plan", END: END}
    )
    return graph.compile(name="looper")


# ---------------------------------------------------------------------------
# Shape of a representative run
# ---------------------------------------------------------------------------

def test_event_type_sequence_for_a_representative_run(tmp_path, instrumented):
    model = fake_model(tool_calling_message())

    def plan(state):
        return {"messages": [model.invoke(state["messages"])], "vals": ["plan"]}

    def act(state):
        adder.invoke({"a": 1, "b": 2})
        return {"vals": ["act"]}

    app = build_simple([("plan", plan), ("act", act)], name="pipeline")
    app.invoke(empty_state(), config={"configurable": {"thread_id": "seq"}})

    assert types_of(read_events(tmp_path)) == [
        "agent_start",
        "hook_triggered",  # plan
        "model_request",
        "model_response",
        "hook_completed",
        "hook_triggered",  # act
        "tool_use",
        "tool_result",
        "hook_completed",
        "agent_end",
    ]


def test_the_root_agent_start_is_the_sessions_first_event(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "first"}}
    )
    rows = read_events(tmp_path)
    assert rows[0]["type"] == "agent_start"
    assert rows[0]["agent_id"] == "root_graph"
    assert rows[0].get("parent_id") is None
    # ...and it is the only root agent_start in the session.
    roots = [r for r in rows if r["type"] == "agent_start" and r.get("parent_id") is None]
    assert len(roots) == 1


def test_every_event_carries_one_session_id_and_the_framework(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "sess"}}
    )
    rows = read_events(tmp_path)
    assert rows
    assert {r["session_id"] for r in rows} == {"sess"}
    assert {r["framework"] for r in rows} == {"langchain"}
    assert all(r["framework_version"] for r in rows)
    assert all(r["integration_version"] for r in rows)


def test_agent_ids_are_human_readable_names_never_uuids(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "names"}}
    )
    rows = read_events(tmp_path)
    agent_ids = {r["agent_id"] for r in rows}
    assert agent_ids == {"root_graph", "root_graph/child"}
    for value in agent_ids:
        assert not _looks_like_a_uuid(value), value
    # Hook names are node names too — `hook_name` is its own facet on /hooks and
    # a uuid there is just as poisonous as one in agent_id.
    for row in only(rows, "hook_triggered", "hook_completed"):
        assert not _looks_like_a_uuid(row["hook_name"])


def _looks_like_a_uuid(value):
    import uuid

    try:
        uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def test_no_event_carries_an_extra_that_would_shadow_a_declared_field(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "shadow"}}
    )
    rows = read_events(tmp_path)
    assert rows
    # `_schema._build()` ends with `result.update(extra)`, so an extra called
    # `tool_name`, `model`, `outcome` or `input_tokens` silently OVERWRITES the
    # declared field — and therefore the promoted column and the
    # server's computed summary — while every behavioural test still passes.
    # The allowed key set is derived from `_schema`'s own dataclasses, so adding
    # a field there cannot leave a stale copy here.
    declared = _declared_fields_by_type()
    assert set(declared) == _SCHEMA_TYPES
    for row in rows:
        allowed = declared[row["type"]] | _core.ALLOWED_TOP_LEVEL
        for key in row:
            if key.startswith("fw_"):
                assert key not in _core.FORBIDDEN_EXTRAS, (row["type"], key)
                continue
            assert key in allowed, (
                "%s carries %r, which is not a field of that event — if it is an "
                "extra it must be namespaced fw_*, or it silently shadows a "
                "declared field" % (row["type"], key)
            )


def _declared_fields_by_type():
    import dataclasses
    import re

    from failproofai_sdk import _schema

    out = {}
    for name, obj in vars(_schema).items():
        if not (dataclasses.is_dataclass(obj) and isinstance(obj, type)):
            continue
        event_type = re.sub(r"(?<!^)(?=[A-Z])", "_", name[: -len("Event")]).lower()
        fields = {f.name for f in dataclasses.fields(obj)} - {"extra_fields"}
        out[event_type] = fields | {"type", "environment"}
    return out


_SCHEMA_TYPES = {
    "agent_start", "agent_end", "agent_pause", "agent_resume",
    "tool_use", "tool_result", "model_request", "model_response",
    "hook_triggered", "hook_completed", "error",
    "human_wait", "human_input", "human_pause", "human_interrupt",
}


def test_only_the_fifteen_known_event_types_are_emitted(tmp_path, instrumented):
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "vocab"}}
    app.invoke(empty_state(), config=config)
    app.invoke(Command(resume="yes"), config=config)
    assert set(types_of(read_events(tmp_path))) <= _SCHEMA_TYPES


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def test_model_events_pair_on_request_id_and_always_carry_an_int_duration(
    tmp_path, instrumented
):
    app = build_looping(fake_model(*[AIMessage("t%d" % i) for i in range(5)]))
    app.invoke(empty_state(), config={"configurable": {"thread_id": "models"}})
    rows = read_events(tmp_path)

    requests = only(rows, "model_request")
    responses = only(rows, "model_response")
    assert len(requests) == len(responses) == 3  # the loop runs `plan` three times
    assert [r["request_id"] for r in requests] == [r["request_id"] for r in responses]
    assert len({r["request_id"] for r in requests}) == 3

    for response in responses:
        # Not guarded by the SDK, and `durationOf` prefers the closing event's
        # value — which is what keeps model durations correct even though the
        # execution graph pairs model events FIFO per agent_id. Must be an int:
        # the server's JSON parser drops floats and NULLs the u32 column.
        assert isinstance(response["duration_ms"], int)
        assert not isinstance(response["duration_ms"], bool)
        assert response["duration_ms"] >= 0


def test_model_name_and_tokens_are_normalized(tmp_path, instrumented):
    app = build_simple(
        [("plan", lambda s: {"messages": [_MODEL.invoke(s["messages"])], "vals": ["p"]})],
        name="tokens",
    )
    app.invoke(empty_state(), config={"configurable": {"thread_id": "tok"}})
    response = only(read_events(tmp_path), "model_response")[0]
    assert response["model"] == "GenericFakeChatModel"
    assert response["input_tokens"] == 11
    assert response["output_tokens"] == 5
    # Shipped as a dict as well: both the server summary and the dashboard fall
    # back to payload.usage when the promoted columns are absent.
    assert response["usage"] == {"input_tokens": 11, "output_tokens": 5, "total_tokens": 16}


_MODEL = fake_model(tool_calling_message(), AIMessage("x"), AIMessage("y"))


def test_model_request_carries_normalized_messages_not_flattened_prompts(
    tmp_path, instrumented
):
    model = fake_model(AIMessage("ok"))
    app = build_simple(
        [("plan", lambda s: {"messages": [model.invoke(s["messages"])], "vals": ["p"]})],
        name="msgs",
    )
    app.invoke(empty_state(), config={"configurable": {"thread_id": "msg"}})
    request = only(read_events(tmp_path), "model_request")[0]
    # `_create_chat_model_run` flattens messages to "Human: hi" before they
    # reach the Run object, which loses the roles. We capture them from
    # `on_chat_model_start`, where they are still BaseMessage objects.
    assert request["messages"] == [{"role": "user", "content": "hi"}]


def test_streaming_never_emits_per_token_events(tmp_path, instrumented):
    model = FakeListChatModel(responses=["hello there"])
    app = build_simple(
        [("stream", lambda s: {"vals": [c.content for c in model.stream(s["messages"])]})],
        name="streamer",
    )
    app.invoke(empty_state(), config={"configurable": {"thread_id": "stream"}})
    rows = read_events(tmp_path)
    # A 500-token response must not become 500 rows against a five-lane rail.
    assert len(only(rows, "model_request")) == 1
    assert len(only(rows, "model_response")) == 1
    response = only(rows, "model_response")[0]
    assert response["fw_streamed"] is True
    assert response["fw_chunks"] >= len("hello there")
    assert isinstance(response["fw_ttft_ms"], int)


def test_a_failed_model_call_is_reported_on_the_model_span(tmp_path, instrumented, sink):
    class Boom(GenericFakeChatModel):
        def _generate(self, *args, **kwargs):
            raise RuntimeError("model 429")

    model = Boom(messages=iter([AIMessage("never")]))

    def plan(state):
        try:
            model.invoke(state["messages"])
        except RuntimeError:
            return {"vals": ["caught"]}
        return {"vals": ["nope"]}

    build_simple([("plan", plan)], name="modelfail").invoke(
        empty_state(), config={"configurable": {"thread_id": "mf"}}
    )
    rows = read_events(tmp_path)
    response = only(rows, "model_response")[0]
    assert response["stop_reason"] == "error"
    assert "model 429" in response["error"]
    assert isinstance(response["duration_ms"], int)
    # The node caught it, so nothing above owns the failure and no standalone
    # `error` event may appear — `sessionSummary.errorCount` would double-count.
    assert not only(rows, "error")
    assert only(rows, "agent_end")[0]["outcome"] == "success"


# ---------------------------------------------------------------------------
# Tools and retrievers
# ---------------------------------------------------------------------------

def test_tool_events_pair_on_tool_call_id_and_carry_a_duration(tmp_path, instrumented):
    model = fake_model(tool_calling_message())

    def plan(state):
        return {"messages": [model.invoke(state["messages"])], "vals": ["p"]}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("tools", ToolNode([adder]))
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "tools")
    graph.add_edge("tools", END)
    graph.compile(name="tools_graph").invoke(
        empty_state(), config={"configurable": {"thread_id": "tools"}}
    )

    rows = read_events(tmp_path)
    use = only(rows, "tool_use")[0]
    result = only(rows, "tool_result")[0]
    assert use["tool_call_id"] == result["tool_call_id"]
    # The **LLM-issued** id, not our run id: this is what makes our events line
    # up with the provider's logs and with the assistant message's tool_calls.
    assert use["tool_call_id"] == "call_abc"
    assert use["tool_name"] == result["tool_name"] == "adder"
    assert isinstance(result["duration_ms"], int)
    assert result.get("error") is None


def test_a_failed_tool_is_reported_on_the_tool_span_only(tmp_path, instrumented):
    def act(state):
        try:
            exploder.invoke({"x": 1})
        except RuntimeError:
            return {"vals": ["caught"]}
        return {"vals": ["nope"]}

    build_simple([("act", act)], name="toolfail").invoke(
        empty_state(), config={"configurable": {"thread_id": "tf"}}
    )
    rows = read_events(tmp_path)
    result = only(rows, "tool_result")[0]
    assert "tool boom" in result["error"]
    # One error, on the span that owns it. No standalone `error` event, and the
    # run itself succeeded because the node handled the failure.
    assert not only(rows, "error")
    assert only(rows, "agent_end")[0]["outcome"] == "success"
    assert only(rows, "hook_completed")[0]["outcome"] == "success"


def test_retriever_output_is_summarized_never_the_document_text(tmp_path, instrumented):
    class Retriever(BaseRetriever):
        def _get_relevant_documents(self, query, *, run_manager=None):
            return [
                Document(page_content="SECRET" * 500, metadata={"source": "a.txt"}),
                Document(page_content="SECRET" * 500, metadata={"source": "b.txt"}),
            ]

    retriever = Retriever()
    build_simple(
        [("fetch", lambda s: {"vals": [len(retriever.invoke("q"))]})], name="rag"
    ).invoke(empty_state(), config={"configurable": {"thread_id": "rag"}})

    rows = read_events(tmp_path)
    use = only(rows, "tool_use")[0]
    result = only(rows, "tool_result")[0]
    assert use["tool_name"] == "retriever:Retriever"
    assert result["output"] == {"n": 2, "sources": ["a.txt", "b.txt"]}
    assert "SECRET" not in json.dumps(rows)


# ---------------------------------------------------------------------------
# Graph structure
# ---------------------------------------------------------------------------

def test_a_langgraph_node_is_a_hook_not_a_nested_agent(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "hooks"}}
    )
    rows = read_events(tmp_path)
    hooks = {r["hook_name"] for r in only(rows, "hook_triggered")}
    # `sub_step` is the subgraph's own node — also a hook, under the nested agent.
    assert hooks == {"plan", "tools", "child", "worker", "ask", "sub_step"}
    for row in only(rows, "hook_triggered"):
        assert row["trigger_event"] == "graph_node"
    # Nodes must never inflate agent_id: it is a LowCardinality column and the
    # primary facet, and `agent_sessions.agent_id = any(...)` would label the
    # session with whichever node happened to run first.
    assert "plan" not in {r["agent_id"] for r in rows}


def test_a_compiled_subgraph_becomes_a_nested_agent(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "sub"}}
    )
    rows = read_events(tmp_path)
    nested = [r for r in only(rows, "agent_start") if r.get("parent_id")]
    assert len(nested) == 1
    assert nested[0]["agent_id"] == "root_graph/child"
    assert nested[0]["parent_id"] == "root_graph"
    # The subgraph's own node runs under the nested agent, and the agent closes.
    inner = [r for r in rows if r["agent_id"] == "root_graph/child"]
    assert types_of(inner) == ["agent_start", "hook_triggered", "hook_completed", "agent_end"]
    assert inner[1]["hook_name"] == "sub_step"


def test_intermediate_runnables_and_edge_functions_emit_nothing(tmp_path, instrumented):
    rows = []

    def plan(state):
        return {"vals": ["p"]}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("done", lambda s: {"vals": ["d"]})
    graph.add_edge(START, "plan")
    graph.add_conditional_edges(
        "plan", _named_edge, {"done": "done", END: END}
    )
    graph.add_edge("done", END)
    graph.compile(name="edges").invoke(
        empty_state(), config={"configurable": {"thread_id": "edges"}}
    )
    rows = read_events(tmp_path)
    names = {r["hook_name"] for r in only(rows, "hook_triggered")}
    # `_named_edge` is a Runnable with its own run and it inherits the node's
    # `langgraph_node` metadata; only `run.name == metadata["langgraph_node"]`
    # keeps it out. Emitting it would bury the timeline in machinery.
    assert names == {"plan", "done"}


def _named_edge(state):
    return "done"


def test_a_node_visited_repeatedly_produces_one_hook_pair_per_visit(tmp_path, instrumented):
    app = build_looping(fake_model(*[AIMessage("t%d" % i) for i in range(5)]))
    app.invoke(empty_state(), config={"configurable": {"thread_id": "loop"}})
    rows = read_events(tmp_path)
    plans = [r for r in only(rows, "hook_triggered") if r["hook_name"] == "plan"]
    assert len(plans) == 3
    assert len({r["hook_id"] for r in plans}) == 3
    completed = [r for r in only(rows, "hook_completed") if r["hook_name"] == "plan"]
    assert {r["hook_id"] for r in plans} == {r["hook_id"] for r in completed}


def test_a_parallel_fan_out_produces_one_hook_pair_per_branch(tmp_path, instrumented):
    build_graph(checkpointer=InMemorySaver()).invoke(
        empty_state(), config={"configurable": {"thread_id": "fan"}}
    )
    rows = read_events(tmp_path)
    workers = [r for r in only(rows, "hook_triggered") if r["hook_name"] == "worker"]
    assert len(workers) == 2
    assert len({r["hook_id"] for r in workers}) == 2


def test_every_event_belongs_to_an_agent_whose_start_is_open(tmp_path, instrumented):
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "open"}}
    app.invoke(empty_state(), config=config)
    app.invoke(Command(resume="yes"), config=config)

    open_agents = set()
    for row in read_events(tmp_path):
        if row["type"] == "agent_start":
            open_agents.add(row["agent_id"])
            continue
        # The dashboard parents every leaf to the open agent with the same
        # agent_id and SYNTHESISES a never-ending root span when there is none.
        assert row["agent_id"] in open_agents, row
        if row["type"] == "agent_end":
            open_agents.discard(row["agent_id"])
    assert not open_agents


# ---------------------------------------------------------------------------
# Human in the loop
# ---------------------------------------------------------------------------

def test_interrupt_and_resume_emit_both_pairs_in_order(tmp_path, instrumented):
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "hitl"}}
    first = app.invoke(empty_state(), config=config)
    assert "__interrupt__" in first
    result = app.invoke(Command(resume="approved"), config=config)
    assert result["answer"] == "approved"

    rows = read_events(tmp_path)
    hitl = types_of(only(rows, "human_wait", "agent_pause", "agent_resume", "human_input"))
    # Neither pair alone is enough: only agent_pause<->agent_resume feeds
    # `pausedMs`, and only human_wait<->human_input carries the prompt, the
    # answer and `pendingHuman`.
    assert hitl == ["human_wait", "agent_pause", "agent_resume", "human_input"]

    wait = only(rows, "human_wait")[0]
    pause = only(rows, "agent_pause")[0]
    resume = only(rows, "agent_resume")[0]
    answer = only(rows, "human_input")[0]
    assert wait["input_id"] == pause["pause_id"] == resume["pause_id"] == answer["input_id"]
    assert wait["prompt"] == "approve?"
    assert wait["options"] == ["y", "n"]
    assert answer["response"] == "approved"
    assert isinstance(resume["duration_ms"], int)


def test_an_interrupt_is_control_flow_not_an_error(tmp_path, instrumented):
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "ctrl"}}
    app.invoke(empty_state(), config=config)
    app.invoke(Command(resume="yes"), config=config)

    rows = read_events(tmp_path)
    # LangGraph reports the GraphInterrupt through on_chain_error with no
    # special case, so without the GraphBubbleUp check every human approval
    # would paint a red error and a failed agent.
    assert not only(rows, "error")
    assert [r["outcome"] for r in only(rows, "agent_end")] == ["success", "success"]
    asks = [r for r in only(rows, "hook_completed") if r["hook_name"] == "ask"]
    assert [r["outcome"] for r in asks] == ["paused", "success"]
    assert asks[0].get("error") is None


def test_the_agent_stays_open_across_the_pause_so_one_run_is_one_span(
    tmp_path, instrumented
):
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "span"}}
    app.invoke(empty_state(), config=config)
    app.invoke(Command(resume="yes"), config=config)

    rows = read_events(tmp_path)
    roots = [r for r in only(rows, "agent_start") if not r.get("parent_id")]
    # One agent_start, one agent_end, across two `.invoke()` calls. Closing the
    # agent at the first invoke would force-close the open pause and zero out
    # the only interval that measures how long the human took.
    assert len(roots) == 1
    assert len([r for r in only(rows, "agent_end") if r["agent_id"] == "root_graph"]) == 1
    assert rows[-1]["type"] == "agent_end"
    assert {r["session_id"] for r in rows} == {"span"}


def test_interrupt_events_survive_without_the_graph_lifecycle_callbacks(
    tmp_path, monkeypatch
):
    """The exception path alone must produce the whole HITL round trip.

    `GraphCallbackHandler.on_interrupt` is new in langgraph 1.2 and, as shipped,
    is not delivered to a handler installed through `register_configure_hook` at
    all — so the fallback is not a legacy branch, it is the load-bearing one on
    any install where the wrap does not apply.
    """
    failproofai_sdk.instrument("langchain", graph_callbacks=False)
    try:
        app = build_graph(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "nolifecycle"}}
        app.invoke(empty_state(), config=config)
        app.invoke(Command(resume="yes"), config=config)
        rows = read_events(tmp_path)
    finally:
        failproofai_sdk.uninstrument("langchain")

    assert types_of(only(rows, "human_wait", "agent_pause", "agent_resume", "human_input")) == [
        "human_wait",
        "agent_pause",
        "agent_resume",
        "human_input",
    ]
    assert not only(rows, "error")


def test_the_two_interrupt_paths_do_not_double_emit(tmp_path, instrumented):
    """Both the lifecycle callback and the exception path fire; `Interrupt.id`
    dedups them. A regression here doubles every pause in the dashboard."""
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "dedup"}}
    app.invoke(empty_state(), config=config)
    rows = read_events(tmp_path)
    assert len(only(rows, "human_wait")) == 1
    assert len(only(rows, "agent_pause")) == 1


# ---------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------

def test_a_node_failure_fails_the_agent_and_is_counted_once(tmp_path, instrumented):
    def boom(state):
        raise ValueError("node exploded")

    app = build_simple([("boom", boom)], name="failing")
    with pytest.raises(ValueError):
        app.invoke(empty_state(), config={"configurable": {"thread_id": "fail"}})

    rows = read_events(tmp_path)
    hook = only(rows, "hook_completed")[0]
    assert hook["outcome"] == "failed"
    assert "node exploded" in hook["error"]
    # `"failed"`, never `"failure"` — the server only counts
    # error|failed|timeout|rejected as a failure.
    assert only(rows, "agent_end")[0]["outcome"] == "failed"
    # The hook already owns this failure. A standalone `error` event as well
    # would make `sessionSummary.errorCount` report two failures for one
    # exception, on every failed run.
    assert not only(rows, "error")


def test_a_failure_no_span_owns_produces_exactly_one_error_event(tmp_path, instrumented):
    from langgraph.errors import GraphRecursionError

    model = fake_model(*[AIMessage("t%d" % i) for i in range(50)])

    def plan(state):
        model.invoke(state["messages"])
        return {"n": state["n"] + 1, "vals": ["p"]}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_edge(START, "plan")
    graph.add_conditional_edges("plan", lambda s: "plan", {"plan": "plan"})
    app = graph.compile(name="runaway")
    with pytest.raises(GraphRecursionError):
        app.invoke(
            empty_state(),
            config={"configurable": {"thread_id": "recursion"}, "recursion_limit": 4},
        )

    rows = read_events(tmp_path)
    # The recursion limit is enforced by the Pregel loop, not by a node, so no
    # leaf reported it: this is exactly the case where a standalone `error`
    # event is the only way the failure reaches the Errors surface.
    assert len(only(rows, "error")) == 1
    assert only(rows, "error")[0]["error_type"] == "GraphRecursionError"
    assert only(rows, "agent_end")[0]["outcome"] == "failed"
    # Strictly before agent_end: the graph closes the agent span at agent_end,
    # so an error after it is attributed to nothing.
    assert types_of(rows)[-2:] == ["error", "agent_end"]


def test_a_translator_that_raises_on_every_call_cannot_break_the_graph(
    tmp_path, monkeypatch, instrumented, sink
):
    sink.allow = True  # the whole point is that the failures are logged, not raised

    def explode(*args, **kwargs):
        raise RuntimeError("translator is broken")

    for name in ("_on_start", "_on_end", "_stash", "_stash_error", "_stash_messages"):
        monkeypatch.setattr(adapter, name, explode)

    model = fake_model(tool_calling_message())

    def plan(state):
        return {"messages": [model.invoke(state["messages"])], "vals": ["p"]}

    def act(state):
        return {"vals": [adder.invoke({"a": 2, "b": 3})]}

    app = build_simple([("plan", plan), ("act", act)], name="broken")
    result = app.invoke(empty_state(), config={"configurable": {"thread_id": "broken"}})

    # The customer's run is untouched: right answer, no exception, no missing work.
    assert result["vals"] == ["p", 5]
    assert result["messages"][-1].content == "planned"
    assert sink.records


def test_the_translators_swallow_by_policy_not_by_accident(monkeypatch, sink):
    """`FAILPROOFAI_SDK_STRICT=1` is what makes the failure policy testable.

    Without it you can only ever prove "the customer's run still worked", never
    "we swallowed the right thing" — and an adapter that swallowed
    `BaseException` would pass the first check while silently breaking
    cancellation in every async application that installed it.
    """
    sink.allow = True  # `safe()` logs the swallow, which is the whole design
    assert getattr(adapter._on_start, "__failproofai_safe__", False)
    assert getattr(adapter._on_end, "__failproofai_safe__", False)

    def explode(_run):
        raise RuntimeError("boom")

    guarded = _core.safe(explode)
    guarded(object())  # swallowed by default

    monkeypatch.setenv("FAILPROOFAI_SDK_STRICT", "1")
    _core.set_strict(None)
    with pytest.raises(RuntimeError):
        guarded(object())

    def cancel(_run):
        raise KeyboardInterrupt

    _core.set_strict(False)
    # A BaseException is never swallowed, strict or not.
    with pytest.raises(KeyboardInterrupt):
        _core.safe(cancel)(object())


def test_strict_mode_actually_surfaces_through_a_real_graph(monkeypatch, sink, instrumented):
    """The check above proves `safe()` re-raises. It does NOT prove the caller
    ever sees it — and for a while, they didn't.

    LangChain's `handle_event` catches every handler exception and logs
    "Error in <handler>.<callback> callback" unless the handler sets
    `raise_error`. We hard-coded that False, so under `FAILPROOFAI_SDK_STRICT=1`
    `safe()` re-raised straight into LangChain's firewall and the fault was
    swallowed one layer further out: the escape hatch silently did nothing on
    the adapter people are most likely to be debugging. `raise_error` now
    follows strict mode.

    Note this asserts through a real `graph.invoke`, not against `safe()`. The
    isolated test above passed the entire time the feature was broken.
    """
    sink.allow = True

    graph = StateGraph(State)
    graph.add_node("bump", lambda state: {"vals": ["bumped"]})
    graph.add_edge(START, "bump")
    graph.add_edge("bump", END)
    compiled = graph.compile(name="strict_probe")

    def explode(self, *args, **kwargs):
        raise RuntimeError("translator exploded")

    monkeypatch.setattr(_core.RunTracker, "emit", explode)

    # Default: the customer's graph is untouched and still returns the answer.
    _core.set_strict(False)
    assert compiled.invoke({"vals": [], "messages": []})["vals"] == ["bumped"]

    # Strict: the fault reaches the caller instead of vanishing into a log line.
    monkeypatch.setenv("FAILPROOFAI_SDK_STRICT", "1")
    _core.set_strict(None)
    with pytest.raises(RuntimeError, match="translator exploded"):
        compiled.invoke({"vals": [], "messages": []})


def test_two_graphs_on_two_threads_never_mix_sessions(tmp_path, instrumented):
    """All adapter state is module-global — it has to be, because the configure
    hook builds a fresh handler per callback manager. So the isolation has to
    come from the run-id keys, and that is what this proves."""
    import threading

    app = build_simple([("n", lambda s: {"vals": ["x"]})], name="threaded")
    barrier = threading.Barrier(4)

    def worker(name):
        barrier.wait(timeout=10)
        for _ in range(3):
            app.invoke(empty_state(), config={"configurable": {"thread_id": name}})

    threads = [threading.Thread(target=worker, args=("t%d" % i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    rows = read_events(tmp_path)
    assert {r["session_id"] for r in rows} == {"t0", "t1", "t2", "t3"}
    per_session = {}
    for row in rows:
        per_session.setdefault(row["session_id"], []).append(row["type"])
    for session, kinds in per_session.items():
        assert kinds.count("agent_start") == 3, (session, kinds)
        assert kinds.count("agent_end") == 3, (session, kinds)
        assert kinds.count("hook_triggered") == 3, (session, kinds)


# ---------------------------------------------------------------------------
# Session resolution and interop
# ---------------------------------------------------------------------------

def test_session_id_prefers_the_documented_metadata_key_over_thread_id(
    tmp_path, instrumented
):
    build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(
        empty_state(),
        config={
            "configurable": {"thread_id": "the-thread"},
            "metadata": {adapter.SESSION_METADATA_KEY: "chosen"},
        },
    )
    assert {r["session_id"] for r in read_events(tmp_path)} == {"chosen"}


def test_session_id_falls_back_to_thread_id(tmp_path, instrumented):
    """Verified against langgraph 1.2.10, contra the widely-reported claim that
    `thread_id` is no longer visible to callbacks: langchain-core's
    `ensure_config` stopped promoting it, and langgraph's `_PROPAGATE_TO_METADATA`
    puts it back."""
    build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(
        empty_state(), config={"configurable": {"thread_id": "from-thread"}}
    )
    assert {r["session_id"] for r in read_events(tmp_path)} == {"from-thread"}


def test_session_id_falls_back_to_the_root_run_id(tmp_path, instrumented):
    build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(empty_state())
    sessions = {r["session_id"] for r in read_events(tmp_path)}
    assert len(sessions) == 1
    # A run id, not a synthesised one: a made-up session splits one run in two.
    assert _looks_like_a_uuid(next(iter(sessions)))


def test_an_ambient_agent_scope_and_the_adapter_produce_one_tree(tmp_path, instrumented):
    with failproofai_sdk.agent("planner", goal="do the thing"):
        build_simple([("n", lambda s: {"vals": ["x"]})], name="inner").invoke(
            empty_state(), config={"configurable": {"thread_id": "ignored"}}
        )
    rows = read_events(tmp_path)
    assert len({r["session_id"] for r in rows}) == 1
    starts = only(rows, "agent_start")
    assert [r["agent_id"] for r in starts] == ["planner", "inner"]
    # This is the whole interop story: a hand-written outer bracket and an
    # adapter must produce one tree, not two disconnected sessions.
    assert starts[1]["parent_id"] == "planner"


def test_an_explicit_session_id_option_wins(tmp_path):
    failproofai_sdk.instrument("langchain", session_id="forced")
    try:
        build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(
            empty_state(), config={"configurable": {"thread_id": "ignored"}}
        )
    finally:
        failproofai_sdk.uninstrument("langchain")
    assert {r["session_id"] for r in read_events(tmp_path)} == {"forced"}


# ---------------------------------------------------------------------------
# Install / uninstall
# ---------------------------------------------------------------------------

def test_uninstrument_stops_recording_and_is_idempotent(tmp_path):
    failproofai_sdk.instrument("langchain")
    app = build_simple([("n", lambda s: {"vals": ["x"]})], name="s")
    app.invoke(empty_state(), config={"configurable": {"thread_id": "on"}})
    before = len(read_events(tmp_path))
    assert before

    assert failproofai_sdk.uninstrument("langchain") == ("langchain",)
    assert failproofai_sdk.uninstrument("langchain") == ()
    assert adapter.ENV_VAR not in os.environ

    app.invoke(empty_state(), config={"configurable": {"thread_id": "off"}})
    assert len(read_events(tmp_path)) == before


def test_instrumenting_twice_does_not_double_record(tmp_path):
    failproofai_sdk.instrument("langchain")
    assert failproofai_sdk.instrument("langchain") == ()
    try:
        build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(
            empty_state(), config={"configurable": {"thread_id": "twice"}}
        )
    finally:
        failproofai_sdk.uninstrument("langchain")
    rows = read_events(tmp_path)
    assert len(only(rows, "agent_start")) == 1
    assert len(only(rows, "hook_triggered")) == 1


def test_autodetect_picks_up_langchain(tmp_path):
    installed = failproofai_sdk.instrument()
    try:
        assert "langchain" in installed
    finally:
        failproofai_sdk.uninstrument()


def test_open_leaves_are_closed_when_the_root_run_ends(tmp_path, instrumented):
    """`agent_end` force-closes open pauses but not tools, models or humans."""
    from failproofai_sdk.integrations.langchain import _RunInfo, _STATE

    def leaky(state):
        # Simulate a framework that never delivered the end callback: register a
        # tool run by hand and leave it open.
        with _STATE.lock:
            root = next(i for i in _STATE.runs.values() if i.kind == "root")
            orphan = _RunInfo(
                id="orphan", parent=root.id, name="ghost", run_type="tool", kind="tool"
            )
            orphan.root = root.id
            orphan.session = root.session
            orphan.tool_call_id = "orphan"
            _STATE.runs["orphan"] = orphan
            _STATE.tracker.link("orphan", root.id)
            _STATE.tracker.emit(
                "tool_use", "orphan", parent_key=root.id, tool_name="ghost", tool_call_id="orphan"
            )
        return {"vals": ["x"]}

    build_simple([("leaky", leaky)], name="leaky").invoke(
        empty_state(), config={"configurable": {"thread_id": "leak"}}
    )
    rows = read_events(tmp_path)
    ghosts = [r for r in only(rows, "tool_result") if r["tool_name"] == "ghost"]
    assert len(ghosts) == 1
    assert ghosts[0]["fw_incomplete"] is True
    assert rows[-1]["type"] == "agent_end"


# ---------------------------------------------------------------------------
# Async
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ainvoke_produces_the_same_shape(tmp_path, instrumented):
    model = fake_model(tool_calling_message())

    async def plan(state, config: RunnableConfig):
        return {
            "messages": [await model.ainvoke(state["messages"], config=config)],
            "vals": ["p"],
        }

    async def act(state, config: RunnableConfig):
        return {"vals": [await adder.ainvoke({"a": 1, "b": 2}, config=config)]}

    app = build_simple([("plan", plan), ("act", act)], name="async_pipeline")
    await app.ainvoke(empty_state(), config={"configurable": {"thread_id": "async"}})

    assert types_of(read_events(tmp_path)) == [
        "agent_start",
        "hook_triggered",
        "model_request",
        "model_response",
        "hook_completed",
        "hook_triggered",
        "tool_use",
        "tool_result",
        "hook_completed",
        "agent_end",
    ]


# ---------------------------------------------------------------------------
# Structural anti-drift — the highest-value tests in this file
# ---------------------------------------------------------------------------

def test_every_override_still_exists_on_its_framework_base():
    """Reflect over the handler and check it still overrides something real.

    This is the test that catches the failure mode nothing else can. If
    LangChain renames `on_tool_error` or drops `_start_trace`, our method stops
    being called, we emit nothing for that path, and every behavioural test in
    this file still passes — they assert on the events we *did* emit, and a
    silent gap looks exactly like a run that had no tool errors. The in-repo
    precedent is `cli/agenteye_cli/_click_compat.py`, where an `isinstance`
    check went quietly always-False while its own anti-drift test stayed green.
    """
    cls = adapter.FailproofAITracer
    overrides = {
        name: fn
        for name, fn in vars(cls).items()
        if inspect.isfunction(fn) and not name.startswith("__")
    }
    assert len(overrides) >= 10, "reflection found nothing — the test would be vacuous"

    for name, fn in sorted(overrides.items()):
        base = next((b for b in cls.__mro__[1:] if name in vars(b)), None)
        assert base is not None, (
            "%s overrides nothing on any base — it is dead code that the "
            "framework will never call" % name
        )
        base_fn = vars(base)[name]
        base_params = inspect.signature(base_fn).parameters
        for param_name, param in inspect.signature(fn).parameters.items():
            if param.kind in (param.VAR_KEYWORD, param.VAR_POSITIONAL):
                continue
            # Deliberately no "...or the base takes **kwargs" escape hatch: a
            # renamed parameter would still be swallowed by the base's **kwargs
            # and our own parameter would silently never be filled.
            assert param_name in base_params, (
                "%s.%s declares %r, which no longer appears in %s.%s%s"
                % (cls.__name__, name, param_name, base.__name__, name,
                   inspect.signature(base_fn))
            )


def test_the_graph_lifecycle_overrides_are_bound_to_the_real_langgraph_base():
    """`on_interrupt` lives on a stand-in when langgraph is too old.

    If the import silently fell back on a machine that *has* langgraph 1.2,
    langgraph's `isinstance(h, GraphCallbackHandler)` filter would never match
    us and HITL would go dark with nothing to show for it.
    """
    from langgraph.callbacks import GraphCallbackHandler

    assert adapter._GraphCallbackHandler is GraphCallbackHandler
    assert issubclass(adapter.FailproofAITracer, GraphCallbackHandler)
    for name in ("on_interrupt", "on_resume"):
        assert name in vars(GraphCallbackHandler)


def test_the_handler_flags_the_callback_manager_depends_on():
    cls = adapter.FailproofAITracer
    # AsyncCallbackManager dispatches sync handlers through run_in_executor
    # unless run_inline, and that hop can REORDER callbacks — which scrambles
    # timestamp order and breaks every pairing in this file.
    assert cls.run_inline is True

    # raise_error follows FAILPROOFAI_SDK_STRICT rather than being a constant, so it
    # has to be read off an INSTANCE -- which is also how LangChain reads it.
    # Normally False: LangChain already firewalls handler exceptions, and
    # raising would take the customer's graph down with our bug. Under strict
    # it must be True, or LangChain's firewall swallows the exception `safe()`
    # re-raises and the escape hatch does nothing at all here.
    handler = cls()
    _core.set_strict(False)
    assert handler.raise_error is False
    _core.set_strict(True)
    assert handler.raise_error is True
    _core.set_strict(None)

    from langchain_core.callbacks.base import BaseCallbackHandler

    assert hasattr(BaseCallbackHandler, "run_inline")
    assert hasattr(BaseCallbackHandler, "raise_error")


def test_the_configure_hook_api_is_still_the_one_we_build_on():
    from langchain_core.tracers import context

    assert callable(context.register_configure_hook)
    params = list(inspect.signature(context.register_configure_hook).parameters)
    assert params[:4] == ["context_var", "inheritable", "handle_class", "env_var"]
    # There is deliberately no deregister API — uninstall() has to work by
    # emptying the ContextVar and the env var instead. If one ever appears, this
    # assertion is the reminder to use it.
    assert not hasattr(context, "unregister_configure_hook")


def test_the_control_flow_exception_hierarchy_is_still_where_we_look():
    from langgraph.errors import GraphBubbleUp, GraphInterrupt, ParentCommand

    assert adapter._GraphBubbleUp is GraphBubbleUp
    assert issubclass(GraphInterrupt, GraphBubbleUp)
    assert issubclass(ParentCommand, GraphBubbleUp)
    # ...and the payload shape `_interrupts_of` reads.
    from langgraph.types import Interrupt

    interrupt_obj = Interrupt(value={"prompt": "p"}, id="abc")
    assert adapter._interrupts_of(GraphInterrupt([interrupt_obj])) == (interrupt_obj,)
    # A ParentCommand is control flow but carries a Command, not interrupts, so
    # it must not be mistaken for a human pause.
    assert adapter._is_control_flow(ParentCommand(Command(resume=1)))
    assert adapter._interrupts_of(ParentCommand(Command(resume=1))) == ()
    assert not adapter._is_control_flow(ValueError("real"))


def test_the_lifecycle_event_dataclasses_still_carry_the_fields_we_read():
    import dataclasses

    from langgraph.callbacks import GraphInterruptEvent, GraphResumeEvent

    interrupt_fields = {f.name for f in dataclasses.fields(GraphInterruptEvent)}
    assert {"run_id", "interrupts"} <= interrupt_fields
    assert "run_id" in {f.name for f in dataclasses.fields(GraphResumeEvent)}

    from langgraph.types import Interrupt

    assert {"value", "id"} <= {f.name for f in dataclasses.fields(Interrupt)}


def test_the_node_filter_still_matches_real_langgraph_metadata(tmp_path):
    """The node filter is a string comparison. Prove the strings still exist.

    `metadata["langgraph_node"] == run.name` is what separates a node from every
    inner Runnable that inherits the same metadata. If the key is renamed, every
    node stops being a hook and the only symptom is a shorter timeline.
    """
    from langchain_core.tracers.base import BaseTracer

    seen = []

    class Probe(BaseTracer):
        run_inline = True

        def _persist_run(self, run):
            pass

        def _start_trace(self, run):
            super()._start_trace(run)
            seen.append((run.name, dict(run.metadata or {}), run.run_type))

    graph = StateGraph(State)
    graph.add_node("only_node", lambda s: {"vals": ["x"]})
    graph.add_edge(START, "only_node")
    graph.add_edge("only_node", END)
    graph.compile(name="probe").invoke(
        empty_state(), config={"callbacks": [Probe()], "configurable": {"thread_id": "t"}}
    )

    root_name, root_meta, _ = seen[0]
    node_name, node_meta, _ = seen[1]
    assert root_meta.get("langgraph_node") is None
    assert node_meta["langgraph_node"] == node_name == "only_node"
    assert "langgraph_checkpoint_ns" in node_meta
    assert node_meta["thread_id"] == "t"
    # And a subgraph node's checkpoint namespace is still `|`-separated, which
    # is how nested agents are derived without recognising a Pregel object.
    seen.clear()
    outer = StateGraph(State)
    outer.add_node("child", subgraph())
    outer.add_edge(START, "child")
    outer.add_edge("child", END)
    outer.compile(name="outer").invoke(
        empty_state(), config={"callbacks": [Probe()], "configurable": {"thread_id": "t2"}}
    )
    inner = [m for name, m, _ in seen if m.get("langgraph_node") == name == "sub_step"]
    assert inner and "|" in inner[0]["langgraph_checkpoint_ns"]


def test_the_tool_call_id_still_reaches_the_run_object():
    """`tool_call_id` is read off `run.extra`, where `_create_tool_run` parks
    the callback kwargs. If that stops happening we would silently fall back to
    the run id and every tool would stop lining up with the provider's logs."""
    from langchain_core.tracers.base import BaseTracer

    seen = []

    class Probe(BaseTracer):
        run_inline = True

        def _persist_run(self, run):
            pass

        def _start_trace(self, run):
            super()._start_trace(run)
            if run.run_type == "tool":
                seen.append(dict(run.extra or {}))

    model = fake_model(tool_calling_message())

    def plan(state):
        return {"messages": [model.invoke(state["messages"])], "vals": ["p"]}

    graph = StateGraph(State)
    graph.add_node("plan", plan)
    graph.add_node("tools", ToolNode([adder]))
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "tools")
    graph.add_edge("tools", END)
    graph.compile(name="ids").invoke(
        empty_state(), config={"callbacks": [Probe()], "configurable": {"thread_id": "t"}}
    )
    assert seen and seen[0].get("tool_call_id") == "call_abc"


def test_usage_metadata_survives_to_on_llm_end():
    """The primary token source. The two fallbacks exist because providers
    disagree; this asserts the primary is still the primary."""
    from langchain_core.tracers.base import BaseTracer

    seen = []

    class Probe(BaseTracer):
        run_inline = True

        def _persist_run(self, run):
            pass

        def on_llm_end(self, response, *, run_id, **kwargs):
            seen.append(adapter._usage(response))
            return super().on_llm_end(response, run_id=run_id, **kwargs)

    model = fake_model(tool_calling_message())
    model.invoke([HumanMessage("hi")], config={"callbacks": [Probe()]})
    assert seen == [{"input_tokens": 11, "output_tokens": 5, "total_tokens": 16}]


# ---------------------------------------------------------------------------
# A root run that is itself a leaf
# ---------------------------------------------------------------------------
#
# `ChatOpenAI(...).invoke(...)` outside any graph arrives as ONE run with no
# parent and `run_type="chat_model"`. Handled only as a root it produced
# `agent_start`/`agent_end` and nothing else: no `model_request`, no
# `model_response`, so the model name, both token counts and the latency of a
# direct model call were dropped while the trace still looked populated.
#
# Direct `.invoke()` is not an edge case — a classifier, a summariser and a
# one-shot rewrite are all shaped exactly like this.


def test_a_bare_model_call_still_emits_its_model_pair(tmp_path, instrumented):
    with failproofai_sdk.session():
        fake_model(AIMessage("hi", usage_metadata={
            "input_tokens": 7, "output_tokens": 3, "total_tokens": 10,
        })).invoke("say hi")

    rows = read_events(tmp_path)
    kinds = types_of(rows)
    assert "model_request" in kinds, (
        f"a bare model call emitted {kinds} — the model pair is missing, so the "
        f"model name, token counts and latency of every direct .invoke() are lost"
    )
    assert "model_response" in kinds


def test_a_bare_model_call_records_tokens_and_an_int_duration(tmp_path, instrumented):
    with failproofai_sdk.session():
        fake_model(AIMessage("hi", usage_metadata={
            "input_tokens": 7, "output_tokens": 3, "total_tokens": 10,
        })).invoke("say hi")

    response = only(read_events(tmp_path), "model_response")[0]
    assert response["input_tokens"] == 7
    assert response["output_tokens"] == 3
    # u32 column: a float silently NULLs it server-side.
    assert isinstance(response["duration_ms"], int)
    assert response["model"]


def test_a_bare_model_calls_pair_sits_inside_its_agent_span(tmp_path, instrumented):
    """Order matters: the dashboard closes the agent span at `agent_end`, so a
    `model_response` after it is attributed to nothing."""
    with failproofai_sdk.session():
        fake_model(AIMessage("hi")).invoke("say hi")

    kinds = types_of(read_events(tmp_path))
    assert kinds.index("agent_start") < kinds.index("model_request")
    assert kinds.index("model_response") < kinds.index("agent_end")


def test_a_bare_model_pair_shares_one_request_id(tmp_path, instrumented):
    with failproofai_sdk.session():
        fake_model(AIMessage("hi")).invoke("say hi")

    rows = read_events(tmp_path)
    request = only(rows, "model_request")[0]
    response = only(rows, "model_response")[0]
    assert request["request_id"] == response["request_id"]


def test_a_graph_run_is_not_treated_as_a_leaf(tmp_path, instrumented):
    """The fix is additive and must not fire for a chain-typed root."""
    build_simple([("only", lambda state: {"vals": ["x"]})]).invoke(empty_state())
    rows = read_events(tmp_path)
    # A graph root emits no model pair of its own — only its nodes do.
    assert types_of(rows).count("agent_start") == 1


# ---------------------------------------------------------------------------
# Two roots that merely OVERLAP are not a resume
# ---------------------------------------------------------------------------
#
# `_start_root` reuses an existing session's agent when that agent is still
# open, because that is what an interrupt/resume looks like: the paused
# `.invoke()` deliberately did not close its agent and the resuming one must not
# open a second root span for the same logical run.
#
# "Still open" is ALSO true of two roots that merely overlap in time under one
# session id, and that is not exotic — langchain-core opens one root run **per
# input** for `.batch()`, and any two requests carrying the same conversation id
# through `SESSION_METADATA_KEY` do the same. Read as a resume, the second root
# got no `agent_start` at all, its work was relabelled with the first root's
# `agent_id`, the first root to finish closed the shared agent, and everything
# the other root emitted afterwards resolved to nothing and was DROPPED.
#
# The discriminator is `open_pauses`: `_end_root` skips `agent_end` exactly when
# it is non-empty, which is the only way an agent outlives its root, and
# `_suspend` is the only thing that fills it.


def test_two_overlapping_roots_in_one_session_are_two_agents(tmp_path, instrumented):
    import threading

    # The barrier is the whole point: both roots are guaranteed to be OPEN at
    # the same time, which is the state that used to be misread as a resume.
    # Without it this races and passes against the bug about half the time.
    barrier = threading.Barrier(2, timeout=10)

    def hold(state):
        barrier.wait()
        return {"vals": ["x"]}

    app = build_simple([("n", hold)], name="overlap")

    def run():
        app.invoke(
            empty_state(),
            config={"metadata": {adapter.SESSION_METADATA_KEY: "one-session"}},
        )

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    rows = read_events(tmp_path)
    assert {r["session_id"] for r in rows} == {"one-session"}
    starts = only(rows, "agent_start")
    ends = only(rows, "agent_end")
    assert len(starts) == 2, (
        f"two overlapping roots produced {len(starts)} agent_start(s): the second "
        f"root was read as a resume of the first"
    )
    assert len(ends) == 2
    # Distinct runs, not one run reported twice.
    assert len({r["fw_run_id"] for r in starts}) == 2
    # Nothing was dropped on the way: each root ran the node once.
    assert types_of(rows).count("hook_triggered") == 2
    assert types_of(rows).count("hook_completed") == 2
    # `sink` (autouse) fails this test on the "could not resolve a session for
    # run ... and is dropping its events" warning the old behaviour produced,
    # which is the other half of the regression and the half that was silent.


def test_a_genuine_interrupt_resume_is_still_one_agent_not_two(tmp_path, instrumented):
    """The counterweight: `open_pauses` must not disable the resume path.

    Deleting the resume branch would also "fix" the overlap bug above, at the
    cost of splitting every human approval into two root spans and zeroing the
    `agent_pause` -> `agent_resume` interval that is the only measure of how
    long the human took.
    """
    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "resume-one"}}
    app.invoke(empty_state(), config=config)
    app.invoke(Command(resume="yes"), config=config)

    rows = read_events(tmp_path)
    roots = [r for r in only(rows, "agent_start") if not r.get("parent_id")]
    assert len(roots) == 1, "the resuming .invoke() opened a second root span"
    assert len([r for r in only(rows, "agent_end") if r["agent_id"] == "root_graph"]) == 1
    assert types_of(only(rows, "agent_pause", "agent_resume")) == [
        "agent_pause",
        "agent_resume",
    ]


# ---------------------------------------------------------------------------
# A failing root-run-that-is-a-leaf owns its failure exactly once
# ---------------------------------------------------------------------------
#
# `_on_end` returns straight after `_end_root` for a root, so the line at the
# bottom of the function that marks the failure as owned by the span below never
# ran for a root that was ALSO a leaf. The same exception was then reported
# twice — once as `tool_result.error` / `model_response.error` and again as a
# standalone `error` event — and the server derives `is_error` from both, so one
# failure counted as two on `sessionSummary.errorCount`. The identical failure
# one Runnable deeper counted as one.


def test_a_failing_bare_tool_reports_its_error_once(tmp_path, instrumented):
    with failproofai_sdk.session():
        with pytest.raises(RuntimeError, match="tool boom"):
            exploder.invoke({"x": 1})

    rows = read_events(tmp_path)
    result = only(rows, "tool_result")[0]
    assert "tool boom" in result["error"]
    # The span that owns the failure has reported it; a standalone `error` event
    # on top is the same failure counted twice.
    assert not only(rows, "error"), (
        "a top-level tool failure was reported both on tool_result and as a "
        "standalone error event"
    )
    assert only(rows, "agent_end")[0]["outcome"] == "failed"


def test_a_failing_bare_model_call_reports_its_error_once(tmp_path, instrumented):
    class _BoomModel(GenericFakeChatModel):
        def _generate(self, *args, **kwargs):
            raise RuntimeError("model boom")

    with failproofai_sdk.session():
        with pytest.raises(RuntimeError, match="model boom"):
            _BoomModel(messages=iter([])).invoke("say hi")

    rows = read_events(tmp_path)
    response = only(rows, "model_response")[0]
    assert "model boom" in response["error"]
    assert response["stop_reason"] == "error"
    assert not only(rows, "error")
    assert only(rows, "agent_end")[0]["outcome"] == "failed"


def test_a_failure_below_the_root_still_produces_its_one_error_event(
    tmp_path, instrumented
):
    """The other side of the same line: a root nothing below reported must still
    get exactly one standalone `error`, or the failure reaches no surface."""

    def boom(_payload):
        raise RuntimeError("chain boom")

    with failproofai_sdk.session():
        with pytest.raises(RuntimeError, match="chain boom"):
            RunnableLambda(boom).with_config(run_name="boomer").invoke({"x": 1})

    rows = read_events(tmp_path)
    assert len(only(rows, "error")) == 1
    assert only(rows, "agent_end")[0]["outcome"] == "failed"


# ---------------------------------------------------------------------------
# `tool_result.output` is the tool's result, not a repr of the envelope
# ---------------------------------------------------------------------------
#
# A tool handed the LLM's `ToolCall` dict — what `bind_tools` produces and what
# every modern tool loop passes — returns a `ToolMessage`. `truncate` has no
# JSON shape for one, so the single most-read field in a tool loop rendered as
# `ToolMessage(content='3', name='adder', tool_call_id='call_zz', ...)`.
#
# `status` is the second half: a `ToolMessage` carries `status="error"` when the
# tool failed but the framework turned the exception into a message for the
# model instead of raising. `run.error` is empty on that path, so the failure
# had no representation at all — `is_error` 0, a green span, and the text of the
# failure sitting in an output field nobody filters on.


def test_a_tool_called_with_a_tool_call_records_its_content_not_a_repr(
    tmp_path, instrumented
):
    with failproofai_sdk.session():
        adder.invoke(
            {"name": "adder", "args": {"a": 1, "b": 2}, "id": "call_zz", "type": "tool_call"}
        )

    result = only(read_events(tmp_path), "tool_result")[0]
    assert result["output"] == "3", (
        f"tool_result.output is {result['output']!r} — the ToolMessage envelope "
        f"leaked instead of the tool's own result"
    )
    assert "ToolMessage(" not in str(result["output"])
    assert result["tool_call_id"] == "call_zz"


def test_a_tool_that_fails_without_raising_is_still_an_error(tmp_path, instrumented):
    @tool
    def quiet_failer(x: int) -> str:
        """Fails without raising: returns an error-status ToolMessage."""
        return ToolMessage(content="upstream 503", tool_call_id="unused", status="error")

    with failproofai_sdk.session():
        quiet_failer.invoke(
            {"name": "quiet_failer", "args": {"x": 1}, "id": "call_q", "type": "tool_call"}
        )

    result = only(read_events(tmp_path), "tool_result")[0]
    assert result.get("error"), (
        "a tool that reported failure through ToolMessage(status='error') was "
        "recorded as a success"
    )
    assert "upstream 503" in result["error"]


def test_a_successful_tool_message_carries_no_error(tmp_path, instrumented):
    """The `status` read must not turn every ToolMessage into a failure."""
    with failproofai_sdk.session():
        adder.invoke(
            {"name": "adder", "args": {"a": 1, "b": 2}, "id": "call_ok", "type": "tool_call"}
        )
    assert only(read_events(tmp_path), "tool_result")[0].get("error") is None


# ---------------------------------------------------------------------------
# The `error` event does not repeat its own type
# ---------------------------------------------------------------------------
#
# `error` is the one event that carries `error_type` as its OWN field, and the
# server builds the row's `summary` as "<error_type>: <message>". Feeding it
# `_error_text` — which prefixes the type because `tool_result.error` and
# `agent_end.summary` have nowhere else to say it — rendered every entry on the
# Errors surface as `ValueError: ValueError: denominator must be non-zero`.
# CrewAI, LlamaIndex and Pydantic AI all pass a bare `str(exc)` here.


def test_the_error_events_message_does_not_repeat_its_own_type(tmp_path, instrumented):
    def boom(_payload):
        raise RuntimeError("chain boom")

    with failproofai_sdk.session():
        with pytest.raises(RuntimeError, match="chain boom"):
            RunnableLambda(boom).with_config(run_name="boomer").invoke({"x": 1})

    rows = read_events(tmp_path)
    event = only(rows, "error")[0]
    assert event["error_type"] == "RuntimeError"
    assert event["message"] == "chain boom", (
        f"message is {event['message']!r} — the server renders summary as "
        f"'<error_type>: <message>', so a prefixed message says it twice"
    )
    # Scoped to the `error` event: `agent_end.summary` has no `error_type`
    # field beside it, so it keeps naming the exception type itself.
    assert only(rows, "agent_end")[0]["summary"] == "RuntimeError: chain boom"


# ---------------------------------------------------------------------------
# `uninstrument()` when the trace env var was exported by somebody else
# ---------------------------------------------------------------------------
#
# A configure hook cannot be deregistered, so removal is "make the hook produce
# nothing" — and neither of the two levers `uninstall()` had actually does that
# in every process. Clearing `_HANDLER_VAR` only reaches contexts derived from
# the caller's, and the env var is unset only when `install()` was the one that
# set it (it must not clobber somebody else's environment). Exported by a
# Dockerfile or a CI job, it left `_configure` constructing a live zero-arg
# tracer per callback manager, and a fully torn-down adapter went on recording
# every event forever.


def test_uninstrument_stops_recording_when_the_env_var_was_already_set(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(adapter.ENV_VAR, "1")
    failproofai_sdk.instrument("langchain")
    app = build_simple([("n", lambda s: {"vals": ["x"]})], name="s")
    app.invoke(empty_state(), config={"configurable": {"thread_id": "on"}})
    before = len(read_events(tmp_path))
    assert before

    assert failproofai_sdk.uninstrument("langchain") == ("langchain",)
    # Deliberately still set: `install()` did not set it, so `uninstall()` does
    # not get to remove it. That is exactly why it cannot be the kill switch.
    assert os.environ.get(adapter.ENV_VAR) == "1"

    app.invoke(empty_state(), config={"configurable": {"thread_id": "off"}})
    assert len(read_events(tmp_path)) == before, (
        "the adapter kept recording after uninstrument() because the trace env "
        "var was set before instrument() ran"
    )


def test_reinstrumenting_after_that_teardown_records_again(tmp_path, monkeypatch):
    """The kill switch must be a switch, not a one-way fuse."""
    monkeypatch.setenv(adapter.ENV_VAR, "1")
    failproofai_sdk.instrument("langchain")
    failproofai_sdk.uninstrument("langchain")
    failproofai_sdk.instrument("langchain")
    try:
        build_simple([("n", lambda s: {"vals": ["x"]})], name="s").invoke(
            empty_state(), config={"configurable": {"thread_id": "again"}}
        )
    finally:
        failproofai_sdk.uninstrument("langchain")
    assert types_of(read_events(tmp_path)).count("agent_start") == 1
