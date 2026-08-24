"""Nothing this SDK accepts may be lost without saying so.

The writer buffers in memory and publishes from a background daemon thread, so
every failure here is asynchronous and out of the caller's sight: `event.*()`
returned None a long time ago and the application moved on. There is no return
code to check, no exception to catch, and — because an unread spool looks
exactly like an idle one — no symptom until someone notices a dashboard is
emptier than it should be.

The tests below are the ones that would have caught a real loss. Several of them
are regression tests for a bug found while writing them: batches were named from
a millisecond timestamp alone, so two written in the same millisecond collided
and `os.replace` silently overwrote the first. It fired on the atexit flush
racing the flush thread, on `flush_now()` from two threads, and — worst — across
processes sharing one spool root, which is the ordinary deployment.
"""
import json
import logging
import os
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from failproofai_sdk import _resolver
from failproofai_sdk._events import _PENDING_CAP, EventNamespace, _tool_key
from failproofai_sdk._writer import _QUEUE_CAP, EventWriter


@pytest.fixture
def spool(tmp_path, monkeypatch):
    """An isolated spool root, restored afterwards."""
    _resolver.set_base_dir(tmp_path)
    yield tmp_path
    _resolver.set_base_dir(None)


def read_all(spool_dir: Path) -> list[dict]:
    """Every event in every published batch. Fails loudly on a torn file."""
    events = []
    for path in sorted((spool_dir / "events").glob("*.jsonl")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:  # pragma: no cover - failure path
                pytest.fail(f"{path.name}:{lineno} is not valid JSON ({exc}): {line!r}")
    return events


# ─────────────────────────────────────────────────────────────────────────────
# Batch naming — the silent-overwrite class
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def frozen_clock(monkeypatch):
    """Pin `_writer`'s clock so "the same millisecond" is guaranteed, not likely.

    Without this the collision tests below only reproduce the bug when both
    writes happen to land in one millisecond. They usually do on a fast machine
    — which is the problem: on a loaded CI runner the clock advances between
    them, a timestamp-only stem produces two different names, and the test
    passes against the very implementation it exists to reject.
    """
    # NOT `from failproofai_sdk import _writer` — `__init__` binds that name to
    # the EventWriter SINGLETON, which shadows the submodule of the same name on
    # the package. Reaching for the module has to go through sys.modules.
    writer_module = sys.modules["failproofai_sdk._writer"]

    fixed = datetime(2026, 1, 2, 3, 4, 5, 678_000, tzinfo=timezone.utc)

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed

    monkeypatch.setattr(writer_module, "datetime", _FrozenDatetime)
    return fixed


def test_two_batches_in_the_same_millisecond_do_not_overwrite_each_other(spool, frozen_clock):
    """Regression: the timestamp-only stem lost whichever batch wrote first."""
    writer = EventWriter(flush_interval=3600)
    writer._write_batch([{"id": "first"}])
    writer._write_batch([{"id": "second"}])

    # Same instant for both, so a timestamp-only name could not have differed.
    stems = sorted(p.name for p in (spool / "events").glob("*.jsonl"))
    assert len(stems) == 2, f"the two batches collided onto one file: {stems}"
    assert all(frozen_clock.strftime("%Y-%m-%dT%H-%M-%S") in s for s in stems)

    recovered = {e["id"] for e in read_all(spool)}
    assert recovered == {"first", "second"}


# The DeprecationWarning about fork() in a multi-threaded process is the
# hazard under test, not a problem with the test.
@pytest.mark.filterwarnings("ignore:.*fork.*:DeprecationWarning")
def test_batch_filenames_are_unique_across_processes(spool, frozen_clock):
    """Several agents share one spool root. Their batches must not collide.

    Nothing in a timestamp-only stem identified the writer, so two processes
    flushing in the same millisecond overwrote each other — and because each one
    saw its own `os.replace` succeed, both would report having written.

    The frozen clock is inherited across `fork()`, so every child computes the
    same timestamp and the collision is forced rather than hoped for.
    """
    if not hasattr(os, "fork"):
        pytest.skip("requires fork")

    pids = []
    for _ in range(4):
        pid = os.fork()
        if pid == 0:  # child
            try:
                writer = EventWriter(flush_interval=3600)
                writer._write_batch([{"id": f"pid-{os.getpid()}"}])
            finally:
                os._exit(0)
        pids.append(pid)
    for pid in pids:
        _, status = os.waitpid(pid, 0)
        assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0

    assert len({e["id"] for e in read_all(spool)}) == 4


def test_published_batches_never_end_in_tmp(spool):
    """`.tmp` is how the daemons tell "still being written" from "ready"."""
    writer = EventWriter(flush_interval=3600)
    for i in range(20):
        writer._write_batch([{"id": i}])

    names = [p.name for p in (spool / "events").iterdir()]
    assert names, "nothing was published"
    assert all(n.endswith(".jsonl") for n in names)
    assert not any(n.endswith(".tmp") for n in names), (
        f"a .tmp file survived publication: {[n for n in names if n.endswith('.tmp')]}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Concurrency
# ─────────────────────────────────────────────────────────────────────────────


def test_sixteen_threads_emitting_concurrently_lose_and_duplicate_nothing(spool):
    """The queue is written by many threads and drained by one. Prove it holds."""
    threads, per_thread = 16, 500
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)
    barrier = threading.Barrier(threads)

    def emit(thread_id: int):
        barrier.wait()
        for n in range(per_thread):
            namespace.agent_start(
                session_id=f"s{thread_id}", agent_id="a", goal=f"{thread_id}:{n}"
            )

    workers = [threading.Thread(target=emit, args=(i,)) for i in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    writer.flush_now()

    goals = [e["goal"] for e in read_all(spool)]
    assert len(goals) == threads * per_thread, "events were lost"
    assert len(set(goals)) == len(goals), "events were duplicated"


def test_concurrent_flushes_publish_every_batch(spool):
    """`flush_now()` from several threads at once must not drop a batch."""
    writer = EventWriter(flush_interval=3600)
    total = 400
    for i in range(total):
        writer.submit({"id": i})

    barrier = threading.Barrier(8)

    def flush():
        barrier.wait()
        writer.flush_now()

    workers = [threading.Thread(target=flush) for _ in range(8)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert sorted(e["id"] for e in read_all(spool)) == list(range(total))


def test_a_reader_never_observes_a_partially_written_batch(spool):
    """The `.tmp` -> `.jsonl` rename is what makes a visible file a complete one.

    A daemon polls this directory. If it can ever open a `.jsonl` mid-write it
    reads truncated JSON, ingest counts the bad lines as `skipped`, and returns
    200 — silent partial loss with a successful-looking upload.
    """
    writer = EventWriter(flush_interval=3600)
    events_dir = spool / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    torn: list[str] = []

    def poll():
        while not stop.is_set():
            for path in list(events_dir.glob("*.jsonl")):
                try:
                    text = path.read_text(encoding="utf-8")
                except (FileNotFoundError, PermissionError):
                    continue
                if text and not text.endswith("\n"):
                    torn.append(f"{path.name}: no trailing newline")
                    continue
                for line in text.splitlines():
                    try:
                        json.loads(line)
                    except json.JSONDecodeError:
                        torn.append(f"{path.name}: {line[:60]!r}")

    reader = threading.Thread(target=poll, daemon=True)
    reader.start()
    try:
        # Batches big enough that a non-atomic write would be caught mid-flight.
        for batch in range(60):
            writer._write_batch([{"id": f"{batch}-{i}", "pad": "x" * 512} for i in range(200)])
    finally:
        stop.set()
        reader.join(timeout=5)

    assert not torn, f"reader saw incomplete batches: {torn[:5]}"


# ─────────────────────────────────────────────────────────────────────────────
# Failure and retry
# ─────────────────────────────────────────────────────────────────────────────


def test_a_failed_write_requeues_the_batch_and_the_next_flush_recovers_it(spool, monkeypatch):
    """A transient filesystem error must delay events, never discard them."""
    writer = EventWriter(flush_interval=3600)
    for i in range(50):
        writer.submit({"id": i})

    real_replace = os.replace
    monkeypatch.setattr(os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError(28, "No space left on device")))

    with pytest.raises(OSError):
        writer.flush_now()
    assert read_all(spool) == [], "a failed write must publish nothing"
    assert len(writer._queue) == 50, "the batch was dropped instead of requeued"

    monkeypatch.setattr(os, "replace", real_replace)
    writer.flush_now()
    assert sorted(e["id"] for e in read_all(spool)) == list(range(50))


def test_a_requeued_batch_keeps_its_original_order(spool, monkeypatch):
    """Requeueing at the front must not reverse the batch."""
    writer = EventWriter(flush_interval=3600)
    for i in range(20):
        writer.submit({"id": i})

    monkeypatch.setattr(os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError):
        writer.flush_now()
    monkeypatch.undo()

    writer.flush_now()
    assert [e["id"] for e in read_all(spool)] == list(range(20))


def test_the_flush_thread_survives_a_write_failure_and_retries(spool, monkeypatch):
    """One bad flush must not permanently kill the background writer.

    If the loop thread dies, every subsequent event in the process is buffered
    forever and lost at exit — from the caller's side, indistinguishable from
    working.
    """
    failures = {"n": 0}
    real_replace = os.replace

    def flaky(src, dst):
        if failures["n"] < 2:
            failures["n"] += 1
            raise OSError("transient")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", flaky)
    writer = EventWriter(flush_interval=0.01)
    writer.submit({"id": "eventually"})

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not read_all(spool):
        time.sleep(0.02)

    assert failures["n"] == 2, "the failure injection never fired"
    assert [e["id"] for e in read_all(spool)] == ["eventually"]
    assert writer._thread.is_alive()


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission semantics")
@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root ignores mode bits")
def test_an_unwritable_spool_retains_events_rather_than_dropping_them(spool):
    """A wrong-permissions spool is a config error, not a reason to lose data."""
    writer = EventWriter(flush_interval=3600)
    events_dir = spool / "events"
    events_dir.mkdir(parents=True)
    events_dir.chmod(0o500)  # r-x: cannot create files
    try:
        writer.submit({"id": "kept"})
        with pytest.raises(OSError):
            writer.flush_now()
        assert len(writer._queue) == 1
    finally:
        events_dir.chmod(0o700)

    writer.flush_now()
    assert [e["id"] for e in read_all(spool)] == ["kept"]


# ─────────────────────────────────────────────────────────────────────────────
# Process lifecycle
# ─────────────────────────────────────────────────────────────────────────────


def _run_script(body: str, spool_dir: Path) -> subprocess.CompletedProcess:
    script = f"""
import failproofai_sdk
failproofai_sdk.configure(base_dir={str(spool_dir)!r}, flush_interval=3600)
{body}
"""
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(Path(__file__).resolve().parents[1]),
    )


def test_events_are_flushed_at_normal_interpreter_exit(tmp_path):
    """`flush_interval=3600` means atexit is the only thing that can publish."""
    result = _run_script(
        "failproofai_sdk.event.agent_start(session_id='s', agent_id='a', goal='at-exit')",
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert [e["goal"] for e in read_all(tmp_path)] == ["at-exit"]


def test_events_are_flushed_when_the_process_exits_via_sys_exit(tmp_path):
    result = _run_script(
        "import sys\n"
        "failproofai_sdk.event.agent_start(session_id='s', agent_id='a', goal='sys-exit')\n"
        "sys.exit(3)",
        tmp_path,
    )
    assert result.returncode == 3
    assert [e["goal"] for e in read_all(tmp_path)] == ["sys-exit"]


def test_events_are_flushed_when_the_process_dies_of_an_uncaught_exception(tmp_path):
    """The run that crashed is the run whose telemetry matters most."""
    result = _run_script(
        "failproofai_sdk.event.error(session_id='s', agent_id='a', "
        "error_type='RuntimeError', message='boom')\n"
        "raise RuntimeError('boom')",
        tmp_path,
    )
    assert result.returncode == 1
    assert [e["type"] for e in read_all(tmp_path)] == ["error"]


def test_os_exit_skips_the_flush_and_that_is_documented_not_fixed(tmp_path):
    """`os._exit` bypasses atexit by definition. Pinned so nobody assumes otherwise.

    There is no way to make this safe from inside the SDK — the point of
    `os._exit` is to skip cleanup. The honest answer is a documented loss window
    and a `flush_now()` for callers who use it, not a fix that cannot exist.
    """
    result = _run_script(
        "import os\n"
        "failproofai_sdk.event.agent_start(session_id='s', agent_id='a', goal='lost')\n"
        "os._exit(0)",
        tmp_path,
    )
    assert result.returncode == 0
    assert read_all(tmp_path) == []


def test_flush_now_makes_os_exit_safe(tmp_path):
    """The documented escape hatch for the case above."""
    result = _run_script(
        "import os\n"
        "failproofai_sdk.event.agent_start(session_id='s', agent_id='a', goal='kept')\n"
        "failproofai_sdk._writer.flush_now()\n"
        "os._exit(0)",
        tmp_path,
    )
    assert result.returncode == 0
    assert [e["goal"] for e in read_all(tmp_path)] == ["kept"]


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires fork")
# The DeprecationWarning about fork() in a multi-threaded process is the
# hazard under test, not a problem with the test.
@pytest.mark.filterwarnings("ignore:.*fork.*:DeprecationWarning")
def test_a_forked_child_can_still_emit_and_publish(spool):
    """The flush thread does not survive fork; the child must not hang or lose.

    A child that inherits a queue with no thread to drain it, and then blocks
    forever at exit, turns telemetry into a liveness bug in the host process.
    """
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)
    namespace.agent_start(session_id="parent", agent_id="a", goal="before-fork")

    pid = os.fork()
    if pid == 0:  # child
        try:
            child_writer = EventWriter(flush_interval=3600)
            EventNamespace(child_writer).agent_start(
                session_id="child", agent_id="a", goal="in-child"
            )
            child_writer.flush_now()
            os._exit(0)
        except BaseException:
            os._exit(70)

    _, status = os.waitpid(pid, 0)
    assert os.WIFEXITED(status), "child did not exit cleanly"
    assert os.WEXITSTATUS(status) == 0, f"child exited {os.WEXITSTATUS(status)}"

    writer.flush_now()
    goals = {e["goal"] for e in read_all(spool)}
    assert goals == {"before-fork", "in-child"}


# ─────────────────────────────────────────────────────────────────────────────
# Correlation state
# ─────────────────────────────────────────────────────────────────────────────


def test_pending_map_is_capped_and_evicts_oldest_first():
    """An agent that never closes its tool calls must not exhaust memory."""
    namespace = EventNamespace(_NullWriter())
    for i in range(_PENDING_CAP + 100):
        namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id=f"c{i}")

    assert len(namespace._pending) == _PENDING_CAP
    assert _tool_key("s", "c0") not in namespace._pending, "eviction is not FIFO"
    assert _tool_key("s", f"c{_PENDING_CAP + 99}") in namespace._pending


