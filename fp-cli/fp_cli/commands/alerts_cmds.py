"""Alert definitions: alerts list / show / create / update / delete / test.

Alerts are referenced by their **name** (unique per org). An alert is a **trigger** (a condition,
shaped per ``trigger_kind`` — e.g. a metric threshold, a custom SQL count, an evaluation-score
rule) plus an **evaluation** cadence and a set of notification **channels**. The trigger body
(``trigger_spec``) + ``channels`` are opaque/union JSON, so create/update take them as JSON flags
or a full payload via ``--file``/stdin, with a few common scalar fields available as convenience
overrides layered on top.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth
from ..models import Alert
from . import _write

_TRIGGER_KINDS = ("metric_threshold", "custom_sql", "evaluation_score", "eval_compound", "per_event")
_SEVERITIES = ("info", "warning", "critical")


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
    return parsed


def _apply_overrides(body: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
    for key, value in overrides.items():
        if value is not None:
            body[key] = value
    return body


def _alert_to_body(alert: Alert) -> Dict[str, Any]:
    """The writable AlertBody fields of an existing alert, used as the merge base for
    a flag-only update.

    The server's ``PUT /api/alerts/{id}`` is a **full replace** (it overwrites every
    column), so a single-field edit must resend the whole alert. We seed the body from
    the current alert and let the override flags change just the named fields — the
    same read-merge ``users update`` already does."""
    return {
        "name": alert.name,
        "description": alert.description,
        "enabled": alert.enabled,
        "trigger_kind": alert.trigger_kind,
        "trigger_spec": alert.trigger_spec,
        "min_breaches": alert.min_breaches,
        "eval_window": alert.eval_window,
        "eval_interval_secs": alert.eval_interval_secs,
        "severity": alert.severity,
        "channels": alert.channels,
    }


def _validate_alert(body: Dict[str, Any], *, require_core: bool) -> None:
    if require_core:
        if not body.get("name"):
            raise typer.BadParameter("alert 'name' is required (in --file or via --name).")
        if not body.get("trigger_kind"):
            raise typer.BadParameter("alert 'trigger_kind' is required (in --file or via --trigger-kind).")
        if body.get("trigger_spec") is None:
            raise typer.BadParameter("alert 'trigger_spec' is required (provide it in --file or --trigger-spec).")
    if body.get("trigger_kind") and body["trigger_kind"] not in _TRIGGER_KINDS:
        raise typer.BadParameter(f"trigger_kind must be one of: {', '.join(_TRIGGER_KINDS)}.")
    if body.get("severity") and body["severity"] not in _SEVERITIES:
        raise typer.BadParameter(f"severity must be one of: {', '.join(_SEVERITIES)}.")
    mb, ew = body.get("min_breaches"), body.get("eval_window")
    if isinstance(mb, int) and mb < 1:
        raise typer.BadParameter("min_breaches must be >= 1.")
    if isinstance(ew, int) and ew < 1:
        raise typer.BadParameter("eval_window must be >= 1.")
    if isinstance(mb, int) and isinstance(ew, int) and mb > ew:
        raise typer.BadParameter("min_breaches cannot exceed eval_window.")
    eis = body.get("eval_interval_secs")
    if isinstance(eis, int) and not (30 <= eis <= 86400):
        raise typer.BadParameter("eval_interval_secs must be between 30 and 86400.")


def _parse_json_opt(value: Optional[str], hint: str) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{hint} is not valid JSON: {exc}", param_hint=hint)


def _refetch_alert(cctx, name: Optional[str]) -> Optional[Alert]:
    """Re-read the canonical stored alert by name after a create/update (the server busts the
    list cache on write, so this reflects the saved state incl. server-applied defaults). Returns
    ``None`` on any miss so the caller can fall back to rendering from the request body."""
    if not name:
        return None
    try:
        for a in api.list_alerts(cctx):
            if a.name == name:
                return a
    except Exception:
        return None
    return None


def _alert_from_body(body: Dict[str, Any], base: Optional[Alert] = None) -> Alert:
    """Build an ``Alert`` view from a create/update request body (fallback when the canonical
    re-fetch misses). ``base`` (the pre-update alert) supplies id/created/open-incidents context;
    for a create there is none, so those default to empty/0."""
    return Alert(
        id=base.id if base else "",
        name=body.get("name") or (base.name if base else ""),
        description=body.get("description") if body.get("description") is not None else (base.description if base else None),
        enabled=body.get("enabled", base.enabled if base else True),
        trigger_kind=body.get("trigger_kind") or (base.trigger_kind if base else ""),
        trigger_spec=body.get("trigger_spec") or (base.trigger_spec if base else {}),
        min_breaches=body.get("min_breaches", base.min_breaches if base else 1),
        eval_window=body.get("eval_window", base.eval_window if base else 1),
        eval_interval_secs=body.get("eval_interval_secs", base.eval_interval_secs if base else 0),
        severity=body.get("severity") or (base.severity if base else ""),
        channels=body.get("channels") if body.get("channels") is not None else (base.channels if base else []),
        created_by=base.created_by if base else "",
        created_at=base.created_at if base else "",
        updated_at="",
        last_attempted_at=base.last_attempted_at if base else None,
        open_incidents=base.open_incidents if base else 0,
    )


def _resolve_alert_or_exit(state: AppState, alerts, handle: str) -> Alert:
    """Resolve an alert by **name** (primary), falling back to an exact id match, raising a typed
    error the central chokepoint renders: none → exit 6, several → exit 2."""
    return _write.resolve_one(alerts, handle, kind="alert", list_cmd="alerts list")


def alerts_list(
    ctx: typer.Context,
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short alert-id column (the full id is always in --json)."),
) -> None:
    """List alert definitions in a boxed table, newest first.

    Shows `created · name · by · trigger · severity · last alert` — `by` the creator's email,
    severity colour-coded, and `last alert` the humanized age of the last evaluation (`never` if it
    has never run, e.g. a disabled alert). Disabled alerts are dimmed; the on/off split is in the
    footer. `name` is the handle action commands take; the raw id is hidden unless `--show-id`.
    Needs `alerts:read`. With `--json`: `{"alerts": [{id, name, created_by, trigger_kind, severity,
    enabled, last_attempted_at, created_at, open_incidents, ...}]}`.

    Example:

    * `fp alerts list`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    alerts = api.list_alerts(cctx)
    if state.json:
        output.emit_json({"alerts": alerts})
        return
    output.render_alerts(alerts, show_id=show_id)
    output.alerts_footer(alerts)


