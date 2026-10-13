"""Author, test and deploy managed evaluators, independently of result readers."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import typer

from .. import client as api, dates, evaluator_spec as spec, output
from .._context import GLOBALS_EPILOG, require_auth
from ..errors import ApiError, NotFoundError
from . import _cloud, _write

PATH = "/api/evaluator-definitions"


def definitions(cctx) -> list:
    return _cloud.rows(api.cloud_request(cctx, "GET", PATH), "definitions")


def select(items: list, handle: str) -> dict:
    key, _, version = handle.partition("@")
    matches = [r for r in items if r.get("eval_key") == key and (not version or str(r.get("eval_version")) == version)]
    if not matches:
        raise NotFoundError(f"no evaluator {handle}; run `fp evaluators list --all`")
    if not version:
        enabled = [r for r in matches if r.get("enabled", True)]
        matches = enabled or matches
    if len(matches) != 1:
        spec.fail(f"{handle} matches multiple versions; use KEY@VERSION")
    return matches[0]


def list_defs(ctx: typer.Context, key: Optional[str] = typer.Option(None, "--key"),
              all_versions: bool = typer.Option(False, "--all")) -> None:
    """List definitions (enabled only unless --all). Needs evaluations:read."""
    items = definitions(require_auth(ctx.obj))
    items = [r for r in items if (not key or r.get("eval_key") == key) and (all_versions or r.get("enabled", True))]
    _cloud.emit(ctx.obj, items, "Evaluators")


def show(ctx: typer.Context, handle: str = typer.Argument(..., metavar="KEY[@VERSION]")) -> None:
    """Show one definition, including its full source."""
    _cloud.emit(ctx.obj, select(definitions(require_auth(ctx.obj)), handle), "Evaluator")


def _create(state, cctx, body, sessions, disabled=False) -> dict:
    if sessions:
        if spec.source_kind(body) == "jev":
            output.warn("Jev dry-runs spend model budget.")
        preview = api.cloud_request(cctx, "POST", f"{PATH}/dry-run", body=spec.dry_run_body(body, sessions))
        check_dry_run(preview)
    _write.confirm(state, f"Create evaluator {body['eval_key']}@{body['eval_version']}", assume_yes=False)
    row = api.cloud_request(cctx, "POST", PATH, body=body)
    if not isinstance(row, dict) or not row.get("id"):
        raise ApiError("Cloud created no identifiable evaluator; check evaluators list --all before retrying")
    if disabled:
        api.cloud_request(cctx, "PATCH", f"{PATH}/{row['id']}", body={"enabled": False})
        row = {**row, "enabled": False}
    _write.record_action("evaluator_created", resource="evaluator", mode=spec.source_kind(body), success=True)
    return row


def create(
    ctx: typer.Context,
    key: Optional[str] = typer.Option(None, "--key"),
    name: Optional[str] = typer.Option(None, "--name"),
    version: Optional[str] = typer.Option(None, "--version"),
    label: Optional[List[str]] = typer.Option(None, "--label"),
    condition: Optional[str] = typer.Option(None, "--condition", help="Python expression or @file."),
    code: Optional[str] = typer.Option(None, "--code", help="Restricted Python expression file, or - for stdin."),
    result_kind: Optional[str] = typer.Option(None, "--result-kind"),
    timeout: Optional[float] = typer.Option(None, "--timeout"),
    judge: bool = typer.Option(False, "--judge"),
    criteria: Optional[str] = typer.Option(None, "--criteria"),
    step: Optional[List[str]] = typer.Option(None, "--step"),
    threshold: Optional[float] = typer.Option(None, "--threshold"),
    jev: Optional[str] = typer.Option(None, "--jev", help="noul or score."),
    instructions: Optional[str] = typer.Option(None, "--instructions"),
    true: Optional[str] = typer.Option(None, "--true"),
    false: Optional[str] = typer.Option(None, "--false"),
    level: Optional[List[str]] = typer.Option(None, "--level", help="3–5 distinct levels, worst to best."),
    file: Optional[str] = typer.Option(None, "--file"),
    dry_run_on: Optional[List[str]] = typer.Option(None, "--dry-run-on"),
    disabled: bool = typer.Option(False, "--disabled"),
) -> None:
    """Create a code, LLM judge or Jev evaluator (enabled by default).

    Needs evaluations:trigger; session dry-run also needs events:read.

    Code: `fp --json evaluators create --key concise --name Concise --code concise.py --result-kind score --dry-run-on run-001`

    Judge: `fp --json evaluators create --key relevance --name Relevance --judge --criteria "Grade relevance to the question" --step "Assess answer specificity" --threshold 0.7`

    Jev: `fp --json evaluators create --key resolved --name Resolved --jev noul --instructions "Assess whether the request was resolved" --true "Fully resolved" --false "Not resolved" --threshold 0.8`

    Spec: `fp --json evaluators create --file evaluator.json`
    """
    body = spec.build(
        key=key, name=name, version=version, label=label, condition=condition,
        code=code, result_kind=result_kind, timeout=timeout, judge=judge, criteria=criteria,
        step=step, threshold_value=threshold, jev=jev, instructions=instructions,
        true=true, false=false, level=level, file=file,
    )
    # Validate before any request, including the judge refusal / session bound.
    if dry_run_on:
        spec.dry_run_body(body, dry_run_on)
    row = _create(ctx.obj, require_auth(ctx.obj), body, dry_run_on, disabled)
    _cloud.emit(ctx.obj, row, "Evaluator created")


def deploy(
    ctx: typer.Context,
    key: str = typer.Argument(..., metavar="EVAL_KEY"),
    name: Optional[str] = typer.Option(None, "--name"),
    version: Optional[str] = typer.Option(None, "--version"),
    label: Optional[List[str]] = typer.Option(None, "--label"),
    condition: Optional[str] = typer.Option(None, "--condition"),
    code: Optional[str] = typer.Option(None, "--code"),
    result_kind: Optional[str] = typer.Option(None, "--result-kind"),
    timeout: Optional[float] = typer.Option(None, "--timeout"),
    judge: bool = typer.Option(False, "--judge"),
    criteria: Optional[str] = typer.Option(None, "--criteria"),
    step: Optional[List[str]] = typer.Option(None, "--step"),
    threshold: Optional[float] = typer.Option(None, "--threshold"),
    jev: Optional[str] = typer.Option(None, "--jev"),
    instructions: Optional[str] = typer.Option(None, "--instructions"),
    true: Optional[str] = typer.Option(None, "--true"),
    false: Optional[str] = typer.Option(None, "--false"),
    level: Optional[List[str]] = typer.Option(None, "--level"),
    file: Optional[str] = typer.Option(None, "--file"),
    dry_run_on: Optional[List[str]] = typer.Option(None, "--dry-run-on"),
    backfill: Optional[str] = typer.Option(None, "--backfill", help="Code only; e.g. 7d (up to 90d)."),
) -> None:
    """Publish a NEW immutable version, then disable enabled predecessors.

    Numeric versions auto-increment; for other version names pass --version.
    A failed predecessor PATCH leaves the new version enabled and reports its id.
    """
    body = spec.build(
        key=None if file else key, name=name, version=None if file else version, label=label,
        condition=condition, code=code, result_kind=result_kind, timeout=timeout,
        judge=judge, criteria=criteria, step=step, threshold_value=threshold, jev=jev,
        instructions=instructions, true=true, false=false, level=level, file=file, complete=False,
    )
    if file and body.get("eval_key") != key:
        spec.fail("The spec eval_key must match the deploy argument")
    body["eval_key"] = key
    if version is not None:
        body["eval_version"] = version
    if dry_run_on:
        spec.dry_run_body(body, dry_run_on)
    backfill_body = None
    if backfill:
        if spec.source_kind(body) != "code":
            spec.fail("--backfill excludes judge/Jev evaluators; use code only")
        if not re.fullmatch(r"[1-9][0-9]*d", backfill) or int(backfill[:-1]) > 90:
            spec.fail("--backfill must be a duration in days from 1d to 90d")
        now = datetime.now(timezone.utc)
        backfill_body = {"from": (now - timedelta(days=int(backfill[:-1]))).isoformat(), "to": now.isoformat(), "eval_key": key, "dry_run": False}
    cctx = require_auth(ctx.obj)
    existing = [r for r in definitions(cctx) if r.get("eval_key") == key]
    if "eval_version" not in body:
        versions = [str(r.get("eval_version", "")) for r in existing]
        if any(not v.isdigit() for v in versions):
            spec.fail("Non-numeric versions exist; specify a new --version")
        body["eval_version"] = str(max([int(v) for v in versions] or [0]) + 1)
    if any(str(r.get("eval_version")) == body["eval_version"] for r in existing):
        spec.fail(f"Version {key}@{body['eval_version']} already exists; deploy needs a NEW version")
    body.setdefault("display_name", existing[-1].get("display_name", key) if existing else key)
    spec.validate(body)
    created = _create(ctx.obj, cctx, body, dry_run_on)
    disabled_ids = []
    try:
        for old in existing:
            if old.get("enabled", True):
                api.cloud_request(cctx, "PATCH", f"{PATH}/{old['id']}", body={"enabled": False})
                disabled_ids.append(old["id"])
        if backfill_body:
            api.cloud_request(cctx, "POST", "/api/evaluations/backfill", body=backfill_body)
    except Exception as exc:
        output.warn(f"Published {key}@{body['eval_version']} (id {created['id']}); disabled {len(disabled_ids)} predecessors. Follow-up failed; inspect evaluators list --all before retrying.")
        raise exc
    _write.record_action("evaluator_deployed", resource="evaluator", success=True)
    _cloud.emit(ctx.obj, {"created": created, "disabled": disabled_ids}, "Evaluator deployed")


def draft(
    ctx: typer.Context,
    intent: str = typer.Argument(...),
    kind: str = typer.Option("code", "--kind"),
    out: str = typer.Option("evaluator.json", "--out"),
) -> None:
    """AI-compose an API spec file. Session only; review it before deployment."""
    _cloud.session_only(ctx.obj, "evaluators draft")
    if kind not in ("code", "judge", "jev"):
        spec.fail("--kind must be code, judge or jev")
    data = api.cloud_request(require_auth(ctx.obj), "POST", "/api/agent/compose-eval",
        body={"intent": f"Author a {kind} evaluator. {intent}", "resultKind": "score"})
    if not isinstance(data, dict):
        spec.fail("Cloud draft was not an evaluator JSON spec")
    body = spec.from_draft(data, kind)
    _cloud.write_file(out, json.dumps(body, indent=2, ensure_ascii=False) + "\n")
    _cloud.emit(ctx.obj, {"out": out, "spec": body}, "Evaluator draft")


def dry_run(
    ctx: typer.Context,
    code: Optional[str] = typer.Option(None, "--code"),
    result_kind: Optional[str] = typer.Option(None, "--result-kind"),
    timeout: Optional[float] = typer.Option(None, "--timeout"),
    condition: Optional[str] = typer.Option(None, "--condition"),
    judge: bool = typer.Option(False, "--judge"),
    criteria: Optional[str] = typer.Option(None, "--criteria"),
    step: Optional[List[str]] = typer.Option(None, "--step"),
    threshold: Optional[float] = typer.Option(None, "--threshold"),
    jev: Optional[str] = typer.Option(None, "--jev"),
    instructions: Optional[str] = typer.Option(None, "--instructions"),
    true: Optional[str] = typer.Option(None, "--true"),
    false: Optional[str] = typer.Option(None, "--false"),
    level: Optional[List[str]] = typer.Option(None, "--level"),
    file: Optional[str] = typer.Option(None, "--file"),
    session: Optional[List[str]] = typer.Option(None, "--session"),
) -> None:
    """Compile only, or run on ≤10 sessions. Cloud refuses judge dry-runs.

    Jev dry-runs execute model calls and spend budget, including before deployment.
    """
    body = spec.build(
        code=code, result_kind=result_kind, timeout=timeout, condition=condition,
        judge=judge, criteria=criteria, step=step, threshold_value=threshold, jev=jev,
        instructions=instructions, true=true, false=false, level=level, file=file, complete=False,
    )
    body = spec.dry_run_body(body, session)
    if spec.source_kind(body) == "jev":
        output.warn("Jev dry-runs spend model budget.")
    result = api.cloud_request(require_auth(ctx.obj), "POST", f"{PATH}/dry-run", body=body)
    _cloud.emit(ctx.obj, result, "Evaluator dry-run")
    if dry_run_failed(result):
        # Preserve the full dry-run result in --json, but do not signal success.
        raise typer.Exit(code=1)


def dry_run_failed(result):
    return isinstance(result, dict) and (
        result.get("ok") is False
        or any(r.get("ok") is False for r in result.get("runs", []) if isinstance(r, dict))
        or result.get("summary", {}).get("failed", 0) > 0
    )


def check_dry_run(result):
    if dry_run_failed(result):
        failures = [r for r in result.get("runs", []) if r.get("ok") is False]
        detail = "; ".join(str(r.get("error_message") or r.get("error_kind") or "run failed") for r in failures)
        raise ApiError(f"Dry-run failed; evaluator was not created. {detail}".strip())


def toggle(ctx, handle, enabled):
    cctx = require_auth(ctx.obj)
    row = select(definitions(cctx), handle)
    _write.confirm(ctx.obj, f"{'Enable' if enabled else 'Disable'} {handle}", assume_yes=False)
    result = api.cloud_request(cctx, "PATCH", f"{PATH}/{row['id']}", body={"enabled": enabled})
    _write.record_action("evaluator_toggled", resource="evaluator", success=True)
    _cloud.emit(ctx.obj, result or {**row, "enabled": enabled}, "Evaluator")


def enable(ctx: typer.Context, handle: str = typer.Argument(...)) -> None:
    """Enable KEY[@VERSION]."""
    toggle(ctx, handle, True)


def disable(ctx: typer.Context, handle: str = typer.Argument(...)) -> None:
    """Disable KEY[@VERSION]."""
    toggle(ctx, handle, False)


def label_def(ctx: typer.Context, handle: str = typer.Argument(...),
              add: Optional[List[str]] = typer.Option(None, "--add"),
              remove: Optional[List[str]] = typer.Option(None, "--remove")) -> None:
    """Add/remove labels on KEY[@VERSION]."""
    if not add and not remove:
        spec.fail("Pass --add or --remove")
    if set(add or []) & set(remove or []):
        spec.fail("A label cannot be both added and removed")
    cctx = require_auth(ctx.obj)
    row = select(definitions(cctx), handle)
    labels = list(dict.fromkeys([v for v in row.get("labels", []) if v not in (remove or [])] + (add or [])))
    spec.validate_labels(labels)
    _write.confirm(ctx.obj, f"Label {handle}", assume_yes=False)
    data = api.cloud_request(cctx, "PATCH", f"{PATH}/{row['id']}", body={"labels": labels})
    _cloud.emit(ctx.obj, data or {**row, "labels": labels}, "Evaluator labels")


def instances(ctx: typer.Context) -> None:
    """List managed evaluator instances."""
    _cloud.emit(ctx.obj, api.cloud_request(require_auth(ctx.obj), "GET", "/api/evaluator-instances"), "Instances")


def schema(ctx: typer.Context) -> None:
    """Schema profile. Needs evaluations:trigger and events:read."""
    _cloud.emit(ctx.obj, api.cloud_request(require_auth(ctx.obj), "GET", "/api/evaluator-schema-profile"), "Schema profile")


def jobs(ctx: typer.Context) -> None:
    """List evaluation jobs."""
    _cloud.emit(ctx.obj, api.cloud_request(require_auth(ctx.obj), "GET", "/api/evaluation-jobs"), "Evaluation jobs")


def backfill(ctx: typer.Context, frm: str = typer.Option(..., "--from"),
             to: str = typer.Option(..., "--to"), key: Optional[str] = typer.Option(None, "--key"),
             dry_run: bool = typer.Option(False, "--dry-run")) -> None:
    """Backfill at most 90 days. Judge/Jev evaluators are excluded by Cloud."""
    try:
        dates.resolve_range(ts_from=frm, ts_to=to)
        start = datetime.fromisoformat(frm.replace("Z", "+00:00"))
        end = datetime.fromisoformat(to.replace("Z", "+00:00"))
    except ValueError as exc:
        spec.fail(str(exc))
    if end <= start or end - start > timedelta(days=90):
        spec.fail("Backfill needs an increasing range of at most 90 days")
    output.warn("Backfill excludes judge/Jev evaluators; only code evaluators are replayed.")
    _write.confirm(ctx.obj, "Backfill evaluations", assume_yes=dry_run)
    _cloud.emit(ctx.obj, api.cloud_request(require_auth(ctx.obj), "POST", "/api/evaluations/backfill",
        body={"from": frm, "to": to, "eval_key": key, "dry_run": dry_run}), "Evaluation backfill")


def register(app: typer.Typer) -> None:
    group = typer.Typer(no_args_is_help=True, rich_markup_mode="markdown", help="Author, test and deploy code, LLM-judge and Jev evaluators.", context_settings={"help_option_names": ["-h", "--help"]})
    for name, fn in (
        ("list", list_defs), ("show", show), ("create", create), ("deploy", deploy),
        ("draft", draft), ("dry-run", dry_run), ("enable", enable), ("disable", disable),
        ("label", label_def), ("instances", instances), ("schema", schema), ("jobs", jobs),
        ("backfill", backfill),
    ):
        group.command(name, epilog=GLOBALS_EPILOG)(fn)
    app.add_typer(group, name="evaluators")
