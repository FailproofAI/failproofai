"""Operator domains: users, settings."""

from __future__ import annotations

import json

import httpx
import respx

from fp_cli.app import app

BASE = "http://dash.test"


def _user(**over):
    """A DashboardUser-shaped dict with sensible defaults, overridable per field."""
    base = {
        "id": "u1", "email": "a@test", "permissions": [], "permission_set": None,
        "permission_added": [], "permission_removed": [], "disabled_at": None,
        "is_protected": False, "created_at": "2026-06-25T08:00:00Z",
        "updated_at": "2026-06-25T08:00:00Z",
    }
    base.update(over)
    return base


# --- users list -------------------------------------------------------------


@respx.mock
def test_users_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[
            _user(id="u1", email="a@test", permissions=["events:read"], permission_set="standard"),
        ])
    )
    result = runner.invoke(app, ["--json", "users", "list"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)["users"][0]
    assert body["email"] == "a@test"
    assert body["created_at"] == "2026-06-25T08:00:00Z"  # join date carried through


@respx.mock
def test_users_list_sorts_active_first(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[
            _user(id="u2", email="b@test", disabled_at="2026-01-01T00:00:00Z"),  # disabled first
            _user(id="u1", email="a@test", disabled_at=None),
        ])
    )
    result = runner.invoke(app, ["--json", "users", "list"])
    emails = [u["email"] for u in json.loads(result.stdout)["users"]]
    assert emails == ["a@test", "b@test"]  # active first, disabled last


@respx.mock
def test_users_list_active_only_hides_disabled(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[
            _user(id="u1", email="a@test", disabled_at=None),
            _user(id="u2", email="b@test", disabled_at="2026-01-01T00:00:00Z"),
        ])
    )
    result = runner.invoke(app, ["--json", "users", "list", "--active-only"])
    assert [u["email"] for u in json.loads(result.stdout)["users"]] == ["a@test"]


@respx.mock
def test_users_list_human_renders_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[
            _user(id="u1", email="root@test", permissions=["events:read"] * 9,
                  permission_set="admin", is_protected=True),
            _user(id="u2", email="off@test", disabled_at="2026-01-01T00:00:00Z", permission_set="standard"),
        ])
    )
    result = runner.invoke(app, ["users", "list"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "users" in out
    assert "active" in out and "disabled" in out  # status words + footer
    assert "protected" in out  # footer protected segment


# --- users show -------------------------------------------------------------


@respx.mock
def test_users_show_by_email(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[
            _user(id="u1", email="dev@example.com", permissions=["events:read", "keys:create"],
                  permission_set="standard"),
        ])
    )
    result = runner.invoke(app, ["--json", "users", "show", "dev@example.com"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert body["email"] == "dev@example.com"
    assert sorted(body["permissions"]) == ["events:read", "keys:create"]


@respx.mock
def test_users_show_by_id(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[_user(id="abc-123", email="dev@example.com")])
    )
    result = runner.invoke(app, ["--json", "users", "show", "abc-123"])  # id handle still works
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["email"] == "dev@example.com"


@respx.mock
def test_users_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[_user(email="a@test")]))
    result = runner.invoke(app, ["users", "show", "nobody@test"])
    assert result.exit_code == 6


# --- users create -----------------------------------------------------------


