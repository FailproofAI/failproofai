"""`fp login` from a browser: the client half of `/api/auth/cli/*`, and the plain flow.

The box itself needs a real terminal, so `__tests__/e2e/layout/fp-login.sh` drives it
through a pty against a real stack. What is pinned here is everything that decides
what a server's answer means, because each mistake there is silent: a Cloud that drops
`kind` hands back a machine key, and a poll that gives up reads as a person's "no".
"""

from __future__ import annotations

import json
import time

import httpx
import pytest
import respx

from fp_cli import auth, config
from fp_cli import select as selectmod
from fp_cli._context import AppState
from fp_cli.app import app
from fp_cli.commands import auth_cmds
from fp_cli.errors import ApiError, AuthError, NetworkError

BASE = "http://dash.test"
LINK = f"{BASE}/cli/authorize?r=abc"
STARTED = {
    "verification_url": LINK,
    "poll_secret": "POLL",
    "expires_in": 600,
    "interval": 2,
    "kind": "session",
}
SESSION = {
    "id": "u1",
    "email": "me@test",
    "is_instance_admin": False,
    "memberships": [
        {"org_id": "o1", "org_slug": "acme", "org_name": "Acme", "permissions": [], "permission_set": "admin"}
    ],
}
CLAIMED = {"session_token": "tok-browser", "expires_in_secs": 3600, "user": {"id": "u1", "email": "me@test"}}


def _start(**over):
    return httpx.Response(over.pop("status", 201), json={**STARTED, **over})


# --- start ------------------------------------------------------------------


@respx.mock
def test_start_asks_for_a_session_and_names_the_machine():
    route = respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start())
    login = auth.start_browser_login(BASE)
    assert login == auth.BrowserLogin(LINK, "POLL", 600, 2)
    sent = json.loads(route.calls[0].request.content)
    assert sent["kind"] == "session"
    assert sent["machine_label"]
    assert sent["cli_version"].startswith("fp ")


@respx.mock
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404),
        httpx.Response(302, headers={"location": f"{BASE}/login"}),
        httpx.Response(200, text="<html>a page, not this API</html>"),
        # A Cloud with `failproofai config`'s login but not this: it dropped `kind`,
        # and approving this request would end in a machine key.
        httpx.Response(201, json={k: v for k, v in STARTED.items() if k != "kind"}),
        httpx.Response(201, json={**STARTED, "kind": "machine_key"}),
        httpx.Response(201, json={"kind": "session"}),
        httpx.Response(201, json={**STARTED, "poll_secret": ""}),
    ],
)
def test_a_cloud_that_cannot_do_this_reads_as_unsupported(response):
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=response)
    assert auth.start_browser_login(BASE) is None


@respx.mock
@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ssh://dash.test",
        "http://",
        "https://:443/cli/authorize?r=abc",
        "https://dash.test:99999/cli/authorize?r=abc",
        "https://dash.test:0/cli/authorize?r=abc",
        "https://[broken/cli/authorize?r=abc",
        f"{LINK}\x1b]0;pwned\x07",
        f"{LINK} --and-more",
        None,
    ],
)
def test_only_a_plain_http_link_is_ever_printed_or_opened(url):
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start(verification_url=url))
    assert auth.start_browser_login(BASE) is None


@respx.mock
def test_start_failures_say_what_kind_of_failure_they_are():
    route = respx.post(f"{BASE}/api/auth/cli/start")
    route.mock(return_value=httpx.Response(429, json={"error": "rate_limited"}))
    with pytest.raises(ApiError, match="Too many"):
        auth.start_browser_login(BASE)
    route.mock(return_value=httpx.Response(502, json={"error": "upstream unreachable"}))
    with pytest.raises(NetworkError):
        auth.start_browser_login(BASE)
    route.mock(return_value=httpx.Response(422, json={"error": "machine_label_required"}))
    with pytest.raises(ApiError, match="HTTP 422"):
        auth.start_browser_login(BASE)
    route.mock(side_effect=httpx.ConnectError("no route"))
    with pytest.raises(NetworkError):
        auth.start_browser_login(BASE)


