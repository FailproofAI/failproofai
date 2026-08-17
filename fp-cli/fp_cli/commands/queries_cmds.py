"""Saved SQL queries + ad-hoc runner: query list/show/create/update/delete/run/schema.

Runs against the server's read-only analytics pool. SQL can be inline or read from a
file with ``--sql @path.sql``; run parameters are positional ``$1..$N`` values.
"""

from __future__ import annotations

from typing import Any, List, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth, resolve_fields, validate_limit
from ..errors import NotFoundError
from ..models import SavedQuery
from . import _write


def _humanize_list(items: List[str]) -> str:
    """``["name","sql","description"]`` → ``name, sql, and description``; one item → itself."""
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


def _read_sql(value: str) -> str:
    """Inline SQL, or the contents of a file when given as ``@path.sql``."""
    if value.startswith("@"):
        return _write.read_text_arg(value[1:], flag="--sql")
    return value


def _coerce_value(raw: str) -> Any:
    """Best-effort coercion of a run parameter value to int/float/bool/null/str."""
    low = raw.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "none"):
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def _resolve_query_or_exit(state: AppState, queries, handle: str) -> SavedQuery:
    """Resolve a saved query by **name** (primary), falling back to an exact id match, raising a
    typed error the central chokepoint renders: none → exit 6, several → exit 2."""
    return _write.resolve_one(queries, handle, kind="query", plural="queries", list_cmd="query list")


def query_list(
    ctx: typer.Context,
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short query-id column (the full id is always in --json)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of raw fields (falls back to a plain table)."),
) -> None:
    """List the org's saved queries in a boxed table, newest first.

    Shows `name · description · created by · created` — the long description is truncated to one
    line (full text in `query show` / `--json`), and `created` is when the query was made (not
    `updated_at`). `name` is the handle `query run`/`query show` take; the raw id is hidden unless
    `--show-id`. Needs `queries:read`. With `--json`: `{"queries": [{id, name, description,
    sql_text, params, created_by, created_at, ...}]}`.

    Example:

    * `fp query list`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    queries = api.list_saved_queries(cctx)
    cols = resolve_fields(fields, SavedQuery)
    if state.json:
        payload = output.project_dicts(queries, cols) if cols else queries
        output.emit_json({"queries": payload})
        return
    if cols:
        # `--fields` asks for specific raw columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(queries, cols), title=f"Saved queries ({len(queries)})")
        return
    output.render_queries(queries, show_id=show_id)


def query_show(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Saved query name (or id)."),
) -> None:
    """Show one saved query — a metadata card + its full, syntax-highlighted SQL.

    Referenced by query **name** (a UUID-shaped id is also accepted). The SQL is shown in full with
    line numbers. Not-found → red `✗ no query named "…"`, exit 6. Needs `queries:read`. With
    `--json`: the full `SavedQuery` (raw `sql_text` for piping).

    Example:

    * `fp query show q_eval_score_avg`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    q = _resolve_query_or_exit(state, api.list_saved_queries(cctx), name)
    if state.json:
        output.emit_json(q)
        return
    output.render_query_show(q)


