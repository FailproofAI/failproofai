"""Human views for the additive Cloud CLI surface.

JSON output never passes through this module. Tables stay tables at narrow widths;
long prose wraps beside grey labels rather than becoming FIELD / VALUE blocks.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from rich.text import Text

from . import output, theme


def begin(title: str) -> None:
    output.screen_header()
    output._stdout.print(Text(title.upper(), style="bold"))


def value(data: Any) -> str:
    """Human text, never a Python repr or serialized JSON container."""
    if data is None:
        return "—"
    if isinstance(data, bool):
        return "yes" if data else "no"
    if isinstance(data, dict):
        return "; ".join(f"{label(k)}: {value(v)}" for k, v in data.items())
    if isinstance(data, (list, tuple)):
        return ", ".join(value(v) for v in data) or "none"
    return str(data)


def label(key: Any) -> str:
    return str(key).replace("_", " ").removesuffix(" source")


def state(enabled: Any, *, on="enabled", off="disabled") -> Text:
    if enabled is None:
        return Text("unknown", style=theme.LABEL)
    return Text("● " + on, style=theme.ACCENT) if enabled else Text("○ " + off, style=theme.LABEL)


def kv(pairs) -> None:
    rows = [(label(k), v) for k, v in pairs if v is not None]
    if not rows:
        return
    table = output.Table.grid(padding=(0, 2, 0, 0), pad_edge=False)
    table.add_column(width=max(len(k) for k, _ in rows) + 2, style=theme.LABEL)
    table.add_column(ratio=1, overflow="fold")
    for key, item in rows:
        table.add_row(Text("  " + key, style=theme.LABEL), item if isinstance(item, Text) else Text(value(item)))
    output._stdout.print(table)


def line(text: str) -> None:
    output._stdout.print(Text("  " + text))


def next_command(text: str) -> None:
    output._stdout.print(Text("  " + text, style=theme.PINK))


def empty(message: str, command: str) -> None:
    line(message)
    next_command(command)


def table(columns, rows, *, empty_message: str, command: str) -> None:
    if not rows:
        empty(empty_message, command)
        return
    grid = output.Table(box=None, padding=(0, 2, 0, 0), pad_edge=False, header_style=theme.LABEL)
    for column in columns:
        grid.add_column(column, overflow="fold")
    for row in rows:
        grid.add_row(*[v if isinstance(v, Text) else Text(value(v)) for v in row])
    output._stdout.print(grid)


def collection(data: Any, *keys: str) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            if isinstance(data.get(key), list):
                return data[key]
    return []


def detail(data: Any, *, skip=()) -> None:
    """Render nested API detail as named sections, not opaque structures."""
    if isinstance(data, dict):
        scalar = [(k, v) for k, v in data.items() if k not in skip and not isinstance(v, (dict, list))]
        kv(scalar)
        for key, item in data.items():
            if key in skip or not isinstance(item, (dict, list)):
                continue
            if not item:
                kv([(key, "none")])
            elif isinstance(item, dict):
                line(label(key))
                detail(item)
            elif all(not isinstance(v, (dict, list)) for v in item):
                kv([(key, item)])
            else:
                line(label(key))
                for row in item:
                    detail(row)
                    output._stdout.print()
    elif isinstance(data, list):
        for row in data:
            detail(row)
    elif data is not None:
        line(value(data))


def envelope(row: dict) -> dict:
    try:
        source = json.loads(row.get("evaluator_source") or "")
    except (ValueError, TypeError):
        return {}
    return source if isinstance(source, dict) else {}


def evaluator_kind(row: dict) -> str:
    source = envelope(row)
    if source.get("kind") == "judge":
        return "LLM judge"
    if source.get("kind") == "jev":
        return "Jev " + str(source.get("type", ""))
    return "code"


def version(raw: Any) -> str:
    text = value(raw)
    return text if text.startswith("v") else "v" + text


def evaluator(row: dict, title="Evaluator") -> None:
    begin(title)
    kv([
        ("key", row.get("eval_key")), ("version", row.get("eval_version")),
        ("name", row.get("display_name")), ("kind", evaluator_kind(row)),
        ("enabled", state(row.get("enabled", True))), ("condition", row.get("condition_source") or "always"),
        ("result kind", row.get("result_kind", "score")), ("labels", row.get("labels", [])),
        ("id", row.get("id")),
    ])
    source = envelope(row)
    if source.get("kind") == "judge":
        kv([("criteria", source.get("criteria")),
            ("threshold", source["threshold"] if source.get("threshold") is not None else "server default")])
        for i, step in enumerate(source.get("steps") or [], 1):
            kv([(f"step {i}", step)])
    elif source.get("kind") == "jev":
        kv([("instructions", source.get("instructions")),
            ("threshold", source["threshold"] if source.get("threshold") is not None else "server default")])
        criteria = source.get("criteria")
        if isinstance(criteria, dict):
            kv([(str(k), v) for k, v in criteria.items()])
        elif isinstance(criteria, list):
            for i, level in enumerate(criteria, 1):
                kv([(f"level {i}", level)])
    else:
        kv([("source", row.get("evaluator_source")), ("timeout", row.get("timeout_seconds"))])


def evaluators(data: Any) -> None:
    begin("Evaluators")
    items = collection(data, "definitions")
    table(["key", "version", "kind", "enabled", "labels"], [
        [r.get("eval_key"), r.get("eval_version"), evaluator_kind(r),
         state(r.get("enabled", True)), r.get("labels", [])] for r in items
    ], empty_message="no evaluators yet", command="fp evaluators create --help")


def deployed(created: dict, predecessors: list) -> None:
    begin("Evaluator deployed")
    text = Text(f"  deployed {created.get('eval_key', 'evaluator')} {version(created.get('eval_version'))} ")
    text.append_text(state(created.get("enabled", True)))
    if predecessors:
        text.append(" · disabled " + ", ".join(version(r.get("eval_version")) for r in predecessors))
    output._stdout.print(text)
    kv([("id", created.get("id"))])


def score_of(result: Any) -> Any:
    if not isinstance(result, dict):
        return None
    score = result.get("score")
    if isinstance(score, dict):
        return score.get("value")
    return score if score is not None else result.get("scores")


def dry_run(data: dict) -> None:
    begin("Evaluator dry-run")
    runs = collection(data, "runs")
    if not runs and "ok" in data:
        runs = [data]
    if not runs:
        detail(data)
        return
    for run in runs:
        result = run.get("result") or {}
        skipped = run.get("applicable") is False
        status = "skipped" if skipped else "passed" if run.get("ok") else "failed"
        glyph = "○" if skipped else "✓" if run.get("ok") else "✕"
        line(f"{glyph} {run.get('session_id') or 'compile only'} · {status}")
        kv([
            ("score", score_of(result)), ("reasoning", result.get("reasoning") if isinstance(result, dict) else None),
            ("error", run.get("error_message") or run.get("error_kind")),
            ("duration ms", run.get("duration_ms")),
        ])
    summary = data.get("summary")
    if isinstance(summary, dict):
        line(" · ".join(f"{summary.get(k, 0)} {k}" for k in ("succeeded", "failed", "skipped")))


def roles(data: Any, *, listing: bool) -> None:
    begin("Roles" if listing else "Role")
    if listing:
        table(["name", "built-in", "users", "permissions"], [
            [r.get("name"), state(r.get("is_builtin", False), on="yes", off="no"),
             r.get("user_count", 0), len(r.get("permissions") or [])]
            for r in collection(data, "permission_sets", "roles")
        ], empty_message="no custom roles yet", command="fp roles create --name reviewer --permission events:read")
    elif isinstance(data, dict):
        kv([("name", data.get("name")), ("built-in", data.get("is_builtin")),
            ("users", data.get("user_count")), ("description", data.get("description"))])
        kv([("permissions", data.get("permissions", []))])


def dashboards(data: Any, *, listing=False, tile_view=False, dashboard_id=None) -> None:
    if tile_view:
        begin("Tiles")
        items = collection(data, "tiles") if listing else [data]
        table(["title", "chart", "query", "id"], [
            [r.get("title") or "untitled", r.get("chart_type"), r.get("query_id"), r.get("id")]
            for r in items if isinstance(r, dict)
        ], empty_message="no tiles yet",
            command=f"fp dashboards tiles {dashboard_id or '<id>'} add --query <query-id> --chart table")
        return
    begin("Dashboards" if listing else "Dashboard")
    if listing:
        table(["name", "tiles", "description", "id"], [
            [r.get("name"), r.get("tile_count", 0), r.get("description") or "—", r.get("id")]
            for r in collection(data, "dashboards")
        ], empty_message="no dashboards yet", command="fp dashboards create --name Quality")
    elif isinstance(data, dict):
        row = data.get("dashboard", data)
        kv([("name", row.get("name")), ("description", row.get("description")), ("id", row.get("id"))])
        if row.get("definition"):
            line("filters and display")
            detail(row["definition"])
        if "tiles" in data:
            dashboards(data["tiles"], listing=True, tile_view=True, dashboard_id=row.get("id"))


def query_result(data: dict, title="Query result") -> None:
    begin(title)
    columns = [c.get("name", "") if isinstance(c, dict) else str(c) for c in data.get("columns", [])]
    table(columns, data.get("rows", []), empty_message="query returned no rows", command="fp query schema")
    kv([("elapsed ms", data.get("elapsed_ms")), ("truncated", data.get("truncated"))])


def sentiment(data: Any, mode: str) -> None:
    begin("Sentiment" if not mode else "Sentiment " + mode)
    mode = "session" if mode.startswith("sessions/") else mode
    items = collection(data, mode, "items", "messages", "sessions")
    if isinstance(data, list) or items or isinstance(data, dict) and any(k in data for k in (mode, "items")):
        columns = ["session", "sentiment", "score", "message"] if mode == "messages" else ["session", "sentiment", "negative", "messages"]
        def strongest(row):
            scores = row.get("scores") or {}
            numeric = [(k, v) for k, v in scores.items() if isinstance(v, (int, float))]
            return max(numeric, key=lambda pair: pair[1]) if numeric else ("—", "—")
        table(columns, [
            [r.get("session_id"), r.get("sentiment") or r.get("label") or r.get("feeling") or strongest(r)[0],
             r.get("score", r.get("negative", r.get("negative_score", strongest(r)[1]))),
             r.get("text") or r.get("message") if mode == "messages" else r.get("message_count", r.get("messages_count"))]
            for r in items if isinstance(r, dict)
        ], empty_message="no sentiment results in this range", command="fp settings set sentiment.enabled --json-value true")
    else:
        detail(data)
        if not data:
            empty("no sentiment results yet", "fp settings set sentiment.enabled --json-value true")


def plan(data: dict) -> None:
    begin("Plan")
    offers = data.get("offers", {})
    items = collection(offers, "offers")
    table(["offer", "tier", "status", "expires"], [
        [r.get("offer_key", r.get("key")), r.get("tier", r.get("plan")), r.get("status"),
         r.get("expires_at")] for r in items if isinstance(r, dict)
    ], empty_message="no offers available", command="fp usage")
    trial = data.get("team_trial", {})
    line("team trial")
    if trial:
        detail(trial)
    else:
        line("no active team trial")


def brief(data: dict) -> None:
    begin("Home brief")
    for key in ("greeting", "summary"):
        if data.get(key):
            line(str(data[key]))
    for block in data.get("blocks", []):
        artifact(block)
    if not data.get("blocks"):
        empty("no brief blocks yet", 'fp agent ask "Summarize my recent sessions"')


def artifact(block: dict) -> None:
    data = block.get("result")
    if isinstance(data, dict):
        query_result(data, block.get("title", "Artifact"))
    else:
        begin(block.get("title", "Home"))
        for key in ("text", "note"):
            if block.get(key):
                line(str(block[key]))
        for key in ("items", "sessions"):
            for item in block.get(key, []):
                detail(item)


def resource(path: str, method: str, data: Any, body=None, params=None) -> None:
    """Request-specific human views used by shared mutation orchestrators."""
    body = body if isinstance(body, dict) else {}
    row = data if isinstance(data, dict) else {}
    parts = path.removeprefix("/api/").split("/")
    family = parts[0]
    if family == "permission-sets":
        if method == "DELETE":
            begin("Role deleted")
            line(f"deleted {parts[-1]} · members keep their permissions")
        else:
            roles({**body, **row} if method != "GET" else data, listing=len(parts) == 1 and method == "GET")
    elif family == "dashboards":
        if method == "DELETE":
            begin("Tile removed" if "tiles" in parts else "Dashboard deleted")
            kv([("id", parts[-1])])
        elif parts[-1] == "layout":
            begin("Tile layout updated")
            kv([("tiles updated", row.get("updated", len(body.get("tiles", []))))])
        else:
            dashboards(data, listing=method == "GET" and (len(parts) == 1 or parts[-1] == "tiles"),
                       tile_view="tiles" in parts, dashboard_id=parts[1] if len(parts) > 1 else None)
    elif family == "otel" or family == "settings" and parts[-1] == "otel.ingest_enabled":
        begin("OTEL")
        kv([("ingest", state(row.get("enabled", row.get("value", body.get("value"))))),
            ("events 24h", row.get("events_24h")), ("last received", row.get("last_received_at")),
            ("content missing", row.get("content_missing"))])
        services = collection(row, "services")
        table(["service", "events", "last received"], [
            [r.get("name", r.get("service_name")), r.get("event_count", r.get("events")), r.get("last_received_at")]
            if isinstance(r, dict) else [r, "—", "—"] for r in services
        ], empty_message="no OTEL services yet", command="fp otel enable")
    elif family == "integrations":
        begin("Slack")
        connection = row.get("integration", row.get("connection", row))
        connection = connection if isinstance(connection, dict) else {}
        kv([("connection", state(method != "DELETE" and connection.get("connected", connection.get("installed", bool(connection))),
                                 on="connected", off="disconnected")),
            ("workspace", connection.get("team_name", connection.get("workspace_name"))),
            ("channel", connection.get("channel_name")), ("connected at", connection.get("created_at"))])
        if method == "DELETE":
            line("Slack disconnected")
        elif not connection:
            line("Connect Slack from your Cloud integration settings.")
    elif family == "settings":
        begin("Context windows")
        if method == "GET":
            table(["model", "tokens", "updated"], [
                [r.get("model_id"), r.get("context_window"), r.get("updated_at")]
                for r in collection(data, "model_context_windows")
            ], empty_message="no model overrides yet", command="fp settings context-windows set <model> <tokens>")
        else:
            kv([("model", row.get("model_id", body.get("model_id", (params or {}).get("model")))),
                ("tokens", row.get("context_window", body.get("context_window")))])
            if method == "DELETE":
                line("override removed")
    elif family == "offers":
        begin("Offer claimed")
        kv([("offer", body.get("offer_key"))])
        detail(data)
    elif family == "users":
        begin("Member deleted" if method == "DELETE" else "Member defaults")
        if method == "DELETE":
            kv([("id", parts[-1])])
        else:
            detail(data)
    elif family == "orgs":
        begin("Organization created")
        kv([("name", row.get("name", body.get("name"))), ("slug", row.get("slug", body.get("slug"))),
            ("id", row.get("id")), ("plan", row.get("plan"))])
        next_command(f"fp orgs switch {row.get('slug', body.get('slug', '<slug>'))}")
    elif family == "usage":
        begin("Usage windows")
        table(["from", "to", "events", "evaluations"], [
            [r.get("from", r.get("starts_at")), r.get("to", r.get("ends_at")),
             r.get("events_ingested", (r.get("usage") or {}).get("events_ingested")),
             r.get("evaluations", (r.get("usage") or {}).get("evaluations"))]
            for r in collection(data, "windows")
        ], empty_message="no historical usage windows yet", command="fp usage")
    elif family == "alerts":
        begin("Alert recipients" if parts[-1] == "recipients" else "Alert issues")
        items = collection(data, "recipients", "issues")
        if method != "GET":
            items = [data]
        if parts[-1] == "recipients":
            table(["recipient", "channel"], [
                [r.get("email", r.get("name")), r.get("channel", "email")] if isinstance(r, dict) else [r, "email"] for r in items
            ], empty_message="no recipients available", command="fp users list")
        else:
            table(["title", "status", "severity", "id"], [
                [r.get("title"), r.get("state", r.get("status")), r.get("severity"), r.get("id")] for r in items
            ], empty_message="no issues for this alert", command=f"fp alerts issues {parts[1]} --create --title <title>")
    elif family == "audits":
        begin("Agent contracts")
        if method == "GET" and len(parts) == 2:
            table(["agent", "enabled", "purpose", "id"], [
                [r.get("agent_id"), state(r.get("enabled", True)), r.get("purpose"), r.get("id")]
                for r in collection(data, "contracts")
            ], empty_message="no agent contracts yet", command="fp audits contracts create --agent-id <agent> --body @agent.md")
        else:
            kv([("agent", row.get("agent_id", body.get("agent_id"))), ("enabled", state(row.get("enabled", True))),
                ("id", row.get("id")), ("body", row.get("body", body.get("body")))])
    else:
        begin(label(family))
        detail(data)


def render(data: Any, title: str, *, view: Optional[str] = None, body=None, method="GET", params=None) -> None:
    """Explicit views for commands without the shared resource orchestrator."""
    if view and view.startswith("/api/"):
        resource(view, method, data, body, params)
    elif title == "Evaluators":
        evaluators(data)
    elif title in ("Evaluator", "Evaluator created", "Evaluator labels"):
        evaluator(data, title)
    elif title == "Evaluator draft":
        evaluator(data.get("spec", {}), title)
        kv([("file", data.get("out"))])
        next_command(f"fp evaluators create --file {data.get('out')}")
    elif title == "Evaluator dry-run":
        dry_run(data)
    elif title == "Instances":
        begin(title)
        table(["name", "kind", "enabled", "evaluators", "queued", "id"], [
            [r.get("name"), r.get("kind"), state(r.get("enabled", True)), r.get("eval_count", 0), r.get("queued", 0), r.get("id")]
            for r in collection(data, "instances")
        ], empty_message="no managed instances available", command="Check your Cloud managed-evaluator deployment.")
    elif title == "Schema profile":
        begin(title)
        kv([(k, data.get(k)) for k in ("window_days", "sampled_events")] if isinstance(data, dict) else [])
        for event in collection(data, "event_types"):
            line(f"{event.get('event_type')} · {event.get('count', 0)} events")
            table(["payload key", "type", "presence"], [
                [r.get("key"), r.get("type"), r.get("presence")] for r in event.get("keys", [])
            ], empty_message="no sampled payload keys", command="fp events --since 24h")
        if not collection(data, "event_types"):
            empty("no sampled event types yet", "fp events --since 24h")
    elif title == "Evaluation jobs":
        begin(title)
        table(["session", "evaluator", "status", "id"], [
            [r.get("session_id"), r.get("eval_key"), r.get("status"), r.get("id")]
            for r in collection(data, "jobs", "evaluation_jobs")
        ], empty_message="no evaluation jobs", command="fp sessions re-evaluate <session-id>")
    elif title == "Evaluation backfill":
        begin(title)
        detail(data)
        next_command("fp evaluators jobs")
    elif title == "Session re-evaluation":
        begin("Re-evaluate")
        count = data.get("v2_assignments_queued", data.get("queued_count"))
        session_id = data.get("session_id") or body
        if count is not None:
            line(f"queued {count} evaluation{'s' if count != 1 else ''} for {session_id}")
        else:
            line(f"re-evaluation queued for {session_id}" if data.get("queued") or data.get("status") == "queued" else "No evaluations queued.")
    elif title == "Session":
        begin(title)
        row = data.get("overview", data)
        kv([(k, row.get(k)) for k in ("session_id", "agent_id", "environment", "status", "event_count", "started_at", "last_event_at")])
        begin("Timeline")
        table(["time", "type", "agent", "summary"], [
            [r.get("ts"), r.get("event_type"), r.get("agent_id"), r.get("summary")]
            for r in collection(data.get("timeline", data), "events")
        ], empty_message="no events in this session", command="fp events --session-id " + str(row.get("session_id", "<id>")))
    elif title == "Evaluation history":
        begin(title)
        table(["evaluator", "version", "status", "score", "finished"], [
            [r.get("eval_key"), r.get("eval_version"), r.get("status"), score_of(r), r.get("finished_at")]
            for r in collection(data, "evaluations", "history", "items")
        ], empty_message="no evaluations for this session", command="fp sessions re-evaluate <session-id>")
    elif title == "Sentiment":
        sentiment(data, view or "")
    elif title == "Plan":
        plan(data)
    elif title == "Composed query":
        begin(title)
        kv([("SQL", data.get("sql"))])
        if data.get("result"):
            query_result(data["result"])
    elif title in ("Query exported", "Session exported"):
        begin(title)
        kv([("file", data.get("out")), ("format", data.get("format"))])
    elif title in ("Policy draft", "Policy backtest", "Policy candidacy"):
        begin(title)
        detail(data)
        if title == "Policy draft":
            line("Draft only — nothing published or deployed.")
    elif title == "Event latency":
        begin(title)
        detail(data)
    else:
        begin(title)
        detail(data)
