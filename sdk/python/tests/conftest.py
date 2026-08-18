"""Nothing in this suite may write to the developer's real event spool.

This is not hypothetical. Two tests here build an `EventWriter` with a long
flush interval to inspect its queue, and never flush it — which is the point of
those tests. But every writer registers itself in `_writer._live_writers`, and
`_flush_all_at_exit` flushes ALL of them at interpreter exit. That runs long
after pytest has torn down its fixtures, so whatever redirection a test applied
is already undone and `get_base_dir()` resolves to the real `~/.agenteye`
again. One run of the queue-cap tests deposited over 160,000 synthetic events
into a live spool, where the collector would have shipped them to a real
dashboard as though an agent had emitted them.

A per-test fixture cannot fix that, because the write happens after the last
fixture has gone. So the redirection is applied HERE, at import, straight into
`os.environ` rather than through `monkeypatch` — pytest undoes monkeypatch at
session end, and session end is still earlier than the flush.

`setdefault` rather than assignment, so a developer who exports `AGENTEYE_HOME`
to point at a scratch spool of their own keeps it.

`test_resolver_umbrella.py` deletes this variable per test through monkeypatch,
so the resolution rules themselves are still tested against a clean environment.
"""
import atexit
import os
import shutil
import tempfile

_SANDBOX = tempfile.mkdtemp(prefix="failproofai-sdk-tests-")
os.environ.setdefault("AGENTEYE_HOME", _SANDBOX)

# Registered before `failproofai_sdk._writer` is imported, so it lands EARLIER in
# atexit's LIFO order and therefore runs LAST — after the final flush has written
# into the sandbox we are about to remove.
atexit.register(shutil.rmtree, _SANDBOX, True)
