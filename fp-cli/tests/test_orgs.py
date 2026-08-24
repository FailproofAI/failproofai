"""Multi-tenancy: org selection at login, --org header injection, orgs/org commands."""

from __future__ import annotations

import json

import httpx
import respx

from fp_cli import config
from fp_cli.app import app

BASE = "http://dash.test"


def _session(memberships, *, is_admin=False, id="u1", email="me@test"):
    return {"id": id, "email": email, "is_instance_admin": is_admin, "memberships": memberships}


_ACME = {"org_id": "o1", "org_slug": "acme", "org_name": "Acme", "permissions": ["events:read"], "permission_set": "standard"}
_GLOBEX = {"org_id": "o2", "org_slug": "globex", "org_name": "Globex", "permissions": ["events:read", "keys:create"], "permission_set": "admin"}


def _otp_routes(user):
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    # The OTP-verify payload is intentionally slim (no memberships); login reads the
    # authoritative memberships from GET /api/auth/session, so mock that too.
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": user["id"], "email": user["email"]}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=user))


# --- login org selection ----------------------------------------------------


@respx.mock
def test_login_single_org_auto_selects(home, runner):
    _otp_routes(_session([_ACME]))
    result = runner.invoke(app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n")
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"


@respx.mock
def test_login_org_flag_persists(home, runner):
    _otp_routes(_session([_ACME, _GLOBEX]))
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "globex"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_org_not_a_member_is_usage_error(home, runner):
    _otp_routes(_session([_ACME]))
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "globex"], input="123456\n"
    )
    assert result.exit_code == 2  # BadParameter: not a member of globex


@respx.mock
def test_login_multi_org_no_selection_exits_nonzero_json(home, runner):
    # Non-interactive (CliRunner) multi-org login without --org: must not block.
    _otp_routes(_session([_ACME, _GLOBEX]))
    result = runner.invoke(app, ["--base-url", BASE, "--json", "login", "--email", "me@test"], input="123456\n")
    assert result.exit_code == 2, result.output
    # CliRunner echoes the typed OTP back onto stdout (its fake `input()` does what a terminal
    # normally does), so stdout here is "<echo>\n<envelope>". That prefix is a harness artifact,
    # not part of the --json contract — a real run echoes nothing — so parse from the envelope's
    # opening brace and keep asserting that the envelope itself lands on stdout.
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload["needs_org_selection"] is True
    assert set(payload["orgs"]) == {"acme", "globex"}
    # token saved so the user can `orgs switch` without re-doing OTP
    assert config.load_config().session_token == "tok"


# --- interactive org picker (multi-tenant) ----------------------------------
#
# The CliRunner's stdin is not a TTY, so the picker is gated behind
# `_stdin_is_tty()` which we stub True. The OTP code is the first stdin line;
# the picker choice (slug / number / Enter-for-default) is the next.


def _tty(monkeypatch):
    monkeypatch.setattr("fp_cli.select.stdin_is_tty", lambda: True)


@respx.mock
def test_login_multi_org_picker_by_slug(home, runner, monkeypatch):
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\nglobex\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_multi_org_picker_by_number(home, runner, monkeypatch):
    # memberships order is acme, globex → "2" selects globex
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n2\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_multi_org_picker_rejects_invalid_then_accepts(home, runner, monkeypatch):
    # A non-member / garbage choice must NOT be accepted — it re-prompts (no leak).
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\nnope\n9\nacme\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"
    assert "not one of your orgs" in (result.stderr or "")


@respx.mock
def test_login_saved_org_does_not_bypass_picker(home, runner, monkeypatch):
    # THE FIX: a previously-saved tenant must not silently re-activate — the picker
    # still runs and a different org can be chosen.
    config.save_config(config.CliConfig(base_url=BASE, org="acme"))
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\nglobex\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"  # chose globex despite saved acme


@respx.mock
def test_login_saved_org_is_picker_default_on_enter(home, runner, monkeypatch):
    # The saved tenant is offered as the Enter-to-keep default.
    config.save_config(config.CliConfig(base_url=BASE, org="acme"))
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"


@respx.mock
def test_login_stale_saved_org_not_offered_as_default(home, runner, monkeypatch):
    # A saved org the user is no longer a member of must not be the default; a bare
    # Enter then has no default → re-prompt (we follow with a valid pick).
    config.save_config(config.CliConfig(base_url=BASE, org="zombie"))
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\nacme\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"


