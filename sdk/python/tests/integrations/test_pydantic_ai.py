"""The Pydantic AI adapter, against the real framework and a fake model.

Everything here runs a genuine `pydantic_ai.Agent` — `TestModel` and
`FunctionModel` ship in the package for exactly this — and then asserts on the
**JSONL the writer actually wrote**, not on mock call args. A mock-based test
of an adapter proves that the adapter calls the functions the test says it
calls, which is the one thing that was never in doubt.

The single highest-value test in this file is `TestAntiDrift`. Every other test
here would still pass if Pydantic AI renamed `wrap_tool_execute` tomorrow: our
override would simply never be called, the framework would run fine, and we
would silently record nothing. Only reflection over the real base class catches
that.
"""

import asyncio
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
from failproofai_sdk.integrations import _compat, _core

pytestmark = pytest.mark.framework

_REQUIRE_FRAMEWORKS = os.environ.get("AGENTEYE_TESTS_REQUIRE_FRAMEWORKS", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

try:
    from pydantic_ai import Agent, RunContext
    from pydantic_ai.capabilities import AbstractCapability
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from pydantic_ai.models import ModelRequestContext
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.models.test import TestModel
    from pydantic_ai.usage import RequestUsage, RunUsage
except ImportError:  # pragma: no cover - exercised only on a bare environment
    # `pytest.importorskip` is fail-open: misspell the module and every test in
    # the file skips while CI stays green having tested nothing. The framework
    # CI leg sets AGENTEYE_TESTS_REQUIRE_FRAMEWORKS=1 to turn that into a hard
    # failure.
    if _REQUIRE_FRAMEWORKS:
        raise
    pytest.skip("pydantic-ai is not installed", allow_module_level=True)

from failproofai_sdk.integrations import pydantic_ai as adapter  # noqa: E402
from failproofai_sdk.integrations.pydantic_ai import FailproofAI  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------

@pytest.fixture()
def emitted(tmp_path):
    """Read back the real JSONL the writer produced during this test.

    The flush interval goes to an hour because event filenames only have
    millisecond resolution: two flushes inside the same millisecond write to the
    same path and the second clobbers the first. So the background thread is
    parked and every flush in this file is explicit.
    """
    _runtime.writer.set_flush_interval(3600)
    # Drain anything a previous test left queued, then start from an empty
    # directory: the autouse fixture has already pointed base_dir at tmp_path.
    failproofai_sdk._writer.flush_now()
    events_dir = tmp_path / "events"
    if events_dir.exists():
        shutil.rmtree(events_dir)

    def read():
        failproofai_sdk._writer.flush_now()
        rows = []
        for path in sorted(events_dir.glob("*.jsonl")):
            rows.extend(
                json.loads(line)
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
        return rows

    return read


@pytest.fixture()
def instrumented():
    _core.set_strict(False)
    _compat.set_strict_integrations(False)
    _core.reset_failures()
    assert failproofai_sdk.instrument("pydantic_ai") == ("pydantic_ai",)
    try:
        yield
    finally:
        failproofai_sdk.uninstrument("pydantic_ai")
        _core.set_strict(None)
        _compat.set_strict_integrations(None)


def types_of(rows):
    return [row["type"] for row in rows]


def of_type(rows, kind):
    return [row for row in rows if row["type"] == kind]


def one_shot_tool_model(tool_name, args, *, tool_call_id="call-1", text="done"):
    """A model that calls one tool, then answers. Deterministic, no network."""
    state = {"n": 0}

    def respond(messages, info):
        state["n"] += 1
        if state["n"] == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id=tool_call_id)])
        return ModelResponse(parts=[TextPart(text)])

    return FunctionModel(respond)


def weather_agent_with_tool(**kwargs):
    agent = Agent(
        one_shot_tool_model("get_weather", {"city": "london"}),
        name="weather_agent",
        **kwargs,
    )

    @agent.tool_plain
    def get_weather(city: str) -> str:
        return f"sunny in {city}"

    return agent


# ---------------------------------------------------------------------------
# The shape of a representative run
# ---------------------------------------------------------------------------

def test_the_event_type_sequence_for_a_tool_using_run(instrumented, emitted):
    result = weather_agent_with_tool().run_sync("weather in london?")

    assert result.output == "done"
    assert types_of(emitted()) == [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
        "model_request",
        "model_response",
        "agent_end",
    ]


