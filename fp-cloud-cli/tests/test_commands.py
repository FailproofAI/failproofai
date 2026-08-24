from __future__ import annotations

import json

import httpx
import respx

from fp_cli import config
from fp_cli.app import app

BASE = "http://dash.test"


# --- auth commands ----------------------------------------------------------


@respx.mock
def test_login_flow_persists_token(home, runner):
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-xyz; Path=/"},
        )
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().session_token == "tok-xyz"


@respx.mock
def test_login_insecure_persists_flag(home, runner):
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-xyz; Path=/"},
        )
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "--insecure", "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    saved = config.load_config()
    assert saved.session_token == "tok-xyz"
    assert saved.insecure is True  # remembered, so later commands skip TLS verification too


def _seed_valid_session() -> None:
    config.save_config(
        config.CliConfig(
            base_url=BASE,
            session_token="existing",
            expires_at="2099-01-01T00:00:00Z",
            email="me@test",
            user_id="u1",
            org="acme",
        )
    )


@respx.mock
def test_login_already_signed_in_short_circuits(home, runner):
    _seed_valid_session()
    req = respx.post(f"{BASE}/api/auth/otp/request").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = runner.invoke(app, ["--base-url", BASE, "login"])
    assert result.exit_code == 0, result.output
    assert "already signed in" in (result.stderr or "")
    assert not req.called  # short-circuited — no code requested
    assert config.load_config().session_token == "existing"  # session untouched


@respx.mock
def test_login_json_already_signed_in(home, runner):
    _seed_valid_session()
    result = runner.invoke(app, ["--base-url", BASE, "--json", "login"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload == {
        "logged_in": True,
        "email": "me@test",
        "org": "acme",
        "already_signed_in": True,
    }


@respx.mock
def test_login_force_reauthenticates_when_signed_in(home, runner):
    _seed_valid_session()
    req = respx.post(f"{BASE}/api/auth/otp/request").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=newtok; Path=/"},
        )
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--force", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert req.called  # --force bypassed the short-circuit and re-authenticated
    assert config.load_config().session_token == "newtok"


@respx.mock
def test_login_expired_session_proceeds(home, runner):
    config.save_config(
        config.CliConfig(
            base_url=BASE,
            session_token="oldtok",
            expires_at="2020-01-01T00:00:00Z",  # expired
            email="me@test",
        )
    )
    req = respx.post(f"{BASE}/api/auth/otp/request").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=freshtok; Path=/"},
        )
    )
    result = runner.invoke(app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n")
    assert result.exit_code == 0, result.output
    assert req.called  # expired → login proceeds normally
    assert config.load_config().session_token == "freshtok"


@respx.mock
def test_secure_flag_overrides_saved_insecure(home, runner):
    # Saved config has insecure=True; an explicit --secure must turn verification back on.
    config.save_config(config.CliConfig(base_url=BASE, insecure=True))
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok; Path=/"},
        )
    )
    result = runner.invoke(app, ["--secure", "login", "--email", "me@test"], input="123456\n")
    assert result.exit_code == 0, result.output
    assert config.load_config().insecure is False  # explicit --secure beat the stored True


@respx.mock
def test_logout_clears_token(logged_in, runner):
    respx.post(f"{BASE}/api/auth/logout").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["logout"])
    assert result.exit_code == 0
    assert config.load_config().session_token is None


@respx.mock
def test_whoami_json(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json={"id": "u1", "email": "me@test", "permissions": ["events:read"]})
    )
    result = runner.invoke(app, ["--json", "whoami"])
    assert result.exit_code == 0
    assert json.loads(result.stdout)["email"] == "me@test"


def test_whoami_not_logged_in(home, runner):
    result = runner.invoke(app, ["--json", "whoami"])
    assert result.exit_code == 0
    assert json.loads(result.stdout)["logged_in"] is False


# --- exit-code contract -----------------------------------------------------


def test_not_logged_in_exits_4(home, runner):
    # URL is set (via flag); the missing token is what triggers exit 4.
    result = runner.invoke(app, ["--base-url", BASE, "events"])
    assert result.exit_code == 4


