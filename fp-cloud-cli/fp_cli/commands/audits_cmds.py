"""Audits: audits list/show/create/edit/delete/run/runs + findings/finding + triage.

An **audit** is a scheduled sweep over a window of agent activity (`audits create`), and what
it produces are **findings** — recurring patterns carried across runs by a fingerprint. So the
group has two handles: an audit is referenced by its **name** (unique per org, like `alerts`),
while a finding is referenced by its **id** (findings have no human name). The triage verbs
(`ack`/`mute`/`dismiss`/`resolve`/`reopen`/`assign`) act on a finding id and all post the same
status endpoint.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, collect_multi, require_auth, validate_limit
from ..errors import ApiError, ForbiddenError, NotFoundError
from ..models import Audit
from . import _write

_WINDOW_MODES = ("fixed", "since_last")
_SENSITIVITIES = ("low", "medium", "high")
_FINDING_STATUSES = ("open", "recurring", "resolved", "dismissed", "muted")
_TRIAGE_ACTIONS = ("ack", "mute", "dismiss", "resolve", "reopen", "assign")
# Triage actions that suppress or close a finding — those confirm first (`--yes` skips).
# ack / reopen / assign are calm, reversible bookkeeping, so they act immediately.
_CONFIRMING_ACTIONS = ("mute", "dismiss", "resolve")
# The server's accepted ranges (mirrored client-side so a bad value is a clean exit 2
# instead of an HTTP 422 round-trip).
_INTERVAL_MIN, _INTERVAL_MAX = 3_600, 604_800
_LOOKBACK_MIN, _LOOKBACK_MAX = 3_600, 7_776_000
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _validate_statuses(value: Optional[str]) -> None:
    """Reject an unknown ``--status`` value up front (exit 2) rather than letting the server answer
    with a 422 (or, worse, silently drop it). Accepts a CSV of the five finding statuses."""
    if value is None:
        return
    for s in value.split(","):
        s = s.strip()
        if s and s not in _FINDING_STATUSES:
            raise typer.BadParameter(
                f"'{s}' is not a valid status. Choose from: {', '.join(_FINDING_STATUSES)} (CSV).",
                param_hint="--status",
            )


def _validate_action(action: str) -> str:
    """Guard the triage action the subcommands hand to the status endpoint. Each triage command
    passes its own fixed verb, so this only trips on a coding error — but it keeps an unknown
    action a clean usage error (exit 2) instead of an HTTP 422."""
    if action not in _TRIAGE_ACTIONS:
        raise typer.BadParameter(
            f"'{action}' is not a valid triage action. Choose from: {', '.join(_TRIAGE_ACTIONS)}.",
            param_hint="--action",
        )
    return action


def _parse_anchor(value: str) -> Optional[str]:
    """Normalize a ``--schedule-anchor`` to an RFC3339 string the server's
    ``DateTime<Utc>`` deserializer accepts, or ``None`` if it isn't a timestamp.

    Accepts a trailing ``Z`` (which ``datetime.fromisoformat`` rejects before 3.11)
    and a naive timestamp, which is read as UTC — audits are UTC end to end and
    there is no timezone anywhere in this system."""
    raw = value.strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_audit(body: Dict[str, Any], *, require_core: bool) -> None:
    """Client-side validation of an audit body (exit 2 on a bad value), mirroring the server's
    accepted ranges/enums so a typo never costs a round-trip or surfaces as a raw 422.

    Also normalizes ``schedule_anchor`` in place to RFC3339 — see the comment there."""
    if require_core and not str(body.get("name") or "").strip():
        raise typer.BadParameter("audit 'name' is required.")
    interval = body.get("schedule_interval_secs")
    if isinstance(interval, int) and not (_INTERVAL_MIN <= interval <= _INTERVAL_MAX):
        raise typer.BadParameter(
            f"schedule_interval_secs must be between {_INTERVAL_MIN} (1h) and {_INTERVAL_MAX} (7d).",
            param_hint="--schedule-interval-secs",
        )
    lookback = body.get("lookback_window_secs")
    if isinstance(lookback, int) and not (_LOOKBACK_MIN <= lookback <= _LOOKBACK_MAX):
        raise typer.BadParameter(
            f"lookback_window_secs must be between {_LOOKBACK_MIN} (1h) and {_LOOKBACK_MAX} (90d).",
            param_hint="--lookback-window-secs",
        )
    mode = body.get("window_mode")
    if mode and mode not in _WINDOW_MODES:
        raise typer.BadParameter(
            f"window_mode must be one of: {', '.join(_WINDOW_MODES)}.", param_hint="--window-mode"
        )
    anchor = body.get("schedule_anchor")
    if anchor is not None:
        normalized = _parse_anchor(str(anchor))
        if not normalized:
            raise typer.BadParameter(
                "schedule_anchor must be an ISO 8601 timestamp, e.g. 2026-07-22T09:00:00Z.",
                param_hint="--schedule-anchor",
            )
        # Normalized in place, so every write path (flags, --file, the edit
        # read-merge) sends the RFC3339 form the server's DateTime<Utc>
        # deserializer accepts. Rewriting it here rather than in the override
        # builder keeps an unparseable value reaching the check above instead of
        # being silently dropped as "not supplied".
        body["schedule_anchor"] = normalized
    sensitivity = body.get("sensitivity")
    if sensitivity and sensitivity not in _SENSITIVITIES:
        raise typer.BadParameter(
            f"sensitivity must be one of: {', '.join(_SENSITIVITIES)}.", param_hint="--sensitivity"
        )
    top_k = body.get("top_k")
    if isinstance(top_k, int) and top_k < 1:
        raise typer.BadParameter("top_k must be at least 1.", param_hint="--top-k")


def _fail(state: AppState, exc: Exception, *, finding_id: str = "") -> None:
    """Re-raise as a typed error for the central chokepoint to render (JSON envelope under
    ``--json`` on stdout, red box otherwise). A 404 — or a **malformed (non-UUID) finding id**,
    which the server answers with a 400 from its path extractor rather than a 404 — becomes the
    friendlier ``no finding <id>`` (exit 6); a permission denial and every other error keep the
    server's message and exit code."""
    if isinstance(exc, ForbiddenError):
        raise exc  # a 403 reached the handler with a usable id — surface it as-is
    status = getattr(exc, "status", None) or 0
    malformed = bool(finding_id) and not _UUID_RE.match(finding_id) and status >= 400
    if finding_id and (malformed or isinstance(exc, NotFoundError)):
        raise NotFoundError(
            f"no finding {finding_id}",
            hint="run `fp audits findings` to list findings",
        )
    raise exc