def test_the_root_agent_start_is_the_sessions_first_event(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    # `agent_sessions.agent_id = any(...)` over an ORDER BY (session_id, ts)
    # table returns the FIRST-by-time agent_id, so anything emitted ahead of the
    # root agent_start becomes the name of the whole session in the list view.
    assert rows[0]["type"] == "agent_start"
    assert rows[0]["agent_id"] == "weather_agent"
    assert len({row["session_id"] for row in rows}) == 1


def test_an_async_run_produces_the_same_sequence(instrumented, emitted):
    agent = weather_agent_with_tool()

    async def main():
        return await agent.run("go")

    result = asyncio.run(main())

    assert result.output == "done"
    assert types_of(emitted()) == [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
        "model_request",
        "model_response",
        "agent_end",
    ]


# ---------------------------------------------------------------------------
# Correlation and duration
# ---------------------------------------------------------------------------

def test_model_events_pair_on_request_id_and_carry_an_int_duration(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    requests = of_type(rows, "model_request")
    responses = of_type(rows, "model_response")
    assert len(requests) == len(responses) == 2

    request_ids = [row["request_id"] for row in requests]
    assert request_ids == [row["request_id"] for row in responses]
    assert len(set(request_ids)) == 2, "request_id must be unique per model call"

    for response in responses:
        # `durationOf` prefers the closing event's duration_ms over end-start,
        # which is what keeps model durations honest even when the dashboard's
        # FIFO pairing brackets the wrong pair. A float silently NULLs the
        # promoted u32 column, so the type is the assertion.
        assert type(response["duration_ms"]) is int


def test_tool_events_pair_on_tool_call_id_and_carry_a_duration(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    (use,) = of_type(rows, "tool_use")
    (result,) = of_type(rows, "tool_result")
    assert use["tool_call_id"] == result["tool_call_id"] == "call-1"
    assert use["tool_name"] == result["tool_name"] == "get_weather"
    # Auto-computed by the SDK from the shared tool_call_id: if the adapter ever
    # passed two different ids the pairing would break and this would be absent.
    assert type(result["duration_ms"]) is int
    assert result["output"] == "sunny in london"


def test_the_tool_input_is_captured(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    (use,) = of_type(emitted(), "tool_use")
    assert use["input"] == {"city": "london"}


def test_capture_content_off_drops_payloads_but_keeps_the_structure(emitted):
    _core.set_strict(False)
    failproofai_sdk.instrument("pydantic_ai", capture_content=False)
    try:
        weather_agent_with_tool().run_sync("go")
    finally:
        failproofai_sdk.uninstrument("pydantic_ai")
        _core.set_strict(None)
    rows = emitted()

    assert types_of(rows) == [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
        "model_request",
        "model_response",
        "agent_end",
    ]
    assert "goal" not in rows[0]
    assert "input" not in of_type(rows, "tool_use")[0]
    assert "output" not in of_type(rows, "tool_result")[0]
    assert "content" not in of_type(rows, "model_response")[0]


def test_usage_is_reported_both_as_ints_and_as_a_normalized_dict(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    response = of_type(rows, "model_response")[0]
    assert isinstance(response["input_tokens"], int)
    assert isinstance(response["output_tokens"], int)
    # Both event_summary.rs and sessionSummary.ts fall back to `usage` when the
    # promoted ints are missing, so it ships too.
    assert response["usage"]["input_tokens"] == response["input_tokens"]

    (end,) = of_type(rows, "agent_end")
    assert end["usage"]["requests"] == 2
    assert end["usage"]["tool_calls"] == 1


# ---------------------------------------------------------------------------
# Identity, labelling, payload hygiene
# ---------------------------------------------------------------------------

def test_agent_ids_are_readable_names_and_never_uuids(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    ids = {row["agent_id"] for row in rows}
    assert ids == {"weather_agent"}
    for value in ids:
        with pytest.raises(ValueError):
            # agent_id is a LowCardinality(String) and the primary facet on every
            # dashboard surface; a UUID in it poisons that facet permanently.
            uuid.UUID(value)


def test_an_unnamed_agent_is_labelled_from_its_variable_not_its_run_id(instrumented, emitted):
    forecast_agent = Agent(TestModel(call_tools=[]))
    forecast_agent.run_sync("go")

    assert {row["agent_id"] for row in emitted()} == {"forecast_agent"}


def test_every_event_carries_the_framework_triple(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    assert rows, "no events were emitted at all"
    for row in rows:
        assert row["framework"] == "pydantic_ai", row["type"]
        assert row["framework_version"], row["type"]
        assert row["integration_version"], row["type"]


TYPE_OF_DATACLASS = {
    re.sub(r"(?<!^)(?=[A-Z])", "_", name[: -len("Event")]).lower(): obj
    for name, obj in vars(_schema).items()
    if isinstance(obj, type) and name.endswith("Event")
}


def test_the_type_table_covers_the_whole_schema():
    # Guards the test below: a bad CamelCase split would make it vacuous.
    assert len(TYPE_OF_DATACLASS) == 15
    assert {"tool_use", "model_response", "agent_end", "hook_triggered", "error"} <= set(
        TYPE_OF_DATACLASS
    )


def test_no_event_carries_a_field_that_shadows_a_declared_one(instrumented, emitted):
    """`_schema._build()` ends with `result.update(extra)`.

    So an extra field named `tool_name`, `model`, `outcome` or `input_tokens`
    silently overwrites the declared one — changing the promoted the events store
    column and the server's computed summary — while every other test still
    passes. Every key we emit must therefore be a declared field of that event's
    own dataclass, a deliberate top-level name, or `fw_*`.
    """
    weather_agent_with_tool().run_sync("go")
    rows = emitted()
    assert rows

    reserved = {"timestamp", "session_id", "agent_id", "type", "environment"}
    for row in rows:
        declared = {
            field.name for field in dataclasses.fields(TYPE_OF_DATACLASS[row["type"]])
        }
        for key in row:
            assert (
                key in declared
                or key in reserved
                or key in _core.ALLOWED_TOP_LEVEL
                or key.startswith("fw_")
            ), f"{row['type']}.{key} is neither declared, allow-listed, nor fw_-namespaced"


def test_framework_detail_rides_in_the_fw_namespace(instrumented, emitted):
    weather_agent_with_tool().run_sync("go")
    rows = emitted()

    start = rows[0]
    assert start["fw_conversation_id"]
    uuid.UUID(start["fw_run_id"])  # the real run id is kept, just not as agent_id
    assert of_type(rows, "model_request")[0]["fw_run_step"] == 1


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

def test_a_failing_tool_is_reported_on_its_own_span_and_the_run_once(instrumented, emitted):
    agent = Agent(one_shot_tool_model("explode", {"x": "1"}), name="boom_agent", retries=0)

    @agent.tool_plain
    def explode(x: str) -> str:
        raise RuntimeError("kaboom")

    with pytest.raises(RuntimeError):
        agent.run_sync("go")
    rows = emitted()

    assert types_of(rows) == [
        "agent_start",
        "model_request",
        "model_response",
        "tool_use",
        "tool_result",
        "error",
        "agent_end",
    ]
    (result,) = of_type(rows, "tool_result")
    assert result["error"] == "RuntimeError: kaboom"

    # Exactly one standalone `error` event: the failure escaped the run, so no
    # leaf span owns it. Two would double-count in sessionSummary.errorCount.
    errors = of_type(rows, "error")
    assert len(errors) == 1
    assert errors[0]["error_type"] == "RuntimeError"
    assert errors[0]["message"] == "kaboom"
    # The traceback is trimmed from the FRONT, so the exception line — the only
    # one anybody reads — survives a stack deeper than the 8KB field limit.
    assert errors[0]["traceback"].rstrip().endswith("RuntimeError: kaboom")

    # "failed", never "failure" — the server counts only
    # error|failed|timeout|rejected as a failure.
    (end,) = of_type(rows, "agent_end")
    assert end["outcome"] == "failed"
    # ...and strictly after the error event: the dashboard closes the agent span
    # at agent_end and anything after it is attributed to nothing.
    assert types_of(rows).index("error") < types_of(rows).index("agent_end")


def test_a_failing_model_request_closes_its_own_span_with_the_error(instrumented, emitted):
    def explode(messages, info):
        raise RuntimeError("provider is down")

    agent = Agent(FunctionModel(explode), name="model_down_agent")
    with pytest.raises(RuntimeError):
        agent.run_sync("go")
    rows = emitted()

    assert types_of(rows) == [
        "agent_start",
        "model_request",
        "model_response",
        "error",
        "agent_end",
    ]
    (response,) = of_type(rows, "model_response")
    # Invariant: a model_request always gets a model_response, even when the call
    # blew up — otherwise the leaf never closes and the session reads `ongoing`
    # forever.
    assert response["error"] == "RuntimeError: provider is down"
    assert response["request_id"] == of_type(rows, "model_request")[0]["request_id"]
    assert type(response["duration_ms"]) is int
    assert len(of_type(rows, "error")) == 1


def test_a_tool_retry_does_not_fail_the_run(instrumented, emitted):
    from pydantic_ai import ModelRetry

    calls = {"model": 0, "tool": 0}

    def respond(messages, info):
        calls["model"] += 1
        if calls["model"] <= 2:
            return ModelResponse(
                parts=[ToolCallPart("flaky", {"x": "1"}, tool_call_id=f"call-{calls['model']}")]
            )
        return ModelResponse(parts=[TextPart("recovered")])

    agent = Agent(FunctionModel(respond), name="retry_agent")

    @agent.tool_plain
    def flaky(x: str) -> str:
        calls["tool"] += 1
        if calls["tool"] == 1:
            raise ModelRetry("try again")
        return "ok"

    assert agent.run_sync("go").output == "recovered"
    rows = emitted()

    # The retry is visible on the tool span that owned it...
    results = of_type(rows, "tool_result")
    assert results[0]["error"].startswith("ToolRetryError")
    assert "error" not in results[1], "the recovered attempt was marked failed"
    # ...and nowhere else: the run recovered, so it is not a run-level error.
    assert of_type(rows, "error") == []
    assert of_type(rows, "agent_end")[0]["outcome"] == "success"


def test_a_cancelled_run_is_not_an_error(instrumented, emitted):
    async def main():
        started = asyncio.Event()
        agent = Agent(
            FunctionModel(
                lambda messages, info: ModelResponse(
                    parts=[ToolCallPart("hang", {}, tool_call_id="call-hang")]
                )
            ),
            name="cancelled_agent",
        )

        @agent.tool_plain
        async def hang() -> str:  # pragma: no cover - cancelled before it returns
            started.set()
            await asyncio.sleep(30)
            return "never"

        task = asyncio.create_task(agent.run("go"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    rows = emitted()

    # A cancellation is not a failure: it must not pollute the Errors surface.
    assert of_type(rows, "error") == []
    assert of_type(rows, "agent_end")[0]["outcome"] == "cancelled"
    # Every open leaf still closes — a run that dies with an open tool_use leaves
    # the session `ongoing` forever. The tool runs in its own task and its own
    # hook returns *after* `wrap_run` does, so the run closes it on the way out;
    # see `test_a_cancelled_leaf_closes_before_the_agent_it_belongs_to`.
    assert len(of_type(rows, "tool_use")) == len(of_type(rows, "tool_result")) == 1
    assert of_type(rows, "tool_result")[0].get("error") is None


# ---------------------------------------------------------------------------
# A leaf that outlives its own run
#
# Shape A promises the start and the end of a span sit in one frame, and for the
# run itself that holds. It does not hold *between* frames: the graph awaits a
# `gather` of tool tasks, so a cancellation unwinds the run body the moment that
# future is cancelled while each tool task's own `CancelledError` is delivered a
# loop iteration later. Measured against pydantic-ai 2.32 before the fix, a
# `wait_for` timeout put `tool_result` 1ms *after* `agent_end`, and a timeout
# inside the provider call did the same to `model_response` — which is the one
# thing every other emit in the adapter is careful never to do, because the
# dashboard closes the agent span at `agent_end`.
# ---------------------------------------------------------------------------

def test_a_cancelled_leaf_closes_before_the_agent_it_belongs_to(instrumented, emitted):
    async def main():
        started = asyncio.Event()
        agent = Agent(
            FunctionModel(
                lambda messages, info: ModelResponse(
                    parts=[ToolCallPart("hang", {}, tool_call_id="call-hang")]
                )
            ),
            name="late_leaf_agent",
        )

        @agent.tool_plain
        async def hang() -> str:  # pragma: no cover - cancelled before it returns
            started.set()
            await asyncio.sleep(30)
            return "never"

        task = asyncio.create_task(agent.run("go"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # Give the tool task's own unwind a chance to run: the whole point is
        # that it lands after the run, and a duplicate would appear here.
        await asyncio.sleep(0.05)

    asyncio.run(main())
    rows = emitted()
    kinds = types_of(rows)

    assert kinds.index("tool_result") < kinds.index("agent_end")
    # Exactly one, not two: the tool's own hook still runs afterwards and must
    # not emit a second close for a span that is already closed.
    assert kinds.count("tool_result") == 1
    (result,) = of_type(rows, "tool_result")
    assert result["tool_call_id"] == of_type(rows, "tool_use")[0]["tool_call_id"]
    # Marked, so a leaf that never reported its own outcome is distinguishable
    # from one that completed.
    assert result["fw_incomplete"] is True
    # A cancellation is still not a failure.
    assert result.get("error") is None
    assert of_type(rows, "agent_end")[0]["outcome"] == "cancelled"


def test_a_cancelled_model_request_closes_before_the_agent_it_belongs_to(instrumented, emitted):
    async def main():
        started = asyncio.Event()

        async def never(messages, info):  # pragma: no cover - cancelled mid-call
            started.set()
            await asyncio.sleep(30)
            return ModelResponse(parts=[TextPart("never")])

        agent = Agent(FunctionModel(never), name="late_model_agent")
        task = asyncio.create_task(agent.run("go"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)

    asyncio.run(main())
    rows = emitted()
    kinds = types_of(rows)

    assert kinds.index("model_response") < kinds.index("agent_end")
    assert kinds.count("model_response") == 1
    (response,) = of_type(rows, "model_response")
    assert response["request_id"] == of_type(rows, "model_request")[0]["request_id"]
    assert response["fw_incomplete"] is True
    # `duration_ms` is still an int on the synthesized close: the server's JSON
    # parser drops floats, so a float silently NULLs the column.
    assert type(response["duration_ms"]) is int
    assert response.get("error") is None


def test_a_streamed_model_response_says_it_was_streamed(instrumented, emitted):
    """`duration_ms` on a streamed response is the whole `async with` block.

    Pydantic AI hands the completed `ModelResponse` back only once the caller
    leaves `agent.run_stream(...)`, so the consumer's own time is inside the
    number — measured against a live gateway, 1.5s of `asyncio.sleep` in the
    consumer moved a 3294ms response to 4677ms. No hook closes the span any
    earlier, so the flag rides on the response as well as the request: a latency
    percentile can exclude these rows instead of averaging UI time into a p95.
    """

    # TestModel, not FunctionModel: only the former can serve a streamed request
    # without a hand-written `stream_function`.
    agent = Agent(TestModel(), name="streamed_agent")

    async def main():
        async with agent.run_stream("go") as result:
            async for _ in result.stream_text(delta=True):
                pass
            await result.get_output()

    asyncio.run(main())
    rows = emitted()

    responses = of_type(rows, "model_response")
    assert responses, types_of(rows)
    assert [r.get("fw_streaming") for r in responses] == [True] * len(responses)
    assert all(type(r["duration_ms"]) is int for r in responses)

    # ...and a non-streamed run still says so, or the flag means nothing.
    agent.run_sync("go")
    later = of_type(emitted(), "model_response")[len(responses):]
    assert later
    assert [r.get("fw_streaming") for r in later] == [False] * len(later)


def test_a_completed_leaf_is_never_marked_incomplete(instrumented, emitted):
    """The teardown path must not leak into the ordinary one."""
    weather_agent_with_tool().run_sync("weather in london?")
    rows = emitted()

    assert [r for r in rows if r.get("fw_incomplete")] == []
    assert types_of(rows).index("tool_result") < types_of(rows).index("agent_end")


def test_uninstrumenting_mid_run_closes_the_run_exactly_once(instrumented, emitted):
    """`uninstrument()` and the run's own end are both allowed to go first.

    Before the fix they both went: teardown emitted `agent_end` (`cancelled`)
    and the run then emitted a second `agent_end` (`success`) against a span the
    dashboard had already closed, with the tool's `tool_result` stranded between
    them.
    """

    async def main():
        started = asyncio.Event()
        release = asyncio.Event()
        agent = Agent(
            one_shot_tool_model("wait", {}, tool_call_id="call-wait"),
            name="torn_down_agent",
        )

        @agent.tool_plain
        async def wait() -> str:
            started.set()
            await release.wait()
            return "finished"

        task = asyncio.create_task(agent.run("go"))
        await started.wait()
        failproofai_sdk.uninstrument("pydantic_ai")
        release.set()
        await task

    asyncio.run(main())
    rows = emitted()
    kinds = types_of(rows)

    assert kinds.count("agent_start") == 1
    assert kinds.count("agent_end") == 1, kinds
    assert of_type(rows, "agent_end")[0]["outcome"] == "cancelled"
    # ...and the leaf still closed, inside the span it belongs to.
    assert kinds.count("tool_result") == 1
    assert kinds.index("tool_result") < kinds.index("agent_end")


# ---------------------------------------------------------------------------
# What `tool_result.output` actually says
# ---------------------------------------------------------------------------

def _tool_returning(value, *, name="produce"):
    agent = Agent(one_shot_tool_model(name, {}), name="output_shape_agent")
    agent.tool_plain(lambda: value, name=name)
    return agent


def test_a_tool_returning_a_pydantic_model_is_recorded_as_its_fields(instrumented, emitted):
    from pydantic import BaseModel

    class Weather(BaseModel):
        city: str
        celsius: int

    _tool_returning(Weather(city="Faro", celsius=21)).run_sync("go")

    (result,) = of_type(emitted(), "tool_result")
    # Not "Weather(city='Faro', celsius=21)": `truncate` reprs an object with no
    # JSON shape, and this one has one.
    assert result["output"] == {"city": "Faro", "celsius": 21}


def test_a_tool_returning_a_dataclass_is_recorded_as_its_fields(instrumented, emitted):
    @dataclasses.dataclass
    class Point:
        x: int
        y: int

    _tool_returning(Point(1, 2)).run_sync("go")

    (result,) = of_type(emitted(), "tool_result")
    assert result["output"] == {"x": 1, "y": 2}


def test_a_tool_returning_ToolReturn_is_recorded_as_its_return_value(instrumented, emitted):
    """`ToolReturn` is an envelope, and the envelope is not the answer.

    `return_value` is what goes back to the model; `metadata` is documented as
    never being shown to it at all. Recording the repr of the whole thing buries
    the one and publishes the other.
    """
    from pydantic_ai.messages import ToolReturn

    _tool_returning(
        ToolReturn(
            return_value={"answer": 42},
            content="the model sees this",
            metadata={"secret": "not for the model"},
        )
    ).run_sync("go")

    (result,) = of_type(emitted(), "tool_result")
    assert result["output"] == {"answer": 42}


def test_an_ordinary_tool_return_value_is_untouched(instrumented, emitted):
    """The unwrapping is narrow: only shapes that have a JSON form."""
    _tool_returning("sunny in london").run_sync("go")

    (result,) = of_type(emitted(), "tool_result")
    assert result["output"] == "sunny in london"


class _NoJsonShape:
    def __repr__(self) -> str:
        return "<opaque handle>"


def test_an_object_with_no_json_shape_is_handed_through_untouched():
    """The unwrapping must not become a second, worse serializer.

    Anything that is not a Pydantic model, a dataclass or a `ToolReturn` comes
    back byte-identical, so `_core.truncate` keeps deciding what happens to it —
    including the `repr` fallback it documents for an object with no JSON shape.
    (Unit-level: pydantic-ai itself refuses to send such a value to a model, so
    there is no end-to-end run that reaches this line.)
    """
    opaque = _NoJsonShape()
    assert adapter._tool_output(opaque) is opaque
    assert _core.truncate(adapter._tool_output(opaque)) == "<opaque handle>"

    # A class object is not an instance, and `dataclasses.is_dataclass` is True
    # for both.
    @dataclasses.dataclass
    class Shape:
        x: int

    assert adapter._tool_output(Shape) is Shape


# ---------------------------------------------------------------------------
# Interop with the hand-written API
# ---------------------------------------------------------------------------

def test_an_enclosing_agenteye_scope_owns_the_session(instrumented, emitted):
    with failproofai_sdk.agent("planner", goal="what is the weather?"):
        weather_agent_with_tool().run_sync("go")
    rows = emitted()

    assert len({row["session_id"] for row in rows}) == 1, "the adapter split the session in two"
    assert types_of(rows)[0] == "agent_start"
    assert rows[0]["agent_id"] == "planner"
    (nested,) = [
        row for row in rows if row["type"] == "agent_start" and row["agent_id"] == "weather_agent"
    ]
    assert nested["parent_id"] == "planner"


def test_a_nested_agent_run_nests(instrumented, emitted):
    researcher = Agent(TestModel(call_tools=[]), name="researcher")
    supervisor = Agent(one_shot_tool_model("delegate", {"q": "x"}), name="supervisor")

    @supervisor.tool_plain
    async def delegate(q: str) -> str:
        return (await researcher.run(q)).output

    supervisor.run_sync("go")
    rows = emitted()

    assert len({row["session_id"] for row in rows}) == 1
    starts = {row["agent_id"]: row for row in of_type(rows, "agent_start")}
    assert set(starts) == {"supervisor", "researcher"}
    assert starts["supervisor"].get("parent_id") is None
    assert starts["researcher"]["parent_id"] == "supervisor"
    # Every event carries the agent_id of an agent whose agent_start is open —
    # otherwise the dashboard synthesizes a never-ending root span.
    assert {row["agent_id"] for row in rows} == {"supervisor", "researcher"}


def test_the_conversation_id_becomes_the_session_id(instrumented, emitted):
    agent = Agent(TestModel(call_tools=[]), name="chatty")
    agent.run_sync("first", conversation_id="conversation-42")
    agent.run_sync("second", conversation_id="conversation-42")
    rows = emitted()

    # A conversation spanning several runs is ONE Failproof AI session; two runs are
    # two agent spans inside it.
    assert {row["session_id"] for row in rows} == {"conversation-42"}
    assert len(of_type(rows, "agent_start")) == 2


# ---------------------------------------------------------------------------
# The adapter must never break the host agent
# ---------------------------------------------------------------------------

class Boom:
    """Every attribute is a callable that raises."""

    def __getattr__(self, name):
        def explode(*args, **kwargs):
            raise RuntimeError(f"translator exploded in {name}")

        return explode


def test_a_translator_that_raises_on_every_call_leaves_the_run_intact(
    instrumented, emitted, monkeypatch
):
    monkeypatch.setattr(adapter, "_tracker", Boom())

    result = weather_agent_with_tool().run_sync("weather in london?")

    assert result.output == "done", "the adapter changed what the framework returned"
    assert emitted() == [], "a broken translator still managed to emit"


def test_a_failing_capability_injection_does_not_break_agent_construction(
    instrumented, emitted, monkeypatch
):
    def explode(kwargs):
        raise RuntimeError("injection exploded")

    monkeypatch.setattr(adapter, "_inject", explode)

    # Construction still succeeds and the run is untouched; it simply records
    # nothing, because the capability never got attached.
    assert weather_agent_with_tool().run_sync("go").output == "done"
    assert emitted() == []


def test_strict_mode_turns_the_swallow_into_a_raise(instrumented, monkeypatch):
    """Without this, "it didn't crash" is the only provable property.

    FAILPROOFAI_SDK_STRICT=1 is what makes the never-raise policy testable at all — and
    it doubles as the production switch for debugging an adapter gone quiet.
    """
    monkeypatch.setattr(adapter, "_tracker", Boom())
    _core.set_strict(True)
    try:
        with pytest.raises(RuntimeError, match="translator exploded"):
            weather_agent_with_tool().run_sync("go")
    finally:
        _core.set_strict(False)
        _core.reset_failures()


# ---------------------------------------------------------------------------
# Install / uninstall discipline
# ---------------------------------------------------------------------------

def test_install_patches_agent_init_and_uninstall_restores_the_saved_object():
    original = Agent.__init__
    failproofai_sdk.instrument("pydantic_ai")
    try:
        assert Agent.__init__ is not original
        assert _core.is_wrapped(Agent.__init__)
        # The SAVED object, never a re-import: re-importing to restore hands back
        # whatever the attribute's source currently holds, which is how two
        # instrumentation libraries silently un-patch each other.
        assert _core.unwrap(Agent.__init__) is original
    finally:
        failproofai_sdk.uninstrument("pydantic_ai")
    assert Agent.__init__ is original


def test_instrumenting_twice_is_a_no_op():
    failproofai_sdk.instrument("pydantic_ai")
    try:
        assert failproofai_sdk.instrument("pydantic_ai") == ()
    finally:
        failproofai_sdk.uninstrument("pydantic_ai")


def test_an_explicit_capability_is_not_duplicated(instrumented, emitted):
    agent = Agent(TestModel(call_tools=[]), name="explicit", capabilities=[FailproofAI()])
    agent.run_sync("go")

    assert types_of(emitted()) == ["agent_start", "model_request", "model_response", "agent_end"]


def test_an_agent_built_while_instrumented_goes_inert_after_uninstrument(emitted):
    failproofai_sdk.instrument("pydantic_ai")
    agent = weather_agent_with_tool()
    failproofai_sdk.uninstrument("pydantic_ai")

    # We cannot retro-remove the capability object from an already-built agent,
    # so uninstall() makes it a pass-through instead. Anything less means
    # uninstrument() does not actually stop the recording.
    assert agent.run_sync("go").output == "done"
    assert emitted() == []


def test_unknown_options_are_ignored_rather_than_fatal(emitted):
    # `failproofai_sdk.instrument()` with no name fans the same **options out to every
    # detected adapter, so a keyword meant for LangChain must not take this one
    # down.
    _core.set_strict(True)
    try:
        assert failproofai_sdk.instrument("pydantic_ai", langgraph_node_hooks=False) == ("pydantic_ai",)
    finally:
        failproofai_sdk.uninstrument("pydantic_ai")
        _core.set_strict(None)


# ---------------------------------------------------------------------------
# Structural anti-drift — the test that catches a silent upstream rename
# ---------------------------------------------------------------------------

OVERRIDES = {
    name: obj
    for name, obj in vars(FailproofAI).items()
    if inspect.isfunction(obj) and not name.startswith("_")
}


class TestAntiDrift:
    """Reflection over the REAL base class.

    If upstream renames a callback, our override becomes dead code that is never
    called — the framework keeps working, every fake-based test above keeps
    passing, and we record nothing. Nothing but reflection catches that.
    """

    def test_the_override_set_is_not_empty(self):
        # Guards every test below: `for name in {}` passes vacuously.
        assert set(OVERRIDES) == {
            "get_ordering",
            "wrap_run",
            "wrap_model_request",
            "wrap_tool_execute",
        }

    @pytest.mark.parametrize("name", sorted(OVERRIDES))
    def test_each_override_still_exists_on_the_base_class(self, name):
        assert hasattr(AbstractCapability, name), (
            f"FailproofAI.{name} no longer overrides anything on AbstractCapability — "
            "it is dead code that will never be called."
        )

    @pytest.mark.parametrize("name", sorted(OVERRIDES))
    def test_each_override_actually_replaces_the_base_implementation(self, name):
        assert getattr(AbstractCapability, name) is not OVERRIDES[name]

    @pytest.mark.parametrize("name", sorted(OVERRIDES))
    def test_every_parameter_we_declare_still_exists_on_the_base_signature(self, name):
        ours = inspect.signature(OVERRIDES[name]).parameters
        theirs = inspect.signature(getattr(AbstractCapability, name)).parameters
        for parameter in ours.values():
            if parameter.kind in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            ):
                continue
            assert parameter.name in theirs, (
                f"FailproofAI.{name} declares {parameter.name!r}, which "
                f"AbstractCapability.{name} no longer accepts"
            )
            assert parameter.kind == theirs[parameter.name].kind, (
                f"FailproofAI.{name} takes {parameter.name!r} as {parameter.kind}, "
                f"the base now takes it as {theirs[parameter.name].kind}"
            )

    @pytest.mark.parametrize("name", sorted(OVERRIDES))
    def test_every_hook_we_override_is_still_async_where_the_base_is(self, name):
        # A `def` where the base has `async def` produces a coroutine the
        # framework awaits into a TypeError — or worse, never awaits at all.
        assert inspect.iscoroutinefunction(OVERRIDES[name]) == inspect.iscoroutinefunction(
            getattr(AbstractCapability, name)
        )

    def test_agent_init_still_takes_a_keyword_only_capabilities_argument(self):
        # This is the install mechanism. If `capabilities` stops being a
        # keyword-only parameter of Agent.__init__, `install()` silently attaches
        # nothing at all.
        parameter = inspect.signature(Agent.__init__).parameters["capabilities"]
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY

    def test_there_is_still_no_supported_global_capability_default(self):
        # If upstream ever grows a public one, `install()` should stop patching
        # `Agent.__init__` and use it — patching a constructor cannot reach
        # agents that already exist.
        assert not hasattr(Agent, "capabilities_all")
        assert not hasattr(Agent, "instrument_all_capabilities")

    @pytest.mark.parametrize(
        "attribute",
        ["run_id", "conversation_id", "prompt", "agent", "run_step", "metadata", "usage"],
    )
    def test_run_context_still_carries_the_fields_we_read(self, attribute):
        assert attribute in inspect.get_annotations(RunContext, eval_str=False)

    @pytest.mark.parametrize(
        "attribute", ["model", "messages", "model_request_parameters", "streaming", "model_id"]
    )
    def test_model_request_context_still_carries_the_fields_we_read(self, attribute):
        assert attribute in inspect.get_annotations(ModelRequestContext, eval_str=False)

    @pytest.mark.parametrize("attribute", ["input_tokens", "output_tokens"])
    def test_usage_still_uses_the_2_0_token_names(self, attribute):
        # 2.0 renamed request_tokens/response_tokens. Reading the old names would
        # report zero tokens on every event, at HTTP 200.
        assert hasattr(RunUsage(), attribute)
        assert hasattr(RequestUsage(), attribute)

    @pytest.mark.parametrize("attribute", ["tool_name", "tool_call_id", "args"])
    def test_tool_call_part_still_carries_the_fields_we_read(self, attribute):
        assert hasattr(ToolCallPart("t", {}, tool_call_id="x"), attribute)

    def test_at_least_one_control_flow_exception_is_still_recognised(self):
        # If every name in the list disappeared, `_CONTROL_FLOW` would go empty
        # and control flow would start being reported as run failures.
        assert adapter._CONTROL_FLOW

    def test_we_deliberately_do_not_override_the_two_hooks_with_side_effects(self):
        capability = FailproofAI()
        # Overriding wrap_run_event_stream makes `agent.run()` switch itself into
        # streaming mode; overriding wrap_node_run flips has_wrap_node_run and
        # buys nothing but a doubled row count.
        assert capability.has_wrap_run_event_stream is False
        assert capability.has_wrap_node_run is False

    def test_the_capability_is_constructible_and_orders_itself_outermost(self):
        ordering = FailproofAI().get_ordering()
        assert ordering.position == "outermost"
