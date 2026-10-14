"""The issue-filter wire contract in both auth modes, including older Clouds."""

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from fp_cli import client, dates, output
from fp_cli.app import app
from fp_cli.models import Incident

BASE = "http://dash.test"
FILTER_FLAGS = [
    "--agent", "claude-repo", "--agent", "codex-repo",
    "--harness", "claude", "--harness", "codex",
    "--env", "prod", "--env", "staging",
    "--machine", "m1", "--machine", "m2",
    "--source", "alert", "--source", "audit",
    "--alert", "a1", "--alert", "a2",
    "--audit", "au1", "--audit", "au2",
    "--assignee", "me", "--assignee", "unassigned", "--assignee", "a@example.test",
    "--since", "2026-10-01T00:00:00Z", "--until", "2026-10-14T00:00:00Z",
    "--search", "tool failures & latency",
]
FILTERS = {
    "agent": "claude-repo,codex-repo",
    "harness": "claude,codex",
    "environment": "prod,staging",
    "machine": "m1,m2",
    "source": "alert,audit",
    "alert_id": "a1,a2",
    "audit_id": "au1,au2",
    "assignee": "me,unassigned,a@example.test",
    "opened_from": "2026-10-01T00:00:00Z",
    "opened_to": "2026-10-14T00:00:00Z",
    "q": "tool failures & latency",
}
FACETS = {"harnesses": [{"value": "claude", "count": 3}],
          "agents": [{"value": "claude-repo", "count": 2}]}


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("command", ["list", "count", "facets"])
@respx.mock
def test_all_filters_in_session_and_key_mode(logged_in, runner, key_mode, command):
    prefix = "/v1" if key_mode else "/api"
    path = f"{BASE}{prefix}/issues" + (f"/{command}" if command != "list" else "")
    response = {"issues": [{"id": "i1", "scope": {"harnesses": ["claude"], "agents": ["claude-repo"]}}],
                "filters": FILTERS} if command == "list" else (
                    {"count": 3, "filters": FILTERS} if command == "count" else FACETS)
    route = respx.get(path).respond(200, json=response)
    auth = ["--api-key", "key"] if key_mode else []
    result = runner.invoke(app, ["--json", *auth, "issues", command,
                                 "--state", "firing,acknowledged", *FILTER_FLAGS])
    assert result.exit_code == 0, result.output
    expected = {**FILTERS, "state": "firing,acknowledged"}
    if command == "list":
        expected["limit"] = "50"
    request = route.calls[0].request
    assert dict(request.url.params) == expected
    if key_mode:
        assert request.headers["authorization"] == "Bearer key"
        assert "cookie" not in request.headers
    else:
        assert "ae_session=tok" in request.headers["cookie"]
        assert "authorization" not in request.headers
    payload = json.loads(result.stdout)
    if command == "list":
        assert payload["issues"][0]["scope"]["harnesses"] == ["claude"]
    elif command == "count":
        assert payload == {"count": 3}
    else:
        assert payload == FACETS
    assert len(respx.calls) == 1, "echoed filters need no capability probe"


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("command", ["list", "count"])
@respx.mock
def test_old_cloud_warns_once_but_preserves_json(logged_in, runner, key_mode, command):
    prefix = "/v1" if key_mode else "/api"
    path = f"{BASE}{prefix}/issues" + ("/count" if command == "count" else "")
    respx.get(path).respond(200, json=[{"id": "old"}] if command == "list" else {"count": 8})
    facets = respx.get(f"{BASE}{prefix}/issues/facets").respond(404, json={"error": "not found"})
    auth = ["--api-key", "key"] if key_mode else []
    result = runner.invoke(app, ["--json", "--quiet", *auth, "issues", command,
                                 "--harness", "claude", "--env", "prod"])
    assert result.exit_code == 0, result.output
    assert result.stderr.count("not available on this FailproofAI Cloud yet") == 1
    assert "unfiltered" in result.stderr
    assert facets.call_count == 1
    payload = json.loads(result.stdout)
    assert (payload["issues"][0]["id"] == "old") if command == "list" else payload == {"count": 8}


@pytest.mark.parametrize("key_mode", [False, True])
@respx.mock
def test_missing_facets_has_existing_availability_error(logged_in, runner, key_mode):
    prefix = "/v1" if key_mode else "/api"
    respx.get(f"{BASE}{prefix}/issues/facets").respond(404, json={"error": "not found"})
    auth = ["--api-key", "key"] if key_mode else []
    result = runner.invoke(app, ["--json", *auth, "issues", "facets", "--env", "prod"])
    assert result.exit_code == 6, result.output
    assert "not available on this FailproofAI Cloud yet" in result.stdout
    json.loads(result.stdout)


