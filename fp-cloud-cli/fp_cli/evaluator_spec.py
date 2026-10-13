"""Evaluator API bodies: validate data, never execute customer Python locally."""

from __future__ import annotations

import ast
import json
import math
import re
from typing import Any, Optional

from . import _click_compat as click
from .commands._write import read_text_arg

FIELDS = frozenset({
    "eval_key", "display_name", "eval_version", "result_kind", "labels",
    "condition_source", "evaluator_source", "timeout_seconds",
})


def fail(message: str) -> None:
    raise click.UsageError(message)


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{name} must be a non-empty string")
    return value


def threshold(value: Any) -> None:
    if value is not None and (
        isinstance(value, bool) or not isinstance(value, (int, float))
        or not math.isfinite(value) or not 0 <= value <= 1
    ):
        fail("threshold must be between 0 and 1")


def source_kind(body: dict) -> str:
    source = body.get("evaluator_source", "")
    try:
        envelope = json.loads(source)
    except (ValueError, TypeError):
        return "code"
    return envelope.get("kind", "code") if isinstance(envelope, dict) else "code"


def validate(body: dict, *, complete: bool = True) -> dict:
    unknown = set(body) - FIELDS
    if unknown:
        fail(f"Unknown spec field(s): {', '.join(sorted(unknown))}; use the evaluator API body")
    if complete:
        key = text(body.get("eval_key"), "eval_key")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", key):
            fail("eval_key must match ^[a-z][a-z0-9_]*$")
        text(body.get("display_name"), "display_name")
        text(body.get("eval_version"), "eval_version")
    elif body.get("eval_key") is not None and not re.fullmatch(r"[a-z][a-z0-9_]*", str(body["eval_key"])):
        fail("eval_key must match ^[a-z][a-z0-9_]*$")
    result_kind = body.get("result_kind", "score")
    if result_kind not in ("score", "metric", "assertion"):
        fail("result_kind must be score, metric or assertion")
    labels = body.get("labels", [])
    if not isinstance(labels, list) or any(not isinstance(v, str) or not v.strip() for v in labels):
        fail("labels must be a list of non-empty strings")
    timeout = body.get("timeout_seconds")
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout) or timeout <= 0
    ):
        fail("timeout_seconds must be positive and finite")
    condition = body.get("condition_source")
    if condition:
        text(condition, "condition_source")
        expression(condition, "condition_source")
    source = text(body.get("evaluator_source"), "evaluator_source")
    kind = source_kind(body)
    if kind == "code":
        expression(source, "evaluator_source")
        return body
    envelope = json.loads(source)
    if kind not in ("judge", "jev"):
        fail("evaluator_source kind must be judge or jev")
    if result_kind != "score":
        fail("judge/Jev evaluators require result_kind score")
    threshold(envelope.get("threshold"))
    if kind == "judge":
        text(envelope.get("criteria"), "judge criteria")
        steps = envelope.get("steps")
        if steps is not None:
            if not isinstance(steps, list):
                fail("judge steps must be a list")
            for step in steps:
                text(step, "judge step")
                if re.search(r"\b(yes\s*/\s*no|true\s*/\s*false|binary|pass\s*/\s*fail|score\s+0\s+if|score\s+1\s+if)\b", step, re.I):
                    fail("binary judge steps are not supported; use graded evaluation steps")
    else:
        text(envelope.get("instructions"), "Jev instructions")
        criteria = envelope.get("criteria")
        if envelope.get("type") == "noul":
            if not isinstance(criteria, dict) or set(criteria) != {"true", "false"}:
                fail("Jev noul criteria must contain true and false")
            text(criteria["true"], "true criterion")
            text(criteria["false"], "false criterion")
            if criteria["true"].strip() == criteria["false"].strip():
                fail("Jev true and false criteria must be distinct")
        elif envelope.get("type") == "score":
            if not isinstance(criteria, list) or not 3 <= len(criteria) <= 5:
                fail("Jev score needs 3–5 distinct levels, ordered worst to best")
            for level in criteria:
                text(level, "Jev level")
            if len({v.strip() for v in criteria}) != len(criteria):
                fail("Jev score levels must be distinct")
        else:
            fail("Jev type must be noul or score")
    return body


