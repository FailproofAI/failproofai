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
ISSUE = {
    "id": "i1", "title": "Timeouts",
    "agent_ids": ["claude-repo"], "harnesses": ["claude"],
    "environments": ["prod"], "machine_ids": ["m1"],
    "scope_computed_at": "2026-10-14T00:00:00Z",
}
FACETS = {
    "harnesses": [{"value": "claude", "count": 3}],
    "agents": [{"value": "claude-repo", "count": 2}],
    "alerts": [{"id": "a1", "name": "Tool failure alert", "count": 4}],
    "audits": [{"id": "au1", "name": "Weekly quality audit", "count": 5}],
}


@pytest.fixture(autouse=True)
def fresh_filter_detection(monkeypatch):
    """Each test is a new process; individual tests can exercise repeated calls."""
    monkeypatch.setattr(client, "_issue_facets_probed", False)
    monkeypatch.setattr(client, "_issue_facets_available", None)
    monkeypatch.setattr(client, "_issue_filters_warned", False)


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("command", ["list", "count", "facets"])
@respx.mock
def test_all_filters_in_session_and_key_mode(logged_in, runner, key_mode, command):
    prefix = "/v1" if key_mode else "/api"
    path = f"{BASE}{prefix}/issues" + (f"/{command}" if command != "list" else "")
    response = [ISSUE] if command == "list" else (
        {"count": 3} if command == "count" else FACETS)
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
        row = payload["issues"][0]
        for key in ("agent_ids", "harnesses", "environments", "machine_ids", "scope_computed_at"):
            assert row[key] == ISSUE[key]
        assert "scope" not in row
    elif command == "count":
        assert payload == {"count": 3}
    else:
        assert payload == FACETS
    assert len(respx.calls) == 1, "normal filtered calls need no capability probe"


@pytest.mark.parametrize("key_mode", [False, True])
@respx.mock
def test_old_nonempty_list_warns_without_extra_request(logged_in, runner, key_mode):
    prefix = "/v1" if key_mode else "/api"
    respx.get(f"{BASE}{prefix}/issues").respond(200, json=[{"id": "old"}])
    auth = ["--api-key", "key"] if key_mode else []
    result = runner.invoke(app, ["--json", "--quiet", *auth, "issues", "list",
                                 "--harness", "claude", "--env", "prod"])
    assert result.exit_code == 0, result.output
    assert result.stderr.count("not available on this FailproofAI Cloud yet") == 1
    assert "unfiltered" in result.stderr
    assert len(respx.calls) == 1
    assert json.loads(result.stdout)["issues"][0]["id"] == "old"


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("command", ["list", "count"])
@respx.mock
def test_old_empty_result_probes_once_and_preserves_json(logged_in, runner, key_mode, command):
    prefix = "/v1" if key_mode else "/api"
    path = f"{BASE}{prefix}/issues" + ("/count" if command == "count" else "")
    respx.get(path).respond(200, json=[] if command == "list" else {"count": 0})
    facets = respx.get(f"{BASE}{prefix}/issues/facets").respond(404, json={"error": "not found"})
    auth = ["--api-key", "key"] if key_mode else []
    result = runner.invoke(app, ["--json", "--quiet", *auth, "issues", command, "--harness", "claude"])
    assert result.exit_code == 0, result.output
    assert result.stderr.count("not available on this FailproofAI Cloud yet") == 1
    assert facets.call_count == 1
    assert json.loads(result.stdout) == ({"issues": []} if command == "list" else {"count": 0})


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
def test_empty_list_on_new_cloud_probes_facets_without_warning(logged_in, runner):
    respx.get(f"{BASE}/api/issues").respond(200, json=[])
    route = respx.get(f"{BASE}/api/issues/facets").respond(200, json=FACETS)
    result = runner.invoke(app, ["--json", "issues", "list", "--source", "manual"])
    assert result.exit_code == 0, result.output
    assert dict(route.calls[0].request.url.params) == {"source": "manual"}
    assert "unfiltered" not in result.stderr


