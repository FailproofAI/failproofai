"""Audits: definitions CRUD + runs + findings triage."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from fp_cli import analytics
from fp_cli.app import app

BASE = "http://dash.test"

_FULL_AUDIT = {
    "id": "au1",
    "name": "nightly-prod",
    "description": "nightly failure sweep",
    "enabled": True,
    "schedule_interval_secs": 86400,
    "window_mode": "since_last",
    "lookback_window_secs": 604800,
    "scope": {"environments": ["prod"]},
    "ignore_error_types": ["TimeoutError"],
    "llm_enabled": True,
    "top_k": 50,
    "sensitivity": "medium",
    "channels": [{"kind": "slack"}],
    "created_by": "ops@example.com",
    "created_at": "2026-06-28T00:00:00Z",
    "updated_at": "2026-06-28T00:00:00Z",
    "open_findings": 3,
    "last_run_status": "succeeded",
    "last_run_finished_at": "2026-06-28T01:00:00Z",
}

_FULL_FINDING = {
    "id": "1f5803aa-aaaa-bbbb-cccc-000000009826",
    "audit_id": "au1",
    "audit_name": "nightly-prod",
    "fingerprint": "fp-1",
    "title": "retry storm on checkout tool",
    "category": "reliability",
    "failure_type": "tool_error",
    "description": "the checkout tool is retried until the budget is exhausted",
    "root_cause_hypothesis": "upstream 502s are not treated as terminal",
    "severity": "critical",
    "magnitude": "big",
    "priority": 0.92,
    "status": "open",
    "occurrences": 41,
    "first_seen_at": "2026-06-20T00:00:00Z",
    "last_seen_at": "2026-06-28T00:00:00Z",
    "recommendation": "treat 502 as terminal and fail fast",
    "expected_impact": "removes ~40 wasted calls a day",
    "effort": "small",
    "evidence": {"sessions": ["run-001"]},
    "evidence_queries": ["SELECT 1"],
    "scope": {"environments": ["prod"]},
    "kind": "failure",
    "assigned_to": None,
}


# --- audits: definitions ----------------------------------------------------


@respx.mock
def test_audits_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["--json", "audits", "list"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)["audits"][0]
    assert body["id"] == "au1" and body["name"] == "nightly-prod"
    assert body["scope"] == {"environments": ["prod"]}   # opaque blob passes through untouched
    assert body["open_findings"] == 3


@respx.mock
def test_audits_list_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[
        _FULL_AUDIT,
        {**_FULL_AUDIT, "id": "au2", "name": "paused", "enabled": False, "open_findings": 0,
         "created_at": "2026-06-20T00:00:00Z", "last_run_status": None,
         "last_run_finished_at": None},
    ]))
    result = runner.invoke(app, ["audits", "list"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "audits" in out and "newest first" in out
    for c in ("created", "name", "every", "findings", "status", "last run"):
        assert c in out
    assert "nightly-prod" in out and "paused" in out
    assert "1d" in out            # humanized 86400s schedule
    assert "never" in out         # the paused audit has never run
    assert "on" in out and "off" in out            # the on/off split in the footer
    assert "3 open findings" in out                # footer findings roll-up


@respx.mock
def test_audits_list_enabled_only(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[
        _FULL_AUDIT, {**_FULL_AUDIT, "id": "au2", "name": "paused", "enabled": False}]))
    result = runner.invoke(app, ["--json", "audits", "list", "--enabled-only"])
    assert result.exit_code == 0, result.output
    audits = json.loads(result.stdout)["audits"]
    assert [a["name"] for a in audits] == ["nightly-prod"]


@respx.mock
def test_audits_show_by_name_json(logged_in, runner):
    # `show` resolves the NAME through the list endpoint (no GET by id needed).
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["--json", "audits", "show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["scope"] == {"environments": ["prod"]}


@respx.mock
def test_audits_show_human_cards(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["audits", "show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "nightly-prod" in out and "enabled" in out and "3 open findings" in out
    assert "schedule" in out and "runs every" in out and "1d" in out
    assert "scope" in out and "prod" in out and "TimeoutError" in out   # covers + ignores
    assert "analysis" in out and "sensitivity" in out and "medium" in out
    assert "channels" in out and "slack" in out


@respx.mock
def test_audits_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["audits", "show", "ghost"])
    assert result.exit_code == 6


@respx.mock
def test_audits_create_sends_definition(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))  # no collision
    route = respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t"}))
    result = runner.invoke(app, [
        "--json", "audits", "create", "nightly-prod",
        "--scope", '{"environments":["prod"]}',
        "--schedule-interval-secs", "86400",
        "--sensitivity", "high",
        "--ignore-error-type", "TimeoutError,ValueError",
    ])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "nightly-prod"
    assert body["scope"] == {"environments": ["prod"]}
    assert body["sensitivity"] == "high"
    assert body["ignore_error_types"] == ["TimeoutError", "ValueError"]   # CSV → list
    assert json.loads(result.stdout)["id"] == "au9"


@respx.mock
def test_audits_create_from_file(logged_in, runner, tmp_path):
    payload = {"name": "weekly", "schedule_interval_secs": 604800, "sensitivity": "low"}
    f = tmp_path / "audit.json"
    f.write_text(json.dumps(payload))
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    route = respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t"}))
    result = runner.invoke(app, ["--json", "audits", "create", "weekly", "--file", str(f),
                                 "--sensitivity", "high"])  # a flag overrides the file
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["schedule_interval_secs"] == 604800 and body["sensitivity"] == "high"


@respx.mock
def test_audits_create_sends_context_in_the_same_request(logged_in, runner):
    """Context goes with the definition, not in a follow-up request.

    Creating an enabled audit queues its first run due immediately, so a second
    request can lose the race: the run an operator watches would argue without
    the brief they just attached. No `PUT .../context` route is registered here
    deliberately — if the command made that call, respx would fail the test."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    route = respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t", "sources": 2}))
    other = "https://docs.example.com/slo"
    result = runner.invoke(app, [
        "--json", "audits", "create", "nightly-prod",
        "--text", "checkout agent for a retail store",
        "--url", _DOC_URL, "--url", other,
    ])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["context"] == {
        "text": "checkout agent for a retail store",
        "urls": [_DOC_URL, other],
    }


