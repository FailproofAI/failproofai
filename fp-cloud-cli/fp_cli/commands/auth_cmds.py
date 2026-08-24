"""login / logout / whoami."""

from __future__ import annotations

from dataclasses import asdict
from typing import List, Optional, Tuple

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import analytics
from .. import auth
from .. import config as cfgmod
from .. import orgs as orgsmod
from .. import output
from .. import select as selectmod
from .._context import (
    GLOBALS_EPILOG,
    AppState,
    AuthMode,
    build_context,
    deny_in_key_mode,
    resolved_base_url,
)
from ..client import ClientContext, get_session_user, org_is_accessible
from ..errors import ApiError, AuthError


def _resolve_login_org(
    state: AppState,
    requested: Optional[str],
    slugs: List[str],
    is_admin: bool,
    saved: Optional[str] = None,
    probe_ctx: Optional[ClientContext] = None,
    discovery_failed: bool = False,
) -> Tuple[Optional[str], bool]:
    """Pick the active org at login. Returns ``(slug_or_None, needs_selection)``.

    ``requested`` is the **explicit** tenant only (login ``--org`` / global
    ``--org`` / ``FP_ORG``) — NOT a previously-saved tenant. ``saved`` is the
    last-used tenant from the config; it never bypasses the picker, it is only the
    interactive default (Enter-to-keep) and the non-interactive fallback.

    Selection rules for a multi-org user with no explicit ``--org``:
      * interactive TTY → always show the picker (defaulting to ``saved``), so the
        user re-chooses every login rather than silently re-entering a stale tenant.
      * non-interactive (``--json`` / piped stdin) → reuse a still-valid ``saved``
        tenant if present, else return ``needs_selection`` so the caller persists
        the token, lists the orgs and exits non-zero for a script to handle.
    """
    if requested:
        if not orgsmod.is_valid_org_slug(requested):
            raise click.BadParameter(
                f"'{requested}' is not a valid org slug.", param_hint="--org"
            )
        # Fast path: an org you're a member of is always fine (no server round-trip).
        if requested in slugs:
            return requested, False
        # Not a membership — but only say so if we actually LOOKED. When the
        # membership fetch failed, `slugs` is empty because nothing answered,
        # not because the user belongs to nothing, and "You are not a member of
        # org 'X'. Your orgs: (none)." is then a confident lie that exits 2 on a
        # tenant they may well have. Fall through to the server probe instead,
        # which is the only thing that can still give a real answer.
        if not is_admin and not discovery_failed:
            raise click.BadParameter(
                f"You are not a member of org '{requested}'. "
                f"Your orgs: {', '.join(slugs) or '(none)'}.",
                param_hint="--org",
            )
        # Instance admin requesting a non-member org: allow ONLY if it actually
        # EXISTS and is accessible — verified against the server. This closes the
        # old `or is_admin` hole that accepted (and saved) any typo'd/nonexistent
        # slug. Same check covers --org and FP_ORG (both feed `requested`).
        if probe_ctx is not None and org_is_accessible(probe_ctx, requested):
            return requested, False
        if discovery_failed:
            raise click.BadParameter(
                f"Could not verify access to org '{requested}' — reading your "
                "memberships failed, and the direct check did not succeed either. "
                "You are still signed in; retry once the dashboard is reachable.",
                param_hint="--org",
            )
        raise click.BadParameter(
            f"Org '{requested}' does not exist or you do not have access to it.",
            param_hint="--org",
        )
    if len(slugs) == 1:
        return slugs[0], False
    if not slugs:
        return None, False  # no memberships (e.g. instance admin) — pick per command with --org
    # Multi-org, no explicit tenant requested.
    if state.json or not selectmod.stdin_is_tty():
        # Can't prompt: reuse a still-valid saved tenant, else ask the caller to choose.
        if saved and saved in slugs:
            return saved, False
        return None, True
    return selectmod.choose_org(slugs, default=saved), False


def _looks_like_email(value: str) -> bool:
    """A light shape check for the interactive email step — `x@y.z`, no spaces (the server is the
    real authority; this just catches an obvious typo before sending a code)."""
    s = (value or "").strip()
    return "@" in s and " " not in s and "." in s.rsplit("@", 1)[-1] and len(s) >= 5