def test_an_evicted_pair_completes_without_duration_instead_of_raising():
    """Losing a duration is acceptable. Raising inside the caller's agent is not."""
    writer = _NullWriter()
    namespace = EventNamespace(writer)
    namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id="evicted")
    for i in range(_PENDING_CAP):
        namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id=f"c{i}")

    writer.entries.clear()
    namespace.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="evicted")

    assert "duration_ms" not in writer.entries[0]


def test_a_tool_and_a_hook_sharing_an_id_do_not_cross_correlate():
    """Regression: they used to share one flat keyspace in `_pending`.

    An id collision between a tool call and a hook is not exotic — both are
    routinely the harness's own step id. When the keys were bare, the
    `hook_completed` consumed the `tool_use` timestamp and reported the interval
    between two unrelated events, and the real `tool_result` that followed got no
    duration at all. Two plausible numbers, no error, nothing downstream able to
    tell.
    """
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id="shared")

    # The hook never started, so its completion must not borrow the tool's start.
    writer.entries.clear()
    namespace.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="shared")
    assert "duration_ms" not in writer.entries[0], (
        "hook_completed consumed the tool_use timestamp — the keyspaces are flat again"
    )

    # And the tool's own pairing is untouched, so its result still gets a duration.
    writer.entries.clear()
    namespace.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="shared")
    assert "duration_ms" in writer.entries[0], (
        "the tool's pending entry was consumed by the unrelated hook"
    )


