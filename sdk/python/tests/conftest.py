"""Suite-wide isolation.

This SDK is built on module-level singletons, so state leaks between tests in
four ways, and every one of them has bitten this package.

1. **At interpreter exit.** Two tests build an `EventWriter` with a long flush
   interval to inspect its queue and never flush it — the point of those tests.
   But every writer registers in `_writer._live_writers`, and
   `_flush_all_at_exit` flushes ALL of them when the process ends, long after
   pytest has torn its fixtures down. Whatever redirection a test applied is
   already undone by then, so `get_base_dir()` resolves to the real spool again.
   One run of the queue-cap tests deposited over 160,000 synthetic events into a
   live spool, where a configured collector would have shipped them to a real
   dashboard as though an agent had emitted them.

   A fixture cannot fix that, because the write happens after the last fixture
   is gone. So the redirection is applied at IMPORT, straight into `os.environ`
   rather than through `monkeypatch` — pytest undoes monkeypatch at session end,
   and session end is still earlier than the flush.

2. **`_resolver._base_dir` during a test.** Same destination, different clock.
   Every test gets `tmp_path` whether it asked for one or not.

3. **`_environment` and the writer's flush interval.** `configure()` mutates
   process-global state and nothing puts it back.

4. **The identity contextvars.** A leaked `session_id` in production means
   events attributed to the wrong run, accepted at HTTP 200 — the exact silent
   failure that layer exists to prevent. So the leak is asserted and the leaking
   test *fails*. It is repaired afterwards only so the failure stays readable as
   one test rather than cascading through the rest of the run.

5. **The process-wide writer's own background thread.** `_runtime.writer` starts
   at import on a 0.5-second interval, and the spool path is resolved when a
   batch is WRITTEN, not when the event is submitted. So an event queued by one
   test is written wherever `FAILPROOFAI_HOME` points up to half a second later
   — which is a different test's directory, and the events land there with no
   error on either side. It reached CI as a one-leg-in-five failure of
   `test_repeated_flushes_do_not_recreate_or_churn_the_directories`, which
   counts the batch files in its own spool and found seven where it wrote six.

   Fixed by quiescing that thread for the whole session: nothing in this suite
   depends on it firing (every test that asserts on disk builds its own
   `EventWriter` and calls `flush_now()`), and whatever accumulates is written
   by the exit-time flush into the sandbox from (1), which is then removed.

`test_sdk.py` has its own in-file autouse `_reset_environment`; these are
additive and idempotent with it.
"""
import atexit
import os
import shutil
import tempfile

import pytest

# ── (1) survives to interpreter exit ─────────────────────────────────────────
#
# `FAILPROOFAI_HOME`, not `AGENTEYE_HOME`: the latter no longer resolves the
# spool at all (see `_resolver.get_base_dir`), so setting it here would isolate
# nothing and the exit-time flush described above would land in the developer's
# REAL `~/.failproofai/custom-agents`.
#
# `setdefault`, so a developer who exports `FAILPROOFAI_HOME` to point at a
# scratch home of their own keeps it. `test_resolver_umbrella.py` deletes this
# variable per test through monkeypatch, so the resolution rules themselves are
# still tested against a clean environment.
#
# Deliberately NOT deleted by the per-test fixture below: that fixture pins the
# spool with `set_base_dir(tmp_path)`, but a test which calls
# `set_base_dir(None)` mid-run would then fall through to the real home. Keeping
# this set at all times means the floor under every test is still the sandbox.
_SANDBOX = tempfile.mkdtemp(prefix="failproofai-sdk-tests-")
os.environ.setdefault("FAILPROOFAI_HOME", _SANDBOX)

# Registered before `failproofai_sdk._writer` is imported, so it lands EARLIER in
# atexit's LIFO order and therefore runs LAST — after the final flush has written
# into the sandbox we are about to remove.
atexit.register(shutil.rmtree, _SANDBOX, True)

import failproofai_sdk._environment as _environment  # noqa: E402
import failproofai_sdk._resolver as _resolver  # noqa: E402
from failproofai_sdk import _context, _runtime  # noqa: E402
from failproofai_sdk._events import EventNamespace  # noqa: E402


#: Long enough that the background loop cannot wake during any plausible run,
#: finite because `_validated_interval` rejects `inf` (it would raise
#: OverflowError inside `Event.wait` and kill the thread outright).
_QUIET_INTERVAL = 86_400.0


class RecordingWriter:
    """A writer that keeps entries in memory. No disk, no flush timing."""

    def __init__(self) -> None:
        self.entries: list[dict] = []

    def submit(self, entry: dict) -> None:
        self.entries.append(entry)

    def last(self) -> dict:
        return self.entries[-1]

    def types(self) -> list[str]:
        return [e["type"] for e in self.entries]


@pytest.fixture(autouse=True, scope="session")
def _quiesce_the_process_wide_writer():
    """(5): stop `_runtime.writer`'s thread flushing into whichever test is running.

    `set_flush_interval`, not a bare attribute write: the loop is already blocked
    in `_wake.wait(0.5)` and would flush once more on the old interval before
    seeing a new value. `set_flush_interval` sets `_wake`, so the loop re-waits on
    the new interval immediately. Done ONCE at session start, when nothing has
    been submitted yet, so the wake it induces drains an empty queue.

    Not restored afterwards. The only thing left to run is the exit-time flush,
    and it is better served by an interval that cannot fire underneath it.
    """
    _runtime.writer.set_flush_interval(_QUIET_INTERVAL)


@pytest.fixture(autouse=True)
def _sdk_global_state(tmp_path, monkeypatch):
    """(2) and (3): a private spool per test, and process globals restored."""
    monkeypatch.delenv("AGENTEYE_ENVIRONMENT", raising=False)

    base_dir = _resolver._base_dir
    environment = _environment._environment
    flush_interval = _runtime.writer._flush_interval

    _resolver.set_base_dir(tmp_path)
    try:
        yield
    finally:
        _resolver.set_base_dir(base_dir)
        _environment._environment = environment
        _runtime.writer._flush_interval = flush_interval


@pytest.fixture(autouse=True)
def _no_context_leak():
    """(4): an unbalanced scope fails the test that left it open."""
    yield
    session_id, stack = _context.snapshot()
    if session_id is not None or stack:
        # Repair before failing: without this every subsequent test in the run
        # also fails and the real culprit is impossible to spot.
        _context.restore((None, ()))
        pytest.fail(
            "failproofai_sdk identity contextvars leaked out of this test: "
            f"session_id={session_id!r}, agent_stack={stack!r}. "
            "A scope was entered without being exited."
        )


@pytest.fixture()
def events(monkeypatch):
    """Swap the process-wide namespace for a recording one.

    `_scopes` resolves `_runtime.event` at call time precisely so this works.
    Tests must not emit through the real writer: `test_sdk.py` asserts on the
    exact contents of the events directory.
    """
    writer = RecordingWriter()
    monkeypatch.setattr(_runtime, "event", EventNamespace(writer))
    return writer
