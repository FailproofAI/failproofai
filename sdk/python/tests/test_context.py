"""Tests for the identity layer: contextvars, the agent stack, and propagate().

The tests that matter here are the ones a reviewer cannot derive from reading
the diff:

* the **adversarially interleaved** task test, which is the only shape that
  fails against a module-global implementation;
* the **tuple test**, which is the only shape that fails against
  `ContextVar[list]`;
* `propagate` under `pool.map`, which is the only shape that fails against
  `partial(copy_context().run, fn)`.
"""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import failproofai_sdk
import failproofai_sdk._context as _context
import failproofai_sdk._runtime as _runtime


# ---------------------------------------------------------------------------
# Basic binding
# ---------------------------------------------------------------------------

def test_nothing_bound_by_default():
    ident = failproofai_sdk.current()
    assert ident.session_id is None
    assert ident.agent_id is None
    assert ident.parent_id is None
    assert ident.depth == 0


def test_session_binds_and_unbinds():
    with failproofai_sdk.session("s-1") as sid:
        assert sid == "s-1"
        assert failproofai_sdk.current().session_id == "s-1"
    assert failproofai_sdk.current().session_id is None


def test_session_generates_an_id_when_none_bound():
    with failproofai_sdk.session() as sid:
        assert isinstance(sid, str) and len(sid) == 32
        assert failproofai_sdk.current().session_id == sid


def test_nested_session_inherits_rather_than_generating(events):
    with failproofai_sdk.session() as outer:
        with failproofai_sdk.session() as inner:
            assert inner == outer
        with failproofai_sdk.agent("child") as ident:
            assert ident.session_id == outer


def test_agent_id_falls_back_to_main():
    assert _context.agent_id() == _context.DEFAULT_AGENT_ID == "main"
    with failproofai_sdk.session("s-1", agent_id="worker"):
        assert _context.agent_id() == "worker"


# ---------------------------------------------------------------------------
# Task isolation — must FAIL against a module-global implementation
# ---------------------------------------------------------------------------

def test_tasks_are_isolated_when_adversarially_interleaved(events):
    """Two tasks bind different sessions, then are forced to interleave.

    The `await asyncio.sleep(0)` between binding and emitting is the whole
    point: it yields to the event loop *while the scope is open*, so task B
    binds its session before task A emits. Against a module global, A's
    tool_use would carry B's session_id and this assertion fails. Without the
    forced interleave the same test passes on a global and proves nothing.
    """
    order: list[str] = []

    async def run(name: str) -> None:
        async with failproofai_sdk.agent(name, session_id=f"sess-{name}"):
            order.append(f"bound-{name}")
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            order.append(f"emit-{name}")
            _runtime.event.tool_use(tool_name="t", tool_call_id=f"tc-{name}")
            await asyncio.sleep(0)

    async def main() -> None:
        await asyncio.gather(run("a"), run("b"))

    asyncio.run(main())

    # Prove the interleave actually happened; otherwise the test is vacuous.
    assert order.index("bound-b") < order.index("emit-a")

    by_call = {e["tool_call_id"]: e for e in events.entries if e["type"] == "tool_use"}
    assert by_call["tc-a"]["session_id"] == "sess-a"
    assert by_call["tc-a"]["agent_id"] == "a"
    assert by_call["tc-b"]["session_id"] == "sess-b"
    assert by_call["tc-b"]["agent_id"] == "b"


def test_agent_stack_is_a_tuple_not_a_shared_list(events):
    """Task A's stack must be unmodified by task B pushing a nested agent.

    A `ContextVar[list]` holds the *same list object* in both tasks, so B's
    push would show up in A's view. This is the test that catches it.
    """
    seen: dict[str, tuple[str, ...]] = {}
    pushed = asyncio.Event()

    async def first() -> None:
        async with failproofai_sdk.agent("root-a", session_id="s"):
            async with failproofai_sdk.agent("child-a"):
                # Hand control to the other task, which pushes child-b.
                await pushed.wait()
                seen["a"] = _context._AGENT_STACK.get()

    async def second() -> None:
        async with failproofai_sdk.agent("root-b", session_id="s"):
            async with failproofai_sdk.agent("child-b"):
                seen["b"] = _context._AGENT_STACK.get()
                pushed.set()
                await asyncio.sleep(0)

    async def main() -> None:
        await asyncio.gather(first(), second())

    asyncio.run(main())

    assert seen["a"] == ("root-a", "child-a")
    assert seen["b"] == ("root-b", "child-b")
    assert isinstance(seen["a"], tuple)


