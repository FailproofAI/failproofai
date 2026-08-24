"""Read/query completion: errors, eval-aggregate, events filters."""

from __future__ import annotations

import json

import httpx
import respx

from fp_cli.app import app

BASE = "http://dash.test"


@respx.mock
def test_errors_aggregate_json(logged_in, runner):
    respx.get(f"{BASE}/api/events/error_summary").mock(
        return_value=httpx.Response(
            200,
            json={"total": 5, "sessions": 2, "agents": 1, "last_ts": "2026-01-01T00:00:00Z", "bins": [1, 2]},
        )
    )
    result = runner.invoke(app, ["--json", "errors", "--aggregate", "--since", "24h"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["total"] == 5


@respx.mock
def test_errors_aggregate_card(logged_in, runner):
    respx.get(f"{BASE}/api/events/error_summary").mock(
        return_value=httpx.Response(
            200, json={"total": 66, "sessions": 62, "agents": 6, "last_ts": "2026-01-01T00:00:00Z", "bins": []}
        )
    )
    result = runner.invoke(app, ["errors", "--aggregate", "--since", "24h"])
    assert result.exit_code == 0, result.output
    assert "errors-aggregate" in result.stdout and "66" in result.stdout
    assert "errored events" in result.stdout and "62 sessions" in result.stdout


@respx.mock
def test_errors_list_fetches_errored_events(logged_in, runner):
    # errors now reads the LIGHT, payload-free feed (/api/events/summary) — server-computed
    # `summary`/`is_error`, no payload.
    route = respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {"id": 1, "session_id": "sess-1", "agent_id": "a", "event_type": "error", "ts": "t",
                     "environment": "prod", "summary": "TimeoutError: upstream timed out",
                     "is_error": True, "error_type": "TimeoutError", "output_tokens": None}
                ],
                "next_cursor": None,
            },
        )
    )
    # bare `errors` now LISTS errored events (errored=true), not the summary
    result = runner.invoke(app, ["--json", "errors", "--search", "boom", "--search", "oops", "--error-type", "TimeoutError"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["errors"][0]["event_type"] == "error"   # keyed under "errors", light rows
    assert data["errors"][0]["summary"] == "TimeoutError: upstream timed out"  # server summary, no payload
    assert "payload" not in data["errors"][0] or not data["errors"][0]["payload"]  # never the fat column
    params = route.calls.last.request.url.params
    assert params["errored"] == "true"
    assert params["error_type"] == "TimeoutError"
    assert params.get_list("search") == ["boom", "oops"]  # repeated free-text params


@respx.mock
def test_errors_list_table(logged_in, runner):
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {"id": 1, "session_id": "sess-20260622-4b90b240", "agent_id": "agent-orderbot",
                     "event_type": "error", "ts": "2026-06-22T17:51:34Z",
                     "summary": "RateLimitError: upstream timed out", "is_error": True,
                     "error_type": "RateLimitError", "output_tokens": None, "environment": "prod"}
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["errors", "--since", "24h"])
    assert result.exit_code == 0, result.output
    # the 80-col CliRunner truncates cells; just assert the error-themed box rendered
    assert "errors" in result.stdout and "newest first" in result.stdout


@respx.mock
def test_evals_aggregate_json(logged_in, runner):
    route = respx.get(f"{BASE}/api/evaluations/aggregate").mock(
        return_value=httpx.Response(
            200,
            json={
                "total": 10,
                "status_counts": {"done": 8, "error": 1, "timeout": 1},
                "score_stats": [{"key": "helpfulness", "count": 8, "avg": 0.7, "min": 0.1, "max": 1.0, "p50": 0.75}],
                "timeline": {"bucket_unit": "hour", "from": None, "to": "t", "points": []},
            },
        )
    )
    result = runner.invoke(app, ["--json", "evals", "--aggregate", "--since", "7d", "--env", "prod"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["status_counts"]["done"] == 8
    assert data["score_stats"][0]["key"] == "helpfulness"
    assert route.calls.last.request.url.params["environment"] == "prod"  # filters thread through


@respx.mock
def test_evals_aggregate_table(logged_in, runner):
    respx.get(f"{BASE}/api/evaluations/aggregate").mock(
        return_value=httpx.Response(
            200,
            json={
                "total": 10,
                "status_counts": {"done": 8, "error": 2, "timeout": 0},
                "score_stats": [{"key": "helpfulness", "count": 8, "avg": 0.66, "min": 0.1, "max": 1.0, "p50": 0.6}],
                "timeline": {"bucket_unit": "hour", "from": None, "to": "t", "points": []},
            },
        )
    )
    result = runner.invoke(app, ["evals", "--aggregate", "--since", "7d"])
    assert result.exit_code == 0, result.output
    # totals card + score-stats panel
    assert "eval-aggregate" in result.stdout and "evals" in result.stdout
    assert "success rate" in result.stdout
    assert "score stats" in result.stdout and "helpfulness" in result.stdout


@respx.mock
def test_events_filters_threaded(logged_in, runner):
    # A broad events read (no --session-id/--full) uses the light feed.
    route = respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None})
    )
    result = runner.invoke(
        app,
        ["--json", "events", "--env", "prod,staging", "--event-type", "tool_use,tool_result", "--order", "asc"],
    )
    assert result.exit_code == 0, result.output
    params = route.calls.last.request.url.params
    assert params["environment"] == "prod,staging"
    assert params["event_type"] == "tool_use,tool_result"
    assert params["order"] == "asc"


def test_events_bad_order_usage_error(logged_in, runner):
    result = runner.invoke(app, ["events", "--order", "sideways"])
    assert result.exit_code == 2


def test_events_nonpositive_limit_usage_error(logged_in, runner):
    # --limit 0 / negative is rejected client-side (not passed through to the server).
    assert runner.invoke(app, ["events", "--limit", "0"]).exit_code == 2
    assert runner.invoke(app, ["events", "-n", "-5"]).exit_code == 2


def test_sessions_nonpositive_limit_usage_error(logged_in, runner):
    assert runner.invoke(app, ["sessions", "--limit", "0"]).exit_code == 2
    assert runner.invoke(app, ["sessions", "-n", "-5"]).exit_code == 2


def test_sessions_nonpositive_limit_usage_error(logged_in, runner):
    assert runner.invoke(app, ["sessions", "--limit", "0"]).exit_code == 2
    assert runner.invoke(app, ["sessions", "-n", "-5"]).exit_code == 2
