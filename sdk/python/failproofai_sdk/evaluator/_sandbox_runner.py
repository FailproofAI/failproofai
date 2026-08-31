"""Subprocess entry point for the managed-source sandbox.

Invoked as ``python -m failproofai_sdk.evaluator._sandbox_runner`` by
``source._run_sandboxed``. Reads a pickled
``(kind, source, session_wire, cpu_seconds, mem_bytes)`` tuple from stdin,
installs hard ``RLIMIT_CPU`` + ``RLIMIT_AS`` limits ON ITSELF, evaluates the
re-validated server-authored source against the reconstructed transcript, and
writes a pickled ``("ok", result)`` / ``("err", type_name, message)`` outcome to
stdout.

This is a FRESH exec'd process — never a fork of the multi-threaded worker — so
there is no inherited-lock deadlock (forking a process that has an asyncio loop,
an executor pool and a writer daemon hangs the child). The parent enforces the
wall-clock bound by killing this process on timeout.
"""

from __future__ import annotations

import pickle
import sys


def _main() -> int:
    kind, source, session_wire, cpu_seconds, mem_bytes = pickle.loads(
        sys.stdin.buffer.read()
    )
    # Imported here, in the child, so the import cost is never on the worker's path.
    from failproofai_sdk.evaluator.protocol import SessionTranscript
    from failproofai_sdk.evaluator.source import _install_limits, _raw_eval

    try:
        session = SessionTranscript.from_wire(session_wire)
        # Compile + re-validate BEFORE the limits so validation cost is not charged
        # against the eval's CPU budget; the limits bind the eval itself.
        run = _raw_eval(source, kind)
        _install_limits(cpu_seconds, mem_bytes)
        out = pickle.dumps(("ok", run(session)))
    except BaseException as error:  # noqa: BLE001 - relay type+msg, this process is the boundary
        out = pickle.dumps(("err", type(error).__name__, str(error)[:500]))
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