def test_every_pairing_is_namespaced_by_what_it_pairs():
    """The keyspaces are separate in both directions, for all four pair types."""
    writer = _NullWriter()
    namespace = EventNamespace(writer)
    ids = dict(session_id="s", agent_id="a")

    namespace.tool_use(**ids, tool_name="t", tool_call_id="x")
    namespace.hook_triggered(**ids, hook_name="h", hook_id="x")
    namespace.human_wait(**ids, input_id="x")
    namespace.agent_pause(**ids, pause_id="x")

    # Four starts, one shared id, four distinct pending keys.
    assert len(namespace._pending) == 4, sorted(namespace._pending)

    # Each end event finds its own start and no other.
    for call in (
        lambda: namespace.tool_result(**ids, tool_name="t", tool_call_id="x"),
        lambda: namespace.hook_completed(**ids, hook_name="h", hook_id="x"),
        lambda: namespace.human_input(**ids, input_id="x"),
        lambda: namespace.agent_resume(**ids, pause_id="x"),
    ):
        writer.entries.clear()
        call()
        assert "duration_ms" in writer.entries[0], writer.entries[0]["type"]

    assert namespace._pending == {}, "an end event left its start behind"


def test_human_and_pause_pairs_are_namespaced_by_session_and_agent():
    """The same input id in two sessions must not cross-correlate."""
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.human_wait(session_id="s1", agent_id="a", input_id="same")
    writer.entries.clear()
    namespace.human_input(session_id="s2", agent_id="a", input_id="same")
    assert "duration_ms" not in writer.entries[0]

    writer.entries.clear()
    namespace.human_input(session_id="s1", agent_id="a", input_id="same")
    assert "duration_ms" in writer.entries[0]


