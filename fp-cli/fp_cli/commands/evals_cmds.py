"""evals — list evaluation results (with scores), or roll them up with --aggregate."""

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
    validate_score_filters,
)
from ..models import Evaluation


def evals(
    ctx: typer.Context,
    aggregate: bool = typer.Option(False, "--aggregate", help="Roll the matching evaluations up into a totals card + per-metric score stats, instead of listing rows."),
    limit: int = typer.Option(50, "--limit", "-n", help="Max rows in total (list mode). Use --all to auto-paginate beyond the server's single-request cap."),
    since: Optional[str] = typer.Option(None, "--since", help=f"Relative window from now (dashboard presets): {', '.join(dates.SINCE_CHOICES)}."),
    ts_from: Optional[str] = typer.Option(None, "--from", help="Custom-range start, ISO-8601 UTC (e.g. 2026-05-01T00:00:00Z). Overrides --since."),
    ts_to: Optional[str] = typer.Option(None, "--to", help="Custom-range end, ISO-8601 UTC. Overrides --since."),
    environment: Optional[str] = typer.Option(None, "--env", help="Filter to one environment (exact match). e.g. `prod`."),
    status: Optional[str] = typer.Option(None, "--status", help="Filter to one evaluation status: `done`, `error`, or `timeout`."),
    agent_id: Optional[str] = typer.Option(None, "--agent-id", help="Filter to one agent id (exact match)."),
    session_id: Optional[str] = typer.Option(None, "--session-id", help="Filter to one session id (exact match)."),
    score: Optional[List[str]] = typer.Option(None, "--score", help="Score range filter `KEY:MIN..MAX` (either bound optional). Repeatable; all must match. e.g. `helpfulness:0.5..0.8`."),
    fetch_all: bool = typer.Option(False, "--all", help="Auto-paginate through all pages, up to --limit (list mode)."),
    cursor: Optional[str] = typer.Option(None, "--cursor", help="Resume after this cursor (a prior next_cursor; opaque token; list mode)."),
    page_size: Optional[int] = typer.Option(None, "--page-size", help="Rows per request when --all (max 200; list mode)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of fields to output (list mode). e.g. `session_id,status,scores`."),
    full_ids: bool = typer.Option(False, "--full-ids", help="Show full session ids in the table instead of truncating them (list mode; --json always has the full id)."),
    scores_full: bool = typer.Option(False, "--scores-full", help="Show every score pair in the table instead of the first few + `+N` (list mode; may wrap)."),
) -> None:
    """List **evaluation results** with their scores, newest first — or roll them up with
    **`--aggregate`**. An evaluation is one scored judgement of an agent run.

    Two modes, same filters:

    * **list** (default) — one row per evaluation: `time · env · agent · session · status · scores`.
    * **`--aggregate`** — a totals card (run-health mix + success rate) and a per-metric
      score-stats table (count, average + bar, min/max/p50) over the whole matching set, worst
      average first. Point it at one slice — an agent, env, session, or status — to read that
      slice's score performance.

    The filters `--env`, `--status`, `--agent-id`, and `--session-id` each take a **single**
    value; combine them to narrow a slice (they AND together). `--score KEY:MIN..MAX` filters by
    score range — either bound optional (`helpfulness:0.5..0.8`, `tool_efficiency:..0.3`,
    `factuality:0.9..`) — and is **repeatable**, with **all** ranges required (AND). Scope time
    with `--since` or `--from`/`--to`. Every filter applies to both modes.

    Needs `evaluations:read`. List `--json`: `{"evaluations": [...], "next_cursor": …}`.
    Aggregate `--json`: `{total, status_counts, score_stats[], timeline}`.

    Examples:

    * `fp evals --agent-id agent-orderbot --aggregate` — one agent's score performance, rolled up
    * `fp evals --aggregate --env prod --status error` — score stats for prod runs that failed
    * `fp evals --score helpfulness:0.8.. --since 7d` — recent evaluations scoring ≥0.8 on helpfulness
    * `fp --json evals --aggregate --session-id sess-001 | jq '.score_stats'` — one session's metric stats as JSON
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    validate_score_filters(score)
    validate_limit(limit)
    status = validate_choice(status, ("done", "error", "timeout"), flag="--status")
    frm, to = resolve_dates(since, ts_from, ts_to)
    score_filters = ",".join(score) if score else None

    # Which narrowing filters did the user set? Used to word the empty message and to nudge
    # them to re-check those values when nothing matches (a value matching nothing returns an
    # empty set, not an error — so a typo looks like "no evals"). Applies to both modes.
    active_filters = [
        flag for flag, val in (
            ("--env", environment),
            ("--status", status),
            ("--agent-id", agent_id),
            ("--session-id", session_id),
            ("--score", score),
            ("--since/--from/--to", since or ts_from or ts_to),
        ) if val
    ]

    # ── aggregate mode: one rolled-up payload, no pagination ──
    if aggregate:
        data = api.evaluation_aggregate(
            cctx,
            session_id=session_id,
            agent_id=agent_id,
            environment=environment,
            status=status,
            score_filters=score_filters,
            ts_from=frm,
            ts_to=to,
        )
        if state.json:
            output.emit_json(data)
        else:
            output.render_eval_aggregate(data)
            if not int(data.get("total", 0) or 0):
                output.recheck_filters_hint(active_filters)
        return

    # ── list mode ──
    cols = resolve_fields(fields, Evaluation)

    def fetch(cursor: Optional[int], limit: Optional[int]):
        return api.list_evaluations(
            cctx,
            session_id=session_id,
            agent_id=agent_id,
            environment=environment,
            status=status,
            score_filters=score_filters,
            ts_from=frm,
            ts_to=to,
            cursor=cursor,
            limit=limit,
        )

    if fetch_all:
        walk = api.Walk()
        items = list(
            api.paginate(fetch, limit=limit, page_size=page_size, start_cursor=cursor, walk=walk)
        )
        # NOT `None`. `--limit` defaults to 50, so `--all` without an explicit
        # limit stops at 50 rows — and hard-coding the cursor to null told the
        # caller the feed was exhausted, on the one output a script or an agent
        # reads. `walk` carries the cursor the walk actually stopped on.
        next_cursor = walk.next_cursor
    else:
        page = fetch(cursor, limit)
        items = page.items
        next_cursor = page.next_cursor

    if state.json:
        payload = output.project_dicts(items, cols) if cols else items
        output.emit_json({"evaluations": payload, "next_cursor": next_cursor})
        return

    if cols:
        # `--fields` asks for specific columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(items, cols), title=f"Evaluations ({len(items)})")
    else:
        empty_message = "no evals match these filters" if active_filters else "no evals"
        output.render_evals(items, full_ids=full_ids, scores_full=scores_full, empty_message=empty_message)
    output.evals_footer(len(items), more=next_cursor is not None)
    if not items:
        output.recheck_filters_hint(active_filters)


def register(app: typer.Typer) -> None:
    app.command("evals", epilog=GLOBALS_EPILOG)(evals)