@respx.mock
def test_login_global_org_flag_skips_picker(home, runner, monkeypatch):
    # An explicit global --org (before the command) is a deliberate choice → no picker.
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "--org", "globex", "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_env_org_skips_picker(home, runner, monkeypatch):
    # FP_ORG is an explicit choice → no picker.
    monkeypatch.setenv("FP_ORG", "globex")
    _otp_routes(_session([_ACME, _GLOBEX]))
    _tty(monkeypatch)
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_admin_can_select_existing_nonmember_org_via_flag(home, runner):
    # An instance admin may activate a non-member org via --org ONLY if it exists
    # and is accessible — the server probe (/api/access-granters) returns 200.
    _otp_routes(_session([_ACME], is_admin=True))
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(200, json=["dev"])
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "globex"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_login_admin_nonexistent_org_rejected(home, runner):
    # THE BUG FIX: an instance admin requesting a NON-EXISTENT org must be rejected,
    # not silently accepted+saved. The probe returns 403 (no such org / no access).
    _otp_routes(_session([_ACME], is_admin=True))
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(403, json={})
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "fp"], input="123456\n"
    )
    assert result.exit_code == 2, result.output
    assert config.load_config().org is None  # nothing bogus persisted


@respx.mock
def test_login_env_nonexistent_org_rejected(home, runner, monkeypatch):
    # FP_ORG follows the SAME validation as --org (both feed `requested`).
    monkeypatch.setenv("FP_ORG", "fp")
    _otp_routes(_session([_ACME], is_admin=True))
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(403, json={})
    )
    result = runner.invoke(app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n")
    assert result.exit_code == 2, result.output
    assert config.load_config().org is None


@respx.mock
def test_login_nonadmin_nonmember_rejected_without_probe(home, runner):
    # A regular user's non-member org is rejected by the membership check alone —
    # no server probe is made (the membership list is conclusive for non-admins).
    _otp_routes(_session([_ACME], is_admin=False))
    probe = respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(200, json=["dev"])
    )
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "globex"], input="123456\n"
    )
    assert result.exit_code == 2, result.output
    assert not probe.called


@respx.mock
def test_login_multi_org_noninteractive_reuses_saved(home, runner):
    # Non-interactive (CliRunner stdin is not a TTY), no --json: a still-valid saved
    # tenant is reused without prompting (back-compat for piped re-login).
    config.save_config(config.CliConfig(base_url=BASE, org="acme"))
    _otp_routes(_session([_ACME, _GLOBEX]))
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"


@respx.mock
def test_login_multi_org_noninteractive_stale_saved_needs_selection(home, runner):
    # Non-interactive with a saved org the user is NO LONGER a member of → must not
    # silently reuse it; falls through to needs-selection (exit 2).
    config.save_config(config.CliConfig(base_url=BASE, org="zombie"))
    _otp_routes(_session([_ACME, _GLOBEX]))
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 2, result.output
    assert config.load_config().org is None


@respx.mock
def test_login_noninteractive_multi_org_no_saved_needs_selection_plain(home, runner):
    # Non-interactive, NON-json, multi-org, nothing saved → needs selection, token kept.
    _otp_routes(_session([_ACME, _GLOBEX]))
    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n"
    )
    assert result.exit_code == 2, result.output
    assert config.load_config().session_token == "tok"
    assert config.load_config().org is None


# --- X-AgentEye-Org header injection ----------------------------------------


@respx.mock
def test_org_flag_sets_header(logged_in, runner):
    route = respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["--org", "acme", "sessions"])
    assert result.exit_code == 0, result.output
    assert route.calls.last.request.headers.get("X-AgentEye-Org") == "acme"


@respx.mock
def test_saved_org_sets_header(home, runner):
    config.save_config(
        config.CliConfig(base_url=BASE, session_token="tok", expires_at="2999-01-01T00:00:00Z", org="globex")
    )
    route = respx.get(f"{BASE}/api/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [], "next_cursor": None})
    )
    result = runner.invoke(app, ["sessions"])
    assert result.exit_code == 0, result.output
    assert route.calls.last.request.headers.get("X-AgentEye-Org") == "globex"


def test_bad_org_slug_is_usage_error(logged_in, runner):
    result = runner.invoke(app, ["--org", "Bad_Slug!", "sessions"])
    assert result.exit_code == 2


# --- whoami multi-tenant shape ----------------------------------------------


