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
    state: AppState = ctx.obj
    data = api.get_usage(require_auth(state))
    if state.json:
        output.emit_json(data)
        return
    output.render_usage(data)


def register(app: typer.Typer) -> None:
    app.command("usage", epilog=GLOBALS_EPILOG)(usage)