def query_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Saved query name (unique per org)."),
    sql: str = typer.Option(..., "--sql", help="SQL text, or `@file.sql` to read from a file."),
    description: str = typer.Option("", "--description", help="Optional one-line description."),
) -> None:
    """Create a saved query — give it a **name**, the SQL, and an optional description.

    The query is saved to the org's analytics library; run it later with `fp query run
    <name>`. The SQL can be inline or read from a file with `--sql @file.sql`. A name collision is
    rejected up front. Needs `queries:write`. With `--json`: the created `SavedQuery`
    (`{id, name, description, created_at, sql_text}`).

    Examples:

    * `fp query create top-agents --sql "SELECT agent_id, count() FROM fp.events GROUP BY agent_id"`
    * `fp query create errors-by-env --sql @errs.sql --description "errored events per environment"`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    if any(q.name == name for q in api.list_saved_queries(cctx)):  # names are unique per org
        raise click.UsageError(f'a query named "{name}" already exists')
    result = api.create_saved_query(
        cctx, name=name, sql_text=_read_sql(sql), description=description, params=[]
    )
    _write.record_action("saved_query_created", resource="query", success=True)
    if state.json:
        output.emit_json({"id": result.id, "name": result.name, "description": result.description,
                          "created_at": result.created_at, "sql_text": result.sql_text})
        return
    output.render_query_created(result)


def query_update(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Saved query name (or id) to update."),
    new_name: Optional[str] = typer.Option(None, "--name", help="Rename the query (defaults to the current name)."),
    sql: Optional[str] = typer.Option(None, "--sql", help="New SQL text, or `@file.sql` (defaults to current)."),
    description: Optional[str] = typer.Option(None, "--description", help="New description (defaults to current)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Update a saved query, referenced by **name** (or a UUID-shaped id).

    Change any of `--name`, `--sql`, `--description` (pass at least one); fields you omit keep
    their current value (the CLI reads the query first, then saves the merged result). It confirms
    first (default no; `--yes` skips) and shows the updated query as a green card + numbered SQL
    box. A no-op exits without saving. Needs `queries:write`. With `--json`: the updated
    `SavedQuery`.

    Examples:

    * `fp query update top-agents --sql @top.sql` — replace the SQL
    * `fp query update top-agents --name agent-totals --description "rows per agent"` — rename + redescribe
    """
    state: AppState = ctx.obj
    if new_name is None and sql is None and description is None:
        raise typer.BadParameter("nothing to update — pass --name, --sql, and/or --description.")
    cctx = require_auth(state)
    queries = api.list_saved_queries(cctx)
    q = _resolve_query_or_exit(state, queries, name)

    # A rename to an existing name collides (like create's 409).
    if new_name is not None and new_name != q.name and any(o.name == new_name for o in queries):
        raise click.UsageError(f'a query named "{new_name}" already exists')

    # Which fields actually change → the confirm consequence (and no-op detection).
    changed: List[str] = []
    if new_name is not None and new_name != q.name:
        changed.append("name")
    if sql is not None and _read_sql(sql) != q.sql_text:
        changed.append("sql")
    if description is not None and description != q.description:
        changed.append("description")
    if not changed:
        if state.json:
            output.emit_json({"id": q.id, "name": q.name, "description": q.description,
                              "created_at": q.created_at, "sql_text": q.sql_text})
        else:
            output.query_no_change()
        return

    if _write.should_prompt(state, yes):
        if not output.confirm_query_update(q.name, _humanize_list(changed)):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.query_cancelled("nothing changed")
            return

    result = api.update_saved_query(
        cctx, q.id,
        name=new_name if new_name is not None else q.name,
        sql_text=_read_sql(sql) if sql is not None else q.sql_text,
        description=description if description is not None else q.description,
        params=q.params,
    )
    _write.record_action("saved_query_updated", resource="query", success=True)
    if state.json:
        output.emit_json({"id": result.id, "name": result.name, "description": result.description,
                          "created_at": result.created_at, "sql_text": result.sql_text})
        return
    output.render_query_updated(result, old_name=q.name)


