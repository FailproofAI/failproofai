"""Org member management: users list / show / create / update / disable / enable.

Members are referenced by their **email** (unique within the org) — not a raw id — across
``show`` / ``update`` / ``disable`` / ``enable`` (a UUID-shaped handle is also accepted). The
whole group converges on the shared boxed visual language: a boxed member list, identity cards,
the shared grouped permissions panel, and the shared confirm/cancel helpers. Effective grants are
``(set ∪ added) − removed``; ``--add`` / ``--remove`` use the compact ``slug:act.act`` token
format (the same parser as ``keys``). Protected members can't be edited/disabled.

A member's role comes from a **permission set** that lives **per org on the server** (managed in
the dashboard): the built-in ``read-only`` / ``standard`` / ``admin`` plus any custom sets the org
defines. The CLI hardcodes only those three built-ins — and only to *preview* the resulting grants
locally; the ``--permission-set`` value is resolved + expanded server-side, so custom org sets work
too (but a custom set can't be previewed, so ``update`` confirms it generically).
"""

from __future__ import annotations

from typing import List, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import client as api
from .. import output, permissions, theme
from .._context import GLOBALS_EPILOG, AppState, require_auth
from ..errors import ForbiddenError
from . import _write


def _resolve_user_or_exit(state: AppState, users, handle: str):
    """Resolve a member by **email** (primary), falling back to an exact id match, raising a
    typed error the central chokepoint renders (JSON envelope under ``--json``, red box
    otherwise): none → exit 6, several → exit 2."""
    return _write.resolve_one(
        users,
        handle,
        kind="user",
        ref="with email",
        key="email",
        list_cmd="users list",
        # The server lowercases on create, so the address the caller typed is not the address
        # stored. Without this, `fp users create Alice.Chen@Example.com` succeeds and every
        # subsequent show/update/disable/enable on that same string reports "no user with
        # email" — the member is reachable only via a lowercased form nothing told them about.
        casefold=True,
    )


def _parse_user_tokens_or_exit(state: AppState, tokens) -> List[str]:
    """Expand the compact ``slug:act1.act2`` ``--add`` / ``--remove`` tokens into a flat
    assignable permission list (empty when no value was given). A malformed/unknown token → a clean
    usage error (exit 2), before any read/write. Space-separated tokens (quoted) and repeated flags
    both compose — e.g. ``--add "keys:create.regenerate users:create.update"`` or
    ``--add keys:create.regenerate --add users:create.update``."""
    if not tokens:
        return []
    try:
        return permissions.parse_permission_tokens(tokens)
    except permissions.PermissionTokenError as exc:
        raise click.UsageError(str(exc))


def users_list(
    ctx: typer.Context,
    active_only: bool = typer.Option(False, "--active-only", help="Show only enabled members (hide disabled ones)."),
    show_id: bool = typer.Option(False, "--show-id", help="Prepend a short user-id column (the full id is always in --json)."),
) -> None:
    """List org members in a boxed table — active members first, disabled ones dimmed at the bottom.

    Shows `email · access · permissions · joined · status` with a leading 🔒 marker on protected
    members; status is derived from the disable state (`● active` / `○ disabled`), and `joined`
    comes from each member's join date. The raw id is hidden by default (use `--show-id` for a
    short id, or `--json` for the full id). Needs `users:read`. With `--json`:
    `{"users": [{id, email, permissions, permission_set, disabled_at, is_protected, created_at, …}]}`.

    Examples:

    * `fp users list`
    * `fp users list --active-only`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    users = api.list_users(cctx)
    if active_only:
        users = [u for u in users if not u.disabled_at]
    users = sorted(users, key=lambda u: 1 if u.disabled_at else 0)  # active first, disabled last
    if state.json:
        output.emit_json({"users": users})
        return
    output.render_users(users, show_id=show_id)
    output.users_footer(users)


def users_show(
    ctx: typer.Context,
    email: str = typer.Argument(..., metavar="EMAIL", help="User email (or id)."),
) -> None:
    """Show one member's identity and full effective permissions — like `whoami` for someone else.

    Renders an identity card (email, role, status) then the shared grouped permissions panel with
    **all** the member's grants (no truncation). Referenced by **email** (or a UUID-shaped id).
    Needs `users:read`. With `--json`: the full member object.

    Example:

    * `fp users show dev@example.com`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    user = _resolve_user_or_exit(state, api.list_users(cctx), email)
    if state.json:
        output.emit_json(user)
        return
    output.render_user_show(user)


