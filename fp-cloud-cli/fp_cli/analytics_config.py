"""Resolve whether CLI telemetry runs, and with what PostHog credentials.

Mirrors the dashboard's ``lib/posthog-config.ts``: a public, write-only project key
shipped in the package, an opt-out env var, and a dev/prod gate — resolved at
invocation time. This module is intentionally pure (no ``posthog`` import) so it is
cheap and safe to import and easy to unit-test.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Public, write-only project key — the SAME PostHog project the dashboard uses
# (dashboard/lib/posthog-config.ts). Safe to ship in the package: it can only
# ingest events, not read them.
POSTHOG_KEY = "phc_Ac1Ww1GqKc0z1SyrRWbmatEeQdlOQIsDEEdP8l8JRgX"

# Direct ingest host. The dashboard posts to its own ``/ingest`` path and
# reverse-proxies to this; a CLI has no first-party origin to proxy through, so it
# talks to PostHog directly.
POSTHOG_HOST = "https://us.i.posthog.com"

# Tags every event so Cloud CLI data separates from the co-tenant "failproofai"
# (Enforcement) CLI in the shared Failproof AI project. REQUIRED — the analog of
# ``posthog.register({ product })``.
#
# This was ``"agenteye"`` before the rename. The value change splits the series in
# PostHog: saved insights filtered on ``product = 'agenteye'`` keep the historical
# rows and see nothing new. That is deliberate and the discontinuity is harmless
# here because ``TELEMETRY_DISABLED`` has been ``True`` since well before the
# rename, so no events were flowing across the boundary in either direction.
PRODUCT = "fp-cloud-cli"

# Master kill switch — telemetry is DISABLED for now (kept in the codebase, not removed).
# When the PostHog host is unreachable the send path blocks the CLI ~5s/command: the
# ``analytics.shutdown`` flush is bounded to 1.5s, but the client-build + first ``capture``
# connect attempt is not, so a blocked network stalls every command (even offline ones like
# ``version``). Until that path is made fully non-blocking (see the TODO in
# ``analytics.shutdown``), telemetry stays off. Flip this to ``False`` to re-enable; nothing
# else was removed, so re-enabling needs no other change.
TELEMETRY_DISABLED = True

_TRUTHY = {"1", "true", "yes"}


def _truthy_env(name: str) -> bool:
    """Match the dashboard's ``isDisabled()`` parse: trim + lowercase, 1/true/yes."""
    return (os.environ.get(name) or "").strip().lower() in _TRUTHY


@dataclass
class AnalyticsConfig:
    enabled: bool
    api_key: str
    host: str


def is_disabled() -> bool:
    """Opt-out via our own ``FP_ANALYTICS_DISABLED`` or the cross-tool ``DO_NOT_TRACK``."""
    return _truthy_env("FP_ANALYTICS_DISABLED") or _truthy_env("DO_NOT_TRACK")


def is_dev_or_test() -> bool:
    """The CLI analog of the dashboard's ``NODE_ENV === 'production'`` gate.

    Keeps our own test runs and source checkouts out of the shared project. Customer
    CI usage is intentionally **not** excluded here — that signal is wanted; CI users
    who want out can set ``DO_NOT_TRACK``.
    """
    return "PYTEST_CURRENT_TEST" in os.environ or _truthy_env("FP_CLI_DEV")


def resolve_config() -> AnalyticsConfig:
    """Resolve telemetry settings now (like the dashboard's request-time check)."""
    enabled = not TELEMETRY_DISABLED and not is_disabled() and not is_dev_or_test()
    return AnalyticsConfig(enabled=enabled, api_key=POSTHOG_KEY, host=POSTHOG_HOST)
