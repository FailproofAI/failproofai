"""Signing in against the dashboard. Both ways end in the same session.

Emailed code: ``/api/auth/otp/request`` (sends a code) then ``/api/auth/otp/verify``.
The verify response carries the session token in the ``ae_session`` **Set-Cookie**
header (not the JSON body), so we read it from ``response.cookies``.

Browser: ``/api/auth/cli/start`` returns a link and a poll secret, a person approves
the link while this polls ``/poll`` with the secret, then ``/claim`` creates the
session and returns it, once. The token is in the JSON body there: nothing is setting a
browser cookie. The other end is ``server/src/routes/cli_login.rs`` in AgentEye.
"""

from __future__ import annotations

import math
import os
import platform as platform_info
import re
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Mapping, Optional, Tuple
from urllib.parse import urlsplit

import uuid

import httpx

from ._version import __version__
from .config import CliConfig, save_config
from .client import _request_id_of
from .errors import ApiError, AuthError, NetworkError


def _request_id_header() -> Dict[str, str]:
    """A fresh request id for one login-flow call — same shape as the client's."""
    return {"x-request-id": uuid.uuid4().hex}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _network_error(base_url: str, exc: Exception) -> NetworkError:
    return NetworkError(f"Cannot reach FailproofAI Cloud at {base_url}: {exc}")


def request_otp(
    base_url: str,
    email: str,
    *,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> None:
    """Ask the dashboard to email a login code. Always succeeds quietly for a
    valid request (the server returns 200 even for unknown emails)."""
    try:
        with httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            verify=verify,
            headers=_request_id_header(),
        ) as client:
            # Mark this as a CLI login so the server emails the paste-into-terminal
            # OTP template (with no "open the dashboard" button) instead of the
            # browser one.
            response = client.post(
                "/api/auth/otp/request",
                json={"email": email},
                headers={"X-AgentEye-Client": "cli"},
            )
    except httpx.RequestError as exc:
        raise _network_error(base_url, exc)
    if response.status_code >= 400:
        raise ApiError(
            f"Failed to request a login code (HTTP {response.status_code}).",
            status=response.status_code,
            request_id=_request_id_of(response),
        )


def verify_otp(
    base_url: str,
    email: str,
    code: str,
    *,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> Tuple[str, int, Dict[str, Any]]:
    """Exchange the code for a session token. Returns ``(token, expires_in_secs, user)``."""
    try:
        with httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            verify=verify,
            headers=_request_id_header(),
        ) as client:
            response = client.post(
                "/api/auth/otp/verify", json={"email": email, "code": code}
            )
    except httpx.RequestError as exc:
        raise _network_error(base_url, exc)

    if response.status_code == 401:
        raise AuthError(
            "That code didn't match or has expired. Sign in again with fp login.",
            request_id=_request_id_of(response),
        )
    if response.status_code == 429:
        raise ApiError(
            "Too many attempts — wait a bit, then run fp login again.",
            status=429,
            request_id=_request_id_of(response),
        )
    if response.status_code >= 400:
        # The dashboard proxy collapses the server's wrong/expired-code 401 into a 500 (its
        # `await res.json()` throws on the server's empty 401 body). So a non-401 4xx/5xx at the
        # verify step is, in practice, a bad/expired code — surface it as a clean auth failure,
        # not a raw "HTTP 500". (Real unreachability is a NetworkError, handled above.)
        raise AuthError(
            "That code didn't match or has expired. Sign in again with fp login.",
            request_id=_request_id_of(response),
        )

    token = response.cookies.get("ae_session")
    if not token:
        raise AuthError("The dashboard did not return a session token.")

    try:
        body = response.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    try:
        expires_in = int(body.get("expires_in_secs"))
    except (TypeError, ValueError):
        expires_in = 86400

    user = body.get("user") or {}
    if not isinstance(user, dict):
        user = {}

    return token, expires_in, user


#: Sent at start and required back. A Cloud from before this feature's server half
#: drops the field and would end the request in a machine key, so a missing echo
#: means "no browser login here": nothing gets approved, and nothing gets minted.
BROWSER_LOGIN_KIND = "session"

#: A poll stalled on a bad connection freezes the countdown and the Esc key with it.
_POLL_TIMEOUT_SECS = 10.0

# Controls (a terminal executes them), bidi overrides and isolates, and zero-width
# formatting. Same set as `displayText` in the npm CLI's `cloud-login.ts`.
_INVISIBLE = re.compile(
    "[\u0000-\u001f\u007f-\u009f؜᠎​-‏‪-‮⁠-⁩﻿]"
)


#: What a session token can be and still be sent back on every later request. A real one is
#: 64 hex characters; a cookie or a header can't carry a control or a non-ASCII character.
_SESSION_TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{1,4096}")