class _NullWriter:
    def __init__(self):
        self.entries = []

    def submit(self, entry):
        self.entries.append(entry)


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad", [-1, -0.001, 0, 0.0, float("nan"), float("inf"), float("-inf")]
)
def test_an_unusable_flush_interval_is_rejected_at_the_boundary(bad):
    """`time.sleep` runs OUTSIDE the loop's try, so a bad value kills the thread.

    And a dead writer thread is the worst state this class has: `submit()` keeps
    accepting events, the queue keeps growing, nothing is ever written, and the
    caller learns none of it. Negative, NaN and infinite intervals all raise from
    `sleep`; zero does not raise but busy-loops, pinning a core and rewriting the
    spool as fast as the disk allows. All of them are refused up front instead.
    """
    with pytest.raises(ValueError, match="finite number greater than zero"):
        EventWriter(flush_interval=bad)


@pytest.mark.parametrize("bad", [-1, 0, float("nan"), float("inf")])
def test_set_flush_interval_rejects_without_changing_the_live_interval(bad):
    """A refused value must leave the writer on the interval it already had."""
    writer = EventWriter(flush_interval=3600)
    with pytest.raises(ValueError):
        writer.set_flush_interval(bad)
    assert writer._flush_interval == 3600
    assert writer._thread.is_alive()


@pytest.mark.parametrize("bad", [-1, 0, float("nan"), float("inf")])
def test_configure_rejects_a_bad_interval_before_applying_anything(bad, spool, tmp_path):
    """Validation comes first, so a rejected call is not a half-applied one."""
    import failproofai_sdk

    failproofai_sdk.configure(base_dir=spool, flush_interval=3600)

    with pytest.raises(ValueError, match="finite number greater than zero"):
        failproofai_sdk.configure(base_dir=tmp_path / "elsewhere", flush_interval=bad)

    # base_dir is set BEFORE the interval in configure(), so validating inside
    # set_flush_interval alone would have left this pointing at "elsewhere".
    assert _resolver.get_base_dir() == spool
    assert failproofai_sdk._writer._flush_interval == 3600


def test_a_valid_interval_still_applies():
    writer = EventWriter(flush_interval=3600)
    writer.set_flush_interval(0.25)
    assert writer._flush_interval == 0.25
    # Ints are accepted and normalised, so `_flush_loop` always sleeps on a float.
    writer.set_flush_interval(2)
    assert writer._flush_interval == 2.0
    assert isinstance(writer._flush_interval, float)


def test_configure_can_be_called_after_events_have_already_been_emitted(spool, tmp_path):
    """Late configuration must redirect the spool, not strand what is buffered."""
    import failproofai_sdk

    failproofai_sdk.configure(base_dir=spool, flush_interval=3600)
    failproofai_sdk.event.agent_start(session_id="s", agent_id="a", goal="before")

    later = tmp_path / "later"
    failproofai_sdk.configure(base_dir=later, flush_interval=3600)
    failproofai_sdk.event.agent_start(session_id="s", agent_id="a", goal="after")
    failproofai_sdk._writer.flush_now()

    # Both were still in the queue, so both land under the newest base dir.
    assert {e["goal"] for e in read_all(later)} == {"before", "after"}
    assert read_all(spool) == []