@respx.mock
def test_a_servers_numbers_are_kept_to_a_range_this_client_can_live_with():
    route = respx.post(f"{BASE}/api/auth/cli/start")
    route.mock(return_value=_start(expires_in=10**9, interval=0.001))
    login = auth.start_browser_login(BASE)
    assert (login.expires_in, login.interval) == (3600, 1)
    route.mock(return_value=_start(expires_in="soon", interval=True))
    login = auth.start_browser_login(BASE)
    assert (login.expires_in, login.interval) == (600, 2)
    # JSON integers have no size limit, and a float can be infinite.
    route.mock(return_value=_start(expires_in=10**400, interval=10**400))
    login = auth.start_browser_login(BASE)
    assert (login.expires_in, login.interval) == (3600, 30)
    route.mock(return_value=httpx.Response(201, text=json.dumps(STARTED).replace("600", "Infinity")))
    assert auth.start_browser_login(BASE).expires_in == 600


# --- poll -------------------------------------------------------------------


@respx.mock
@pytest.mark.parametrize(
    "status", ["pending", "slow_down", "approved", "denied", "expired", "claimed"]
)
def test_poll_reports_each_status(status):
    respx.post(f"{BASE}/api/auth/cli/poll").mock(return_value=httpx.Response(200, json={"status": status}))
    assert auth.poll_browser_login(BASE, "POLL") == status


@respx.mock
def test_poll_tells_unknown_from_try_again():
    route = respx.post(f"{BASE}/api/auth/cli/poll")
    route.mock(return_value=httpx.Response(404, json={"status": "unknown"}))
    assert auth.poll_browser_login(BASE, "POLL") == "unknown"
    route.mock(return_value=httpx.Response(200, json={"status": "something new"}))
    assert auth.poll_browser_login(BASE, "POLL") == "unknown"
    for answer in (httpx.Response(500), httpx.Response(200, text="not json")):
        route.mock(return_value=answer)
        with pytest.raises(NetworkError):
            auth.poll_browser_login(BASE, "POLL")


def _quick(expires_in=60.0):
    return auth.BrowserLogin(LINK, "POLL", expires_in, 0.0)


@respx.mock
def test_waiting_carries_on_through_a_dropped_connection():
    respx.post(f"{BASE}/api/auth/cli/poll").mock(
        side_effect=[
            httpx.Response(200, json={"status": "pending"}),
            httpx.ConnectError("wifi went away"),
            httpx.Response(500),
            httpx.Response(200, json={"status": "slow_down"}),
            httpx.Response(200, json={"status": "approved"}),
        ]
    )
    seen = []
    # `slow_down` adds a second before the next poll: the tick is what passes it.
    def tick(_left, offline):
        seen.append(offline)
        time.sleep(0.05)

    assert auth.await_browser_approval(BASE, _quick(), tick=tick) == "approved"
    assert True in seen, "a dropped connection is shown to the person"
    assert seen[-1] is False, "and clears once the server answers"


@respx.mock
@pytest.mark.parametrize("final", ["denied", "expired", "claimed"])
def test_waiting_ends_on_any_final_answer(final):
    respx.post(f"{BASE}/api/auth/cli/poll").mock(return_value=httpx.Response(200, json={"status": final}))
    assert auth.await_browser_approval(BASE, _quick(), tick=lambda *_: None) == final


@respx.mock
def test_waiting_gives_up_when_the_link_runs_out():
    route = respx.post(f"{BASE}/api/auth/cli/poll")
    assert auth.await_browser_approval(BASE, _quick(expires_in=0.0), tick=lambda *_: None) == "expired"
    assert not route.called


# --- claim ------------------------------------------------------------------


@respx.mock
def test_claim_returns_the_session_in_the_shape_of_the_emailed_code():
    respx.post(f"{BASE}/api/auth/cli/claim").mock(return_value=httpx.Response(201, json=CLAIMED))
    assert auth.claim_browser_login(BASE, "POLL") == ("tok-browser", 3600, CLAIMED["user"])


@respx.mock
@pytest.mark.parametrize("lifetime,saved", [(10**400, 30 * 86400), (0, 86400), ("soon", 86400), (None, 86400)])
def test_a_servers_session_lifetime_cannot_crash_saving_it(home, lifetime, saved):
    respx.post(f"{BASE}/api/auth/cli/claim").mock(
        return_value=httpx.Response(201, json={**CLAIMED, "expires_in_secs": lifetime})
    )
    token, expires_in, user = auth.claim_browser_login(BASE, "POLL")
    assert expires_in == saved
    auth.persist_session(config.load_config(), BASE, token, expires_in, user)
    assert config.load_config().session_token == "tok-browser"


