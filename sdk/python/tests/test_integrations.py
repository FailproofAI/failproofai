"""The integrations scaffolding, exercised without any framework installed.

Everything here runs against a **fake** adapter registered into the real
registry, and `sys.modules` stubs for the patch mechanics. That is deliberate:
the registry, the failure policy and the install/uninstall discipline are the
parts that must be reviewable on their own, before any framework-specific code
exists to hide behind.

Two properties are only testable because `FAILPROOFAI_SDK_STRICT` exists. Without it
you can prove "the customer's call still worked", but never "we swallowed the
right thing" — and an adapter that swallows `BaseException` passes the first
test while silently breaking cancellation in every async app that installs it.
"""

import logging
import sys
import threading
import types
import warnings

import pytest

import failproofai_sdk
from failproofai_sdk import integrations
from failproofai_sdk.integrations import _compat, _core

INTEGRATIONS_LOGGER = "failproofai_sdk.integrations"


@pytest.fixture(autouse=True)
def _integration_state(monkeypatch):
    """Both strict flags off, no degraded sites, no already-shown warnings.

    All of this is process-global by design (a degraded hook must stay degraded
    for the life of the process), so it has to be reset around every test or the
    order of the file changes its result.
    """
    monkeypatch.delenv("FAILPROOFAI_SDK_STRICT", raising=False)
    monkeypatch.delenv("FAILPROOFAI_SDK_STRICT_INTEGRATIONS", raising=False)
    _reset_flags()
    yield
    _reset_flags()


def _reset_flags():
    _core.set_strict(None)
    _compat.set_strict_integrations(None)
    _core.reset_failures()
    _compat.reset_warnings()


def strict_on(monkeypatch, var="FAILPROOFAI_SDK_STRICT"):
    monkeypatch.setenv(var, "1")
    _core.set_strict(None)
    _compat.set_strict_integrations(None)


class FakeAdapter:
    """The shape `failproofai_sdk/integrations/<framework>.py` has to implement."""

    def __init__(self, name="fake", module="fakeframework", fail_install=False):
        self.name = name
        self.module = module
        self.fail_install = fail_install
        self.installs = 0
        self.uninstalls = 0
        self.options = None

    def install(self, **options):
        self.installs += 1
        self.options = options
        if self.fail_install:
            raise RuntimeError("adapter install exploded")

    def uninstall(self):
        self.uninstalls += 1


def register(monkeypatch, adapter, *, name=None, detect=None):
    """Put an adapter into the real registry for the duration of one test."""
    name = name or adapter.name
    module_path = f"agenteye_fake_{name}"
    module = types.ModuleType(module_path)
    module.adapter = adapter
    monkeypatch.setitem(sys.modules, module_path, module)
    monkeypatch.setitem(integrations._REGISTRY, name, module_path)
    monkeypatch.setitem(integrations._DETECT, name, detect or (adapter.module,))
    return adapter


@pytest.fixture()
def fake(monkeypatch):
    adapter = register(monkeypatch, FakeAdapter())
    yield adapter
    # Before monkeypatch unwinds the registry, so _ACTIVE cannot keep a
    # reference to a test-scoped adapter.
    integrations.uninstrument()


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------

def test_the_four_adapters_are_pre_registered():
    # Registered before their modules exist so that adding an adapter is one new
    # file, never an edit to the registry (which four agents would conflict on).
    assert integrations.available() == ("crewai", "langchain", "llama_index", "pydantic_ai")


@pytest.mark.parametrize(
    "spelling,expected",
    [
        ("langgraph", "langchain"),
        ("LangGraph", "langchain"),
        ("llamaindex", "llama_index"),
        ("llama-index", "llama_index"),
        ("pydantic-ai", "pydantic_ai"),
        (" crewai ", "crewai"),
    ],
)
def test_aliases_resolve(spelling, expected):
    assert integrations._canonical(spelling) == expected


