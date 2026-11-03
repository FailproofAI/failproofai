"""Conversation sentiment summary, messages and sessions."""

from __future__ import annotations

from typing import Optional

import typer

from .. import client as api
from .._context import GLOBALS_EPILOG, require_auth, resolve_dates, validate_limit
from . import _cloud


def read(ctx, suffix, since=None, limit=None, session_id=None):
    validate_limit(limit)
    frm, to = resolve_dates(since, None, None)
    data = api.cloud_request(require_auth(ctx.obj), "GET", f"/api/events/sentiment{suffix}",
        params={"ts_from": frm, "ts_to": to, "limit": limit, "session_id": session_id})
    _cloud.emit(ctx.obj, data, "Sentiment", view=suffix.strip("/") or "summary")


def summary(ctx: typer.Context, since: Optional[str] = typer.Option(None, "--since")) -> None:
    """Summarize conversation sentiment."""
    read(ctx, "", since)


def messages(ctx: typer.Context, since: Optional[str] = typer.Option(None, "--since"),
             limit: int = typer.Option(50, "--limit"),
             session_id: Optional[str] = typer.Option(None, "--session-id")) -> None:
    """List sentiment-scored messages."""
    read(ctx, "/messages", since, limit, session_id)


def sessions(ctx: typer.Context, since: Optional[str] = typer.Option(None, "--since"),
             limit: int = typer.Option(50, "--limit")) -> None:
    """List sentiment-scored sessions."""
    read(ctx, "/sessions", since, limit)


def session(ctx: typer.Context, id: str = typer.Argument(...)) -> None:
    """Show one session's sentiment."""
    read(ctx, f"/sessions/{id}")


def register(app: typer.Typer) -> None:
    group = typer.Typer(no_args_is_help=True, help="Inspect conversation sentiment.", context_settings={"help_option_names": ["-h", "--help"]})
    for name, fn in (("summary", summary), ("messages", messages), ("sessions", sessions), ("session", session)):
        group.command(name, epilog=GLOBALS_EPILOG)(fn)
    app.add_typer(group, name="sentiment")
