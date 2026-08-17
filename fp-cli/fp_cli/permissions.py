"""Permission catalogue (mirrors the server ``Permission`` enum + dashboard presets).

Used to validate ``--permission`` / ``--add`` / ``--remove`` / ``--preset`` values
client-side so a typo is a clean usage error instead of a server 422. Kept in sync
with ``server/src/auth.rs`` (``Permission::all``) and
``dashboard/lib/permissionGroups.ts`` (presets).
"""

from __future__ import annotations

import re
from typing import List

# The full assignable permission set, in the server's declared order.
ALL_PERMISSIONS: List[str] = [
    "events:add",
    "events:read",
    "keys:create",
    "keys:read",
    "keys:disable",
    "keys:regenerate",
    "keys:update",
    "users:create",
    "users:read",
    "users:update",
    "users:delete",
    "evaluations:read",
    "evaluations:trigger",
    "dashboards:read",
    "dashboards:write",
    "dashboards:delete",
    "queries:read",
    "queries:write",
    "queries:delete",
    "queries:run",
    "agent:use",
    "settings:read",
    "settings:write",
    "alerts:read",
    "alerts:write",
    "issues:read",
    "issues:create",
    "issues:close",
    "audits:read",
    "audits:write",
    "policies:read",
    "policies:write",
    "policies:pull",
    "usage:read",
    "orgs:admin",
]

# Retired spellings. `incidents:*` was renamed to `issues:*`; the server still
# PARSES the old tokens forever (see Permission::from_str) so keys minted before
# the rename keep working. Accept them here too and normalize, or a script that
# has passed `--add incidents:read` for a year would start exiting 2 against a
# server that would happily have honoured it.
#
# `incidents:ack` gated ack + comment + assign + subscribe + resolve, which now
# span all three issues permissions — so it expands to all three rather than
# mapping to any one, matching expand_implied() on the server.
RETIRED_PERMISSION_ALIASES = {
    "incidents:read": ["issues:read"],
    "incidents:write": ["issues:create"],
    "incidents:ack": ["issues:read", "issues:create", "issues:close"],
    "alerts:ack": ["issues:read", "issues:create", "issues:close"],
}


def normalize_permissions(perms: List[str]) -> List[str]:
    """Expand retired spellings to their current equivalents, order-preserving."""
    out: List[str] = []
    for p in perms:
        for mapped in RETIRED_PERMISSION_ALIASES.get(p, [p]):
            if mapped not in out:
                out.append(mapped)
    return out

# orgs:admin is an instance-level grant, not assignable to an org API key or member
# through these commands; exclude it from what the CLI lets you grant.
ASSIGNABLE_PERMISSIONS: List[str] = [p for p in ALL_PERMISSIONS if p != "orgs:admin"]

_READ_ONLY = [p for p in ALL_PERMISSIONS if p.endswith(":read")]
# Must match BUILTIN_PERMISSION_SETS["standard"] in server/src/ch_tenancy.rs and
# STANDARD_PERMS in dashboard/lib/permissionGroups.ts. `issues:read` arrives via
# _READ_ONLY (it ends in ":read"); create + close are added explicitly. Close is
# included because the retired `incidents:ack` this replaces already granted
# resolve — see migration 20260721000000.
_STANDARD = _READ_ONLY + [
    "evaluations:trigger",
    "queries:run",
    "issues:create",
    "issues:close",
    "agent:use",
]

# Builtin permission-set presets (dashboard/lib/permissionGroups.ts).
PRESETS = {
    "read-only": list(_READ_ONLY),
    "standard": list(_STANDARD),
    "admin": list(ASSIGNABLE_PERMISSIONS),
    "clear": [],
}

_ASSIGNABLE_SET = frozenset(ASSIGNABLE_PERMISSIONS)

# Permissions that parse + are user-assignable but must NEVER sit on an API key — the server's
# `Permission::key_assignable` rejects them (422). `orgs:admin` is already excluded above;
# `keys:update` is human-only (a bearer key can create keys but never edit them). The key flows
# strip these from a permission-set seed (silently, like the dashboard's keyAssignableOnly-strip)
# and reject them from an explicit `--add` (so the user gets a clean message, not a server 422).
KEY_NON_ASSIGNABLE = frozenset({"orgs:admin", "keys:update"})
KEY_ASSIGNABLE_PERMISSIONS: List[str] = [p for p in ASSIGNABLE_PERMISSIONS if p not in KEY_NON_ASSIGNABLE]