@respx.mock
def test_whoami_shows_memberships_and_active_org(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX], is_admin=True))
    )
    result = runner.invoke(app, ["--org", "globex", "--json", "whoami"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["active_org"] == "globex"
    assert data["is_instance_admin"] is True
    assert data["permissions"] == ["events:read", "keys:create"]  # globex's grants
    assert {m["org_slug"] for m in data["memberships"]} == {"acme", "globex"}


# --- orgs list / orgs current -----------------------------------------------
# (org selection/persistence/validation is covered by the orgs switch tests below;
#  `orgs use` was removed in favour of `orgs switch`.)


@respx.mock
def test_orgs_list_json(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "acme", "--json", "orgs", "list"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["active_org"] == "acme"
    assert {o["org_slug"] for o in data["orgs"]} == {"acme", "globex"}


@respx.mock
def test_orgs_current_json(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "globex", "--json", "orgs", "current"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["slug"] == "globex"
    assert data["name"] == "Globex" and data["role"] == "admin"
    assert data["permission_count"] == 2  # globex's two grants
    assert data["user_email"]  # reports who you're signed in as


@respx.mock
def test_orgs_perms_json(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "globex", "--json", "orgs", "perms"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["slug"] == "globex" and data["role"] == "admin"
    assert data["permissions"] == ["events:read", "keys:create"]  # globex's flat grants
    assert data["permission_count"] == 2


@respx.mock
def test_orgs_perms_table(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "globex", "orgs", "perms"])
    assert result.exit_code == 0, result.output
    # identity header (name · slug · role) + the shared grouped permissions panel, with the
    # org NAME in the panel's border title.
    assert "Globex" in result.stdout and "globex" in result.stdout and "role admin" in result.stdout
    assert "permissions · 2 · Globex" in result.stdout
    assert "events" in result.stdout and "keys" in result.stdout


@respx.mock
def test_org_use_admin_nonexistent_org_rejected(logged_in, runner):
    # Instance admin → a NON-EXISTENT org (probe 403) is rejected, not persisted.
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME], is_admin=True))
    )
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(403, json={})
    )
    result = runner.invoke(app, ["orgs", "use", "fp"])
    assert result.exit_code == 2
    assert config.load_config().org is None


@respx.mock
def test_logout_clears_active_org_and_identity(logged_in, runner):
    # Logout must not leave a remembered org/identity in cli.json — only base_url
    # (and prefs) survive, so the next login starts fresh.
    cfg = config.load_config()
    cfg.org = "acme"
    config.save_config(cfg)
    respx.post(f"{BASE}/api/auth/logout").mock(return_value=httpx.Response(200, json={}))
    result = runner.invoke(app, ["logout"])
    assert result.exit_code == 0, result.output
    after = config.load_config()
    assert after.session_token is None
    assert after.org is None
    assert after.email is None
    assert after.user_id is None
    assert after.base_url == BASE  # kept so the next login needs no --base-url


def test_logout_when_not_signed_in_is_noop(home, runner):
    # No session → logout must NOT claim a sign-out happened (no server call either).
    result = runner.invoke(app, ["--base-url", BASE, "logout"])
    assert result.exit_code == 0, result.output
    assert "already signed out" in (result.stderr or "").lower()


def test_logout_when_not_signed_in_json(home, runner):
    result = runner.invoke(app, ["--base-url", BASE, "--json", "logout"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["already_signed_out"] is True


# --- org list (and the orgs-list alias) -------------------------------------


@respx.mock
def test_org_list_json_shows_role_and_active(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX], is_admin=True))
    )
    result = runner.invoke(app, ["--org", "globex", "--json", "orgs", "list"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["active_org"] == "globex"
    assert data["is_instance_admin"] is True
    byslug = {o["org_slug"]: o for o in data["orgs"]}
    assert byslug["globex"]["active"] is True and byslug["acme"]["active"] is False
    assert byslug["acme"]["permission_set"] == "standard"  # your role in that org


@respx.mock
def test_org_list_table_lists_all_orgs(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "acme", "orgs", "list"])
    assert result.exit_code == 0, result.output
    assert "acme" in result.stdout and "globex" in result.stdout


@respx.mock
def test_orgs_list_alias_still_works(logged_in, runner):
    # `orgs list` lists your orgs (merged single `orgs` group).
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME]))
    )
    result = runner.invoke(app, ["--org", "acme", "--json", "orgs", "list"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["active_org"] == "acme"


# --- org switch -------------------------------------------------------------


@respx.mock
def test_org_switch_to_member(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["orgs", "switch", "globex"])
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_org_switch_non_member_rejected_without_probe(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME]))
    )
    probe = respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(200, json=["dev"])
    )
    result = runner.invoke(app, ["orgs", "switch", "globex"])
    assert result.exit_code == 2
    assert not probe.called  # non-admin → membership check is conclusive
    assert config.load_config().org is None


@respx.mock
def test_org_switch_admin_existing_nonmember_allowed(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME], is_admin=True))
    )
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(200, json=["dev"])
    )
    result = runner.invoke(app, ["orgs", "switch", "globex"])
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_org_switch_admin_nonexistent_rejected(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME], is_admin=True))
    )
    respx.get(f"{BASE}/api/access-granters").mock(
        return_value=httpx.Response(403, json={})
    )
    result = runner.invoke(app, ["orgs", "switch", "fp"])
    assert result.exit_code == 2
    assert config.load_config().org is None