def test_configure_is_safe_to_call_from_several_threads(spool, tmp_path):
    """Racing configure() calls must not corrupt state or lose queued events."""
    import failproofai_sdk

    # This is the one test that asserts an EXACT count on the process-wide
    # singleton, so it must not inherit anything another test left queued. Drain
    # to a throwaway directory first — otherwise the assertion below depends on
    # test execution order, and an order-dependent test fails for a reason that
    # has nothing to do with what it checks.
    failproofai_sdk.configure(base_dir=tmp_path / "drain", flush_interval=3600)
    failproofai_sdk._writer.flush_now()

    failproofai_sdk.configure(base_dir=spool, flush_interval=3600)
    barrier = threading.Barrier(8)
    errors: list[BaseException] = []

    def churn(n: int):
        try:
            barrier.wait()
            for _ in range(50):
                failproofai_sdk.configure(base_dir=spool, flush_interval=3600)
                failproofai_sdk.event.agent_start(session_id=f"s{n}", agent_id="a")
        except BaseException as exc:  # pragma: no cover - failure path
            errors.append(exc)

    workers = [threading.Thread(target=churn, args=(i,)) for i in range(8)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    failproofai_sdk._writer.flush_now()

    assert not errors, errors
    assert len(read_all(spool)) == 8 * 50


# ─────────────────────────────────────────────────────────────────────────────
# fork() — the flush thread does not survive it
# ─────────────────────────────────────────────────────────────────────────────


def test_a_forked_child_publishes_through_its_own_restarted_thread(tmp_path):
    """The realistic shape: the child reuses the INHERITED singleton.

    The sibling test above builds a fresh `EventWriter` in the child and calls
    `flush_now()` by hand, which proves the child does not hang and nothing else.
    Nobody writes an agent that way. They `import failproofai_sdk` once, and
    whatever forks — gunicorn, celery, `multiprocessing` on Linux — inherits that
    module-level writer.

    Threads do not cross `fork()`, so before `os.register_at_fork` the child got
    a queue and no drainer: `submit()` kept accepting, nothing was ever
    published, and the events appeared only if the child happened to exit through
    a normal interpreter shutdown. A prefork worker is killed instead, so all of
    the telemetry — the workers are where the work happens — silently vanished.

    The child here ends with `os._exit`, which skips atexit by definition. If the
    event still lands, a background thread wrote it, which is the whole claim.
    """
    result = _run_script(
        "import os, time\n"
        "pid = os.fork()\n"
        "if pid == 0:\n"
        "    failproofai_sdk.configure(base_dir=%r, flush_interval=0.05)\n"
        "    failproofai_sdk.event.agent_start(session_id='child', agent_id='a', goal='in-child')\n"
        "    time.sleep(1.5)\n"
        "    os._exit(0)\n"
        "os.waitpid(pid, 0)\n" % str(tmp_path),
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    goals = [e["goal"] for e in read_all(tmp_path)]
    assert goals == ["in-child"], (
        f"the child's flush thread never restarted (got {goals!r}); "
        "os._exit skips atexit, so only a live thread could have written this"
    )


def test_a_fork_does_not_duplicate_the_events_the_parent_had_queued(tmp_path):
    """The child inherits the parent's undrained queue; only one of them owns it.

    Publishing from both produced a byte-identical duplicate of every event
    buffered at the instant of the fork. Ingest would most likely collapse those
    — its dedup key hashes the canonical payload — but relying on the server to
    tidy up after the SDK is not a property worth shipping.
    """
    result = _run_script(
        "import os\n"
        "failproofai_sdk.event.agent_start(session_id='p', agent_id='a', goal='queued-before-fork')\n"
        "pid = os.fork()\n"
        "if pid == 0:\n"
        "    failproofai_sdk.event.agent_start(session_id='c', agent_id='a', goal='child-only')\n"
        "    failproofai_sdk._writer.flush_now()\n"
        "    os._exit(0)\n"
        "os.waitpid(pid, 0)\n"
        "failproofai_sdk._writer.flush_now()\n",
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    goals = sorted(e["goal"] for e in read_all(tmp_path))
    assert goals == ["child-only", "queued-before-fork"], (
        f"expected each event exactly once, got {goals!r}"
    )


def test_the_fork_handler_prunes_writers_that_have_been_collected():
    """`_live_writers` holds weak references, and drops the dead ones.

    Note what this does NOT claim. A writer is not collectable while it exists:
    its flush thread targets `self._flush_loop`, and a running thread holds its
    target, so in practice every writer outlives every collection. The weakness
    matters because a dead referent must be SKIPPED rather than restarted, and
    because it keeps this list from being a second, independent reason a writer
    can never be freed — which is what `atexit.register(self._flush)` was.

    So the dead entry is injected rather than produced, because producing one
    means defeating the thread that keeps it alive.
    """
    import gc
    import sys
    import weakref

    writer_module = sys.modules["failproofai_sdk._writer"]

    class _Collectable:
        def _reinit_after_fork(self):  # pragma: no cover - must never be reached
            raise AssertionError("a collected writer was restarted after fork")

    victim = _Collectable()
    dead = weakref.ref(victim)
    writer_module._live_writers.append(dead)
    del victim
    gc.collect()
    assert dead() is None, "the test's own victim outlived it"

    writer_module._reinit_all_after_fork()
    assert dead not in writer_module._live_writers, "a dead weakref was left registered"


# ─────────────────────────────────────────────────────────────────────────────
# The queue is bounded
# ─────────────────────────────────────────────────────────────────────────────


def test_the_queue_is_capped_and_discards_oldest_first(spool, caplog):
    """`submit` cannot block or raise, so the only other option is to bound it.

    Unbounded, any condition that stops the spool draining turns a telemetry
    outage into an OOM kill of the host agent — the SDK taking down the very
    process it exists to observe.
    """
    writer = EventWriter(flush_interval=3600)
    with caplog.at_level(logging.WARNING, logger="failproofai_sdk._writer"):
        for i in range(_QUEUE_CAP + 250):
            writer.submit({"type": "e", "n": i})

    assert len(writer._queue) == _QUEUE_CAP, "the queue is unbounded"
    ns = [e["n"] for e in writer._queue]
    assert ns[0] == 250, "eviction is not oldest-first"
    assert ns[-1] == _QUEUE_CAP + 249, "the newest event was dropped instead of the oldest"
    assert any("queue is full" in r.getMessage() for r in caplog.records), (
        "the cap discarded events without saying so"
    )


def test_the_full_queue_warning_does_not_fire_on_every_single_drop(spool, caplog):
    """A stuck spool must not become the thing that fills the disk."""
    writer = EventWriter(flush_interval=3600)
    with caplog.at_level(logging.WARNING, logger="failproofai_sdk._writer"):
        for i in range(_QUEUE_CAP + 2500):
            writer.submit({"type": "e", "n": i})

    warnings = [r for r in caplog.records if "queue is full" in r.getMessage()]
    assert 1 <= len(warnings) <= 5, f"{len(warnings)} warnings for 2500 drops"


# ─────────────────────────────────────────────────────────────────────────────
# The flush interval, and the shutdown race that changing it exposed
# ─────────────────────────────────────────────────────────────────────────────


def test_a_new_flush_interval_applies_to_the_cycle_already_waiting(spool):
    """Otherwise `configure()` is ignored for one full cycle of the OLD interval.

    The thread starts at import, so its first wait is always the 500 ms default —
    which a caller asking for 50 ms has no way to know about, and which is long
    enough for a fork or an exit to land inside it.
    """
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "e", "n": 1})

    writer.set_flush_interval(0.05)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not list((spool / "events").glob("*.jsonl")):
        time.sleep(0.02)

    assert [e["n"] for e in read_all(spool)] == [1], (
        "the writer sat on the hour-long interval it was configured away from"
    )


def test_a_flush_racing_interpreter_shutdown_does_not_lose_the_batch(tmp_path):
    """A batch is drained from the queue BEFORE it is written.

    So a flush thread stopped part-way through — which is what happens to a
    daemon thread once the interpreter starts finalising — takes those events
    with it, leaving at most a stray `.tmp`. The atexit flush has to WAIT on an
    in-flight batch rather than find an empty queue and return, which is why the
    emptiness check lives inside `_flush_lock`.

    Waking the thread on `set_flush_interval` is what made this likely enough to
    reproduce: it puts a flush and the main thread's exit path in the same
    moment, every run.
    """
    for attempt in range(8):
        target = tmp_path / f"run-{attempt}"
        result = _run_script(
            "failproofai_sdk.event.error(session_id='s', agent_id='a', "
            "error_type='RuntimeError', message='boom')\n"
            "raise RuntimeError('boom')",
            target,
        )
        assert result.returncode == 1
        assert [e["type"] for e in read_all(target)] == ["error"], (
            f"attempt {attempt}: the crashing run's telemetry was lost to the shutdown race"
        )
        assert list((target / "events").glob("*.tmp")) == [], (
            f"attempt {attempt}: a batch was abandoned part-written"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Correlation state — session and agent scoping
# ─────────────────────────────────────────────────────────────────────────────


def test_tool_pairs_are_namespaced_by_session_and_agent():
    """Two sessions in one process must not share a tool_call_id's timestamp.

    `_pending` lives on a single process-wide `EventNamespace`, and a supervisor
    running agents concurrently is the ordinary multi-agent shape — so a step id
    that repeats across sessions (`step-1`, and both ids are frequently the
    harness's own step counter) collided. Session B's start overwrote A's, A's
    result reported B's interval, and B's result reported nothing at all.
    """
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.tool_use(session_id="A", agent_id="a", tool_name="t", tool_call_id="step-1")
    namespace.tool_use(session_id="B", agent_id="b", tool_name="t", tool_call_id="step-1")
    assert len(namespace._pending) == 2, "B's start overwrote A's"

    writer.entries.clear()
    namespace.tool_result(session_id="A", agent_id="a", tool_name="t", tool_call_id="step-1")
    assert "duration_ms" in writer.entries[0], "A's result could not find A's own start"

    writer.entries.clear()
    namespace.tool_result(session_id="B", agent_id="b", tool_name="t", tool_call_id="step-1")
    assert "duration_ms" in writer.entries[0], "B's start had been consumed by A's result"


def test_hook_pairs_are_namespaced_by_session_and_agent():
    """Same lookup pattern, same bug, same fix."""
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.hook_triggered(session_id="A", agent_id="a", hook_name="h", hook_id="step-1")
    namespace.hook_triggered(session_id="B", agent_id="b", hook_name="h", hook_id="step-1")
    assert len(namespace._pending) == 2

    for session, agent in (("A", "a"), ("B", "b")):
        writer.entries.clear()
        namespace.hook_completed(session_id=session, agent_id=agent, hook_name="h", hook_id="step-1")
        assert "duration_ms" in writer.entries[0], f"{session} lost its own start"


def test_a_pair_opened_and_closed_under_different_agents_still_pairs():
    """The key is deliberately NOT agent-scoped, and this is why.

    This test asserted the opposite when the keys were first namespaced: that a
    tool id repeated under two agents in one session produced two independent
    pairs. That looked like tightening; it was over-tightening. Once a framework
    runs tools inside sub-agents — LangGraph and CrewAI both do — a `tool_use`
    opened under `planner` and closed under `worker` is the ORDINARY case, and an
    agent-scoped key makes it miss silently, dropping `duration_ms` for exactly
    the nested runs that most need it.

    The rule that survives both: key on what makes the id unique (kind, session)
    and never on what can legitimately change between the two events (the agent).
    """
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.tool_use(session_id="S", agent_id="planner", tool_name="t", tool_call_id="x")
    writer.entries.clear()
    namespace.tool_result(session_id="S", agent_id="worker", tool_name="t", tool_call_id="x")

    assert "duration_ms" in writer.entries[0], (
        "a tool handed from planner to worker lost its duration — the key is "
        "agent-scoped again"
    )
    assert namespace._pending == {}, "the pending entry was left behind"


def test_a_hook_opened_and_closed_under_different_agents_still_pairs():
    """Same rule, same reason, for the other adapter-driven pair type."""
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.hook_triggered(session_id="S", agent_id="planner", hook_name="h", hook_id="x")
    writer.entries.clear()
    namespace.hook_completed(session_id="S", agent_id="worker", hook_name="h", hook_id="x")
    assert "duration_ms" in writer.entries[0]


def test_a_result_from_an_unrelated_session_gets_no_duration_at_all():
    """The failure the scoping prevents: a duration measured across sessions.

    No duration is the correct answer here. A plausible number would be worse
    than an absent one, because nothing downstream can tell it is wrong.
    """
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.tool_use(session_id="A", agent_id="a", tool_name="t", tool_call_id="shared")
    writer.entries.clear()
    namespace.tool_result(session_id="B", agent_id="b", tool_name="t", tool_call_id="shared")
    assert "duration_ms" not in writer.entries[0], "a duration leaked across sessions"


# ─────────────────────────────────────────────────────────────────────────────
# Durability — atomic is not the same as committed
# ─────────────────────────────────────────────────────────────────────────────


def _fs_trace(monkeypatch):
    """Record the order of fsync/replace calls made while writing a batch."""
    import sys

    writer_module = sys.modules["failproofai_sdk._writer"]
    order = []
    real_fsync, real_replace = os.fsync, writer_module.os.replace

    def fsync_spy(fd):
        try:
            st = os.fstat(fd)
            kind = "dir" if stat.S_ISDIR(st.st_mode) else "file"
        except OSError:  # pragma: no cover
            kind = "?"
        order.append(f"fsync:{kind}")
        return real_fsync(fd)

    def replace_spy(src, dst):
        order.append("replace")
        return real_replace(src, dst)

    monkeypatch.setattr(writer_module.os, "fsync", fsync_spy)
    monkeypatch.setattr(writer_module.os, "replace", replace_spy)
    return order


def test_the_batch_is_fsynced_before_the_rename_and_the_dir_after(spool, monkeypatch):
    """`os.replace` is atomic to READERS; it commits nothing to the platter.

    Without the content fsync, a power loss can leave a correctly-named,
    zero-length `.jsonl`. The collector reads it, POSTs an empty body, gets a
    200 and then DELETES the file (`remove_file` in
    `crates/fpai-collect/src/uploader.rs`) — permanent, silent loss. Without the
    directory fsync the reverse survives: the bytes are on disk but the rename
    is not, so the batch sits under a `.tmp` name the watcher ignores by design.

    This repo's own Rust spool writer has called `sync_all()` here from the
    start (`crates/fpai-collect/src/spool.rs`); the Python writer publishing
    into the same directories was the odd one out.
    """
    order = _fs_trace(monkeypatch)
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "e", "n": 1})
    writer.flush_now()

    assert "replace" in order, "no rename happened"
    assert order.index("fsync:file") < order.index("replace"), (
        f"content was renamed before it was committed: {order}"
    )
    assert any(o == "fsync:dir" for o in order[order.index("replace"):]), (
        f"the rename itself was never committed: {order}"
    )