def test_unknown_name_raises_valueerror_listing_the_valid_ones():
    # A typo that silently records nothing is the worst outcome available.
    with pytest.raises(ValueError) as excinfo:
        integrations.instrument("langhcain")
    message = str(excinfo.value)
    assert "langhcain" in message
    for name in ("langchain", "crewai", "llama_index", "pydantic_ai"):
        assert name in message


def test_instrument_installs_and_reports_the_name(fake):
    assert integrations.instrument("fake") == ("fake",)
    assert fake.installs == 1
    assert integrations.active() == ("fake",)


def test_the_public_facade_reaches_the_registry(fake):
    # `failproofai_sdk.instrument` imports this package inside the function body, so
    # this is also the test that the lazy wiring is connected at all.
    assert failproofai_sdk.instrument("fake") == ("fake",)
    assert failproofai_sdk.uninstrument("fake") == ("fake",)
    with pytest.raises(ValueError):
        failproofai_sdk.instrument("bogus")


def test_options_reach_the_adapter(fake):
    integrations.instrument("fake", session_id="s-1", capture_inputs=False)
    assert fake.options == {"session_id": "s-1", "capture_inputs": False}


def test_instrumenting_twice_is_a_noop(fake):
    assert integrations.instrument("fake") == ("fake",)
    assert integrations.instrument("fake") == ()
    assert fake.installs == 1


def test_uninstrument_calls_uninstall_once(fake):
    integrations.instrument("fake")
    assert integrations.uninstrument("fake") == ("fake",)
    assert fake.uninstalls == 1
    assert integrations.active() == ()


def test_uninstrument_of_something_never_instrumented_is_a_noop(fake):
    assert integrations.uninstrument("fake") == ()
    assert fake.uninstalls == 0


def test_uninstrument_of_an_unknown_name_does_not_raise(caplog):
    # Teardown that can fail is teardown people stop calling.
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        assert integrations.uninstrument("nope") == ()
    assert "nope" in caplog.text


