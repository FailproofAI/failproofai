"""Dev provisioning: API keys (one-time secret) and saved queries / SQL runner."""

from __future__ import annotations

import json
import re

import httpx
import pytest
import respx

from fp_cli.app import app
from fp_cli.commands.keys_cmds import PermissionTokenError, _parse_permissions


def test_audit_permissions_are_assignable_and_in_presets():
    from fp_cli.permissions import ALL_PERMISSIONS, PRESETS

    assert "audits:read" in ALL_PERMISSIONS
    assert "audits:write" in ALL_PERMISSIONS
    assert "audits:read" in PRESETS["read-only"]
    assert "usage:read" in ALL_PERMISSIONS
    assert "usage:read" in PRESETS["read-only"]
    assert "audits:write" in PRESETS["admin"]


def test_policy_permissions_are_assignable_and_in_presets():
    from fp_cli.permissions import ALL_PERMISSIONS, PRESETS

    assert "policies:read" in ALL_PERMISSIONS
    assert "policies:write" in ALL_PERMISSIONS
    assert "policies:pull" in ALL_PERMISSIONS
    assert "policies:read" in PRESETS["read-only"]
    assert "policies:read" in PRESETS["standard"]
    assert "policies:pull" in PRESETS["admin"]

BASE = "http://dash.test"


def test_parse_permissions_expands_and_dedupes():
    # dotted actions expand to flat slug:action, across tokens, de-duplicated, order preserved
    assert _parse_permissions(["events:read.add", "keys:read.create"]) == [
        "events:read", "events:add", "keys:read", "keys:create"]
    assert _parse_permissions(["events:read", "events:read.add"]) == ["events:read", "events:add"]
    assert _parse_permissions(["events:read.add keys:read"]) == ["events:read", "events:add", "keys:read"]  # whitespace in one token


@pytest.mark.parametrize("bad", [["events"], ["events:"], ["events:frobnicate"], []])
def test_parse_permissions_rejects(bad):
    with pytest.raises(PermissionTokenError):
        _parse_permissions(bad)


def test_parse_permission_tokens_require_nonempty_flag():
    # The shared parser (in permissions.py) lets users --add/--remove be empty when asked.
    from fp_cli.permissions import PermissionTokenError as PTErr
    from fp_cli.permissions import parse_permission_tokens
    assert parse_permission_tokens([], require_nonempty=False) == []
    assert parse_permission_tokens(None, require_nonempty=False) == []
    with pytest.raises(PTErr):
        parse_permission_tokens([])  # default requires at least one


# --- keys -------------------------------------------------------------------