def _parse_json_opt(value: Optional[str], hint: str) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{hint} is not valid JSON: {exc}", param_hint=hint)


# Mirrors MAX_CONTEXT_CHARS / MAX_REFERENCE_URLS in server/src/audits/context.rs.
# Checked here so an over-long brief is a usage error at exit 2, not a 422 after
# the request went out.
_MAX_CONTEXT_CHARS = 8192
_MAX_REFERENCE_URLS = 5


def _context_text(text: Optional[str], text_file: Optional[str]) -> Optional[str]:
    """The brief from ``--text`` or ``--text-file``. ``None`` means neither was given.

    Shared by ``audits create`` and ``audits context-set`` so the two flags mean the same
    thing on both, and the cap is stated once."""
    if text is not None and text_file:
        raise typer.BadParameter("pass --text or --text-file, not both.", param_hint="--text-file")
    body_text = text
    if text_file:
        try:
            with open(text_file, "r", encoding="utf-8") as fh:
                body_text = fh.read()
        except OSError as exc:
            raise typer.BadParameter(f"could not read {text_file}: {exc}", param_hint="--text-file")
    if body_text is not None and len(body_text) > _MAX_CONTEXT_CHARS:
        raise typer.BadParameter(
            f"the brief is limited to {_MAX_CONTEXT_CHARS} characters.", param_hint="--text"
        )
    return body_text


def _context_urls(url: Optional[List[str]]) -> List[str]:
    """The ``--url`` list, capped where the server caps it."""
    urls = list(url or [])
    if len(urls) > _MAX_REFERENCE_URLS:
        raise typer.BadParameter(
            f"an audit may reference at most {_MAX_REFERENCE_URLS} URLs.", param_hint="--url"
        )
    return urls


# Keys `audits show --json` emits that the definition endpoint will not accept.
#
# Server-derived state the server simply ignores, plus the two context keys it
# actively 422s (they are written through `PUT /audits/{id}/context`). Dropping
# them here is what makes the documented `audits show --json > f && audits edit
# --file f` round-trip work: without it the file carries `additional_context`,
# the server rejects the whole request, and the edit fails for a field the
# operator never touched.
_READ_ONLY_AUDIT_KEYS = frozenset({
    "id", "created_by", "created_at", "updated_at",
    "open_findings", "run_count",
    "last_run_status", "last_run_finished_at", "last_attempted_at",
    "next_attempt_at", "last_error",
    # Written through the context sub-resource, not here.
    "additional_context", "reference_urls", "reference_url_count",
})


def _load_file(file: Optional[str]) -> Dict[str, Any]:
    if file is None:
        return {}
    raw = _write.read_text_arg(file)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"--file is not valid JSON: {exc}", param_hint="--file")
    if not isinstance(parsed, dict):
        raise typer.BadParameter("--file must contain a JSON object.", param_hint="--file")
    return {k: v for k, v in parsed.items() if k not in _READ_ONLY_AUDIT_KEYS}