def test_bare_instrument_with_nothing_imported_warns_rather_than_going_quiet(
    monkeypatch, caplog
):
    # The import-order mistake — calling instrument() above the `import
    # langchain` line — instruments nothing and is otherwise indistinguishable
    # from working: no exception, no events, adapter "installed". The message
    # naming the fix existed at debug level, where no default logging config
    # shows it, so the one mistake that costs a user all of their telemetry was
    # the one mistake the SDK said nothing about.
    #
    # The registry is emptied for the duration rather than trusting that no
    # earlier test imported a real framework: tests/integrations/ runs first
    # and imports all four, which would make `instrument()` here install them
    # for real and leak `_ACTIVE` into every test after this one.
    monkeypatch.setattr(integrations, "_REGISTRY", {})
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        assert integrations.instrument() == ()
    assert "NOTHING was instrumented" in caplog.text
    assert [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_uninstrument_all_removes_everything(monkeypatch):
    one = register(monkeypatch, FakeAdapter(name="fake1", module="fw1"))
    two = register(monkeypatch, FakeAdapter(name="fake2", module="fw2"))
    integrations.instrument("fake1")
    integrations.instrument("fake2")
    assert sorted(integrations.uninstrument()) == ["fake1", "fake2"]
    assert one.uninstalls == 1 and two.uninstalls == 1
    assert integrations.active() == ()


def test_a_failing_install_is_skipped_and_the_others_still_install(monkeypatch, caplog):
    broken = register(monkeypatch, FakeAdapter(name="broken", module="fw1", fail_install=True))
    good = register(monkeypatch, FakeAdapter(name="good", module="fw2"))
    try:
        with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
            assert integrations.instrument("broken") == ()
            assert integrations.instrument("good") == ("good",)
        assert broken.installs == 1 and good.installs == 1
        assert integrations.active() == ("good",)
        assert "broken" in caplog.text
    finally:
        integrations.uninstrument()


def test_a_failing_install_raises_under_strict(monkeypatch):
    register(monkeypatch, FakeAdapter(name="broken", module="fw1", fail_install=True))
    strict_on(monkeypatch)
    with pytest.raises(RuntimeError, match="exploded"):
        integrations.instrument("broken")
    assert integrations.active() == ()


def test_an_adapter_missing_install_is_rejected(monkeypatch, caplog):
    register(monkeypatch, types.SimpleNamespace(name="halfbaked", module="fw"), name="halfbaked")
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        assert integrations.instrument("halfbaked") == ()
    assert "halfbaked" in caplog.text


# ---------------------------------------------------------------------------
# auto-detection
# ---------------------------------------------------------------------------

def test_autodetect_ignores_a_framework_that_is_not_imported(fake):
    assert "fakeframework" not in sys.modules
    assert "fake" not in integrations.instrument()


def test_autodetect_picks_up_a_framework_that_is_imported(fake, monkeypatch):
    monkeypatch.setitem(sys.modules, "fakeframework", types.ModuleType("fakeframework"))
    assert "fake" in integrations.instrument()
    assert fake.installs == 1


def test_autodetect_ignores_an_installed_but_unimported_framework(fake, monkeypatch, tmp_path):
    """The test that actually separates `sys.modules` from `find_spec`.

    A framework merely *installed* must not be instrumented — the earlier test
    passes against a `find_spec` implementation too, because a stub in
    `sys.modules` has no spec to find. Here the module is genuinely importable
    and genuinely not imported, which is the common case on any machine with
    more than one framework in its virtualenv.
    """
    import importlib.util

    (tmp_path / "unimported_framework.py").write_text("raise AssertionError('imported!')\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setitem(integrations._DETECT, "fake", ("unimported_framework",))

    assert importlib.util.find_spec("unimported_framework") is not None
    assert "unimported_framework" not in sys.modules

    assert "fake" not in integrations.instrument()
    assert fake.installs == 0
    assert "unimported_framework" not in sys.modules


def test_autodetect_never_imports_the_framework(fake, monkeypatch):
    """`sys.modules`, not `find_spec`.

    `find_spec` would say "installed" for a framework the user has not imported,
    and acting on that means charging 200ms of transitive imports to a library
    that was supposed to be invisible.
    """
    imported = []
    real_import_module = integrations.importlib.import_module

    def spy(name, *args, **kwargs):
        imported.append(name)
        return real_import_module(name, *args, **kwargs)

    monkeypatch.setattr(integrations.importlib, "import_module", spy)
    integrations.instrument()
    assert "fakeframework" not in imported


# ---------------------------------------------------------------------------
# install / uninstall discipline
# ---------------------------------------------------------------------------

def original_function(x):
    return x * 2


def test_uninstall_restores_the_exact_original_object():
    # `is`, not `==`. Restoring by re-importing hands back whatever the current
    # value is, which is how two instrumentation libraries un-patch each other.
    holder = types.SimpleNamespace(fn=original_function)
    patcher = _core.Patcher()
    patcher.patch(holder, "fn", _core.wrap_callable(holder.fn, before=lambda *a, **k: None))
    assert holder.fn is not original_function
    assert holder.fn(3) == 6
    patcher.restore_all()
    assert holder.fn is original_function


def test_patching_an_absent_attribute_removes_it_again():
    holder = types.SimpleNamespace()
    patcher = _core.Patcher()
    patcher.patch(holder, "hook", lambda: None)
    assert hasattr(holder, "hook")
    patcher.restore_all()
    assert not hasattr(holder, "hook")


def test_uninstall_declines_when_a_third_party_patched_on_top(caplog):
    holder = types.SimpleNamespace(fn=original_function)
    patcher = _core.Patcher()
    patcher.patch(holder, "fn", _core.wrap_callable(holder.fn, before=lambda *a, **k: None))

    def third_party(x):
        return x

    holder.fn = third_party  # somebody else instrumented after us

    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        patcher.restore_all()

    # Restoring here would silently delete their patch.
    assert holder.fn is third_party
    assert "not restoring" in caplog.text


def test_every_wrapper_carries_the_original():
    wrapped = _core.wrap_callable(original_function, before=lambda *a, **k: None)
    assert _core.is_wrapped(wrapped)
    assert _core.unwrap(wrapped) is original_function
    assert wrapped.__name__ == "original_function"
    assert _core.unwrap(original_function) is original_function


# ---------------------------------------------------------------------------
# failure policy
# ---------------------------------------------------------------------------

def test_a_raising_hook_leaves_the_call_untouched_and_logs_once(caplog):
    def before(*args, **kwargs):
        raise RuntimeError("hook boom")

    wrapped = _core.wrap_callable(original_function, before=before)
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        assert wrapped(21) == 42
    warnings_logged = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings_logged) == 1
    assert warnings_logged[0].exc_info is not None


def test_a_raising_hook_reraises_under_strict(monkeypatch):
    def before(*args, **kwargs):
        raise RuntimeError("hook boom")

    wrapped = _core.wrap_callable(original_function, before=before)
    strict_on(monkeypatch)
    with pytest.raises(RuntimeError, match="hook boom"):
        wrapped(21)


def test_a_hot_failing_hook_is_logged_once_then_disabled(caplog):
    calls = []

    def before(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("boom")

    wrapped = _core.wrap_callable(original_function, before=before)
    with caplog.at_level(logging.DEBUG, logger=INTEGRATIONS_LOGGER):
        for _ in range(10):
            assert wrapped(1) == 2

    # Stops being called at all: a broken adapter costs one log line, not 40%
    # of the process.
    assert len(calls) == _core._MAX_FAILURES
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1
    assert len([r for r in caplog.records if r.levelno == logging.ERROR]) == 1


def test_safe_does_not_swallow_baseexception():
    """CancelledError is a BaseException, and eating it breaks cancellation.

    A `safe()` that caught `BaseException` would pass every other test in this
    file while silently making every instrumented async application unkillable.
    """

    @_core.safe
    def handler():
        raise KeyboardInterrupt("ctrl-c")

    with pytest.raises(KeyboardInterrupt):
        handler()


def test_safe_swallows_exception_and_returns_none(caplog):
    @_core.safe
    def handler():
        raise ValueError("nope")

    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        assert handler() is None
    assert caplog.records


def test_the_structural_guarantee_return_value():
    """before AND after both raising still returns the original's value."""
    sentinel = object()

    def boom(*args, **kwargs):
        raise RuntimeError("hook")

    wrapped = _core.wrap_callable(lambda: sentinel, before=boom, after=boom)
    assert wrapped() is sentinel


def test_the_structural_guarantee_exception_identity():
    """The original exception object comes back out unchanged."""
    original_exc = ValueError("the real failure")

    def raiser():
        raise original_exc

    def boom(*args, **kwargs):
        raise RuntimeError("hook")

    wrapped = _core.wrap_callable(raiser, before=boom, after=boom, on_error=boom)
    with pytest.raises(ValueError) as excinfo:
        wrapped()
    # `is`, not a message match: a wrapper that re-raised a copy would break
    # `except MyError as e: e.retry_after`.
    assert excinfo.value is original_exc


def test_on_error_sees_the_exception_and_the_before_context():
    seen = {}

    def before(*args, **kwargs):
        return {"args": args}

    def on_error(ctx, exc):
        seen["ctx"] = ctx
        seen["exc"] = exc

    failure = KeyError("k")

    def raiser(x):
        raise failure

    wrapped = _core.wrap_callable(raiser, before=before, on_error=on_error)
    with pytest.raises(KeyError):
        wrapped(7)
    assert seen["ctx"] == {"args": (7,)}
    assert seen["exc"] is failure


def test_after_sees_the_result():
    seen = {}
    wrapped = _core.wrap_callable(
        original_function,
        before=lambda *a, **k: "ctx",
        after=lambda ctx, result: seen.update(ctx=ctx, result=result),
    )
    assert wrapped(4) == 8
    assert seen == {"ctx": "ctx", "result": 8}


# ---------------------------------------------------------------------------
# payload discipline
# ---------------------------------------------------------------------------

def test_truncate_marks_and_bounds_a_long_string():
    out = _core.truncate("x" * 20_000, 100)
    assert len(out) == 100
    assert out.endswith(_core.TRUNCATION_MARKER)


def test_truncate_recurses_into_containers():
    out = _core.truncate({"a": ["y" * 500]}, 50)
    assert out["a"][0].endswith(_core.TRUNCATION_MARKER)


def test_truncate_leaves_small_values_alone():
    value = {"a": 1, "b": "short", "c": None, "d": True}
    assert _core.truncate(value) == value


def test_payload_flags_truncation():
    out = _core.payload({"fw_prompt": "z" * 100_000})
    assert out["fw_truncated"] is True
    assert len(out["fw_prompt"]) <= _core.FIELD_LIMIT


def test_payload_enforces_the_event_budget():
    fields = {f"fw_{i}": "q" * _core.FIELD_LIMIT for i in range(20)}
    out = _core.payload(fields)
    assert out["fw_truncated"] is True
    total = sum(len(v) for v in out.values() if isinstance(v, str))
    assert total <= _core.EVENT_BUDGET


def test_payload_leaves_a_small_event_alone():
    assert _core.payload({"fw_node": "retrieve"}) == {"fw_node": "retrieve"}


def test_fw_fields_namespaces_and_drops_none():
    assert _core.fw_fields(run_id="r1", node="retrieve", tags=None) == {
        "fw_run_id": "r1",
        "fw_node": "retrieve",
    }


def test_fw_fields_namespaces_a_name_that_would_shadow_a_column():
    # `_schema._build()` merges extras last, so a bare `tool_name` extra would
    # overwrite the declared one and change the promoted column.
    assert _core.fw_fields(tool_name="sneaky") == {"fw_tool_name": "sneaky"}


def test_fw_fields_passes_the_deliberate_top_level_names_through():
    out = _core.fw_fields(duration_ms=12, request_id="req-1", usage={"total_tokens": 3})
    assert out == {"duration_ms": 12, "request_id": "req-1", "usage": {"total_tokens": 3}}


def test_forbidden_extras_is_derived_from_the_schema():
    # Derived, not hand-listed, so adding a field to _schema.py cannot leave a
    # stale copy here.
    for name in ("tool_name", "model", "outcome", "input_tokens", "error", "session_id"):
        assert name in _core.FORBIDDEN_EXTRAS
    for name in ("request_id", "duration_ms", "usage", "framework"):
        assert name not in _core.FORBIDDEN_EXTRAS


def test_guard_extras_strips_a_shadowing_name(caplog):
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        out = _core.guard_extras({"tool_name": "sneaky", "fw_node": "ok"})
    assert out == {"fw_node": "ok"}
    assert "tool_name" in caplog.text


def test_guard_extras_raises_under_strict(monkeypatch):
    strict_on(monkeypatch)
    with pytest.raises(ValueError, match="tool_name"):
        _core.guard_extras({"tool_name": "sneaky"})


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("  retrieve\n  documents ", "retrieve documents"),
        ("550e8400-e29b-41d4-a716-446655440000", "main"),
        ("550e8400e29b41d4a716446655440000", "main"),
        ("deadbeefdeadbeefdead", "main"),
        ("", "main"),
        ("   ", "main"),
        (None, "main"),
        ("Researcher", "Researcher"),
        ("node_" * 40, ("node_" * 40)[:64]),
    ],
)
def test_normalize_agent_id(raw, expected):
    # agent_id is LowCardinality(String) and the primary dashboard facet; a UUID
    # in it poisons that facet for every session in the project.
    assert _core.normalize_agent_id(raw, "main") == expected