@respx.mock
def test_keys_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(
        return_value=httpx.Response(
            200,
            json=[{"id": "k1", "name": "ci", "permissions": ["events:add"], "created_at": "t", "revoked_at": None}],
        )
    )
    result = runner.invoke(app, ["--json", "keys", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["keys"][0]["id"] == "k1"


@respx.mock
def test_keys_create_generates_secret_and_posts_it(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[]))  # no name collision
    route = respx.post(f"{BASE}/api/keys").mock(
        return_value=httpx.Response(201, json={"id": "k9", "name": "ci-bot",
                                               "permissions": ["events:read", "events:add", "keys:read"], "created_at": "t"})
    )
    # compact --add tokens: `events:read.add` expands to events:read + events:add; `keys:read` too
    result = runner.invoke(app, ["--json", "keys", "create", "ci-bot", "--add", "events:read.add,keys:read"])
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "ci-bot"
    assert body["permissions"] == ["events:add", "events:read", "keys:read"]  # expanded + de-duped + sorted
    assert re.fullmatch(r"[0-9a-f]{64}", body["key"])  # CLI-generated 64-hex secret
    assert json.loads(result.stdout)["key"] == body["key"]  # secret only in the JSON `key` field


def test_keys_create_rejects_unknown_permission(logged_in, runner):
    result = runner.invoke(app, ["keys", "create", "k", "--add", "orgs:admin"])
    assert result.exit_code == 2  # orgs:admin is not assignable


def test_keys_create_rejects_human_only_permission(logged_in, runner):
    # keys:update is human-only — rejected client-side for a key (exit 2), not a server 422.
    result = runner.invoke(app, ["keys", "create", "k", "--add", "keys:update"])
    assert result.exit_code == 2


def test_keys_create_rejects_malformed_token(logged_in, runner):
    # missing colon / empty action → red error box, exit 2, before any mutation
    assert runner.invoke(app, ["keys", "create", "k", "--add", "events"]).exit_code == 2
    assert runner.invoke(app, ["keys", "create", "k", "--add", "events:"]).exit_code == 2


@respx.mock
def test_keys_create_name_collision(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "k1", "name": "ci-bot", "permissions": [], "created_at": "t", "revoked_at": None}]))
    result = runner.invoke(app, ["--json", "keys", "create", "ci-bot", "--add", "events:read"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


def _one_key(name="ci-bot", key_id="k1", revoked=False):
    return [{"id": key_id, "name": name, "permissions": ["events:add"], "created_at": "t",
             "revoked_at": ("t" if revoked else None)}]


@respx.mock
def test_keys_disable_by_name_json(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=_one_key()))
    route = respx.post(f"{BASE}/api/keys/k1/disable").mock(return_value=httpx.Response(200, json={}))
    # name is resolved to the key id; --json non-tty + --yes proceeds (auto-skip rule).
    result = runner.invoke(app, ["--json", "keys", "disable", "ci-bot", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called  # resolved "ci-bot" -> /keys/k1/disable
    assert json.loads(result.stdout) == {"name": "ci-bot", "status": "disabled"}


@respx.mock
def test_keys_disable_already_disabled_is_noop(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=_one_key(revoked=True)))
    route = respx.post(f"{BASE}/api/keys/k1/disable").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "keys", "disable", "ci-bot"])
    assert result.exit_code == 0, result.output
    assert not route.called  # already disabled → no destructive call
    assert json.loads(result.stdout) == {"name": "ci-bot", "status": "disabled"}


@respx.mock
def test_keys_disable_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=_one_key()))
    result = runner.invoke(app, ["keys", "disable", "nope", "--yes"])
    assert result.exit_code == 6
    assert "no key named" in (result.stderr or result.output)


@respx.mock
def test_keys_disable_forbidden_exits_5(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=_one_key()))
    respx.post(f"{BASE}/api/keys/k1/disable").mock(
        return_value=httpx.Response(403, json={"error": "key is part of the configuration"})
    )
    result = runner.invoke(app, ["keys", "disable", "ci-bot", "--yes"])
    assert result.exit_code == 5


@respx.mock
def test_keys_regenerate_shows_new_secret(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=_one_key()))
    respx.post(f"{BASE}/api/keys/k1/regenerate").mock(
        return_value=httpx.Response(200, json={"key": "a" * 64})
    )
    result = runner.invoke(app, ["--json", "keys", "regenerate", "ci-bot", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"name": "ci-bot", "key": "a" * 64}


@respx.mock
def test_keys_list_box(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "1f58376d", "name": "admin", "permissions": ["a", "b"], "created_at": "2026-06-18T05:14:00Z", "revoked_at": None},
        {"id": "9c22aa01", "name": "old-key", "permissions": ["x"], "created_at": "2026-06-10T00:00:00Z", "revoked_at": "2026-06-12T00:00:00Z"},
    ]))
    result = runner.invoke(app, ["keys", "list"])
    assert result.exit_code == 0, result.output
    assert "api keys" in result.stdout and "active first" in result.stdout
    assert "admin" in result.stdout and "active" in result.stdout and "revoked" in result.stdout
    assert result.stdout.index("admin") < result.stdout.index("old-key")  # active sorts above revoked
    # footer summary (stderr) counts by status
    assert "2 keys" in (result.stderr or "") and "1 active" in (result.stderr or "") and "1 revoked" in (result.stderr or "")


