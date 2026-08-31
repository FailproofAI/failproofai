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
import signal
import time
import warnings
from collections.abc import Callable
from typing import Any

try:
    # Imported at MODULE level, never inside the forked child: acquiring the import
    # lock in a child forked from a multi-threaded process is a classic fork
    # deadlock. Absent on non-POSIX, where `_run_killable` degrades to a direct call.
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

# Hard ceilings for ONE sandboxed evaluation, enforced by the kernel in a forked
# child (see `_run_killable`). CPU-seconds and wall-clock both bound compute
# bombs; RLIMIT_AS is the memory backstop for a giant-int / huge-allocation bomb.
DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30
SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB address space
SANDBOX_MAX_RESULT_BYTES = 4 * 1024 * 1024      # cap the pickled result read back


class EvaluationTimeout(Exception):
    """A sandboxed evaluation exceeded its CPU/memory/wall-clock budget.

    Distinct from an eval that *returned* an error: the computation was forcibly
    terminated because it could not be allowed to keep running.
    """


def _run_killable(
    fn: Callable[[Any], Any],
    session: Any,
    *,
    wall_timeout: float,
    cpu_seconds: float,
    mem_bytes: int,
) -> Any:
    """Run ``fn(session)`` in a forked child that CANNOT outlive its budget.

    The child installs hard ``RLIMIT_CPU`` + ``RLIMIT_AS`` and evaluates; the
    parent waits at most ``wall_timeout`` and ``SIGKILL``s otherwise. This is the
    one thing an in-process thread cannot do: cancelling a Python thread running
    ``sum(range(10**20))`` leaves it burning CPU, but the kernel enforces these
    limits on a separate process and the parent can kill it outright. Only the
    result crosses back, over a pipe, as a small pickle.
    """
    if not hasattr(os, "fork"):
        # Non-POSIX (Windows) has no fork. The managed worker only ships on Linux
        # containers, so this branch never runs in production; it keeps the SDK
        # importable/testable elsewhere by degrading to a direct call.
        return fn(session)

    read_fd, write_fd = os.pipe()
    with warnings.catch_warnings():
        # The child is deliberately fork-safe — it acquires no lock any other
        # thread holds (resource is imported at module level, pickle/os.write take
        # no Python-level lock), then os._exit. Python 3.12's blanket
        # "fork() in a multi-threaded process" DeprecationWarning does not apply.
        warnings.simplefilter("ignore", DeprecationWarning)
        pid = os.fork()
    if pid == 0:  # ---- child ----
        try:
            os.close(read_fd)
            try:
                if _resource is not None:
                    cpu = max(1, int(cpu_seconds))
                    _resource.setrlimit(_resource.RLIMIT_CPU, (cpu, cpu))
                    _resource.setrlimit(_resource.RLIMIT_AS, (mem_bytes, mem_bytes))
            except Exception:  # noqa: BLE001 - if limits can't be set, wall-clock still bounds it
                pass
            try:
                payload = pickle.dumps(("ok", fn(session)))
            except BaseException as error:  # noqa: BLE001 - relay type+msg, never raise across the fork
                payload = pickle.dumps(
                    ("err", type(error).__name__, str(error)[:500])
                )
            while payload:
                written = os.write(write_fd, payload)
                payload = payload[written:]
        finally:
            os._exit(0)  # never run atexit / flush the parent's shared buffers

    # ---- parent ----
    os.close(write_fd)
    chunks: list[bytes] = []
    timed_out = False
    total = 0
    deadline = time.monotonic() + wall_timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([read_fd], [], [], remaining)
            if not ready:
                timed_out = True
                break
            chunk = os.read(read_fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > SANDBOX_MAX_RESULT_BYTES:
                timed_out = True  # runaway output — treat as over-budget
                break
    finally:
        os.close(read_fd)
        if timed_out:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    if timed_out:
        raise EvaluationTimeout("evaluation exceeded its CPU/memory/time budget")
    data = b"".join(chunks)
    if not data:
        # Killed by RLIMIT_CPU/RLIMIT_AS before it could write a result.
        raise EvaluationTimeout("evaluation was terminated before producing a result")
    outcome = pickle.loads(data)
    if outcome[0] == "ok":
        return outcome[1]
    # Re-raise with the child's original exception SEMANTICS preserved: an eval's
    # `NameError`/`TypeError`/`ZeroDivisionError`/… and the sandbox's own
    # `UnsafeEvaluatorSource` must read the same across the fork as they did
    # in-process. Reconstruct any builtin exception by name; anything else
    # collapses to a generic error — still caught as a failed run upstream.
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
_ALLOWED_ATTRS = frozenset(
    {
        # SessionTranscript + TranscriptEvent data surface (see protocol.py).
        "events",
        "events_of_type",
        "count",
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
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise UnsafeEvaluatorSource(f"{field_name} may not access private names")
    return compile(tree, f"<{field_name}>", "eval", dont_inherit=True, optimize=2)


# CPython's default object repr — `<... at 0x7f...>` — embeds a live heap
# address (an ASLR/memory-layout disclosure). An expression cannot be stopped
# from producing such a repr at the source level: it falls out of `str()` on any
# bound method of an allowed object (`str(payload.get)`), and those methods must
# stay reachable. So the disclosure is closed at the OUTPUT boundary instead: a
# result whose text embeds this signature is rejected. The result types are all
# frozen dataclasses with pointer-free reprs, so scanning the value's repr sees
# every user-controlled string field. The pattern is the interpreter's own repr
# grammar, which authored reasoning/summaries never legitimately contain.
_OBJECT_REPR = re.compile(r"<[^<>]* at 0x[0-9a-fA-F]+")


def _forbid_object_reprs(field_name: str, value: Any) -> Any:
    if _OBJECT_REPR.search(repr(value)):
        raise UnsafeEvaluatorSource(
            f"{field_name} result may not embed a runtime object repr"
        )
    return value


def compile_condition(
    source: str,
    *,
    timeout_seconds: float | None = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
) -> Callable[[Any], bool | ConditionResult]:
    code = _compile(
        source,
        field_name="condition_source",
        maximum=MAX_CONDITION_SOURCE_BYTES,
    )
    budget = float(timeout_seconds or DEFAULT_SANDBOX_TIMEOUT_SECONDS)

    def _eval(session: Any) -> bool | ConditionResult:
        value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
        if not isinstance(value, (bool, ConditionResult)):
            raise TypeError("condition_source must return bool or ConditionResult")
        return _forbid_object_reprs("condition_source", value)

    def condition(session: Any) -> bool | ConditionResult:
        # Managed conditions are sandboxed like evaluators — `sum(range(10**10)) > 0`
        # in a condition would otherwise block the worker with NO timeout at all.
        return _run_killable(
            _eval,
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
) -> Callable[[Any], EvalResult]:
    code = _compile(
        source,
        field_name="evaluator_source",
        maximum=MAX_EVALUATOR_SOURCE_BYTES,
    )
    budget = float(timeout_seconds or DEFAULT_SANDBOX_TIMEOUT_SECONDS)

    def _eval(session: Any) -> EvalResult:
        value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
        if not isinstance(value, EvalResult):
            raise TypeError("evaluator_source must return EvalResult")
        return _forbid_object_reprs("evaluator_source", value)

    def evaluate(session: Any) -> EvalResult:
        # The kernel-enforced boundary: this runs in a forked child with hard
        # CPU/memory/wall-clock limits and is killed if it exceeds them, so a
        # server-authored compute bomb cannot exhaust the worker (SEC-001).
        return _run_killable(
            _eval,
            session,
            wall_timeout=budget,
            cpu_seconds=budget,
            mem_bytes=SANDBOX_MEMORY_BYTES,
        )

    return evaluate