def test_ms_is_always_an_int():
    # The server stores duration_ms as u32 and its JSON parser drops floats,
    # which silently NULLs the column.
    from datetime import timedelta

    assert _core.ms(1.2345) == 1234
    assert isinstance(_core.ms(0.5), int)
    assert _core.ms(timedelta(milliseconds=250)) == 250
    assert _core.ms(-3.0) == 0


def test_framework_fields():
    out = _core.framework_fields("langchain", "definitely-not-installed")
    assert out["framework"] == "langchain"
    assert out["integration_version"] == failproofai_sdk.__version__
    assert "framework_version" not in out


# ---------------------------------------------------------------------------
# RunTracker
# ---------------------------------------------------------------------------

def test_run_tracker_brackets_an_agent(events):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("run-1", agent_id="researcher", session_id="s-1", goal="find it")
    tracker.end_agent("run-1", outcome="success")
    assert events.types() == ["agent_start", "agent_end"]
    start, end = events.entries
    assert start["session_id"] == "s-1"
    assert start["agent_id"] == "researcher"
    assert start["goal"] == "find it"
    assert "parent_id" not in start
    assert end["outcome"] == "success"


def test_run_tracker_uses_a_uuid_run_id_as_a_key_not_as_an_agent_id(events):
    tracker = _core.RunTracker("fake")
    tracker.start_agent(
        "run-1", agent_id="550e8400-e29b-41d4-a716-446655440000", session_id="s-1"
    )
    assert events.last()["agent_id"] == "main"


