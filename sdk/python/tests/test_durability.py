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
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from failproofai_sdk import _resolver
from failproofai_sdk._events import _PENDING_CAP, EventNamespace
from failproofai_sdk._writer import EventWriter


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


def test_two_batches_in_the_same_millisecond_do_not_overwrite_each_other(spool):
    """Regression: the timestamp-only stem lost whichever batch wrote first."""
    writer = EventWriter(flush_interval=3600)
    writer._write_batch([{"id": "first"}])
    writer._write_batch([{"id": "second"}])

    recovered = {e["id"] for e in read_all(spool)}
    assert recovered == {"first", "second"}


# The DeprecationWarning about fork() in a multi-threaded process is the
# hazard under test, not a problem with the test.
@pytest.mark.filterwarnings("ignore:.*fork.*:DeprecationWarning")
def test_batch_filenames_are_unique_across_processes(spool):
    """Several agents share one spool root. Their batches must not collide.

    Nothing in a timestamp-only stem identified the writer, so two processes
    flushing in the same millisecond overwrote each other — and because each one
    saw its own `os.replace` succeed, both would report having written.
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
    assert "c0" not in namespace._pending, "eviction is not FIFO"
    assert f"c{_PENDING_CAP + 99}" in namespace._pending


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


def test_tool_and_hook_ids_share_one_flat_namespace():
    """Pinned as-is, deliberately, because it is a trap rather than a design.

    `tool_use` keys `_pending` on the bare `tool_call_id` and `hook_triggered`
    on the bare `hook_id`, while the human and pause pairs use composite keys.
    So a tool call and a hook that happen to share an id cross-correlate, and
    the resulting `duration_ms` is measured between two unrelated events — a
    plausible number, silently wrong.

    This asserts the current behaviour so that anyone changing `_pending` sees
    the collision spelled out. Namespacing these two the way the others already
    are would be a wire-visible change to `duration_ms` values, so it belongs in
    its own deliberate change, not a drive-by.
    """
    writer = _NullWriter()
    namespace = EventNamespace(writer)

    namespace.tool_use(session_id="s", agent_id="a", tool_name="t", tool_call_id="shared")
    writer.entries.clear()
    namespace.hook_completed(session_id="s", agent_id="a", hook_name="h", hook_id="shared")

    assert "duration_ms" in writer.entries[0], (
        "tool and hook ids no longer share a namespace. That is an improvement — "
        "update this test, and note that recorded durations change for anyone "
        "who was relying on the collision."
    )
    # And the tool's own entry is gone, so its real result gets no duration.
    writer.entries.clear()
    namespace.tool_result(session_id="s", agent_id="a", tool_name="t", tool_call_id="shared")
    assert "duration_ms" not in writer.entries[0]


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


def test_configure_is_safe_to_call_from_several_threads(spool):
    """Racing configure() calls must not corrupt state or lose queued events."""
    import failproofai_sdk

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