@respx.mock
def test_claim_refuses_anything_but_a_session():
    route = respx.post(f"{BASE}/api/auth/cli/claim")
    # What a machine-key request would answer. Never saved as if it were a session.
    route.mock(return_value=httpx.Response(201, json={"api_key": "KEY", "key_id": "k"}))
    with pytest.raises(AuthError):
        auth.claim_browser_login(BASE, "POLL")
    for status in (403, 409, 410):
        route.mock(return_value=httpx.Response(status, json={"error": "approval_revoked"}))
        with pytest.raises(AuthError) as err:
            auth.claim_browser_login(BASE, "POLL")
        assert err.value.hint == "run fp login again"
    route.mock(return_value=httpx.Response(500))
    with pytest.raises(NetworkError):
        auth.claim_browser_login(BASE, "POLL")


@respx.mock
@pytest.mark.parametrize(
    "user",
    [None, {}, {"id": "u1"}, {"email": "me@test"}, {"id": "u1", "email": ""}, {"id": "u1", "email": "\x1b\u200b"}, "me"],
)
def test_a_claim_with_no_identity_is_no_login(user):
    # `persist_session` keeps the previous identity when a field is missing, so this
    # would otherwise save the new session under whoever was signed in before.
    respx.post(f"{BASE}/api/auth/cli/claim").mock(
        return_value=httpx.Response(201, json={**CLAIMED, "user": user})
    )
    with pytest.raises(AuthError):
        auth.claim_browser_login(BASE, "POLL")


@respx.mock
def test_what_the_server_says_about_the_person_cannot_drive_the_terminal():
    evil = "me\x1b]0;pwned\x07@te‮st\x1b[2J"
    respx.post(f"{BASE}/api/auth/cli/claim").mock(
        return_value=httpx.Response(201, json={**CLAIMED, "user": {"id": "u1", "email": evil}})
    )
    _, _, user = auth.claim_browser_login(BASE, "POLL")
    assert user["email"] == "me]0;pwned@test[2J"
    assert auth.display_text("\x1b​  ") is None
    assert auth.display_text(7) is None


# --- opening a browser ------------------------------------------------------


@pytest.mark.parametrize(
    "env,platform,expected",
    [
        ({"DISPLAY": ":0"}, "linux", True),
        ({"WAYLAND_DISPLAY": "wayland-0"}, "linux", True),
        ({}, "linux", False),
        ({"DISPLAY": ":0", "SSH_TTY": "/dev/pts/1"}, "linux", False),
        ({"SSH_CONNECTION": "1.2.3.4 1 5.6.7.8 22"}, "darwin", False),
        ({"SSH_CLIENT": "1.2.3.4 1 22"}, "win32", False),
        ({}, "darwin", True),
        ({}, "win32", True),
    ],
)
def test_a_browser_is_only_opened_where_a_person_can_see_it(env, platform, expected):
    assert auth.can_open_browser(env, platform) is expected


def test_opening_uses_the_platform_handler_detached_and_never_raises(monkeypatch):
    calls = []

    def popen(argv, **kw):
        calls.append((argv, kw))

    monkeypatch.setattr(auth.subprocess, "Popen", popen)
    auth.open_url(LINK, "linux")
    auth.open_url(LINK, "darwin")
    assert [c[0] for c in calls] == [["xdg-open", LINK], ["open", LINK]]
    assert calls[0][1]["start_new_session"] is True
    assert calls[0][1]["stdin"] is auth.subprocess.DEVNULL

    def missing(*_a, **_k):
        raise FileNotFoundError("xdg-open")

    monkeypatch.setattr(auth.subprocess, "Popen", missing)
    auth.open_url(LINK, "linux")


# --- the box, at the moment it claims ----------------------------------------


class _Box:
    """A login box with a queue of keys already pressed. `fp-login.sh` drives the real one."""

    def __init__(self, *keys):
        self.keys = list(keys)

    def working(self, _text):
        pass

    def wait_key(self, _seconds):
        key = self.keys.pop(0) if self.keys else None
        if key == "ESC":
            raise selectmod.LoginCancelled()
        return key


