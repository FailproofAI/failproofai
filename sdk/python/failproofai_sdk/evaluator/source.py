"""Restricted deterministic expression compiler for server-authored evaluations.

The managed worker never executes a module, statements, imports, or ambient
builtins from tenant-authored source. Definitions are single Python expressions
evaluated with a small constructor/helper surface and the immutable transcript
bound as ``session``.
"""

from __future__ import annotations

import ast
import hashlib
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
    ast.GeneratorExp,
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
    "enumerate": enumerate,
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
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise UnsafeEvaluatorSource(
                f"{field_name} may not access private or dunder attributes"
            )
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise UnsafeEvaluatorSource(f"{field_name} may not access private names")
    return compile(tree, f"<{field_name}>", "eval", dont_inherit=True, optimize=2)


def compile_condition(source: str) -> Callable[[Any], bool | ConditionResult]:
    code = _compile(
        source,
        field_name="condition_source",
        maximum=MAX_CONDITION_SOURCE_BYTES,
    )

    def condition(session: Any) -> bool | ConditionResult:
        value = eval(code, _SAFE_GLOBALS, {"session": session})  # noqa: S307
        if not isinstance(value, (bool, ConditionResult)):
            raise TypeError("condition_source must return bool or ConditionResult")
        return value

    return condition


def compile_evaluator(source: str) -> Callable[[Any], EvalResult]:
    code = _compile(
        source,
        field_name="evaluator_source",
        maximum=MAX_EVALUATOR_SOURCE_BYTES,
    )

    def evaluate(session: Any) -> EvalResult:
        value = eval(code, _SAFE_GLOBALS, {"session": session})  # noqa: S307
        if not isinstance(value, EvalResult):
            raise TypeError("evaluator_source must return EvalResult")
        return value

    return evaluate