def alerts_show(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Alert name (or id)."),
) -> None:
    """Show one alert as a stack of parsed cards — identity, trigger, evaluation, channels.

    Referenced by alert **name** (a UUID-shaped id is also accepted). The `trigger_spec` is parsed
    into a human sentence per `trigger_kind`, and `channels` shows default-vs-custom per channel.
    Not-found → red `✗ no alert named "…"`, exit 6. Needs `alerts:read`. With `--json`: the full
    raw `Alert` (untouched `trigger_spec` + `channels`).

    Example:

    * `fp alerts show metric-threshold-alert`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    alert = _resolve_alert_or_exit(state, api.list_alerts(cctx), name)
    if state.json:
        output.emit_json(alert)
        return
    output.render_alert_show(alert)


def _common_overrides(name, description, severity, trigger_kind, eval_interval_secs, min_breaches, eval_window, trigger_spec, channels):
    return dict(
        name=name,
        description=description,
        severity=severity,
        trigger_kind=trigger_kind,
        eval_interval_secs=eval_interval_secs,
        min_breaches=min_breaches,
        eval_window=eval_window,
        trigger_spec=_parse_json_opt(trigger_spec, "--trigger-spec"),
        channels=_parse_json_opt(channels, "--channels"),
    )


def alerts_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Alert name (unique per org)."),
    file: Optional[str] = typer.Option(None, "--file", help="Full alert JSON (AlertInput) to base it on, or `-` for stdin."),
    description: Optional[str] = typer.Option(None, "--description", help="Description (overrides --file)."),
    severity: Optional[str] = typer.Option(None, "--severity", help=f"Severity: {', '.join(_SEVERITIES)} (overrides --file)."),
    trigger_kind: Optional[str] = typer.Option(None, "--trigger-kind", help=f"What kind of trigger: {', '.join(_TRIGGER_KINDS)} (overrides --file)."),
    trigger_spec: Optional[str] = typer.Option(None, "--trigger-spec", help="Trigger spec as JSON — the condition, shaped per trigger kind (overrides --file)."),
    channels: Optional[str] = typer.Option(None, "--channels", help="Channels as a JSON array, e.g. `[{\"kind\":\"email\"}]` (overrides --file)."),
    eval_interval_secs: Optional[int] = typer.Option(None, "--eval-interval-secs", help="How often to evaluate, in seconds (30–86400)."),
    min_breaches: Optional[int] = typer.Option(None, "--min-breaches", help="Breaches within the window required to fire."),
    eval_window: Optional[int] = typer.Option(None, "--eval-window", help="Evaluation window size (number of intervals)."),
) -> None:
    """Create an alert and show it rendered as parsed cards.

    Give the alert a **name** (positional), then define it inline with the flags or base it on a
    full JSON payload via `--file` (flags layer on top). The core pieces are `--trigger-kind` +
    `--trigger-spec` (the condition) and `--severity`; the rest have sensible server defaults. On
    success the new alert renders the same way `alerts show` does (identity + trigger + evaluation
    + channels) in a green "alert created" card. Creating isn't destructive, so there's no confirm.
    A name collision is rejected up front. New alerts start **enabled**. Needs `alerts:write`. With
    `--json`: `{id, created_at}`.

    Examples:

    * `fp alerts create high-errors --trigger-kind metric_threshold --severity warning \\
        --trigger-spec '{"metric":"error_count","op":">","value":50,"window_secs":900}'`
    * `fp alerts create high-errors --file alert.json` — base it on a saved AlertInput
    * `fp alerts create high-errors --file alert.json --severity critical` — file + an override
    """
    state: AppState = ctx.obj
    body = _load_file(file)
    _apply_overrides(body, **_common_overrides(name, description, severity, trigger_kind, eval_interval_secs, min_breaches, eval_window, trigger_spec, channels))
    _validate_alert(body, require_core=True)
    cctx = require_auth(state)
    if any(a.name == body.get("name") for a in api.list_alerts(cctx)):  # names are the handle → unique
        raise click.UsageError(f'an alert named "{body.get("name")}" already exists')
    result = api.create_alert(cctx, body)
    _write.record_action("alert_created", resource="alert", success=True, trigger_kind=body.get("trigger_kind"))
    if state.json:
        output.emit_json(result)
        return
    # Re-read the canonical stored alert (server defaults applied) for the rendered cards.
    alert = _refetch_alert(cctx, body.get("name")) or _alert_from_body(body)
    output.render_alert_created(alert)


def alerts_update(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Alert name (or id) to update."),
    new_name: Optional[str] = typer.Option(None, "--name", help="Rename the alert."),
    file: Optional[str] = typer.Option(None, "--file", help="Full alert JSON (AlertInput) to replace it with, or `-` for stdin."),
    description: Optional[str] = typer.Option(None, "--description", help="New description."),
    severity: Optional[str] = typer.Option(None, "--severity", help=f"New severity: {', '.join(_SEVERITIES)}."),
    trigger_kind: Optional[str] = typer.Option(None, "--trigger-kind", help=f"New trigger kind: {', '.join(_TRIGGER_KINDS)}."),
    trigger_spec: Optional[str] = typer.Option(None, "--trigger-spec", help="New trigger spec as JSON."),
    channels: Optional[str] = typer.Option(None, "--channels", help="New channels as a JSON array."),
    eval_interval_secs: Optional[int] = typer.Option(None, "--eval-interval-secs", help="New evaluation interval in seconds (30–86400)."),
    min_breaches: Optional[int] = typer.Option(None, "--min-breaches", help="New breaches-to-fire."),
    eval_window: Optional[int] = typer.Option(None, "--eval-window", help="New evaluation window size."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Update an alert, referenced by **name** (or a UUID-shaped id). Two ways to change it:

    * **Tweak fields** with the override flags (e.g. `--severity critical`, `--name new-name`).
      Because the server replaces the whole alert on update, the CLI re-sends the current alert
      with your changes applied — so a flag-only edit needs `alerts:read` **and** `alerts:write`.
    * **Replace wholesale** with `--file` (a complete AlertInput), optionally layering a few
      override flags on top.

    It confirms first (default no; `--yes` skips) and renders the new state as a green "alert
    updated" card. With `--json`: `{id, updated_at}`.

    Examples:

    * `fp alerts update high-errors --severity critical` — change one field
    * `fp alerts update high-errors --name critical-errors --yes` — rename, no prompt
    * `fp alerts update high-errors --file alert.json --yes` — replace the whole definition
    """
    state: AppState = ctx.obj
    overrides = _common_overrides(new_name, description, severity, trigger_kind, eval_interval_secs, min_breaches, eval_window, trigger_spec, channels)
    cctx = require_auth(state)
    existing = api.list_alerts(cctx)
    alert = _resolve_alert_or_exit(state, existing, name)
    if file is not None:
        # An explicit full body is a straight replace (existing behaviour).
        body = _load_file(file)
        _apply_overrides(body, **overrides)
        _validate_alert(body, require_core=False)
    else:
        # Flag-only edit: the server's PUT is a full replace, so seed the body from the resolved
        # alert and overlay just the changed fields (read-merge, like `users update`).
        body = _alert_to_body(alert)
        _apply_overrides(body, **overrides)
        _validate_alert(body, require_core=True)
    final_name = body.get("name") or alert.name
    if final_name != alert.name and any(a.name == final_name and a.id != alert.id for a in existing):
        raise click.UsageError(f'an alert named "{final_name}" already exists')
    if _write.should_prompt(state, yes):
        if not output.confirm_alert_update(alert.name):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.print_cancelled("nothing changed")
            return
    result = api.update_alert(cctx, alert.id, body)
    _write.record_action("alert_updated", resource="alert", success=True)
    if state.json:
        output.emit_json(result)
        return
    final_name = body.get("name") or alert.name
    updated = _refetch_alert(cctx, final_name) or _alert_from_body(body, base=alert)
    output.render_alert_updated(updated, old_name=alert.name)