@pytest.fixture
def approved_link(monkeypatch):
    """A link whose last poll came back approved; returns the list of claims made."""
    claims = []
    monkeypatch.setattr(auth, "can_open_browser", lambda *_a: False)
    monkeypatch.setattr(auth, "start_browser_login", lambda *_a, **_k: auth.BrowserLogin(LINK, "POLL", 60.0, 1.0))
    monkeypatch.setattr(auth, "await_browser_approval", lambda *_a, **_k: "approved")

    def claim(*_a, **_k):
        claims.append(1)
        return ("tok", 3600, CLAIMED["user"])

    monkeypatch.setattr(auth, "claim_browser_login", claim)
    return claims


def _state():
    return AppState(json=False, base_url=BASE, token=None, timeout=1.0, config=config.CliConfig())


@pytest.mark.parametrize("before", [(), ("x",), ("UP",), ("", "")], ids=["alone", "letter", "arrow", "non-ascii"])
def test_esc_pressed_during_the_last_poll_means_no_session(approved_link, before):
    # A non-ASCII character reads as "", once per byte: not the end of the queue.
    with pytest.raises(selectmod.LoginCancelled):
        auth_cmds._browser_login_in_box(_state(), BASE, _Box(*before, "ESC"))
    assert approved_link == []


def test_any_other_key_pressed_during_the_last_poll_changes_nothing(approved_link):
    assert auth_cmds._browser_login_in_box(_state(), BASE, _Box("x", "ENTER"))[0] == "tok"
    assert approved_link == [1]


# --- the command, on a terminal with no raw mode ----------------------------
#
# The box needs termios and a real pty, so this is the path CliRunner can reach:
# stdin stubbed as a terminal, the box stubbed as unavailable. It is what Windows gets,
# and every decision it makes about a server's answer is the box's too.


@pytest.fixture
def plain_terminal(monkeypatch):
    monkeypatch.setattr("fp_cli.select.stdin_is_tty", lambda: True)
    monkeypatch.setattr("fp_cli.select.login_box_supported", lambda: False)
    # Never a real browser from a test run, wherever it runs.
    monkeypatch.setattr(auth, "open_url", lambda *_a, **_k: pytest.fail("opened a browser"))
    monkeypatch.setenv("SSH_TTY", "/dev/pts/1")


def _approved_on_first_poll():
    respx.post(f"{BASE}/api/auth/cli/poll").mock(return_value=httpx.Response(200, json={"status": "approved"}))
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=SESSION))


def _fast_links(monkeypatch):
    real = auth.start_browser_login

    def start(*a, **k):
        login = real(*a, **k)
        return login and auth.BrowserLogin(login.verification_url, login.poll_secret, 60.0, 0.0)

    monkeypatch.setattr(auth, "start_browser_login", start)


@respx.mock
def test_choosing_browser_signs_in_without_any_email(home, runner, plain_terminal, monkeypatch):
    _fast_links(monkeypatch)
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start())
    respx.post(f"{BASE}/api/auth/cli/claim").mock(return_value=httpx.Response(201, json=CLAIMED))
    _approved_on_first_poll()
    otp = respx.post(f"{BASE}/api/auth/otp/request")

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="\n")

    assert result.exit_code == 0, result.output
    assert LINK in result.output
    assert not otp.called
    cfg = config.load_config()
    assert (cfg.session_token, cfg.email, cfg.org) == ("tok-browser", "me@test", "acme")


@respx.mock
def test_a_cloud_without_browser_login_falls_back_to_the_emailed_code(home, runner, plain_terminal):
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=httpx.Response(404))
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-otp; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=SESSION))

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="browser\nme@test\n123456\n")

    assert result.exit_code == 0, result.output
    assert "no browser login" in result.output
    assert config.load_config().session_token == "tok-otp"


@respx.mock
def test_a_cloud_that_dropped_the_kind_is_never_claimed_from(home, runner, plain_terminal):
    respx.post(f"{BASE}/api/auth/cli/start").mock(
        return_value=httpx.Response(201, json={k: v for k, v in STARTED.items() if k != "kind"})
    )
    claim = respx.post(f"{BASE}/api/auth/cli/claim")
    poll = respx.post(f"{BASE}/api/auth/cli/poll")
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(return_value=httpx.Response(401))

    runner.invoke(app, ["--base-url", BASE, "login"], input="browser\nme@test\n000000\n")

    assert not poll.called and not claim.called