def _login_interactive(state: AppState, base: str, email_opt: Optional[str], org_opt: Optional[str]) -> None:
    """The single-box interactive login (real TTY only): one redrawn-in-place panel — email → code →
    (org picker) → signed-in. Mirrors the non-interactive orchestration below; only the UI differs.
    Network/auth errors propagate (terminal restored on the way out) to the standard red error box."""
    saved = state.config.org
    persisted = False
    with selectmod.LoginBox() as box:
        try:
            # email
            if email_opt:
                email = email_opt
                box.note("email", email)
            else:
                email = box.text_step("email", validate=_looks_like_email,
                                      error_msg="that doesn't look like an email")
            # send the code
            box.working("sending a code…")
            auth.request_otp(base, email, timeout=state.timeout, verify=not state.insecure)
            box.note("code sent")
            # code → verify. A wrong/expired code is reported cleanly INSIDE the box (not a raw
            # HTTP 500) with a relogin hint, then we exit — re-run `fp login` for a fresh code.
            code = box.text_step("code", helper="enter the 6-digit code", slots=6, collapse=False)
            box.working("verifying…")
            try:
                token, expires_in, user = auth.verify_otp(
                    base, email, code.strip(), timeout=state.timeout, verify=not state.insecure
                )
            except AuthError:
                box.fail("that code didn't match or has expired", "sign in again with fp login")
                raise typer.Exit(code=4)
            except ApiError as exc:  # e.g. too many attempts (429)
                box.fail(exc.message, "try fp login again in a bit")
                raise typer.Exit(code=exc.exit_code)
            box.note("code")  # collapse to `✓ code` — never echo the value
            # persist first (so we can read authoritative memberships), then resolve the org
            auth.persist_session(state.config, base, token, expires_in, user, insecure=state.insecure)
            persisted = True
            analytics.identify(state.config.user_id)
            sess_ctx = ClientContext(base_url=base, token=token, timeout=state.timeout, verify=not state.insecure)
            slugs: List[str] = []
            is_admin = False
            discovery_failed: Optional[str] = None
            # The token is already persisted, so a discovery failure must NOT
            # undo the login — but it must not be reported as "no memberships"
            # either. A timeout, a 500, a malformed body or a permissions
            # problem all used to collapse into an empty list, which then reads
            # as a single-org user: the active org is silently cleared, a
            # previously chosen tenant is dropped, and an explicit `--org` is
            # rejected as inaccessible when it was never actually checked.
            # Keeping the session and SAYING so is the honest recovery.
            try:
                su = get_session_user(sess_ctx)
                slugs = su.org_slugs
                is_admin = su.is_instance_admin
            except Exception as exc:
                discovery_failed = str(exc) or exc.__class__.__name__
                output.cli_warn(
                    "⚠ signed in, but could not read your organisation memberships "
                    f"({discovery_failed}). The active org was left unchanged — "
                    "run `fp orgs list` once the dashboard is reachable."
                )
            requested = org_opt or state.org_explicit
            if requested:
                chosen, _ = _resolve_login_org(
                    state, requested, slugs, is_admin, saved=saved, probe_ctx=sess_ctx,
                    discovery_failed=discovery_failed is not None,
                )
                if chosen:
                    box.note("org", chosen)
            elif len(slugs) > 1:
                chosen = box.pick(slugs, default=saved if saved in slugs else None)
            else:
                chosen = slugs[0] if slugs else None  # single/none → named only in the final block
            state.config.org = chosen
            cfgmod.save_config(state.config)
            analytics.capture("logged_in")  # also count the interactive (real-TTY) login path
            who = user.get("email") or email
            box.finish(who, chosen)
        except selectmod.LoginCancelled:
            box.cancel(persisted)  # calm close inside the same frame