@respx.mock
def test_bare_list_on_new_cloud_probes_facets_without_warning(logged_in, runner):
    respx.get(f"{BASE}/api/issues").respond(200, json=[{"id": "i1"}])
    route = respx.get(f"{BASE}/api/issues/facets").respond(200, json=FACETS)
    result = runner.invoke(app, ["--json", "issues", "list", "--source", "manual"])
    assert result.exit_code == 0, result.output
    assert dict(route.calls[0].request.url.params) == {"source": "manual"}
    assert "unfiltered" not in result.stderr


@respx.mock
def test_partial_echo_still_checks_capability(logged_in, runner):
    respx.get(f"{BASE}/api/issues").respond(200, json={"issues": [], "filters": {"harness": "claude"}})
    route = respx.get(f"{BASE}/api/issues/facets").respond(404, json={})
    result = runner.invoke(app, ["--json", "issues", "list", "--harness", "claude", "--env", "prod"])
    assert result.exit_code == 0
    assert route.call_count == 1
    assert "unfiltered" in result.stderr


@pytest.mark.parametrize("status", [401, 403, 500])
@respx.mock
def test_probe_errors_are_not_disguised_as_older_cloud(logged_in, runner, status):
    respx.get(f"{BASE}/api/issues/count").respond(200, json={"count": 8})
    respx.get(f"{BASE}/api/issues/facets").respond(status, json={"error": "probe failed"})
    result = runner.invoke(app, ["--json", "issues", "count", "--harness", "claude"])
    assert result.exit_code != 0
    assert "unfiltered" not in result.stderr


@pytest.mark.parametrize("command", ["list", "count", "facets"])
@pytest.mark.parametrize("flags", [
    ["--source", "invalid"], ["--harness", ""], ["--agent", "a,,b"],
    ["--since", "yesterday"], ["--until", "2026-10-14"],
])
@respx.mock
def test_invalid_filters_fail_before_http(logged_in, runner, command, flags):
    result = runner.invoke(app, ["issues", command, *flags])
    assert result.exit_code == 2, result.output
    assert not respx.calls


@respx.mock
def test_relative_since_keeps_until_and_csv_is_normalized(logged_in, runner, monkeypatch):
    real = dates.resolve_range
    now = datetime(2026, 10, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(dates, "resolve_range", lambda *args: real(*args, now=now))
    expected = {"harness": "claude,codex", "opened_from": "2026-10-07T00:00:00Z",
                "opened_to": "2026-10-14T00:00:00Z"}
    route = respx.get(f"{BASE}/api/issues/count").respond(200, json={"count": 0, "applied_filters": expected})
    result = runner.invoke(app, ["--json", "issues", "count",
        "--harness", "claude, codex", "--harness", "claude",
        "--since", "7d", "--until", "2026-10-14T00:00:00Z"])
    assert result.exit_code == 0, result.output
    assert dict(route.calls[0].request.url.params) == expected
    assert len(respx.calls) == 1


@respx.mock
def test_existing_alert_id_path_is_kept_and_combined_filters_use_issues(logged_in, runner):
    legacy = respx.get(f"{BASE}/api/alerts/a1/issues").respond(200, json=[])
    result = runner.invoke(app, ["--json", "issues", "list", "--alert-id", "a1"])
    assert result.exit_code == 0, result.output
    assert legacy.called
    route = respx.get(f"{BASE}/api/issues").respond(200, json={"issues": [], "filters": {"harness": "codex"}})
    result = runner.invoke(app, ["--json", "issues", "list", "--alert-id", "a1", "--harness", "codex"])
    assert result.exit_code == 0, result.output
    assert dict(route.calls[0].request.url.params) == {"limit": "50", "harness": "codex", "alert_id": "a1"}


def test_human_rows_include_harness_and_agent_tags(capsys):
    output.render_incidents([Incident.from_dict({
        "id": "i1", "title": "Timeouts",
        "scope": {"harnesses": ["claude"], "agents": ["claude-repo"]},
    })])
    out = capsys.readouterr().out
    assert "[harness:claude]" in out
    assert "[agent:claude-repo]" in out


def test_human_facets_show_values_counts_and_empty_state(capsys):
    output.render_issue_facets(FACETS)
    out = capsys.readouterr().out
    assert "claude" in out and "3" in out and "claude-repo" in out
    assert "{'value'" not in out
    output.render_issue_facets({})
    assert "no issue filter values" in capsys.readouterr().out


def test_programmatic_client_reports_missing_filters_without_printing():
    def handle(request):
        return httpx.Response(404, json={}) if request.url.path.endswith("/facets") else httpx.Response(200, json=[])
    ctx = client.ClientContext(BASE, token="tok", transport=httpx.MockTransport(handle))
    warnings = []
    assert client.list_incidents(ctx, filters={"harness": "codex"},
                                 on_filters_unavailable=lambda: warnings.append(True)) == []
    assert warnings == [True]
