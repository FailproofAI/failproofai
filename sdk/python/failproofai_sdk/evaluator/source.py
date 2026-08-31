"""Restricted deterministic expression compiler for server-authored evaluations.

The managed worker never executes a module, statements, imports, or ambient
builtins from tenant-authored source. Definitions are single Python expressions
evaluated with a small constructor/helper surface and the immutable transcript
bound as ``session``.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import os
import pickle
import re
import select
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from typing import Any

try:
    import resource as _resource
except ImportError:  # pragma: no cover - non-POSIX
    _resource = None  # type: ignore[assignment]

from failproofai_sdk.evaluator.authoring import (
    Assertion,
    ConditionResult,
    EvalResult,
    Metric,
    Score,
)

MAX_CONDITION_SOURCE_BYTES = 16 * 1024
MAX_EVALUATOR_SOURCE_BYTES = 128 * 1024

# Static defense-in-depth bounds applied at COMPILE time (see `_compile`). They
# reject the obvious authoring bombs early; they are NOT the primary defense —
# a runtime-computed size (`range(len(session.events) ** 40)`) slips past any
# static check, which is exactly why the fork sandbox below is the real bound.
MAX_AST_NODES = 5_000
MAX_POW_EXPONENT = 64

# Hard ceilings for ONE sandboxed evaluation, enforced by the kernel in a
# fork+exec'd subprocess (see `_run_sandboxed`). RLIMIT_CPU + the parent's
# wall-clock kill both bound compute bombs; RLIMIT_AS is the memory backstop for a
# giant-int / huge-allocation bomb.
DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30
# The effective budget is CLAMPED to this ceiling regardless of the (server-set)
# per-definition timeout, so a large `timeout_seconds` can never remove the
# execution bound (SEC-001). Wall-clock and CPU are both capped here.
MAX_SANDBOX_TIMEOUT_SECONDS = 60
# Per-sandbox address-space cap. A managed eval works over a transcript (<=25 MiB)
# and returns a small result, so this is generous; it also rejects an allocation
# bomb (`[0] * 200000000` is ~1.6 GiB > this) before it returns a valid result.
SANDBOX_MEMORY_BYTES = 512 * 1024 * 1024  # 512 MiB
# ...but a per-process cap alone does not bound the HOST: a worker with
# max_concurrency=32 could run 32 sandboxes at once. Cap the number of concurrent
# sandbox processes so the AGGREGATE (MAX_CONCURRENT_SANDBOXES * SANDBOX_MEMORY_BYTES,
# ~2 GiB) is bounded independent of the worker's claim concurrency; extra evals
# queue on the semaphore rather than pile up memory.
MAX_CONCURRENT_SANDBOXES = 4
_SANDBOX_SLOTS = threading.Semaphore(MAX_CONCURRENT_SANDBOXES)
# The result crossing back is bounded on BOTH sides: the child refuses to serialize
# a result larger than this, and the parent stops reading (and kills the child)
# past it — so a permitted expression that builds a huge result
# (`EvalResult(metrics={str(x): 1 for x in range(100000)})`) cannot OOM the worker
# even though the child's RLIMIT_AS lets it construct one. A valid result (<=25
# items, bounded fields) is far under this.
SANDBOX_MAX_RESULT_BYTES = 1 * 1024 * 1024  # 1 MiB


def _clamp_budget(timeout_seconds: float | None) -> float:
    """The wall-clock/CPU budget for one evaluation: a positive value no larger
    than MAX_SANDBOX_TIMEOUT_SECONDS. Server-provided timeouts cannot exceed it."""
    requested = float(timeout_seconds or DEFAULT_SANDBOX_TIMEOUT_SECONDS)
    if requested <= 0:
        requested = DEFAULT_SANDBOX_TIMEOUT_SECONDS
    return min(requested, float(MAX_SANDBOX_TIMEOUT_SECONDS))


class EvaluationTimeout(Exception):
    """A sandboxed evaluation exceeded its CPU/memory/wall-clock budget.

    Distinct from an eval that *returned* an error: the computation was forcibly
    terminated because it could not be allowed to keep running.
    """


class EvaluationSandboxUnavailable(Exception):
    """The killable-process sandbox could not be established.

    Raised instead of running server-authored source unsandboxed — if the sandbox
    subprocess cannot be started, or the transcript cannot be serialized into it,
    there is no way to bound or terminate the evaluation, so we fail closed
    (SEC-001).
    """


def _install_limits(cpu_seconds: float, mem_bytes: int) -> None:
    """Install hard CPU + address-space limits on the CURRENT process.

    Called by the sandbox subprocess on itself, right before it evaluates.
    """
    if _resource is None:  # pragma: no cover - non-POSIX
        return
    cpu = max(1, int(cpu_seconds))
    _resource.setrlimit(_resource.RLIMIT_CPU, (cpu, cpu))
    _resource.setrlimit(_resource.RLIMIT_AS, (mem_bytes, mem_bytes))


def _run_sandboxed(
    kind: str,
    source: str,
    session: Any,
    *,
    wall_timeout: float,
    cpu_seconds: float,
    mem_bytes: int,
    eval_key: str | None = None,
) -> Any:
    """Evaluate server-authored ``source`` against ``session`` in a fork+exec'd
    subprocess that CANNOT outlive its budget or flood this process.

    A FRESH ``python -m ..._sandbox_runner`` process — never a fork of this
    multi-threaded worker (forking one deadlocks the child on a lock some other
    thread holds) — reads its input from a temp file, installs hard RLIMIT_CPU +
    RLIMIT_AS on itself, evaluates, and writes a bounded result to stdout. This
    parent reads stdout up to ``SANDBOX_MAX_RESULT_BYTES`` and no further, killing
    the child on timeout OR oversize — so neither compute (``sum(range(10**20))``)
    nor an oversized result (``metrics={str(x):1 for x in range(100000)}``) can
    exhaust the worker.
    """
    try:
        session_wire = session.to_wire()
    except AttributeError as error:
        raise EvaluationSandboxUnavailable(
            "sandboxed evaluation requires a serializable transcript"
        ) from error
    payload = pickle.dumps(
        (kind, source, session_wire, cpu_seconds, mem_bytes, eval_key)
    )
    # Input via a temp file, not stdin: the transcript can be large (up to the
    # transcript ceiling) and feeding a big stdin while bounding stdout invites a
    # pipe deadlock. The child reads the file; we only read its stdout.
    handle, path = tempfile.mkstemp(prefix="fpai-sandbox-", suffix=".pkl")
    try:
        with os.fdopen(handle, "wb") as tmp:
            tmp.write(payload)
        chunks: list[bytes] = []
        total = 0
        timed_out = False
        too_large = False
        # A slot is held for the whole subprocess lifetime so no more than
        # MAX_CONCURRENT_SANDBOXES run at once — bounding aggregate memory across
        # concurrent sandboxes. But acquiring it must COUNT AGAINST the wall-clock
        # budget: the runtime runs this in a thread and `asyncio.wait_for` only
        # cancels the awaiter, so a thread that blocked here UNBOUNDED past its
        # deadline would still go on to launch a sandbox after its run was already
        # reported timed out — 28 such threads could queue behind 4 long sandboxes
        # and starve the worker (conditions have no runtime-level wait at all). One
        # deadline therefore covers BOTH the slot wait and execution: we acquire the
        # slot with the remaining budget and, on failure, time out WITHOUT spawning.
        deadline = time.monotonic() + wall_timeout
        acquire_timeout = deadline - time.monotonic()
        if acquire_timeout <= 0 or not _SANDBOX_SLOTS.acquire(timeout=acquire_timeout):
            raise EvaluationTimeout("evaluation timed out waiting for a sandbox slot")
        try:
            if deadline - time.monotonic() <= 0:
                # Slot acquired exactly at the deadline: a child launched now could
                # only be killed immediately, so do not spawn one at all.
                raise EvaluationTimeout("evaluation timed out waiting for a sandbox slot")
            try:
                proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                    [sys.executable, "-m", "failproofai_sdk.evaluator._sandbox_runner", path],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as error:
                raise EvaluationSandboxUnavailable(
                    f"could not start the evaluation sandbox: {error}"
                ) from error
            out_fd = proc.stdout.fileno()
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        break
                    ready, _, _ = select.select([out_fd], [], [], remaining)
                    if not ready:
                        timed_out = True
                        break
                    chunk = os.read(out_fd, 65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > SANDBOX_MAX_RESULT_BYTES:
                        too_large = True
                        break
                    chunks.append(chunk)
            finally:
                proc.stdout.close()
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
        finally:
            _SANDBOX_SLOTS.release()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    if timed_out:
        raise EvaluationTimeout("evaluation exceeded its wall-clock budget")
    if too_large:
        raise EvaluationTimeout("evaluation result exceeded the size limit")
    data = b"".join(chunks)
    if not data:
        # Killed by RLIMIT_CPU/RLIMIT_AS (or otherwise died) before it could write.
        raise EvaluationTimeout("evaluation was terminated before producing a result")
    outcome = pickle.loads(data)
    if outcome[0] == "ok":
        return outcome[1]
    # Preserve the child's original exception SEMANTICS: an eval's
    # NameError/TypeError/ZeroDivisionError/... and the sandbox's own
    # UnsafeEvaluatorSource must read the same as they did in-process. Reconstruct
    # any builtin exception by name; anything else collapses to a generic error —
    # still caught as a failed run upstream.
    _, name, message = outcome
    if name == UnsafeEvaluatorSource.__name__:
        raise UnsafeEvaluatorSource(message)
    builtin = getattr(builtins, name, None)
    if isinstance(builtin, type) and issubclass(builtin, BaseException):
        raise builtin(message)
    raise RuntimeError(f"{name}: {message}")

_ALLOWED_NODES = (
    ast.Expression,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.IfExp,
    ast.Dict,
    ast.Set,
    ast.List,
    ast.Tuple,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    # `ast.GeneratorExp` is intentionally NOT allowed: a bare generator object's
    # default repr is `<generator object ... at 0x...>`, which leaks a live host
    # heap address (an ASLR/memory-layout disclosure) the moment it is coerced to
    # a string into any result field. List/set/dict comprehensions render as their
    # data (`[...]`, `{...}`) and cover the same ground — wrap a generator in `[]`.
    ast.comprehension,
    ast.Compare,
    ast.Call,
    ast.FormattedValue,
    ast.JoinedStr,
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.Store,
    ast.Attribute,
    ast.Subscript,
    ast.Slice,
    ast.keyword,
    ast.And,
    ast.Or,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
    ast.Is,
    ast.IsNot,
)

_SAFE_GLOBALS = {
    "__builtins__": {},
    "Assertion": Assertion,
    "ConditionResult": ConditionResult,
    "EvalResult": EvalResult,
    "Metric": Metric,
    "Score": Score,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    # `enumerate` is intentionally excluded: an enumerate object's default repr is
    # `<enumerate object at 0x...>`, leaking a live host heap address into any
    # result field. Index-aware iteration can use `range(len(...))` instead.
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
}


# Attribute access is DEFAULT-DENY. A denylist is unwinnable here: dunder access
# is only one door. `str.format`/`format_map` traverse a format string's fields
# at the C level; `(x for x in [1]).gi_frame.f_globals` reaches the eval globals
# through generator/frame introspection; `str.mro()[-1]` reaches the `object`
# type — and NONE of `format`, `gi_frame`, `f_globals`, `co_names`, `mro`, ...
# start with an underscore, so the dunder guard never sees them. Rather than
# chase each introspection family, we allow ONLY the attribute names a real
# session evaluation needs: the transcript/event data surface plus a fixed set
# of pure string/collection data methods. Anything else — every current and
# future introspection attribute — is rejected. `format`/`format_map` are simply
# absent from this set, so the C-level format escape is closed too.
# Data attributes on the transcript surface — safe to READ as a value: each is a
# field of a frozen dataclass (SessionTranscript / TranscriptEvent, whose reprs are
# field-based and pointer-free) or a JSON scalar/container from an event payload.
_DATA_ATTRS = frozenset(
    {
        # SessionTranscript + TranscriptEvent data surface (see protocol.py).
        "events",
        "event_count",
        "event_type",
        "payload",
        "id",
        "ts",
        "agent_id",
        "environment",
        "session_id",
        "session_revision_id",
        "assignment_id",
        "started_at",
        "ended_at",
        "schema_version",
    }
)

# Method attributes — pure data methods that must be CALLED, never referenced as a
# bare value. A bound method's repr is `<... at 0x...>`, a live heap address; a bare
# reference (`payload.get` uncalled) is only ever useful for smuggling that address
# into a result field via `str()`, an f-string, or `%`-formatting — none of which a
# real evaluation needs. `_compile` requires each of these names to appear at a call
# site, which closes every text-coercion leak at its source: no reachable value can
# then carry a pointer repr, so the output-boundary scan is only defense in depth.
_METHOD_ATTRS = frozenset(
    {
        # SessionTranscript methods.
        "events_of_type",
        "count",
        # dict data methods.
        "get",
        "keys",
        "values",
        "items",
        # str / bytes pure data methods.
        "lower",
        "upper",
        "strip",
        "lstrip",
        "rstrip",
        "split",
        "rsplit",
        "splitlines",
        "startswith",
        "endswith",
        "replace",
        "find",
        "rfind",
        "index",
        "join",
        "title",
        "capitalize",
        "casefold",
        "swapcase",
        "isdigit",
        "isalpha",
        "isalnum",
        "isspace",
        "isnumeric",
        "isdecimal",
        "islower",
        "isupper",
        "istitle",
        "zfill",
        "ljust",
        "rjust",
        "center",
        "partition",
        "rpartition",
        "removeprefix",
        "removesuffix",
        "encode",
        "decode",
        "hex",
        # set data methods.
        "union",
        "intersection",
        "difference",
        "symmetric_difference",
        "issubset",
        "issuperset",
        "isdisjoint",
    }
)

# The walk rejects any attribute outside this union, and additionally requires every
# name in `_METHOD_ATTRS` to appear only as the function of a call.
_ALLOWED_ATTRS = _DATA_ATTRS | _METHOD_ATTRS


def _fresh_globals() -> dict[str, Any]:
    """A throwaway globals mapping for one eval call.

    Every evaluation gets its own copy — with a fresh empty ``__builtins__`` —
    so that even if a future reach exposes the eval's globals (e.g. through a
    frame object), a mutation cannot persist into another evaluation and poison
    a shared, process-wide namespace.
    """
    return {**_SAFE_GLOBALS, "__builtins__": {}}


class UnsafeEvaluatorSource(ValueError):
    """Raised before any disallowed server-authored source can execute."""


def source_checksum(condition_source: str | None, evaluator_source: str) -> str:
    payload = (condition_source or "").encode("utf-8") + b"\0" + evaluator_source.encode(
        "utf-8"
    )
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _compile(source: str, *, field_name: str, maximum: int) -> Any:
    if not isinstance(source, str) or not source.strip():
        raise UnsafeEvaluatorSource(f"{field_name} must not be empty")
    if len(source.encode("utf-8")) > maximum:
        raise UnsafeEvaluatorSource(f"{field_name} exceeds {maximum} bytes")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as error:
        raise UnsafeEvaluatorSource(f"{field_name} must be one expression") from error
    # An Attribute that is the function of a Call is a method invocation; any other
    # Attribute naming a method (`_METHOD_ATTRS`) is a bare bound-method reference,
    # whose only use is leaking the method's `<... at 0xADDR>` repr into a result.
    called_method_nodes = {
        node.func
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    node_count = 0
    for node in ast.walk(tree):
        node_count += 1
        if node_count > MAX_AST_NODES:
            raise UnsafeEvaluatorSource(
                f"{field_name} is too large ({MAX_AST_NODES}-node ceiling)"
            )
        if not isinstance(node, _ALLOWED_NODES):
            raise UnsafeEvaluatorSource(
                f"{field_name} contains disallowed syntax: {type(node).__name__}"
            )
        # Defense in depth: a literal `10 ** 20` (or worse, `2 ** (10**8)`) builds a
        # giant int — a memory bomb — at compile-time-visible size. Require Pow's
        # exponent to be a small non-negative integer constant. Runtime-sized bombs
        # still exist and are caught by the fork sandbox, not here.
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            exponent = node.right
            if not (
                isinstance(exponent, ast.Constant)
                and isinstance(exponent.value, int)
                and not isinstance(exponent.value, bool)
                and 0 <= exponent.value <= MAX_POW_EXPONENT
            ):
                raise UnsafeEvaluatorSource(
                    f"{field_name} exponent must be an integer constant "
                    f"in 0..{MAX_POW_EXPONENT}"
                )
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                raise UnsafeEvaluatorSource(
                    f"{field_name} may not access private or dunder attributes"
                )
            if node.attr not in _ALLOWED_ATTRS:
                raise UnsafeEvaluatorSource(
                    f"{field_name} may not access attribute '{node.attr}'"
                )
            if node.attr in _METHOD_ATTRS and node not in called_method_nodes:
                raise UnsafeEvaluatorSource(
                    f"{field_name} may reference method '{node.attr}' only to call it; "
                    "a bare bound method leaks a heap address when stringified"
                )
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise UnsafeEvaluatorSource(f"{field_name} may not access private names")
    return compile(tree, f"<{field_name}>", "eval", dont_inherit=True, optimize=2)


# CPython's default object repr — `<... at 0x7f...>` — embeds a live heap address
# (an ASLR/memory-layout disclosure). The PRIMARY defense is at compile time: a bound
# method (the only reachable object with such a repr — the result and transcript types
# are all frozen, pointer-free dataclasses) can no longer be referenced as a value
# (`_METHOD_ATTRS` must be called), so no reachable value carries a pointer repr to
# begin with. This output-boundary scan is DEFENSE IN DEPTH. It matches the "... at
# 0xADDR" tail every default repr shares, plus a bare `0x`+hex run — deliberately
# WITHOUT the leading `<`, so reshaping the wrapper (e.g. `str(x).replace("<","")`,
# the way the compile-time hole was originally bypassed) cannot strip the match.
_OBJECT_REPR = re.compile(r" at 0x[0-9a-fA-F]+|0x[0-9a-fA-F]{6,}")


def _forbid_object_reprs(field_name: str, value: Any) -> Any:
    if _OBJECT_REPR.search(repr(value)):
        raise UnsafeEvaluatorSource(
            f"{field_name} result may not embed a runtime object repr"
        )
    return value


def _raw_eval(source: str, kind: str) -> Callable[[Any], Any]:
    """Compile server-authored source and return a function that evaluates it and
    validates the result.

    Runs INSIDE the sandbox subprocess (see `_sandbox_runner`) — there is no
    isolation here. `compile_condition`/`compile_evaluator` have already validated
    the AST in the parent; this recompiles as defense in depth so a subprocess
    can never eval source the parent has not vetted.
    """
    if kind == "condition":
        code = _compile(
            source, field_name="condition_source", maximum=MAX_CONDITION_SOURCE_BYTES
        )

        def run(session: Any) -> Any:
            value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
            if not isinstance(value, (bool, ConditionResult)):
                raise TypeError("condition_source must return bool or ConditionResult")
            return _forbid_object_reprs("condition_source", value)

    else:
        code = _compile(
            source, field_name="evaluator_source", maximum=MAX_EVALUATOR_SOURCE_BYTES
        )

        def run(session: Any) -> Any:
            value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
            if not isinstance(value, EvalResult):
                raise TypeError("evaluator_source must return EvalResult")
            return _forbid_object_reprs("evaluator_source", value)

    return run


def compile_condition(
    source: str,
    *,
    timeout_seconds: float | None = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
) -> Callable[[Any], bool | ConditionResult]:
    # Validate the AST in THIS (parent) process so unsafe/malformed source is
    # rejected up front, before any subprocess is spawned.
    _compile(source, field_name="condition_source", maximum=MAX_CONDITION_SOURCE_BYTES)
    budget = _clamp_budget(timeout_seconds)

    def condition(session: Any) -> bool | ConditionResult:
        # Managed conditions are sandboxed like evaluators — `sum(range(10**10)) > 0`
        # in a condition would otherwise block the worker with NO timeout at all.
        return _run_sandboxed(
            "condition",
            source,
            session,
            wall_timeout=budget,
            cpu_seconds=budget,
            mem_bytes=SANDBOX_MEMORY_BYTES,
        )

    return condition


def compile_evaluator(
    source: str,
    *,
    timeout_seconds: float | None = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    eval_key: str | None = None,
) -> Callable[[Any], EvalResult]:
    _compile(source, field_name="evaluator_source", maximum=MAX_EVALUATOR_SOURCE_BYTES)
    budget = _clamp_budget(timeout_seconds)

    def evaluate(session: Any) -> EvalResult:
        # The kernel-enforced boundary: this runs in a fork+exec'd subprocess with
        # hard CPU/memory/wall-clock limits and a bounded result, killed if it
        # exceeds them, so a server-authored compute or result bomb cannot exhaust
        # the worker (SEC-001). `eval_key` lets the child validate the result's
        # 25-item limit before it crosses back.
        return _run_sandboxed(
            "evaluator",
            source,
            session,
            wall_timeout=budget,
            cpu_seconds=budget,
            mem_bytes=SANDBOX_MEMORY_BYTES,
            eval_key=eval_key,
        )

    return evaluate
