"""Additive account, billing and integration commands."""

from __future__ import annotations

from typing import List, Optional

import typer

from .. import _click_compat as click, client as api, permissions
from .._context import GLOBALS_EPILOG, require_auth
from . import _cloud, _write


def request(ctx, method, path, body=None, params=None):
    if method != "GET":
        _write.confirm(ctx.obj, f"{method} {path}", assume_yes=False, destructive=method == "DELETE")
    result = api.cloud_request(require_auth(ctx.obj), method, path, body=body, params=params)
    if method != "GET":
        _write.record_action("cloud_resource_changed", resource=path.split("/")[2], success=True, destructive=method == "DELETE")
    _cloud.emit(ctx.obj, result, "Cloud")


def roles_list(ctx: typer.Context) -> None:
    """List named permission sets. Needs users:read."""
    request(ctx, "GET", "/api/permission-sets")


def roles_show(ctx: typer.Context, name: str = typer.Argument(...)) -> None:
    """Show one permission set by name."""
    request(ctx, "GET", f"/api/permission-sets/{name}")


def grants(values):
    if not values:
        return []
    try:
        return permissions.parse_permission_tokens(values)
    except permissions.PermissionTokenError as exc:
        raise click.UsageError(str(exc)) from exc


def roles_create(ctx: typer.Context, name: str = typer.Option(..., "--name"),
                 permission: Optional[List[str]] = typer.Option(None, "--permission", "--add"),
                 description: Optional[str] = typer.Option(None, "--description"),
                 file: Optional[str] = typer.Option(None, "--file")) -> None:
    """Create a custom permission set. Needs settings:write."""
    if not 1 <= len(name.strip()) <= 64:
        raise click.UsageError("Role name must be 1–64 characters")
    body = _write.read_body(ctx.obj, file, {"permissions": grants(permission) if permission is not None else None, "description": description})
    body["name"] = name.strip()
    body.setdefault("permissions", [])
    if not isinstance(body["permissions"], list):
        raise click.UsageError("permissions must be an array")
    body["permissions"] = grants(body["permissions"])
    request(ctx, "POST", "/api/permission-sets", body)


def roles_update(ctx: typer.Context, name: str = typer.Argument(...),
                 permission: Optional[List[str]] = typer.Option(None, "--permission", help="Full replacement grants."),
                 add: Optional[List[str]] = typer.Option(None, "--add"),
                 remove: Optional[List[str]] = typer.Option(None, "--remove"),
                 description: Optional[str] = typer.Option(None, "--description"),
                 file: Optional[str] = typer.Option(None, "--file")) -> None:
    """Update a custom set; affected members receive the new grants."""
    if permission is not None and (add or remove):
        raise click.UsageError("Use --permission or --add/--remove, not both")
    added, removed = grants(add or []), grants(remove or [])
    body = _write.read_body(ctx.obj, file, {"permissions": grants(permission) if permission is not None else None, "description": description})
    if file and (add or remove):
        raise click.UsageError("Use --file or discrete flags")
    if not body and not added and not removed:
        raise click.UsageError("Pass --permission, --add, --remove, --description or --file")
    current = api.cloud_request(require_auth(ctx.obj), "GET", f"/api/permission-sets/{name}")
    if current.get("is_builtin"):
        raise click.UsageError("Builtin permission sets are immutable")
    body.setdefault("permissions", list(dict.fromkeys([v for v in current.get("permissions", []) if v not in removed] + added)))
    body["permissions"] = grants(body["permissions"])
    body.setdefault("description", current.get("description"))
    request(ctx, "PUT", f"/api/permission-sets/{name}", body)


def roles_delete(ctx: typer.Context, name: str = typer.Argument(...)) -> None:
    """Delete a custom permission set; members keep materialized permissions."""
    request(ctx, "DELETE", f"/api/permission-sets/{name}")


