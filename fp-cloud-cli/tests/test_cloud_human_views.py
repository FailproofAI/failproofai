"""Real command output with server-shaped payloads at both terminal widths."""

import json
import os
from pathlib import Path

import httpx
import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"
CODE = 'EvalResult(score=Score(0.7), reasoning="Tool usage")'
DEFINITION = {
    "eval_key": "tool_usage", "display_name": "Tool usage", "eval_version": "1",
    "result_kind": "score", "enabled": True, "labels": ["tools", "reliability"],
    "condition_source": 'session.agent_id == "support-bot"', "evaluator_source": CODE,
    "id": "b370402a-0ace-4e45-9c1c-d40e7062b5ea", "created_at": "2026-10-14T05:26:14Z",
}
ROLE = {"name": "reviewer", "is_builtin": False, "user_count": 3,
        "permissions": ["events:read", "evaluations:read", "queries:run", "users:read"],
        "description": "Review agent quality"}
DASHBOARD = {"id": "board1", "name": "Quality", "description": "Review production agents",
             "tile_count": 1, "definition": {"filters": {"env": ["prod"]}}}
TILE = {"id": "tile1", "query_id": "query1", "title": "Traffic", "chart_type": "bar",
        "chart_config": {"x": "agent", "y": "events"}, "param_bindings": {},
        "pos_x": 0, "pos_y": 0, "pos_w": 6, "pos_h": 4}
DRY_RUN = {"runs": [{"session_id": "run-check", "ok": True, "mode": "run",
                    "result": {"score": {"value": 0.7}, "reasoning": "Seven tool calls"},
                    "duration_ms": 8}],
           "summary": {"succeeded": 1, "failed": 0, "skipped": 0}}
QUERY = {"columns": [{"name": "agent", "type": "String"}, {"name": "events", "type": "UInt64"}],
         "rows": [["support-bot", 7]], "elapsed_ms": 9, "truncated": False}
SESSION = {"session_id": "run-check", "agent_id": "support-bot", "environment": "prod",
           "event_count": 7, "status": "done"}
CONTRACT = {"id": "contract1", "agent_id": "support-bot", "body": "# Purpose\nResolve requests",
            "enabled": True, "purpose": "Resolve requests"}


