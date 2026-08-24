from __future__ import annotations

import json

import httpx
import respx

from fp_cli.app import app

BASE = "http://dash.test"

USAGE = {
    "org_id": "00000000-0000-0000-0000-000000000001",
    "billing_anchor": "2026-07-15T00:00:00Z",
    "window": {
        "start": "2026-07-15T00:00:00Z",
        "end": "2026-08-14T00:00:00Z",
        "current": True,
    },
    "usage": {
        "events_ingested": 12840,
        "sessions": 146,
        "agents": 12,
        "environments": 3,
        "evaluation_runs": 84,
        "evaluation_finishes": 79,
        "evaluations": 420,
        "metrics": 1260,
        "queries_created": 31,
        "dashboards_created": 6,
        "alerts_created": 11,
        "issues_created": 34,
        "audit_runs": 18,
        "audit_finishes": 16,
        "keys_created": 5,
        "keys_active": 3,
        "users_created": 5,
        "users_active": 1,
    },
    "calculated_at": "2026-07-31T12:00:00Z",
    "stale_after": "2026-07-31T12:01:00Z",
}


@respx.mock
def test_usage_json_returns_dashboard_contract_unchanged(logged_in, runner):
    request = respx.get(f"{BASE}/api/usage").mock(
        return_value=httpx.Response(200, json=USAGE)
    )

    result = runner.invoke(app, ["--json", "usage"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == USAGE
    assert request.called


@respx.mock
def test_usage_human_output_is_grouped_and_readable(logged_in, runner):
    respx.get(f"{BASE}/api/usage").mock(return_value=httpx.Response(200, json=USAGE))

    result = runner.invoke(app, ["--no-color", "usage"])

    assert result.exit_code == 0, result.output
    assert "Jul 15, 2026" in result.stdout
    assert "12,840" in result.stdout
    assert "PIPELINE COMPLETION" in result.stdout
    assert "WORKSPACE & ACCESS" in result.stdout
    assert "94%" in result.stdout


@respx.mock
def test_usage_names_required_permission(logged_in, runner):
    respx.get(f"{BASE}/api/usage").mock(
        return_value=httpx.Response(
            403,
            json={"error": "forbidden", "required_permission": "usage:read"},
        )
    )

    result = runner.invoke(app, ["--json", "usage"])

    assert result.exit_code == 5
    assert json.loads(result.stdout)["error"] == "you don't have the usage:read permission"


@respx.mock
def test_usage_reports_missing_billing_date(logged_in, runner):
    respx.get(f"{BASE}/api/usage").mock(
        return_value=httpx.Response(404, json={"error": "billing date is not set"})
    )

    result = runner.invoke(app, ["--json", "usage"])

    assert result.exit_code == 6
    assert json.loads(result.stdout)["error"] == "billing date is not set"


@respx.mock
def test_usage_rejects_non_object_success_response(logged_in, runner):
    respx.get(f"{BASE}/api/usage").mock(return_value=httpx.Response(200, json=[]))

    result = runner.invoke(app, ["--json", "usage"])

    assert result.exit_code == 1
    assert json.loads(result.stdout)["error"] == "The dashboard returned an invalid usage response."


def test_usage_is_one_command_with_help_but_no_subcommands(home, runner):
    help_result = runner.invoke(app, ["usage", "--help"])
    assert help_result.exit_code == 0
    assert "current fixed 30-day metering window" in help_result.stdout

    child_result = runner.invoke(app, ["usage", "history"])
    assert child_result.exit_code == 2
