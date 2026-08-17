"""errors — list errored events, or --aggregate them into a summary card.

Read-only; talks to the dashboard `/api/events/summary` (the light, payload-free errored
rows) and `/api/events/error_summary` (the aggregate). The list view renders the server's
precomputed `summary` column — the CLI never returns the fat payload for an errors read.
Free-text `--search` remains the exception at the database layer: it scans payload to match.
Emits the server payload verbatim under `--json`.
"""

from __future__ import annotations

from typing import List, Optional

import typer

from .. import client as api
from .. import dates, output
from .._context import (
    GLOBALS_EPILOG,
    AppState,
    require_auth,
    resolve_dates,
    resolve_fields,
    validate_choice,
    validate_limit,
)
from ..models import AgentEvent


def errors(
    ctx: typer.Context,
    aggregate: bool = typer.Option(False, "--aggregate", help="Summarise the matching errors into a card (count + sessions/agents/last seen) instead of listing them."),
    limit: int = typer.Option(50, "--limit", "-n", help="Max rows in total (list mode). Use --all to auto-paginate beyond the server's single-request cap."),
    since: Optional[str] = typer.Option(None, "--since", help=f"Relative window from now (dashboard presets): {', '.join(dates.SINCE_CHOICES)}."),
    ts_from: Optional[str] = typer.Option(None, "--from", help="Custom-range start, ISO-8601 UTC (e.g. 2026-05-01T00:00:00Z). Overrides --since."),
    ts_to: Optional[str] = typer.Option(None, "--to", help="Custom-range end, ISO-8601 UTC. Overrides --since."),
    environment: Optional[str] = typer.Option(None, "--env", help="Filter to one environment (exact match). e.g. `prod`."),
    error_type: Optional[str] = typer.Option(None, "--error-type", help="Filter to one error type (exact match). e.g. `TimeoutError`."),
    event_type: Optional[str] = typer.Option(None, "--event-type", help="Filter to one event type (exact match). e.g. `error`."),
    agent_id: Optional[str] = typer.Option(None, "--agent-id", help="Filter to one agent id (exact match)."),
    session_id: Optional[str] = typer.Option(None, "--session-id", help="Filter to one session id (exact match)."),
    search: Optional[List[str]] = typer.Option(None, "--search", help="Free-text term to match in the payload (repeatable; an event matches if it contains ANY of the terms)."),
    order: Optional[str] = typer.Option(None, "--order", help="Sort order by time: `asc` or `desc` (default newest-first; list mode)."),
    fetch_all: bool = typer.Option(False, "--all", help="Auto-paginate through all pages, up to --limit (list mode)."),
    cursor: Optional[str] = typer.Option(None, "--cursor", help="Resume after this cursor (a prior next_cursor; opaque token; list mode)."),
    page_size: Optional[int] = typer.Option(None, "--page-size", help="Rows per request when --all (max 200; list mode)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of fields to output (list mode). e.g. `ts,event_type,session_id`."),
    full_ids: bool = typer.Option(False, "--full-ids", help="Show full session ids in the table instead of truncating them (list mode; --json always has the full id)."),
) -> None:
    """List **errored events**, newest first — or roll them up with **`--aggregate`**.

    Errored events are the failures across your agents' runs (the dashboard's `/errors` view).
    Two modes, same filters:

    * **list** (default) — one row per errored event: `time · event · env · agent · session ·
      summary` (the summary is derived from the event payload).
    * **`--aggregate`** — a summary card: the total error count plus how many sessions and agents
      are affected and how recent the last error is.

    Each filter — `--env`, `--error-type`, `--event-type`, `--agent-id`, `--session-id` — takes a
    **single** value; combine them to narrow to one slice (they AND together). `--search` matches
    a free-text term in the event payload (repeatable — an event matches ANY of the terms). Scope
    time with `--since` or `--from`/`--to`. Every filter applies to both modes.

    Needs `events:read`. List `--json`: `{"errors": [...], "next_cursor": …}` — each row is a
    light, payload-free event (`id, session_id, agent_id, event_type, ts, environment,
    summary, is_error, error_type, output_tokens`, also the valid `--fields` names). The
    rendered `summary` is the server-computed `summary` field (no client-side payload
    parsing). Aggregate `--json`: `{total, sessions, agents, last_ts, bins}`. For the raw
    payload of an errored run, use `fp events --full --session-id <id>`.

    Examples:

    * `fp errors --env prod --since 24h` — recent production errors
    * `fp errors --error-type TimeoutError --agent-id agent-orderbot` — one agent's timeouts
    * `fp errors --aggregate --env prod --since 7d` — how many prod errors this week, and where
    * `fp --json errors --session-id sess-001 --all | jq '.errors[].summary'` — one session's error summaries as JSON
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    validate_limit(limit)
    order = validate_choice(order, ("asc", "desc"), flag="--order")
    frm, to = resolve_dates(since, ts_from, ts_to)

    # Which narrowing filters did the user set? Used to word the empty message and to nudge them
    # to re-check those values when nothing matches (a value matching nothing returns empty, not
    # an error — so a typo reads as "no errors"). Applies to both modes.
    active_filters = [
        flag for flag, val in (
            ("--env", environment),
            ("--event-type", event_type),
            ("--error-type", error_type),
            ("--agent-id", agent_id),
            ("--session-id", session_id),
            ("--search", search),
            ("--since/--from/--to", since or ts_from or ts_to),
        ) if val
    ]

    # ── aggregate mode: one summary payload, no pagination ──
    if aggregate:
        data = api.event_error_summary(
            cctx,
            session_id=session_id,
            agent_id=agent_id,
            event_type=event_type,
            error_type=error_type,
            environment=environment,
            search=search,
            ts_from=frm,
            ts_to=to,
        )
        if state.json:
            output.emit_json(data)
        else:
            output.render_error_aggregate(data)
            if not int(data.get("total", 0) or 0):
                output.recheck_filters_hint(active_filters)
        return

    # ── list mode: errored events (errored=true, like the dashboard /errors view) ──
    cols = resolve_fields(fields, AgentEvent)
    common = dict(
        session_id=session_id,
        agent_id=agent_id,
        event_type=event_type,
        error_type=error_type,
        environment=environment,
        errored=True,
        order=order,
        search=search,
        ts_from=frm,
        ts_to=to,
    )

    if fetch_all:
        items = list(
            api.paginate(
                lambda cursor, limit: api.list_event_summaries(cctx, cursor=cursor, limit=limit, **common),
                limit=limit,
                page_size=page_size,
                start_cursor=cursor,
            )
        )
        next_cursor = None
    else:
        page = api.list_event_summaries(cctx, cursor=cursor, limit=limit, **common)
        items = page.items
        next_cursor = page.next_cursor

    if state.json:
        payload = output.project_dicts(items, cols) if cols else items
        output.emit_json({"errors": payload, "next_cursor": next_cursor})
        return

    if cols:
        # `--fields` asks for specific raw columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(items, cols), title=f"Errors ({len(items)})")
    else:
        empty_message = "no errors match these filters" if active_filters else "no errors"
        output.render_errors(items, order=order, full_ids=full_ids, empty_message=empty_message)
    output.errors_footer(len(items), more=next_cursor is not None)
    if not items:
        output.recheck_filters_hint(active_filters)


def register(app: typer.Typer) -> None:
    app.command("errors", epilog=GLOBALS_EPILOG)(errors)
