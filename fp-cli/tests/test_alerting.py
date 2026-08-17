"""Alerting: alert definitions + incident triage."""

from __future__ import annotations

import json

import httpx
import respx

from fp_cli import output
from fp_cli.app import app
from fp_cli.commands import _write

BASE = "http://dash.test"


# --- alerts -----------------------------------------------------------------


@respx.mock
def test_alerts_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(
        return_value=httpx.Response(200, json=[{"id": "a1", "name": "p95", "trigger_kind": "metric_threshold", "severity": "warning", "enabled": True, "open_incidents": 0}])
    )
    result = runner.invoke(app, ["--json", "alerts", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["alerts"][0]["id"] == "a1"


@respx.mock
def test_alerts_list_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[
        {"id": "a1", "name": "live", "trigger_kind": "custom_sql", "severity": "critical", "enabled": True,
         "open_incidents": 1, "created_at": "2026-06-28T00:00:00Z", "last_attempted_at": "2026-06-28T00:00:00Z"},
        {"id": "a2", "name": "old", "trigger_kind": "metric_threshold", "severity": "warning", "enabled": False,
         "open_incidents": 0, "created_at": "2026-06-20T00:00:00Z", "last_attempted_at": None},
    ]))
    result = runner.invoke(app, ["alerts", "list"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "alerts" in out and "newest first" in out
    for c in ("created", "name", "by", "trigger", "severity", "last alert"):  # no status column
        assert c in out
    assert "status" not in out                                       # the status column was removed
    assert "never" in out                                            # null last-alert
    assert "on" in out and "off" in out                              # the on/off split is in the footer
    assert "critical" in out and "warning" in out                    # footer severities


@respx.mock
def test_alerts_show_by_name_json(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    result = runner.invoke(app, ["--json", "alerts", "show", "p95"])  # by NAME
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["trigger_spec"] == {"metric": "latency", "op": ">", "value": 100}


@respx.mock
def test_alerts_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    result = runner.invoke(app, ["alerts", "show", "ghost"])
    assert result.exit_code == 6


@respx.mock
def test_alerts_show_human_cards(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    result = runner.invoke(app, ["alerts", "show", "p95"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "p95" in out and "warning" in out and "enabled" in out
    assert "trigger" in out and "fire when" in out and "latency" in out  # parsed metric_threshold
    assert "evaluation" in out and "checks every" in out
    assert "channels" in out and "email" in out


@respx.mock
def test_alerts_create_from_file(logged_in, runner, tmp_path):
    payload = {"name": "p95", "trigger_kind": "metric_threshold", "trigger_spec": {"metric": "latency", "op": ">", "value": 100}, "severity": "warning", "eval_interval_secs": 60}
    f = tmp_path / "alert.json"
    f.write_text(json.dumps(payload))
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[]))  # no name collision
    route = respx.post(f"{BASE}/api/alerts").mock(return_value=httpx.Response(201, json={"id": "a9", "created_at": "t"}))
    result = runner.invoke(app, ["--json", "alerts", "create", "p95", "--file", str(f)])  # name is positional
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "p95"
    assert body["trigger_kind"] == "metric_threshold"


@respx.mock
def test_alerts_create_name_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[{"id": "a1", "name": "errs"}]))
    result = runner.invoke(app, ["--json", "alerts", "create", "errs", "--trigger-kind",
                                 "metric_threshold", "--trigger-spec", '{"metric":"x","op":">","value":1}'])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


@respx.mock
def test_alerts_create_human_renders_card(logged_in, runner, tmp_path):
    # Human mode: pre-check (no collision) → POST → re-read the canonical alert → render the card.
    payload = {"name": "errs", "trigger_kind": "metric_threshold",
               "trigger_spec": {"metric": "error_count", "op": ">", "value": 50, "window_secs": 900},
               "severity": "warning", "eval_interval_secs": 300}
    f = tmp_path / "a.json"
    f.write_text(json.dumps(payload))
    respx.get(f"{BASE}/api/alerts").mock(side_effect=[
        httpx.Response(200, json=[]),  # pre-check: no collision
        httpx.Response(200, json=[{"id": "a9", "name": "errs", "enabled": True, "trigger_kind": "metric_threshold",
                                   "trigger_spec": payload["trigger_spec"], "severity": "warning",
                                   "eval_interval_secs": 300, "min_breaches": 1, "eval_window": 1, "channels": []}]),
    ])
    respx.post(f"{BASE}/api/alerts").mock(return_value=httpx.Response(201, json={"id": "a9", "created_at": "t"}))
    result = runner.invoke(app, ["alerts", "create", "errs", "--file", str(f)])  # name positional
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "alert created" in out and "errs" in out
    assert "fire when error_count > 50 over 15m" in out and "channels" in out


@respx.mock
def test_alerts_update_rename_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[
        _FULL_ALERT, {**_FULL_ALERT, "id": "a2", "name": "taken"}]))
    result = runner.invoke(app, ["--json", "alerts", "update", "p95", "--name", "taken", "--yes"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


@respx.mock
def test_alerts_update_human_renders_card(logged_in, runner):
    # First GET resolves the name (old state); the post-PUT re-fetch returns the new state.
    respx.get(f"{BASE}/api/alerts").mock(side_effect=[
        httpx.Response(200, json=[_FULL_ALERT]),
        httpx.Response(200, json=[{**_FULL_ALERT, "severity": "critical"}]),
    ])
    respx.put(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(200, json={"id": "a1", "updated_at": "t"}))
    result = runner.invoke(app, ["alerts", "update", "p95", "--severity", "critical", "--yes"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "alert updated" in out and "p95" in out
    assert "critical" in out and "trigger" in out


def test_alerts_create_validation_local(logged_in, runner, tmp_path):
    # eval_interval_secs below 30 fails locally before any HTTP call.
    payload = {"name": "x", "trigger_kind": "metric_threshold", "trigger_spec": {}, "eval_interval_secs": 10}
    f = tmp_path / "a.json"
    f.write_text(json.dumps(payload))
    result = runner.invoke(app, ["alerts", "create", "--file", str(f)])
    assert result.exit_code == 2


def test_alerts_create_bad_trigger_kind(logged_in, runner):
    result = runner.invoke(app, ["alerts", "create", "x", "--trigger-kind", "bogus", "--trigger-spec", "{}"])
    assert result.exit_code == 2


_FULL_ALERT = {
    "id": "a1",
    "name": "p95",
    "description": "latency guard",
    "enabled": True,
    "trigger_kind": "metric_threshold",
    "trigger_spec": {"metric": "latency", "op": ">", "value": 100},
    "min_breaches": 1,
    "eval_window": 1,
    "eval_interval_secs": 300,
    "severity": "warning",
    "channels": [{"kind": "email", "recipients": ["x@y.z"]}],
}


@respx.mock
def test_alerts_update_flag_only_by_name_resends_full_body(logged_in, runner):
    # A flag-only edit resolves the NAME via the list, then PUTs the WHOLE alert back with just
    # the changed field — the server's PUT is a full replace.
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    put = respx.put(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(200, json={"id": "a1", "updated_at": "t"}))
    result = runner.invoke(app, ["--json", "alerts", "update", "p95", "--description", "off-hours", "--yes"])
    assert result.exit_code == 0, result.output
    assert put.called
    body = json.loads(put.calls.last.request.content)
    assert body["description"] == "off-hours"        # the changed field
    assert body["name"] == "p95"                     # everything else carried over
    assert body["trigger_kind"] == "metric_threshold"
    assert body["trigger_spec"] == {"metric": "latency", "op": ">", "value": 100}
    assert body["severity"] == "warning"
    assert body["channels"] == [{"kind": "email", "recipients": ["x@y.z"]}]
    assert body["enabled"] is True                   # preserved (no enable/disable flag any more)


@respx.mock
def test_alerts_update_flag_only_can_change_severity(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    put = respx.put(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(200, json={"id": "a1", "updated_at": "t"}))
    result = runner.invoke(app, ["--json", "alerts", "update", "p95", "--severity", "critical", "--yes"])
    assert result.exit_code == 0, result.output
    body = json.loads(put.calls.last.request.content)
    assert body["severity"] == "critical"
    assert body["enabled"] is True  # untouched, preserved from the existing alert


@respx.mock
def test_alerts_update_missing_alert_is_not_found(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    put = respx.put(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["alerts", "update", "nope", "--severity", "critical", "--yes"])
    assert result.exit_code == 6, result.output
    assert not put.called


@respx.mock
def test_alerts_update_with_file_is_full_replace(logged_in, runner, tmp_path):
    # The --file path is a straight replace (the list read only resolves the name → id).
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    payload = {"name": "renamed", "trigger_kind": "metric_threshold", "trigger_spec": {"metric": "latency", "op": ">", "value": 1}, "severity": "info", "eval_interval_secs": 60}
    f = tmp_path / "alert.json"
    f.write_text(json.dumps(payload))
    put = respx.put(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(200, json={"id": "a1", "updated_at": "t"}))
    result = runner.invoke(app, ["--json", "alerts", "update", "p95", "--file", str(f), "--yes"])
    assert result.exit_code == 0, result.output
    body = json.loads(put.calls.last.request.content)
    assert body["name"] == "renamed"
    assert body["severity"] == "info"


@respx.mock
def test_alerts_delete_by_name(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    route = respx.delete(f"{BASE}/api/alerts/a1").mock(return_value=httpx.Response(204))
    result = runner.invoke(app, ["--json", "alerts", "delete", "p95", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(result.stdout)
    assert body["deleted"] is True and body["name"] == "p95"


@respx.mock
def test_alerts_delete_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    result = runner.invoke(app, ["alerts", "delete", "ghost", "--yes"])
    assert result.exit_code == 6


@respx.mock
def test_alerts_test_sends_by_name(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    respx.post(f"{BASE}/api/alerts/a1/test").mock(
        return_value=httpx.Response(200, json={"ok": True, "synthetic_incident_id": "i1"})
    )
    result = runner.invoke(app, ["--json", "alerts", "test", "p95", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["ok"] is True


@respx.mock
def test_alerts_test_human_renders_dispatch(logged_in, runner):
    respx.get(f"{BASE}/api/alerts").mock(return_value=httpx.Response(200, json=[_FULL_ALERT]))
    respx.post(f"{BASE}/api/alerts/a1/test").mock(
        return_value=httpx.Response(200, json={"ok": True, "synthetic_incident_id": "i1"})
    )
    result = runner.invoke(app, ["alerts", "test", "p95", "--yes"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "test notification sent for" in out and "p95" in out
    assert "dispatched to" in out and "email" in out         # _FULL_ALERT's email channel
    assert "delivery isn't confirmed" in out                  # honest note (issue #183)


# --- incidents --------------------------------------------------------------


@respx.mock
def test_incidents_list_by_state(logged_in, runner):
    route = respx.get(f"{BASE}/api/issues").mock(
        return_value=httpx.Response(200, json=[{"id": "i1", "alert_name": "p95", "alert_severity": "warning", "state": "firing", "opened_at": "t", "assignees": []}])
    )
    result = runner.invoke(app, ["--json", "issues", "list", "--state", "firing"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["issues"][0]["id"] == "i1"
    assert route.calls.last.request.url.params["state"] == "firing"


@respx.mock
def test_incidents_list_by_alert_uses_alert_path(logged_in, runner):
    route = respx.get(f"{BASE}/api/alerts/a1/issues").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["--json", "issues", "list", "--alert-id", "a1"])
    assert result.exit_code == 0, result.output
    assert route.called


@respx.mock
def test_incidents_count_json(logged_in, runner):
    respx.get(f"{BASE}/api/issues/count").mock(return_value=httpx.Response(200, json={"count": 3}))
    result = runner.invoke(app, ["--json", "issues", "count"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["count"] == 3


@respx.mock
def test_incident_ack(logged_in, runner):
    route = respx.post(f"{BASE}/api/issues/i1/ack").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "issues", "ack", "i1"])
    assert result.exit_code == 0, result.output
    assert route.called


@respx.mock
def test_incident_assign_sends_array(logged_in, runner):
    route = respx.post(f"{BASE}/api/issues/i1/assign").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "issues", "assign", "i1", "--assignee", "a@x.com", "--assignee", "b@x.com"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"assignees": ["a@x.com", "b@x.com"]}


@respx.mock
def test_incident_comment_add_from_body(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/comments").mock(
        return_value=httpx.Response(201, json={"id": "c1", "incident_id": "i1", "author_email": "me@test", "body": "hi", "created_at": "t"})
    )
    result = runner.invoke(app, ["--json", "issues", "comment-add", "i1", "--body", "hi"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["id"] == "c1"


@respx.mock
def test_incident_resolve_requires_yes(logged_in, runner):
    route = respx.post(f"{BASE}/api/issues/i1/resolve").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "issues", "resolve", "i1", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called


@respx.mock
def test_incident_open_standalone(logged_in, runner):
    respx.post(f"{BASE}/api/issues").mock(
        return_value=httpx.Response(201, json={"id": "i9", "newly_opened": True, "state": "firing"})
    )
    result = runner.invoke(app, ["--json", "issues", "open", "--summary", "manual",
                                 "--title", "checkout 500s", "--severity", "critical"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["id"] == "i9"
    # The title has to reach the wire — the server REQUIRES it on the orphan
    # path, and omitting it is what made this command 422 unconditionally.
    sent = json.loads(respx.calls.last.request.content)
    assert sent["title"] == "checkout 500s" and sent["severity"] == "critical"


@respx.mock
def test_incident_open_standalone_without_title_exits_2(logged_in, runner):
    """A standalone open with no --title is rejected client-side, before the
    request: the server can only answer 422, so spending a round-trip on a
    known-bad body just turns a usage error into a server error."""
    route = respx.post(f"{BASE}/api/issues").mock(
        return_value=httpx.Response(201, json={"id": "i9"}))
    result = runner.invoke(app, ["issues", "open", "--summary", "manual"])
    assert result.exit_code == 2, result.output
    assert "--title is required" in result.output
    assert not route.called


@respx.mock
def test_incident_open_linked_uses_alert_path(logged_in, runner):
    route = respx.post(f"{BASE}/api/alerts/a1/issues").mock(
        return_value=httpx.Response(201, json={"id": "i9", "newly_opened": True, "state": "firing"})
    )
    result = runner.invoke(app, ["--json", "issues", "open", "--summary", "x", "--alert-id", "a1"])
    assert result.exit_code == 0, result.output
    assert route.called


# --- incidents: redesigned human UI + edge cases ----------------------------

_FULL_INCIDENT = {
    "id": "1f5803aaaaaabbbbcccc000000009826",
    "alert_id": "a1",
    "alert_name": "p95 latency",
    "alert_severity": "critical",
    "state": "acknowledged",
    "opened_at": "2026-06-28T00:00:00Z",
    "acknowledged_by": "ops@corp.com",
    "assignees": ["a@corp.com"],
    "breach_summary": "p95 = 1240ms > 1000ms",
    "comments": [
        {"id": "c1", "author_email": "ops@corp.com", "body": "looking into it", "created_at": "2026-06-28T00:01:00Z"},
        {"id": "c2", "author_email": "x@corp.com", "body": None, "created_at": "2026-06-28T00:02:00Z", "deleted_at": "2026-06-28T00:03:00Z"},
    ],
    "subscribers": [{"email": "ops@corp.com", "source": "ack", "subscribed_at": "2026-06-28T00:01:00Z"}],
    "activity": [{"kind": "opened", "actor": "system", "at": "2026-06-28T00:00:00Z"},
                 {"kind": "acknowledged", "actor": "ops@corp.com", "at": "2026-06-28T00:01:00Z"}],
}


@respx.mock
def test_incidents_list_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/issues").mock(return_value=httpx.Response(200, json=[
        {"id": "1f5803aaaaaabbbbcccc000000009826", "alert_name": "p95", "alert_severity": "critical",
         "state": "firing", "opened_at": "2026-06-28T00:00:00Z", "assignees": ["a@corp.com"]},
        {"id": "z", "alert_name": None, "alert_severity": "info", "state": "resolved",
         "opened_at": "2026-06-20T00:00:00Z", "assignees": []},
    ]))
    result = runner.invoke(app, ["issues", "list"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "issues" in out
    for c in ("alert", "severity", "state", "opened", "assignees"):
        assert c in out
    assert "1f58" in out                         # short id is the handle
    assert "firing" in out and "resolved" in out  # state words + footer distribution


@respx.mock
def test_incidents_list_invalid_state_exits_2(logged_in, runner):
    result = runner.invoke(app, ["issues", "list", "--state", "bogus"])
    assert result.exit_code == 2


@respx.mock
def test_incidents_list_limit_zero_exits_2(logged_in, runner):
    result = runner.invoke(app, ["issues", "list", "--limit", "0"])
    assert result.exit_code == 2


@respx.mock
def test_incidents_count_human_card(logged_in, runner):
    respx.get(f"{BASE}/api/issues/count").mock(return_value=httpx.Response(200, json={"count": 4}))
    result = runner.invoke(app, ["issues", "count", "--state", "firing"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "issues" in out and "4" in out and "firing issues" in out


@respx.mock
def test_incidents_show_human_cards(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1").mock(return_value=httpx.Response(200, json=_FULL_INCIDENT))
    result = runner.invoke(app, ["issues", "show", "i1"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "p95 latency" in out and "critical" in out and "acknowledged" in out
    assert "breach" in out and "1240ms" in out
    assert "comments" in out and "looking into it" in out and "(deleted)" in out
    assert "subscribers" in out and "ops@corp.com" in out
    assert "activity" in out and "opened" in out and "system" in out


@respx.mock
def test_incidents_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/issues/ghost").mock(return_value=httpx.Response(404, json={"error": "Not found."}))
    result = runner.invoke(app, ["issues", "show", "ghost"])
    assert result.exit_code == 6, result.output
    assert "no issue" in result.stderr
    assert "HTTP" not in (result.stdout + result.stderr)  # never leak raw HTTP status


@respx.mock
def test_incidents_show_not_found_json(logged_in, runner):
    respx.get(f"{BASE}/api/issues/ghost").mock(return_value=httpx.Response(404, json={"error": "Not found."}))
    result = runner.invoke(app, ["--json", "issues", "show", "ghost"])
    assert result.exit_code == 6
    assert "no issue" in json.loads(result.stdout)["error"]


@respx.mock
def test_incidents_ack_human(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/ack").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["issues", "ack", "i1"])
    assert result.exit_code == 0, result.output
    assert "acknowledged issue" in result.stderr


@respx.mock
def test_incidents_assign_non_operator_clean_error(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/assign").mock(
        return_value=httpx.Response(422, json={"error": "a@x.com is not an operator"})
    )
    result = runner.invoke(app, ["issues", "assign", "i1", "--assignee", "a@x.com"])
    assert result.exit_code == 1, result.output       # ApiError → exit 1
    assert "not an operator" in result.stderr
    assert "HTTP" not in (result.stdout + result.stderr)


@respx.mock
def test_incidents_assign_non_operator_json(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/assign").mock(
        return_value=httpx.Response(422, json={"error": "a@x.com is not an operator"})
    )
    result = runner.invoke(app, ["--json", "issues", "assign", "i1", "--assignee", "a@x.com"])
    assert result.exit_code == 1
    body = json.loads(result.stdout)
    assert "not an operator" in body["error"] and body["status"] == 422


@respx.mock
def test_incidents_resolve_human_yes(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/resolve").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["issues", "resolve", "i1", "--yes"])
    assert result.exit_code == 0, result.output
    assert "resolved issue" in result.stderr


@respx.mock
def test_incidents_resolve_declined_emits_the_json_cancel_envelope(logged_in, runner, monkeypatch):
    # Both docstrings promise `{cancelled: true}` under --json on a declined prompt, and
    # every other write command emits it. `should_prompt` is forced here because --json
    # normally auto-proceeds, which is what let these two paths drift to a stderr line
    # only: a caller reading stdout would have got an empty document at exit 0.
    monkeypatch.setattr(_write, "should_prompt", lambda *a, **k: True)
    monkeypatch.setattr(output, "confirm_incident_resolve", lambda *a, **k: False)
    respx.get(f"{BASE}/api/issues/i1").mock(  # the prompt names the alert, so it reads first
        return_value=httpx.Response(200, json={"id": "i1", "alert_name": "p95", "status": "open"}))
    resolve = respx.post(f"{BASE}/api/issues/i1/resolve").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "issues", "resolve", "i1"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"cancelled": True}
    assert not resolve.called


@respx.mock
def test_incidents_comment_delete_declined_emits_the_json_cancel_envelope(logged_in, runner, monkeypatch):
    monkeypatch.setattr(_write, "should_prompt", lambda *a, **k: True)
    monkeypatch.setattr(output, "confirm_incident_comment_delete", lambda *a, **k: False)
    respx.get(f"{BASE}/api/issues/i1/comments").mock(return_value=httpx.Response(200, json=[
        {"id": "c1", "incident_id": "i1", "author_email": "me@test", "body": "typo", "created_at": "t"}]))
    delete = respx.delete(f"{BASE}/api/issues/i1/comments/c1").mock(return_value=httpx.Response(204))
    result = runner.invoke(app, ["--json", "issues", "comment-delete", "i1", "c1"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"cancelled": True}
    assert not delete.called


@respx.mock
def test_incidents_comment_add_human_card(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/comments").mock(
        return_value=httpx.Response(201, json={"id": "c1", "incident_id": "i1", "author_email": "me@test", "body": "on it", "created_at": "t"})
    )
    result = runner.invoke(app, ["issues", "comment-add", "i1", "--body", "on it"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "comment added" in out and "on it" in out


def test_incidents_comment_add_neither_exits_2(logged_in, runner):
    result = runner.invoke(app, ["issues", "comment-add", "i1"])
    assert result.exit_code == 2


@respx.mock
def test_incidents_comment_delete_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1/comments").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["issues", "comment-delete", "i1", "cX", "--yes"])
    assert result.exit_code == 6, result.output
    assert "no comment" in result.stderr


@respx.mock
def test_incidents_comment_delete_human_yes(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1/comments").mock(return_value=httpx.Response(200, json=[
        {"id": "c1", "incident_id": "i1", "author_email": "me@test", "body": "typo", "created_at": "2026-06-28T00:00:00Z"}]))
    route = respx.delete(f"{BASE}/api/issues/i1/comments/c1").mock(return_value=httpx.Response(204))
    result = runner.invoke(app, ["issues", "comment-delete", "i1", "c1", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called
    assert "deleted comment" in result.stderr


@respx.mock
def test_incidents_comment_delete_json(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1/comments").mock(return_value=httpx.Response(200, json=[
        {"id": "c1", "incident_id": "i1", "author_email": "me@test", "body": "typo", "created_at": "t"}]))
    respx.delete(f"{BASE}/api/issues/i1/comments/c1").mock(return_value=httpx.Response(204))
    result = runner.invoke(app, ["--json", "issues", "comment-delete", "i1", "c1", "--yes"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert body["deleted"] is True and body["id"] == "c1"


@respx.mock
def test_incidents_comment_list_human(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1/comments").mock(return_value=httpx.Response(200, json=[
        {"id": "c1", "author_email": "ops@corp.com", "body": "db pool exhausted", "created_at": "2026-06-28T00:00:00Z"},
        {"id": "c2", "author_email": "x@corp.com", "body": None, "created_at": "2026-06-28T00:01:00Z", "deleted_at": "t"},
    ]))
    result = runner.invoke(app, ["issues", "comment-list", "i1"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "comments" in out and "db pool exhausted" in out and "(deleted)" in out


@respx.mock
def test_incidents_subscribers_human(logged_in, runner):
    respx.get(f"{BASE}/api/issues/i1/subscribers").mock(return_value=httpx.Response(200, json=[
        {"email": "ops@corp.com", "source": "creator", "subscribed_at": "2026-06-28T00:00:00Z"}]))
    result = runner.invoke(app, ["issues", "subscribers", "i1"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "subscribers" in out and "ops@corp.com" in out and "creator" in out


@respx.mock
def test_incidents_subscribe_human(logged_in, runner):
    respx.post(f"{BASE}/api/issues/i1/subscribe").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["issues", "subscribe", "i1"])
    assert result.exit_code == 0, result.output
    assert "subscribed" in result.stderr and "you" in result.stderr


@respx.mock
def test_incidents_open_human_card(logged_in, runner):
    respx.post(f"{BASE}/api/issues").mock(
        return_value=httpx.Response(201, json={"id": "i9", "newly_opened": True, "state": "firing"}))
    respx.get(f"{BASE}/api/issues/i9").mock(return_value=httpx.Response(200, json={
        "id": "i9", "state": "firing", "alert_severity": "critical", "title": "checkout 500s",
        "opened_at": "2026-06-28T00:00:00Z"}))
    result = runner.invoke(app, ["issues", "open", "--summary", "manual page",
                                 "--title", "checkout 500s", "--severity", "critical"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "issue opened" in out and "manual page" in out and "critical" in out
    assert "checkout 500s" in out          # the title is the card's hero line


def test_incidents_open_bad_severity_exits_2(logged_in, runner):
    result = runner.invoke(app, ["issues", "open", "--summary", "x", "--severity", "bogus"])
    assert result.exit_code == 2
