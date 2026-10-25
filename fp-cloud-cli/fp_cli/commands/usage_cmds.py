"""usage — show the active organization's current billing-window usage."""

from __future__ import annotations

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth


def usage(ctx: typer.Context) -> None:
    """Show usage for the active org's current fixed 30-day metering window.

    Reports telemetry, evaluations, workspace objects, audits, API keys, and members. This is
    read-only and does not apply or display limits. Needs `usage:read`.

    With `--json`, returns the dashboard response unchanged: `org_id`, `billing_anchor`,
    `window`, `usage`, `calculated_at`, and `stale_after`.

    Examples:

    * `fp usage`
    * `fp --json usage | jq '.usage.events_ingested'`
    """
    if ctx.invoked_subcommand:
        return
    state: AppState = ctx.obj
    data = api.get_usage(require_auth(state))
    if state.json:
        output.emit_json(data)
        return
    output.render_usage(data)


def register(app: typer.Typer) -> None:
    group = typer.Typer(invoke_without_command=True, rich_markup_mode="markdown", context_settings={"help_option_names": ["-h", "--help"]})
    group.callback(epilog=GLOBALS_EPILOG)(usage)
    group.command("windows", epilog=GLOBALS_EPILOG)(usage_windows)
    app.add_typer(group, name="usage")


def usage_windows(ctx: typer.Context) -> None:
    """List usage metering windows. API key only (the dashboard has no session route)."""
    from .account_cmds import request
    from ..client import AuthMode
    from ..errors import KeyModeUnsupportedError
    if ctx.obj.auth_mode is not AuthMode.API_KEY:
        # GET /usage/windows is served on the versioned API only; a signed-in
        # session would reach a dashboard 404 and print a misleading message.
        raise KeyModeUnsupportedError(
            "`fp usage windows` needs an API key — the dashboard has no session route for it.",
            hint="pass --api-key (or FP_API_KEY) with a usage:read key",
        )
    request(ctx, "GET", "/api/usage/windows")
