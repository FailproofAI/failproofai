"""Tests for the review-driven fixes: json-aware error contract, resolver, SQL detail,
NaN-safe JSON, markup-safe tables, settings int parsing, and the org-switch json path."""

from __future__ import annotations

import json
from types import SimpleNamespace

from fp_cli import _click_compat as click  # the Click Typer is running
import httpx
import pytest
import respx

from fp_cli import client, output
from fp_cli.app import app
from fp_cli.commands import _write
from fp_cli.errors import NotFoundError

BASE = "http://dash.test"


# --- json-aware error contract (envelope on stdout) ------------------------------


@respx.mock
def test_json_error_envelope_not_found(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["--json", "users", "show", "nobody@x.com"])
    assert result.exit_code == 6
    data = json.loads(result.stdout)  # must be a clean JSON object on stdout
    assert "nobody@x.com" in data["error"]
    assert data["exit_code"] == 6
    assert "hint" in data  # the "run `fp users list`" hint rides along


def test_json_error_envelope_usage(logged_in, runner):
    # A client-side validation error is ALSO a JSON envelope on stdout under --json.
    result = runner.invoke(app, ["--json", "sessions", "--since", "bogus"])
    assert result.exit_code == 2
    data = json.loads(result.stdout)
    assert data["exit_code"] == 2
    assert "since" in data["error"].lower()


@respx.mock
def test_json_error_envelope_carries_status_and_request_id(logged_in, runner):
    respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(500, json={"error": "boom"}, headers={"x-request-id": "req-123"})
    )
    result = runner.invoke(app, ["--json", "sessions"])
    assert result.exit_code == 1
    data = json.loads(result.stdout)
    assert data["error"] == "boom" and data["exit_code"] == 1 and data["status"] == 500
    assert data["request_id"] == "req-123"  # kept for server-log correlation
    assert "HTTP" not in data["error"]  # clean message; status is a separate field


def test_unknown_command_json_envelope_via_env(logged_in, runner):
    # An error raised BEFORE the group callback runs (unknown command) still honors --json via the
    # env fallback, so an agent that typos a command under --json gets a parseable error on stdout.
    result = runner.invoke(app, ["frobnicate"], env={"FP_JSON": "1"})
    assert result.exit_code == 2
    data = json.loads(result.stdout)
    assert "frobnicate" in data["error"] and data["exit_code"] == 2


def test_flag_placement_hint(logged_in, runner):
    # A global flag AFTER the command nudges toward the right placement.
    result = runner.invoke(app, ["sessions", "--json"])
    assert result.exit_code == 2
    assert "before the command" in result.stderr


# --- shared resolve_one ----------------------------------------------------------


def test_resolve_one_resolves_by_name_and_id():
    items = [SimpleNamespace(name="a", id="1"), SimpleNamespace(name="b", id="2")]
    assert _write.resolve_one(items, "a", kind="key", list_cmd="keys list").id == "1"
    assert _write.resolve_one(items, "2", kind="key", list_cmd="keys list").name == "b"


def test_resolve_one_not_found_raises_exit_6():
    with pytest.raises(NotFoundError) as exc:
        _write.resolve_one([], "zzz", kind="key", list_cmd="keys list")
    assert exc.value.exit_code == 6
    assert exc.value.hint  # carries a "run `fp keys list`" hint


def test_resolve_one_ambiguous_raises_usage():
    dup = [SimpleNamespace(name="a", id="1"), SimpleNamespace(name="a", id="2")]
    with pytest.raises(click.UsageError):
        _write.resolve_one(dup, "a", kind="key", list_cmd="keys list")


# --- client._extract_error folds in the server `detail` --------------------------


def test_extract_error_includes_detail():
    resp = httpx.Response(400, json={"error": "query failed", "detail": "syntax error near 'FORM'"})
    assert client._extract_error(resp) == "query failed: syntax error near 'FORM'"


def test_extract_error_without_detail():
    resp = httpx.Response(404, json={"error": "Not found."})
    assert client._extract_error(resp) == "Not found."


# --- emit_json is always valid JSON (no NaN/Infinity tokens) ---------------------


def test_emit_json_coerces_non_finite(capsys):
    output.emit_json({"a": float("nan"), "b": float("inf"), "c": float("-inf"), "d": 1.5})
    data = json.loads(capsys.readouterr().out)  # would raise on a bare NaN token
    assert data == {"a": None, "b": None, "c": None, "d": 1.5}


# --- print_table never raises MarkupError on bracketed cells ---------------------


def test_print_table_escapes_markup(capsys):
    output.configure(no_color=True)
    output.print_table(["k", "v"], [["x", "[/]"], ["y", "[red]bad[/red]"]])  # must not raise
    out = capsys.readouterr().out
    assert "[/]" in out and "[red]bad[/red]" in out  # rendered literally


# --- settings set --value coercion never crashes on odd input --------------------


@respx.mock
def test_settings_set_unicode_value_no_crash(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(
        return_value=httpx.Response(200, json={"settings": [
            {"key": "session_ttl_secs", "value": 100, "schema": {"kind": "positive_int"}}]})
    )
    respx.put(f"{BASE}/api/settings/session_ttl_secs").mock(
        return_value=httpx.Response(422, json={"error": "must be an integer"})
    )
    result = runner.invoke(app, ["--json", "settings", "set", "session_ttl_secs", "--value", "²"])
    assert "Traceback" not in result.output  # the old isdigit()/int() path raised here
    assert result.exit_code == 1
    assert json.loads(result.stdout)["error"] == "must be an integer"


# --- orgs switch not-found now emits a JSON envelope (was silent under --json) ----


@respx.mock
def test_orgs_switch_not_found_json_emits_error(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json={
        "id": "u1", "email": "me@test", "is_instance_admin": False,
        "memberships": [{"org_id": "o1", "org_slug": "acme", "org_name": "Acme",
                         "permissions": ["events:read"], "permission_set": "standard"}],
    }))
    result = runner.invoke(app, ["--json", "orgs", "switch", "acm"])
    assert result.exit_code == 2
    data = json.loads(result.stdout)
    assert "no org named acm" in data["error"]
    assert data["exit_code"] == 2
    assert "acme" in data.get("hint", "")