def test_run_tracker_nests_on_the_parent_key(events):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("root", agent_id="crew", session_id="s-1")
    tracker.start_agent("child", agent_id="researcher", parent_key="root")
    child = events.entries[-1]
    assert child["parent_id"] == "crew"
    assert child["session_id"] == "s-1"


def test_run_tracker_walks_a_chain_of_non_agent_runs(events):
    """The framework's parent_run_id chain is a better parent than a contextvar
    stack: it survives task hops and thread pools."""
    tracker = _core.RunTracker("fake")
    tracker.start_agent("agent-run", agent_id="graph", session_id="s-1")
    tracker.link("chain-run", "agent-run")
    tracker.link("inner-run", "chain-run")
    tracker.emit(
        "tool_use", "tool-run", parent_key="inner-run", tool_name="search", tool_call_id="t1"
    )
    tool = events.entries[-1]
    assert tool["type"] == "tool_use"
    assert tool["agent_id"] == "graph"
    assert tool["session_id"] == "s-1"


def test_run_tracker_joins_a_hand_written_scope(events):
    """Step 3 of `identity()` — the whole interop story.

    An adapter running inside a hand-written `with failproofai_sdk.agent("planner")`
    must land in the SAME session with parent_id="planner", or the customer gets
    two disconnected trees for one run.
    """
    tracker = _core.RunTracker("fake")
    with failproofai_sdk.agent("planner", session_id="s-outer", goal="q"):
        tracker.start_agent("run-1", agent_id="researcher")
        tracker.emit("tool_use", "run-1", tool_name="search", tool_call_id="t1")
        tracker.end_agent("run-1")
        # A run the tracker has never seen — a callback that arrived without a
        # start, which every framework produces eventually — still lands on the
        # open scope rather than being dropped or given a session of its own.
        tracker.emit("tool_use", "never-registered", tool_name="lookup", tool_call_id="t2")

    assert events.types() == [
        "agent_start",
        "agent_start",
        "tool_use",
        "agent_end",
        "tool_use",
        "agent_end",
    ]
    assert all(e["session_id"] == "s-outer" for e in events.entries)
    researcher = events.entries[1]
    assert researcher["agent_id"] == "researcher"
    assert researcher["parent_id"] == "planner"
    assert events.entries[2]["agent_id"] == "researcher"
    assert events.entries[4]["agent_id"] == "planner"


