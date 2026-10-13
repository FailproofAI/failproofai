import json

import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"
DASHBOARD = {"name": "Quality", "description": "Keep", "definition": {"filters": {"env": "prod"}}}
TILE = {"id": "t1", "query_id": "q1", "title": "Before", "chart_type": "table",
        "chart_config": {}, "param_bindings": {}, "pos_x": 0, "pos_y": 0, "pos_w": 6, "pos_h": 4}
RESULT = {"columns": [{"name": "agent", "type": "String"}, {"name": "n", "type": "Int64"}],
          "rows": [["agent-001", 42]], "truncated": False, "elapsed_ms": 1}
CASES = [
    (["dashboards", "list"], "GET", "/dashboards", {"dashboards": []}),
    (["dashboards", "show", "d1"], "GET", "/dashboards/d1", {"dashboard": DASHBOARD, "tiles": []}),
    (["dashboards", "create", "--name", "Quality"], "POST", "/dashboards", {"id": "d1"}),
    (["dashboards", "update", "d1", "--name", "New"], "PUT", "/dashboards/d1", {"id": "d1"}),
    (["dashboards", "delete", "d1"], "DELETE", "/dashboards/d1", {"deleted": True}),
    (["dashboards", "tiles", "d1", "list"], "GET", "/dashboards/d1/tiles", {"tiles": [TILE]}),
    (["dashboards", "tiles", "d1", "add", "--query", "q1", "--chart", "bar"], "POST", "/dashboards/d1/tiles", {"id": "t1"}),
    (["dashboards", "tiles", "d1", "update", "t1", "--title", "After"], "PUT", "/dashboards/d1/tiles/t1", {"id": "t1"}),
    (["dashboards", "tiles", "d1", "remove", "t1"], "DELETE", "/dashboards/d1/tiles/t1", {"deleted": True}),
    (["dashboards", "tiles", "d1", "layout", "--file", "{layout}"], "PUT", "/dashboards/d1/tiles/layout", {"updated": 1}),
    (["sessions", "show", "s1"], "GET", "/events/summary", {"events": [], "next_cursor": None}),
    (["sessions", "export", "s1"], "GET", "/sessions/s1/export", {"session_id": "s1", "events": []}),
    (["sessions", "history", "s1"], "GET", "/sessions/s1/evaluation-history", []),
    (["events", "latency"], "GET", "/events/latency_aggregate", {"p95": 42}),
    (["sentiment", "summary"], "GET", "/events/sentiment", {"positive": 1}),
    (["sentiment", "messages"], "GET", "/events/sentiment/messages", []),
    (["sentiment", "sessions"], "GET", "/events/sentiment/sessions", []),
    (["sentiment", "session", "s1"], "GET", "/events/sentiment/sessions/s1", {}),
    (["query", "export", "q1", "--format", "json"], "POST", "/queries/run", RESULT),
    (["query", "export", "--sql", "SELECT 1", "--format", "csv"], "POST", "/queries/run", RESULT),
]


@pytest.fixture
def files(tmp_path):
    path = tmp_path / "layout.json"
    path.write_text(json.dumps({"tiles": [{k: v for k, v in TILE.items() if k in ("id", "pos_x", "pos_y", "pos_w", "pos_h")}]}))
    return {"layout": str(path)}


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("argv,method,path,response", CASES, ids=lambda v: " ".join(v) if isinstance(v, list) else str(v))
def test_observability_commands(logged_in, runner, files, key_mode, argv, method, path, response):
    prefix = "/v1" if key_mode else "/api"
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{BASE}{prefix}/dashboards/d1").respond(200, json={"dashboard": DASHBOARD, "tiles": []})
        mock.get(f"{BASE}{prefix}/dashboards/d1/tiles").respond(200, json={"tiles": [TILE]})
        mock.get(f"{BASE}{prefix}/sessions").respond(200, json={"sessions": [{"session_id": "s1"}]})
        route = mock.request(method, f"{BASE}{prefix}{path}").respond(200, json=response)
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), *[v.format(**files) for v in argv]])
    assert result.exit_code == 0, result.output
    assert route.called
    json.loads(result.stdout)
    if argv[:2] == ["dashboards", "create"]:
        assert json.loads(route.calls[0].request.content) == {"name": "Quality", "description": "", "definition": {}}
    if argv[:2] == ["dashboards", "update"]:
        assert json.loads(route.calls[0].request.content) == {**DASHBOARD, "name": "New"}
    if argv[:4] == ["dashboards", "tiles", "d1", "update"]:
        assert json.loads(route.calls[0].request.content) == {k: ("After" if k == "title" else v) for k, v in TILE.items() if k != "id"}


@pytest.mark.parametrize("argv,method,path,response", CASES)
@pytest.mark.parametrize("key_mode", [False, True])
def test_observability_404(logged_in, runner, files, key_mode, argv, method, path, response):
    with respx.mock as mock:
        mock.route().respond(404, json={})
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), *[v.format(**files) for v in argv]])
    assert result.exit_code == 6, result.output
    assert "not available on this FailproofAI Cloud yet" in result.stdout


def test_query_compose(logged_in, runner):
    stream = 'data: {"type":"done","sql":"SELECT 1"}\n\n'
    with respx.mock as mock:
        draft = mock.post(f"{BASE}/api/agent/compose-sql").respond(200, text=stream, headers={"content-type": "text/event-stream"})
        run = mock.post(f"{BASE}/api/queries/run").respond(200, json=RESULT)
        result = runner.invoke(app, ["--json", "query", "compose", "Count events", "--run"])
    assert result.exit_code == 0, result.output
    assert json.loads(draft.calls[0].request.content) == {"intent": "Count events"}
    assert json.loads(run.calls[0].request.content) == {"sql": "SELECT 1", "params": []}


def test_query_compose_key_denial(logged_in, runner):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", "--api-key", "key", "query", "compose", "Count events"])
        assert not mock.calls
    assert result.exit_code == 2
    assert "fp login" in result.stdout


def test_exports_write_files(logged_in, runner, tmp_path):
    path = tmp_path / "data.csv"
    with respx.mock as mock:
        mock.post(f"{BASE}/api/queries/run").respond(200, json=RESULT)
        result = runner.invoke(app, ["--json", "query", "export", "--sql", "SELECT 1", "--out", str(path)])
    assert result.exit_code == 0
    assert path.read_text().splitlines() == ["agent,n", "agent-001,42"]


@pytest.mark.parametrize("argv", [
    ["dashboards", "create", "--name", ""],
    ["dashboards", "update", "d1"],
    ["dashboards", "tiles", "d1", "add", "--query", "q1", "--chart", "invalid"],
    ["sentiment", "messages", "--limit", "0"],
    ["query", "export", "--sql", "SELECT 1", "--format", "xml"],
    ["query", "export", "q1", "--sql", "SELECT 1"],
])
def test_validation(logged_in, runner, argv):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", *argv])
        assert not mock.calls
    assert result.exit_code == 2, result.output
