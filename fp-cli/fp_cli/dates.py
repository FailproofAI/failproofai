"""Relative date-range presets, mirroring the dashboard's ``resolveDateRange``.

``--since`` accepts one of ``15m|1h|6h|24h|7d|all`` and is converted to a
``ts_from`` lower bound (open-ended to "now"). ``--from``/``--to`` provide an
explicit custom range and take precedence over ``--since``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

PRESETS = {
    "15m": timedelta(minutes=15),
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}

# Accepted values for --since (including the no-op "all").
SINCE_CHOICES = ["all", "15m", "1h", "6h", "24h", "7d"]


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _validate_iso(value: str, flag: str) -> str:
    """Validate an explicit ``--from``/``--to`` is a full RFC3339 UTC datetime.

    The server deserializes ``ts_from``/``ts_to`` as ``chrono::DateTime<Utc>``, which
    requires a ``T`` separator AND an explicit timezone (``Z`` or ``±HH:MM``). A
    date-only, timezone-less (``2026-05-01T00:00:00``), or space-separated value is
    sent verbatim and rejected by the server with a 400; validating here turns that
    into a clean usage error (exit 2) instead.
    """
    v = value.strip()
    try:
        parsed = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
    if parsed is None or "T" not in v or parsed.tzinfo is None:
        raise ValueError(
            f"invalid {flag} value {value!r}; expected an ISO-8601 UTC timestamp, "
            "e.g. 2026-05-01T00:00:00Z"
        )
    return v


def resolve_range(
    since: Optional[str] = None,
    ts_from: Optional[str] = None,
    ts_to: Optional[str] = None,
    *,
    now: Optional[datetime] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(ts_from, ts_to)`` for the given inputs.

    Explicit ``ts_from``/``ts_to`` win. Otherwise a ``--since`` preset sets the
    lower bound. ``since="all"`` (or ``None``) means no bounds.
    """
    if ts_from is not None or ts_to is not None:
        return (
            _validate_iso(ts_from, "--from") if ts_from is not None else None,
            _validate_iso(ts_to, "--to") if ts_to is not None else None,
        )

    if since is None or since == "all":
        return None, None

    if since not in PRESETS:
        raise ValueError(
            f"invalid --since value {since!r}; choose one of {', '.join(SINCE_CHOICES)}"
        )

    now = now or datetime.now(timezone.utc)
    return _iso(now - PRESETS[since]), None
