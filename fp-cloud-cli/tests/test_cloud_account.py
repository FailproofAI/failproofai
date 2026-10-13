import json

import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"
CONTRACT = {"agent_id": "agent-1", "body": "# Purpose\nResolve requests", "enabled": True}
CASES = [
    (["roles", "list"], "GET", "/permission-sets", []),
    (["roles", "show", "reviewer"], "GET", "/permission-sets/reviewer", {"name": "reviewer", "permissions": ["events:read"]}),
    (["roles", "create", "--name", "reviewer", "--permission", "events:read"], "POST", "/permission-sets", {"name": "reviewer"}),
    (["roles", "update", "reviewer", "--add", "queries:run"], "PUT", "/permission-sets/reviewer", {"name": "reviewer"}),
    (["roles", "delete", "reviewer"], "DELETE", "/permission-sets/reviewer", {"deleted": True}),
    (["users", "delete", "u1"], "DELETE", "/users/u1", {"deleted": True}),
    (["users", "defaults"], "GET", "/users/defaults", {}),
    (["usage", "windows"], "GET", "/usage/windows", []),
    (["plan"], "GET", "/offers/me", []),
    (["plan", "claim", "team_offer"], "POST", "/offers/claim", {"claimed": True}),
    (["settings", "context-windows", "list"], "GET", "/settings/model-context-windows", {}),
    (["settings", "context-windows", "set", "provider/model", "64000"], "PUT", "/settings/model-context-windows", {}),
    (["settings", "context-windows", "delete", "provider/model"], "DELETE", "/settings/model-context-windows", {}),
    (["otel", "status"], "GET", "/otel/status", {}),
    (["otel", "enable"], "PUT", "/settings/otel.ingest_enabled", {"value": True}),
    (["otel", "disable"], "PUT", "/settings/otel.ingest_enabled", {"value": False}),
    (["alerts", "recipients"], "GET", "/alerts/recipients", []),
    (["alerts", "issues", "a1"], "GET", "/alerts/a1/issues", []),
    (["alerts", "issues", "a1", "--create", "--title", "Failure"], "POST", "/alerts/a1/issues", {"id": "i1"}),
    (["audits", "contracts", "list"], "GET", "/audits/contracts", []),
    (["audits", "contracts", "show", "c1"], "GET", "/audits/contracts/c1", CONTRACT),
    (["audits", "contracts", "create", "--agent-id", "agent-1", "--body", "# Purpose\nResolve requests"], "POST", "/audits/contracts", CONTRACT),
    (["audits", "contracts", "update", "c1", "--body", "# New purpose"], "PUT", "/audits/contracts/c1", CONTRACT),
]
SESSION = [
    (["orgs", "create", "--name", "My Team"], "POST", "/orgs", {"id": "o1"}),
    (["slack", "status"], "GET", "/integrations/slack", {"connected": True}),
    (["slack", "disconnect"], "DELETE", "/integrations/slack", {"disconnected": True}),
]


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("argv,method,path,response", CASES)
def test_commands(logged_in, runner, key_mode, argv, method, path, response):
    prefix = "/v1" if key_mode else "/api"
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{BASE}{prefix}/permission-sets/reviewer").respond(200, json={"name": "reviewer", "permissions": ["events:read"], "description": "Keep"})
        mock.get(f"{BASE}{prefix}/audits/contracts/c1").respond(200, json=CONTRACT)
        mock.get(f"{BASE}{prefix}/team-trial/me").respond(200, json={})
        route = mock.request(method, f"{BASE}{prefix}{path}").respond(200, json=response)
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), *argv])
    assert result.exit_code == 0, result.output
    assert route.called
    json.loads(result.stdout)
    if argv[:2] == ["roles", "create"]:
        assert json.loads(route.calls[0].request.content) == {"name": "reviewer", "permissions": ["events:read"]}
    if argv[:2] == ["roles", "update"]:
        assert json.loads(route.calls[0].request.content) == {"permissions": ["events:read", "queries:run"], "description": "Keep"}
    if argv[:2] == ["plan", "claim"]:
        assert json.loads(route.calls[0].request.content) == {"offer_key": "team_offer"}
    if argv[:3] == ["settings", "context-windows", "set"]:
        assert json.loads(route.calls[0].request.content) == {"model_id": "provider/model", "context_window": 64000}
    if argv[:3] == ["settings", "context-windows", "delete"]:
        assert route.calls[0].request.url.params["model"] == "provider/model"
    if argv[:3] == ["audits", "contracts", "update"]:
        assert json.loads(route.calls[0].request.content) == {**CONTRACT, "body": "# New purpose"}


@pytest.mark.parametrize("argv,method,path,response", SESSION)
def test_session_commands(logged_in, runner, argv, method, path, response):
    with respx.mock as mock:
        route = mock.request(method, f"{BASE}/api{path}").respond(200, json=response)
        result = runner.invoke(app, ["--json", *argv])
    assert result.exit_code == 0, result.output
    if path == "/orgs":
        assert json.loads(route.calls[0].request.content) == {"name": "My Team", "slug": "my-team"}
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", "--api-key", "key", *argv])
        assert not mock.calls
    assert result.exit_code == 2
    assert "needs a signed-in session" in result.stdout


@pytest.mark.parametrize("argv,method,path,response", CASES + SESSION)
def test_404(logged_in, runner, argv, method, path, response):
    with respx.mock as mock:
        mock.route().respond(404, json={})
        result = runner.invoke(app, ["--json", *argv])
    assert result.exit_code == 6, result.output
    assert "not available on this FailproofAI Cloud yet" in result.stdout


@pytest.mark.parametrize("argv", [
    ["roles", "create", "--name", "", "--permission", "events:read"],
    ["roles", "create", "--name", "x", "--permission", "unknown:read"],
    ["roles", "update", "x"],
    ["roles", "update", "x", "--permission", "events:read", "--add", "queries:run"],
    ["settings", "context-windows", "set", "model", "-1"],
    ["settings", "context-windows", "set", "model", "1000001"],
    ["alerts", "issues", "a1", "--create"],
    ["alerts", "issues", "a1", "--title", "No create"],
    ["audits", "contracts", "create", "--agent-id", "a", "--body", ""],
    ["audits", "contracts", "update", "c1"],
    ["orgs", "create", "--name", ""],
])
def test_validation(logged_in, runner, argv):
    with respx.mock as mock:
        result = runner.invoke(app, ["--json", *argv])
        assert not mock.calls
    assert result.exit_code == 2, result.output
