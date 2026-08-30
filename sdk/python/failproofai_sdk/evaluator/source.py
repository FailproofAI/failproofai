"""Restricted deterministic expression compiler for server-authored evaluations.

The managed worker never executes a module, statements, imports, or ambient
builtins from tenant-authored source. Definitions are single Python expressions
evaluated with a small constructor/helper surface and the immutable transcript
bound as ``session``.
"""

from __future__ import annotations

import ast
import hashlib
import re
from collections.abc import Callable
from typing import Any

from failproofai_sdk.evaluator.authoring import (
    Assertion,
    ConditionResult,
    EvalResult,
    Metric,
    Score,
)

MAX_CONDITION_SOURCE_BYTES = 16 * 1024
MAX_EVALUATOR_SOURCE_BYTES = 128 * 1024

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
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise UnsafeEvaluatorSource(
                f"{field_name} contains disallowed syntax: {type(node).__name__}"
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


def compile_condition(source: str) -> Callable[[Any], bool | ConditionResult]:
    code = _compile(
        source,
        field_name="condition_source",
        maximum=MAX_CONDITION_SOURCE_BYTES,
    )

    def condition(session: Any) -> bool | ConditionResult:
        value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
        if not isinstance(value, (bool, ConditionResult)):
            raise TypeError("condition_source must return bool or ConditionResult")
        return _forbid_object_reprs("condition_source", value)

    return condition


def compile_evaluator(source: str) -> Callable[[Any], EvalResult]:
    code = _compile(
        source,
        field_name="evaluator_source",
        maximum=MAX_EVALUATOR_SOURCE_BYTES,
    )

    def evaluate(session: Any) -> EvalResult:
        value = eval(code, _fresh_globals(), {"session": session})  # noqa: S307
        if not isinstance(value, EvalResult):
            raise TypeError("evaluator_source must return EvalResult")
        return _forbid_object_reprs("evaluator_source", value)

    return evaluate
