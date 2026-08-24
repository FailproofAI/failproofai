"""`fp list <thing>` — value discovery behind the dashboard's filter dropdowns."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from fp_cli.app import app

BASE = "http://dash.test"

# friendly `list` name -> the endpoint it must hit
_CASES = {
    "envs": "/api/events/environments",
    "agents": "/api/events/agent_ids",
    "event_types": "/api/events/event_types",
    "score_filters": "/api/evaluations/score-keys",
    "models": "/api/events/models",
    "hooks": "/api/events/hook_names",
    "tools": "/api/events/tool_names",
    "error_types": "/api/events/error_types",
}


@pytest.mark.parametrize("name,path", list(_CASES.items()))
@respx.mock
def test_list_hits_right_endpoint_and_wraps(logged_in, runner, name, path):
    route = respx.get(f"{BASE}{path}").mock(return_value=httpx.Response(200, json=["a", "b"]))
    result = runner.invoke(app, ["--json", "list", name])
    assert result.exit_code == 0, result.output
    assert route.called  # the friendly name resolved to the correct endpoint
    assert json.loads(result.stdout) == {"kind": name, "values": ["a", "b"]}


@respx.mock
def test_list_empty_is_clean(logged_in, runner):
    respx.get(f"{BASE}/api/events/models").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["--json", "list", "models"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["values"] == []


def test_list_unknown_kind_is_usage_error(logged_in, runner):
    # An undefined subcommand is a clean usage error, not a crash.
    result = runner.invoke(app, ["list", "bogus"])
    assert result.exit_code == 2


@respx.mock
def test_list_forbidden_exits_5(logged_in, runner):
    # score_filters needs evaluations:read; a 403 maps to the forbidden exit code.
    respx.get(f"{BASE}/api/evaluations/score-keys").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"})
    )
    result = runner.invoke(app, ["list", "score_filters"])
    assert result.exit_code == 5
