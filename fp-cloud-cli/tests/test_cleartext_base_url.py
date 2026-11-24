"""Plain http to another machine is refused before any credential is sent.

FailproofAI/agenteye#1799: `--base-url` / `FP_DASHBOARD_URL` / the saved config were
only checked for a scheme, so `http://` to any host was accepted, and every request then
carried the session cookie or API key in clear (and `login` sent the emailed code and got
the session back over it). Loopback stays allowed: it has no network path to read.
"""

from __future__ import annotations

import re

import httpx
import pytest
import respx

from fp_cli import config
from fp_cli._context import plain_http_destination
from fp_cli.app import app

REMOTE_HTTP = [
    "http://dash.example.com",
    "http://10.0.0.5:3000",
    "http://dash.internal:3000/",
    "http://localhost.example.com",
    "http://[2001:db8::1]:3000",
    "http://0.0.0.0:3000",
]


def _said(result) -> str:
    """Everything the command printed, with Typer's error box and line wrapping undone."""
    text = (result.stdout or "") + (getattr(result, "stderr", "") or "")
    return re.sub(r"[\s│╭╮╰╯─]+", " ", text)


LOOPBACK_HTTP = [
    "http://localhost:3000",
    "http://LOCALHOST:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.2:3000",
    "http://[::1]:3000",
]


@pytest.mark.parametrize("url", REMOTE_HTTP)
def test_plain_http_to_another_host_is_named(url):
    assert plain_http_destination(url) is not None


@pytest.mark.parametrize(
    "url", LOOPBACK_HTTP + ["https://dash.example.com", "https://10.0.0.5:3000", "", None]
)
def test_https_and_loopback_http_are_not(url):
    assert plain_http_destination(url) is None


def test_the_named_destination_never_carries_userinfo():
    shown = plain_http_destination("http://alice:hunter2@dash.example.com:3000/x?y=1")
    assert shown == "http://dash.example.com:3000"


def test_an_unparseable_http_url_is_refused_rather_than_guessed():
    assert plain_http_destination("http://[::1:3000") is not None


@pytest.mark.parametrize("url", REMOTE_HTTP)
def test_flag_env_and_saved_config_are_all_refused_before_a_request(url, home, runner, monkeypatch):
    config.save_config(
        config.CliConfig(base_url=url, session_token="tok", expires_at="2999-01-01T00:00:00Z")
    )
    with respx.mock(assert_all_called=False) as router:
        anything = router.route().respond(200, json={})
        via_flag = runner.invoke(app, ["--base-url", url, "sessions"])
        monkeypatch.setenv("FP_DASHBOARD_URL", url)
        via_env = runner.invoke(app, ["sessions"])
        monkeypatch.delenv("FP_DASHBOARD_URL")
        via_saved = runner.invoke(app, ["whoami"])
    for result in (via_flag, via_env, via_saved):
        assert result.exit_code == 2, _said(result)
        assert "over plain http" in _said(result)
    assert not anything.called


def test_login_and_api_key_mode_are_refused_too(home, runner):
    with respx.mock(assert_all_called=False) as router:
        anything = router.route().respond(200, json={})
        login = runner.invoke(app, ["--base-url", "http://dash.example.com", "login", "--email", "a@b.co"])
        keyed = runner.invoke(
            app, ["--base-url", "http://dash.example.com", "--api-key", "ak_x", "sessions"]
        )
    for result in (login, keyed):
        assert result.exit_code == 2, _said(result)
        assert "over plain http" in _said(result)
    assert not anything.called


@pytest.mark.parametrize("url", LOOPBACK_HTTP)
def test_loopback_http_still_reaches_a_local_stack(url, home, runner):
    with respx.mock(assert_all_called=False) as router:
        sessions = router.get(f"{url}/api/sessions").mock(side_effect=httpx.ConnectError("down"))
        result = runner.invoke(app, ["--base-url", url, "--token", "tok", "sessions"])
    assert result.exit_code == 3, _said(result)  # the request went out, and found nothing
    assert sessions.called


def test_version_needs_no_network_and_is_not_refused(home, runner):
    result = runner.invoke(app, ["--base-url", "http://dash.example.com", "version"])
    assert result.exit_code == 0, _said(result)


def test_logout_clears_an_old_plain_http_session_without_sending_it(home, runner):
    """A base URL saved by an older CLI must not trap its session on disk."""
    config.save_config(
        config.CliConfig(
            base_url="http://dash.internal:3000",
            session_token="tok",
            expires_at="2999-01-01T00:00:00Z",
        )
    )
    with respx.mock(assert_all_called=False) as router:
        anything = router.route().respond(200, json={})
        result = runner.invoke(app, ["logout"])
    assert result.exit_code == 0, _said(result)
    assert config.load_config().session_token is None
    assert not anything.called
    assert "not revoking" in _said(result)