def test_create_task_inherits_without_propagate(events):
    """Pinned deliberately: contextvars DO flow into asyncio tasks.

    Nobody should later sprinkle `propagate()` over async code — a Task copies
    the current context at creation, so the identity is already there.
    """
    captured: list = []

    async def child() -> None:
        captured.append(failproofai_sdk.current())

    async def main() -> None:
        with failproofai_sdk.agent("parent", session_id="s-async"):
            await asyncio.create_task(child())

    asyncio.run(main())
    assert captured[0].session_id == "s-async"
    assert captured[0].agent_id == "parent"


# ---------------------------------------------------------------------------
# Thread isolation and propagate()
# ---------------------------------------------------------------------------

def test_threads_do_not_inherit_identity():
    seen: list = []

    def worker() -> None:
        seen.append(failproofai_sdk.current())

    with failproofai_sdk.session("s-thread"):
        t = threading.Thread(target=worker)
        t.start()
        t.join()

    assert seen[0].session_id is None


def test_bare_submit_inside_agent_raises_naming_propagate(events):
    def worker():
        _runtime.event.tool_use(tool_name="t", tool_call_id="tc")

    with failproofai_sdk.agent("a", session_id="s"):
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker)
            with pytest.raises(TypeError) as excinfo:
                future.result()

    assert "propagate" in str(excinfo.value)


def test_propagate_with_pool_submit(events):
    def worker(n):
        _runtime.event.tool_use(tool_name="t", tool_call_id=f"tc-{n}")
        return failproofai_sdk.current().session_id

    with failproofai_sdk.agent("a", session_id="s-submit"):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [pool.submit(failproofai_sdk.propagate(worker), n).result() for n in range(3)]

    assert results == ["s-submit"] * 3
    tool_uses = [e for e in events.entries if e["type"] == "tool_use"]
    assert {e["session_id"] for e in tool_uses} == {"s-submit"}
    assert {e["agent_id"] for e in tool_uses} == {"a"}


def test_propagate_survives_reuse_via_pool_map(events):
    """`pool.map` calls ONE wrapper object many times, concurrently.

    This is what `partial(contextvars.copy_context().run, fn)` cannot do: a
    `Context` raises `RuntimeError: cannot enter context ... already entered`
    on the second concurrent entry, and mutations inside it persist into the
    next call. Snapshot/restore has neither problem.
    """
    # Forces four workers to be *inside* the wrapper simultaneously. Without
    # it the calls serialise and a copy_context() implementation passes by
    # accident, which makes the test worthless.
    barrier = threading.Barrier(4)

    def worker(n):
        ident = failproofai_sdk.current()
        barrier.wait(timeout=5)
        # Mutate the stack, to prove the mutation does not leak into the next
        # invocation of the same wrapper.
        with failproofai_sdk.agent(f"child-{n}", session_id=ident.session_id):
            pass
        return (ident.session_id, ident.agent_id, ident.depth)

    with failproofai_sdk.agent("a", session_id="s-map"):
        wrapped = failproofai_sdk.propagate(worker)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(wrapped, range(8)))

    assert results == [("s-map", "a", 1)] * 8


def test_propagate_with_threading_thread(events):
    seen: list = []

    def worker():
        seen.append(failproofai_sdk.current())

    with failproofai_sdk.agent("a", session_id="s-thread2"):
        t = threading.Thread(target=failproofai_sdk.propagate(worker))
        t.start()
        t.join()

    assert seen[0].session_id == "s-thread2"
    assert seen[0].agent_id == "a"


def test_propagate_with_run_in_executor(events):
    def worker():
        return failproofai_sdk.current().session_id

    async def main():
        with failproofai_sdk.agent("a", session_id="s-executor"):
            loop = asyncio.get_running_loop()
            with ThreadPoolExecutor(max_workers=1) as pool:
                return await loop.run_in_executor(pool, failproofai_sdk.propagate(worker))

    assert asyncio.run(main()) == "s-executor"


def test_propagate_does_not_leak_into_the_worker_thread_afterwards():
    seen: list = []

    def worker():
        pass

    def after():
        seen.append(failproofai_sdk.current().session_id)

    with failproofai_sdk.session("s-leak"):
        wrapped = failproofai_sdk.propagate(worker)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(wrapped).result()
        pool.submit(after).result()

    assert seen[0] is None