@respx.mock
def test_audits_create_without_context_sends_no_context_key(logged_in, runner):
    """An omitted brief must not become an empty one — `context` absent, not `{}`."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    route = respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t"}))
    result = runner.invoke(app, ["--json", "audits", "create", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "context" not in json.loads(route.calls.last.request.content)


@respx.mock
def test_audits_create_reads_the_brief_from_a_file(logged_in, runner, tmp_path):
    f = tmp_path / "brief.md"
    f.write_text("# Checkout agent\n\nRetries are expected on 429.")
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    route = respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t", "sources": 0}))
    result = runner.invoke(app, ["--json", "audits", "create", "nightly-prod",
                                 "--text-file", str(f)])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["context"]["text"].startswith("# Checkout agent")
    assert body["context"]["urls"] == []


def test_audits_create_rejects_too_many_urls(logged_in, runner):
    # The server's cap, applied before the request goes out.
    result = runner.invoke(app, ["audits", "create", "x"] + sum(
        (["--url", f"https://docs.example.com/{i}"] for i in range(6)), []))
    assert result.exit_code == 2, result.output


def test_audits_create_rejects_text_and_text_file_together(logged_in, runner):
    result = runner.invoke(app, ["audits", "create", "x", "--text", "a", "--text-file", "b.md"])
    assert result.exit_code == 2, result.output


@respx.mock
def test_audits_create_human_renders_card(logged_in, runner):
    # Human mode: pre-check (no collision) → POST → re-read the canonical audit → render the card.
    respx.get(f"{BASE}/api/audits").mock(side_effect=[
        httpx.Response(200, json=[]),              # pre-check: no collision
        httpx.Response(200, json=[_FULL_AUDIT]),   # re-fetch after the write
    ])
    respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au1", "created_at": "t"}))
    result = runner.invoke(app, ["audits", "create", "nightly-prod"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "audit created" in out and "nightly-prod" in out
    assert "schedule" in out and "channels" in out   # the same cards `show` renders


@respx.mock
def test_audits_create_renders_from_body_when_refetch_misses(logged_in, runner):
    # If the post-write re-read doesn't find the audit, the card still renders — built from the
    # request body — rather than crashing on the missing canonical row.
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t"}))
    result = runner.invoke(app, ["audits", "create", "weekly", "--sensitivity", "high",
                                 "--scope", '{"environments":["prod"]}'])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "audit created" in out and "weekly" in out
    assert "high" in out and "prod" in out


@respx.mock
def test_audits_create_name_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["--json", "audits", "create", "nightly-prod"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


def test_audits_create_bad_interval_exits_2(logged_in, runner):
    # Below the server's 1h floor — rejected locally, before any HTTP call.
    result = runner.invoke(app, ["audits", "create", "x", "--schedule-interval-secs", "60"])
    assert result.exit_code == 2


def test_audits_create_bad_window_mode_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "create", "x", "--window-mode", "bogus"])
    assert result.exit_code == 2


def test_audits_create_bad_sensitivity_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "create", "x", "--sensitivity", "bogus"])
    assert result.exit_code == 2


@respx.mock
def test_audits_edit_flag_only_resends_full_body(logged_in, runner):
    # A flag-only edit resolves the NAME via the list, then PUTs the WHOLE definition back with
    # just the changed field — the server replaces the definition on update.
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    put = respx.put(f"{BASE}/api/audits/au1").mock(
        return_value=httpx.Response(200, json={"id": "au1", "updated": True}))
    result = runner.invoke(app, ["--json", "audits", "edit", "nightly-prod",
                                 "--sensitivity", "high", "--yes"])
    assert result.exit_code == 0, result.output
    body = json.loads(put.calls.last.request.content)
    assert body["sensitivity"] == "high"                        # the changed field
    assert body["name"] == "nightly-prod"                       # everything else carried over
    assert body["scope"] == {"environments": ["prod"]}
    assert body["schedule_interval_secs"] == 86400
    assert body["channels"] == [{"kind": "slack"}]
    assert body["enabled"] is True
    assert "open_findings" not in body                          # server-derived state never sent


@respx.mock
def test_audits_edit_disable(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    put = respx.put(f"{BASE}/api/audits/au1").mock(
        return_value=httpx.Response(200, json={"id": "au1", "updated": True}))
    result = runner.invoke(app, ["--json", "audits", "edit", "nightly-prod", "--disabled", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(put.calls.last.request.content)["enabled"] is False


@respx.mock
def test_audits_edit_human_renders_card(logged_in, runner):
    # First GET resolves the name (old state); the post-PUT re-fetch returns the new state.
    respx.get(f"{BASE}/api/audits").mock(side_effect=[
        httpx.Response(200, json=[_FULL_AUDIT]),
        httpx.Response(200, json=[{**_FULL_AUDIT, "sensitivity": "high"}]),
    ])
    respx.put(f"{BASE}/api/audits/au1").mock(
        return_value=httpx.Response(200, json={"id": "au1", "updated": True}))
    result = runner.invoke(app, ["audits", "edit", "nightly-prod", "--sensitivity", "high", "--yes"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "audit updated" in out and "nightly-prod" in out and "high" in out


@respx.mock
def test_audits_edit_rename_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[
        _FULL_AUDIT, {**_FULL_AUDIT, "id": "au2", "name": "taken"}]))
    result = runner.invoke(app, ["--json", "audits", "edit", "nightly-prod", "--name", "taken", "--yes"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


@respx.mock
def test_audits_edit_missing_audit_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    put = respx.put(f"{BASE}/api/audits/au1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["audits", "edit", "ghost", "--sensitivity", "high", "--yes"])
    assert result.exit_code == 6, result.output
    assert not put.called


@respx.mock
def test_audits_delete_by_name(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    route = respx.delete(f"{BASE}/api/audits/au1").mock(return_value=httpx.Response(204))
    result = runner.invoke(app, ["--json", "audits", "delete", "nightly-prod", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(result.stdout)
    assert body["deleted"] is True and body["name"] == "nightly-prod"


@respx.mock
def test_audits_delete_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["audits", "delete", "ghost", "--yes"])
    assert result.exit_code == 6


# --- audits: run + runs -----------------------------------------------------


@respx.mock
def test_audits_run_queues_202(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    route = respx.post(f"{BASE}/api/audits/au1/run").mock(
        return_value=httpx.Response(202, json={"queued": True}))
    result = runner.invoke(app, ["--json", "audits", "run", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert route.called
    assert json.loads(result.stdout)["queued"] is True


@respx.mock
def test_audits_run_human(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.post(f"{BASE}/api/audits/au1/run").mock(
        return_value=httpx.Response(202, json={"queued": True}))
    result = runner.invoke(app, ["audits", "run", "nightly-prod"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "queued a run for" in out and "nightly-prod" in out


@respx.mock
def test_audits_run_conflict_409(logged_in, runner):
    # A run already in progress → the server's 409 message, never a double-queue.
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.post(f"{BASE}/api/audits/au1/run").mock(return_value=httpx.Response(
        409, json={"error": "a run is already in progress; it must finish before another can be queued"}))
    result = runner.invoke(app, ["audits", "run", "nightly-prod"])
    assert result.exit_code == 1, result.output       # ApiError → exit 1
    assert "already in progress" in result.stderr
    assert "HTTP" not in (result.stdout + result.stderr)   # never leak the raw status


@respx.mock
def test_audits_run_conflict_409_json(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.post(f"{BASE}/api/audits/au1/run").mock(return_value=httpx.Response(
        409, json={"error": "a run is already in progress; it must finish before another can be queued"}))
    result = runner.invoke(app, ["--json", "audits", "run", "nightly-prod"])
    assert result.exit_code == 1
    body = json.loads(result.stdout)
    assert "already in progress" in body["error"] and body["status"] == 409
    assert "audits runs" in body["hint"]


@respx.mock
def test_audits_runs_json(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/runs").mock(return_value=httpx.Response(200, json=[
        {"id": "r1", "status": "succeeded", "trigger_kind": "schedule",
         "window_from": "2026-06-27T00:00:00Z", "window_to": "2026-06-28T00:00:00Z",
         "started_at": "2026-06-28T00:00:00Z", "finished_at": "2026-06-28T00:00:30Z",
         "stats": {"events": 100}, "findings_count": 4, "new_findings_count": 1,
         "report": "all good", "error": None},
    ]))
    result = runner.invoke(app, ["--json", "audits", "runs", "nightly-prod"])
    assert result.exit_code == 0, result.output
    run = json.loads(result.stdout)["runs"][0]
    assert run["id"] == "r1" and run["findings_count"] == 4 and run["stats"] == {"events": 100}


@respx.mock
def test_audits_runs_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/runs").mock(return_value=httpx.Response(200, json=[
        {"id": "r1", "status": "succeeded", "trigger_kind": "schedule",
         "started_at": "2026-06-28T00:00:00Z", "finished_at": "2026-06-28T00:00:30Z",
         "findings_count": 4, "new_findings_count": 1},
        {"id": "r2", "status": "failed", "trigger_kind": "manual",
         "started_at": "2026-06-27T00:00:00Z", "finished_at": "2026-06-27T00:00:10Z",
         "findings_count": 0, "new_findings_count": 0, "error": "clickhouse timeout"},
    ]))
    result = runner.invoke(app, ["audits", "runs", "nightly-prod"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "runs" in out and "nightly-prod" in out
    for c in ("started", "status", "trigger", "findings", "new", "took"):
        assert c in out
    assert "succeeded" in out and "failed" in out and "30s" in out   # computed wall time


@respx.mock
def test_audits_runs_limit_zero_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "runs", "nightly-prod", "--limit", "0"])
    assert result.exit_code == 2


# --- audits: findings -------------------------------------------------------


@respx.mock
def test_audits_findings_json_with_filters(logged_in, runner):
    route = respx.get(f"{BASE}/api/audits/findings").mock(
        return_value=httpx.Response(200, json=[_FULL_FINDING]))
    result = runner.invoke(app, ["--json", "audits", "findings", "--status", "open,recurring",
                                 "--run-id", "r1", "--limit", "20", "--offset", "5"])
    assert result.exit_code == 0, result.output
    params = route.calls.last.request.url.params
    assert params["status"] == "open,recurring"
    assert params["run_id"] == "r1"
    assert params["limit"] == "20" and params["offset"] == "5"
    assert json.loads(result.stdout)["findings"][0]["id"] == _FULL_FINDING["id"]


@respx.mock
def test_audits_findings_by_audit_name_resolves_id(logged_in, runner):
    # `--audit` takes the audit NAME; the CLI resolves it to the id the server filter wants.
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    route = respx.get(f"{BASE}/api/audits/findings").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["--json", "audits", "findings", "--audit", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert route.calls.last.request.url.params["audit_id"] == "au1"


@respx.mock
def test_audits_findings_unknown_audit_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    result = runner.invoke(app, ["audits", "findings", "--audit", "ghost"])
    assert result.exit_code == 6


@respx.mock
def test_audits_findings_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/audits/findings").mock(return_value=httpx.Response(200, json=[
        _FULL_FINDING,
        {**_FULL_FINDING, "id": "22220000-aaaa-bbbb-cccc-000000001111", "title": "slow tool",
         "severity": "warning", "status": "muted", "kind": "improvement", "occurrences": 2},
    ]))
    result = runner.invoke(app, ["audits", "findings"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "findings" in out and "highest priority first" in out
    for c in ("title", "severity", "status", "kind", "seen", "last"):
        assert c in out
    assert "1f58" in out                                  # short id is the handle
    # The title truncates to the leftover width (80-col test console) so the fixed columns
    # always survive — the full text is in `audits finding` / --json.
    assert "retry" in out and "critical" in out
    assert "open" in out and "muted" in out               # status words + footer distribution
    assert "1 critical" in out                            # footer severity roll-up


def test_audits_findings_bad_status_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "findings", "--status", "bogus"])
    assert result.exit_code == 2


def test_audits_findings_limit_zero_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "findings", "--limit", "0"])
    assert result.exit_code == 2


def test_audits_findings_negative_offset_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "findings", "--offset", "-1"])
    assert result.exit_code == 2


@respx.mock
def test_audits_finding_show_json(logged_in, runner):
    fid = _FULL_FINDING["id"]
    respx.get(f"{BASE}/api/audits/findings/{fid}").mock(
        return_value=httpx.Response(200, json=_FULL_FINDING))
    result = runner.invoke(app, ["--json", "audits", "finding", fid])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert body["title"] == "retry storm on checkout tool"
    assert body["evidence"] == {"sessions": ["run-001"]}


@respx.mock
def test_audits_finding_show_human_cards(logged_in, runner):
    fid = _FULL_FINDING["id"]
    respx.get(f"{BASE}/api/audits/findings/{fid}").mock(
        return_value=httpx.Response(200, json=_FULL_FINDING))
    result = runner.invoke(app, ["audits", "finding", fid])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "retry storm on checkout tool" in out and "critical" in out and "failure" in out
    assert "seen" in out and "41" in out
    assert "analysis" in out and "upstream 502s" in out          # root-cause hypothesis
    assert "recommendation" in out and "fail fast" in out and "small" in out
    assert "evidence" in out and "run-001" in out


@respx.mock
def test_audits_finding_not_found_exits_6(logged_in, runner):
    fid = "1f5803aa-aaaa-bbbb-cccc-000000000000"
    respx.get(f"{BASE}/api/audits/findings/{fid}").mock(
        return_value=httpx.Response(404, json={"error": "not found"}))
    result = runner.invoke(app, ["audits", "finding", fid])
    assert result.exit_code == 6, result.output
    assert "no finding" in result.stderr
    assert "HTTP" not in (result.stdout + result.stderr)


@respx.mock
def test_audits_finding_malformed_id_is_not_found(logged_in, runner):
    # The server's path extractor answers a non-UUID id with a 400 — surface the calm not-found.
    respx.get(f"{BASE}/api/audits/findings/not-a-uuid").mock(
        return_value=httpx.Response(400, json={"error": "invalid uuid"}))
    result = runner.invoke(app, ["--json", "audits", "finding", "not-a-uuid"])
    assert result.exit_code == 6
    assert "no finding" in json.loads(result.stdout)["error"]


@respx.mock
def test_audits_finding_forbidden_exits_5(logged_in, runner):
    fid = _FULL_FINDING["id"]
    respx.get(f"{BASE}/api/audits/findings/{fid}").mock(return_value=httpx.Response(
        403, json={"error": "forbidden", "required_permission": "audits:read"}))
    result = runner.invoke(app, ["audits", "finding", fid])
    assert result.exit_code == 5, result.output
    assert "audits:read" in result.stderr      # the denial names the missing permission


@respx.mock
def test_audits_list_forbidden_exits_5(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(
        403, json={"error": "forbidden", "required_permission": "audits:read"}))
    result = runner.invoke(app, ["--json", "audits", "list"])
    assert result.exit_code == 5
    assert "audits:read" in json.loads(result.stdout)["error"]


# --- audits: finding triage -------------------------------------------------


@respx.mock
def test_finding_ack(logged_in, runner):
    fid = _FULL_FINDING["id"]
    route = respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "ack", "ok": True}))
    result = runner.invoke(app, ["--json", "audits", "ack", fid, "--reason", "known"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body == {"action": "ack", "reason": "known"}
    assert json.loads(result.stdout)["ok"] is True


@respx.mock
def test_finding_mute(logged_in, runner):
    fid = _FULL_FINDING["id"]
    route = respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "mute", "ok": True}))
    result = runner.invoke(app, ["--json", "audits", "mute", fid, "--reason", "expected", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content)["action"] == "mute"


@respx.mock
def test_finding_dismiss(logged_in, runner):
    fid = _FULL_FINDING["id"]
    route = respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "dismiss", "ok": True}))
    result = runner.invoke(app, ["--json", "audits", "dismiss", fid, "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"action": "dismiss"}


@respx.mock
def test_finding_resolve_human(logged_in, runner):
    fid = _FULL_FINDING["id"]
    respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "resolve", "ok": True}))
    result = runner.invoke(app, ["audits", "resolve", fid, "--yes"])
    assert result.exit_code == 0, result.output
    assert "resolved finding" in result.stderr


@respx.mock
def test_finding_reopen(logged_in, runner):
    fid = _FULL_FINDING["id"]
    route = respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "reopen", "ok": True}))
    result = runner.invoke(app, ["audits", "reopen", fid])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"action": "reopen"}
    assert "reopened finding" in result.stderr


@respx.mock
def test_finding_assign_sends_assignee(logged_in, runner):
    fid = _FULL_FINDING["id"]
    route = respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(200, json={"id": fid, "action": "assign", "ok": True}))
    result = runner.invoke(app, ["audits", "assign", fid, "--to", "alice@example.com"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {
        "action": "assign", "assigned_to": "alice@example.com"}
    assert "assigned finding" in result.stderr and "alice@example.com" in result.stderr


def test_finding_assign_without_to_exits_2(logged_in, runner):
    result = runner.invoke(app, ["audits", "assign", _FULL_FINDING["id"]])
    assert result.exit_code == 2      # --to is required


def test_finding_unknown_action_exits_2(logged_in, runner):
    # The triage verbs are the command surface — an unknown action is a usage error, never a 422.
    result = runner.invoke(app, ["audits", "snooze", _FULL_FINDING["id"]])
    assert result.exit_code == 2


def test_triage_action_validator_rejects_unknown():
    # The shared validator behind every triage verb (defence in depth for the --action value).
    import pytest

    from fp_cli import _click_compat as click  # the Click Typer is running
    from fp_cli.commands import audits_cmds

    with pytest.raises(click.BadParameter):
        audits_cmds._validate_action("snooze")
    assert audits_cmds._validate_action("ack") == "ack"


@respx.mock
def test_finding_triage_not_found_exits_6(logged_in, runner):
    fid = "1f5803aa-aaaa-bbbb-cccc-000000000000"
    respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(
        return_value=httpx.Response(404, json={"error": "not found"}))
    result = runner.invoke(app, ["audits", "ack", fid])
    assert result.exit_code == 6, result.output
    assert "no finding" in result.stderr


@respx.mock
def test_finding_triage_forbidden_exits_5(logged_in, runner):
    fid = _FULL_FINDING["id"]
    respx.post(f"{BASE}/api/audits/findings/{fid}/status").mock(return_value=httpx.Response(
        403, json={"error": "forbidden", "required_permission": "audits:write"}))
    result = runner.invoke(app, ["--json", "audits", "ack", fid])
    assert result.exit_code == 5
    assert "audits:write" in json.loads(result.stdout)["error"]


# --- audits: reference context ---
#
# This surface shipped with zero tests, and the first thing an operator does
# after `context-set` is the thing that crashed: `context-show` dereferenced a
# theme token that does not exist, so every human-mode render raised
# AttributeError. `--json` returns before the formatter, which is why nothing
# scripted noticed. The human-render assertions below are the ones that matter.

_DOC_URL = "https://docs.example.com/runbook"

_CTX_PENDING = {
    "text": "checkout agent for a retail store",
    "sources": [
        {"id": "s1", "url": _DOC_URL, "position": 0,
         "status": "pending", "final_url": None, "title": None, "content_type": None,
         "preview": "", "preview_truncated": False, "chars": 0, "chars_total": 0,
         "truncated": False, "redactions": 0, "injection_markers": [],
         "error_code": None, "error_detail": None, "fetched_at": None,
         "attempted_at": None, "changed_at": None},
    ],
}


@respx.mock
def test_context_show_renders_a_pending_source(logged_in, runner):
    """The regression test for the AttributeError: a non-`ok` status took the
    branch that referenced a missing theme token."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json=_CTX_PENDING))
    result = runner.invoke(app, ["audits", "context-show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "pending" in result.stderr
    assert "docs.example.com" in result.stderr


@respx.mock
def test_context_show_renders_an_ok_source_with_injection_markers(logged_in, runner):
    """The other crashing branch: a stored page that carries markers — i.e. the
    exact case the feature exists to surface."""
    ctx = json.loads(json.dumps(_CTX_PENDING))
    ctx["sources"][0].update(status="ok", chars=1200, chars_total=1200,
                             injection_markers=["ignore previous instructions"])
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(return_value=httpx.Response(200, json=ctx))
    result = runner.invoke(app, ["audits", "context-show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "review" in result.stderr
    assert "instructions to an AI" in result.stderr


@respx.mock
def test_context_show_tolerates_an_unknown_status(logged_in, runner):
    """The server owns this vocabulary; a value we do not know must render, not raise."""
    ctx = json.loads(json.dumps(_CTX_PENDING))
    ctx["sources"][0]["status"] = "quarantined"
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(return_value=httpx.Response(200, json=ctx))
    result = runner.invoke(app, ["audits", "context-show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "quarantined" in result.stderr


@respx.mock
def test_context_show_marks_a_retained_snapshot_as_still_used(logged_in, runner):
    """A `failed` re-read does not withdraw the snapshot we already hold — the
    server still puts it in the prompt. Reporting it as simply "failed" told the
    operator the opposite, and suppressed its injection markers with it."""
    ctx = json.loads(json.dumps(_CTX_PENDING))
    ctx["sources"][0].update(status="failed", chars=1500, chars_total=1500,
                             error_detail="connection reset",
                             injection_markers=["ignore previous instructions"])
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(return_value=httpx.Response(200, json=ctx))
    result = runner.invoke(app, ["audits", "context-show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "review" in result.stderr, "a retained page with markers must still say review"
    assert "still used" in result.stderr
    assert "1500 chars" in result.stderr
    assert "instructions to an AI" in result.stderr


@respx.mock
def test_context_show_does_not_claim_a_blocked_page_is_used(logged_in, runner):
    """`blocked` is the one status that overrides a retained snapshot: the guard
    refused the URL, so it is not in the prompt and must not read as though it is."""
    ctx = json.loads(json.dumps(_CTX_PENDING))
    ctx["sources"][0].update(status="blocked", chars=900, error_detail="private address")
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(return_value=httpx.Response(200, json=ctx))
    result = runner.invoke(app, ["audits", "context-show", "nightly-prod"])
    assert result.exit_code == 0, result.output
    assert "blocked" in result.stderr
    assert "still used" not in result.stderr
    assert "private address" in result.stderr


@respx.mock
def test_context_set_text_only_preserves_existing_urls(logged_in, runner):
    """`--text` alone used to send `"urls": []`, deleting every reference page and
    its snapshot — while the brief was read-merged three lines away."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json=_CTX_PENDING))
    put = respx.put(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json={"id": "au1", "sources": 1, "queued": 0}))
    result = runner.invoke(app, ["--json", "audits", "context-set", "nightly-prod",
                                 "--text", "new brief"])
    assert result.exit_code == 0, result.output
    sent = json.loads(put.calls[0].request.content)
    assert sent["text"] == "new brief"
    assert sent["urls"] == [_DOC_URL], "URLs must survive a --text edit"


@respx.mock
def test_context_set_url_only_preserves_the_brief(logged_in, runner):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json=_CTX_PENDING))
    put = respx.put(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json={"id": "au1", "sources": 1, "queued": 1}))
    other = "https://docs.example.com/other"
    result = runner.invoke(app, ["--json", "audits", "context-set", "nightly-prod",
                                 "--url", other])
    assert result.exit_code == 0, result.output
    sent = json.loads(put.calls[0].request.content)
    assert sent["text"] == _CTX_PENDING["text"]
    assert sent["urls"] == [other]


@respx.mock
def test_context_set_clear_urls_sends_an_empty_list(logged_in, runner):
    """Removal has to stay expressible — it is now explicit rather than implied."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json=_CTX_PENDING))
    put = respx.put(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json={"id": "au1", "sources": 0, "queued": 0}))
    result = runner.invoke(app, ["--json", "audits", "context-set", "nightly-prod",
                                 "--clear-urls"])
    assert result.exit_code == 0, result.output
    assert json.loads(put.calls[0].request.content)["urls"] == []


@respx.mock
def test_context_set_rejects_url_and_clear_urls_together(logged_in, runner):
    result = runner.invoke(app, ["--json", "audits", "context-set", "nightly-prod",
                                 "--url", _DOC_URL, "--clear-urls"])
    assert result.exit_code == 2, result.output


# --- audits: reference-context telemetry ---
#
# These pin the emitted PROPERTY NAMES, which nothing else does: the CLI sent this
# count as `count` while the dashboard sent `url_count`, so one event carried two
# names and neither answered "how much context is being attached?" on its own.
# They assert what actually leaves `record_action`, because it filters through the
# `_SAFE_PROP_KEYS` allowlist (`commands/_write.py`) first — a property missing from
# that list is dropped with no error, so a rename that forgets its allowlist entry
# reads as correct at the call site and silently emits nothing.


@pytest.fixture
def emitted(monkeypatch):
    """Every ``(event, properties)`` the command sends, as the allowlist leaves it."""
    events = []
    monkeypatch.setattr(
        analytics, "capture",
        lambda event, properties=None: events.append((event, properties or {})),
    )
    return events


def _props(emitted, event: str) -> dict:
    """The one ``event``'s properties — failing if it did not fire exactly once."""
    matches = [props for name, props in emitted if name == event]
    assert len(matches) == 1, f"expected one {event}, got {[name for name, _ in emitted]}"
    return matches[0]


@respx.mock
def test_context_set_emits_url_count(logged_in, runner, emitted):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.get(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json=_CTX_PENDING))
    respx.put(f"{BASE}/api/audits/au1/context").mock(
        return_value=httpx.Response(200, json={"id": "au1", "sources": 2, "queued": 2}))
    result = runner.invoke(app, ["--json", "audits", "context-set", "nightly-prod",
                                 "--url", _DOC_URL, "--url", "https://docs.example.com/slo"])
    assert result.exit_code == 0, result.output
    props = _props(emitted, "audit_context_saved")
    assert props["url_count"] == 2
    assert "count" not in props, "the dashboard's name for this is url_count — one series, one name"
    assert props["via"] == "cli"


@respx.mock
def test_audits_create_with_context_emits_url_count(logged_in, runner, emitted):
    """The second call site of the same event: context attached at creation."""
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[]))
    respx.post(f"{BASE}/api/audits").mock(
        return_value=httpx.Response(201, json={"id": "au9", "created_at": "t", "sources": 1}))
    result = runner.invoke(app, ["--json", "audits", "create", "nightly-prod",
                                 "--text", "checkout agent", "--url", _DOC_URL])
    assert result.exit_code == 0, result.output
    props = _props(emitted, "audit_context_saved")
    assert props["url_count"] == 1 and "count" not in props


@respx.mock
def test_context_refresh_emits_url_count(logged_in, runner, emitted):
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    respx.post(f"{BASE}/api/audits/au1/context/refresh").mock(
        return_value=httpx.Response(200, json={"queued": 3, "skipped": 1}))
    result = runner.invoke(app, ["--json", "audits", "context-refresh", "nightly-prod"])
    assert result.exit_code == 0, result.output
    props = _props(emitted, "audit_context_refreshed")
    assert props["url_count"] == 3 and "count" not in props


@respx.mock
def test_edit_from_show_json_round_trips(logged_in, runner, tmp_path):
    """`audits show --json` emits every field, including the two the definition
    endpoint 422s. Feeding that straight back is the documented workflow, so the
    read-only keys are stripped client-side."""
    shown = dict(_FULL_AUDIT, additional_context="a brief", reference_url_count=2, run_count=9)
    f = tmp_path / "audit.json"
    f.write_text(json.dumps(shown))
    respx.get(f"{BASE}/api/audits").mock(return_value=httpx.Response(200, json=[_FULL_AUDIT]))
    put = respx.put(f"{BASE}/api/audits/au1").mock(
        return_value=httpx.Response(200, json=_FULL_AUDIT))
    result = runner.invoke(app, ["--json", "audits", "edit", "nightly-prod", "--file", str(f)])
    assert result.exit_code == 0, result.output
    sent = json.loads(put.calls[0].request.content)
    for banned in ("additional_context", "reference_url_count", "run_count", "id", "open_findings"):
        assert banned not in sent, f"{banned} must not reach the definition endpoint"
    assert sent["name"] == "nightly-prod"
