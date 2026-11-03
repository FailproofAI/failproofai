from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from fp_cli import auth, config
from fp_cli.errors import ApiError, AuthError, NetworkError

BASE = "http://dash.test"


@respx.mock
def test_request_otp_ok():
    route = respx.post(f"{BASE}/api/auth/otp/request").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    auth.request_otp(BASE, "me@test")
    assert route.called
    assert json.loads(route.calls.last.request.read()) == {"email": "me@test"}
    # Marks a CLI login so the server emails the paste-into-terminal OTP variant.
    assert route.calls.last.request.headers["X-AgentEye-Client"] == "cli"


@respx.mock
def test_request_otp_server_error_raises():
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(502))
    with pytest.raises(ApiError):
        auth.request_otp(BASE, "me@test")


@respx.mock
def test_verify_otp_reads_token_from_set_cookie_not_body():
    # The dashboard returns user + expires_in_secs in the body and the token only
    # in the Set-Cookie header — verify we read it from the cookie.
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-xyz; HttpOnly; Path=/; Max-Age=3600"},
        )
    )
    token, expires_in, user = auth.verify_otp(BASE, "me@test", "123456")
    assert token == "tok-xyz"
    assert expires_in == 3600
    assert user["email"] == "me@test"


@respx.mock
def test_verify_otp_wrong_code_is_auth_error():
    respx.post(f"{BASE}/api/auth/otp/verify").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(AuthError):
        auth.verify_otp(BASE, "me@test", "000000")


@respx.mock
def test_verify_otp_without_cookie_is_auth_error():
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(200, json={"user": {}, "expires_in_secs": 3600})
    )
    with pytest.raises(AuthError):
        auth.verify_otp(BASE, "me@test", "123456")


@respx.mock
def test_verify_otp_network_error():
    respx.post(f"{BASE}/api/auth/otp/verify").mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(NetworkError):
        auth.verify_otp(BASE, "me@test", "123456")


def test_persist_session_computes_expiry_and_writes_0600(home):
    cfg = config.CliConfig()
    now = datetime(2026, 5, 25, 12, 0, 0, tzinfo=timezone.utc)
    auth.persist_session(cfg, BASE, "tok", 3600, {"email": "me@test", "id": "u1"}, now=now)

    reloaded = config.load_config()
    assert reloaded.session_token == "tok"
    assert reloaded.expires_at == "2026-05-25T13:00:00Z"
    assert reloaded.email == "me@test"
    assert reloaded.user_id == "u1"
    assert reloaded.base_url == BASE
    assert not config.is_expired(reloaded, now=now)


@respx.mock
def test_logout_is_best_effort_on_network_error():
    respx.post(f"{BASE}/api/auth/logout").mock(side_effect=httpx.ConnectError("down"))
    # Must not raise even though the server is unreachable.
    auth.logout(BASE, "tok")


def test_logout_noop_without_token():
    # No registered routes — if it tried to call out, respx would complain.
    auth.logout(BASE, None)