def _validate_permission_set_or_exit(state: AppState, cctx, set_name: Optional[str]) -> None:
    """Reject an unknown ``--permission-set`` client-side (clean exit 2) instead of a raw server
    422 with a request-id. Valid = the org's sets ∪ the built-in presets (the server expands it).
    Mirrors how ``keys create`` validates its set."""
    presets = set(permissions.PRESETS) - {"clear"}  # `clear` is an internal preset, not assignable
    if not set_name or set_name in presets:
        return  # no set, or a built-in preset (always valid) → no extra round-trip
    valid = set(api.list_permission_sets(cctx)) | presets
    if set_name not in valid:
        raise click.UsageError(
            f'unknown permission set "{set_name}". available: {", ".join(sorted(valid))}'
        )


def users_create(
    ctx: typer.Context,
    email: str = typer.Argument(..., metavar="EMAIL", help="Email of the member to invite (unique within the org)."),
    permission_set: Optional[str] = typer.Option(None, "--permission-set", help="Role to start from — a permission set: `read-only`, `standard`, `admin`, or a custom set your org defines in the dashboard. Omit for no base role."),
    add: Optional[List[str]] = typer.Option(None, "--add", help="Grant extra permissions on top of the set, as `slug:action.action` tokens (dotted actions expand: `keys:create.regenerate` → `keys:create`, `keys:regenerate`). Several via comma, repeated flag, or a quoted group: `--add keys:create,users:read` · `--add a --add b` · `--add \"a b\"`."),
    remove: Optional[List[str]] = typer.Option(None, "--remove", help="Revoke permissions from the set, same `slug:action.action` token format as --add (comma / repeated / quoted)."),
) -> None:
    """Invite an org member and show their new identity + permissions.

    Give the member's **email** (positional). Their role comes from `--permission-set` (a built-in
    `read-only` / `standard` / `admin`, or a custom set your org defines in the dashboard), and you
    can fine-tune it per member with `--add` / `--remove`. The effective grants are
    `(set ∪ added) − removed`, expanded server-side; the permissions box shows the result.

    `--add` / `--remove` take the compact `slug:action.action` token format — dotted actions expand
    (`keys:create.regenerate` → two grants) and several compose by comma, repeated flag, or a quoted
    group. Needs `users:create`. With `--json`: `{id, email, permission_set, permissions}`
    (`permissions` = the expanded set).

    Examples:

    * `fp users create dev@example.com --permission-set standard` — invite with the standard role
    * `fp users create ci@example.com --permission-set read-only --add keys:create.regenerate` — read-only plus key management
    * `fp users create lead@example.com --permission-set admin --remove settings:write` — admin minus settings writes
    """
    state: AppState = ctx.obj
    parsed_add = _parse_user_tokens_or_exit(state, add)
    parsed_remove = _parse_user_tokens_or_exit(state, remove)
    cctx = require_auth(state)
    _validate_permission_set_or_exit(state, cctx, permission_set)
    # Casefolded, matching `_write.resolve_one`. The server lowercases an email
    # on create, so the address the caller typed is not the address stored —
    # 6372ecf2 fixed the RESOLVER for that and left this guard an exact
    # comparison, which made the group internally inconsistent about case: `fp
    # users show Alice.Chen@Example.com` resolved the member, while `fp users
    # create Alice.Chen@Example.com` failed to see them, sent the POST, and
    # surfaced the server's 409 as exit 1. The skill's own guidance branches on
    # the code — exit 2 means "report it and ask", exit 1 means "unexpected
    # server error" — so an agent took the wrong branch for the same logical
    # outcome, decided purely by the capitalisation a human typed.
    if any((u.email or "").casefold() == email.casefold() for u in api.list_users(cctx)):
        raise click.UsageError(f'a user with email "{email}" already exists')
    user = api.create_user(
        cctx, email=email, permission_set=permission_set,
        permission_added=parsed_add or None, permission_removed=parsed_remove or None,
    )
    _write.record_action("user_created", resource="user", success=True, permission_count=len(user.permissions))
    if state.json:
        output.emit_json({"id": user.id, "email": user.email,
                          "permission_set": user.permission_set, "permissions": user.permissions})
        return
    output.render_user_created(user)


