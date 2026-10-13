"""Org dashboards and their saved-query tiles."""

from __future__ import annotations

from typing import Optional

import typer

from .. import _click_compat as click, client as api
from .._context import GLOBALS_EPILOG, require_auth, validate_choice
from . import _cloud, _write

CHARTS = ("line", "area", "bar", "stacked_bar", "pie", "kpi", "table")
TILE_FIELDS = ("query_id", "title", "chart_type", "chart_config", "param_bindings", "pos_x", "pos_y", "pos_w", "pos_h")


def request(ctx, method, path, body=None):
    if method != "GET":
        _write.confirm(ctx.obj, f"{method} {path}", assume_yes=False, destructive=method == "DELETE")
    data = api.cloud_request(require_auth(ctx.obj), method, path, body=body)
    if method != "GET":
        _write.record_action("dashboard_changed", resource="dashboard", success=True, destructive=method == "DELETE")
    _cloud.emit(ctx.obj, data, "Dashboards")


def list_dashboards(ctx: typer.Context) -> None:
    """List org dashboards."""
    request(ctx, "GET", "/api/dashboards")


def show(ctx: typer.Context, id: str = typer.Argument(...)) -> None:
    """Show a dashboard and its tiles."""
    request(ctx, "GET", f"/api/dashboards/{id}")


def create(ctx: typer.Context, name: str = typer.Option(..., "--name"),
           description: str = typer.Option("", "--description"),
           file: Optional[str] = typer.Option(None, "--file", help="Dashboard definition JSON.")) -> None:
    """Create a dashboard (no tiles yet)."""
    if not name.strip():
        raise click.UsageError("--name cannot be empty")
    definition = _write.read_body(ctx.obj, file) if file else {}
    request(ctx, "POST", "/api/dashboards", {"name": name, "description": description, "definition": definition})


def update(ctx: typer.Context, id: str = typer.Argument(...),
           name: Optional[str] = typer.Option(None, "--name"),
           description: Optional[str] = typer.Option(None, "--description"),
           file: Optional[str] = typer.Option(None, "--file", help="Replacement dashboard definition JSON.")) -> None:
    """Update selected fields, preserving the others."""
    if name is None and description is None and file is None:
        raise click.UsageError("Pass --name, --description or --file")
    if name is not None and not name.strip():
        raise click.UsageError("--name cannot be empty")
    definition = _write.read_body(ctx.obj, file) if file else None
    current = api.cloud_request(require_auth(ctx.obj), "GET", f"/api/dashboards/{id}")
    # Show returns {dashboard, tiles}; older deployments return the row itself.
    current = current.get("dashboard", current)
    body = {k: current.get(k, {} if k == "definition" else "") for k in ("name", "description", "definition")}
    body.update({k: v for k, v in {"name": name, "description": description, "definition": definition}.items() if v is not None})
    request(ctx, "PUT", f"/api/dashboards/{id}", body)


def delete(ctx: typer.Context, id: str = typer.Argument(...)) -> None:
    """Delete a dashboard (saved queries are retained)."""
    request(ctx, "DELETE", f"/api/dashboards/{id}")


def tiles(ctx: typer.Context, id: str = typer.Argument(..., metavar="DASHBOARD_ID")) -> None:
    """Manage tiles: `fp dashboards tiles ID list|add|update|remove|layout`."""
    ctx.meta["dashboard_id"] = id


def tile_path(ctx):
    return f"/api/dashboards/{ctx.meta['dashboard_id']}/tiles"


def tile_list(ctx: typer.Context) -> None:
    """List tiles."""
    request(ctx, "GET", tile_path(ctx))


def tile_add(ctx: typer.Context, query: str = typer.Option(..., "--query"),
             chart: str = typer.Option(..., "--chart"), title: str = typer.Option("", "--title"),
             file: Optional[str] = typer.Option(None, "--file", help="Tile config/geometry JSON.")) -> None:
    """Add a saved-query tile."""
    validate_choice(chart, CHARTS, flag="--chart")
    body = {"query_id": query, "title": title, "chart_type": chart, "chart_config": {},
            "param_bindings": {}, "pos_x": 0, "pos_y": 0, "pos_w": 6, "pos_h": 4}
    if file:
        body.update(_write.read_body(ctx.obj, file))
    validate_tile(body)
    request(ctx, "POST", tile_path(ctx), body)


