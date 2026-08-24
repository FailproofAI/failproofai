"""orgs list / orgs switch / orgs current — discover, select, and inspect the active tenant.

Org membership comes from the session (no dedicated list endpoint), so the
listing reads it via ``GET /api/auth/session``. ``switch`` persists the chosen
slug to ``~/.failproofai/fpcli/cli-auth.json`` so later commands send it as the
``X-AgentEye-Org`` header; ``current`` reports the tenant in effect right now.
"""

from __future__ import annotations

import difflib
from typing import Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import analytics
from .. import config as cfgmod
from .. import orgs as orgsmod
from .. import output
from .. import select as selectmod
from .._context import GLOBALS_EPILOG, AppState, build_context, deny_in_key_mode
from ..client import get_session_user, org_is_accessible
from ..errors import AuthError

# Every subcommand here reads or writes the SESSION's org memberships, which an API key
# does not have: memberships belong to a person, and `GET /auth/session` (their only
# source) is deliberately absent from the versioned API. Refuse before any network call
# rather than let a 404 on a path that does not exist explain it.
_KEY_MODE_REASON = (
    "org membership belongs to a signed-in user; a key already acts for one org "
    "(pass --org <slug> to target another)"
)


def _require_session(state: AppState):
    """Fetch the session user, or emit a friendly 'not logged in' and exit 4-style."""
    if not state.token:
        raise AuthError("Not logged in. Run fp login.")
    return get_session_user(build_context(state))


def _active_org(state: AppState, user) -> Optional[str]:
    """The effective active org: the explicit/saved value, else your sole org."""
    active = state.org
    if not active and len(user.memberships) == 1:
        active = user.memberships[0].org_slug
    return active


def _persist_org(state: AppState, slug: str) -> None:
    """Persist ``slug`` as the active tenant (no rendering — the caller chooses the output)."""
    state.config.org = slug
    cfgmod.save_config(state.config)
    analytics.capture("org_selected")


def _switch_to(state: AppState, slug: str, *, prev: Optional[str], perm_count: Optional[int]) -> None:
    """Persist the chosen org and render the result — the boxed 'switched org' card (or the
    ``{"active_org"}`` payload under ``--json``). Shared by the positional + interactive paths so
    both render identically."""
    _persist_org(state, slug)
    if state.json:
        output.emit_json({"active_org": slug})
    else:
        output.render_switched_org(slug=slug, prev_slug=prev, perm_count=perm_count)


def _render_orgs(state: AppState) -> None:
    """Shared body of ``orgs list`` — your orgs + your role in each."""
    user = _require_session(state)
    active = _active_org(state, user)

    if state.json:
        output.emit_json(
            {
                "active_org": active,
                "is_instance_admin": user.is_instance_admin,
                "orgs": [
                    {
                        "org_slug": m.org_slug,
                        "org_name": m.org_name,
                        "permission_set": m.permission_set,
                        "permissions": m.permissions,
                        "active": m.org_slug == active,
                    }
                    for m in user.memberships
                ],
            }
        )
        return

    if not user.memberships:
        output.info("  You are not a member of any org.")
        if user.is_instance_admin:
            output.hint("  Instance admin — pass --org <slug> to act in a specific org.")
        return
    output.render_orgs_list([
        {
            "is_active": m.org_slug == active,
            "slug": m.org_slug,
            "name": m.org_name,
            "role": m.permission_set or "custom",
            "perms": len(m.permissions),
        }
        for m in user.memberships
    ])


# ── commands ────────────────────────────────────────────────────────────────


def org_list(ctx: typer.Context) -> None:
    """List the orgs you belong to, with your role in each (the active one is marked).

    Reads your memberships from the current session — for each org it shows the org
    slug + name, your permission set (role), and how many permissions you hold there.
    The active org (`--org`/`FP_ORG`/saved, or your sole org) is marked `●`. With
    `--json`: `{"active_org", "is_instance_admin", "orgs":[{"org_slug","org_name",
    "permission_set","permissions","active"}]}`.

    Example:

    * `fp orgs list`
    * `fp --json orgs list`
    """
    deny_in_key_mode(ctx.obj, "orgs list", _KEY_MODE_REASON)
    _render_orgs(ctx.obj)


def _active_membership(user, active):
    """The membership for the active org (or None — e.g. an instance admin acting via --org)."""
    return next((m for m in user.memberships if m.org_slug == active), None)


