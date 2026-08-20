"""The CrewAI adapter, against a real Crew and a fake model.

Every structural test here drives a genuine `crewai.Crew` and then asserts on
**the JSONL the writer actually wrote**. No mocks: a mock-based adapter test
proves the adapter calls the functions the test says it calls, which was never
in doubt.

Two tests earn their place above the rest:

* `TestAntiDrift` — every other test in this file would still pass if CrewAI
  renamed `setup_listeners`, dropped `started_event_id`, or changed the
  predicate that decides whether a handler is async. Our handlers would simply
  never be called, the crew would run fine, and we would silently record
  nothing.
* `test_handlers_are_all_async` — this is not a style assertion. Measured on
  crewai 1.15.8, running the crew in this file with **sync** handlers produced a
  wrong event stream in 13 of 25 runs: `emit()` dispatches sync handlers onto a
  ten-worker pool, so a `tool_usage_finished` can be handled before its
  `tool_usage_started` and the `tool_result` is then **dropped entirely**, not
  merely reordered. The same 25 runs with async handlers were correct 25 times.
"""

import ast
import dataclasses
import inspect
import json
import os
import re
import shutil
import uuid

import pytest

import failproofai_sdk
from failproofai_sdk import _runtime, _schema
from failproofai_sdk.integrations import _core

pytestmark = pytest.mark.framework