def test_propagate_preserves_metadata():
    def worker(a, b=2):
        """docstring."""
        return a + b

    wrapped = failproofai_sdk.propagate(worker)
    assert wrapped.__name__ == "worker"
    assert wrapped.__doc__ == "docstring."
    assert wrapped(1, b=3) == 4


# ---------------------------------------------------------------------------
# Explicit identity always wins
# ---------------------------------------------------------------------------

def test_explicit_ids_override_the_context(events):
    with failproofai_sdk.agent("ctx-agent", session_id="ctx-session"):
        _runtime.event.tool_use(
            session_id="explicit-session",
            agent_id="explicit-agent",
            tool_name="t",
            tool_call_id="tc",
        )
    entry = [e for e in events.entries if e["type"] == "tool_use"][0]
    assert entry["session_id"] == "explicit-session"
    assert entry["agent_id"] == "explicit-agent"


def test_explicit_agent_id_only_keeps_context_session(events):
    with failproofai_sdk.agent("ctx-agent", session_id="ctx-session"):
        _runtime.event.tool_use(agent_id="other", tool_name="t", tool_call_id="tc")
    entry = [e for e in events.entries if e["type"] == "tool_use"][0]
    assert entry["session_id"] == "ctx-session"
    assert entry["agent_id"] == "other"


def test_missing_session_outside_any_scope_raises(events):
    with pytest.raises(TypeError, match="propagate"):
        _runtime.event.agent_start()


def test_agent_id_defaults_to_main_with_only_a_session(events):
    with failproofai_sdk.session("s-only"):
        _runtime.event.agent_start()
    assert events.last()["agent_id"] == "main"


# ---------------------------------------------------------------------------
# Exception precedence is unchanged by the identity fallback
# ---------------------------------------------------------------------------

def test_duration_ms_guard_still_beats_the_identity_error(events):
    """No session bound, and duration_ms passed. The ValueError must win.

    `_identity()` runs after the guard precisely so today's precedence holds.
    """
    with pytest.raises(ValueError, match="duration_ms"):
        _runtime.event.tool_result(tool_name="t", tool_call_id="tc", duration_ms=99)


def test_reserved_field_error_still_beats_the_identity_error(events):
    with pytest.raises(ValueError, match="Reserved field"):
        _runtime.event.agent_start(timestamp="nope")


def test_duplicate_session_id_still_raises_type_error(events):
    with pytest.raises(TypeError):
        _runtime.event.agent_start(session_id="s", **{"session_id": "s2"})


# ---------------------------------------------------------------------------
# `_pending` correlation keys
# ---------------------------------------------------------------------------

def test_hook_id_no_longer_collides_with_tool_call_id(events):
    ns = _runtime.event
    ns.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id="x1")
    ns.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="x1")
    assert "duration_ms" not in events.last()
    # And the tool's own pending entry is untouched, so it still pairs.
    ns.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="x1")
    assert "duration_ms" in events.last()


def test_hook_pair_still_produces_a_duration(events):
    ns = _runtime.event
    ns.hook_triggered(session_id="s", agent_id="a", hook_name="h", hook_id="h1")
    ns.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="h1")
    assert "duration_ms" in events.last()


def test_tool_keys_stay_bare_so_cross_agent_pairs_still_match(events):
    """A tool started under one agent and finished under another must pair.

    Namespacing tool keys by agent_id would silently turn this correct
    duration_ms into a missing one, and this is routine once frameworks run
    tools inside sub-agents.
    """
    ns = _runtime.event
    ns.tool_use(session_id="s", agent_id="planner", tool_name="t", tool_call_id="tc")
    ns.tool_result(session_id="s", agent_id="worker", tool_name="t", tool_call_id="tc")
    assert "duration_ms" in events.last()


def test_track_pending_is_thread_safe_at_the_cap(events):
    """Hammer `_track_pending` at the cap from several threads.

    Unlocked, the read-modify-write lets two threads pick the same `oldest` and
    the second `del` raises KeyError *inside* the caller's event.tool_use().
    """
    from failproofai_sdk._events import _PENDING_CAP

    ns = _runtime.event
    for i in range(_PENDING_CAP):
        ns._track_pending(f"seed-{i}", ns._now())

    errors: list[Exception] = []

    def hammer(worker: int) -> None:
        try:
            for i in range(200):
                ns._track_pending(f"w{worker}-{i}", ns._now())
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=hammer, args=(w,)) for w in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert len(ns._pending) == _PENDING_CAP