def test_run_tracker_does_not_invent_a_parent_inside_a_bare_session(events):
    """A `session()` scope binds no agent, so an adapter agent there is a root.

    Claiming `parent_id="main"` would point at an agent that never emitted an
    `agent_start`, and the dashboard answers that by synthesizing a permanent
    extra lane that is `ongoing` forever.
    """
    tracker = _core.RunTracker("fake")
    with failproofai_sdk.session("s-outer"):
        tracker.start_agent("run-1", agent_id="researcher")
    start = events.entries[0]
    assert start["session_id"] == "s-outer"
    assert "parent_id" not in start


def test_run_tracker_drops_unresolvable_events_and_warns_once(events, caplog):
    tracker = _core.RunTracker("fake")
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        for i in range(5):
            tracker.emit("tool_use", f"unknown-{i}", tool_name="t", tool_call_id="x")
    assert events.entries == []
    # Dropped rather than given a synthesized session id: a synthetic session
    # splits one run into many, which is a silent wrong answer.
    resolution_warnings = [r for r in caplog.records if "could not resolve" in r.getMessage()]
    assert len(resolution_warnings) == 1


def test_run_tracker_is_bounded(events):
    tracker = _core.RunTracker("fake", max_open=10)
    for i in range(200):
        tracker.start_agent(f"run-{i}", agent_id="worker", session_id="s-1")
    assert len(tracker.open_agents()) <= 10


