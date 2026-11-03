"""Multi-value option support.

Covers the reusable `collect_multi` normalizer (repeated flags + comma-separated → one
flat, trimmed, de-duped, order-preserving list) and its end-to-end wiring on the `events`
command's `--session-id` / `--env` / `--event-type` / `--agent-id` filters (each serialized
to a CSV `IN(...)` on the wire, single value back-compatible).
"""

from __future__ import annotations

import httpx
import respx

from fp_cli._context import collect_multi
from fp_cli.app import app

BASE = "http://dash.test"


# --- the pure normalizer ----------------------------------------------------


def test_collect_multi_single_value():
    # Always an array internally, even for one value.
    assert collect_multi(["prod"]) == ["prod"]


def test_collect_multi_repeated_flags():
    assert collect_multi(["prod", "staging"]) == ["prod", "staging"]


def test_collect_multi_comma_separated():
    assert collect_multi(["prod,staging"]) == ["prod", "staging"]


def test_collect_multi_repeated_and_comma_combined():
    assert collect_multi(["prod,staging", "dev"]) == ["prod", "staging", "dev"]


def test_collect_multi_trims_whitespace():
    assert collect_multi(["prod, staging"]) == ["prod", "staging"]
    assert collect_multi([" prod ", " dev"]) == ["prod", "dev"]


def test_collect_multi_drops_empty_from_trailing_comma():
    assert collect_multi(["prod,"]) == ["prod"]
    assert collect_multi(["prod,,staging"]) == ["prod", "staging"]
    assert collect_multi([","]) is None


def test_collect_multi_dedup_preserves_first_seen_order():
    assert collect_multi(["prod", "prod"]) == ["prod"]
    assert collect_multi(["b", "a", "b", "c", "a"]) == ["b", "a", "c"]
    assert collect_multi(["prod,staging", "staging,prod"]) == ["prod", "staging"]


def test_collect_multi_empty_and_none():
    assert collect_multi(None) is None
    assert collect_multi([]) is None
    assert collect_multi(["", "  "]) is None


# --- end-to-end on the events command (what reaches the wire) ---------------


def _captured_params(logged_in, runner, argv):
    """Run `events` with argv and return the query params the CLI sent.

    `events` routes to the light feed (/api/events/summary) by default and to the full feed
    (/api/events) only when payload is needed (e.g. --session-id). Both accept the identical
    query surface, so mock BOTH and read params from whichever the CLI actually called.
    """
    resp = httpx.Response(200, json={"events": [], "next_cursor": None})
    light = respx.get(f"{BASE}/api/events/summary").mock(return_value=resp)
    full = respx.get(f"{BASE}/api/events").mock(return_value=resp)
    result = runner.invoke(app, argv)
    assert result.exit_code == 0, result.output
    route = full if full.called else light
    return dict(route.calls.last.request.url.params)


@respx.mock
def test_events_env_single_value_unchanged(logged_in, runner):
    # Backward compatibility: one value serializes to a bare `environment=prod`.
    params = _captured_params(logged_in, runner, ["events", "--env", "prod"])
    assert params["environment"] == "prod"


@respx.mock
def test_events_env_repeated_flags_merge(logged_in, runner):
    # The original failing case: repeated flags must keep BOTH, not last-wins.
    params = _captured_params(logged_in, runner, ["events", "--env", "prod", "--env", "staging"])
    assert params["environment"] == "prod,staging"


@respx.mock
def test_events_env_comma_separated(logged_in, runner):
    params = _captured_params(logged_in, runner, ["events", "--env", "prod,staging"])
    assert params["environment"] == "prod,staging"


@respx.mock
def test_events_env_combined_and_deduped(logged_in, runner):
    params = _captured_params(
        logged_in, runner, ["events", "--env", "prod,staging", "--env", "dev", "--env", "prod"]
    )
    assert params["environment"] == "prod,staging,dev"


@respx.mock
def test_events_all_four_filters_multi(logged_in, runner):
    # session-id / agent-id / event-type / env all become CSV IN(...) on the wire.
    params = _captured_params(
        logged_in,
        runner,
        [
            "events",
            "--session-id", "s1", "--session-id", "s2",
            "--agent-id", "a1,a2",
            "--event-type", "tool_use", "--event-type", "tool_result",
            "--env", "prod",
        ],
    )
    assert params["session_id"] == "s1,s2"
    assert params["agent_id"] == "a1,a2"
    assert params["event_type"] == "tool_use,tool_result"
    assert params["environment"] == "prod"


# --- end-to-end on the sessions command (/api/sessions) ---------------------


def _captured_session_params(logged_in, runner, argv):
    """Run `sessions` with argv and return the query params the CLI sent to /api/sessions."""
    route = respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    result = runner.invoke(app, argv)
    assert result.exit_code == 0, result.output
    return dict(route.calls.last.request.url.params)


@respx.mock
def test_sessions_status_repeated_flags_merge(logged_in, runner):
    # --status was the one that 400'd as multi-value on the old endpoint; now CSV IN.
    params = _captured_session_params(
        logged_in, runner, ["sessions", "--status", "error", "--status", "timeout"]
    )
    assert params["status"] == "error,timeout"


@respx.mock
def test_sessions_all_four_filters_multi(logged_in, runner):
    # env / status / agent-id / session-id all become CSV IN(...) on the wire.
    params = _captured_session_params(
        logged_in,
        runner,
        [
            "sessions",
            "--env", "prod,staging",
            "--status", "done", "--status", "error",
            "--agent-id", "a1", "--agent-id", "a2",
            "--session-id", "s1,s2",
        ],
    )
    assert params["environment"] == "prod,staging"
    assert params["status"] == "done,error"
    assert params["agent_id"] == "a1,a2"
    assert params["session_id"] == "s1,s2"


@respx.mock
def test_sessions_single_value_unchanged(logged_in, runner):
    # Backward compatibility: one value serializes to a bare param.
    params = _captured_session_params(logged_in, runner, ["sessions", "--env", "prod"])
    assert params["environment"] == "prod"


def test_sessions_bad_status_is_usage_error(logged_in, runner):
    # An invalid --status value is caught client-side (exit 2), not a server 400.
    assert runner.invoke(app, ["sessions", "--status", "bogus"]).exit_code == 2
    # ...even when mixed with a valid one.
    assert runner.invoke(app, ["sessions", "--status", "done,bogus"]).exit_code == 2