def query_delete(
    ctx: typer.Context,
    name: str = typer.Argument(..., metavar="NAME", help="Saved query name (or id) to delete."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Delete a saved query, referenced by **name** (or a UUID-shaped id). This cannot be undone.

    Needs `queries:delete`. With `--json`: `{"deleted": true, "id", "name"}`.

    Example:

    * `fp query delete errs --yes`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    q = _resolve_query_or_exit(state, api.list_saved_queries(cctx), name)
    if _write.should_prompt(state, yes):
        output.render_query_delete_preview(q)  # amber preview of what's about to go
        if not output.confirm_query_delete():
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.query_cancelled("nothing deleted")
            return
    api.delete_saved_query(cctx, q.id)
    _write.record_action("saved_query_deleted", resource="query", success=True, destructive=True)
    if state.json:
        output.emit_json({"deleted": True, "id": q.id, "name": q.name})
    else:
        output.query_deleted(q.name)


def query_run(
    ctx: typer.Context,
    name: Optional[str] = typer.Argument(None, metavar="[NAME]", help="Saved query name to run (or a UUID-shaped id)."),
    sql: Optional[str] = typer.Option(None, "--sql", help="Run ad-hoc SQL instead of a saved query, or `@file.sql`."),
    limit: Optional[int] = typer.Option(None, "--limit", help=f"Max rows to show in the table view (default {output.QUERY_RUN_ROW_CAP}; --json always returns all)."),
    all_: bool = typer.Option(False, "--all", help="Show every returned row (override the table row cap)."),
    param: Optional[List[str]] = typer.Option(None, "--arg", "--param", help="Positional argument value bound to $1..$N, in order (repeatable). Alias: --param."),
) -> None:
    """Run a saved query by **name**, or ad-hoc `--sql`, against the read-only analytics pool.

    The result is rendered adaptively from its shape — a scalar stat card, a single record, or a
    boxed table (capped to a preview; `--limit`/`--all` adjust it, `--json` returns everything).
    Pass a saved query's positional parameters with `--arg` (one per `$1..$N`, in order). Needs
    `queries:run`. Not-found → red `✗ no query named "…"`; a SQL/exec error → `✗ query failed — …`.
    With `--json`: `{columns: [{name, type}], rows: [[...]], truncated, elapsed_ms}` (all rows).

    Examples:

    * `fp query run q_eval_total`
    * `fp query run q_eval_score_avg --arg agent-codegen`
    * `fp --json query run --sql "select count(*) from analytics.events"`
    """
    state: AppState = ctx.obj
    if (name is None) == (sql is None):
        raise typer.BadParameter("pass a saved query NAME or --sql (exactly one).")
    validate_limit(limit)
    cctx = require_auth(state)
    query_id: Optional[str] = None
    display_name = "query"
    if name is not None:
        q = _resolve_query_or_exit(state, api.list_saved_queries(cctx), name)
        query_id, display_name = q.id, q.name
    values = [_coerce_value(v) for v in (param or [])]
    # A SQL/exec/permission failure propagates as a typed error to the central chokepoint
    # (JSON envelope under --json, red box otherwise). The DB detail is surfaced because
    # client._extract_error folds the server's `detail` into the message.
    result = api.run_query(
        cctx, sql=_read_sql(sql) if sql is not None else None, query_id=query_id, params=values
    )
    _write.record_action(
        "query_run", success=True, via="saved" if query_id else "ad_hoc", row_count_bucket=_bucket(len(result.rows))
    )
    if state.json:
        output.emit_json(result)
        return
    row_cap = limit if limit is not None else output.QUERY_RUN_ROW_CAP
    output.render_query_result(display_name, result, row_cap=row_cap, show_all=all_)


def _bucket(n: int) -> str:
    if n == 0:
        return "0"
    if n <= 10:
        return "1-10"
    if n <= 100:
        return "11-100"
    return "100+"


def query_schema(
    ctx: typer.Context,
    table: Optional[str] = typer.Argument(None, metavar="[TABLE]", help="Filter to one table's columns."),
) -> None:
    """Show the queryable analytics schema in a boxed, table-grouped view.

    Each table's name prints once (then blanks down its columns); types are coloured by category
    (numeric / string / uuid+timestamp / bool) with a dim `?` for nullable. Pass a `TABLE` to
    filter to one. Needs `queries:read`. With `--json`: `{schema, columns: [{table, column, type,
    nullable}]}` (the `?` split into a boolean).

    Examples:

    * `fp query schema`
    * `fp query schema events`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    data = api.query_schema(cctx)
    tables = list(data.get("tables", []) or [])
    if table is not None:
        match = [t for t in tables if t.get("name") == table]
        if not match:
            names = [str(t.get("name", "")) for t in tables]
            raise NotFoundError(
                f'no table named "{table}"', hint=f"available: {', '.join(names)}" if names else None
            )
        tables = match
    data = {**data, "tables": tables}

    if state.json:
        flat = []
        for t in tables:
            for col in t.get("columns", []) or []:
                ty = str(col.get("type", ""))
                nullable = ty.endswith("?")
                flat.append({"table": t.get("name", ""), "column": col.get("name", ""),
                             "type": ty[:-1] if nullable else ty, "nullable": nullable})
        output.emit_json({"schema": data.get("schema", ""), "columns": flat})
        return
    output.render_query_schema(data)
    total_cols = sum(len(t.get("columns", []) or []) for t in tables)
    output.schema_footer(len(tables), total_cols)


def register(app: typer.Typer) -> None:
    query_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="Run and manage saved SQL queries (list / show / create / update / delete / run / schema).",
    )
    query_app.command("list", epilog=GLOBALS_EPILOG)(query_list)
    query_app.command("show", epilog=GLOBALS_EPILOG)(query_show)
    query_app.command("create", epilog=GLOBALS_EPILOG)(query_create)
    query_app.command("update", epilog=GLOBALS_EPILOG)(query_update)
    query_app.command("delete", epilog=GLOBALS_EPILOG)(query_delete)
    query_app.command("run", epilog=GLOBALS_EPILOG)(query_run)
    query_app.command("schema", epilog=GLOBALS_EPILOG)(query_schema)
    app.add_typer(query_app, name="query")