def plan(ctx: typer.Context) -> None:
    """Show current offers and team-trial state."""
    if ctx.invoked_subcommand:
        return
    cctx = require_auth(ctx.obj)
    data = {"offers": api.cloud_request(cctx, "GET", "/api/offers/me"),
            "team_trial": api.cloud_request(cctx, "GET", "/api/team-trial/me")}
    _cloud.emit(ctx.obj, data, "Plan")


def claim(ctx: typer.Context, offer: str = typer.Argument(...)) -> None:
    """Claim a named offer."""
    request(ctx, "POST", "/api/offers/claim", {"offer_key": offer})


def otel_status(ctx: typer.Context) -> None:
    """Show Cloud OTEL ingest status."""
    request(ctx, "GET", "/api/otel/status")


def otel_enable(ctx: typer.Context) -> None:
    """Enable OTEL ingestion for the Cloud org."""
    request(ctx, "PUT", "/api/settings/otel.ingest_enabled", {"value": True})


def otel_disable(ctx: typer.Context) -> None:
    """Disable OTEL ingestion for the Cloud org."""
    request(ctx, "PUT", "/api/settings/otel.ingest_enabled", {"value": False})


def slack_status(ctx: typer.Context) -> None:
    """Show Slack connection status (session only)."""
    _cloud.session_only(ctx.obj, "slack status")
    request(ctx, "GET", "/api/integrations/slack")


def slack_disconnect(ctx: typer.Context) -> None:
    """Disconnect Slack (session only)."""
    _cloud.session_only(ctx.obj, "slack disconnect")
    request(ctx, "DELETE", "/api/integrations/slack")


def context_list(ctx: typer.Context) -> None:
    """List model context-window overrides."""
    request(ctx, "GET", "/api/settings/model-context-windows")


def context_set(ctx: typer.Context, model: str = typer.Argument(...),
                tokens: int = typer.Argument(...)) -> None:
    """Set an override; zero means unknown."""
    if not 1 <= len(model.strip()) <= 256 or not 0 <= tokens <= 1_000_000:
        raise click.UsageError("Model must be 1–256 characters; tokens must be 0–1000000")
    request(ctx, "PUT", "/api/settings/model-context-windows", {"model_id": model.strip(), "context_window": tokens})


def context_delete(ctx: typer.Context, model: str = typer.Argument(...)) -> None:
    """Remove a model override."""
    if not model.strip():
        raise click.UsageError("Model cannot be empty")
    request(ctx, "DELETE", "/api/settings/model-context-windows", params={"model": model})


def register_context_windows(settings_app):
    group = typer.Typer(no_args_is_help=True, context_settings={"help_option_names": ["-h", "--help"]})
    for name, fn in (("list", context_list), ("set", context_set), ("delete", context_delete)):
        group.command(name, epilog=GLOBALS_EPILOG)(fn)
    settings_app.add_typer(group, name="context-windows")


def register(app):
    for name, help_text, commands in (
        ("roles", "Manage permission sets.", (("list", roles_list), ("show", roles_show), ("create", roles_create), ("update", roles_update), ("delete", roles_delete))),
        ("otel", "Control Cloud OTEL ingest.", (("status", otel_status), ("enable", otel_enable), ("disable", otel_disable))),
        ("slack", "Manage the Slack integration (session only).", (("status", slack_status), ("disconnect", slack_disconnect))),
    ):
        group = typer.Typer(no_args_is_help=True, help=help_text, context_settings={"help_option_names": ["-h", "--help"]})
        for command, fn in commands:
            group.command(command, epilog=GLOBALS_EPILOG)(fn)
        app.add_typer(group, name=name)
    group = typer.Typer(invoke_without_command=True, context_settings={"help_option_names": ["-h", "--help"]})
    group.callback(epilog=GLOBALS_EPILOG)(plan)
    group.command("claim", epilog=GLOBALS_EPILOG)(claim)
    app.add_typer(group, name="plan")