def display_text(value: Any, max_chars: int = 200) -> Optional[str]:
    """A server-supplied string made safe to print, or ``None`` if nothing is left."""
    if not isinstance(value, str):
        return None
    return _INVISIBLE.sub("", value).strip()[:max_chars] or None


def _machine_label() -> str:
    """This machine's name, always sendable. Python hands back a hostname's non-UTF-8 bytes
    as surrogates, which JSON can't carry, and the server refuses a label with nothing in it."""
    name = socket.gethostname().encode("utf-8", "replace").decode("utf-8")
    return display_text(name) or "unknown"


def _within(value: Any, low: float, high: float, fallback: float) -> float:
    """A server's number, kept to a range this client can live with."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    # `isfinite` only on a float: JSON integers have no size limit, and past a float's
    # range it raises instead of answering.
    if (isinstance(value, float) and not math.isfinite(value)) or value <= 0:
        return fallback
    return min(high, max(low, value))


def _is_openable(url: Any) -> bool:
    """Only a plain http(s) link is printed or handed to the opener: it comes from the
    server, and ``xdg-open`` will act on any scheme it knows."""
    if not isinstance(url, str) or not all(33 <= ord(c) < 127 for c in url):
        return False
    try:
        parts = urlsplit(url)
        return parts.scheme in ("http", "https") and bool(parts.hostname) and parts.port != 0
    except ValueError:  # malformed, or `.port` past 65535
        return False


def can_open_browser(
    env: Mapping[str, str] = os.environ, platform: str = sys.platform
) -> bool:
    """False over SSH, where a browser would start on the remote machine, and on a Linux
    box with no display. A guess: being wrong costs a browser that doesn't appear next to
    a link that is printed anyway."""
    if env.get("SSH_CONNECTION") or env.get("SSH_CLIENT") or env.get("SSH_TTY"):
        return False
    if platform.startswith("linux") and not env.get("DISPLAY") and not env.get("WAYLAND_DISPLAY"):
        return False
    return True


def open_url(url: str, platform: str = sys.platform) -> None:
    """Open a link with the platform's handler. Never raises: the link is on screen.

    Not ``webbrowser``: it falls back to text browsers like lynx, which would take over
    this terminal in the middle of the login box."""
    try:
        if platform == "win32":
            os.startfile(url)  # type: ignore[attr-defined]
            return
        subprocess.Popen(
            ["open" if platform == "darwin" else "xdg-open", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def _post_login(
    base_url: str,
    path: str,
    body: Dict[str, Any],
    *,
    timeout: float,
    transport: Optional[httpx.BaseTransport],
    verify: bool,
) -> httpx.Response:
    try:
        with httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            verify=verify,
            headers=_request_id_header(),
        ) as client:
            return client.post(path, json=body)
    except httpx.RequestError as exc:
        raise _network_error(base_url, exc)


def _json_object(response: httpx.Response) -> Optional[Dict[str, Any]]:
    try:
        body = response.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


@dataclass(frozen=True)
class BrowserLogin:
    verification_url: str
    poll_secret: str
    expires_in: float
    interval: float
    started: float = field(default_factory=time.monotonic, compare=False)


def start_browser_login(
    base_url: str,
    *,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> Optional[BrowserLogin]:
    """Open a login request. ``None`` means this Cloud can't do browser login, and the
    emailed code still works."""
    response = _post_login(
        base_url,
        "/api/auth/cli/start",
        {
            "machine_label": _machine_label(),
            "machine_os": "macOS" if sys.platform == "darwin" else platform_info.system().lower(),
            "cli_version": f"fp {__version__}",
            "kind": BROWSER_LOGIN_KIND,
        },
        timeout=timeout,
        transport=transport,
        verify=verify,
    )
    status = response.status_code
    body = _json_object(response)
    # No such route, the web app redirecting an unknown path, or serving a page in its
    # place: a Cloud from before browser login. Not an error.
    if status == 404 or 300 <= status < 400 or (status == 200 and body is None):
        return None
    request_id = _request_id_of(response)
    if status == 429:
        raise ApiError(
            "Too many login attempts from here — wait a minute, then run fp login again.",
            status=429,
            request_id=request_id,
        )
    if status >= 500:
        raise NetworkError(
            f"FailproofAI Cloud at {base_url} answered HTTP {status}.", request_id=request_id
        )
    if status != 201 or body is None:
        raise ApiError(
            f"Could not start a browser login (HTTP {status}).", status=status, request_id=request_id
        )
    url = body.get("verification_url")
    secret = body.get("poll_secret")
    if body.get("kind") != BROWSER_LOGIN_KIND or not _is_openable(url):
        return None
    if not isinstance(secret, str) or not secret:
        return None
    return BrowserLogin(
        verification_url=url,
        poll_secret=secret,
        expires_in=_within(body.get("expires_in"), 30, 3600, 600),
        interval=_within(body.get("interval"), 1, 30, 2),
    )


def poll_browser_login(
    base_url: str,
    poll_secret: str,
    *,
    timeout: float = _POLL_TIMEOUT_SECS,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> str:
    """One "approved yet?". Raises ``NetworkError`` for anything worth trying again."""
    response = _post_login(
        base_url,
        "/api/auth/cli/poll",
        {"poll_secret": poll_secret},
        timeout=timeout,
        transport=transport,
        verify=verify,
    )
    if response.status_code == 404:
        return "unknown"
    body = _json_object(response)
    if response.status_code != 200 or body is None:
        raise NetworkError(
            f"FailproofAI Cloud at {base_url} answered HTTP {response.status_code}.",
            request_id=_request_id_of(response),
        )
    status = body.get("status")
    known = ("pending", "slow_down", "approved", "denied", "expired", "claimed")
    return status if status in known else "unknown"


def await_browser_approval(
    base_url: str,
    login: BrowserLogin,
    *,
    tick: Callable[[float, bool], None],
    timeout: float = _POLL_TIMEOUT_SECS,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> str:
    """Poll until the person answers or the link runs out; returns the final status.

    ``tick(seconds_left, offline)`` waits a moment and may draw; it is how the caller
    stays responsive, and how a key press gets to cancel. A dropped connection is not
    an answer, so polling carries on through it.
    """
    deadline = login.started + login.expires_in  # not from now: Tab can come back to a link
    next_poll = time.monotonic() + login.interval
    offline = False
    while True:
        now = time.monotonic()
        if now >= deadline:
            return "expired"
        tick(deadline - now, offline)
        if time.monotonic() < next_poll:
            continue
        try:
            status = poll_browser_login(
                base_url,
                login.poll_secret,
                timeout=min(timeout, _POLL_TIMEOUT_SECS),
                transport=transport,
                verify=verify,
            )
            offline = False
        except NetworkError:
            status, offline = "pending", True
        if status not in ("pending", "slow_down"):
            return status
        next_poll = time.monotonic() + login.interval + (1 if status == "slow_down" else 0)


def claim_browser_login(
    base_url: str,
    poll_secret: str,
    *,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> Tuple[str, int, Dict[str, Any]]:
    """Collect the session, once. Returns ``(token, expires_in_secs, user)``, the same
    shape as :func:`verify_otp`."""
    response = _post_login(
        base_url,
        "/api/auth/cli/claim",
        {"poll_secret": poll_secret},
        timeout=timeout,
        transport=transport,
        verify=verify,
    )
    request_id = _request_id_of(response)
    if response.status_code >= 500:
        raise NetworkError(
            f"FailproofAI Cloud at {base_url} answered HTTP {response.status_code}.",
            hint="run fp login again",
            request_id=request_id,
        )
    body = _json_object(response) or {}
    token = body.get("session_token")
    user = body.get("user")
    user = user if isinstance(user, dict) else {}
    user_id, email = display_text(user.get("id")), display_text(user.get("email"))
    # No identity is no login: `persist_session` keeps the previous one when a field is
    # missing, which would save this session under whoever was signed in before.
    if (
        response.status_code != 201
        or not isinstance(token, str)
        or not _SESSION_TOKEN.fullmatch(token)
        or not user_id
        or not email
    ):
        raise AuthError(
            "That login can't be finished any more.",
            hint="run fp login again",
            request_id=request_id,
        )
    # The server's own range for a session lifetime. Past it `timedelta` raises on saving.
    expires_in = int(_within(body.get("expires_in_secs"), 60, 30 * 86400, 86400))
    return token, expires_in, {"id": user_id, "email": email}


def persist_session(
    cfg: CliConfig,
    base_url: str,
    token: str,
    expires_in_secs: int,
    user: Dict[str, Any],
    *,
    insecure: bool = False,
    org: Optional[str] = None,
    now: Optional[datetime] = None,
) -> CliConfig:
    now = now or datetime.now(timezone.utc)
    cfg.base_url = base_url
    cfg.session_token = token
    cfg.expires_at = _iso(now + timedelta(seconds=expires_in_secs))
    cfg.email = (user or {}).get("email") or cfg.email
    cfg.user_id = (user or {}).get("id") or cfg.user_id
    cfg.insecure = insecure
    if org is not None:
        cfg.org = org  # active tenant chosen at login
    save_config(cfg)
    return cfg


def logout(
    base_url: str,
    token: Optional[str],
    *,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
    verify: bool = True,
) -> None:
    """Best-effort server-side session revocation; never raises."""
    if not token:
        return
    try:
        with httpx.Client(
            base_url=base_url.rstrip("/"),
            cookies={"ae_session": token},
            headers=_request_id_header(),
            timeout=timeout,
            transport=transport,
            verify=verify,
        ) as client:
            client.post("/api/auth/logout")
    except httpx.RequestError:
        pass