def _apply_overrides(body: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
    for key, value in overrides.items():
        if value is not None:
            body[key] = value
    return body


def _audit_to_body(audit: Audit) -> Dict[str, Any]:
    """The writable fields of an existing audit, used as the merge base for a flag-only edit.

    The server's ``PUT /api/audits/{id}`` replaces the definition (and ``name`` is mandatory on
    it), so a single-field change must re-send the whole audit. Server-derived state
    (``open_findings``, the last-run columns) is deliberately excluded — it is read-only."""
    return {
        "name": audit.name,
        "description": audit.description,
        "enabled": audit.enabled,
        "schedule_interval_secs": audit.schedule_interval_secs,
        "schedule_anchor": audit.schedule_anchor,
        "window_mode": audit.window_mode,
        "lookback_window_secs": audit.lookback_window_secs,
        "scope": audit.scope,
        "ignore_error_types": audit.ignore_error_types,
        "llm_enabled": audit.llm_enabled,
        "top_k": audit.top_k,
        "sensitivity": audit.sensitivity,
        "channels": audit.channels,
    }


def _audit_from_body(body: Dict[str, Any], base: Optional[Audit] = None) -> Audit:
    """Build an ``Audit`` view from a create/edit request body — the fallback when the canonical
    re-fetch misses. ``base`` (the pre-edit audit) supplies id/created/derived context; a create
    has none, so those default to empty."""
    merged: Dict[str, Any] = dict(_audit_to_body(base)) if base else {}
    merged.update({k: v for k, v in body.items() if v is not None})
    merged.setdefault("id", base.id if base else "")
    return Audit.from_dict({
        **merged,
        "id": base.id if base else "",
        "created_by": base.created_by if base else "",
        "created_at": base.created_at if base else "",
        "open_findings": base.open_findings if base else 0,
        "last_run_status": base.last_run_status if base else None,
        "last_run_finished_at": base.last_run_finished_at if base else None,
    })


def _refetch_audit(cctx, name: Optional[str]) -> Optional[Audit]:
    """Re-read the canonical stored audit by name after a create/edit (the server busts the list
    cache on write, so this reflects the saved state incl. server-applied defaults). Returns
    ``None`` on any miss so the caller falls back to rendering from the request body."""
    if not name:
        return None
    try:
        for a in api.list_audits(cctx):
            if a.name == name:
                return a
    except Exception:
        return None
    return None


def _resolve_audit_or_exit(audits, handle: str) -> Audit:
    """Resolve an audit by **name** (primary), falling back to an exact id match, raising a typed
    error the central chokepoint renders: none → exit 6, several → exit 2."""
    return _write.resolve_one(audits, handle, kind="audit", list_cmd="audits list")


def audits_list(
    ctx: typer.Context,
    enabled_only: bool = typer.Option(False, "--enabled-only", help="Only audits that are switched on."),
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short audit-id column (the full id is always in --json)."),
) -> None:
    """List audit definitions in a boxed table, newest first.

    Shows `created · name · by · every · findings · status · last run` — `every` is the humanized
    schedule interval, `findings` the open-finding count (pink when there's something to triage),
    and `last run` the age of the last run tinted by its outcome (`never` if it hasn't run yet).
    Disabled audits are dimmed; the on/off split is in the footer. `name` is the handle the other
    subcommands take; the raw id is hidden unless `--show-id`. Needs `audits:read`. With `--json`:
    `{"audits": [{id, name, enabled, schedule_interval_secs, window_mode, scope, open_findings,
    last_run_status, created_by, created_at, ...}]}`.

    Example:

    * `fp audits list --enabled-only`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audits = api.list_audits(cctx)
    if enabled_only:
        audits = [a for a in audits if a.enabled]
    if state.json:
        output.emit_json({"audits": audits})
        return
    output.render_audits(audits, show_id=show_id)
    output.audits_footer(audits)


def audits_show(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id)."),
) -> None:
    """Show one audit as a stack of cards — identity, schedule, scope, analysis, channels.

    Referenced by audit **name** (a UUID-shaped id is also accepted). The identity card carries the
    on/off state, the cadence and the open-finding count; `scope` shows what activity the audit
    covers, `analysis` the LLM/sensitivity settings, `channels` default-vs-custom delivery.
    Not-found → red `✗ no audit named "…"`, exit 6. Needs `audits:read`. With `--json`: the full
    raw `Audit` (untouched `scope` + `channels`).

    Example:

    * `fp audits show weekly-failure-audit`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    if state.json:
        output.emit_json(audit)
        return
    output.render_audit_show(audit)


def _definition_overrides(
    name, description, enabled, schedule_interval_secs, schedule_anchor, window_mode,
    lookback_window_secs, scope, ignore_error_type, llm_enabled, top_k, sensitivity, channels,
) -> Dict[str, Any]:
    """The discrete definition flags → an overrides dict (``None`` = "not supplied", so it never
    clobbers a value carried over from `--file` or the existing audit)."""
    return dict(
        name=name,
        description=description,
        enabled=enabled,
        schedule_interval_secs=schedule_interval_secs,
        # Raw here on purpose — `_validate_audit` parses/normalizes it. Parsing at
        # this point would turn a malformed anchor into None, i.e. "not supplied",
        # and silently ignore the flag instead of erroring.
        schedule_anchor=schedule_anchor,
        window_mode=window_mode,
        lookback_window_secs=lookback_window_secs,
        scope=_parse_json_opt(scope, "--scope"),
        ignore_error_types=collect_multi(ignore_error_type),
        llm_enabled=llm_enabled,
        top_k=top_k,
        sensitivity=sensitivity,
        channels=_parse_json_opt(channels, "--channels"),
    )


def audits_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (unique per org)."),
    file: Optional[str] = typer.Option(None, "--file", help="Full audit JSON to base it on, or `-` for stdin."),
    description: Optional[str] = typer.Option(None, "--description", help="What this audit is for."),
    enabled: Optional[bool] = typer.Option(None, "--enabled/--disabled", help="Start it on or off (default: on)."),
    schedule_interval_secs: Optional[int] = typer.Option(None, "--schedule-interval-secs", help=f"How often it runs, in seconds ({_INTERVAL_MIN}–{_INTERVAL_MAX})."),
    schedule_anchor: Optional[str] = typer.Option(None, "--schedule-anchor", help="Fixed UTC slot the schedule is phased to, ISO 8601 (default: next 09:00 UTC)."),
    window_mode: Optional[str] = typer.Option(None, "--window-mode", help=f"Which window each run sweeps: {', '.join(_WINDOW_MODES)}."),
    lookback_window_secs: Optional[int] = typer.Option(None, "--lookback-window-secs", help=f"How far back a run looks, in seconds ({_LOOKBACK_MIN}–{_LOOKBACK_MAX})."),
    scope: Optional[str] = typer.Option(None, "--scope", help="Scope filter as JSON, e.g. `{\"environments\":[\"prod\"]}` (omit to cover everything)."),
    ignore_error_type: Optional[List[str]] = typer.Option(None, "--ignore-error-type", help="Error type to exclude (repeatable, or CSV)."),
    llm_enabled: Optional[bool] = typer.Option(None, "--llm/--no-llm", help="Use the LLM analysis pass (default: on)."),
    top_k: Optional[int] = typer.Option(None, "--top-k", help="Max findings a run keeps."),
    sensitivity: Optional[str] = typer.Option(None, "--sensitivity", help=f"How eagerly it flags: {', '.join(_SENSITIVITIES)}."),
    channels: Optional[str] = typer.Option(None, "--channels", help="Channels as a JSON array, e.g. `[{\"kind\":\"slack\"}]` (omit for the org defaults)."),
    text: Optional[str] = typer.Option(
        None, "--text", help="Operator brief for the analysis prompt (max 8192 chars)."
    ),
    text_file: Optional[str] = typer.Option(
        None, "--text-file", help="Read the brief from a file instead of --text."
    ),
    url: Optional[List[str]] = typer.Option(
        None, "--url", help="Reference URL; repeat up to 5 times. Public https:// only."
    ),
) -> None:
    """Create an audit and show it rendered as parsed cards.

    Give it a **name** (positional), then define it with the flags or base it on a full JSON
    payload via `--file` (flags layer on top). Everything except the name has a server default —
    a bare `fp audits create nightly` gives you a daily, LLM-backed audit over all activity.
    On success it renders exactly the way `audits show` does, in a green "audit created" card.
    Creating isn't destructive, so there's no confirm; a name collision is rejected up front
    (exit 2). New audits start **enabled** unless you pass `--disabled`. Needs `audits:write`.
    With `--json`: `{id, created_at, sources}`.

    `--text`/`--text-file`/`--url` attach reference context in the SAME request, which is
    also the only way to be sure the first run has it: a new enabled audit is due
    immediately, so context set afterwards can miss it. A URL the guard refuses fails the
    whole create — no half-made audit is left behind. Change it later with
    `audits context-set`.

    Examples:

    * `fp audits create nightly-prod --scope '{"environments":["prod"]}' --schedule-interval-secs 86400`
    * `fp audits create nightly-prod --text "checkout agent for a retail store" --url https://docs.example.com/runbook`
    * `fp audits create weekly --file audit.json` — base it on a saved payload
    * `fp audits create weekly --file audit.json --sensitivity high` — file + an override
    """
    state: AppState = ctx.obj
    body = _load_file(file)
    _apply_overrides(body, **_definition_overrides(
        name, description, enabled, schedule_interval_secs, schedule_anchor, window_mode,
        lookback_window_secs, scope, ignore_error_type, llm_enabled, top_k, sensitivity, channels,
    ))
    # Context travels WITH the definition — the server writes both in one
    # transaction, so the run it queues cannot start before the material lands.
    # Flags layer over `--file` here too; neither flag leaves whatever the file
    # carried alone.
    brief, urls = _context_text(text, text_file), _context_urls(url)
    if brief is not None or urls:
        body["context"] = {"text": brief or "", "urls": urls}
    _validate_audit(body, require_core=True)
    cctx = require_auth(state)
    if any(a.name == body.get("name") for a in api.list_audits(cctx)):  # names are the handle → unique
        raise click.UsageError(f'an audit named "{body.get("name")}" already exists')
    result = api.create_audit(cctx, body)
    _write.record_action("audit_created", resource="audit", success=True)
    if body.get("context"):
        # Same event and the same allowlisted properties as `context-set`, so
        # "was context filled in at creation?" is answerable across surfaces.
        # `via` and `url_count` are both on _SAFE_PROP_KEYS; shape only, never a URL.
        _write.record_action(
            "audit_context_saved", resource="audit", success=True, via="cli",
            url_count=len(body["context"]["urls"]),
        )
    if state.json:
        output.emit_json(result)
        return
    # Re-read the canonical stored audit (server defaults applied) for the rendered cards.
    audit = _refetch_audit(cctx, body.get("name")) or _audit_from_body(body)
    output.render_audit_created(audit)