def response(request):
    path = request.url.path
    method = request.method
    body = json.loads(request.content) if request.content else {}
    data = {
        "/api/evaluator-instances": {"instances": [
            {"name": "failproof-managed", "kind": "managed", "enabled": True, "eval_count": 4,
             "queued": 2, "id": "instance1"}]},
        "/api/evaluator-schema-profile": {"window_days": 7, "sampled_events": 100, "event_types": [
            {"event_type": "tool_use", "count": 100, "keys": [{"key": "tool_name", "type": "string", "presence": 1.0}]}]},
        "/api/evaluation-jobs": {"jobs": [{"session_id": "run-check", "eval_key": "tool_usage",
                                        "status": "queued", "id": "job1"}]},
        "/api/evaluations/backfill": {"queued": True, "sessions": 12, "eval_key": "tool_usage"},
        "/api/permission-sets": [ROLE],
        "/api/permission-sets/reviewer": ROLE,
        "/api/dashboards": {"dashboards": [DASHBOARD]},
        "/api/dashboards/board1": {"dashboard": DASHBOARD, "tiles": [TILE]},
        "/api/dashboards/board1/tiles": {"tiles": [TILE]},
        "/api/dashboards/board1/tiles/tile1": TILE,
        "/api/dashboards/board1/tiles/layout": {"updated": 1},
        "/api/sessions": {"sessions": [SESSION]},
        "/api/events/summary": {"events": [{"ts": "2026-10-14T05:26:14Z", "event_type": "tool_use",
                                          "agent_id": "support-bot", "summary": "Read customer request"}]},
        "/api/sessions/run-check/export": {**SESSION, "events": []},
        "/api/sessions/run-check/evaluation-history": {"evaluations": [
            {"eval_key": "tool_usage", "eval_version": "1", "status": "done",
             "score": {"value": 0.7}, "finished_at": "2026-10-14T05:26:14Z"}]},
        "/api/sessions/run-check/re-evaluate": {
            "session_id": "run-check", "status": "queued", "v2_assignments_queued": 1,
            "v2_assignment_ids": ["assignment-uuid"]},
        "/api/events/latency_aggregate": {"p50": 42, "p95": 145, "models": [
            {"model": "model1", "calls": 10, "p95_ms": 145}]},
        "/api/events/sentiment": {"totals": {"messages": 10, "flagged": 2, "sessions": 3},
                                 "averages": {"frustration": 0.2}, "timeline": [], "by_agent": []},
        "/api/events/sentiment/messages": {"items": [{"session_id": "run-check",
            "text": "Please try again", "scores": {"frustration": 0.8, "satisfaction": 0.1}}]},
        "/api/events/sentiment/sessions": {"sessions": [{"session_id": "run-check",
            "negative_score": 0.8, "message_count": 10, "feeling": "frustration"}]},
        "/api/events/sentiment/sessions/run-check": {"session_id": "run-check",
            "scores": {"frustration": 0.8}, "messages": []},
        "/api/queries/run": QUERY,
        "/api/alerts/recipients": {"recipients": [{"email": "ops@example.test", "channel": "email"}]},
        "/api/alerts/alert1/issues": {"issues": [{"title": "Too many failures", "state": "open",
                                               "severity": "warning", "id": "issue1"}]},
        "/api/audits/contracts": {"contracts": [CONTRACT]},
        "/api/audits/contracts/contract1": CONTRACT,
        "/api/agent/policy-backtest": {"matched": 4, "allowed": 6, "denied": 4,
                                     "examples": [{"session_id": "run-check", "reason": "Force push blocked"}]},
        "/api/agent/policy-candidacy": {"candidate": True, "reason": "Force push can be blocked", "intent": "Prevent force push"},
        "/api/issues/issue1": {"id": "issue1", "title": "Force push incident"},
        "/api/users/defaults": {"permission_set": "reviewer", "permissions": ROLE["permissions"]},
        "/api/usage/windows": {"windows": [{"from": "2026-09-01", "to": "2026-10-01",
                                          "usage": {"events_ingested": 300, "evaluations": 40}}]},
        "/api/offers/me": {"offers": [{"offer_key": "team_offer", "tier": "team",
                                     "status": "available", "expires_at": "2026-10-31"}]},
        "/api/team-trial/me": {"active": True, "ends_at": "2026-10-31"},
        "/api/offers/claim": {"claimed": True, "grant": {"tier": "team", "expires_at": "2026-10-31"}},
        "/api/settings/model-context-windows": {"model_context_windows": [
            {"model_id": "provider/model", "context_window": 64000, "updated_at": "2026-10-14"}]},
        "/api/otel/status": {"enabled": True, "events_24h": 10, "last_received_at": "2026-10-14",
                            "content_missing": False, "services": [{"service_name": "support-service", "events": 10}]},
        "/api/integrations/slack": {"connected": True, "team_name": "Reliability", "channel_name": "agent-alerts"},
        "/api/agent/home-brief": {"greeting": "Hello", "summary": "One session needs attention", "blocks": [
            {"title": "Traffic", "kind": "table", "sql": "SELECT 1"},
            {"title": "Next steps", "kind": "note", "text": "Inspect the failed session"}]},
    }.get(path)
    if path == "/api/evaluator-definitions":
        data = [DEFINITION] if method == "GET" else {**DEFINITION, **body, "id": "new-definition"}
    elif path.startswith("/api/evaluator-definitions/") and path.endswith("dry-run"):
        data = DRY_RUN
    elif path.startswith("/api/evaluator-definitions/"):
        data = {**DEFINITION, **body}
    elif path == "/api/agent/compose-eval":
        data = {k: v for k, v in DEFINITION.items() if k not in ("id", "created_at", "enabled")}
    elif path in ("/api/agent/compose-sql", "/api/agent/policy-author"):
        draft = {"sql": "SELECT agent, events FROM traffic"} if path.endswith("compose-sql") else {
            "source": "customPolicies.add({ name: 'no-force-push' });",
            "verdict": {"tone": "good", "reason": "Blocks force pushes"}, "tests": {"ran": 4, "passed": 4}}
        return httpx.Response(200, text="data: " + json.dumps({"type": "done", "result": draft}) + "\n\n",
                              headers={"content-type": "text/event-stream"})
    elif path == "/api/orgs":
        data = {"id": "org1", "name": body["name"], "slug": body["slug"], "plan": "free"}
    elif path == "/api/users/user1":
        data = {"deleted": True}
    elif path == "/api/settings/otel.ingest_enabled":
        data = {"key": "otel.ingest_enabled", **body}
    elif method == "DELETE":
        data = {"deleted": True}
    elif method in ("POST", "PUT"):
        if path == "/api/dashboards":
            data = {**DASHBOARD, **body}
        elif path.endswith("/tiles"):
            data = {**TILE, **body}
        elif path == "/api/permission-sets":
            data = {**ROLE, **body}
        elif path == "/api/audits/contracts":
            data = {**CONTRACT, **body}
        elif path == "/api/settings/model-context-windows":
            data = body
        elif path == "/api/alerts/alert1/issues":
            data = {"id": "issue1", "state": "open", **body}
    assert data is not None, f"missing realistic fake payload for {method} {path}"
    return httpx.Response(200, json=data)