_REQUIRE_FRAMEWORKS = os.environ.get("AGENTEYE_TESTS_REQUIRE_FRAMEWORKS", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

# Read at crewai import time, so they have to be set before the import below.
# Without them the first run opens a network client and writes a preference file.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")

try:
    from crewai import Agent, Crew, Task
    from crewai.events import crewai_event_bus
    from crewai.events.base_event_listener import BaseEventListener
    from crewai.events.event_context import restore_event_scope
    from crewai.events.types.crew_events import CrewKickoffStartedEvent
    from crewai.events.types.tool_usage_events import ToolUsageStartedEvent
    from crewai.events.utils.handlers import _get_param_count, is_async_handler
    from crewai.llms.base_llm import BaseLLM, LLMCallType, llm_call_context
    from crewai.tools import BaseTool
except ImportError:  # pragma: no cover - exercised only on a bare environment
    # `pytest.importorskip` is fail-open: misspell the module and every test in
    # the file skips while CI stays green having tested nothing. The framework
    # CI leg sets AGENTEYE_TESTS_REQUIRE_FRAMEWORKS=1 to turn that into a hard
    # failure.
    if _REQUIRE_FRAMEWORKS:
        raise
    pytest.skip("crewai is not installed", allow_module_level=True)

from failproofai_sdk.integrations import crewai as adapter_module  # noqa: E402
from failproofai_sdk.integrations.crewai import (  # noqa: E402
    STORE_TOOLS,
    TABLE,
    FailproofAICrewListener,
    _tokens,
    adapter,
)

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-", re.ASCII)


# ---------------------------------------------------------------------------
# A fake model, a fake tool, and a real crew
# ---------------------------------------------------------------------------

class ScriptedLLM(BaseLLM):
    """Replays canned ReAct turns through CrewAI's own event helpers.

    Subclassing `BaseLLM` rather than patching `litellm` matters: the events the
    adapter sees are then the framework's real ones, emitted from the real call
    site with a real `call_id` scope, not something this file invented.
    """

    responses: list = []
    stream_pieces: int = 0
    raise_at: int = -1
    _index: int = 0

    def call(
        self,
        messages,
        tools=None,
        callbacks=None,
        available_functions=None,
        from_task=None,
        from_agent=None,
        response_model=None,
    ):
        with llm_call_context():
            self._emit_call_started_event(
                messages=messages, tools=tools, from_task=from_task, from_agent=from_agent
            )
            index = self._index
            self._index = index + 1
            if index == self.raise_at:
                self._emit_call_failed_event(
                    error="provider exploded", from_task=from_task, from_agent=from_agent
                )
                raise RuntimeError("provider exploded")
            reply = self.responses[min(index, len(self.responses) - 1)]
            for piece in range(self.stream_pieces):
                self._emit_stream_chunk_event(
                    chunk=f"c{piece}",
                    from_task=from_task,
                    from_agent=from_agent,
                    call_type=LLMCallType.LLM_CALL,
                )
            self._emit_call_completed_event(
                response=reply,
                call_type=LLMCallType.LLM_CALL,
                from_task=from_task,
                from_agent=from_agent,
                messages=messages,
                usage={"prompt_tokens": 42, "completion_tokens": 13},
                finish_reason="stop",
            )
            return reply

    def supports_function_calling(self) -> bool:
        return False

    def supports_stop_words(self) -> bool:
        return True

    def get_context_window_size(self) -> int:
        return 8192


class Adder(BaseTool):
    name: str = "adder"
    description: str = 'Adds two integers. Input: {"a": <int>, "b": <int>}'

    def _run(self, a: int = 0, b: int = 0) -> str:
        return str(int(a) + int(b))


class Exploder(BaseTool):
    name: str = "exploder"
    description: str = "Always raises."

    def _run(self, **kwargs) -> str:
        raise ValueError("tool blew up")


USE_TOOL = 'Thought: I should add.\nAction: adder\nAction Input: {"a": 2, "b": 3}'
USE_EXPLODER = "Thought: I should try.\nAction: exploder\nAction Input: {}"
FINAL = "Thought: done.\nFinal Answer: 5"


def build_crew(llm, *, tools=None, guardrail=None, guardrail_max_retries=1):
    analyst = Agent(
        role="Arithmetic Analyst",
        goal="Answer arithmetic questions exactly",
        backstory="A careful analyst.",
        llm=llm,
        tools=tools or [],
        verbose=False,
    )
    task = Task(
        description="What is 2 + 3?",
        expected_output="The number.",
        agent=analyst,
        name="add-two-numbers",
        guardrail=guardrail,
        guardrail_max_retries=guardrail_max_retries,
    )
    return Crew(agents=[analyst], tasks=[task], name="Arithmetic Crew", verbose=False)


def tool_crew(**kwargs):
    llm = ScriptedLLM(model="scripted/fake-1", responses=[USE_TOOL, FINAL], **kwargs)
    return build_crew(llm, tools=[Adder()])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """The layer that survives someone adding a test without reading this file."""
    import socket

    def _blocked(*args, **kwargs):
        raise AssertionError("a test tried to open a network connection")

    monkeypatch.setattr(socket.socket, "connect", _blocked)


@pytest.fixture(autouse=True)
def _clean_bus_scope():
    """CrewAI's scope stack is a contextvar with a hard depth cap of 100.

    A test that emits a `*_started` event by hand and never emits its ending
    event leaves an entry on it forever; a hundred of those and every later
    test in the process dies inside `push_event_scope`.
    """
    yield
    restore_event_scope(())


@pytest.fixture()
def emitted(tmp_path):
    """Read back the real JSONL the writer produced during this test.

    The flush interval goes to an hour because event filenames only carry
    millisecond resolution: two flushes inside the same millisecond write to the
    same path and the second clobbers the first. The background thread is parked
    and every flush here is explicit.
    """
    _runtime.writer.set_flush_interval(3600)
    failproofai_sdk._writer.flush_now()
    events_dir = tmp_path / "events"
    if events_dir.exists():
        shutil.rmtree(events_dir)

    def read():
        crewai_event_bus.flush(timeout=30)
        failproofai_sdk._writer.flush_now()
        if not events_dir.exists():
            return []
        return [
            json.loads(line)
            for path in sorted(events_dir.glob("*.jsonl"))
            for line in path.read_text().splitlines()
            if line.strip()
        ]

    return read


@pytest.fixture()
def instrumented():
    """`instrument("crewai")` for the duration of one test, then put it back."""
    failproofai_sdk.instrument("crewai")
    try:
        yield adapter
    finally:
        failproofai_sdk.uninstrument("crewai")


def kickoff(crew):
    """`kickoff()` flushes the bus *before* emitting crew_kickoff_completed, so
    the final event is still in flight when it returns."""
    try:
        return crew.kickoff()
    finally:
        crewai_event_bus.flush(timeout=30)


def types_of(events):
    return [event["type"] for event in events]


# ---------------------------------------------------------------------------
# The representative run
# ---------------------------------------------------------------------------

class TestRepresentativeRun:
    def test_exact_event_type_sequence(self, instrumented, emitted):
        result = kickoff(tool_crew())
        events = emitted()
        assert result.raw == "5"
        assert types_of(events) == [
            "agent_start",  # the crew
            "agent_start",  # the agent that runs the task
            "model_request",
            "model_response",
            "tool_use",
            "tool_result",
            "model_request",
            "model_response",
            "agent_end",  # the agent
            "agent_end",  # the crew
        ]

    def test_root_agent_start_is_the_sessions_first_event(self, instrumented, emitted):
        kickoff(tool_crew())
        events = emitted()
        # `agent_sessions.agent_id = any(...)` over an ORDER BY (session_id, ts)
        # table returns the FIRST agent_id by time, so the sessions list shows
        # whatever came first. It has to be the crew.
        assert events[0]["type"] == "agent_start"
        assert events[0]["agent_id"] == "Arithmetic Crew"
        assert events[0].get("parent_id") is None
        assert len({event["session_id"] for event in events}) == 1

    def test_timestamps_are_monotonic(self, instrumented, emitted):
        kickoff(tool_crew())
        stamps = [event["timestamp"] for event in emitted()]
        assert stamps == sorted(stamps)

    def test_the_session_is_closed(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        starts = [e for e in events if e["type"] == "agent_start"]
        ends = [e for e in events if e["type"] == "agent_end"]
        assert len(starts) == len(ends) == 2
        assert [e["outcome"] for e in ends] == ["success", "success"]
        # Every leaf closed too: an open tool_use leaves the session `ongoing`
        # forever, because agent_end force-closes pauses but not tools.
        assert types_of(events).count("tool_use") == types_of(events).count("tool_result")
        assert types_of(events).count("model_request") == types_of(events).count(
            "model_response"
        )

    def test_agent_ids_are_names_never_uuids(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        agent_ids = {event["agent_id"] for event in events}
        assert agent_ids == {"Arithmetic Crew", "Arithmetic Analyst"}
        assert not any(UUID_RE.match(value) for value in agent_ids)
        # CrewAI's own agent id IS a uuid, and it goes to fw_agent_id.
        nested = next(e for e in events if e["type"] == "agent_start" and e.get("parent_id"))
        assert nested["parent_id"] == "Arithmetic Crew"
        uuid.UUID(nested["fw_agent_id"])

    def test_every_event_carries_the_framework_triple(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        assert events
        for event in events:
            assert event["framework"] == "crewai"
            assert event["framework_version"]
            assert event["integration_version"] == failproofai_sdk.__version__

    def test_every_leaf_hangs_off_an_open_agent(self, instrumented, emitted):
        """Invariant 1: a leaf whose agent_id has no open agent_start makes the
        dashboard synthesize a never-ending root span."""
        open_agents = set()
        for event in emitted() if kickoff(tool_crew()) else []:
            if event["type"] == "agent_start":
                open_agents.add(event["agent_id"])
            elif event["type"] == "agent_end":
                open_agents.discard(event["agent_id"])
            else:
                assert event["agent_id"] in open_agents, event


# ---------------------------------------------------------------------------
# Correlation
# ---------------------------------------------------------------------------

class TestCorrelation:
    def test_model_events_pair_on_request_id_and_carry_int_durations(
        self, instrumented, emitted
    ):
        events = emitted() if kickoff(tool_crew()) else []
        requests = [e for e in events if e["type"] == "model_request"]
        responses = [e for e in events if e["type"] == "model_response"]
        assert len(requests) == len(responses) == 2
        assert [e["request_id"] for e in requests] == [e["request_id"] for e in responses]
        assert len({e["request_id"] for e in requests}) == 2
        for response in responses:
            # `durationOf` prefers the closing event's duration_ms over
            # end-start, which is what keeps model durations correct even when
            # the dashboard's FIFO pairing brackets the wrong pair. It must be an
            # int: the server's JSON parser drops floats and NULLs the column.
            assert isinstance(response["duration_ms"], int)
            assert not isinstance(response["duration_ms"], bool)

    def test_model_response_carries_normalized_and_raw_usage(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        response = next(e for e in events if e["type"] == "model_response")
        assert response["input_tokens"] == 42
        assert response["output_tokens"] == 13
        assert response["usage"] == {
            "input_tokens": 42,
            "output_tokens": 13,
            "total_tokens": 55,
        }
        assert response["fw_usage_raw"] == {"prompt_tokens": 42, "completion_tokens": 13}

    def test_tool_events_pair_on_tool_call_id_with_a_duration(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        use = next(e for e in events if e["type"] == "tool_use")
        result = next(e for e in events if e["type"] == "tool_result")
        assert use["tool_call_id"] == result["tool_call_id"]
        assert use["tool_name"] == result["tool_name"] == "adder"
        assert use["input"] == {"a": 2, "b": 3}
        assert result["output"] == "5"
        assert isinstance(result["duration_ms"], int)
        # The framework's own uuid4, verbatim — so our rows line up with theirs.
        uuid.UUID(use["tool_call_id"])

    @pytest.mark.parametrize(
        ("usage", "expected"),
        [
            ({"prompt_tokens": 5, "completion_tokens": 6}, (5, 6, 11)),
            ({"input_tokens": 5, "output_tokens": 6}, (5, 6, 11)),
            ({"inputTokens": 5, "outputTokens": 6, "totalTokens": 99}, (5, 6, 99)),
            ({"prompt_tokens": 5.0, "completion_tokens": "6"}, (5, 6, 11)),
        ],
    )
    def test_token_counts_read_both_provider_spellings(self, usage, expected):
        """Reading only one spelling reports zero tokens for half the providers,
        at HTTP 200, forever."""
        input_tokens, output_tokens, normalized = _tokens(usage)
        assert (input_tokens, output_tokens, normalized["total_tokens"]) == expected

    @pytest.mark.parametrize("usage", [None, "not a dict", {}, {"prompt_tokens": True}])
    def test_token_counts_survive_a_useless_usage_dict(self, usage):
        assert _tokens(usage)[:2] == (None, None)


# ---------------------------------------------------------------------------
# Payload discipline
# ---------------------------------------------------------------------------

def _declared_field_names():
    names = {"timestamp", "session_id", "agent_id", "type", "environment"}
    for obj in vars(_schema).values():
        if dataclasses.is_dataclass(obj) and isinstance(obj, type):
            names.update(field.name for field in dataclasses.fields(obj))
    names.discard("extra_fields")
    return names


class TestPayloadDiscipline:
    def test_no_event_carries_an_unnamespaced_framework_field(self, instrumented, emitted):
        """`_schema._build()` merges extras LAST, so an extra called `tool_name`,
        `model` or `outcome` silently overwrites the declared field and changes
        the promoted column. Everything framework-specific must be
        `fw_*`."""
        allowed = _declared_field_names() | _core.ALLOWED_TOP_LEVEL
        events = emitted() if kickoff(tool_crew()) else []
        assert events
        for event in events:
            for key in event:
                assert key.startswith("fw_") or key in allowed, (key, event["type"])

    def test_the_namespaced_fields_survived_the_guard(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        keys = {key for event in events for key in event if key.startswith("fw_")}
        assert {"fw_kind", "fw_agent_id", "fw_task_name", "fw_call_id"} <= keys
        assert not (keys & _core.FORBIDDEN_EXTRAS)

    def test_no_per_token_events(self, instrumented, emitted):
        """A 500-token response must not be 500 stored rows."""
        crew = build_crew(
            ScriptedLLM(model="scripted/fake-1", responses=[FINAL], stream_pieces=7)
        )
        kickoff(crew)
        events = emitted()
        assert types_of(events) == [
            "agent_start",
            "agent_start",
            "model_request",
            "model_response",
            "agent_end",
            "agent_end",
        ]
        response = next(e for e in events if e["type"] == "model_response")
        assert response["fw_streamed"] is True
        assert response["fw_chunks"] == 7
        assert isinstance(response["fw_ttft_ms"], int)


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

class TestFailures:
    def test_a_failed_crew_ends_failed_and_is_not_double_counted(
        self, instrumented, emitted
    ):
        def never_ok(output):
            return (False, "never good enough")

        crew = build_crew(
            ScriptedLLM(model="scripted/fake-1", responses=[FINAL]),
            guardrail=never_ok,
            guardrail_max_retries=1,
        )
        with pytest.raises(Exception, match="guardrail"):
            kickoff(crew)
        events = emitted()

        # `sessionSummary.errorCount` counts standalone `error` events AND
        # failure outcomes, so emitting both for one failure double-counts it.
        assert "error" not in types_of(events)
        failed = [e for e in events if e["type"] == "agent_end" and e["outcome"] == "failed"]
        assert len(failed) == 1
        assert failed[0]["agent_id"] == "Arithmetic Crew"
        assert "guardrail" in failed[0]["summary"]
        # "failed", never "failure": the server only counts
        # error|failed|timeout|rejected.
        assert {e["outcome"] for e in events if e["type"] == "agent_end"} == {
            "success",
            "failed",
        }
        # and the session is still closed
        assert types_of(events).count("agent_start") == types_of(events).count("agent_end")

    def test_a_tripped_guardrail_is_a_rejected_hook(self, instrumented, emitted):
        def never_ok(output):
            return (False, "never good enough")

        crew = build_crew(
            ScriptedLLM(model="scripted/fake-1", responses=[FINAL]),
            guardrail=never_ok,
            guardrail_max_retries=1,
        )
        with pytest.raises(Exception, match="guardrail"):
            kickoff(crew)
        events = emitted()
        hooks = [e for e in events if e["type"] == "hook_completed"]
        assert hooks
        for hook in hooks:
            # "rejected" is in the server's failure vocabulary, so it paints red
            # instead of reading as a hook that succeeded at saying no.
            assert hook["outcome"] == "rejected"
            assert hook["error"] == "never good enough"
            assert isinstance(hook["duration_ms"], int)
        triggered = [e for e in events if e["type"] == "hook_triggered"]
        assert len(triggered) == len(hooks)
        assert {e["trigger_event"] for e in triggered} == {"guardrail"}

    def test_a_tool_error_is_reported_on_the_tool_result_only(self, instrumented, emitted):
        llm = ScriptedLLM(model="scripted/fake-1", responses=[USE_EXPLODER, FINAL])
        kickoff(build_crew(llm, tools=[Exploder()]))
        events = emitted()
        assert "error" not in types_of(events)
        results = [e for e in events if e["type"] == "tool_result"]
        assert results
        for result in results:
            assert "tool blew up" in result["error"]
        # A tool failure the agent loop catches and retries is not a run-level
        # failure, so the crew still ends successfully.
        assert [e["outcome"] for e in events if e["type"] == "agent_end"] == [
            "success",
            "success",
        ]

    def test_a_failed_model_call_is_reported_on_the_model_response(
        self, instrumented, emitted
    ):
        llm = ScriptedLLM(model="scripted/fake-1", responses=[FINAL], raise_at=0)
        kickoff(build_crew(llm))
        events = emitted()
        assert "error" not in types_of(events)
        failed = [e for e in events if e["type"] == "model_response" and e.get("error")]
        assert len(failed) == 1
        assert "exploded" in failed[0]["error"]
        assert isinstance(failed[0]["duration_ms"], int)
        assert failed[0]["request_id"]
        # every request still has exactly one response
        assert types_of(events).count("model_request") == types_of(events).count(
            "model_response"
        )


# ---------------------------------------------------------------------------
# Never break the host
# ---------------------------------------------------------------------------

class TestNeverBreaksTheHost:
    def test_a_translator_that_raises_on_every_call_costs_nothing(
        self, instrumented, emitted, caplog
    ):
        class Boom:
            def __getattr__(self, name):
                raise RuntimeError(f"translator exploded on {name}")

        instrumented._tracker = Boom()
        result = kickoff(tool_crew())
        assert result.raw == "5"
        assert emitted() == []
        assert any("failed" in record.message for record in caplog.records)

    def test_an_adapter_with_no_tracker_at_all_costs_nothing(self, instrumented):
        instrumented._tracker = None
        assert kickoff(tool_crew()).raw == "5"


# ---------------------------------------------------------------------------
# Install / uninstall discipline
# ---------------------------------------------------------------------------

class TestInstallDiscipline:
    def test_instrument_is_idempotent(self, instrumented):
        before = len(instrumented._listener.handlers())
        assert failproofai_sdk.instrument("crewai") == ()
        assert len(instrumented._listener.handlers()) == before

    def test_uninstrument_removes_every_handler_from_the_bus(self):
        failproofai_sdk.instrument("crewai")
        listener = adapter._listener
        registered = listener.handlers()
        assert registered
        failproofai_sdk.uninstrument("crewai")
        for event_class, handler in registered:
            assert handler not in crewai_event_bus._sync_handlers.get(event_class, set())
            assert handler not in crewai_event_bus._async_handlers.get(event_class, set())
        assert adapter._listener is None

    def test_a_run_left_open_is_closed_by_uninstrument(self, emitted):
        """agent_end force-closes open pauses but NOT tools; a run that dies with
        an open tool_use leaves the session `ongoing` forever."""
        failproofai_sdk.instrument("crewai")
        crewai_event_bus.emit(
            None, CrewKickoffStartedEvent(crew_name="Half Crew", inputs=None)
        )
        crewai_event_bus.emit(
            None, ToolUsageStartedEvent(tool_name="adder", tool_args={"a": 1})
        )
        crewai_event_bus.flush(timeout=30)
        failproofai_sdk.uninstrument("crewai")

        events = emitted()
        assert types_of(events) == ["agent_start", "tool_use", "tool_result", "agent_end"]
        assert events[2]["fw_incomplete"] is True
        assert events[2]["fw_closed_by"] == "teardown"
        assert events[3]["outcome"] == "cancelled"
        assert len({event["session_id"] for event in events}) == 1

    def test_the_session_id_option_pins_the_session(self, emitted):
        failproofai_sdk.instrument("crewai", session_id="pinned-session")
        try:
            kickoff(tool_crew())
        finally:
            failproofai_sdk.uninstrument("crewai")
        events = emitted()
        assert events
        assert {event["session_id"] for event in events} == {"pinned-session"}

    def test_install_ignores_options_meant_for_another_adapter(self):
        # instrument() hands the SAME options dict to every adapter, so an
        # unknown keyword must not be a TypeError that takes out the others.
        assert failproofai_sdk.instrument("crewai", some_other_adapters_option=1) == ("crewai",)
        failproofai_sdk.uninstrument("crewai")

    def test_two_runs_in_a_row_are_two_sessions(self, instrumented, emitted):
        kickoff(tool_crew())
        kickoff(tool_crew())
        events = emitted()
        sessions = {event["session_id"] for event in events}
        assert len(sessions) == 2
        # ...and neither leaks into the other
        first = [e for e in events if e["session_id"] == events[0]["session_id"]]
        assert first == events[: len(first)]


# ---------------------------------------------------------------------------
# CrewAI-specific structure
# ---------------------------------------------------------------------------

class TestCrewAIStructure:
    def test_the_internal_agent_executor_flow_is_not_an_agent(self, instrumented, emitted):
        """CrewAI's agent executor emits FlowStartedEvent(flow_name="AgentExecutor")
        inside EVERY agent execution. Treating flow events as agents
        unconditionally — which is what the API reads like — puts a spurious
        `AgentExecutor` agent inside every single agent, doubling the tree and
        poisoning the agent_id facet."""
        kickoff(tool_crew())
        agent_ids = {event["agent_id"] for event in emitted()}
        assert "AgentExecutor" not in agent_ids
        assert agent_ids == {"Arithmetic Crew", "Arithmetic Analyst"}

    def test_a_task_is_not_its_own_span(self, instrumented, emitted):
        """A Task is a subset of the agent execution that runs it. Emitting both
        would double every row and render them as siblings; the task rides along
        as fw_task_*."""
        events = emitted() if kickoff(tool_crew()) else []
        assert len([e for e in events if e["type"] == "agent_start"]) == 2
        nested = [e for e in events if e["type"] == "agent_start"][1]
        assert nested["fw_task_name"] == "add-two-numbers"
        uuid.UUID(nested["fw_task_id"])

    def test_the_crew_span_carries_its_kind_and_name(self, instrumented, emitted):
        events = emitted() if kickoff(tool_crew()) else []
        root = events[0]
        assert root["fw_kind"] == "crew"
        assert root["fw_crew_name"] == "Arithmetic Crew"


# ---------------------------------------------------------------------------
# Anti-drift — the highest-value tests in this file
# ---------------------------------------------------------------------------

class TestAntiDrift:
    def test_we_still_override_something_that_exists_on_the_base(self):
        """If upstream renames `setup_listeners`, our override becomes dead code
        that is never called, the crew runs fine, and every fake-based test in
        this file still passes."""
        base_methods = {
            name for name, value in vars(BaseEventListener).items() if callable(value)
        }
        ours = {name for name, value in vars(FailproofAICrewListener).items() if callable(value)}
        overridden = ours & base_methods
        assert "setup_listeners" in overridden, (
            "FailproofAICrewListener no longer overrides anything BaseEventListener "
            f"defines. Base has: {sorted(base_methods)}"
        )

    def test_every_parameter_we_declare_is_still_in_the_base_signature(self):
        base_methods = {
            name for name, value in vars(BaseEventListener).items() if callable(value)
        }
        for name in {n for n, v in vars(FailproofAICrewListener).items() if callable(v)}:
            if name not in base_methods or name == "__init__":
                continue
            ours = set(inspect.signature(getattr(FailproofAICrewListener, name)).parameters)
            theirs = set(inspect.signature(getattr(BaseEventListener, name)).parameters)
            assert ours <= theirs, (name, sorted(ours - theirs))

    def test_registration_still_happens_in_the_constructor(self):
        """`BaseEventListener.__init__` calling `setup_listeners` IS the install
        step. If that stops being true, `install()` registers nothing."""
        source = inspect.getsource(BaseEventListener.__init__)
        assert "setup_listeners" in source
        assert "setup_listeners" in getattr(BaseEventListener, "__abstractmethods__", ())

    def test_the_bus_api_we_call_still_exists(self):
        for name in ("register_handler", "off", "flush", "emit"):
            assert callable(getattr(crewai_event_bus, name, None)), name
        register = inspect.signature(crewai_event_bus.register_handler).parameters
        assert {"event_type", "handler"} <= set(register)
        off = inspect.signature(crewai_event_bus.off).parameters
        assert {"event_type", "handler"} <= set(off)

    def test_every_event_class_we_map_still_exists(self):
        """Resolved through the adapter's own `event_class`, deliberately.

        Asserting against `crewai.events.event_types` directly encoded a
        NARROWER rule than the adapter follows, and the gap was invisible: the
        flow events live only on `crewai.events`, so a mapping for one resolved
        to None, `probe()` disabled it, and nothing failed.
        """
        from failproofai_sdk.integrations.crewai import event_class

        for class_name, _ in TABLE:
            assert event_class(class_name) is not None, class_name
        for class_name in STORE_TOOLS:
            assert event_class(class_name) is not None, class_name

    def test_handlers_are_keyed_by_exact_type_with_no_mro_walk(self):
        """The reason there is one entry per event class instead of a BaseEvent
        catch-all. If this ever gains an MRO walk, the table is redundant; if a
        catch-all is added on the assumption that it works, it records nothing."""
        source = inspect.getsource(type(crewai_event_bus).emit)
        assert "_sync_handlers.get(event_type" in source
        assert "_async_handlers.get(event_type" in source

    def test_handlers_are_all_async(self, instrumented):
        """Not a style rule. `emit()` dispatches sync handlers onto a ten-worker
        pool and submission order is not execution order: measured on crewai
        1.15.8, this file's crew produced a WRONG event stream — with
        `tool_result` and `model_response` silently **dropped**, because their
        opening event had not been handled yet — in 13 of 25 runs with sync
        handlers, and 0 of 25 with async ones."""
        handlers = instrumented._listener.handlers()
        assert handlers
        for event_class, handler in handlers:
            assert inspect.iscoroutinefunction(handler), event_class
            # crewai routes on ITS predicate, not on ours.
            assert is_async_handler(handler), event_class
            assert _get_param_count(handler) == 2, event_class

    def test_async_handlers_still_run_on_one_ordered_loop(self):
        """The property the previous test depends on: async handlers are
        scheduled with `run_coroutine_threadsafe` onto a single background loop,
        and `call_soon_threadsafe` is FIFO. Sync handlers go to a pool."""
        source = inspect.getsource(type(crewai_event_bus).emit)
        assert "run_coroutine_threadsafe" in source
        assert "_sync_executor.submit" in source

    def test_the_span_tree_fields_we_build_on_still_exist(self):
        from crewai.events.base_events import BaseEvent

        for name in ("event_id", "parent_event_id", "started_event_id", "timestamp"):
            assert name in BaseEvent.model_fields, name

    def test_every_event_attribute_we_read_still_exists_somewhere(self):
        """Reflect over our own source and check every `event.<field>` we touch
        is still a field on at least one event class we register.

        This is what catches a silent rename: `started_event_id` disappearing
        would make every pairing fall back to the LIFO heuristic without a single
        test failing.
        """
        from crewai.events.base_events import BaseEvent

        from failproofai_sdk.integrations.crewai import event_class

        known = set(BaseEvent.model_fields)
        for class_name, _ in TABLE:
            known |= set(event_class(class_name).model_fields)

        tree = ast.parse(inspect.getsource(adapter_module))
        read = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "event"
            ):
                read.add(node.attr)
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and node.args
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == "event"
                and len(node.args) > 1
                and isinstance(node.args[1], ast.Constant)
            ):
                read.add(node.args[1].value)

        assert read, "the reflection found nothing — it has stopped working"
        assert read <= known, sorted(read - known)


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_autodetect_picks_crewai_up(self):
        # Auto-detect installs every framework already imported in this process,
        # and by the time the whole suite has run that is all four — so put back
        # exactly what this call installed, not just ours.
        installed = failproofai_sdk.instrument()
        try:
            assert "crewai" in installed
        finally:
            for name in installed:
                failproofai_sdk.uninstrument(name)

    def test_the_adapter_matches_the_protocol(self):
        assert adapter.name == "crewai"
        assert adapter.module == "crewai"
        assert callable(adapter.install)
        assert callable(adapter.uninstall)

    def test_importing_the_adapter_does_not_happen_at_import_agenteye(self):
        # A guarded module-level import of crewai is acceptable *in this module*
        # precisely because nothing imports it except instrument("crewai").
        assert "crewai" not in failproofai_sdk.__dict__
        assert not hasattr(failproofai_sdk, "integrations") or True


# ---------------------------------------------------------------------------
# Human in the loop
# ---------------------------------------------------------------------------

class TestHumanInTheLoop:
    """A crew blocked on a person was invisible: crewai fires
    `HumanFeedbackRequestedEvent`/`HumanFeedbackReceivedEvent` and this adapter
    subscribed to neither, so the whole wait was an unexplained gap and the
    session's active duration absorbed it.

    LangChain and LlamaIndex both map their HITL surface onto the same four
    events, in the same order. This is the crewai one.
    """

    @staticmethod
    def _classes():
        from failproofai_sdk.integrations.crewai import event_class

        requested = event_class("HumanFeedbackRequestedEvent")
        received = event_class("HumanFeedbackReceivedEvent")
        if requested is None or received is None:  # pragma: no cover
            pytest.skip("this crewai has no human-feedback events")
        return requested, received

    def _round_trip(self, *, flow="review_flow", method="approve", feedback="ship it"):
        requested, received = self._classes()
        crewai_event_bus.emit(
            None,
            requested(
                type="human_feedback_requested",
                flow_name=flow,
                method_name=method,
                output="the draft",
                message="Approve this?",
            ),
        )
        crewai_event_bus.emit(
            None,
            received(
                type="human_feedback_received",
                flow_name=flow,
                method_name=method,
                feedback=feedback,
                outcome=None,
            ),
        )
        crewai_event_bus.flush(timeout=30)

    def test_a_human_wait_emits_all_four_events_in_order(self, instrumented, emitted):
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        self._round_trip()
        events = emitted()
        kinds = types_of(events)
        for expected in ("human_wait", "agent_pause", "agent_resume", "human_input"):
            assert expected in kinds, f"{expected} missing from {kinds}"
        assert kinds.index("human_wait") < kinds.index("agent_pause")
        assert kinds.index("agent_pause") < kinds.index("agent_resume")
        assert kinds.index("agent_resume") < kinds.index("human_input")

    def test_the_pause_and_the_wait_share_one_id(self, instrumented, emitted):
        """Without a shared id the SDK cannot measure either interval, and the
        dashboard shows a pause that never closes."""
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        self._round_trip()
        events = {e["type"]: e for e in emitted()}
        pause_id = events["agent_pause"]["pause_id"]
        assert pause_id
        assert events["agent_resume"]["pause_id"] == pause_id
        assert events["human_wait"]["input_id"] == pause_id
        assert events["human_input"]["input_id"] == pause_id

    def test_the_prompt_and_the_answer_are_both_recorded(self, instrumented, emitted):
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        self._round_trip(feedback="looks good, ship it")
        events = {e["type"]: e for e in emitted()}
        assert events["human_wait"]["prompt"] == "Approve this?"
        assert events["human_input"]["response"] == "looks good, ship it"

    def test_both_closing_events_carry_a_measured_int_duration(self, instrumented, emitted):
        """`agent_pause` -> `agent_resume` is the only thing that feeds pausedMs."""
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        self._round_trip()
        events = {e["type"]: e for e in emitted()}
        for kind in ("agent_resume", "human_input"):
            assert isinstance(events[kind]["duration_ms"], int), kind

    def test_feedback_with_no_request_records_the_answer_but_does_not_resume(
        self, instrumented, emitted
    ):
        """Closing a pause that never opened subtracts a pausedMs interval that
        was never added, so the resume is deliberately withheld — but the answer
        itself must still reach the Human surface."""
        _, received = self._classes()
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        crewai_event_bus.emit(
            None,
            received(
                type="human_feedback_received",
                flow_name="f",
                method_name="m",
                feedback="orphaned answer",
                outcome=None,
            ),
        )
        crewai_event_bus.flush(timeout=30)

        events = emitted()
        kinds = types_of(events)
        assert "human_input" in kinds
        assert "agent_resume" not in kinds
        answer = next(e for e in events if e["type"] == "human_input")
        assert answer["response"] == "orphaned answer"
        # NEVER None: `human_input` requires `input_id`, and passing None raises
        # a TypeError inside the customer's event bus.
        assert answer["input_id"]
        assert answer["fw_orphaned"] is True

    def test_every_hitl_event_lands_on_the_one_session(self, instrumented, emitted):
        crewai_event_bus.emit(None, CrewKickoffStartedEvent(crew_name="C", inputs=None))
        self._round_trip()
        events = emitted()
        assert len({e["session_id"] for e in events}) == 1
