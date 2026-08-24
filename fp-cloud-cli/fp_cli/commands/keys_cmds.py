"""API key provisioning: keys list / show / create / update / disable / regenerate.

Keys are referenced by their **name** (unique within the org) across ``show`` / ``update`` /
``disable`` / ``regenerate``. The group mirrors the ``users`` visual + permission language: a
boxed list, a ``show`` identity card + grouped permissions panel, and the SAME
``--permission-set`` / ``--add`` / ``--remove`` flags as ``users create`` / ``users update``.

A KEY stores a **flat permission list** (no persisted role/set), so ``--permission-set`` is
expanded **client-side** to seed the grants (matching the dashboard's key SetPicker); the
human-only permissions (``keys:update`` / ``orgs:admin``) are stripped from a seed and rejected
from an explicit ``--add`` (the server's ``key_assignable`` would 422 them).

The CLI generates the secret for ``create`` (the server never echoes it back) and prints it
exactly once. ``regenerate`` rotates the secret and prints the new one once. Secrets go to
**stdout** (capturable); the "shown once" warning goes to stderr.
"""

from __future__ import annotations

import secrets
import sys
from typing import List, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output, permissions
from .._context import (
    GLOBALS_EPILOG,
    AppState,
    deny_in_key_mode,
    require_auth,
    resolve_fields,
)
from ..errors import ForbiddenError, NotFoundError
from ..models import ApiKey
from ..permissions import PermissionTokenError
from ..permissions import parse_permission_tokens as _parse_permissions
from . import _write

# ``PermissionTokenError`` / ``_parse_permissions`` live in ``permissions.py`` (shared with
# ``users``); re-exported here under their historical names so the keys flow + its tests keep
# importing them from this module.
__all__ = ["PermissionTokenError", "_parse_permissions", "register"]


def _resolve_key_or_exit(state: AppState, keys, name: str) -> ApiKey:
    """Resolve a unique key NAME (or id) to its key, raising a typed error the central
    chokepoint renders (JSON envelope under ``--json``, red box otherwise): none → exit 6,
    several → exit 2."""
    return _write.resolve_one(keys, name, kind="key", list_cmd="keys list")


def _parse_key_tokens_or_exit(state: AppState, tokens) -> List[str]:
    """Expand the compact ``slug:act1.act2`` ``--add`` / ``--remove`` tokens for a KEY (empty when
    none given). A malformed/unknown token — or a human-only permission (``keys:update`` /
    ``orgs:admin``) — → a clean usage error (exit 2), before any create/update."""
    if not tokens:
        return []
    try:
        return permissions.parse_key_permission_tokens(tokens)
    except PermissionTokenError as exc:
        raise click.UsageError(str(exc))


def _expand_key_set_or_exit(state: AppState, cctx, set_name: str) -> List[str]:
    """Expand a ``--permission-set`` NAME → its **key-assignable** permissions, to seed a key's
    flat grants (keys have no persisted set). Resolves against the ORG's sets (fetched, so custom
    sets work like the dashboard's SetPicker), falling back to the built-in presets if that read
    is unavailable. Human-only perms are stripped. Unknown set → clean error + exit 2."""
    try:
        sets = api.list_permission_sets(cctx)
    except (ForbiddenError, NotFoundError):
        sets = {}
    if set_name in sets:
        return permissions.key_assignable_only(sets[set_name])
    if set_name in permissions.PRESETS:
        return permissions.key_assignable_only(permissions.PRESETS[set_name])
    available = sorted(set(sets) | (set(permissions.PRESETS) - {"clear"}))
    raise click.UsageError(
        f'unknown permission set "{set_name}". available: {", ".join(available)}'
    )