def test_a_published_batch_is_complete_on_disk_not_merely_present(spool):
    """The property the fsync exists to buy, asserted at the file level."""
    writer = EventWriter(flush_interval=3600)
    namespace = EventNamespace(writer)
    for i in range(200):
        namespace.agent_start(session_id="s", agent_id="a", goal=f"g{i}")
    writer.flush_now()

    published = read_all(spool)
    assert len(published) == 200
    for path in (spool / "events").glob("*.jsonl"):
        text = path.read_text(encoding="utf-8")
        assert text.endswith("\n"), f"{path.name} is truncated mid-line"
        assert all(json.loads(line) for line in text.splitlines())


def test_a_crash_between_write_and_rename_leaves_no_half_batch(spool, monkeypatch):
    """Fault injection: the rename never happens.

    The watcher must see nothing — a `.tmp` is not a `.jsonl` — and the events
    must go back on the queue rather than being counted as delivered.
    """
    import sys

    writer_module = sys.modules["failproofai_sdk._writer"]
    monkeypatch.setattr(
        writer_module.os, "replace",
        lambda *a: (_ for _ in ()).throw(OSError(5, "simulated crash before rename")),
    )
    writer = EventWriter(flush_interval=3600)
    writer.submit({"type": "e", "n": 1})

    with pytest.raises(OSError):
        writer.flush_now()

    assert list((spool / "events").glob("*.jsonl")) == [], "a batch was published anyway"
    assert len(writer._queue) == 1, "the events were dropped rather than retried"