def audits_edit(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id) to edit."),
    new_name: Optional[str] = typer.Option(None, "--name", help="Rename the audit."),
    file: Optional[str] = typer.Option(None, "--file", help="Full audit JSON to replace it with, or `-` for stdin."),
    description: Optional[str] = typer.Option(None, "--description", help="New description."),
    enabled: Optional[bool] = typer.Option(None, "--enabled/--disabled", help="Switch the audit on or off."),
    schedule_interval_secs: Optional[int] = typer.Option(None, "--schedule-interval-secs", help=f"New run interval, in seconds ({_INTERVAL_MIN}–{_INTERVAL_MAX})."),
    schedule_anchor: Optional[str] = typer.Option(None, "--schedule-anchor", help="New fixed UTC slot the schedule is phased to, ISO 8601."),
    window_mode: Optional[str] = typer.Option(None, "--window-mode", help=f"New window mode: {', '.join(_WINDOW_MODES)}."),
    lookback_window_secs: Optional[int] = typer.Option(None, "--lookback-window-secs", help=f"New lookback, in seconds ({_LOOKBACK_MIN}–{_LOOKBACK_MAX})."),
    scope: Optional[str] = typer.Option(None, "--scope", help="New scope filter as JSON."),
    ignore_error_type: Optional[List[str]] = typer.Option(None, "--ignore-error-type", help="Replace the ignored error types (repeatable, or CSV)."),
    llm_enabled: Optional[bool] = typer.Option(None, "--llm/--no-llm", help="Turn the LLM analysis pass on or off."),
    top_k: Optional[int] = typer.Option(None, "--top-k", help="New max findings per run."),
    sensitivity: Optional[str] = typer.Option(None, "--sensitivity", help=f"New sensitivity: {', '.join(_SENSITIVITIES)}."),
    channels: Optional[str] = typer.Option(None, "--channels", help="New channels as a JSON array."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Edit an audit, referenced by **name** (or a UUID-shaped id). Two ways to change it:

    * **Tweak fields** with the override flags (e.g. `--sensitivity high`, `--disabled`). Because
      the server replaces the whole definition, the CLI re-sends the current audit with your
      changes applied — so a flag-only edit needs `audits:read` **and** `audits:write`.
    * **Replace wholesale** with `--file` (a complete audit payload), optionally layering a few
      override flags on top.

    It confirms first (default no; `--yes` skips) and renders the new state as a green "audit
    updated" card. A rename onto an existing name is rejected (exit 2). Needs `audits:write`.
    With `--json`: `{id, updated}`.

    Examples:

    * `fp audits edit nightly-prod --sensitivity high` — change one field
    * `fp audits edit nightly-prod --disabled --yes` — pause it, no prompt
    * `fp audits edit nightly-prod --name nightly --yes` — rename
    """
    state: AppState = ctx.obj
    overrides = _definition_overrides(
        new_name, description, enabled, schedule_interval_secs, schedule_anchor, window_mode,
        lookback_window_secs, scope, ignore_error_type, llm_enabled, top_k, sensitivity, channels,
    )
    cctx = require_auth(state)
    existing = api.list_audits(cctx)
    audit = _resolve_audit_or_exit(existing, name)
    if file is not None:
        # An explicit full body is a straight replace.
        body = _load_file(file)
        _apply_overrides(body, **overrides)
        body.setdefault("name", audit.name)
    else:
        # Flag-only edit: the server replaces the definition, so seed the body from the resolved
        # audit and overlay just the changed fields (read-merge, like `alerts update`).
        body = _audit_to_body(audit)
        _apply_overrides(body, **overrides)
    _validate_audit(body, require_core=True)
    final_name = body.get("name") or audit.name
    if final_name != audit.name and any(a.name == final_name and a.id != audit.id for a in existing):
        raise click.UsageError(f'an audit named "{final_name}" already exists')
    if _write.should_prompt(state, yes):
        if not output.confirm_audit_edit(audit.name):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing changed")
            return
    result = api.update_audit(cctx, audit.id, body)
    _write.record_action("audit_updated", resource="audit", success=True)
    if state.json:
        output.emit_json(result)
        return
    updated = _refetch_audit(cctx, final_name) or _audit_from_body(body, base=audit)
    output.render_audit_updated(updated, old_name=audit.name)


def audits_delete(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id) to delete."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Delete an audit, referenced by **name** (or a UUID-shaped id). This cannot be undone.

    Shows an amber preview of the audit (incl. its open-finding count — the findings and the run
    history go with it) then confirms. Needs `audits:write`. With `--json`: `{"deleted": true, "id",
    "name"}` (or `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp audits delete old-experiment --yes`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    if _write.should_prompt(state, yes):
        output.render_audit_delete_preview(audit)  # amber preview of what's about to go
        if not output.confirm_audit_delete(audit.open_findings):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing deleted")
            return
    api.delete_audit(cctx, audit.id)
    _write.record_action("audit_deleted", resource="audit", success=True, destructive=True)
    if state.json:
        output.emit_json({"deleted": True, "id": audit.id, "name": audit.name})
    else:
        output.audit_deleted(audit.name)


def audits_run(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id) to run now."),
) -> None:
    """Queue an audit to run now, ahead of its schedule.

    This makes the audit **due**; the dispatcher picks it up on its next tick, so success here
    means "queued", not "finished" — follow it with `fp audits runs <name>`. An audit that
    is disabled, or that already has a run in progress, is refused with the server's explanation
    (exit 1) rather than silently double-queued. Needs `audits:write`. With `--json`:
    `{"queued": true}`.

    Example:

    * `fp audits run nightly-prod`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    try:
        result = api.run_audit(cctx, audit.id)
    except ApiError as exc:
        if getattr(exc, "status", None) == 409:
            # A run is already in progress (or the audit is disabled) — the server's message says
            # which; add the "what now" pointer the bare message lacks.
            raise ApiError(
                exc.message,
                status=exc.status,
                request_id=exc.request_id,
                hint=f"check it with `fp audits runs {audit.name}`",
            )
        raise
    _write.record_action("audit_run_queued", resource="audit", success=True)
    if state.json:
        output.emit_json(result)
    else:
        output.audit_run_queued(audit.name)


def audits_context_show(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id)."),
) -> None:
    """Show the reference context an audit sends to the analysis prompt.

    Prints the operator brief plus every reference URL with its fetch state: how many
    characters were stored, whether the snapshot was truncated, how many secret-shaped
    values were masked, and whether the page contains phrases that read as instructions
    to an AI (which is worth reading before the next run). Needs `audits:read`.

    Example:

    * `fp audits context-show nightly-prod`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    result = api.get_audit_context(cctx, audit.id)
    if state.json:
        output.emit_json(result)
    else:
        output.audit_context(audit.name, result)


def audits_context_set(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id)."),
    text: Optional[str] = typer.Option(
        None, "--text", help="Operator brief (max 8192 chars). Pass an empty string to clear it."
    ),
    text_file: Optional[str] = typer.Option(
        None, "--text-file", help="Read the brief from a file instead of --text."
    ),
    url: Optional[List[str]] = typer.Option(
        None, "--url", help="Reference URL; repeat up to 5 times. Public https:// only. "
                            "Replaces the existing list; omit to leave it unchanged."
    ),
    clear_urls: bool = typer.Option(
        False, "--clear-urls", help="Remove every reference URL and its stored snapshot."
    ),
) -> None:
    """Update an audit's reference context.

    Each half is independent: pass `--text`/`--text-file` to change the brief, `--url`
    to replace the URL list, or both. **Whatever you omit is left alone.** Removing
    something is always explicit — `--text ""` clears the brief, `--clear-urls` drops
    every URL and its stored snapshot.

    Omission used to mean "delete" for URLs but "keep" for the brief, so a routine
    `--text` edit silently threw away every reference page.

    URLs are validated immediately (public `https://` only; private, loopback and
    cloud-metadata addresses are refused) and fetched in the background, so a slow site
    never blocks the save and never blocks a run. Needs `audits:write`.

    Examples:

    * `fp audits context-set nightly-prod --text "checkout agent for a retail store"`
    * `fp audits context-set nightly-prod --url https://docs.example.com/runbook`
    * `fp audits context-set nightly-prod --text ""` — clear the brief
    * `fp audits context-set nightly-prod --clear-urls` — drop the pages
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    body_text = _context_text(text, text_file)
    urls = _context_urls(url)
    if clear_urls and urls:
        raise typer.BadParameter("pass --url or --clear-urls, not both.", param_hint="--clear-urls")
    if body_text is None and not urls and not clear_urls:
        raise typer.BadParameter(
            "nothing to change — pass --text, --text-file, --url or --clear-urls.",
            param_hint="--text",
        )

    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    # The endpoint is a FULL replacement, so anything the caller did not name has
    # to be read back and re-sent. Both halves, symmetrically: this used to merge
    # the brief and not the URLs, which made `--text` alone a silent delete of
    # every reference page — the read-merge-allowlist class recorded in
    # models.py:116, in miniature.
    if body_text is None or not (urls or clear_urls):
        current = api.get_audit_context(cctx, audit.id)
        if body_text is None:
            body_text = current.get("text", "")
        if not urls and not clear_urls:
            urls = [str(s.get("url") or "") for s in (current.get("sources") or [])]
            urls = [u for u in urls if u]
    result = api.put_audit_context(cctx, audit.id, {"text": body_text, "urls": urls})
    # Shape only — how many URLs, never which. The name is `url_count` because that is
    # what the dashboard sends for this same quantity (the API field is
    # `reference_url_count`); the CLI used to send `count`, so one event carried two
    # property names and neither answered it alone. It is on _SAFE_PROP_KEYS —
    # anything not on that allowlist is dropped silently, so a renamed property needs
    # its entry there in the same change or it never existed.
    # `via` names the surface this was written from, so the one series splits
    # into create / settings / cli rather than answering "somebody saved
    # context" and nothing more. The dashboard emits the other two values.
    # Already on _SAFE_PROP_KEYS, so it survives the allowlist.
    _write.record_action(
        "audit_context_saved", resource="audit", success=True, via="cli", url_count=len(urls)
    )
    if state.json:
        output.emit_json(result)
    else:
        output.audit_context_saved(audit.name, result)


