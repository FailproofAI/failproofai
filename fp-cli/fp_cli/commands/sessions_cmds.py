"""sessions — list agent sessions (newest first) with their run status."""

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
    validate_choice,
    validate_limit,
)
from ..models import Session


def sessions(
    ctx: typer.Context,
    limit: int = typer.Option(50, "--limit", "-n", help="Max rows in total. Use --all to auto-paginate beyond the server's single-request cap."),
    since: Optional[str] = typer.Option(None, "--since", help=f"Relative window from now (dashboard presets): {', '.join(dates.SINCE_CHOICES)}."),
    ts_from: Optional[str] = typer.Option(None, "--from", help="Custom-range start, ISO-8601 UTC (e.g. 2026-05-01T00:00:00Z). Overrides --since."),
    ts_to: Optional[str] = typer.Option(None, "--to", help="Custom-range end, ISO-8601 UTC. Overrides --since."),
    environment: Optional[List[str]] = typer.Option(None, "--env", help="Filter by environment. Accepts multiple — repeat the flag or comma-separate: `--env prod --env staging` or `--env prod,staging` (matches any)."),
    status: Optional[List[str]] = typer.Option(None, "--status", help="Filter by run status (`done`/`error`/`timeout`), matched against each session's latest evaluation. Accepts multiple — repeat the flag or comma-separate: `--status error,timeout` (matches any)."),
    agent_id: Optional[List[str]] = typer.Option(None, "--agent-id", help="Filter by agent id. Accepts multiple — repeat the flag or comma-separate: `--agent-id a,b` (matches any)."),
    session_id: Optional[List[str]] = typer.Option(None, "--session-id", help="Filter by session id. Accepts multiple — repeat the flag or comma-separate: `--session-id a,b` (matches any)."),
    fetch_all: bool = typer.Option(False, "--all", help="Auto-paginate through all pages, up to --limit."),
    cursor: Optional[str] = typer.Option(None, "--cursor", help="Resume after this cursor (a prior next_cursor; opaque token)."),
    page_size: Optional[int] = typer.Option(None, "--page-size", help="Rows per request when --all (max 200)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of fields to output (applies to --json and the table). e.g. `session_id,status,last_event_at`."),
    full_ids: bool = typer.Option(False, "--full-ids", help="Show full session ids in the table instead of truncating them (--json always has the full id)."),
    agents_expand: bool = typer.Option(False, "--agents", help="Expand every multi-agent session into an indented roster of its agents (name + event count). Rendered view only — `--json` always carries the full `agents` list."),
) -> None:
    """List **sessions** — one row per agent run, newest first.

    Shows what ran and how it ended: `time · env · agent · session · status`. `status` is the
    session's latest evaluation outcome (`done`/`error`/`timeout`, blank if it was never
    evaluated). For the per-evaluation **scores** behind a session — and rolled-up score stats —
    use `fp evals`.

    The filters `--env`, `--status`, `--agent-id`, and `--session-id` each accept **multiple
    values** — repeat the flag or comma-separate (`--status error,timeout` is the same as
    `--status error --status timeout`). Values within one filter match **any** of them; different
    filters are combined (a session must satisfy all of them). Scope by time with `--since` (a
    preset window) or `--from`/`--to` (a custom UTC range), and page with `--all` or `--cursor`.

    A session can involve **more than one agent**. The `agent` column shows the root agent (the
    first to start) plus a `+N` badge counting the others; `--agents` expands every multi-agent
    session into an indented roster (each agent + its event count). `--agent-id` matches a session
    if **any** of its agents is one you named (not just the root).

    Needs `evaluations:read`. With `--json`: `{"sessions": [...], "next_cursor": <cursor or null>}`.
    Each row has `session_id, agent_id, agents, environment, status, scores, event_count,
    started_at, last_event_at, first_event_id, last_event_id, latest_evaluation` (also the valid
    `--fields` names) — `agent_id` is the root agent and `agents` is the full roster (each
    `{agent_id, event_count}`, sorted by event count); `status` and `scores` are flattened up from
    the latest evaluation for convenience, and the full evaluation is kept under `latest_evaluation`.

    Examples:

    * `fp sessions --env prod,staging --status error,timeout` — recent prod/staging runs that errored or timed out
    * `fp sessions --agent-id agent-orderbot --since 24h` — every session agent-orderbot took part in over the last 24h
    * `fp sessions --agents` — expand each multi-agent session to its full agent roster
    * `fp --json sessions --all --fields session_id,agents | jq '.sessions'` — every session's full agent roster as JSON
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    validate_limit(limit)
    frm, to = resolve_dates(since, ts_from, ts_to)
    cols = resolve_fields(fields, Session)

    # Multi-value filters: merge repeated flags + comma-separated values into one flat,
    # de-duplicated list each (the server UNIONs within a filter via `IN`, ANDs across them).
    environment = collect_multi(environment)
    status = collect_multi(status)
    agent_id = collect_multi(agent_id)
    session_id = collect_multi(session_id)
    # Validate each status value client-side (clean exit 2) rather than a server 400.
    for s in status or []:
        validate_choice(s, ("done", "error", "timeout"), flag="--status")

    def fetch(cursor: Optional[str], limit: Optional[int]):
        return api.list_sessions(
            cctx,
            session_id=session_id,
            agent_id=agent_id,
            environment=environment,
            status=status,
            ts_from=frm,
            ts_to=to,
            cursor=cursor,
            limit=limit,
        )

    if fetch_all:
        items = list(api.paginate(fetch, limit=limit, page_size=page_size, start_cursor=cursor))
        next_cursor = None
    else:
        page = fetch(cursor, limit)
        items = page.items
        next_cursor = page.next_cursor

    if state.json:
        payload = output.project_dicts(items, cols) if cols else items
        output.emit_json({"sessions": payload, "next_cursor": next_cursor})
        return

    # Which narrowing filters did the user set? Used to word the empty-box message and to
    # nudge them to re-check those values when 0 rows come back (a value matching nothing
    # returns empty, not an error — so a typo looks like "no sessions").
    active_filters = [
        flag for flag, val in (
            ("--env", environment),
            ("--status", status),
            ("--agent-id", agent_id),
            ("--session-id", session_id),
            ("--since/--from/--to", since or ts_from or ts_to),
        ) if val
    ]

    if cols:
        # `--fields` asks for specific columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(items, cols), title=f"Sessions ({len(items)})")
    else:
        empty_message = "no sessions match these filters" if active_filters else "no sessions"
        if agents_expand:
            output.render_sessions_expanded(items, full_ids=full_ids, empty_message=empty_message)
        else:
            output.render_sessions(items, full_ids=full_ids, empty_message=empty_message)
    multi_agent = sum(1 for e in items if output.is_multi_agent(e))
    output.sessions_footer(len(items), more=next_cursor is not None, multi_agent=multi_agent)
    if not items:
        output.recheck_filters_hint(active_filters)


def register(app: typer.Typer) -> None:
    app.command("sessions", epilog=GLOBALS_EPILOG)(sessions)
