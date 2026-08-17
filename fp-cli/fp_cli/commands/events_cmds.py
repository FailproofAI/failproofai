"""events — list raw agent events."""

from __future__ import annotations

from typing import List, Optional

import typer

from .. import client as api
from .. import dates, output
from .._context import (
    GLOBALS_EPILOG,
    AppState,
    collect_multi,
    require_auth,
    resolve_dates,
    resolve_fields,
    validate_limit,
)
from ..models import AgentEvent


def events(
    ctx: typer.Context,
    limit: int = typer.Option(50, "--limit", "-n", help="Max rows in total. Use --all to auto-paginate beyond the server's single-request cap."),
    since: Optional[str] = typer.Option(None, "--since", help=f"Relative window from now (dashboard presets): {', '.join(dates.SINCE_CHOICES)}."),
    ts_from: Optional[str] = typer.Option(None, "--from", help="Custom-range start, ISO-8601 UTC (e.g. 2026-05-01T00:00:00Z). Overrides --since."),
    ts_to: Optional[str] = typer.Option(None, "--to", help="Custom-range end, ISO-8601 UTC. Overrides --since."),
    environment: Optional[List[str]] = typer.Option(None, "--env", help="Filter by environment. Accepts multiple — repeat the flag or comma-separate: `--env prod --env staging` or `--env prod,staging` (matches any)."),
    event_type: Optional[List[str]] = typer.Option(None, "--event-type", help="Filter by event type. Accepts multiple — repeat the flag or comma-separate: `--event-type tool_use,tool_result` (matches any). Discover values with `fp list event_types`."),
    agent_id: Optional[List[str]] = typer.Option(None, "--agent-id", help="Filter by agent id. Accepts multiple — repeat the flag or comma-separate: `--agent-id a,b` (matches any). Discover values with `fp list agents`."),
    session_id: Optional[List[str]] = typer.Option(None, "--session-id", help="Filter by session id. Accepts multiple — repeat the flag or comma-separate: `--session-id a,b` (matches any)."),
    search: Optional[List[str]] = typer.Option(None, "--search", help="Free-text term to match in the payload (repeatable; an event matches if it contains ANY of the terms)."),
    order: Optional[str] = typer.Option(None, "--order", help="Sort order by time: `asc` or `desc` (default newest-first)."),
    fetch_all: bool = typer.Option(False, "--all", help="Auto-paginate through all pages, up to --limit."),
    cursor: Optional[str] = typer.Option(None, "--cursor", help="Resume after this cursor (a prior next_cursor; opaque token)."),
    page_size: Optional[int] = typer.Option(None, "--page-size", help="Rows per request when --all (max 200)."),
    full: bool = typer.Option(False, "--full", help="Fetch the FULL event rows incl. the raw `payload` (the heavy feed). Off by default — the light payload-free feed is used unless you pass this or request `--fields payload`. The full feed is slow at scale, so keep it bounded (e.g. to one `--session-id`)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of fields to output (applies to --json and the table). e.g. `ts,event_type,summary`. Requesting `payload` auto-switches to the full feed."),
) -> None:
    """List **event logs** — the raw, per-step trail your agents emit (tool calls, model
    requests/responses, hooks, results), newest first.

    Narrow the feed with the filters below. `--env`, `--event-type`, `--agent-id`, and
    `--session-id` each accept **multiple values** — repeat the flag or comma-separate
    (`--env prod,staging` is the same as `--env prod --env staging`). Values within one
    filter match **any** of them; different filters are combined (an event must satisfy all
    of them). Scope by time with `--since` (a preset window) or `--from`/`--to` (a custom
    UTC range), and walk large result sets with `--all` (or resume with `--cursor`).

    Discover valid filter values with `fp list` — e.g. `fp list event_types`,
    `fp list agents`, `fp list envs`.

    Needs `events:read`. With `--json`: `{"events": [...], "next_cursor": <cursor or null>}`.

    By **default** this reads the light, payload-free feed — each event has `id, session_id,
    agent_id, event_type, ts, environment, summary, is_error, error_type, output_tokens,
    context_window, context_fill` (a server-computed one-line `summary`, never the raw
    payload). This is the fast path for structured filters, `--session-id`, and `--all`.
    `--search` keeps the response payload-free but still scans payload server-side, so broad
    searches may be expensive. To get
    the raw `payload`, opt into the **full feed** with `--full` (or `--fields payload`), which
    hits the heavy `/events` endpoint — slow at scale, so keep it bounded (pair `--full` with a
    single `--session-id`). All listed keys are valid `--fields` names (`payload` too, in full
    mode).

    Examples:

    * `fp events --env prod,staging --event-type tool_use,error --limit 100` — recent prod/staging events (light)
    * `fp --json events --session-id run-001 --all` — a run's full timeline: event types + summaries (light, fast)
    * `fp --json events --full --session-id run-001 --all | jq '.events[].payload'` — that run's raw payloads (full feed, bounded to one run)
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    frm, to = resolve_dates(since, ts_from, ts_to)
    cols = resolve_fields(fields, AgentEvent)
    if order is not None and order not in ("asc", "desc"):
        raise typer.BadParameter("--order must be 'asc' or 'desc'.")
    validate_limit(limit)

    # Multi-value filters: merge repeated flags + comma-separated values into one flat,
    # de-duplicated list each (the server UNIONs within a filter via `IN`, ANDs across them).
    session_id = collect_multi(session_id)
    agent_id = collect_multi(agent_id)
    event_type = collect_multi(event_type)
    environment = collect_multi(environment)

    # Default to the light, payload-free feed (/api/events/summary). Only reach for the heavy
    # full feed (/api/events, with `payload`) when the caller EXPLICITLY asks for the raw
    # payload: --full, or --fields payload. Everything else — including --session-id — stays
    # on the light feed: the full feed is slow/timeout-prone at scale, a single-session read
    # wants the summaries/timeline (not the fat payload), and payload is a deliberate opt-in.
    use_full = full or (cols is not None and "payload" in cols)
    fetch = api.list_events if use_full else api.list_event_summaries

    common = dict(
        session_id=session_id,
        agent_id=agent_id,
        event_type=event_type,
        environment=environment,
        order=order,
        search=search,
        ts_from=frm,
        ts_to=to,
    )

    if fetch_all:
        items = list(
            api.paginate(
                lambda cursor, limit: fetch(cctx, cursor=cursor, limit=limit, **common),
                limit=limit,
                page_size=page_size,
                start_cursor=cursor,
            )
        )
        next_cursor = None
    else:
        page = fetch(cctx, cursor=cursor, limit=limit, **common)
        items = page.items
        next_cursor = page.next_cursor

    if state.json:
        payload = output.project_dicts(items, cols) if cols else items
        output.emit_json({"events": payload, "next_cursor": next_cursor})
        return

    # Which narrowing filters did the user actually set? Used to (a) word the empty-box
    # message and (b) nudge them to re-check those values when 0 rows come back — the server
    # returns an empty set for any value that matches nothing, so a typo looks like "no data".
    active_filters = [
        flag for flag, val in (
            ("--env", environment),
            ("--event-type", event_type),
            ("--agent-id", agent_id),
            ("--session-id", session_id),
            ("--search", search),
            ("--since/--from/--to", since or ts_from or ts_to),
        ) if val
    ]

    if cols:
        # `--fields` asks for specific columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(items, cols), title=f"Events ({len(items)})")
    else:
        empty_message = "no events match these filters" if active_filters else "no events in this window"
        output.render_events(items, order=order, empty_message=empty_message)
    output.events_footer(len(items), more=next_cursor is not None)
    if not items:
        output.recheck_filters_hint(active_filters)


def register(app: typer.Typer) -> None:
    app.command("events", epilog=GLOBALS_EPILOG)(events)