def audits_context_refresh(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id)."),
) -> None:
    """Re-fetch every reference URL on an audit.

    Snapshots refresh on their own weekly, so this is for when you know a page changed
    and want it picked up now. URLs the guard refused are not retried — nothing about
    them can change until the URL itself does. Needs `audits:write`.

    Example:

    * `fp audits context-refresh nightly-prod`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    result = api.refresh_audit_context(cctx, audit.id)
    # `url_count` is how many URLs the server queued, under the same property name the
    # dashboard sends — see the note in `audits_context_set`.
    _write.record_action(
        "audit_context_refreshed", resource="audit", success=True,
        url_count=int(result.get("queued") or 0),
    )
    if state.json:
        output.emit_json(result)
    else:
        output.audit_context_refreshed(audit.name, result)


def audits_runs(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Audit name (or id)."),
    limit: int = typer.Option(50, "--limit", "-n", help="Max runs to show (the server returns the 50 most recent)."),
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short run-id column (the full id is always in --json)."),
) -> None:
    """List an audit's run history in a boxed table, newest first.

    Shows `started · status · trigger · findings · new · took` — `findings` is the run's total,
    `new` the count first seen in that run, `took` the wall time (`-` while a run is still going).
    A failed run's `error` and each run's `stats`/`report` live in `--json`. Needs `audits:read`.
    With `--json`: `{"runs": [{id, status, trigger_kind, window_from, window_to, started_at,
    finished_at, stats, findings_count, new_findings_count, report, error}]}`.

    Example:

    * `fp audits runs nightly-prod --limit 10`
    """
    state: AppState = ctx.obj
    validate_limit(limit)
    cctx = require_auth(state)
    audit = _resolve_audit_or_exit(api.list_audits(cctx), name)
    runs = api.list_audit_runs(cctx, audit.id)[:limit]
    if state.json:
        output.emit_json({"runs": runs})
        return
    output.render_audit_runs(runs, name=audit.name, show_id=show_id)
    output.audit_runs_footer(runs)


def audits_findings(
    ctx: typer.Context,
    audit: Optional[str] = typer.Option(None, "--audit", help="Only findings from this audit (name, or id)."),
    run_id: Optional[str] = typer.Option(None, "--run-id", help="Only findings produced or updated by this run."),
    status: Optional[str] = typer.Option(None, "--status", help=f"Filter by status: {', '.join(_FINDING_STATUSES)} (CSV; default: open + recurring)."),
    limit: int = typer.Option(100, "--limit", "-n", help="Max findings to return (server caps at 500)."),
    offset: int = typer.Option(0, "--offset", help="Skip this many findings (paging)."),
    show_id: bool = typer.Option(False, "--show-id", help="Show full finding ids instead of the short form (always full in --json)."),
) -> None:
    """List findings across audits in a boxed table, highest priority first.

    Shows `id · title · severity · status · kind · seen · last` — the id is the handle the triage
    commands take (short by default, full with `--show-id`); `kind` separates a `failure` from a
    `policy` violation or an `improvement`; `seen` is the occurrence count and `last` the age of the
    most recent sighting. With no `--status` the server returns the live set (open + recurring).
    Suppressed findings are dimmed; a status/severity breakdown is in the footer. `--audit` takes an
    audit **name**. Needs `audits:read`. With `--json`: `{"findings": [{id, audit_id, audit_name,
    title, severity, status, kind, priority, occurrences, last_seen_at, recommendation, ...}]}`.

    Examples:

    * `fp audits findings --status open --limit 20`
    * `fp audits findings --audit nightly-prod`
    """
    state: AppState = ctx.obj
    _validate_statuses(status)
    validate_limit(limit)
    if offset < 0:
        raise typer.BadParameter("must be zero or a positive integer.", param_hint="--offset")
    cctx = require_auth(state)
    audit_id = None
    if audit:
        audit_id = _resolve_audit_or_exit(api.list_audits(cctx), audit).id
    findings = api.list_audit_findings(
        cctx, audit_id=audit_id, run_id=run_id, status=status, limit=limit, offset=offset
    )
    if state.json:
        output.emit_json({"findings": findings})
        return
    output.render_findings(findings, show_id=show_id)
    output.findings_footer(findings)


def audits_finding(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
) -> None:
    """Show one finding in full — a stack of cards: identity, analysis, recommendation, evidence.

    The identity card carries severity · status · kind · magnitude, how often it's been seen, the
    owning audit and any assignee; `analysis` holds the description and the root-cause hypothesis,
    `recommendation` the suggested fix with its expected impact and effort. Empty sections are
    omitted. Not-found (or a malformed id) → `✗ no finding <id>`, exit 6. Needs `audits:read`.
    With `--json`: the full `AuditFinding` (untouched `evidence`/`evidence_queries`/`scope`).

    Example:

    * `fp audits finding <id>`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        finding = api.get_audit_finding(cctx, finding_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, finding_id=finding_id)
    if state.json:
        output.emit_json(finding)
        return
    output.render_finding_show(finding)


