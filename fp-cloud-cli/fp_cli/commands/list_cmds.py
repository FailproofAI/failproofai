"""fp list — discover the distinct values behind the dashboard's filter dropdowns.

Each subcommand returns a flat list of strings for one facet (the same data that powers the
dashboard's dropdowns), handy for finding valid filter values to pass to `sessions` / `events`.
Every value comes from a per-org cached endpoint, so it stays cheap to call.
"""

from __future__ import annotations

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth

# Friendly `list <name>` -> (facet key in client._FACET_PATHS, required permission, one-liner,
# title description). The order here is the order shown in `fp list --help`.
_LIST_KINDS = {
    "envs": ("environments", "events:read or evaluations:read", "Environments seen across events.", "seen across events"),
    "agents": ("agent_ids", "events:read or evaluations:read", "Agent ids seen across events.", "seen across events"),
    "event_types": ("event_types", "events:read or evaluations:read", "Event types (agent_start, tool_use, error, …).", "seen across events"),
    "score_filters": ("score_filters", "evaluations:read", "Evaluation score keys / metrics (for `--score KEY:MIN..MAX`).", "evaluation score keys"),
    "models": ("models", "events:read", "Model names seen across events.", "seen across events"),
    "hooks": ("hook_names", "events:read", "Hook names seen across events.", "seen across events"),
    "tools": ("tool_names", "events:read", "Tool names seen across events.", "seen across events"),
    "error_types": ("error_types", "events:read", "Error types seen across events.", "seen across events"),
}

def _make_list_cmd(name: str, facet_key: str, perm: str, summary: str, description: str):
    """Build the handler for one `list <name>` subcommand (a thin wrapper over the shared
    facet fetch, so all nine share one code path)."""

    def _cmd(ctx: typer.Context) -> None:
        state: AppState = ctx.obj
        cctx = require_auth(state)
        values = api.list_facet(cctx, facet_key)
        if state.json:
            output.emit_json({"kind": name, "values": values})
            return
        output.render_value_list(name, values, description=description)

    _cmd.__name__ = f"list_{name}"
    _cmd.__doc__ = (
        f"{summary}\n\n"
        f"    Needs `{perm}`. With `--json`: `{{\"kind\": \"{name}\", \"values\": [...]}}`.\n\n"
        f"    Example:\n\n"
        f"    * `fp --json list {name} | jq '.values'`"
    )
    return _cmd


def register(app: typer.Typer) -> None:
    list_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="List the distinct values behind the dashboard's filter dropdowns. Subcommands: "
        "**envs**, **agents**, **event_types**, **score_filters**, **models**, **hooks**, "
        "**tools**, **error_types**.",
    )
    for name, (facet_key, perm, summary, description) in _LIST_KINDS.items():
        list_app.command(name, epilog=GLOBALS_EPILOG)(_make_list_cmd(name, facet_key, perm, summary, description))
    app.add_typer(list_app, name="list")
