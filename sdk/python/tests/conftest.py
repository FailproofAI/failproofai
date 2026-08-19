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
   live `~/.agenteye`, where a configured collector would have shipped them to a
   real dashboard as though an agent had emitted them.

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
# `setdefault`, so a developer who exports `AGENTEYE_HOME` to point at a scratch
# spool of their own keeps it. `test_resolver_umbrella.py` deletes this variable
# per test through monkeypatch, so the resolution rules themselves are still
# tested against a clean environment.
_SANDBOX = tempfile.mkdtemp(prefix="failproofai-sdk-tests-")
os.environ.setdefault("AGENTEYE_HOME", _SANDBOX)

# Registered before `failproofai_sdk._writer` is imported, so it lands EARLIER in
# atexit's LIFO order and therefore runs LAST — after the final flush has written
# into the sandbox we are about to remove.
atexit.register(shutil.rmtree, _SANDBOX, True)

import failproofai_sdk._environment as _environment  # noqa: E402
import failproofai_sdk._resolver as _resolver  # noqa: E402
from failproofai_sdk import _context, _runtime  # noqa: E402
from failproofai_sdk._events import EventNamespace  # noqa: E402


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


@pytest.fixture(autouse=True)
def _sdk_global_state(tmp_path, monkeypatch):
    """(2) and (3): a private spool per test, and process globals restored."""
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
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