def validate_tile(body):
    if set(body) - set(TILE_FIELDS):
        raise click.UsageError("Unknown tile fields")
    validate_choice(body.get("chart_type"), CHARTS, flag="--chart")
    if not body.get("query_id") or not body.get("chart_type"):
        raise click.UsageError("Tile needs query_id and chart_type")
    for key in ("pos_x", "pos_y", "pos_w", "pos_h"):
        value = body.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < (1 if key in ("pos_w", "pos_h") else 0):
            raise click.UsageError("Tile position must be non-negative with positive size")
    for key in ("chart_config", "param_bindings"):
        if not isinstance(body.get(key), dict):
            raise click.UsageError(f"{key} must be a JSON object")


def tile_update(ctx: typer.Context, tile: str = typer.Argument(...),
                query: Optional[str] = typer.Option(None, "--query"),
                chart: Optional[str] = typer.Option(None, "--chart"),
                title: Optional[str] = typer.Option(None, "--title"),
                file: Optional[str] = typer.Option(None, "--file")) -> None:
    """Update a tile, preserving unmentioned config and geometry."""
    body = _write.read_body(ctx.obj, file, {"query_id": query, "chart_type": chart, "title": title})
    if not body:
        raise click.UsageError("Pass --query, --chart, --title or --file")
    data = api.cloud_request(require_auth(ctx.obj), "GET", tile_path(ctx))
    matches = [r for r in _cloud.rows(data, "tiles") if str(r.get("id")) == tile]
    if len(matches) != 1:
        from ..errors import NotFoundError
        raise NotFoundError(f"no tile {tile}; run `fp dashboards tiles {ctx.meta['dashboard_id']} list`")
    merged = {k: matches[0][k] for k in TILE_FIELDS}
    merged.update(body)
    validate_tile(merged)
    request(ctx, "PUT", f"{tile_path(ctx)}/{tile}", merged)


def tile_remove(ctx: typer.Context, tile: str = typer.Argument(...)) -> None:
    """Remove a tile."""
    request(ctx, "DELETE", f"{tile_path(ctx)}/{tile}")


def tile_layout(ctx: typer.Context, file: str = typer.Option(..., "--file")) -> None:
    """Apply geometry JSON: {tiles: [{id,pos_x,pos_y,pos_w,pos_h}]}."""
    body = _write.read_body(ctx.obj, file)
    if not isinstance(body.get("tiles"), list):
        raise click.UsageError("Layout must contain a tiles array")
    for row in body["tiles"]:
        if not isinstance(row, dict) or not row.get("id"):
            raise click.UsageError("Layout tiles need ids")
        if set(row) != {"id", "pos_x", "pos_y", "pos_w", "pos_h"}:
            raise click.UsageError("Layout tiles must contain id,pos_x,pos_y,pos_w,pos_h")
        validate_tile({**{k: v for k, v in row.items() if k != "id"}, "query_id": "layout", "chart_type": "table", "chart_config": {}, "param_bindings": {}, "title": ""})
    request(ctx, "PUT", f"{tile_path(ctx)}/layout", body)


def register(app: typer.Typer) -> None:
    group = typer.Typer(no_args_is_help=True, help="Manage org dashboards and tiles.", context_settings={"help_option_names": ["-h", "--help"]})
    for name, fn in (("list", list_dashboards), ("show", show), ("create", create), ("update", update), ("delete", delete)):
        group.command(name, epilog=GLOBALS_EPILOG)(fn)
    tile_group = typer.Typer(no_args_is_help=True, context_settings={"help_option_names": ["-h", "--help"]})
    tile_group.callback()(tiles)
    for name, fn in (("list", tile_list), ("add", tile_add), ("update", tile_update), ("remove", tile_remove), ("layout", tile_layout)):
        tile_group.command(name, epilog=GLOBALS_EPILOG)(fn)
    group.add_typer(tile_group, name="tiles")
    app.add_typer(group, name="dashboards")
