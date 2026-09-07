"""Subprocess entry point for the managed-source sandbox.

Invoked as ``python -m failproofai_sdk.evaluator._sandbox_runner <input-file>`` by
``source._run_sandboxed``. The input file holds a pickled
``(kind, source, session_wire, cpu_seconds, mem_bytes, eval_key)`` tuple. This
process installs hard ``RLIMIT_CPU`` + ``RLIMIT_AS`` limits ON ITSELF, evaluates
the re-validated server-authored source against the reconstructed transcript,
validates + bounds the result, and writes a pickled ``("ok", result)`` /
``("err", type_name, message)`` outcome to stdout.

This is a FRESH exec'd process — never a fork of the multi-threaded worker — so
there is no inherited-lock deadlock (forking a process that has an asyncio loop,
an executor pool and a writer daemon hangs the child). The parent enforces the
wall-clock bound and the output-size bound by reading only so far and killing
this process on timeout or overflow.
"""

from __future__ import annotations

import pickle
import sys


def _main() -> int:
    with open(sys.argv[1], "rb") as handle:
        kind, source, session_wire, cpu_seconds, mem_bytes, eval_key = pickle.loads(
            handle.read()
        )
    # Imported here, in the child, so the import cost is never on the worker's path.
    from failproofai_sdk.evaluator.protocol import SessionTranscript
    from failproofai_sdk.evaluator.source import (
        SANDBOX_MAX_RESULT_BYTES,
        _install_limits,
        _raw_eval,
    )

    try:
        session = SessionTranscript.from_wire(session_wire)
        # Compile + re-validate BEFORE the limits so validation cost is not charged
        # against the eval's CPU budget; the limits bind the eval itself.
        run = _raw_eval(source, kind)
        _install_limits(cpu_seconds, mem_bytes)
        result = run(session)
        # Bound the result INSIDE the sandbox before it crosses back: result_items
        # enforces the 25-result limit + field validation, so a huge result
        # (`metrics={str(x):1 for x in range(100000)}`) raises here instead of
        # being serialized and shipped to the parent.
        if kind == "evaluator":
            result.result_items(eval_key or "result")
        payload = pickle.dumps(("ok", result))
        if len(payload) > SANDBOX_MAX_RESULT_BYTES:
            payload = pickle.dumps(
                ("err", "ResultTooLarge", "evaluation result exceeds the size limit")
            )
    except BaseException as error:  # noqa: BLE001 - relay type+msg, this process is the boundary
        payload = pickle.dumps(("err", type(error).__name__, str(error)[:500]))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