def login(
    ctx: typer.Context,
    email: Optional[str] = typer.Option(None, "--email", "-e", help="Email to send the login code to (prompted if omitted)."),
    org: Optional[str] = typer.Option(None, "--org", help="Org/tenant slug to sign in to — skips the picker. Must be one you can access."),
    force: bool = typer.Option(False, "--force", help="Re-authenticate even if you already have a valid session."),
) -> None:
    """Sign in to the dashboard with an emailed one-time code.

    You enter your email (or pass `--email`), the dashboard emails a 6-digit code, and you paste
    it back. The session is saved to `~/.failproofai/fpcli/cli-auth.json` (mode 0600) and lasts ~24h — just
    re-run `login` when it expires. Already signed in? `login` shows who you are and exits 0
    without prompting; pass `--force` to re-authenticate anyway.

    The active org is chosen here and saved for later commands. With one org it's picked
    automatically; with several you choose from a list once your email is verified (your last-used
    org is the Enter-to-keep default), or pass `--org <slug>` to skip the picker. Switch it later
    with `fp orgs switch <slug>`.

    Both prompts are skippable: `--email` / `--org` provide the values up front, otherwise you're
    asked interactively. First time, set the dashboard URL with the global `--base-url` (saved for
    next time); add the global `--insecure` for a self-signed/internal dashboard.

    With `--json`: `{"logged_in": true, "email": "...", "org": "<slug>", "expires_in_secs": <n>}`.
    Exit `0` on success; `2` if sign-in worked but the org is still unresolved (multi-org, no
    `--org`, non-interactive) — the token is saved, so re-run with `--org <slug>`.

    Examples:

    * `fp login` — fully interactive: prompts for your email, then the org picker
    * `fp --base-url https://fp.example.com login` — first time: set the dashboard URL, then sign in interactively
    * `fp login --email you@example.com --org acme` — skip both prompts (email + org up front)
    * `fp --base-url https://dash.internal --insecure login` — self-signed / internal dashboard
    """
    state: AppState = ctx.obj
    deny_in_key_mode(
        state,
        "login",
        "it signs a human in and saves the session, and an API key already IS the "
        "credential — there is nothing to sign in as",
    )
    # Already signed in with a still-valid session? Don't silently start a second login —
    # but DO honor an explicit selector instead of dropping it: a different `--email` means
    # "sign in as someone else" (fall through to a full re-auth); an explicit `--org` that
    # differs from the active one switches the tenant on the existing session (no re-auth).
    # `--force` overrides everything. Otherwise, just report who you are.
    if not force and not cfgmod.is_expired(state.config):
        requested = org or state.org_explicit
        switching_account = bool(email) and email != state.config.email
        if not switching_account:
            if requested and requested != state.config.org:
                base = resolved_base_url(state)
                sess_ctx = ClientContext(
                    base_url=base, token=state.config.session_token,
                    timeout=state.timeout, verify=not state.insecure,
                )
                # Read memberships to validate the requested org. Unlike the post-OTP flow (where
                # memberships are best-effort), here a failed read must surface — otherwise an
                # empty membership set would mis-reject a valid org as "not a member". A dead/
                # expired session (AuthError) or outage (NetworkError) propagates to the chokepoint.
                su = get_session_user(sess_ctx)
                slugs, is_admin = su.org_slugs, su.is_instance_admin
                # Validates membership / admin-accessibility (raises a clean usage error on a
                # bad slug) exactly like a fresh login, then persists the new active tenant.
                chosen, _ = _resolve_login_org(
                    state, requested, slugs, is_admin, saved=state.config.org, probe_ctx=sess_ctx
                )
                state.config.org = chosen
                cfgmod.save_config(state.config)
                analytics.capture("org_selected")  # name-only (no slug value)
                if state.json:
                    output.emit_json({
                        "logged_in": True, "email": state.config.email, "org": chosen,
                        "already_signed_in": True, "switched_org": True,
                    })
                else:
                    output.signed_in(state.config.email, chosen)
                return
            if state.json:
                output.emit_json(
                    {
                        "logged_in": True,
                        "email": state.config.email,
                        "org": state.config.org,
                        "already_signed_in": True,
                    }
                )
            else:
                output.already_signed_in(state.config.email, state.config.org)
            return
    base = resolved_base_url(state)
    # On a real TTY (not --json / pipes / CI) run the single-box interactive flow; everything
    # else keeps the plain prompt flow below (which the test runner + scripts rely on).
    if not state.json and selectmod.login_box_supported():
        _login_interactive(state, base, email, org)
        return
    output.auth_header()
    if not email:
        email = output.prompt("email")
    auth.request_otp(base, email, timeout=state.timeout, verify=not state.insecure)
    output.code_sent(email)
    code = output.prompt("code")
    token, expires_in, user = auth.verify_otp(
        base, email, str(code).strip(), timeout=state.timeout, verify=not state.insecure
    )
    # Persist the token first so we can query the session for authoritative memberships:
    # the OTP-verify payload is slim (no memberships / is_instance_admin) — only
    # GET /api/auth/session returns them.
    auth.persist_session(state.config, base, token, expires_in, user, insecure=state.insecure)
    analytics.identify(state.config.user_id)
    # One context, reused to read memberships AND to validate an explicit --org.
    sess_ctx = ClientContext(
        base_url=base, token=token, timeout=state.timeout, verify=not state.insecure
    )
    slugs: List[str] = []
    is_admin = False
    discovery_failed: Optional[str] = None
    # Same reasoning as the interactive flow above: keep the session, but never
    # let a discovery failure masquerade as "this user belongs to no orgs".
    try:
        su = get_session_user(sess_ctx)
        slugs = su.org_slugs
        is_admin = su.is_instance_admin
    except Exception as exc:
        discovery_failed = str(exc) or exc.__class__.__name__
        output.cli_warn(
            "⚠ signed in, but could not read your organisation memberships "
            f"({discovery_failed}). The active org was left unchanged — "
            "run `fp orgs list` once the dashboard is reachable."
        )
    # The active tenant at login is an EXPLICIT choice only: the `login --org`
    # flag, the global `--org`, or FP_ORG. A previously *saved* tenant must
    # not silently bypass the picker — a multi-org user re-running `login` is shown
    # their orgs and chooses (the saved one is just the default). `state.org`
    # (flag > env > config) is NOT used here precisely because it folds in config.
    requested = org or state.org_explicit
    saved = state.config.org
    chosen, needs_selection = _resolve_login_org(
        state, requested, slugs, is_admin, saved=saved, probe_ctx=sess_ctx,
        discovery_failed=discovery_failed is not None,
    )
    state.config.org = chosen  # persist the active tenant (or clear it if unresolved)
    cfgmod.save_config(state.config)
    who = user.get("email") or email

    if needs_selection:
        # Multi-org, non-interactive, no --org: token is saved but no tenant is active.
        if state.json:
            output.emit_json(
                {
                    "logged_in": True,
                    "email": who,
                    "org": None,
                    "expires_in_secs": expires_in,
                    "needs_org_selection": True,
                    "orgs": slugs,
                }
            )
        else:
            output.warn(
                "Logged in, but you belong to multiple orgs and none was selected."
            )
            output.info("Your orgs: " + ", ".join(slugs))
            output.hint("Re-run with --org <slug> (e.g. `fp login --org "
                        f"{slugs[0]}`) or `fp orgs switch <slug>`.")
        raise typer.Exit(code=2)

    analytics.capture("logged_in")  # name-only business event (no email/id/org value)
    if state.json:
        output.emit_json(
            {"logged_in": True, "email": who, "org": chosen, "expires_in_secs": expires_in}
        )
    else:
        output.signed_in(who, chosen)