# ─────────────────────────────────────────────────────────────────────────────
# The correlation map is mutated from the caller's own threads
# ─────────────────────────────────────────────────────────────────────────────


def test_evicting_at_the_cap_never_raises_into_the_callers_thread():
    """Regression: `len()` -> `next(iter())` -> `del` is a read-modify-write.

    Nothing serialised the three, so two threads arriving at a full `_pending`
    picked the SAME victim and the second `del` raised KeyError — straight out
    of `event.tool_use()`, in the caller's agent loop. Measured at 24 crashes
    per 30_000 calls across 10 threads before the fix.

    It only fires once `_pending` is full, which is exactly the long-running
    multi-agent process the cap exists for, so "rare" here means "only in
    production".
    """
    namespace = EventNamespace(_NullWriter())
    errors: list[BaseException] = []

    def churn(worker: int):
        try:
            for i in range(3000):
                namespace.tool_use(
                    session_id="s", agent_id="a", tool_name="t", tool_call_id=f"{worker}-{i}"
                )
                if i % 7 == 0:
                    namespace.tool_result(
                        session_id="s", agent_id="a", tool_name="t", tool_call_id=f"{worker}-{i}"
                    )
        except BaseException as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=churn, args=(w,)) for w in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"{len(errors)} exception(s) reached the caller: {errors[:3]}"
    assert len(namespace._pending) <= _PENDING_CAP * 2, (
        f"the cap stopped bounding anything: {len(namespace._pending)}"
    )


def test_the_cap_still_bounds_the_map_after_the_concurrency_fix():
    """Tolerant eviction must not become no eviction."""
    namespace = EventNamespace(_NullWriter())
    for i in range(_PENDING_CAP + 500):
        namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id=f"c{i}")
    assert len(namespace._pending) == _PENDING_CAP


def test_a_persistent_write_fault_does_not_strand_a_tmp_file_per_cycle(spool, monkeypatch):
    """Each flush picks a fresh stem, so a stuck rename leaked one file a cycle.

    At the default 500 ms interval that is ~170_000 files a day, on the very
    disk that is already the problem — and the watcher ignores them by
    extension, so nothing else would ever notice or collect them.

    The batch itself must survive: `_flush` returns the entries to the queue and
    the next cycle rewrites them under a new name.
    """
    import sys

    writer_module = sys.modules["failproofai_sdk._writer"]
    real_replace = writer_module.os.replace
    monkeypatch.setattr(
        writer_module.os, "replace",
        lambda *a: (_ for _ in ()).throw(OSError(28, "No space left on device")),
    )

    writer = EventWriter(flush_interval=3600)
    for i in range(50):
        writer.submit({"type": "e", "n": i})
        with pytest.raises(OSError):
            writer.flush_now()

    assert list((spool / "events").glob("*.tmp")) == [], "orphaned .tmp files accumulated"
    assert len(writer._queue) == 50, "events were lost to the failed writes"

    monkeypatch.setattr(writer_module.os, "replace", real_replace)
    writer.flush_now()
    assert len(read_all(spool)) == 50, "the recovered batch is incomplete"
    assert list((spool / "events").glob("*.tmp")) == []


# ─────────────────────────────────────────────────────────────────────────────
# SIGTERM — the exit path the docs got wrong
# ─────────────────────────────────────────────────────────────────────────────


