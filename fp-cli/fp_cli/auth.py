"""Email-OTP device login against the dashboard.

Flow: ``/api/auth/otp/request`` (sends a code) then ``/api/auth/otp/verify``.
The verify response carries the session token in the ``ae_session`` **Set-Cookie**
header (not the JSON body), so we read it from ``response.cookies``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

import httpx

from .config import CliConfig, save_config
from .errors import ApiError, AuthError, NetworkError


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
            base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, verify=verify
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
            base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, verify=verify
        ) as client:
            response = client.post(
                "/api/auth/otp/verify", json={"email": email, "code": code}
            )
    except httpx.RequestError as exc:
        raise _network_error(base_url, exc)

    if response.status_code == 401:
        raise AuthError("That code didn't match or has expired. Sign in again with fp login.")
    if response.status_code == 429:
        raise ApiError(
            "Too many attempts — wait a bit, then run fp login again.",
            status=429,
        )
    if response.status_code >= 400:
        # The dashboard proxy collapses the server's wrong/expired-code 401 into a 500 (its
        # `await res.json()` throws on the server's empty 401 body). So a non-401 4xx/5xx at the
        # verify step is, in practice, a bad/expired code — surface it as a clean auth failure,
        # not a raw "HTTP 500". (Real unreachability is a NetworkError, handled above.)
        raise AuthError("That code didn't match or has expired. Sign in again with fp login.")

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
            timeout=timeout,
            transport=transport,
            verify=verify,
        ) as client:
            client.post("/api/auth/logout")
    except httpx.RequestError:
        pass