def logout(ctx: typer.Context) -> None:
    """Sign out and clear the saved session from this machine.

    Best-effort server-side revocation, then wipes the session from
    `~/.failproofai/fpcli/cli-auth.json` —
    the token, your email and user id, and the active org — so nothing about who you were or
    which tenant you used is left behind. Your `base_url` and `--insecure` preference are kept,
    so the next `login` is quick. If you are not signed in it is a no-op that reports
    "already signed out".

    With `--json`: `{"logged_out": true}` (plus `"already_signed_out": true` when there was no
    session to clear).

    Example:

    * `fp logout`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(
        state,
        "logout",
        "an API key is never saved to disk, so there is nothing here to clear — and "
        "revoking one takes `keys disable`, a permission a scoped key does not hold",
    )
    # No active session → nothing to revoke. Don't falsely claim a sign-out happened.
    if not state.token:
        if state.json:
            output.emit_json({"logged_out": True, "already_signed_out": True})
        else:
            output.already_signed_out()
        return
    if state.base_url:
        auth.logout(state.base_url, state.token, timeout=state.timeout, verify=not state.insecure)
    analytics.capture("logged_out")  # name-only; fire before reset() rotates the anon id
    cfgmod.clear_token(state.config)
    analytics.reset()
    if state.json:
        output.emit_json({"logged_out": True})
    else:
        output.signed_out()


def whoami(ctx: typer.Context) -> None:
    """Show the **current user**, the active org, and that org's permissions.

    Never errors on a missing/expired session — it reports "not logged in" instead, so
    it is safe for agents to probe auth state. Permissions are **per org**: the
    `permissions` shown are for the active org. With `--json`, logged in:
    `{"logged_in": true, "auth_mode": "session", "id": "...", "email": "...",
    "is_instance_admin": <bool>, "active_org": "<slug|null>", "permissions": [...],
    "memberships": [...]}`; otherwise `{"logged_in": false, "auth_mode": "none"}`.

    With an API key it is the one command that still works, and it reports an honest
    different shape — `{"logged_in": false, "auth_mode": "api_key", "active_org":
    "<slug|null>"}`. A `null` there is worth reading: an instance-scoped key with no
    `--org` resolves server-side to the DEFAULT org, so you would get *an* org's data,
    just not necessarily the one you meant, with no error anywhere.

    Example:

    * `fp whoami`
    * `fp --json whoami`
    """
    state: AppState = ctx.obj
    if state.auth_mode is AuthMode.API_KEY:
        # `whoami` is contractually "never errors" (cli/skill/SKILL.md leans on it as
        # the pre-flight probe), so key mode reports rather than refuses — but it does
        # NOT invent a user: a key has no identity the CLI can read, and no /v1
        # endpoint would tell us. Report exactly what we know, locally, exit 0.
        if state.json:
            output.emit_json(
                {
                    "logged_in": False,
                    "auth_mode": AuthMode.API_KEY.value,
                    "active_org": state.org_explicit,
                }
            )
        else:
            output.render_key_mode_whoami(state.org_explicit)
        return
    if not state.token:
        if state.json:
            output.emit_json({"logged_in": False, "auth_mode": AuthMode.NONE.value})
        else:
            output.not_signed_in()
        return
    try:
        user = get_session_user(build_context(state))
    except AuthError:
        if state.json:
            output.emit_json({"logged_in": False, "auth_mode": AuthMode.NONE.value})
        else:
            output.not_signed_in()
        return

    # Effective active org: explicit/global/saved, else the sole membership.
    active = state.org
    if not active and len(user.memberships) == 1:
        active = user.memberships[0].org_slug
    active_perms = user.permissions_for(active)

    if state.json:
        output.emit_json(
            {
                "logged_in": True,
                "auth_mode": AuthMode.SESSION.value,
                "id": user.id,
                "email": user.email,
                "is_instance_admin": user.is_instance_admin,
                "active_org": active,
                "permissions": active_perms,
                "memberships": [asdict(m) for m in user.memberships],
            }
        )
        return

    # Scannable identity view: a small header, then a permissions panel + an orgs panel.
    orgs = [
        {
            "slug": m.org_slug,
            "name": m.org_name,
            "role": m.permission_set or "custom",
            "perms": len(m.permissions),
            "is_active": m.org_slug == active,
        }
        for m in user.memberships
    ]
    active_role = next((o["role"] for o in orgs if o["is_active"]), None)
    output.render_whoami(
        email=user.email,
        is_instance_admin=user.is_instance_admin,
        user_id=user.id,
        active_org=active,
        active_role=active_role,
        permissions=active_perms,
        orgs=orgs,
    )


# whoami's relevant global flag is `--json`; the full global-options list is omitted here.
_WHOAMI_EPILOG = "The global `--json` option goes **before** the command: `fp --json whoami`."


def register(app: typer.Typer) -> None:
    app.command("login", epilog=GLOBALS_EPILOG)(login)
    app.command("logout", epilog=GLOBALS_EPILOG)(logout)
    app.command("whoami", epilog=_WHOAMI_EPILOG)(whoami)
