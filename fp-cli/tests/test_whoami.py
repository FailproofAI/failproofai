"""`whoami` (logged in): the identity header + permissions/orgs panels, and the
permission grouping/coloring logic."""

from __future__ import annotations

import httpx
import respx

from fp_cli import theme
from fp_cli.app import app
from fp_cli.output import _group_permissions

BASE = "http://dash.test"


# --- permission grouping / coloring -----------------------------------------


def test_group_permissions_orders_resources_and_actions_by_risk():
    grouped = _group_permissions(
        ["keys:delete", "keys:read", "keys:create", "dashboards:read", "agent:use"]
    )
    # resources follow the fixed priority order (dashboards < keys < agent)
    assert [r for r, _ in grouped] == ["dashboards", "keys", "agent"]
    by_res = dict(grouped)
    # actions within a row ordered by risk: read → create → delete
    assert [a for a, _ in by_res["keys"]] == ["read", "create", "delete"]
    colors = dict(by_res["keys"])
    assert colors["read"] == theme.PERM_READ
    assert colors["create"] == theme.PERM_WRITE
    assert colors["delete"] == theme.PERM_DANGER


def test_group_permissions_unknown_action_falls_back_neutral():
    grouped = _group_permissions(["weird:frobnicate"])
    assert grouped == [("weird", [("frobnicate", theme.DEFAULT_PERM_COLOR)])]


# --- human render ------------------------------------------------------------


def _session(memberships):
    return {
        "id": "62230791-4811-4f04-b388-ae57bdcb422e",
        "email": "admin@local.host",
        "is_instance_admin": True,
        "memberships": memberships,
    }


@respx.mock
def test_whoami_human_renders_header_and_panels(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([
            {"org_id": "o1", "org_slug": "globex", "org_name": "Globex Corp", "permission_set": "admin",
             "permissions": ["dashboards:read", "dashboards:write", "dashboards:delete", "keys:read", "agent:use"]},
            {"org_id": "o2", "org_slug": "acme", "org_name": "Acme Corp", "permission_set": "admin",
             "permissions": ["events:read"]},
        ]))
    )
    result = runner.invoke(app, ["--org", "globex", "whoami"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    # identity header: email, instance role, FULL user id, active org
    assert "admin@local.host" in out
    assert "62230791-4811-4f04-b388-ae57bdcb422e" in out
    assert "instance admin" in out
    # permissions panel
    assert "permissions" in out
    assert "dashboards" in out and "read" in out and "write" in out and "delete" in out
    # orgs panel + switch hint to the non-active org
    assert "your orgs" in out
    assert "globex" in out and "acme" in out
    assert "Globex Corp" in out  # permissions title shows the active org NAME
    assert "fp orgs switch <slug>" in out


@respx.mock
def test_whoami_single_org_has_no_switch_hint(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([
            {"org_id": "o", "org_slug": "acme", "org_name": "Acme", "permission_set": "admin",
             "permissions": ["events:read"]},
        ]))
    )
    result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0, result.output
    assert "your orgs" in result.stdout
    assert "orgs switch" not in result.stdout  # only one org → no switch hint


@respx.mock
def test_whoami_no_color_marks_destructive_actions(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([
            {"org_id": "o", "org_slug": "acme", "org_name": "Acme", "permission_set": "admin",
             "permissions": ["keys:read", "keys:delete", "keys:disable"]},
        ]))
    )
    result = runner.invoke(app, ["whoami"], env={"NO_COLOR": "1"})
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "delete*" in out and "disable*" in out  # destructive marked in plain text
    assert "read" in out and "read*" not in out    # non-destructive unmarked