@respx.mock
def test_users_create_positional_email_and_set(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[]))  # no collision
    route = respx.post(f"{BASE}/api/users").mock(
        return_value=httpx.Response(201, json=_user(id="u9", email="dev@example.com",
                                                    permissions=["events:read"], permission_set="standard"))
    )
    result = runner.invoke(app, ["--json", "users", "create", "dev@example.com",
                                 "--permission-set", "standard", "--add", "keys:create"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["email"] == "dev@example.com"
    assert body["permission_set"] == "standard"
    assert body["permission_added"] == ["keys:create"]


@respx.mock
def test_users_create_dotted_tokens_expand(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[]))
    route = respx.post(f"{BASE}/api/users").mock(
        return_value=httpx.Response(201, json=_user(id="u9", email="dev@example.com"))
    )
    result = runner.invoke(app, ["--json", "users", "create", "dev@example.com",
                                 "--add", "keys:create.regenerate", "--remove", "alerts:read"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["permission_added"] == ["keys:create", "keys:regenerate"]  # dotted expanded
    assert body["permission_removed"] == ["alerts:read"]


def test_users_create_rejects_unknown_permission(logged_in, runner):
    result = runner.invoke(app, ["users", "create", "a@b.com", "--add", "bogus:perm"])
    assert result.exit_code == 2


def test_users_create_email_is_positional_only(logged_in, runner):
    # --email was removed — the email is the positional argument now.
    result = runner.invoke(app, ["users", "create", "--email", "c@d.com"])
    assert result.exit_code == 2  # unknown option


def test_users_create_requires_email(logged_in, runner):
    result = runner.invoke(app, ["users", "create", "--permission-set", "standard"])
    assert result.exit_code == 2  # missing required EMAIL argument


@respx.mock
def test_users_create_email_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[_user(id="u1", email="dev@example.com")])
    )
    result = runner.invoke(app, ["--json", "users", "create", "dev@example.com", "--permission-set", "standard"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


# --- users update: incremental + role assign + diff -------------------------


@respx.mock
def test_users_update_add_is_incremental(logged_in, runner):
    # current state: a set + existing overrides — the merge must keep them.
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="a@b.com", permissions=["events:add"], permission_set="standard",
              permission_added=["events:add"], permission_removed=["queries:run"]),
    ]))
    route = respx.put(f"{BASE}/api/users/u1").mock(
        return_value=httpx.Response(200, json=_user(id="u1", email="a@b.com",
                                                    permissions=["events:add", "keys:create"]))
    )
    result = runner.invoke(app, ["--json", "users", "update", "a@b.com", "--add", "keys:create", "--yes"])
    assert result.exit_code == 0, result.output
    sent = json.loads(route.calls.last.request.content)
    assert sent["permission_set"] == "standard"  # set preserved
    assert sorted(sent["permission_added"]) == ["events:add", "keys:create"]  # merged, not replaced
    assert sent["permission_removed"] == ["queries:run"]  # preserved


@respx.mock
def test_users_update_remove_unsuppresses_and_drops_add(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="a@b.com", permissions=["keys:create"], permission_set="standard",
              permission_added=["keys:create"], permission_removed=[]),
    ]))
    route = respx.put(f"{BASE}/api/users/u1").mock(
        return_value=httpx.Response(200, json=_user(id="u1", email="a@b.com", permissions=[]))
    )
    result = runner.invoke(app, ["--json", "users", "update", "a@b.com", "--remove", "keys:create", "--yes"])
    assert result.exit_code == 0, result.output
    sent = json.loads(route.calls.last.request.content)
    assert sent["permission_added"] == []           # dropped from added
    assert sent["permission_removed"] == ["keys:create"]  # and suppressed


@respx.mock
def test_users_update_permission_set_assign(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="a@b.com", permissions=[], permission_set="read-only"),
    ]))
    route = respx.put(f"{BASE}/api/users/u1").mock(
        return_value=httpx.Response(200, json=_user(id="u1", email="a@b.com", permission_set="admin"))
    )
    result = runner.invoke(app, ["--json", "users", "update", "a@b.com",
                                 "--permission-set", "admin", "--add", "events:add", "--yes"])
    assert result.exit_code == 0, result.output
    sent = json.loads(route.calls.last.request.content)
    assert sent == {"permission_set": "admin", "permission_added": ["events:add"], "permission_removed": []}


@respx.mock
def test_users_update_json_includes_diff(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="a@b.com", permissions=["events:read"]),
    ]))
    respx.put(f"{BASE}/api/users/u1").mock(
        return_value=httpx.Response(200, json=_user(id="u1", email="a@b.com",
                                                    permissions=["events:read", "keys:create"]))
    )
    result = runner.invoke(app, ["--json", "users", "update", "a@b.com", "--add", "keys:create", "--yes"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.stdout)
    assert body["added"] == ["keys:create"]
    assert body["removed"] == []


@respx.mock
def test_users_update_noop_makes_no_call(logged_in, runner):
    # adding a perm the member already has effectively → no-op: no PUT, exit 0.
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="a@b.com", permissions=["events:read"]),
    ]))
    put = respx.put(f"{BASE}/api/users/u1").mock(return_value=httpx.Response(200, json=_user()))
    result = runner.invoke(app, ["--json", "users", "update", "a@b.com", "--add", "events:read", "--yes"])
    assert result.exit_code == 0, result.output
    assert not put.called  # no server call for a no-op
    assert json.loads(result.stdout)["added"] == []


