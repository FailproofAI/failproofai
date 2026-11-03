"""Org-slug helpers (multi-tenant).

The dashboard is path-routed by an org slug and validates it against a strict
pattern (see ``dashboard/lib/org.ts``). The CLI validates the same shape before
sending an ``X-AgentEye-Org`` header so a typo fails fast with a clear message
instead of a confusing server error.
"""

from __future__ import annotations

import re

# lowercase alphanumeric + single hyphens, 1-40 chars (mirrors dashboard SLUG_RE
# and the server's orgs.slug CHECK constraint). Keep all three in sync.
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# Reserved first path segments that can never be an org slug (dashboard/lib/org.ts).
RESERVED_ORG_SLUGS = frozenset(
    {"api", "login", "admin", "ingest", "_next", "favicon.ico", "auth"}
)


def is_valid_org_slug(slug: object) -> bool:
    if not isinstance(slug, str) or not slug:
        return False
    if len(slug) > 40:
        return False
    if slug in RESERVED_ORG_SLUGS:
        return False
    return bool(_SLUG_RE.match(slug))