def _triage(
    ctx: typer.Context,
    action: str,
    finding_id: str,
    *,
    reason: Optional[str] = None,
    assigned_to: Optional[str] = None,
    assume_yes: bool = True,
) -> None:
    """The shared body behind every triage verb: validate → (confirm) → POST the status action →
    record → render. The suppressing/closing actions (mute/dismiss/resolve) confirm first; ack,
    reopen and assign act immediately (they're calm and reversible)."""
    state: AppState = ctx.obj
    _validate_action(action)
    cctx = require_auth(state)
    if action in _CONFIRMING_ACTIONS and _write.should_prompt(state, assume_yes):
        title = None
        try:
            title = api.get_audit_finding(cctx, finding_id).title
        except NotFoundError as exc:
            _fail(state, exc, finding_id=finding_id)
        except (ApiError, ForbiddenError):
            title = None
        if not output.confirm_finding_action(action, finding_id, title=title):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing changed")
            return
    try:
        result = api.set_finding_status(
            cctx, finding_id, action=action, reason=reason, assigned_to=assigned_to
        )
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, finding_id=finding_id)
    _write.record_action(f"finding_{action}", resource="finding", success=True)
    if state.json:
        output.emit_json(result)
    else:
        output.finding_triaged(action, finding_id, assigned_to=assigned_to)