def from_draft(data: dict, requested_kind: str) -> dict:
    """Convert the dashboard's EvalDraft (UI fields) to the immutable API body."""
    draft = data.get("spec", data)
    if isinstance(draft, str):
        try:
            draft = json.loads(draft)
        except ValueError:
            fail("Cloud draft was not an evaluator JSON spec")
    if not isinstance(draft, dict):
        fail("Cloud draft was not an evaluator JSON spec")
    body = {k: v for k, v in draft.items() if k in FIELDS}
    body.setdefault("eval_version", "1")
    kind = draft.get("kind", source_kind(body))
    if kind != requested_kind:
        fail(f"Cloud drafted {kind}, not requested {requested_kind}; retry with a more specific intent")
    if kind == "judge" and source_kind(body) != "judge":
        body["evaluator_source"] = json.dumps({
            "kind": "judge", "criteria": draft.get("criteria"),
            "threshold": draft.get("threshold"), "steps": draft.get("steps"),
        })
    elif kind == "jev" and source_kind(body) != "jev":
        body["evaluator_source"] = json.dumps({
            "kind": "jev", "type": draft.get("jevType"), "instructions": draft.get("instructions"),
            "criteria": draft.get("jevCriteria"), "threshold": draft.get("threshold"),
        })
    return validate(body)


def expression(source: str, name: str) -> None:
    try:
        ast.parse(source.strip(), mode="eval")
    except SyntaxError as exc:
        fail(f"{name} must be a restricted Python expression: {exc.msg}")


def build(
    *, key=None, name=None, version=None, label=None, condition=None,
    code=None, result_kind=None, timeout=None, judge=False, criteria=None,
    step=None, threshold_value=None, jev=None, instructions=None,
    true=None, false=None, level=None, file=None, complete=True,
) -> dict:
    kinds = sum((bool(code), bool(judge), bool(jev), bool(file)))
    if kinds != 1:
        fail("Choose exactly one source: --code, --judge, --jev or --file")
    source_flags = (criteria, step, threshold_value, instructions, true, false, level)
    if file:
        if any(v is not None for v in (key, name, version, label, condition, result_kind, timeout, *source_flags)):
            fail("Pass either --file or discrete spec flags, not both")
        try:
            body = json.loads(read_text_arg(file))
        except ValueError as exc:
            fail(f"--file is not valid JSON: {exc}")
        if not isinstance(body, dict):
            fail("--file must contain a JSON object")
        return validate(body, complete=complete)
    if code:
        if any(v is not None for v in source_flags):
            fail("Judge/Jev flags cannot be used with --code")
        source = read_text_arg(code, flag="--code")
    elif judge:
        if any(v is not None for v in (instructions, true, false, level)):
            fail("Jev flags cannot be used with --judge")
        source = json.dumps({"kind": "judge", "criteria": criteria, "threshold": threshold_value, "steps": step})
    else:
        if criteria is not None or step is not None:
            fail("Judge flags cannot be used with --jev")
        if jev == "noul" and level is not None or jev == "score" and (true is not None or false is not None):
            fail("Use --true/--false for Jev noul; --level for Jev score")
        source = json.dumps({
            "kind": "jev", "type": jev, "instructions": instructions,
            "criteria": {"true": true, "false": false} if jev == "noul" else level,
            "threshold": threshold_value,
        })
    body = {
        "result_kind": result_kind or "score", "labels": label or [],
        "evaluator_source": source,
    }
    if key is not None:
        body["eval_key"] = key
    if name is not None:
        body["display_name"] = name
    if version is not None:
        body["eval_version"] = version
    if condition is not None:
        body["condition_source"] = read_text_arg(condition[1:], flag="--condition") if condition.startswith("@") else condition
    if timeout is not None:
        body["timeout_seconds"] = timeout
    if complete:
        body.setdefault("eval_version", "1")
    return validate(body, complete=complete)


def dry_run_body(body: dict, sessions: Optional[list]) -> dict:
    if len(sessions or []) > 10:
        fail("dry-run accepts at most 10 sessions")
    if source_kind(body) == "judge":
        fail("Cloud refuses judge dry-runs; create/deploy without --dry-run-on and inspect evaluation results instead")
    return {
        **{k: v for k, v in body.items() if k in (
            "evaluator_source", "condition_source", "timeout_seconds", "result_kind", "eval_key",
        )},
        "session_ids": sessions or [],
    }