@respx.mock
def test_keys_update_incremental_add(logged_in, runner):
    # --add alone is INCREMENTAL — merged into the key's current grants (like users update).
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "k1", "name": "ci", "permissions": ["events:add"], "created_at": "t", "revoked_at": None}]))
    route = respx.patch(f"{BASE}/api/keys/k1").mock(
        return_value=httpx.Response(200, json={"id": "k1", "name": "ci",
                                               "permissions": ["events:add", "users:read"], "created_at": "t", "revoked_at": None})
    )
    result = runner.invoke(app, ["--json", "keys", "update", "ci", "--add", "users:read", "--yes"])
    assert result.exit_code == 0, result.output
    # current {events:add} ∪ {users:read} = sorted ["events:add", "users:read"]
    assert json.loads(route.calls.last.request.content) == {"permissions": ["events:add", "users:read"]}
    body = json.loads(result.stdout)
    assert body["added"] == ["users:read"] and body["removed"] == []


@respx.mock
def test_keys_update_incremental_remove(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "k1", "name": "ci", "permissions": ["events:add", "events:read"], "created_at": "t", "revoked_at": None}]))
    route = respx.patch(f"{BASE}/api/keys/k1").mock(
        return_value=httpx.Response(200, json={"id": "k1", "name": "ci",
                                               "permissions": ["events:read"], "created_at": "t", "revoked_at": None})
    )
    result = runner.invoke(app, ["--json", "keys", "update", "ci", "--remove", "events:add", "--yes"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content) == {"permissions": ["events:read"]}


@respx.mock
def test_keys_update_noop_skips_server(logged_in, runner):
    # adding a grant the key already has → no-op: no PATCH, exit 0.
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "k1", "name": "ci", "permissions": ["events:add"], "created_at": "t", "revoked_at": None}]))
    route = respx.patch(f"{BASE}/api/keys/k1").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["--json", "keys", "update", "ci", "--add", "events:add", "--yes"])
    assert result.exit_code == 0, result.output
    assert not route.called
    assert json.loads(result.stdout)["added"] == [] and json.loads(result.stdout)["removed"] == []


def test_keys_update_requires_a_change_flag(logged_in, runner):
    result = runner.invoke(app, ["keys", "update", "ci"])
    assert result.exit_code == 2  # nothing to update


@respx.mock
def test_keys_update_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[
        {"id": "k1", "name": "ci", "permissions": [], "created_at": "t", "revoked_at": None}]))
    result = runner.invoke(app, ["keys", "update", "nope", "--add", "events:read", "--yes"])
    assert result.exit_code == 6


# --- queries ----------------------------------------------------------------


