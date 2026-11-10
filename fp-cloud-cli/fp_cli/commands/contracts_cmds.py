"""Org-wide agent contracts, alongside scheduled audits."""

from __future__ import annotations

from typing import Optional

import typer

from .. import _click_compat as click, client as api
from .._context import GLOBALS_EPILOG, require_auth
from . import _write
from .account_cmds import request

PATH = "/api/audits/contracts"


def list_contracts(ctx: typer.Context) -> None:
    """List agent contracts."""
    request(ctx, "GET", PATH)


def show(ctx: typer.Context, id: str = typer.Argument(...)) -> None:
    """Show one contract, including its Markdown."""
    request(ctx, "GET", f"{PATH}/{id}")


def validate(body):
    if set(body) - {"agent_id", "body", "enabled"}:
        raise click.UsageError("Contracts accept agent_id, body and enabled")
    if not isinstance(body.get("agent_id"), str) or not body["agent_id"].strip():
        raise click.UsageError("Contract needs an agent_id from your telemetry")
    if not isinstance(body.get("body"), str) or not body["body"].strip() or len(body["body"]) > 5000 or "\0" in body["body"]:
        raise click.UsageError("Contract body must be 1–5000 characters without NUL")
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise click.UsageError("Contract enabled must be boolean")


def create(ctx: typer.Context, agent_id: Optional[str] = typer.Option(None, "--agent-id"),
           body: Optional[str] = typer.Option(None, "--body", help="Markdown or @file."),
           file: Optional[str] = typer.Option(None, "--file", help="Contract API body JSON.")) -> None:
    """Write an agent contract."""
    data = _write.read_body(ctx.obj, file, {"agent_id": agent_id, "body": _write.read_text_arg(body[1:]) if body and body.startswith("@") else body})
    validate(data)
    request(ctx, "POST", PATH, data)


def update(ctx: typer.Context, id: str = typer.Argument(...),
           agent_id: Optional[str] = typer.Option(None, "--agent-id"),
           body: Optional[str] = typer.Option(None, "--body"),
           enabled: Optional[bool] = typer.Option(None, "--enabled/--disabled"),
           file: Optional[str] = typer.Option(None, "--file")) -> None:
    """Update selected fields, preserving the rest."""
    changes = _write.read_body(ctx.obj, file, {"agent_id": agent_id, "body": _write.read_text_arg(body[1:]) if body and body.startswith("@") else body, "enabled": enabled})
    if not changes:
        raise click.UsageError("Pass --agent-id, --body, --enabled/--disabled or --file")
    current = api.cloud_request(require_auth(ctx.obj), "GET", f"{PATH}/{id}")
    data = {k: current[k] for k in ("agent_id", "body", "enabled") if k in current}
    data.update(changes)
    validate(data)
    request(ctx, "PUT", f"{PATH}/{id}", data)


def register(audits_app):
    group = typer.Typer(no_args_is_help=True, context_settings={"help_option_names": ["-h", "--help"]})
    for name, fn in (("list", list_contracts), ("show", show), ("create", create), ("update", update)):
        group.command(name, epilog=GLOBALS_EPILOG)(fn)
    audits_app.add_typer(group, name="contracts")