def alerts_delete(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Alert name (or id) to delete."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Delete an alert, referenced by **name** (or a UUID-shaped id). This cannot be undone.

    Shows an amber preview of the alert (incl. its open-incident count, which the delete orphans)
    then confirms. Needs `alerts:write`. With `--json`: `{"deleted": true, "id", "name"}` (or
    `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp alerts delete old-test-alert`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    alert = _resolve_alert_or_exit(state, api.list_alerts(cctx), name)
    if _write.should_prompt(state, yes):
        output.render_alert_delete_preview(alert)  # amber preview of what's about to go
        if not output.confirm_alert_delete(alert.open_incidents):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.print_cancelled("nothing deleted")
            return
    api.delete_alert(cctx, alert.id)
    _write.record_action("alert_deleted", resource="alert", success=True, destructive=True)
    if state.json:
        output.emit_json({"deleted": True, "id": alert.id, "name": alert.name})
    else:
        output.alert_deleted(alert.name)


def _test_channel_kinds(alert: Alert, override: Any) -> list:
    """The channel kinds a test will dispatch to: the ``--channels`` override if given, else the
    alert's saved channels, else (empty) the default set (slack/webhook/email)."""
    chans = override if override is not None else (alert.channels or [])
    if not chans:
        return ["slack", "webhook", "email"]
    kinds: list = []
    for c in chans:
        if isinstance(c, dict):
            k = c.get("kind")
            if k and k not in kinds:
                kinds.append(k)
    return kinds


def alerts_test(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Alert name (or id) to test."),
    channels: Optional[str] = typer.Option(None, "--channels", help="Channels as a JSON array (else uses the alert's saved channels)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Fire a test notification for an alert — really sends to its email/Slack/webhook channels.

    Referenced by alert **name** (a UUID-shaped id is also accepted). Confirms first (it delivers
    real notifications; `--yes` skips), then reports which channels it dispatched to. Note: the
    server reports success as soon as it dispatches — actual delivery isn't confirmed. Needs
    `alerts:write`. With `--json`: `{ok, synthetic_incident_id}` (or `{cancelled: true}`).

    Example:

    * `fp alerts test metric-threshold-alert`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    alert = _resolve_alert_or_exit(state, api.list_alerts(cctx), name)
    override = _parse_json_opt(channels, "--channels")
    if _write.should_prompt(state, yes):
        if not output.confirm_alert_test(alert.name):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.print_cancelled("nothing sent")
            return
    result = api.test_alert(cctx, alert.id, override)
    _write.record_action("alert_tested", resource="alert", success=True)
    if state.json:
        output.emit_json(result)
        return
    output.alert_test_sent(alert.name, _test_channel_kinds(alert, override))


_ALERTS_GROUP_HELP = """Manage alert definitions — list, inspect, create, edit, delete, and test-fire them.

Alerts are referenced by **name** (unique per org). Each is a **trigger** (a condition shaped per
`--trigger-kind`) + an evaluation cadence + notification **channels** (email / Slack / webhook).

**Subcommands:** `list` · `show` · `create` · `update` · `delete` · `test`

**Examples:**

* `fp alerts list` — all alerts, newest first
* `fp alerts show high-errors` — one alert's trigger / evaluation / channels
* `fp alerts create high-errors --trigger-kind metric_threshold --severity warning --trigger-spec '{"metric":"error_count","op":">","value":50,"window_secs":900}'`
* `fp alerts update high-errors --severity critical` — change a field
* `fp alerts test high-errors` — fire a sample notification to its channels
* `fp alerts delete high-errors` — remove it
"""


def register(app: typer.Typer) -> None:
    alerts_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help=_ALERTS_GROUP_HELP,
    )
    alerts_app.command("list", epilog=GLOBALS_EPILOG)(alerts_list)
    alerts_app.command("show", epilog=GLOBALS_EPILOG)(alerts_show)
    alerts_app.command("create", epilog=GLOBALS_EPILOG)(alerts_create)
    alerts_app.command("update", epilog=GLOBALS_EPILOG)(alerts_update)
    alerts_app.command("delete", epilog=GLOBALS_EPILOG)(alerts_delete)
    alerts_app.command("test", epilog=GLOBALS_EPILOG)(alerts_test)
    app.add_typer(alerts_app, name="alerts")