def findings_ack(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
    reason: Optional[str] = typer.Option(None, "--reason", help="Why you're acknowledging it (kept as durable feedback)."),
) -> None:
    """Acknowledge a finding — you've seen it and it stays visible, just deprioritized.

    The gentlest triage verb: the status doesn't change, but the acknowledgement is recorded as
    durable feedback so later runs rank the pattern lower. No confirm (it isn't destructive).
    Needs `audits:write`. With `--json`: `{id, action, ok}`.

    Example:

    * `fp audits ack <finding-id> --reason "known, fix is queued"`
    """
    _triage(ctx, "ack", finding_id, reason=reason)


def findings_mute(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
    reason: Optional[str] = typer.Option(None, "--reason", help="Why you're muting it (kept as durable feedback)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Mute a finding — stop future runs surfacing this pattern at all.

    The strongest "don't show me this again" action: the finding goes to `muted` and the
    suppression is durable, so a re-detection of the same fingerprint stays hidden until you
    `reopen` it. Confirms first (`--yes` skips). Needs `audits:write`. With `--json`:
    `{id, action, ok}` (or `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp audits mute <finding-id> --reason "expected in staging" --yes`
    """
    _triage(ctx, "mute", finding_id, reason=reason, assume_yes=yes)


def findings_dismiss(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
    reason: Optional[str] = typer.Option(None, "--reason", help="Why you're dismissing it (kept as durable feedback)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Dismiss a finding — it's not worth acting on.

    Sets the status to `dismissed` and records durable feedback so the pattern is suppressed in
    later runs (like `mute`, but the label says "judged not a problem" rather than "hide this").
    Confirms first (`--yes` skips). Needs `audits:write`. With `--json`: `{id, action, ok}` (or
    `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp audits dismiss <finding-id> --reason "false positive" --yes`
    """
    _triage(ctx, "dismiss", finding_id, reason=reason, assume_yes=yes)


def findings_resolve(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Resolve a finding — you fixed it.

    Sets the status to `resolved` and leaves **no** suppression behind, deliberately: if the
    pattern genuinely comes back, the next run should raise it as new. Confirms first (`--yes`
    skips). Needs `audits:write`. With `--json`: `{id, action, ok}` (or `{"cancelled": true}` on a
    declined prompt).

    Example:

    * `fp audits resolve <finding-id> --yes`
    """
    _triage(ctx, "resolve", finding_id, assume_yes=yes)


def findings_reopen(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
) -> None:
    """Re-open a finding — put it back in the live queue.

    Sets the status back to `open` **and clears any mute/dismiss suppression**, so the pattern can
    rank and resurface normally. The undo for `mute`/`dismiss`/`resolve`. No confirm (it only makes
    things more visible). Needs `audits:write`. With `--json`: `{id, action, ok}`.

    Example:

    * `fp audits reopen <finding-id>`
    """
    _triage(ctx, "reopen", finding_id)


def findings_assign(
    ctx: typer.Context,
    finding_id: str = typer.Argument(..., metavar="FINDING_ID", help="Finding id."),
    assignee: str = typer.Option(..., "--to", help="Email of the person who owns this finding."),
) -> None:
    """Assign a finding to someone (sets its owner; the status is untouched).

    `--to` is required — the server rejects an assign without one. Re-running it reassigns.
    No confirm (it isn't destructive). Needs `audits:write`. With `--json`: `{id, action, ok}`.

    Example:

    * `fp audits assign <finding-id> --to alice@example.com`
    """
    _triage(ctx, "assign", finding_id, assigned_to=assignee)


_AUDITS_GROUP_HELP = """Schedule audits over your agent activity and triage the findings they produce.

An **audit** runs on a schedule and sweeps a window of activity; what it produces are **findings** —
recurring patterns carried across runs. Audits are referenced by **name**, findings by **id**.

**Subcommands:** `list` · `show` · `create` · `edit` · `delete` · `run` · `runs` · `findings` ·
`finding` · `ack` · `mute` · `dismiss` · `resolve` · `reopen` · `assign`

**Examples:**

* `fp audits list` — all audits, newest first
* `fp audits show nightly-prod` — one audit's schedule / scope / analysis / channels
* `fp audits create nightly-prod --scope '{"environments":["prod"]}'`
* `fp audits run nightly-prod` — queue a run now, ahead of schedule
* `fp audits findings --status open` — the live triage queue, highest priority first
* `fp audits finding <id>` — one finding in full, with its recommendation
* `fp audits resolve <id>` — you fixed it · `mute` / `dismiss` to suppress · `reopen` to undo
"""


def register(app: typer.Typer) -> None:
    audits_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help=_AUDITS_GROUP_HELP,
    )
    audits_app.command("list", epilog=GLOBALS_EPILOG)(audits_list)
    audits_app.command("show", epilog=GLOBALS_EPILOG)(audits_show)
    audits_app.command("create", epilog=GLOBALS_EPILOG)(audits_create)
    audits_app.command("edit", epilog=GLOBALS_EPILOG)(audits_edit)
    audits_app.command("delete", epilog=GLOBALS_EPILOG)(audits_delete)
    audits_app.command("run", epilog=GLOBALS_EPILOG)(audits_run)
    audits_app.command("runs", epilog=GLOBALS_EPILOG)(audits_runs)
    # Hyphenated rather than a nested `context` sub-group: the group's help is a
    # hand-maintained table (output.py `_TOP_LEVEL_GROUPS`), and a third level
    # would not render in it.
    audits_app.command("context-show", epilog=GLOBALS_EPILOG)(audits_context_show)
    audits_app.command("context-set", epilog=GLOBALS_EPILOG)(audits_context_set)
    audits_app.command("context-refresh", epilog=GLOBALS_EPILOG)(audits_context_refresh)
    audits_app.command("findings", epilog=GLOBALS_EPILOG)(audits_findings)
    audits_app.command("finding", epilog=GLOBALS_EPILOG)(audits_finding)
    audits_app.command("ack", epilog=GLOBALS_EPILOG)(findings_ack)
    audits_app.command("mute", epilog=GLOBALS_EPILOG)(findings_mute)
    audits_app.command("dismiss", epilog=GLOBALS_EPILOG)(findings_dismiss)
    audits_app.command("resolve", epilog=GLOBALS_EPILOG)(findings_resolve)
    audits_app.command("reopen", epilog=GLOBALS_EPILOG)(findings_reopen)
    audits_app.command("assign", epilog=GLOBALS_EPILOG)(findings_assign)
    app.add_typer(audits_app, name="audits")