def test_run_tracker_survives_concurrent_start_and_end(events):
    """CrewAI dispatches its handlers on a ten-worker pool."""
    tracker = _core.RunTracker("fake")
    errors = []
    barrier = threading.Barrier(8)

    def worker(n):
        try:
            barrier.wait(timeout=10)
            for i in range(50):
                key = f"{n}-{i}"
                tracker.start_agent(key, agent_id="worker", session_id="s-1")
                tracker.emit("tool_use", key, tool_name="t", tool_call_id=key)
                tracker.end_agent(key)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert errors == []
    assert tracker.open_agents() == ()
    assert len(events.entries) == 8 * 50 * 3


def test_run_tracker_close_open_agents(events):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("a", agent_id="one", session_id="s-1")
    tracker.start_agent("b", agent_id="two", parent_key="a")
    tracker.close_open_agents()
    # A session that dies with an open agent_start renders `ongoing` forever.
    assert events.types() == ["agent_start", "agent_start", "agent_end", "agent_end"]
    assert [e["agent_id"] for e in events.entries[2:]] == ["two", "one"]
    assert all(e["outcome"] == "cancelled" for e in events.entries[2:])


def test_run_tracker_stamps_the_framework_fields(events):
    tracker = _core.RunTracker("fake", base_fields=_core.framework_fields("fake"))
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    assert events.last()["framework"] == "fake"
    assert events.last()["integration_version"] == failproofai_sdk.__version__


def test_run_tracker_base_fields_cannot_shadow_a_declared_field(events, caplog):
    tracker = _core.RunTracker("fake", base_fields={"tool_name": "hijacked"})
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        tracker.emit("tool_use", "run-1", tool_name="real", tool_call_id="t1")
    assert events.last()["tool_name"] == "real"


def test_run_tracker_truncates_a_huge_payload(events):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    tracker.emit(
        "tool_use", "run-1", tool_name="t", tool_call_id="t1", input={"q": "x" * 100_000}
    )
    assert len(events.last()["input"]["q"]) <= _core.FIELD_LIMIT


def test_run_tracker_never_raises_into_the_caller(events, caplog):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    with caplog.at_level(logging.WARNING, logger=INTEGRATIONS_LOGGER):
        # `timestamp` is reserved, so the emit raises inside the SDK.
        tracker.emit("tool_use", "run-1", tool_name="t", tool_call_id="t1", timestamp="nope")
    assert "failproofai_sdk" in caplog.text


def test_run_tracker_raises_into_the_caller_under_strict(events, monkeypatch):
    tracker = _core.RunTracker("fake")
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    strict_on(monkeypatch)
    with pytest.raises(ValueError):
        tracker.emit("tool_use", "run-1", tool_name="t", tool_call_id="t1", timestamp="nope")