@respx.mock
def test_query_list_unwraps_queries_key(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(
        return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs", "sql_text": "select 1"}]})
    )
    result = runner.invoke(app, ["--json", "query", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["queries"][0]["id"] == "q1"


@respx.mock
def test_query_create_posts_body(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": []}))  # no collision
    route = respx.post(f"{BASE}/api/queries").mock(
        return_value=httpx.Response(201, json={"id": "q9", "name": "errs", "sql_text": "select 1", "params": []})
    )
    result = runner.invoke(
        app, ["--json", "query", "create", "errs", "--sql", "select 1"]  # name is positional now
    )
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["name"] == "errs"
    assert body["sql_text"] == "select 1"
    assert body["params"] == []  # --param was removed; created queries carry no params


@respx.mock
def test_query_create_sql_from_file(logged_in, runner, tmp_path):
    sql_file = tmp_path / "q.sql"
    sql_file.write_text("select count(*) from analytics.events")
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": []}))
    route = respx.post(f"{BASE}/api/queries").mock(
        return_value=httpx.Response(201, json={"id": "q1", "name": "n", "sql_text": "x", "params": []})
    )
    result = runner.invoke(app, ["query", "create", "n", "--sql", f"@{sql_file}"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content)["sql_text"] == "select count(*) from analytics.events"


@respx.mock
def test_query_create_name_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs"}]}))
    result = runner.invoke(app, ["--json", "query", "create", "errs", "--sql", "select 1"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


@respx.mock
def test_query_run_inline_renders_rows(logged_in, runner):
    respx.post(f"{BASE}/api/queries/run").mock(
        return_value=httpx.Response(200, json={"columns": [{"name": "n", "type": "int"}], "rows": [[5]], "truncated": False, "elapsed_ms": 3})
    )
    result = runner.invoke(app, ["--json", "query", "run", "--sql", "select 5 as n"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["rows"] == [[5]]
    assert data["elapsed_ms"] == 3


def test_query_run_requires_sql_or_saved(logged_in, runner):
    result = runner.invoke(app, ["query", "run"])
    assert result.exit_code == 2


@respx.mock
def test_query_run_coerces_param_values(logged_in, runner):
    route = respx.post(f"{BASE}/api/queries/run").mock(
        return_value=httpx.Response(200, json={"columns": [], "rows": [], "truncated": False, "elapsed_ms": 1})
    )
    result = runner.invoke(app, ["--json", "query", "run", "--sql", "select $1,$2,$3", "--param", "5", "--param", "true", "--param", "hi"])
    assert result.exit_code == 0, result.output
    assert json.loads(route.calls.last.request.content)["params"] == [5, True, "hi"]


@respx.mock
def test_query_run_readonly_violation_403(logged_in, runner):
    respx.post(f"{BASE}/api/queries/run").mock(
        return_value=httpx.Response(403, json={"error": "permission denied — only analytics.* views are queryable"})
    )
    result = runner.invoke(app, ["query", "run", "--sql", "select * from pg_user"])
    assert result.exit_code == 5


@respx.mock
def test_query_schema_json_splits_nullable(logged_in, runner):
    respx.get(f"{BASE}/api/queries/schema").mock(
        return_value=httpx.Response(200, json={"schema": "analytics", "tables": [
            {"name": "events", "columns": [{"name": "id", "type": "int"}, {"name": "tool_name", "type": "string?"}]}]})
    )
    result = runner.invoke(app, ["--json", "query", "schema"])
    assert result.exit_code == 0, result.output
    doc = json.loads(result.stdout)
    assert doc["schema"] == "analytics"
    cols = {c["column"]: c for c in doc["columns"]}
    assert cols["id"] == {"table": "events", "column": "id", "type": "int", "nullable": False}
    assert cols["tool_name"]["type"] == "string" and cols["tool_name"]["nullable"] is True  # ? split off


@respx.mock
def test_query_schema_table_filter(logged_in, runner):
    respx.get(f"{BASE}/api/queries/schema").mock(
        return_value=httpx.Response(200, json={"schema": "analytics", "tables": [
            {"name": "events", "columns": [{"name": "id", "type": "int"}]},
            {"name": "evaluations", "columns": [{"name": "status", "type": "string"}]}]})
    )
    result = runner.invoke(app, ["--json", "query", "schema", "evaluations"])
    assert result.exit_code == 0, result.output
    cols = json.loads(result.stdout)["columns"]
    assert {c["table"] for c in cols} == {"evaluations"}  # filtered to one table


@respx.mock
def test_query_schema_table_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/queries/schema").mock(
        return_value=httpx.Response(200, json={"schema": "analytics", "tables": [{"name": "events", "columns": []}]}))
    result = runner.invoke(app, ["query", "schema", "nope"])
    assert result.exit_code == 6


# --- queries: name-referenced show / run / update / delete ------------------


@respx.mock
def test_query_show_by_name_json(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [
        {"id": "q1", "name": "errs", "description": "d", "sql_text": "select 1", "created_by": "system", "created_at": "t"}]}))
    result = runner.invoke(app, ["--json", "query", "show", "errs"])  # by NAME, not id
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["sql_text"] == "select 1"


@respx.mock
def test_query_show_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs"}]}))
    result = runner.invoke(app, ["query", "show", "nope"])
    assert result.exit_code == 6


@respx.mock
def test_query_run_saved_by_positional_name(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [
        {"id": "q1", "name": "errs", "sql_text": "select 1"}]}))
    route = respx.post(f"{BASE}/api/queries/run").mock(
        return_value=httpx.Response(200, json={"columns": [], "rows": [], "truncated": False, "elapsed_ms": 1}))
    result = runner.invoke(app, ["--json", "query", "run", "errs", "--arg", "prod"])  # positional name, no --saved
    assert result.exit_code == 0, result.output
    body = json.loads(route.calls.last.request.content)
    assert body["query_id"] == "q1"   # name resolved to id
    assert body["params"] == ["prod"]


def test_query_run_requires_name_or_sql(logged_in, runner):
    assert runner.invoke(app, ["query", "run"]).exit_code == 2                      # neither
    assert runner.invoke(app, ["query", "run", "errs", "--sql", "select 1"]).exit_code == 2  # both


@respx.mock
def test_query_run_saved_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs"}]}))
    result = runner.invoke(app, ["query", "run", "ghost"])
    assert result.exit_code == 6


@respx.mock
def test_query_run_exec_error_is_clean(logged_in, runner):
    respx.post(f"{BASE}/api/queries/run").mock(
        return_value=httpx.Response(400, json={"error": "Syntax error: unexpected token near 'FORM'"}))
    result = runner.invoke(app, ["query", "run", "--sql", "SELECT * FORM events"])
    assert result.exit_code == 1
    # The underlying DB error is surfaced directly (no opaque "query failed" wrapper).
    assert "Syntax error" in result.stderr


@respx.mock
def test_query_update_rename_collision_exits_2(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [
        {"id": "q1", "name": "errs", "sql_text": "select 1"}, {"id": "q2", "name": "taken", "sql_text": "select 2"}]}))
    result = runner.invoke(app, ["--json", "query", "update", "errs", "--name", "taken", "--yes"])
    assert result.exit_code == 2
    assert "already exists" in json.loads(result.stdout)["error"]


@respx.mock
def test_query_update_noop_makes_no_put(logged_in, runner):
    # --description equal to current → nothing actually changes → no PUT, exit 0.
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [
        {"id": "q1", "name": "errs", "description": "same", "sql_text": "select 1", "params": []}]}))
    put = respx.put(f"{BASE}/api/queries/q1").mock(return_value=httpx.Response(200, json={"id": "q1"}))
    result = runner.invoke(app, ["--json", "query", "update", "errs", "--description", "same", "--yes"])
    assert result.exit_code == 0, result.output
    assert not put.called