def test_users_update_noop_flags_is_rejected(logged_in, runner):
    # No flags → usage error, NOT a silent wipe (no routes mocked → must fail before any call).
    result = runner.invoke(app, ["users", "update", "a@b.com", "--yes"])
    assert result.exit_code == 2


def test_users_update_add_remove_same_perm_rejected(logged_in, runner):
    result = runner.invoke(app, ["users", "update", "a@b.com",
                                 "--add", "keys:create", "--remove", "keys:create", "--yes"])
    assert result.exit_code == 2


@respx.mock
def test_users_update_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[_user(email="a@b.com")]))
    result = runner.invoke(app, ["users", "update", "nope@b.com", "--add", "keys:create", "--yes"])
    assert result.exit_code == 6


# --- users disable / enable -------------------------------------------------


@respx.mock
def test_users_disable_then_json(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="dev@example.com"),
    ]))
    route = respx.delete(f"{BASE}/api/users/u1").mock(return_value=httpx.Response(200, json={"disabled": True}))
    result = runner.invoke(app, ["--json", "users", "disable", "dev@example.com", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called
    assert json.loads(result.stdout)["status"] == "disabled"


@respx.mock
def test_users_disable_protected_refused(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="root@example.com", is_protected=True),
    ]))
    delete = respx.delete(f"{BASE}/api/users/u1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["users", "disable", "root@example.com", "--yes"])
    assert result.exit_code == 5
    assert not delete.called  # refused client-side, never hit the server


@respx.mock
def test_users_disable_self_refused(logged_in, runner):
    # logged_in fixture seeds email="me@test"
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="me@test"),
    ]))
    delete = respx.delete(f"{BASE}/api/users/u1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["users", "disable", "me@test", "--yes"])
    assert result.exit_code == 5
    assert not delete.called


@respx.mock
def test_users_disable_already_disabled_noop(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="off@example.com", disabled_at="2026-01-01T00:00:00Z"),
    ]))
    delete = respx.delete(f"{BASE}/api/users/u1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "users", "disable", "off@example.com", "--yes"])
    assert result.exit_code == 0, result.output
    assert not delete.called  # no-op


@respx.mock
def test_users_disable_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[_user(email="a@test")]))
    result = runner.invoke(app, ["users", "disable", "nobody@test", "--yes"])
    assert result.exit_code == 6