CASES = [
    (["evaluators", "list"], "tool_usage"),
    (["evaluators", "show", "tool_usage@1"], "support-bot"),
    (["evaluators", "create", "--key", "tool_usage", "--name", "Tool usage", "--code", "{code}"], "code"),
    (["evaluators", "create", "--key", "resolution", "--name", "Resolution", "--judge",
      "--criteria", "Resolved the request", "--step", "Assess relevance", "--threshold", "0.7"], "LLM judge"),
    (["evaluators", "create", "--key", "frustration", "--name", "Frustration", "--jev", "noul",
      "--instructions", "Read user messages", "--true", "Frustrated", "--false", "Calm"], "Jev noul"),
    (["evaluators", "create", "--key", "quality", "--name", "Quality", "--jev", "score",
      "--instructions", "Grade answer", "--level", "Wrong", "--level", "Partial", "--level", "Correct"], "level 3"),
    (["evaluators", "deploy", "tool_usage", "--code", "{code}", "--dry-run-on", "run-check"], "disabled v1"),
    (["evaluators", "draft", "Measure tools", "--out", "{draft}"], "create --file"),
    (["evaluators", "dry-run", "--code", "{code}", "--session", "run-check"], "Seven tool calls"),
    (["evaluators", "enable", "tool_usage@1"], "● enabled"),
    (["evaluators", "disable", "tool_usage@1"], "○ disabled"),
    (["evaluators", "label", "tool_usage@1", "--add", "qa"], "qa"),
    (["evaluators", "instances"], "failproof-managed"),
    (["evaluators", "schema"], "tool_name"),
    (["evaluators", "jobs"], "queued"),
    (["evaluators", "backfill", "--from", "2026-10-01T00:00:00Z", "--to", "2026-10-08T00:00:00Z", "--dry-run"], "12"),
    (["dashboards", "list"], "Quality"),
    (["dashboards", "show", "board1"], "Traffic"),
    (["dashboards", "create", "--name", "Quality"], "Quality"),
    (["dashboards", "update", "board1", "--name", "New quality"], "board1"),
    (["dashboards", "delete", "board1"], "board1"),
    (["dashboards", "tiles", "board1", "list"], "Traffic"),
    (["dashboards", "tiles", "board1", "add", "--query", "query1", "--chart", "bar"], "query1"),
    (["dashboards", "tiles", "board1", "update", "tile1", "--title", "New traffic"], "tile1"),
    (["dashboards", "tiles", "board1", "remove", "tile1"], "tile1"),
    (["dashboards", "tiles", "board1", "layout", "--file", "{layout}"], "tiles updated"),
    (["roles", "list"], "reviewer"),
    (["roles", "show", "reviewer"], "queries:run"),
    (["roles", "create", "--name", "reviewer", "--permission", "events:read"], "events:read"),
    (["roles", "update", "reviewer", "--add", "users:read"], "users:read"),
    (["roles", "delete", "reviewer"], "members keep"),
    (["sessions", "show", "run-check"], "Read customer"),
    (["sessions", "export", "run-check", "--out", "{export}"], "file"),
    (["sessions", "export", "run-check"], "run-check"),
    (["sessions", "history", "run-check"], "tool_usage"),
    (["sessions", "re-evaluate", "run-check"], "queued 1 evaluation for run-check"),
    (["events", "latency"], "145"),
    (["sentiment", "summary"], "frustration"),
    (["sentiment", "messages"], "Please try again"),
    (["sentiment", "sessions"], "run-check"),
    (["sentiment", "session", "run-check"], "frustration"),
    (["query", "compose", "Count events"], "SELECT"),
    (["query", "compose", "Count events", "--run"], "support-bot"),
    (["query", "export", "--sql", "SELECT 1", "--format", "csv"], "support-bot"),
    (["query", "export", "--sql", "SELECT 1", "--format", "json"], "support-bot"),
    (["query", "export", "--sql", "SELECT 1", "--out", "{export}"], "file"),
    (["alerts", "recipients"], "ops@example.test"),
    (["alerts", "issues", "alert1"], "Too many failures"),
    (["alerts", "issues", "alert1", "--create", "--title", "Failure"], "Failure"),
    (["audits", "contracts", "list"], "support-bot"),
    (["audits", "contracts", "show", "contract1"], "Resolve requests"),
    (["audits", "contracts", "create", "--agent-id", "support-bot", "--body", "Resolve requests"], "Resolve requests"),
    (["audits", "contracts", "update", "contract1", "--body", "New purpose"], "support-bot"),
    (["policies", "author", "Prevent force pushes"], "nothing published"),
    (["policies", "backtest", "{policy}"], "Force push blocked"),
    (["policies", "candidacy", "--issue", "issue1"], "can be blocked"),
    (["agent", "brief"], "One session needs attention"),
    (["orgs", "create", "--name", "Reliability"], "orgs switch"),
    (["users", "delete", "user1"], "user1"),
    (["users", "defaults"], "queries:run"),
    (["plan"], "team_offer"),
    (["plan", "claim", "team_offer"], "team_offer"),
    (["otel", "status"], "support-service"),
    (["otel", "enable"], "● enabled"),
    (["otel", "disable"], "○ disabled"),
    (["slack", "status"], "Reliability"),
    (["slack", "disconnect"], "disconnected"),
    (["settings", "context-windows", "list"], "64000"),
    (["settings", "context-windows", "set", "provider/model", "64000"], "provider/model"),
    (["settings", "context-windows", "delete", "provider/model"], "override removed"),
]