@respx.mock
def test_org_switch_no_arg_single_org_auto_selects(logged_in, runner):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME]))
    )
    result = runner.invoke(app, ["orgs", "switch"])
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "acme"


@respx.mock
def test_org_switch_no_arg_interactive_picker(logged_in, runner, monkeypatch):
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    _tty(monkeypatch)
    result = runner.invoke(app, ["orgs", "switch"], input="globex\n")
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"


@respx.mock
def test_org_switch_no_arg_noninteractive_requires_slug(logged_in, runner):
    # CliRunner stdin is not a TTY and no slug given → must not hang; error out.
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["orgs", "switch"])
    assert result.exit_code == 2
    assert config.load_config().org is None


@respx.mock
def test_org_switch_to_different_renders_switched_card(logged_in, runner):
    # Positional switch to a DIFFERENT org → the boxed 'switched org' card (was <prev>).
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "acme", "orgs", "switch", "globex"])
    assert result.exit_code == 0, result.output
    assert config.load_config().org == "globex"
    assert "switched org" in result.stderr and "globex" in result.stderr and "was acme" in result.stderr


@respx.mock
def test_org_switch_to_current_is_noop(logged_in, runner):
    # Positional switch to the org you're already on → calm 'already on' no-op, not the card.
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--org", "acme", "orgs", "switch", "acme"])
    assert result.exit_code == 0, result.output
    assert "already on acme" in result.stderr
    assert "switched org" not in result.stderr


@respx.mock
def test_org_switch_not_found_did_you_mean(logged_in, runner):
    # A near-miss slug → styled not-found + did-you-mean + hint, non-zero exit.
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["orgs", "switch", "acm"])
    assert result.exit_code == 2
    assert "no org named acm" in result.stderr
    assert "did you mean acme" in result.stderr
    assert config.load_config().org is None


@respx.mock
def test_org_switch_single_org_says_only_org(logged_in, runner):
    # One org → no picker; calm 'only org' line; still persisted as active.
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME]))
    )
    result = runner.invoke(app, ["orgs", "switch"])
    assert result.exit_code == 0, result.output
    assert "only org" in result.stderr and "acme" in result.stderr
    assert config.load_config().org == "acme"


@respx.mock
def test_login_already_signed_in_switches_org_via_flag(home, runner):
    # A valid session is active on org acme; `login --org globex` must honor the explicit
    # selector and switch the active tenant (no re-auth), not drop it and report "already
    # signed in" on the old org (the bug).
    config.save_config(config.CliConfig(
        base_url=BASE, session_token="tok", expires_at="2999-01-01T00:00:00Z",
        email="me@test", user_id="u1", org="acme",
    ))
    respx.get(f"{BASE}/api/auth/session").mock(
        return_value=httpx.Response(200, json=_session([_ACME, _GLOBEX]))
    )
    result = runner.invoke(app, ["--json", "login", "--org", "globex"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["org"] == "globex" and data.get("switched_org") is True
    assert config.load_config().org == "globex"


# --- membership discovery that FAILS is not "no memberships" ----------------


@respx.mock
def test_a_membership_fetch_failure_is_reported_not_silently_emptied(home, runner):
    """`except Exception: pass` turned every discovery failure into an empty list.

    A timeout, a 500, a malformed body or a permissions problem all collapsed
    into "this user belongs to no orgs" — which then clears a previously chosen
    tenant and reads, to anyone looking, like a successful single-org login.
    """
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(503, json={"error": "upstream down"}))

    result = runner.invoke(app, ["--base-url", BASE, "login", "--email", "me@test"], input="123456\n")

    # The token IS kept — losing a good session to a discovery blip would be worse.
    assert config.load_config().session_token == "tok"
    # ...but the failure is said out loud rather than presented as "no orgs".
    assert "could not read your organisation memberships" in result.stderr, result.stderr


@respx.mock
def test_an_explicit_org_is_not_rejected_on_a_check_that_never_ran(home, runner):
    """"You are not a member of org 'X'. Your orgs: (none)." was a confident lie.

    With discovery failed, `slugs` is empty because nothing answered — not
    because the user belongs to nothing. Exiting 2 on a tenant they may well
    have, citing a membership list that was never fetched, is the worst of the
    available answers.
    """
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(500, json={"error": "boom"}))
    # The direct check is the only thing that can still answer, so it is consulted.
    respx.get(f"{BASE}/api/access-granters").mock(return_value=httpx.Response(200, json=[]))

    result = runner.invoke(
        app, ["--base-url", BASE, "login", "--email", "me@test", "--org", "globex"], input="123456\n"
    )
    assert result.exit_code == 0, result.output + result.stderr
    assert config.load_config().org == "globex"