def keys_list(
    ctx: typer.Context,
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short key-id column (the full id is always in --json)."),
    fields: Optional[str] = typer.Option(None, "--fields", help="Comma-separated subset of fields. e.g. `id,name,permissions`."),
) -> None:
    """List the org's API keys (metadata only — secrets are never returned), active keys first.

    Shows `created · name · permissions · status` in a boxed table — **active keys sort to the
    top** (then revoked), each group newest-first. The raw key id is hidden by default (use
    `--show-id` for a short id, or `--json` for the full id). Needs `keys:read`. With `--json`:
    `{"keys": [{id, name, permissions, created_at, revoked_at}]}`.

    Example:

    * `fp keys list`
    * `fp --json keys list`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    keys = api.list_keys(cctx)
    cols = resolve_fields(fields, ApiKey)
    if state.json:
        payload = output.project_dicts(keys, cols) if cols else keys
        output.emit_json({"keys": payload})
        return
    if cols:
        # `--fields` asks for specific raw columns → the generic table (no bespoke styling).
        output.print_table(list(cols), output.project_rows(keys, cols), title=f"API keys ({len(keys)})")
        return
    output.render_keys(keys, show_id=show_id)
    output.keys_footer(keys)


def keys_show(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Key name (unique within the org)."),
) -> None:
    """Show one key's identity and full permissions — like `users show`, for an API key.

    Renders an identity card (name, created date, permission count, status) then the shared
    grouped permissions panel with **all** the key's grants. Referenced by **name**. Needs
    `keys:read`. With `--json`: the full key object `{id, name, permissions, created_at, revoked_at}`.

    Example:

    * `fp keys show ci-bot`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    key = _resolve_key_or_exit(state, api.list_keys(cctx), name)
    if state.json:
        output.emit_json(key)
        return
    output.render_key_show(key)


def keys_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Human-readable key name (unique within the org)."),
    permission_set: Optional[str] = typer.Option(None, "--permission-set", help="Role to seed the key from — a permission set: `read-only`, `standard`, `admin`, or a custom set your org defines in the dashboard. The set is expanded into the key's grants (human-only perms are dropped). Omit for no base role."),
    add: Optional[List[str]] = typer.Option(None, "--add", help="Grant extra permissions on top of the set, as `slug:action.action` tokens (dotted actions expand: `events:read.add` → `events:read`, `events:add`). Several via comma, repeated flag, or a quoted group: `--add events:read,keys:read` · `--add a --add b` · `--add \"a b\"`."),
    remove: Optional[List[str]] = typer.Option(None, "--remove", help="Drop permissions from the set, same `slug:action.action` token format as --add (comma / repeated / quoted)."),
) -> None:
    """Create an API key and reveal its secret **once**.

    Grant permissions exactly like `users create`: start from a role with `--permission-set`
    (a built-in `read-only` / `standard` / `admin`, or a custom org set — expanded into the key's
    grants), then fine-tune with `--add` / `--remove`. The effective grants are
    `(set ∪ added) − removed`. `--add` / `--remove` take the compact `slug:action.action` token
    format (dotted actions expand). Human-only permissions (`keys:update`) can't be granted to a
    key.

    The secret is generated locally; the server stores only a hash. Needs `keys:create`. With
    `--json`: `{id, name, permissions, created_at, key}` — `key` is the only place the secret
    appears, and `permissions` is the expanded flat list.

    Examples:

    * `fp keys create ci-bot --permission-set read-only` — a read-only key
    * `fp keys create deployer --add events:read.add,keys:read` — just the listed grants
    * `fp keys create ops --permission-set standard --add keys:create --remove agent:use` — a role, tuned
    * `fp keys create ci-bot --permission-set read-only | pbcopy` — pipe captures just the secret
    """
    state: AppState = ctx.obj
    if not name.strip():
        raise typer.BadParameter("key name must not be empty.", param_hint="NAME")
    parsed_add = _parse_key_tokens_or_exit(state, add)
    parsed_remove = _parse_key_tokens_or_exit(state, remove)
    both = sorted(set(parsed_add) & set(parsed_remove))
    if both:
        raise typer.BadParameter(f"{', '.join(both)} given to both --add and --remove.")
    cctx = require_auth(state)
    if any(k.name == name for k in api.list_keys(cctx)):  # names are unique
        raise click.UsageError(f'a key named "{name}" already exists')
    base = _expand_key_set_or_exit(state, cctx, permission_set) if permission_set else []
    flat = sorted((set(base) | set(parsed_add)) - set(parsed_remove))
    secret = secrets.token_hex(32)  # 64 hex chars, mirrors the dashboard's generateToken()
    result = api.create_key(cctx, name=name, key=secret, permissions=flat)
    _write.record_action("api_key_created", resource="key", success=True, permission_count=len(flat))
    perms = result.permissions or flat
    if state.json:
        output.emit_json({"id": result.id, "name": result.name, "permissions": perms,
                          "created_at": result.created_at, "key": secret})
        return
    if not sys.stdout.isatty():
        print(secret)  # piped/redirected → just the secret (capturable)
        return
    output.render_key_created(result)            # green identity card
    output.render_created_secret_box(secret)     # the secret, shown once
    output.permissions_box(perms)                # the grouped grants