def _run_child(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    """Run `body` in a fresh interpreter spooling into `tmp_path`.

    A subprocess rather than a fork: the point is CPython's *default* signal
    disposition in a process this test did not otherwise touch, and pytest's own
    handlers are inherited across a fork.
    """
    src = (
        "import os, signal, sys\n"
        "import failproofai_sdk as fp\n"
        "from failproofai_sdk import event\n"
        f"fp.configure(base_dir={str(tmp_path)!r}, flush_interval=3600.0)\n" + body
    )
    return subprocess.run(
        [sys.executable, "-c", src],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(Path(__file__).resolve().parents[1]),
    )


def test_sigterm_drops_the_queue_because_cpython_runs_no_atexit_for_it(tmp_path):
    """The claim this replaces said `atexit` *does* run on `SIGTERM`. It does not.

    CPython installs no handler for `SIGTERM` — `signal.getsignal(SIGTERM)` is
    `SIG_DFL` — so the OS terminates the process where it stands and the atexit
    flush never runs. `SKILL.md` told readers the opposite, under a heading
    naming rolling deploys and `docker stop`, which is exactly the population
    that would have believed it and shipped nothing.

    The long flush interval isolates the exit path: in real use the 0.5s default
    is what bounds the loss, and that bound is the whole mitigation.
    """
    proc = _run_child(
        tmp_path,
        "with fp.session('sigterm-bare'):\n"
        "    for i in range(20):\n"
        "        event.agent_start(agent_id='a', goal=str(i))\n"
        "os.kill(os.getpid(), signal.SIGTERM)\n",
    )
    assert proc.returncode == -15, proc.stderr
    assert read_all(tmp_path) == [], (
        "SIGTERM must be shown losing the queue; if this now passes events "
        "through, the SDK grew a handler and SKILL.md's recipe is obsolete"
    )


def test_the_documented_sigterm_handler_saves_the_queue_and_closes_the_run(tmp_path):
    """The recipe SKILL.md now ships, executed rather than described.

    `sys.exit` and not `os._exit`: it unwinds, so an open `agent()` scope emits
    its `agent_end` before the flush — the events most likely to be in flight at
    shutdown are exactly the ones that close a run.
    """
    proc = _run_child(
        tmp_path,
        "def _flush_and_exit(signum, frame):\n"
        "    fp._writer.flush_now()\n"
        "    sys.exit(128 + signum)\n"
        "signal.signal(signal.SIGTERM, _flush_and_exit)\n"
        "with fp.agent('worker', session_id='sigterm-handled', goal='survive'):\n"
        "    for i in range(20):\n"
        "        event.tool_use(tool_name='t', tool_call_id=str(i), input={'i': i})\n"
        "    os.kill(os.getpid(), signal.SIGTERM)\n",
    )
    assert proc.returncode == 128 + 15, proc.stderr
    events = read_all(tmp_path)
    kinds = {e["type"] for e in events}
    assert len([e for e in events if e["type"] == "tool_use"]) == 20
    assert "agent_start" in kinds and "agent_end" in kinds
    # The interrupted run closes as failed, carrying the SystemExit — an evicted
    # run did not finish, and that is the thing an operator needs to see.
    end = next(e for e in events if e["type"] == "agent_end")
    assert end["outcome"] == "failed"


def test_a_second_sigterm_during_the_handlers_flush_does_not_deadlock(tmp_path):
    """The shipped SIGTERM recipe, re-entered — which is how it is actually met.

    Signal handlers run on the MAIN thread, interrupting whatever bytecode it was
    executing, so `flush_now()` called from a handler re-enters `_flush` whenever
    the main thread was already inside it. With a plain `threading.Lock` that is a
    permanent self-deadlock: the thread blocks acquiring a lock it already holds,
    and the process cannot be signalled out of it because every further SIGTERM
    re-enters the wedged handler. `docker stop` followed by a second `kill` — a
    supervisor, an impatient operator — reaches it in one step.

    The child sends itself 200 SIGTERMs 1 ms apart while a large queue is
    draining. Before the fix this hung until the outer `timeout` killed it.
    """
    proc = _run_child(
        tmp_path,
        "import threading, time\n"
        "with fp.session('sigterm-reentrant'):\n"
        "    for i in range(4000):\n"
        "        event.tool_use(agent_id='a', tool_name='t', tool_call_id=str(i),\n"
        "                       input={'x': 'y' * 200})\n"
        "entries = []\n"
        "def _handler(signum, frame):\n"
        "    entries.append(1)\n"
        "    fp._writer.flush_now()\n"
        "signal.signal(signal.SIGTERM, _handler)\n"
        "def _bomb():\n"
        "    for _ in range(200):\n"
        "        os.kill(os.getpid(), signal.SIGTERM)\n"
        "        time.sleep(0.001)\n"
        "threading.Thread(target=_bomb, daemon=True).start()\n"
        "time.sleep(3)\n"
        "sys.stdout.write(str(len(entries)))\n",
    )
    assert proc.returncode == 0, proc.stderr
    # The handler ran many times over, and every one of them returned.
    assert int(proc.stdout) > 1, "the handler never re-entered; the test proves nothing"
    assert len(read_all(tmp_path)) == 4000


def test_the_queue_is_bounded_by_bytes_and_not_only_by_a_count(tmp_path):
    """`_QUEUE_CAP` alone is not a memory bound, because it says nothing about size.

    The adapters budget 128 KiB of `fw_*` extras per event, so 10_000 of those is
    ~1.3 GB — an OOM kill of the host agent, which is the one outcome the cap
    exists to prevent. The effective cap has to fall as events get bigger.
    """
    # NOT `from failproofai_sdk import _writer` — `__init__` binds that name to
    # the writer INSTANCE, not the module.
    writer_mod = sys.modules["failproofai_sdk._writer"]

    w = writer_mod.EventWriter()
    try:
        assert w._effective_cap == writer_mod._QUEUE_CAP

        # One batch of large events teaches it what an event costs here.
        w._observe_entry_size(128 * 1024)
        assert w._effective_cap < writer_mod._QUEUE_CAP
        assert w._effective_cap * w._avg_entry_bytes <= writer_mod._QUEUE_BYTE_CAP

        # Small events must not shrink it below the count cap.
        for _ in range(50):
            w._observe_entry_size(200)
        assert w._effective_cap == writer_mod._QUEUE_CAP
    finally:
        writer_mod._live_writers[:] = [
            ref for ref in writer_mod._live_writers if ref() is not w
        ]