def test_no_base_url_defaults_to_hosted(home, runner):
    # No --base-url, no env, no saved config -> the CLI defaults to the hosted
    # dashboard (config.DEFAULT_BASE_URL) rather than erroring. With no token it
    # then fails on auth (exit 4, "not signed in"), NOT a usage error (exit 2)
    # about a missing URL. This pins that the default kicks in.
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 4


def test_default_base_url_is_the_hosted_product():
    # The default the CLI falls back to is the hosted dashboard.
    from fp_cli import config
    from fp_cli._context import AppState, resolved_base_url

    assert config.DEFAULT_BASE_URL == "https://app.befailproof.ai"
    # An AppState with no URL resolves to that default.
    state = AppState(json=False, base_url=None, token=None, timeout=30.0, config=config.CliConfig())
    assert resolved_base_url(state) == config.DEFAULT_BASE_URL


@respx.mock
def test_forbidden_exits_5(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"})
    )
    result = runner.invoke(app, ["users", "list"])
    assert result.exit_code == 5


@respx.mock
def test_network_error_exits_3(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(side_effect=httpx.ConnectError("down"))
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 3


def test_bad_since_is_usage_error(logged_in, runner):
    result = runner.invoke(app, ["events", "--since", "bogus"])
    assert result.exit_code == 2  # click usage error


# --- query commands ---------------------------------------------------------


@respx.mock
def test_events_json(logged_in, runner):
    # --session-id stays on the light feed (payload is a deliberate --full opt-in).
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {
                        "id": 1,
                        "session_id": "s",
                        "agent_id": "a",
                        "event_type": "tool_use",
                        "ts": "t",
                        "summary": "slack.post",
                        "environment": "prod",
                    }
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["--json", "events", "--session-id", "s"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["events"][0]["event_type"] == "tool_use"


@respx.mock
def test_events_all_paginates(logged_in, runner):
    respx.get(f"{BASE}/api/events/summary").mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "events": [
                        {"id": 3, "session_id": "s", "agent_id": "a", "event_type": "e", "ts": "t", "payload": {}, "environment": "p"},
                        {"id": 2, "session_id": "s", "agent_id": "a", "event_type": "e", "ts": "t", "payload": {}, "environment": "p"},
                    ],
                    "next_cursor": 2,
                },
            ),
            httpx.Response(
                200,
                json={
                    "events": [
                        {"id": 1, "session_id": "s", "agent_id": "a", "event_type": "e", "ts": "t", "payload": {}, "environment": "p"}
                    ],
                    "next_cursor": None,
                },
            ),
        ]
    )
    result = runner.invoke(app, ["--json", "events", "--all", "--limit", "100"])
    assert result.exit_code == 0, result.output
    assert len(json.loads(result.stdout)["events"]) == 3


@respx.mock
def test_events_feed_routing(logged_in, runner):
    """Default → light feed (payload-free); --full / --fields payload / --session-id → full feed."""
    resp = httpx.Response(200, json={"events": [], "next_cursor": None})
    light = respx.get(f"{BASE}/api/events/summary").mock(return_value=resp)
    full = respx.get(f"{BASE}/api/events").mock(return_value=resp)

    def counts():
        return light.call_count, full.call_count

    l, f = counts()
    # bare / broad → light, never full
    assert runner.invoke(app, ["--json", "events", "--env", "prod"]).exit_code == 0
    assert counts() == (l + 1, f); l, f = counts()

    # explicit --full → full
    assert runner.invoke(app, ["--json", "events", "--full"]).exit_code == 0
    assert counts() == (l, f + 1); l, f = counts()

    # --fields payload (payload requested) → full
    assert runner.invoke(app, ["--json", "events", "--fields", "id,payload"]).exit_code == 0
    assert counts() == (l, f + 1); l, f = counts()

    # --session-id stays on the LIGHT feed (fast session timeline; payload is a --full opt-in)
    assert runner.invoke(app, ["--json", "events", "--session-id", "run-1"]).exit_code == 0
    assert counts() == (l + 1, f); l, f = counts()

    # --full + --session-id → full (bounded raw-payload read)
    assert runner.invoke(app, ["--json", "events", "--full", "--session-id", "run-1"]).exit_code == 0
    assert counts() == (l, f + 1); l, f = counts()

    # --fields summary (light-only field) stays on the light feed
    assert runner.invoke(app, ["--json", "events", "--fields", "id,summary"]).exit_code == 0
    assert counts() == (l + 1, f)