def keys_update(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Key name to update (unique within the org)."),
    permission_set: Optional[str] = typer.Option(None, "--permission-set", help="Reseed the key from a permission set: `read-only`, `standard`, `admin`, or a custom org set. REPLACES the key's grants with the set (then applies any --add/--remove). Human-only perms are dropped."),
    add: Optional[List[str]] = typer.Option(None, "--add", help="Grant permissions, same `slug:action.action` token format as `keys create` (dotted actions expand; comma / repeated flag / quoted compose). Incremental — merged into the key's CURRENT grants, unless --permission-set is also given."),
    remove: Optional[List[str]] = typer.Option(None, "--remove", help="Revoke permissions, same `slug:action.action` token format as --add. Incremental — applied to the key's CURRENT grants, unless --permission-set is also given."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Change an API key's permissions and show the diff — like `users update`, by key name.

    Two ways to use it (combine if you like):

    * **Reseed from a role** — `--permission-set <set>` replaces the key's grants with that set
      (a built-in `read-only` / `standard` / `admin`, or a custom org set); add `--add`/`--remove`
      to tune it.
    * **Tweak incrementally** — `--add` / `--remove` **alone** adjust the key's *current* grants.
      Both take the compact `slug:action.action` token format (dotted actions expand). Human-only
      permissions (`keys:update`) can't be granted to a key.

    The CLI reads the current grants, computes the result `(set ∪ added) − removed`, and shows a
    git-style diff — added green, removed struck-through, unchanged dim. It confirms first (default
    no; `--yes` skips); a no-op exits without calling the server. The key keeps working — only its
    permissions change. Needs `keys:update`. With `--json`:
    `{id, name, permissions, created_at, revoked_at, added, removed}`.

    Examples:

    * `fp keys update ci-bot --add keys:read` — grant on top of current grants
    * `fp keys update ci-bot --remove events:add,agent:use` — revoke a couple of grants
    * `fp keys update ci-bot --permission-set standard --yes` — reseed from the standard role
    """
    state: AppState = ctx.obj
    # The only `keys` subcommand an API key can never run: it needs `keys:update`, and
    # `Permission::key_assignable` forbids that grant on ANY key (a bearer key may
    # create keys, never edit one). So this is unreachable by construction, not just
    # unlikely — say so here instead of letting the server's 403 imply "ask for the
    # permission", which nobody can grant.
    deny_in_key_mode(
        state,
        "keys update",
        "it needs the keys:update permission, which cannot be granted to any API key",
    )
    if permission_set is None and not add and not remove:
        raise typer.BadParameter("nothing to update — pass --permission-set, --add, and/or --remove.")
    parsed_add = _parse_key_tokens_or_exit(state, add)
    parsed_remove = _parse_key_tokens_or_exit(state, remove)
    both = sorted(set(parsed_add) & set(parsed_remove))
    if both:
        raise typer.BadParameter(f"{', '.join(both)} given to both --add and --remove.")
    cctx = require_auth(state)
    key = _resolve_key_or_exit(state, api.list_keys(cctx), name)
    before = set(key.permissions)
    add_set, remove_set = set(parsed_add), set(parsed_remove)

    if permission_set is not None:
        # Reseed: the set is the base; --add/--remove are fresh tweaks on top.
        base = _expand_key_set_or_exit(state, cctx, permission_set)
        after = sorted((set(base) | add_set) - remove_set)
    else:
        # Incremental: apply the deltas to the key's CURRENT flat grants.
        after = sorted((before | add_set) - remove_set)
    after_set = set(after)
    added, removed = sorted(after_set - before), sorted(before - after_set)

    if not added and not removed:  # no-op: don't call the server, don't prompt
        if state.json:
            output.emit_json({"id": key.id, "name": key.name, "permissions": sorted(before),
                              "created_at": key.created_at, "revoked_at": key.revoked_at,
                              "added": [], "removed": []})
        else:
            output.key_no_change()
        return

    proceed = (not _write.should_prompt(state, yes)) or output.confirm_key_update(
        key.name, len(added), len(removed))
    if not proceed:
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled("permissions unchanged")
        return

    result = api.update_key(cctx, key.id, permissions=after)
    final = set(result.permissions)
    added, removed = sorted(final - before), sorted(before - final)
    _write.record_action("api_key_updated", resource="key", success=True, permission_count=len(final))
    if state.json:
        output.emit_json({"id": result.id, "name": result.name, "permissions": sorted(final),
                          "created_at": result.created_at, "revoked_at": result.revoked_at,
                          "added": added, "removed": removed})
        return
    output.render_key_updated(result, added=added, removed=removed, union=sorted(before | final))


def keys_disable(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Key name to disable (unique within the org)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Disable (revoke) an API key by name. This cannot be undone.

    Resolves the unique key name, confirms (amber, default no), then revokes it — anything
    using the key stops working immediately. Needs `keys:disable`. With `--json`:
    `{"name", "status": "disabled"}` (or `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp keys disable "ci-bot" --yes`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    key = _resolve_key_or_exit(state, api.list_keys(cctx), name)
    if key.revoked_at:  # already disabled — a no-op, not an error
        if state.json:
            output.emit_json({"name": key.name, "status": "disabled"})
        else:
            output.key_already_disabled(key.name)
        return
    if not _write.confirm_destructive(
        state, "disable the key", key.name,
        consequence="this revokes the key immediately — anything using it will stop working",
        assume_yes=yes,
    ):
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    api.disable_key(cctx, key.id)
    _write.record_action("api_key_disabled", resource="key", success=True, destructive=True)
    if state.json:
        output.emit_json({"name": key.name, "status": "disabled"})
    else:
        output.key_disabled(key.name)


def keys_regenerate(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="Key name to rotate the secret for (unique within the org)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Rotate an API key's secret by name and reveal the new secret **once**.

    Resolves the unique key name, confirms (amber, default no), then rotates — the old secret
    stops working immediately. The new secret is shown once: piping captures just the raw
    secret (`fp keys regenerate admin -y | pbcopy`); interactively it's shown in a box.
    Needs `keys:regenerate`. With `--json`: `{"name", "key"}` — the new secret under `key`, the
    same field `keys create` uses (or `{"cancelled": true}` on a declined prompt).

    Example:

    * `fp keys regenerate "ci-bot" -y`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    key = _resolve_key_or_exit(state, api.list_keys(cctx), name)
    if not _write.confirm_destructive(
        state, "regenerate the secret for key", key.name,
        consequence="this revokes the current secret immediately and can't be undone",
        assume_yes=yes,
    ):
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    secret = api.regenerate_key(cctx, key.id)
    _write.record_action("api_key_regenerated", resource="key", success=True)
    if state.json:
        output.emit_json({"name": key.name, "key": secret})
        return
    if sys.stdout.isatty():
        output.render_secret_box(key.name, secret)  # pretty box (with secret) → stderr
    else:
        print(secret)  # piped/redirected → bare secret to stdout, capturable


_KEYS_GROUP_HELP = """Provision and manage API keys — list, inspect, create, and adjust their permissions.

Keys are referenced by **name** (unique in the org). A key carries a flat set of permissions;
grant them from a role (`--permission-set`) plus `--add` / `--remove` overrides — the same
language as `users`. The secret is shown **once**, at create / regenerate.

**Subcommands:** `list` · `show` · `create` · `update` · `disable` · `regenerate`

**Examples:**

* `fp keys list` — all keys, active first
* `fp keys show ci-bot` — one key's identity + full grants
* `fp keys create ci-bot --permission-set read-only` — invite a key with a role
* `fp keys update ci-bot --add keys:read --remove agent:use` — tweak grants
* `fp keys regenerate ci-bot -y` — rotate the secret (shown once)
* `fp keys disable ci-bot` — revoke it
"""


def register(app: typer.Typer) -> None:
    keys_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help=_KEYS_GROUP_HELP,
    )
    keys_app.command("list", epilog=GLOBALS_EPILOG)(keys_list)
    keys_app.command("show", epilog=GLOBALS_EPILOG)(keys_show)
    keys_app.command("create", epilog=GLOBALS_EPILOG)(keys_create)
    keys_app.command("update", epilog=GLOBALS_EPILOG)(keys_update)
    keys_app.command("disable", epilog=GLOBALS_EPILOG)(keys_disable)
    keys_app.command("regenerate", epilog=GLOBALS_EPILOG)(keys_regenerate)
    app.add_typer(keys_app, name="keys")
