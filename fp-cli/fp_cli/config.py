"""Persistent CLI configuration at ``~/.fp/cli.json`` (mode 0600).

The base directory honours ``FP_HOME``. Note this is the CLI's own namespace and
is deliberately NOT shared with anything else: the Python SDK and the collector
still resolve ``AGENTEYE_HOME`` / ``~/.agenteye`` for their event spool, and the
Enforcement CLI owns ``~/.failproofai``. Three separate roots, on purpose — this
one holds a session token and nothing else.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# The dashboard the CLI talks to when nothing else says otherwise. Resolution is
# always explicit flag/env (`--base-url` / `FP_DASHBOARD_URL`) > saved config
# (`~/.fp/cli.json`) > this default, so a fresh install points at the hosted
# product with zero configuration, while a self-hosted or dev user overrides it
# once (at login, or per command) and never thinks about it again.
# NOT stored in `CliConfig` — a saved config with no `base_url` still reads back
# as `None`; the default is applied only when resolving the effective URL.
DEFAULT_BASE_URL = "https://app.befailproof.ai"


def base_dir() -> Path:
    """Return ``$FP_HOME`` if set, else ``~/.fp``."""
    override = os.environ.get("FP_HOME")
    if override:
        return Path(override)
    return Path.home() / ".fp"


def config_path() -> Path:
    return base_dir() / "cli.json"


@dataclass
class CliConfig:
    base_url: Optional[str] = None
    session_token: Optional[str] = None
    expires_at: Optional[str] = None  # ISO 8601, e.g. 2026-05-26T12:00:00Z
    email: Optional[str] = None
    user_id: Optional[str] = None
    insecure: bool = False
    org: Optional[str] = None  # active tenant slug, chosen at login (multi-tenant)
    anonymous_id: Optional[str] = None  # stable per-machine id for anonymous telemetry


def load_config() -> CliConfig:
    """Load config, tolerating a missing or unreadable file."""
    path = config_path()
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return CliConfig()
    if not isinstance(data, dict):
        return CliConfig()
    return CliConfig(
        base_url=data.get("base_url"),
        session_token=data.get("session_token"),
        expires_at=data.get("expires_at"),
        email=data.get("email"),
        user_id=data.get("user_id"),
        insecure=bool(data.get("insecure", False)),
        org=data.get("org"),
        anonymous_id=data.get("anonymous_id"),
    )


def save_config(cfg: CliConfig) -> None:
    """Write config with owner-only permissions (0600)."""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create with restrictive mode up front to avoid a brief world-readable window.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(asdict(cfg), indent=2) + "\n")
    os.chmod(path, 0o600)


def clear_token(cfg: CliConfig) -> CliConfig:
    """Clear the whole logged-in session and persist.

    Drops everything tied to *who* was signed in — token, expiry, email, user id,
    and the active org/tenant — so a logout leaves no stale identity (and the next
    `login` starts the org picker fresh, with no remembered tenant). Kept on
    purpose: `base_url` and the `insecure` TLS preference (so the next login
    doesn't need them re-specified) and the machine-stable `anonymous_id`.
    """
    cfg.session_token = None
    cfg.expires_at = None
    cfg.email = None
    cfg.user_id = None
    cfg.org = None
    save_config(cfg)
    return cfg


def _parse_iso(value: str) -> datetime:
    # Python 3.10's fromisoformat does not accept a trailing 'Z'.
    normalized = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_expired(cfg: CliConfig, *, skew_secs: int = 60, now: Optional[datetime] = None) -> bool:
    """True if there is no usable, unexpired token (with a safety skew)."""
    if not cfg.session_token or not cfg.expires_at:
        return True
    try:
        expires = _parse_iso(cfg.expires_at)
    except ValueError:
        return True
    now = now or datetime.now(timezone.utc)
    return now >= expires - timedelta(seconds=skew_secs)