@respx.mock
def test_events_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # A filtered run that matches nothing exits 0 (not an error) and nudges the user to
    # re-check the value, pointing at the facet that lists valid values.
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["events", "--env", "xyz"])
    assert result.exit_code == 0, result.output
    assert "no events match these filters" in result.output  # the box (stdout)
    assert "double-check" in result.stderr
    assert "--env" in result.stderr
    assert "fp list envs" in result.stderr  # facet discovery hint


@respx.mock
def test_events_empty_no_filter_no_hint(logged_in, runner):
    # A bare run with 0 rows is a genuinely empty window, not a typo — no recheck nudge.
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["events"])
    assert result.exit_code == 0, result.output
    assert "no events in this window" in result.output
    assert "double-check" not in result.stderr


@respx.mock
def test_events_empty_json_has_no_hint(logged_in, runner):
    # --json stays clean: the recheck nudge is stderr chrome, never on the JSON stdout.
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["--json", "events", "--env", "xyz"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"events": [], "next_cursor": None}
    assert "double-check" not in result.stderr


@respx.mock
def test_sessions_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # Same 0-result nudge on sessions: filtered run matching nothing exits 0 + names filters.
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["sessions", "--env", "xyz"])
    assert result.exit_code == 0, result.output
    assert "no sessions match these filters" in result.output  # the box (stdout)
    assert "double-check" in result.stderr
    assert "--env" in result.stderr
    assert "fp list envs" in result.stderr  # facet discovery hint


@respx.mock
def test_sessions_empty_no_filter_no_hint(logged_in, runner):
    # A bare run with 0 rows is a genuinely empty result, not a typo — no recheck nudge.
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 0, result.output
    assert "no sessions" in result.output
    assert "double-check" not in result.stderr