@respx.mock
def test_users_enable(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="off@example.com", disabled_at="2026-01-01T00:00:00Z"),
    ]))
    respx.post(f"{BASE}/api/users/u1/enable").mock(
        return_value=httpx.Response(200, json=_user(id="u1", email="off@example.com", disabled_at=None))
    )
    result = runner.invoke(app, ["--json", "users", "enable", "off@example.com", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["status"] == "active"


@respx.mock
def test_users_enable_already_active_noop(logged_in, runner):
    respx.get(f"{BASE}/api/users").mock(return_value=httpx.Response(200, json=[
        _user(id="u1", email="on@example.com", disabled_at=None),
    ]))
    enable = respx.post(f"{BASE}/api/users/u1/enable").mock(return_value=httpx.Response(200, json=_user()))
    result = runner.invoke(app, ["--json", "users", "enable", "on@example.com", "--yes"])
    assert result.exit_code == 0, result.output
    assert not enable.called  # no-op


# --- settings ---------------------------------------------------------------


@respx.mock
def test_settings_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(
        return_value=httpx.Response(200, json={"settings": [{"key": "session_ttl_secs", "value": 86400, "updated_at": "t", "updated_by": None}]})
    )
    result = runner.invoke(app, ["--json", "settings", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["settings"][0]["key"] == "session_ttl_secs"


_SETTINGS = [
    {"key": "session_ttl_secs", "value": 86400, "updated_by": "admin@local.host", "updated_at": "2026-06-25T16:00:00Z",
     "schema": {"kind": "positive_int", "label": "session lifetime", "min": 60, "max": 2592000, "unit": "seconds",
                "description": "how long a dashboard login stays valid"}},
    {"key": "alerts.email_default_recipients", "value": ["admin@local.host"], "updated_at": "2026-06-28T06:00:00Z",
     "schema": {"kind": "email_list", "description": "default alert email recipients"}},
    {"key": "alerts.webhook_signing_secret", "value": "", "updated_at": "2026-06-28T06:00:00Z",
     "schema": {"kind": "secret", "description": "HMAC signing key"}},
]


@respx.mock
def test_settings_list_human_boxed(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    result = runner.invoke(app, ["settings", "list"])
    assert result.exit_code == 0, result.output
    out = result.stdout + result.stderr
    assert "settings · 3" in out
    for c in ("key", "value", "type", "updated"):
        assert c in out
    assert "session_ttl_secs" in out and "86400" in out and "integer" in out
    assert "(secret)" in out                          # secret value masked, never echoed
    assert "change one with" not in out                # the footer hint was removed


@respx.mock
def test_settings_schema_human(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    result = runner.invoke(app, ["settings", "schema"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "settings schema · 3" in out
    for c in ("key", "type", "accepts"):
        assert c in out
    assert "60–2592000 seconds" in out                 # positive_int range + unit (description wraps; see output test)


@respx.mock
def test_settings_schema_json_includes_kind(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    result = runner.invoke(app, ["--json", "settings", "schema"])
    assert result.exit_code == 0, result.output
    entries = {e["key"]: e for e in json.loads(result.stdout)["settings"]}
    assert entries["session_ttl_secs"]["kind"] == "positive_int"


@respx.mock
def test_settings_set_scalar_int(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    route = respx.put(f"{BASE}/api/settings/session_ttl_secs").mock(
        return_value=httpx.Response(200, json={"key": "session_ttl_secs", "value": 3600})
    )
    result = runner.invoke(app, ["--json", "settings", "set", "session_ttl_secs", "--value", "3600", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"value": 3600}


@respx.mock
def test_settings_set_json_value_array(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    route = respx.put(f"{BASE}/api/settings/alerts.email_default_recipients").mock(
        return_value=httpx.Response(200, json={"key": "alerts.email_default_recipients", "value": ["a@b.com"]})
    )
    result = runner.invoke(
        app, ["--json", "settings", "set", "alerts.email_default_recipients", "--json-value", '["a@b.com"]', "--yes"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"value": ["a@b.com"]}


def test_settings_set_requires_one_value_source(logged_in, runner):
    result = runner.invoke(app, ["settings", "set", "k", "--value", "1", "--json-value", "2", "--yes"])
    assert result.exit_code == 2


@respx.mock
def test_settings_set_unknown_key_exits_6(logged_in, runner):
    # Settings are a fixed registry → an unknown key is rejected before any PUT.
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    put = respx.put(f"{BASE}/api/settings/nope").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["settings", "set", "nope", "--value", "1", "--yes"])
    assert result.exit_code == 6
    assert not put.called


@respx.mock
def test_settings_set_noop_makes_no_put(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    put = respx.put(f"{BASE}/api/settings/session_ttl_secs").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["settings", "set", "session_ttl_secs", "--value", "86400", "--yes"])  # same value
    assert result.exit_code == 0, result.output
    assert not put.called  # no-op → no server call


@respx.mock
def test_settings_set_invalid_value_clean_error(logged_in, runner):
    respx.get(f"{BASE}/api/settings").mock(return_value=httpx.Response(200, json={"settings": _SETTINGS}))
    respx.put(f"{BASE}/api/settings/session_ttl_secs").mock(
        return_value=httpx.Response(422, json={"error": "value must be between 60 and 2592000"}))
    result = runner.invoke(app, ["settings", "set", "session_ttl_secs", "--value", "5", "--yes"])
    assert result.exit_code == 1
    assert "value must be between 60 and 2592000" in result.stderr


@respx.mock
def test_users_show_finds_a_member_whose_email_the_server_lowercased(logged_in, runner):
    """`users create` is normalised server-side; the lookup commands were not.

    `fp users create Alice.Chen@Example.com` stores `alice.chen@example.com`, so every later
    show/update/disable/enable on the exact string the caller had just typed answered
    `no user with email "Alice.Chen@Example.com"` (exit 6) — the CLI denying a member it had
    itself just created, reachable only via a lowercased form nothing told them about.
    """
    respx.get(f"{BASE}/api/users").mock(
        return_value=httpx.Response(200, json=[_user(id="u1", email="alice.chen@example.com")])
    )
    result = runner.invoke(app, ["--json", "users", "show", "Alice.Chen@Example.com"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["email"] == "alice.chen@example.com"