@respx.mock
@pytest.mark.parametrize("final", ["denied", "expired", "claimed"])
def test_a_link_that_ends_leaves_nothing_saved(home, runner, plain_terminal, monkeypatch, final):
    _fast_links(monkeypatch)
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start())
    respx.post(f"{BASE}/api/auth/cli/poll").mock(return_value=httpx.Response(200, json={"status": final}))
    claim = respx.post(f"{BASE}/api/auth/cli/claim")

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="browser\n")

    assert result.exit_code == 4, result.output
    assert not claim.called
    assert config.load_config().session_token is None


@respx.mock
def test_a_typo_at_the_prompt_asks_again_instead_of_starting_a_login(home, runner, plain_terminal):
    start = respx.post(f"{BASE}/api/auth/cli/start")
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(return_value=httpx.Response(401))

    runner.invoke(app, ["--base-url", BASE, "login"], input="emial\nemail\nme@test\n000000\n")

    assert not start.called


@respx.mock
def test_ctrl_c_while_waiting_cancels_calmly(home, runner, plain_terminal, monkeypatch):
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start())
    claim = respx.post(f"{BASE}/api/auth/cli/claim")

    def interrupted(*_a, **_k):
        raise KeyboardInterrupt()

    monkeypatch.setattr(auth, "await_browser_approval", interrupted)

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="browser\n")

    assert result.exit_code == 0, result.output
    assert "cancelled" in result.output
    assert not claim.called
    assert config.load_config().session_token is None


@respx.mock
def test_the_plain_flow_says_when_it_is_reconnecting_once(home, runner, plain_terminal, monkeypatch):
    _fast_links(monkeypatch)
    respx.post(f"{BASE}/api/auth/cli/start").mock(return_value=_start())
    respx.post(f"{BASE}/api/auth/cli/poll").mock(
        side_effect=[
            httpx.ConnectError("x"),
            httpx.ConnectError("x"),
            httpx.Response(200, json={"status": "pending"}),
            httpx.Response(200, json={"status": "approved"}),
        ]
    )
    respx.post(f"{BASE}/api/auth/cli/claim").mock(return_value=httpx.Response(201, json=CLAIMED))
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=SESSION))

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="browser\n")

    assert result.exit_code == 0, result.output
    assert result.output.count("reconnecting") == 1
    assert "back online" in result.output


@respx.mock
def test_choosing_email_never_touches_the_browser_routes(home, runner, plain_terminal):
    start = respx.post(f"{BASE}/api/auth/cli/start")
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-otp; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=SESSION))

    result = runner.invoke(app, ["--base-url", BASE, "login"], input="email\nme@test\n123456\n")

    assert result.exit_code == 0, result.output
    assert not start.called


@respx.mock
@pytest.mark.parametrize(
    "args,tty,stdin",
    [
        (["--base-url", BASE, "login", "--email", "me@test"], True, "123456\n"),
        (["--base-url", BASE, "--json", "login"], True, "me@test\n123456\n"),
        (["--base-url", BASE, "login"], False, "me@test\n123456\n"),
    ],
)
def test_email_flag_json_and_no_terminal_never_see_the_menu(home, runner, monkeypatch, args, tty, stdin):
    monkeypatch.setattr("fp_cli.select.stdin_is_tty", lambda: tty)
    monkeypatch.setattr("fp_cli.select.login_box_supported", lambda: False)
    start = respx.post(f"{BASE}/api/auth/cli/start")
    respx.post(f"{BASE}/api/auth/otp/request").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.post(f"{BASE}/api/auth/otp/verify").mock(
        return_value=httpx.Response(
            200,
            json={"user": {"id": "u1", "email": "me@test"}, "expires_in_secs": 3600},
            headers={"set-cookie": "ae_session=tok-otp; Path=/"},
        )
    )
    respx.get(f"{BASE}/api/auth/session").mock(return_value=httpx.Response(200, json=SESSION))

    result = runner.invoke(app, args, input=stdin)

    assert result.exit_code == 0, result.output
    assert not start.called
    assert config.load_config().session_token == "tok-otp"