def org_current(ctx: typer.Context) -> None:
    """Show the org/tenant you're acting as right now — a compact identity card.

    The active org is the global `--org`/`FP_ORG`, else the saved default, else your sole
    org if you belong to just one. The card shows the slug + name, your role, your permission
    count, and the signed-in email; see the permissions themselves with `fp orgs perms`.
    If you haven't picked an org it tells you to run `fp orgs switch`. With `--json`:
    `{"slug", "name", "role", "permission_count", "user_email"}`.

    Example:

    * `fp orgs current`
    * `fp --json orgs current`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "orgs current", _KEY_MODE_REASON)
    user = _require_session(state)
    active = _active_org(state, user)
    m = _active_membership(user, active)
    role = (m.permission_set or "custom") if m else ("instance admin (not a member)" if active else None)
    perm_count = len(m.permissions) if m else 0

    if state.json:
        output.emit_json(
            {
                "slug": active,
                "name": m.org_name if m else None,
                "role": role,
                "permission_count": perm_count,
                "user_email": user.email,
            }
        )
        return

    if not active:
        output.info("  No active org selected.")
        output.hint("  Run fp orgs switch to choose one.")
        return
    output.render_current_org(
        slug=active, name=m.org_name if m else None, role=role or "—",
        permission_count=perm_count, email=user.email,
    )


def org_perms(ctx: typer.Context) -> None:
    """Show your permissions in the active org — grouped by resource, coloured by risk.

    The same grouped view as `fp whoami`, scoped to the active org: one row per resource
    with its actions (read = green, create/modify = pink, invoke = amber, destructive = red).
    With `--json`: `{"slug", "role", "permissions", "permission_count"}` (the flat grant list).

    Example:

    * `fp orgs perms`
    * `fp --json orgs perms`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "orgs perms", _KEY_MODE_REASON)
    user = _require_session(state)
    active = _active_org(state, user)
    m = _active_membership(user, active)

    if state.json:
        output.emit_json(
            {
                "slug": active,
                "role": (m.permission_set or "custom") if m else None,
                "permissions": m.permissions if m else [],
                "permission_count": len(m.permissions) if m else 0,
            }
        )
        return

    if not active:
        output.info("  No active org selected.")
        output.hint("  Run fp orgs switch to choose one.")
        return
    if not m:
        output.info(f"  You are not a member of '{active}' (acting as instance admin).")
        output.hint("  Instance admins hold no per-org grants; switch to an org you belong to.")
        return
    output.render_org_perms(slug=active, role=m.permission_set or "custom",
                            permissions=m.permissions, name=m.org_name)


def org_switch(
    ctx: typer.Context,
    slug: Optional[str] = typer.Argument(
        None, help="Org/tenant slug to switch to. Omit it to pick from an arrow-key list (in a terminal)."
    ),
) -> None:
    """Switch the active org/tenant — pass a slug, or omit it to pick one interactively.

    `fp orgs switch acme` switches straight to `acme`. `fp orgs switch` with no slug
    opens an arrow-key picker (↑↓ to move, ⏎ to select, esc to cancel) starting on your current
    org; if you belong to exactly one org there's nothing to switch to. Either way the result is
    a boxed `switched org` card, and the choice is persisted to
    `~/.failproofai/fpcli/cli-auth.json` so later
    commands send it as the active tenant.

    A non-interactive run (piped stdin / CI) falls back to a numbered prompt. With `--json` a slug
    is required and the output is just `{"active_org": "<slug>"}` — no card.

    Examples:

    * `fp orgs switch acme` — switch straight to acme
    * `fp orgs switch` — pick from an arrow-key list
    * `fp --json orgs switch acme | jq` — switch and capture the active org
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "orgs switch", _KEY_MODE_REASON)
    user = _require_session(state)
    current = _active_org(state, user)

    def _perms_for(s: str) -> Optional[int]:
        return next((len(m.permissions) for m in user.memberships if m.org_slug == s), None)

    # ── positional form: resolve + switch directly (same card as the picker) ──
    if slug is not None:
        accessible = slug in user.org_slugs or (
            user.is_instance_admin
            and orgsmod.is_valid_org_slug(slug)
            and org_is_accessible(build_context(state), slug)
        )
        if not accessible:
            # Raise a usage error (exit 2) the central chokepoint renders the same way under
            # --json (a JSON envelope on stdout) and for humans (a red box on stderr) — the old
            # code emitted nothing under --json, so a script got a bare exit 2 with no reason.
            match = difflib.get_close_matches(slug, user.org_slugs, n=1, cutoff=0.6)
            err = click.UsageError(f"no org named {slug}")
            err.hint = (
                f"did you mean {match[0]}" if match else "run `fp orgs list` to see your orgs"
            )
            raise err
        if slug == current:
            output.emit_json({"active_org": slug}) if state.json else output.org_already_on(slug)
            return
        _switch_to(state, slug, prev=current, perm_count=_perms_for(slug))
        return

    # ── no slug → discover ──
    slugs = user.org_slugs
    if not slugs:
        output.emit_json({"active_org": current}) if state.json else \
            output.org_none_available(instance_admin=user.is_instance_admin)
        return
    if len(slugs) == 1:
        _persist_org(state, slugs[0])
        output.emit_json({"active_org": slugs[0]}) if state.json else output.org_only_one(slugs[0])
        return
    if state.json:
        # No card to render in json mode and no way to pick → require an explicit slug.
        raise typer.BadParameter(
            "No org given. With --json pass a slug, e.g. `fp --json orgs switch <slug>`."
        )

    # Pick: an arrow-key picker on a real TTY, else a numbered prompt (reads piped input;
    # aborts cleanly on empty stdin) — both inside choose_org_interactive.
    orgs_view = [{"slug": m.org_slug, "is_current": m.org_slug == current} for m in user.memberships]
    chosen = selectmod.choose_org_interactive(orgs_view, current_slug=current)
    if chosen is None:
        output.org_switch_cancelled(current)
        return
    if chosen == current:
        output.org_already_on(chosen)
        return
    _switch_to(state, chosen, prev=current, perm_count=_perms_for(chosen))


def register(app: typer.Typer) -> None:
    _ctx = {"help_option_names": ["-h", "--help"]}

    # A single `orgs` group holding all tenant functionality.
    orgs_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings=_ctx,
        help="Inspect and select the active org/tenant. Subcommands: **list**, **switch**, **current**, **perms**.",
    )
    orgs_app.command("list", epilog=GLOBALS_EPILOG)(org_list)
    orgs_app.command("switch", epilog=GLOBALS_EPILOG)(org_switch)
    orgs_app.command("current", epilog=GLOBALS_EPILOG)(org_current)
    orgs_app.command("perms", epilog=GLOBALS_EPILOG)(org_perms)
    app.add_typer(orgs_app, name="orgs")