@respx.mock
@pytest.mark.parametrize("rows", [
    [{"id": "manual", "harnesses": []}],
    [{"id": "legacy"}, ISSUE],
])
def test_any_raw_harnesses_key_confirms_support_without_probe(logged_in, runner, rows):
    respx.get(f"{BASE}/api/issues").respond(200, json=rows)
    result = runner.invoke(app, ["--json", "issues", "list", "--source", "manual"])
    assert result.exit_code == 0, result.output
    assert len(respx.calls) == 1
    assert "unfiltered" not in result.stderr


@pytest.mark.parametrize("available", [True, False])
@respx.mock
def test_empty_result_probe_and_warning_are_once_per_process(logged_in, runner, available):
    respx.get(f"{BASE}/api/issues").respond(200, json=[])
    respx.get(f"{BASE}/api/issues/count").respond(200, json={"count": 0})
    route = respx.get(f"{BASE}/api/issues/facets").respond(
        200 if available else 404, json=FACETS if available else {})
    results = [
        runner.invoke(app, ["--json", "issues", command, "--harness", "claude"])
        for command in ("list", "count", "list")
    ]
    assert all(result.exit_code == 0 for result in results)
    assert route.call_count == 1
    warnings = "".join(result.stderr for result in results)
    assert warnings.count("unfiltered") == (0 if available else 1)


@respx.mock
def test_legacy_row_warning_is_once_per_process(logged_in, runner):
    respx.get(f"{BASE}/api/issues").respond(200, json=[{"id": "old"}])
    results = [runner.invoke(app, ["--json", "issues", "list", "--harness", "claude"])
               for _ in range(2)]
    assert all(result.exit_code == 0 for result in results)
    assert "".join(result.stderr for result in results).count("unfiltered") == 1
    assert len(respx.calls) == 2


@pytest.mark.parametrize("status", [401, 403, 500])
@respx.mock
def test_probe_errors_are_not_disguised_as_older_cloud(logged_in, runner, status):
    respx.get(f"{BASE}/api/issues/count").respond(200, json={"count": 0})
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
    route = respx.get(f"{BASE}/api/issues/count").respond(200, json={"count": 3})
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
    route = respx.get(f"{BASE}/api/issues").respond(200, json=[{**ISSUE, "harnesses": ["codex"]}])
    result = runner.invoke(app, ["--json", "issues", "list", "--alert-id", "a1", "--harness", "codex"])
    assert result.exit_code == 0, result.output
    assert dict(route.calls[0].request.url.params) == {"limit": "50", "harness": "codex", "alert_id": "a1"}


def test_human_rows_include_harness_and_agent_tags(capsys):
    output.render_incidents([Incident.from_dict(ISSUE)])
    out = capsys.readouterr().out
    assert "[harness:claude]" in out
    assert "[agent:claude-repo]" in out


def test_older_issue_defaults_scope_fields_without_inventing_tags(capsys):
    issue = Incident.from_dict({"id": "old", "title": "Old issue"})
    assert issue.agent_ids == issue.harnesses == issue.environments == issue.machine_ids == []
    assert issue.scope_computed_at is None
    output.render_incidents([issue])
    out = capsys.readouterr().out
    assert "[harness:" not in out and "[agent:" not in out


def test_human_facets_show_values_counts_and_empty_state(capsys):
    output.render_issue_facets(FACETS)
    out = capsys.readouterr().out
    assert "claude" in out and "3" in out and "claude-repo" in out
    assert "Tool failure alert" in out and "4" in out
    assert "Weekly quality audit" in out and "5" in out
    assert "a1" not in out and "au1" not in out
    assert "{'value'" not in out
    output.render_issue_facets({})
    assert "no issue filter values" in capsys.readouterr().out


def test_unnamed_alert_and_audit_facets_fall_back_to_id(capsys):
    output.render_issue_facets({"alerts": [{"id": "a1", "name": None, "count": 2}],
                                "audits": [{"id": "au1", "name": "", "count": 1}]})
    out = capsys.readouterr().out
    assert "a1" in out and "au1" in out


def test_programmatic_client_reports_missing_filters_without_printing():
    def handle(request):
        return httpx.Response(404, json={}) if request.url.path.endswith("/facets") else httpx.Response(200, json=[])
    ctx = client.ClientContext(BASE, token="tok", transport=httpx.MockTransport(handle))
    warnings = []
    assert client.list_incidents(ctx, filters={"harness": "codex"},
                                 on_filters_unavailable=lambda: warnings.append(True)) == []
    assert warnings == [True]