@pytest.mark.parametrize("width", [80, 140])
@pytest.mark.parametrize("argv,expected", CASES, ids=lambda item: " ".join(item[:3]) if isinstance(item, list) else "")
def test_deliberate_human_command_views(logged_in, runner, monkeypatch, tmp_path, width, argv, expected):
    monkeypatch.setenv("COLUMNS", str(width))
    code, policy, layout = tmp_path / "source.py", tmp_path / "policy.mjs", tmp_path / "layout.json"
    code.write_text(CODE)
    policy.write_text("customPolicies.add({})")
    layout.write_text(json.dumps({"tiles": [{"id": "tile1", "pos_x": 0, "pos_y": 0, "pos_w": 6, "pos_h": 4}]}))
    paths = {"code": code, "policy": policy, "layout": layout, "draft": tmp_path / "draft.json", "export": tmp_path / "export.json"}
    args = [v.format(**paths) for v in argv]
    with respx.mock as mock:
        mock.route().mock(side_effect=response)
        result = runner.invoke(app, args)
    assert result.exit_code == 0, result.output
    assert expected in result.stdout, result.stdout
    if argv[:2] != ["query", "export"] or "--out" in argv or "json" in argv:
        assert result.stdout.lstrip().startswith("failproof ai"), result.stdout
    assert "\nFIELD\n" not in result.stdout and "\nVALUE\n" not in result.stdout
    for raw in ('"eval_key":', '"created":', '"permissions":', "dashboards  []", "{'"):
        assert raw not in result.stdout, result.stdout
    if argv[:2] == ["evaluators", "deploy"]:
        assert result.stdout.index("run-check · passed") < result.stdout.index("deployed tool_usage v2")
    # Optional transcript capture for the manager, outside the repository.
    if os.environ.get("FP_HUMAN_ARTIFACTS"):
        directory = Path(os.environ["FP_HUMAN_ARTIFACTS"])
        directory.mkdir(parents=True, exist_ok=True)
        name = "-".join(argv[:3]).replace("/", "_").replace("{", "").replace("}", "")
        with (directory / f"{width}-{name}.txt").open("a", encoding="utf-8") as dest:
            dest.write("$ fp " + " ".join(argv) + "\n" + result.output + "\n")


@pytest.mark.parametrize("width", [80, 140])
@pytest.mark.parametrize("argv,path,next_step", [
    (["dashboards", "list"], "/api/dashboards", "fp dashboards create --name"),
    (["roles", "list"], "/api/permission-sets", "fp roles create"),
    (["evaluators", "list"], "/api/evaluator-definitions", "fp evaluators create --help"),
    (["sentiment", "messages"], "/api/events/sentiment/messages", "sentiment.enabled"),
    (["settings", "context-windows", "list"], "/api/settings/model-context-windows", "context-windows set"),
])
def test_empty_views_give_next_step(logged_in, runner, monkeypatch, width, argv, path, next_step):
    monkeypatch.setenv("COLUMNS", str(width))
    data = {"dashboards": []} if argv[0] == "dashboards" else {"items": []} if argv[0] == "sentiment" else []
    with respx.mock as mock:
        mock.get(BASE + path).respond(200, json=data)
        result = runner.invoke(app, argv)
    assert result.exit_code == 0, result.output
    assert "no " in result.stdout
    assert next_step in result.stdout
    assert "[]" not in result.stdout


@pytest.mark.parametrize("width", [80, 140])
def test_roles_permissions_wrap_as_readable_text(logged_in, runner, monkeypatch, width):
    monkeypatch.setenv("COLUMNS", str(width))
    from fp_cli.permissions import ASSIGNABLE_PERMISSIONS
    with respx.mock as mock:
        mock.get(BASE + "/api/permission-sets/admin").respond(200, json={
            "name": "admin", "is_builtin": True, "user_count": 1,
            "permissions": ASSIGNABLE_PERMISSIONS,
        })
        result = runner.invoke(app, ["roles", "show", "admin"])
    assert result.exit_code == 0
    assert "permissions" in result.stdout
    assert "[" not in result.stdout
    assert "events:read" in result.stdout and "policies:write" in result.stdout
