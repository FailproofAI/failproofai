"""API-key auth mode: precedence, the empty-string rule, what goes on the wire, and
what never touches disk.

The wire assertions here are deliberately NEGATIVE as well as positive. "The bearer
header is set" passes just as happily when the CLI *also* attaches the operator's
`ae_session` cookie — which would hand a human's session to `/v1` from a CI box, and
no positive-only test would ever notice.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from fp_cli import config
from fp_cli._context import AppState, AuthMode, resolve_auth
from fp_cli.app import app

BASE = "http://dash.test"
KEY = "ak_live_abc123"


def _mock_keys(mock):
    """Mock BOTH surfaces so a wrong-mode request is a wrong URL, not a network error."""
    return (
        mock.get(f"{BASE}/api/keys").mock(return_value=httpx.Response(200, json=[])),
        mock.get(f"{BASE}/v1/keys").mock(return_value=httpx.Response(200, json=[])),
    )


def _run_keys_list(runner, argv, env=None):
    """Run `keys list` with both surfaces mocked → (result, api_route, v1_route)."""
    with respx.mock(assert_all_called=False) as mock:
        api_route, v1_route = _mock_keys(mock)
        result = runner.invoke(app, [*argv, "--json", "keys", "list"], env=env or {})
    return result, api_route, v1_route


# --- precedence ladder ------------------------------------------------------


def test_api_key_flag_selects_key_mode(home, runner):
    result, api_route, v1_route = _run_keys_list(runner, ["--base-url", BASE, "--api-key", KEY])
    assert result.exit_code == 0, result.output
    assert v1_route.called and not api_route.called


def test_token_flag_beats_api_key_env(home, runner):
    # An explicit flag outranks any env var, including the key's.
    result, api_route, v1_route = _run_keys_list(
        runner, ["--base-url", BASE, "--token", "tok"], env={"FP_API_KEY": KEY}
    )
    assert result.exit_code == 0, result.output
    assert api_route.called and not v1_route.called


def test_api_key_env_beats_token_env(home, runner):
    # Between two env vars the KEY wins — the documented rung.
    result, api_route, v1_route = _run_keys_list(
        runner,
        ["--base-url", BASE],
        env={"FP_API_KEY": KEY, "FP_TOKEN": "tok"},
    )
    assert result.exit_code == 0, result.output
    assert v1_route.called and not api_route.called


def test_token_env_beats_saved_session(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, session_token="saved-tok",
                                        expires_at="2999-01-01T00:00:00Z"))
    with respx.mock(assert_all_called=False) as mock:
        api_route, _v1 = _mock_keys(mock)
        result = runner.invoke(app, ["--json", "keys", "list"], env={"FP_TOKEN": "env-tok"})
    assert result.exit_code == 0, result.output
    assert "ae_session=env-tok" in api_route.calls.last.request.headers.get("cookie", "")


def test_api_key_env_beats_saved_session(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, session_token="saved-tok",
                                        expires_at="2999-01-01T00:00:00Z"))
    result, api_route, v1_route = _run_keys_list(
        runner, [], env={"FP_API_KEY": KEY}
    )
    assert result.exit_code == 0, result.output
    assert v1_route.called and not api_route.called


def test_saved_session_when_nothing_else(logged_in, runner):
    result, api_route, v1_route = _run_keys_list(runner, [])
    assert result.exit_code == 0, result.output
    assert api_route.called and not v1_route.called


def test_no_credential_at_all_exits_4(home, runner):
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().mock(return_value=httpx.Response(200, json=[]))
        result = runner.invoke(app, ["--base-url", BASE, "keys", "list"])
    assert result.exit_code == 4, result.output
    assert catch_all.call_count == 0  # never opened a connection


# --- resolve_auth, unit ------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs,expected",
    [
        # flag key, flag token, env key, env token, saved token
        (dict(api_key=KEY, api_key_on_cli=True, token=None, token_on_cli=False, saved_token=None),
         (AuthMode.API_KEY, KEY, None)),
        (dict(api_key=None, api_key_on_cli=False, token="t", token_on_cli=True, saved_token=None),
         (AuthMode.SESSION, None, "t")),
        (dict(api_key=KEY, api_key_on_cli=False, token="t", token_on_cli=False, saved_token=None),
         (AuthMode.API_KEY, KEY, None)),
        (dict(api_key=None, api_key_on_cli=False, token="t", token_on_cli=False, saved_token="s"),
         (AuthMode.SESSION, None, "t")),
        (dict(api_key=None, api_key_on_cli=False, token=None, token_on_cli=False, saved_token="s"),
         (AuthMode.SESSION, None, "s")),
        (dict(api_key=None, api_key_on_cli=False, token=None, token_on_cli=False, saved_token=None),
         (AuthMode.NONE, None, None)),
        # `--api-key ""` is key mode with NO credential — never a fallback to the
        # saved session (mirrors the established `--token ""` rule).
        (dict(api_key="", api_key_on_cli=True, token=None, token_on_cli=False, saved_token="s"),
         (AuthMode.API_KEY, "", None)),
    ],
)
def test_resolve_auth_precedence(kwargs, expected):
    assert resolve_auth(**kwargs) == expected


def test_both_flags_is_a_usage_error():
    from fp_cli import _click_compat as click

    with pytest.raises(click.UsageError):
        resolve_auth(api_key=KEY, api_key_on_cli=True, token="t", token_on_cli=True,
                     saved_token=None)


def test_both_flags_exits_2_with_zero_http_calls(logged_in, runner):
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().mock(return_value=httpx.Response(200, json=[]))
        result = runner.invoke(
            app, ["--base-url", BASE, "--api-key", KEY, "--token", "tok", "keys", "list"]
        )
    assert result.exit_code == 2, result.output
    assert catch_all.call_count == 0  # never guessed which one you meant


# --- the empty-string rule ---------------------------------------------------


def test_empty_api_key_does_not_fall_back_to_saved_session(logged_in, runner):
    """`--api-key ""` (an unset CI var) must not silently act as the logged-in human."""
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().mock(return_value=httpx.Response(200, json=[]))
        result = runner.invoke(app, ["--base-url", BASE, "--api-key", "", "keys", "list"])
    assert result.exit_code == 4, result.output  # key mode, no credential
    assert catch_all.call_count == 0


# --- what goes on the wire (both directions) ---------------------------------


def test_key_mode_sends_bearer_and_no_cookie(logged_in, runner):
    # `logged_in` seeds a saved session on purpose: the cookie is available, and must
    # still not be sent.
    result, _api, v1_route = _run_keys_list(runner, ["--base-url", BASE, "--api-key", KEY])
    assert result.exit_code == 0, result.output
    headers = v1_route.calls.last.request.headers
    assert headers["authorization"] == f"Bearer {KEY}"
    assert "cookie" not in headers, "an API-key request must never carry ae_session"


def test_session_mode_sends_cookie_and_no_bearer(logged_in, runner):
    result, api_route, _v1 = _run_keys_list(runner, [])
    assert result.exit_code == 0, result.output
    headers = api_route.calls.last.request.headers
    assert "ae_session=tok" in headers.get("cookie", "")
    assert "authorization" not in headers


# --- the org header ----------------------------------------------------------


def test_key_mode_never_sends_the_saved_org(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, org="human-org"))
    result, _api, v1_route = _run_keys_list(runner, ["--api-key", KEY])
    assert result.exit_code == 0, result.output
    assert "x-agenteye-org" not in v1_route.calls.last.request.headers


def test_key_mode_sends_an_explicit_org(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, org="human-org"))
    result, _api, v1_route = _run_keys_list(runner, ["--api-key", KEY, "--org", "acme"])
    assert result.exit_code == 0, result.output
    assert v1_route.calls.last.request.headers["x-agenteye-org"] == "acme"


def test_session_mode_still_sends_the_saved_org(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, session_token="tok",
                                        expires_at="2999-01-01T00:00:00Z", org="human-org"))
    result, api_route, _v1 = _run_keys_list(runner, [])
    assert result.exit_code == 0, result.output
    assert api_route.calls.last.request.headers["x-agenteye-org"] == "human-org"


# --- the key never reaches disk ---------------------------------------------


def test_api_key_is_never_persisted(home, runner):
    result, _api, _v1 = _run_keys_list(runner, ["--base-url", BASE, "--api-key", KEY])
    assert result.exit_code == 0, result.output
    path = config.config_path()
    on_disk = path.read_text() if path.exists() else ""
    assert KEY not in on_disk
    # And no field quietly holds it either (a new CliConfig field would be the way
    # this regresses).
    assert KEY not in json.dumps(config.load_config().__dict__)


def test_api_key_is_not_persisted_by_whoami(home, runner):
    result = runner.invoke(app, ["--base-url", BASE, "--api-key", KEY, "--json", "whoami"])
    assert result.exit_code == 0, result.output
    path = config.config_path()
    assert KEY not in (path.read_text() if path.exists() else "")


# --- whoami in key mode is the documented exception --------------------------


def test_whoami_key_mode_exits_0_with_honest_shape(logged_in, runner):
    with respx.mock(assert_all_called=False) as mock:
        catch_all = mock.route().mock(return_value=httpx.Response(200, json={}))
        result = runner.invoke(
            app, ["--base-url", BASE, "--api-key", KEY, "--org", "acme", "--json", "whoami"]
        )
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {
        "logged_in": False,
        "auth_mode": "api_key",
        "active_org": "acme",
    }
    assert catch_all.call_count == 0  # a key has no identity to look up


def test_whoami_key_mode_reports_no_org_when_none_given(home, runner):
    config.save_config(config.CliConfig(base_url=BASE, org="human-org"))
    result = runner.invoke(app, ["--api-key", KEY, "--json", "whoami"])
    assert result.exit_code == 0, result.output
    # The SAVED org is not the key's org, so it must not be reported as active.
    assert json.loads(result.stdout)["active_org"] is None


def test_whoami_human_shapes_carry_auth_mode(home, runner):
    result = runner.invoke(app, ["--base-url", BASE, "--json", "whoami"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"logged_in": False, "auth_mode": "none"}


# --- AppState default --------------------------------------------------------


def test_appstate_defaults_to_none_mode():
    # An AppState built by another path (tests, embedders) must never be silently
    # treated as key mode.
    state = AppState(json=False, base_url=None, token=None, timeout=30.0,
                     config=config.CliConfig())
    assert state.auth_mode is AuthMode.NONE
    assert state.api_key is None