@respx.mock
def test_query_update_by_name_keeps_omitted_fields(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [
        {"id": "q1", "name": "errs", "description": "old desc", "sql_text": "select 1",
         "params": [{"name": "e", "type": "text"}]}]}))
    route = respx.put(f"{BASE}/api/queries/q1").mock(
        return_value=httpx.Response(200, json={"id": "q1", "name": "errs", "sql_text": "select 2"}))
    result = runner.invoke(app, ["--json", "query", "update", "errs", "--sql", "select 2", "--yes"])
    assert result.exit_code == 0, result.output
    sent = json.loads(route.calls.last.request.content)
    assert sent["sql_text"] == "select 2"                      # changed
    assert sent["name"] == "errs"                              # kept
    assert sent["description"] == "old desc"                   # kept
    assert sent["params"] == [{"name": "e", "type": "text"}]   # kept


def test_query_update_noop_rejected(logged_in, runner):
    # No fields → usage error before any read/write (no routes mocked).
    result = runner.invoke(app, ["query", "update", "errs", "--yes"])
    assert result.exit_code == 2


@respx.mock
def test_query_delete_by_name(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs"}]}))
    route = respx.delete(f"{BASE}/api/queries/q1").mock(return_value=httpx.Response(200, json={"deleted": True}))
    result = runner.invoke(app, ["--json", "query", "delete", "errs", "--yes"])
    assert result.exit_code == 0, result.output
    assert route.called
    body = json.loads(result.stdout)
    assert body["deleted"] is True and body["name"] == "errs"


@respx.mock
def test_query_delete_not_found_exits_6(logged_in, runner):
    respx.get(f"{BASE}/api/queries").mock(return_value=httpx.Response(200, json={"queries": [{"id": "q1", "name": "errs"}]}))
    result = runner.invoke(app, ["query", "delete", "ghost", "--yes"])
    assert result.exit_code == 6