def test_run_tracker_does_not_touch_contextvars(events):
    """Shape B must never bind identity onto the context.

    `ContextVar.reset(token)` raises across asyncio tasks as well as threads, so
    a token cannot be held between two callbacks — and a scope entered in
    `on_tool_start` that is never exited misattributes every later event in the
    process.
    """
    from failproofai_sdk import _context

    tracker = _core.RunTracker("fake")
    tracker.start_agent("run-1", agent_id="worker", session_id="s-1")
    assert _context.snapshot() == (None, ())
    tracker.emit("tool_use", "run-1", tool_name="t", tool_call_id="t1")
    assert _context.snapshot() == (None, ())
    tracker.end_agent("run-1")
    assert _context.snapshot() == (None, ())


# ---------------------------------------------------------------------------
# _compat
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("1.5.2", (1, 5, 2)),
        ("2.0.0b1", (2, 0, 0)),
        ("0.14.23.post1", (0, 14, 23)),
        ("1.2.dev0", (1, 2)),
        ("1", (1,)),
        ("", ()),
        ("nonsense", ()),
    ],
)
def test_parse_version_is_naive_on_purpose(text, expected):
    # No `packaging`: `import failproofai_sdk` is zero-dependency.
    assert _compat.parse_version(text) == expected


def test_version_comparison_orders_as_expected():
    assert _compat.parse_version("1.5") >= _compat.parse_version("1.4.7")
    assert _compat.parse_version("1.5.2") < _compat.parse_version("2")


def test_missing_framework_raises_with_the_install_command():
    # Tier 1. Instrumenting is an explicit user action, so silence is never right.
    with pytest.raises(ImportError) as excinfo:
        _compat.require_module("definitely_not_a_module", dist="nope", extra="langchain")
    assert "pip install 'failproofai_sdk[langchain]'" in str(excinfo.value)


def test_require_module_returns_the_module():
    assert _compat.require_module("json", dist="json", extra="langchain").__name__ == "json"


def test_version_in_range_is_silent(recwarn):
    assert _compat.check_version("self", "failproofai_sdk", minimum="0.0.1", below="99") is True
    assert not [w for w in recwarn if issubclass(w.category, _compat.FailproofAICompatWarning)]


def test_version_out_of_range_warns_once():
    # Tier 2: warn, then best effort. A ceiling is what stops a future major
    # from making the adapter stop recording while raising nothing.
    with pytest.warns(_compat.FailproofAICompatWarning, match="newer"):
        assert _compat.check_version("self", "failproofai_sdk", below="0.0.1") is False

    # Deduplicated: these fire from install() *and* from hot callbacks, so a
    # per-call warning on a chatty framework is its own outage.
    with warnings.catch_warnings(record=True) as second:
        warnings.simplefilter("always")
        _compat.check_version("self", "failproofai_sdk", below="0.0.1")
    assert not [w for w in second if issubclass(w.category, _compat.FailproofAICompatWarning)]


def test_an_uninstallable_distribution_is_best_effort():
    assert _compat.check_version("x", "definitely-not-installed", minimum="99") is True


def test_strict_integrations_promotes_a_warning_to_an_exception(monkeypatch):
    strict_on(monkeypatch, "FAILPROOFAI_SDK_STRICT_INTEGRATIONS")
    with pytest.raises(_compat.FailproofAICompatWarning):
        _compat.check_version("self", "failproofai_sdk", minimum="99")


def test_a_failing_capability_probe_disables_one_hook_only():
    # Tier 3.
    with pytest.warns(_compat.FailproofAICompatWarning, match="on_interrupt"):
        assert _compat.probe("langchain", "on_interrupt", lambda: 1 / 0) is False
    assert _compat.probe("langchain", "on_tool_start", lambda: True) is True


def test_a_probe_returning_false_warns():
    with pytest.warns(_compat.FailproofAICompatWarning, match="does not provide"):
        assert _compat.probe("langchain", "on_resume", lambda: None) is False