@respx.mock
def test_evals_list_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # Same 0-result nudge on evals list mode.
    respx.get(f"{BASE}/api/evaluations").mock(
        return_value=httpx.Response(200, json={"evaluations": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["evals", "--env", "xyz"])
    assert result.exit_code == 0, result.output
    assert "no evals match these filters" in result.output
    assert "double-check" in result.stderr
    assert "fp list envs" in result.stderr


@respx.mock
def test_evals_aggregate_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # The nudge also fires in aggregate mode when the slice is empty (total 0).
    respx.get(f"{BASE}/api/evaluations/aggregate").mock(
        return_value=httpx.Response(
            200,
            json={"total": 0, "status_counts": {"done": 0, "error": 0, "timeout": 0},
                  "score_stats": [], "timeline": []},
        )
    )
    result = runner.invoke(app, ["evals", "--aggregate", "--agent-id", "nope"])
    assert result.exit_code == 0, result.output
    assert "double-check" in result.stderr
    assert "--agent-id" in result.stderr
    assert "fp list agents" in result.stderr


@respx.mock
def test_evals_aggregate_nonempty_no_hint(logged_in, runner):
    # A non-empty aggregate (total > 0) never shows the recheck nudge.
    respx.get(f"{BASE}/api/evaluations/aggregate").mock(
        return_value=httpx.Response(
            200,
            json={"total": 5, "status_counts": {"done": 5, "error": 0, "timeout": 0},
                  "score_stats": [], "timeline": []},
        )
    )
    result = runner.invoke(app, ["evals", "--aggregate", "--env", "prod"])
    assert result.exit_code == 0, result.output
    assert "double-check" not in result.stderr


@respx.mock
def test_errors_list_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # Same 0-result nudge on errors list mode; --error-type maps to its own facet.
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(200, json={"events": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["errors", "--error-type", "NopeError"])
    assert result.exit_code == 0, result.output
    assert "no errors match these filters" in result.output
    assert "double-check" in result.stderr
    assert "fp list error_types" in result.stderr


@respx.mock
def test_errors_aggregate_empty_with_filter_shows_recheck_hint(logged_in, runner):
    # Aggregate 0-total with an active filter shows the nudge under the "no errors found" card.
    respx.get(f"{BASE}/api/events/error_summary").mock(
        return_value=httpx.Response(
            200, json={"total": 0, "sessions": 0, "agents": 0, "last_ts": None, "bins": []}
        )
    )
    result = runner.invoke(app, ["errors", "--aggregate", "--env", "xyz"])
    assert result.exit_code == 0, result.output
    assert "no errors found" in result.output  # the card stays
    assert "double-check" in result.stderr
    assert "fp list envs" in result.stderr


@respx.mock
def test_errors_aggregate_no_filter_no_hint(logged_in, runner):
    # 0 errors with NO filter is genuinely clean — celebrate, don't nag.
    respx.get(f"{BASE}/api/events/error_summary").mock(
        return_value=httpx.Response(
            200, json={"total": 0, "sessions": 0, "agents": 0, "last_ts": None, "bins": []}
        )
    )
    result = runner.invoke(app, ["errors", "--aggregate"])
    assert result.exit_code == 0, result.output
    assert "no errors found" in result.output
    assert "double-check" not in result.stderr


@respx.mock
def test_evals_score_filters(logged_in, runner):
    route = respx.get(f"{BASE}/api/evaluations").mock(
        return_value=httpx.Response(200, json={"evaluations": [], "next_cursor": None})
    )
    result = runner.invoke(
        app,
        ["--json", "evals", "--score", "helpfulness:0.5..0.8", "--score", "x:..0.3"],
    )
    assert result.exit_code == 0, result.output
    params = route.calls.last.request.url.params
    assert params["score_filters"] == "helpfulness:0.5..0.8,x:..0.3"


def test_sessions_has_no_score_option(logged_in, runner):
    # `--score` moved to `evals`; sessions must reject it (scores live on evals now).
    assert runner.invoke(app, ["sessions", "--score", "helpfulness:..0.5"]).exit_code == 2


@respx.mock
def test_sessions_table(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(
            200,
            json={
                "sessions": [
                    {
                        "session_id": "s",
                        "agent_id": "a",
                        "environment": "prod",
                        "event_count": 5,
                        "started_at": "2026-06-22T12:00:00Z",
                        "last_event_at": "2026-06-22T12:05:00Z",
                        "latest_evaluation": {
                            "evaluation_id": "e1",
                            "status": "done",
                            "scores": {"helpfulness": 0.9},
                        },
                    }
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 0, result.output
    assert "sessions" in result.stdout  # the boxed panel title
    assert "done" in result.stdout  # status flattened up from latest_evaluation


@respx.mock
def test_sessions_json_flattens_status_and_scores(logged_in, runner):
    # Flattening: status/scores are lifted to the top level of each row for back-compat,
    # while the full evaluation stays under `latest_evaluation`.
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(
            200,
            json={
                "sessions": [
                    {
                        "session_id": "s",
                        "agent_id": "a",
                        "environment": "prod",
                        "last_event_at": "2026-06-22T12:05:00Z",
                        "latest_evaluation": {"status": "error", "scores": {"x": 0.5}},
                    }
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["--json", "sessions"])
    assert result.exit_code == 0, result.output
    row = json.loads(result.stdout)["sessions"][0]
    assert row["status"] == "error"  # flattened to top level
    assert row["scores"] == {"x": 0.5}  # flattened to top level
    assert row["latest_evaluation"]["status"] == "error"  # nested source preserved


# ── multi-agent roster (agents column) ─────────────────────────────────────

_MULTI_AGENT_SESSION = {
    "session_id": "s", "agent_id": "agent-codegen", "environment": "dev",
    "last_event_at": "2026-07-16T12:05:00Z",
    "agents": [
        {"agent_id": "agent-codegen", "event_count": 52},
        {"agent_id": "agent-linter", "event_count": 18},
        {"agent_id": "agent-testgen", "event_count": 9},
    ],
    "latest_evaluation": None,
}


@respx.mock
def test_sessions_json_includes_agents_roster(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [_MULTI_AGENT_SESSION], "next_cursor": None})
    )
    result = runner.invoke(app, ["--json", "sessions"])
    assert result.exit_code == 0, result.output
    row = json.loads(result.stdout)["sessions"][0]
    # the full nested roster (agent_id + event_count) is carried through verbatim
    assert row["agents"] == _MULTI_AGENT_SESSION["agents"]


@respx.mock
def test_sessions_table_badges_multi_agent(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [_MULTI_AGENT_SESSION], "next_cursor": None})
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 0, result.output
    assert "+2" in result.stdout                            # 3 agents → +2 badge
    assert "1 multi-agent" in result.stderr                 # footer count
    assert "fp sessions --agents" in result.stderr    # footer hint


@respx.mock
def test_sessions_agents_flag_expands_roster(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [_MULTI_AGENT_SESSION], "next_cursor": None})
    )
    result = runner.invoke(app, ["sessions", "--agents"])
    assert result.exit_code == 0, result.output
    # the roster is expanded → the other agents' names + event counts are now visible
    assert "agent-linter" in result.stdout and "agent-testgen" in result.stdout
    assert "18 ev" in result.stdout


@respx.mock
def test_sessions_single_agent_no_badge(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={
            "sessions": [{
                "session_id": "s", "agent_id": "solo", "environment": "dev",
                "last_event_at": "2026-07-16T12:05:00Z",
                "agents": [{"agent_id": "solo", "event_count": 5}],
                "latest_evaluation": None,
            }],
            "next_cursor": None,
        })
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 0, result.output
    assert "+" not in result.stdout                 # single agent → no badge
    assert "multi-agent" not in result.stderr       # footer omits the segment


@respx.mock
def test_sessions_unevaluated_row_blank_status(logged_in, runner):
    # A session never evaluated → latest_evaluation null → blank status (no crash).
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(
            200,
            json={
                "sessions": [
                    {
                        "session_id": "s",
                        "agent_id": "a",
                        "environment": "prod",
                        "last_event_at": "2026-06-22T12:05:00Z",
                        "latest_evaluation": None,
                    }
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["--json", "sessions"])
    assert result.exit_code == 0, result.output
    row = json.loads(result.stdout)["sessions"][0]
    assert row["status"] == ""
    assert row["scores"] is None
    assert row["latest_evaluation"] is None


def test_version_command(home, runner):
    from fp_cli import __version__

    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout  # shown in the branded box


def test_version_json_global_form(home, runner):
    # JSON via the GLOBAL --json (before the command), per the global option format.
    from fp_cli import __version__

    result = runner.invoke(app, ["--json", "version"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"version": __version__}


def test_version_json_after_command_is_rejected(home, runner):
    # `--json` AFTER the command is NOT accepted — globals come before (usage error).
    result = runner.invoke(app, ["version", "--json"])
    assert result.exit_code == 2


def test_help_command(home, runner):
    result = runner.invoke(app, ["help"])
    assert result.exit_code == 0
    out = result.stdout
    assert "Commands" in out  # the grouped top-level panel
    # the four purpose groups, in order
    for g in ("ESSENTIALS", "OBSERVE", "MANAGE", "TOOLS"):
        assert g in out
    assert out.index("ESSENTIALS") < out.index("OBSERVE") < out.index("MANAGE") < out.index("TOOLS")
    assert "sessions" in out and "EXAMPLES" in out


def test_insecure_threads_verify_into_client_context():
    from fp_cli._context import AppState, build_context, require_auth

    cfg = config.CliConfig(base_url=BASE, session_token="t", expires_at="2999-01-01T00:00:00Z")
    insecure = AppState(json=False, base_url=BASE, token="t", timeout=30.0, config=cfg, insecure=True)
    assert require_auth(insecure).verify is False
    assert build_context(insecure).verify is False

    secure = AppState(json=False, base_url=BASE, token="t", timeout=30.0, config=cfg, insecure=False)
    assert require_auth(secure).verify is True


# --- new filters, --fields projection, and -h -------------------------------


@respx.mock
def test_evals_agent_id_and_score_filters(logged_in, runner):
    route = respx.get(f"{BASE}/api/evaluations").mock(
        return_value=httpx.Response(200, json={"evaluations": [], "next_cursor": None})
    )
    result = runner.invoke(
        app, ["--json", "evals", "--agent-id", "bot-1", "--score", "helpfulness:..0.5"]
    )
    assert result.exit_code == 0, result.output
    params = route.calls.last.request.url.params
    assert params["agent_id"] == "bot-1"
    assert params["score_filters"] == "helpfulness:..0.5"
    assert "latest_per_session" not in params  # not deduped


@respx.mock
def test_fields_projection_json(logged_in, runner):
    # --fields without `payload` stays on the light feed.
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {"id": 1, "session_id": "s", "agent_id": "a", "event_type": "tool_use", "ts": "t", "summary": "slack.post", "environment": "prod"}
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["--json", "events", "--fields", "id,event_type"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["events"][0] == {"id": 1, "event_type": "tool_use"}


def test_fields_unknown_is_usage_error(logged_in, runner):
    result = runner.invoke(app, ["--json", "events", "--fields", "bogus"])
    assert result.exit_code == 2  # BadParameter lists the valid fields


def test_dash_h_alias_shows_help(home, runner):
    result = runner.invoke(app, ["-h"])
    assert result.exit_code == 0
    assert "Commands" in result.stdout and "sessions" in result.stdout
    assert "ESSENTIALS" in result.stdout  # the grouped top-level help, via the rich_format_help override


def test_subcommand_dash_h(home, runner):
    result = runner.invoke(app, ["events", "-h"])
    assert result.exit_code == 0
    assert "--fields" in result.stdout


@respx.mock
def test_all_reports_a_resumable_cursor_when_it_stops_on_the_limit(logged_in, runner):
    """`--all` truncated silently and then asserted it had not.

    `--limit` defaults to 50, so `fp --json events --session-id X --all` — the
    exact line the docs give for reading a whole session — made ONE request,
    returned 50 rows out of however many exist, and emitted
    `"next_cursor": null`, which positively states the feed is exhausted. A
    script or an agent reading that JSON concludes the session had 50 events and
    has nothing to resume from. The CLI had the live cursor in hand at that
    moment and threw it away.
    """
    def handler(request):
        limit = int(dict(request.url.params).get("limit", 50))
        return httpx.Response(
            200,
            json={
                "events": [
                    {"id": i, "session_id": "s", "agent_id": "a", "event_type": "e",
                     "ts": "t", "environment": "p"}
                    for i in range(limit)
                ],
                "next_cursor": "more-to-come",
            },
        )

    route = respx.get(f"{BASE}/api/events/summary").mock(side_effect=handler)
    result = runner.invoke(app, ["--json", "events", "--session-id", "run-001", "--all"])

    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert len(body["events"]) == 50
    assert route.call_count == 1
    assert body["next_cursor"] == "more-to-come", (
        "a walk that stopped on --limit must hand back somewhere to resume, not null"
    )


@respx.mock
def test_all_reports_no_cursor_when_the_feed_really_is_exhausted(logged_in, runner):
    """The other half: a complete walk must still say so."""
    respx.get(f"{BASE}/api/events/summary").mock(
        return_value=httpx.Response(
            200,
            json={
                "events": [
                    {"id": 1, "session_id": "s", "agent_id": "a", "event_type": "e",
                     "ts": "t", "environment": "p"}
                ],
                "next_cursor": None,
            },
        )
    )
    result = runner.invoke(app, ["--json", "events", "--all", "--limit", "100"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert len(body["events"]) == 1
    assert body["next_cursor"] is None