def unknown_permissions(perms: List[str]) -> List[str]:
    """Return any tokens that are not assignable permissions (empty if all valid).

    Retired spellings count as VALID. The server parses them (aliasing to the
    current names), so rejecting them here would make the CLI stricter than the
    API it fronts — a script that has passed `--add incidents:read` for a year
    would start failing with exit 2 against a server that would have accepted it.
    Callers should run the values through `normalize_permissions` before sending.
    """
    return [
        p
        for p in perms
        if p not in _ASSIGNABLE_SET and p not in RETIRED_PERMISSION_ALIASES
    ]


def key_assignable_only(perms) -> List[str]:
    """Drop the human-only permissions (`keys:update` / `orgs:admin`) from a permission list —
    used when SEEDING a key from a permission set, mirroring the dashboard's keyAssignableOnly
    strip. Order-preserving."""
    return [p for p in perms if p not in KEY_NON_ASSIGNABLE]


def parse_key_permission_tokens(tokens, *, require_nonempty: bool = True) -> List[str]:
    """Like :func:`parse_permission_tokens`, but for an API KEY — additionally rejects the
    human-only permissions (`keys:update` / `orgs:admin`) with a clear message, so an explicit
    `--add keys:update` fails client-side (exit 2) instead of hitting a server 422."""
    flat = parse_permission_tokens(tokens, require_nonempty=require_nonempty)
    forbidden = [p for p in flat if p in KEY_NON_ASSIGNABLE]
    if forbidden:
        raise PermissionTokenError(
            f'{", ".join(sorted(set(forbidden)))} can\'t be granted to an API key — it\'s human-only'
        )
    return flat


def expand_preset(name: str) -> List[str]:
    """Return the permissions for a builtin preset, or raise KeyError."""
    return list(PRESETS[name])


class PermissionTokenError(Exception):
    """A malformed or unknown compact ``slug:act.act`` permission token (carries a
    user-facing message). Shared by ``keys`` and ``users`` so both surfaces parse the
    compact token format identically."""


def parse_permission_tokens(tokens, *, require_nonempty: bool = True) -> List[str]:
    """Expand the compact ``slug:act1.act2`` permission tokens into a de-duplicated flat
    assignable permission list (``events:read.add`` → ``events:read``, ``events:add``). Tokens
    separated by **whitespace or commas** within one value AND repeated flags all compose — so
    ``-p "a b"``, ``--add a,b``, and ``--add a --add b`` are equivalent. Raises
    :class:`PermissionTokenError` on a malformed token or an unknown permission, and — when
    ``require_nonempty`` — on an empty set (``users`` ``--add``/``--remove`` may be empty, so
    they call the helper only when a value is supplied)."""
    flat: List[str] = []
    seen: set = set()
    for raw in tokens or []:
        for tok in re.split(r"[\s,]+", str(raw).strip()):  # whitespace- or comma-separated
            if not tok:
                continue  # stray empties from `a,,b` / whitespace-only input
            if ":" not in tok:
                raise PermissionTokenError(f'bad permission "{tok}" — expected slug:action (e.g. events:read.add)')
            slug, _, actions_str = tok.partition(":")
            slug = slug.strip()
            actions = [a.strip() for a in actions_str.split(".")]
            if not slug or not actions_str.strip() or any(not a for a in actions):
                raise PermissionTokenError(f'bad permission "{tok}" — no action after \':\' (e.g. {slug or "events"}:read.add)')
            for a in actions:
                perm = f"{slug}:{a}"
                if perm not in seen:
                    seen.add(perm)
                    flat.append(perm)
    if not flat:
        if require_nonempty:
            raise PermissionTokenError("at least one permission is required (e.g. events:read.add)")
        return flat
    unknown = unknown_permissions(flat)
    if unknown:
        raise PermissionTokenError(f'unknown permission(s): {", ".join(unknown)}')
    return flat
