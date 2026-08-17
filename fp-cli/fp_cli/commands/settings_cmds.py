"""Org settings: settings list / schema / set.

Settings are a FIXED registry — you can read them (``list``), inspect what each accepts
(``schema``), and change an existing key's value (``set``). You can't create new keys.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth
from ..errors import NotFoundError
from . import _write


def settings_list(ctx: typer.Context) -> None:
    """List the org's settings and their current values in a boxed table.

    Shows `key · value · type · updated` — the value rendered type-aware (lists comma-joined,
    numbers pink, secrets masked), truncated to one line (full values in `--json`). `key` is the
    handle `settings set` takes. Needs `settings:read`. With `--json`: `{"settings": [{key, value,
    updated_at, updated_by, scope, schema}]}`.

    Example:

    * `fp settings list`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    rows = api.list_settings(cctx)
    if state.json:
        output.emit_json({"settings": rows})
        return
    output.render_settings(rows, current_email=state.config.email)


def settings_schema(ctx: typer.Context) -> None:
    """Show the settings registry — what each key is and what it accepts.

    A boxed `key · type · accepts · description` table derived from each setting's `schema` blob
    (there is no separate schema endpoint). `accepts` summarizes the constraints (int range + unit,
    channel options, …). Needs `settings:read`. With `--json`: `{"settings": [<schema entries>]}`.

    Example:

    * `fp settings schema`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    schema = api.get_settings_schema(cctx)
    if state.json:
        output.emit_json({"settings": schema})
        return
    output.render_settings_schema(schema)


def settings_set(
    ctx: typer.Context,
    key: str = typer.Argument(..., help="Setting key to update (must be an existing key — see `settings list`)."),
    value: Optional[str] = typer.Option(None, "--value", help="Scalar value (string; a digit-only value is sent as an integer)."),
    json_value: Optional[str] = typer.Option(None, "--json-value", help="Raw JSON value, for arrays/objects (e.g. `[\"a@b.com\"]`)."),
    file: Optional[str] = typer.Option(None, "--file", help="Read a JSON value from a file, or `-` for stdin."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Change one org setting's value, showing the before → after.

    Provide the value exactly one way: `--value` (scalar), `--json-value` (raw JSON for
    arrays/objects), or `--file`/stdin (JSON). The CLI checks the key exists, shows the change and
    confirms (a no-op is skipped), then renders the updated value. Needs `settings:write`. Unknown
    key → exit 6; an invalid value → the server's clean message, exit non-zero. With `--json`: the
    updated `SettingRow` (or `{cancelled: true}`).

    Examples:

    * `fp settings set session_ttl_secs --value 86400`
    * `fp settings set alerts.email_default_recipients --json-value '["a@b.com"]'`
    """
    state: AppState = ctx.obj
    provided = [v is not None for v in (value, json_value, file)]
    if sum(provided) != 1:
        raise typer.BadParameter("Provide exactly one of --value, --json-value, or --file.")

    if value is not None:
        # `str.isdigit()` accepts characters int() rejects (superscripts, "--5"); just try the
        # conversion and fall back to the string, so a non-int value is never an uncaught traceback.
        try:
            parsed: Any = int(value)
        except ValueError:
            parsed = value
    elif json_value is not None:
        try:
            parsed = json.loads(json_value)
        except json.JSONDecodeError as exc:
            raise typer.BadParameter(f"--json-value is not valid JSON: {exc}", param_hint="--json-value")
    else:
        raw = _write.read_text_arg(file)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise typer.BadParameter(f"--file is not valid JSON: {exc}", param_hint="--file")

    cctx = require_auth(state)
    current = next((s for s in api.list_settings(cctx) if s.key == key), None)
    if current is None:  # settings are a fixed registry — an unknown key can't be created
        raise NotFoundError(
            f'no setting named "{key}"', hint="run `fp settings list` to see them"
        )
    kind = (current.schema or {}).get("kind", "") if isinstance(current.schema, dict) else ""

    if parsed == current.value:  # no-op — don't call the server or prompt (secrets always blank)
        if state.json:
            output.emit_json(current)
        else:
            output.setting_no_change(key, current.value, kind)
        return

    if _write.should_prompt(state, yes):
        if not output.confirm_setting_change(key, current.value, parsed, kind):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.print_cancelled("nothing changed")
            return

    # An invalid value (422) / unknown key (404) propagates as a typed error to the central
    # chokepoint (JSON envelope under --json, red box otherwise).
    row = api.put_setting(cctx, key, parsed)
    _write.record_action("setting_updated", resource="setting", success=True)
    if state.json:
        output.emit_json(row)
        return
    output.render_setting_updated(row, kind)


def register(app: typer.Typer) -> None:
    settings_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="View and update org settings (list / schema / set).",
    )
    settings_app.command("list", epilog=GLOBALS_EPILOG)(settings_list)
    settings_app.command("schema", epilog=GLOBALS_EPILOG)(settings_schema)
    settings_app.command("set", epilog=GLOBALS_EPILOG)(settings_set)
    app.add_typer(settings_app, name="settings")