def users_update(
    ctx: typer.Context,
    email: str = typer.Argument(..., metavar="EMAIL", help="Email (or id) of the member to update."),
    permission_set: Optional[str] = typer.Option(None, "--permission-set", help="Reassign the member's role — a permission set: `read-only`, `standard`, `admin`, or a custom set your org defines in the dashboard. Replaces their per-member overrides (apply fresh ones with --add/--remove)."),
    add: Optional[List[str]] = typer.Option(None, "--add", help="Grant permissions, same `slug:action.action` token format as `users create` (dotted actions expand; comma / repeated flag / quoted group compose). Incremental — merged into the member's CURRENT grants, unless --permission-set is also given."),
    remove: Optional[List[str]] = typer.Option(None, "--remove", help="Revoke permissions, same `slug:action.action` token format as --add. Incremental — applied to the member's CURRENT grants, unless --permission-set is also given."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Change a member's permissions and show the diff. Referenced by **email** (or a UUID id).

    Two ways to use it (combine if you like):

    * **Reassign a role** — `--permission-set <set>` swaps the member's base role (a built-in
      `read-only` / `standard` / `admin`, or a custom org set); add `--add`/`--remove` to layer
      fresh per-member overrides on top.
    * **Tweak incrementally** — `--add` / `--remove` **alone** adjust the member's *current* grants
      (their set is kept). `--add` grants, `--remove` revokes; both take the compact
      `slug:action.action` token format (dotted actions expand; comma / repeated / quoted compose).

    The CLI reads the current grants, computes the resulting set `(set ∪ added) − removed`, and
    shows a git-style diff — added green, removed struck-through, unchanged dim. It confirms first
    (default no; `--yes` skips) and a no-op exits without calling the server. Needs `users:update`
    (+ `users:read`). With `--json`: `{id, email, permission_set, permissions, added, removed}`.

    Examples:

    * `fp users update dev@example.com --add keys:create.regenerate` — grant on top of current grants
    * `fp users update dev@example.com --remove alerts:read,incidents:ack` — revoke a couple of grants
    * `fp users update dev@example.com --add events:read --remove keys:delete` — add and remove at once
    * `fp users update dev@example.com --permission-set admin --yes` — reassign the role (no prompt)
    """
    state: AppState = ctx.obj
    if permission_set is None and not add and not remove:
        raise typer.BadParameter("nothing to update — pass --permission-set, --add, and/or --remove.")
    parsed_add = _parse_user_tokens_or_exit(state, add)
    parsed_remove = _parse_user_tokens_or_exit(state, remove)
    both = sorted(set(parsed_add) & set(parsed_remove))
    if both:
        raise typer.BadParameter(f"{', '.join(both)} given to both --add and --remove.")
    cctx = require_auth(state)
    _validate_permission_set_or_exit(state, cctx, permission_set)
    user = _resolve_user_or_exit(state, api.list_users(cctx), email)
    before = set(user.permissions)
    add_set, remove_set = set(parsed_add), set(parsed_remove)

    # Build the body to send + predict the resulting effective set (for the confirm preview).
    if permission_set is None:
        # Incremental: merge the override deltas into the member's CURRENT overrides (keep the set).
        new_set = user.permission_set
        merged_add = (set(user.permission_added or []) | add_set) - remove_set
        merged_remove = (set(user.permission_removed or []) | remove_set) - add_set
        new_added, new_removed = sorted(merged_add), sorted(merged_remove)
        # Applying the deltas to the current effective set is exact (base is unchanged).
        predicted_after = (before | add_set) - remove_set
    else:
        # Assign a role: the set is the base; the flags are its fresh overrides.
        new_set, new_added, new_removed = permission_set, sorted(add_set), sorted(remove_set)
        if permission_set in permissions.PRESETS:
            predicted_after = (set(permissions.PRESETS[permission_set]) | add_set) - remove_set
        else:
            predicted_after = None  # a custom set we can't expand locally → confirm generically

    if predicted_after is not None:
        p_added = predicted_after - before
        p_removed = before - predicted_after
        if not p_added and not p_removed:  # no-op: don't call the server, don't prompt
            if state.json:
                output.emit_json({"id": user.id, "email": user.email, "permission_set": new_set,
                                  "permissions": sorted(before), "added": [], "removed": []})
            else:
                output.user_no_change()
            return
        proceed = (not _write.should_prompt(state, yes)) or output.confirm_user_update(
            user.email, len(p_added), len(p_removed))
    else:
        proceed = _write.confirm_action(
            state, "change permissions for", user.email,
            consequence="this reassigns their role; the user keeps access", assume_yes=yes)

    if not proceed:
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled("permissions unchanged")
        return

    result = api.update_user(
        cctx, user.id, permission_set=new_set, permission_added=new_added, permission_removed=new_removed)
    after = set(result.permissions)
    added, removed = sorted(after - before), sorted(before - after)
    _write.record_action("user_updated", resource="user", success=True, permission_count=len(after))
    if state.json:
        output.emit_json({"id": result.id, "email": result.email, "permission_set": result.permission_set,
                          "permissions": sorted(after), "added": added, "removed": removed})
        return
    if not added and not removed:  # custom-set assign that turned out to be a no-op
        output.user_no_change()
        return
    output.render_user_updated(result, added=added, removed=removed, union=sorted(before | after))


def users_disable(
    ctx: typer.Context,
    email: str = typer.Argument(..., metavar="EMAIL", help="User email (or id) to disable."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Disable a member by email — they can no longer sign in (reversible with `users enable`).

    Confirms first (amber, default no; `--yes` skips). Refuses a protected member or your own
    account. Already-disabled is a calm no-op. Needs `users:delete`. With `--json`:
    `{id, email, status: "disabled"}` (or `{cancelled: true}` on a declined prompt).

    Example:

    * `fp users disable dev@example.com`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    user = _resolve_user_or_exit(state, api.list_users(cctx), email)
    if user.is_protected:
        raise ForbiddenError(f'"{user.email}" is protected and can\'t be disabled')
    if state.config.email and user.email == state.config.email:
        raise ForbiddenError("you can't disable your own account")
    if user.disabled_at:  # already disabled — a no-op, not an error
        if state.json:
            output.emit_json({"id": user.id, "email": user.email, "status": "disabled"})
        else:
            output.user_already_disabled(user.email)
        return
    if not _write.confirm_action(
        state, "disable user", user.email,
        consequence="they can no longer sign in — you can re-enable them later", assume_yes=yes,
    ):
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled("nothing changed")
        return
    api.disable_user(cctx, user.id)
    _write.record_action("user_disabled", resource="user", success=True, destructive=True)
    if state.json:
        output.emit_json({"id": user.id, "email": user.email, "status": "disabled"})
    else:
        output.user_disabled(user.email)


def users_enable(
    ctx: typer.Context,
    email: str = typer.Argument(..., metavar="EMAIL", help="User email (or id) to re-enable."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Re-enable a disabled member by email — they can sign in again.

    Confirms first (a calm re-activation prompt, default no; `--yes` skips). Already-active is a
    calm no-op. Needs `users:delete`. With `--json`: `{id, email, status: "active"}` (or
    `{cancelled: true}` on a declined prompt).

    Example:

    * `fp users enable dev@example.com`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    user = _resolve_user_or_exit(state, api.list_users(cctx), email)
    if not user.disabled_at:  # already active — a no-op, not an error
        if state.json:
            output.emit_json({"id": user.id, "email": user.email, "status": "active"})
        else:
            output.user_already_active(user.email)
        return
    if not _write.confirm_action(
        state, "re-enable user", user.email,
        consequence="they'll be able to sign in again", assume_yes=yes,
        glyph="↑", color=theme.ACCENT,
    ):
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled("nothing changed")
        return
    result = api.enable_user(cctx, user.id)
    _write.record_action("user_enabled", resource="user", success=True)
    if state.json:
        output.emit_json({"id": result.id, "email": result.email, "status": "active"})
    else:
        output.user_enabled(user.email)


_USERS_GROUP_HELP = """Manage org members — list, inspect, invite, and adjust their permissions.

Members are referenced by **email** (unique in the org). A member's grants are a permission
set (role) plus optional per-member `--add` / `--remove` overrides.

**Subcommands:** `list` · `show` · `create` · `update` · `disable` · `enable`

**Examples:**

* `fp users list --active-only` — current members, active first
* `fp users show dev@example.com` — one member's identity + full grants
* `fp users create dev@example.com --permission-set standard` — invite with a role
* `fp users update dev@example.com --add keys:create --remove alerts:read` — tweak grants
* `fp users disable dev@example.com` / `fp users enable dev@example.com` — revoke / restore sign-in
"""


def register(app: typer.Typer) -> None:
    users_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help=_USERS_GROUP_HELP,
    )
    users_app.command("list", epilog=GLOBALS_EPILOG)(users_list)
    users_app.command("show", epilog=GLOBALS_EPILOG)(users_show)
    users_app.command("create", epilog=GLOBALS_EPILOG)(users_create)
    users_app.command("update", epilog=GLOBALS_EPILOG)(users_update)
    users_app.command("disable", epilog=GLOBALS_EPILOG)(users_disable)
    users_app.command("enable", epilog=GLOBALS_EPILOG)(users_enable)
    app.add_typer(users_app, name="users")
