"""Shared command-layer state and helpers.

Kept separate from ``app.py`` so command modules can import these without a
circular dependency (``app.py`` imports the command modules).
"""

from __future__ import annotations

import dataclasses
import math
import re
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from . import _click_compat as click  # the Click Typer is running; see _click_compat
from . import config as cfgmod
from . import dates as _dates

# `AuthMode` is DEFINED in `client.py`, not here, even though it is this layer that
# resolves it: the import runs `_context` -> `client` (below), and `client` needs the
# enum at runtime for its bearer-vs-cookie branch — defining it here would make that
# a cycle. Re-exported so `from ._context import AuthMode` reads naturally beside
# AppState, which is where most callers want it.
from .client import AuthMode, ClientContext
from .errors import AuthError, KeyModeUnsupportedError


@dataclass
class AppState:
    json: bool
    base_url: Optional[str]
    token: Optional[str]
    timeout: float
    config: cfgmod.CliConfig
    insecure: bool = False
    org: Optional[str] = None  # active tenant slug (flag > env > config)
    # The EXPLICITLY-supplied tenant (global `--org` or `FP_ORG`), before
    # the saved-config fallback. `login` uses this so a *saved* tenant never
    # silently bypasses the interactive org picker — only an explicit choice does.
    # Key mode reuses it as the ONLY org it will ever send (see `build_context`).
    org_explicit: Optional[str] = None
    # The bearer credential in key mode. NEVER written to `cli.json` — see
    # `resolve_auth`.
    api_key: Optional[str] = None
    # Which credential this invocation carries. Defaults to NONE so an AppState
    # built by another path (tests, embedders) is never silently treated as key
    # mode; the transport reads it directly, and everything that is not API_KEY
    # takes the cookie path.
    auth_mode: AuthMode = AuthMode.NONE


def resolve_auth(
    *,
    api_key: Optional[str],
    api_key_on_cli: bool,
    token: Optional[str],
    token_on_cli: bool,
    saved_token: Optional[str],
) -> Tuple[AuthMode, Optional[str], Optional[str]]:
    """Resolve the one credential this invocation uses → ``(mode, api_key, token)``.

    Precedence, highest first::

        --api-key AND --token   -> usage error, exit 2 (never guess)
        --api-key               -> key mode
        --token                 -> session mode
        FP_API_KEY    -> key mode      (a key env var beats a token env var)
        FP_TOKEN      -> session mode
        cli.json session_token  -> session mode
        nothing                 -> AuthMode.NONE (require_auth then exits 4)

    ``*_on_cli`` distinguishes a flag from its env var, which the *values* cannot:
    an explicit ``--token`` has to beat ``FP_API_KEY`` while
    ``FP_API_KEY`` beats ``FP_TOKEN``. Click's
    ``ctx.get_parameter_source`` is the only thing that knows the difference.

    ``--api-key ""`` (an unset CI variable spelled out) means "no override": the mode
    stays KEY with an empty credential, so `require_auth` raises instead of quietly
    acting as whichever human is logged in on this machine. That mirrors the
    established ``--token ""`` rule exactly.

    The key is returned for this process only and is never persisted: a session token
    expires in ~24h, which bounds the blast radius of a leaked `cli.json`; an API key
    is valid until someone revokes it. There is also no honest revocation path from
    here — `keys disable` needs `keys:disable`, which a scoped CI key will not hold —
    so a "clear the saved key" command could not actually revoke anything.
    """
    if api_key_on_cli and token_on_cli:
        raise click.UsageError(
            "--api-key and --token are mutually exclusive: --api-key authenticates as an "
            "API key against /v1, --token as a signed-in user session. Pass exactly one."
        )
    if api_key_on_cli:
        return AuthMode.API_KEY, api_key, None
    if token_on_cli:
        return AuthMode.SESSION, None, token
    # Neither flag was given: whatever Click resolved came from the environment.
    # (Click treats an empty env var as unset, so `FP_API_KEY=""` falls
    # through to the next rung rather than becoming an empty-credential key mode.)
    if api_key is not None:
        return AuthMode.API_KEY, api_key, None
    if token is not None:
        return AuthMode.SESSION, None, token
    if saved_token:
        return AuthMode.SESSION, None, saved_token
    return AuthMode.NONE, None, None


def deny_in_key_mode(state: "AppState", command: str, reason: str) -> None:
    """Fail ``command`` with exit 2 when this invocation carries an API key.

    Called as the FIRST statement of every command an API key cannot perform, so the
    CLI never opens a connection it already knows will fail — a 401/403 from the
    server would be a much worse explanation than the real one.
    """
    if state.auth_mode is AuthMode.API_KEY:
        raise KeyModeUnsupportedError(
            f"`fp {command}` does not work with an API key — {reason}.",
            hint="drop --api-key / FP_API_KEY and sign in with fp login",
        )


def resolved_base_url(state: AppState) -> str:
    """The effective dashboard URL.

    The app callback already resolves flag/env > saved config > the public
    default (`config.DEFAULT_BASE_URL`), so `state.base_url` is normally set.
    This falls back to the same default for any AppState built by another path
    (tests, embedders), so the CLI always has a URL to talk to.
    """
    return state.base_url or cfgmod.DEFAULT_BASE_URL


def _org_header(state: AppState) -> Optional[str]:
    """The tenant slug to send as ``X-AgentEye-Org``.

    In KEY mode only an EXPLICIT ``--org`` / ``FP_ORG`` is ever sent. The saved
    `cli.json` org belongs to whichever human logged in on this machine and has no
    bearing on which org a CI key was minted for; sending it would silently ask for
    another tenant's data and get a 403 that reads like a missing permission.

    (The reverse trap is real too and `whoami` is the pre-flight for it: an
    instance-scoped key with no `--org` resolves server-side to the DEFAULT org and
    answers with that org's data, no error anywhere.)
    """
    if state.auth_mode is AuthMode.API_KEY:
        return state.org_explicit
    return state.org


def build_context(state: AppState) -> ClientContext:
    return ClientContext(
        base_url=resolved_base_url(state),
        token=state.token,
        timeout=state.timeout,
        verify=not state.insecure,
        org=_org_header(state),
        api_key=state.api_key,
        auth_mode=state.auth_mode,
    )


def require_auth(state: AppState) -> ClientContext:
    """Return a client context, or raise if no URL is set / not authenticated."""
    base = resolved_base_url(state)  # the URL is the prerequisite — check it first
    if state.auth_mode is AuthMode.API_KEY:
        # `--api-key ""` lands here: key mode, no credential. It must NOT fall back
        # to a saved cookie session (see `resolve_auth`), so this is an auth failure.
        if not state.api_key:
            raise AuthError(
                "No API key supplied. Pass --api-key <key> or set FP_API_KEY."
            )
        # No local expiry check: an API key carries no expiry the CLI can see, and the
        # server is the only authority on whether it is still live.
        return ClientContext(
            base_url=base,
            api_key=state.api_key,
            auth_mode=AuthMode.API_KEY,
            timeout=state.timeout,
            verify=not state.insecure,
            org=_org_header(state),
        )
    if not state.token:
        # A pre-move file with no usable session in it (expired, or only ever
        # held a base_url) reaches here after adoption declined to carry
        # anything. Name it, so the upgrade is not blamed for the logout.
        if cfgmod.legacy_install_detected():
            raise AuthError(
                "Not logged in. Run fp login.\n"
                f"The config moved to {cfgmod.config_path()}; "
                f"{cfgmod.legacy_config_path()} held no usable session to carry "
                "over. It is left in place — remove it when convenient."
            )
        raise AuthError("Not logged in. Run fp login.")
    # Only enforce local expiry when the token came from the stored config; an
    # explicit --token / env override has no known expiry, so trust it.
    if state.token == state.config.session_token and cfgmod.is_expired(state.config):
        raise AuthError("Session expired. Run fp login.")
    return ClientContext(
        base_url=base,
        token=state.token,
        timeout=state.timeout,
        verify=not state.insecure,
        org=_org_header(state),
    )


def resolve_dates(
    since: Optional[str], ts_from: Optional[str], ts_to: Optional[str]
) -> Tuple[Optional[str], Optional[str]]:
    try:
        return _dates.resolve_range(since, ts_from, ts_to)
    except ValueError as exc:
        raise click.BadParameter(str(exc))


def resolve_fields(raw: Optional[str], model_cls: type) -> Optional[List[str]]:
    """Parse a ``--fields`` CSV into a validated list of model field names (or None).

    Field names must match the dataclass (and thus the ``--json``) keys of the
    model; unknown names raise a usage error listing the valid set.
    """
    if not raw:
        return None
    valid = [f.name for f in dataclasses.fields(model_cls)]
    chosen = [f.strip() for f in raw.split(",") if f.strip()]
    unknown = [f for f in chosen if f not in valid]
    if unknown:
        raise click.BadParameter(
            f"unknown field(s): {', '.join(unknown)}. Valid fields: {', '.join(valid)}"
        )
    return chosen


def collect_multi(values: Optional[Sequence[str]]) -> Optional[List[str]]:
    """Normalize a repeatable + comma-separated CLI option into one flat, de-duplicated list.

    The single reusable helper behind every multi-value filter. Typer hands us a list with
    one entry per repeated flag (``--env prod --env staging`` → ``["prod", "staging"]``), and
    each entry may itself be a comma-separated group (``--env prod,staging`` → ``["prod,staging"]``).
    This splits every entry on commas, trims surrounding whitespace (so ``--env "prod, staging"``
    works), drops empties (so a trailing comma ``--env prod,`` adds nothing), and de-duplicates
    while preserving first-seen order. Returns ``None`` when nothing usable remains, so an unset
    or blank option stays ``None`` and the client drops the param (unchanged single-value path).

    A single value still yields the obvious one-item list (``--env prod`` → ``["prod"]``), which
    the client serializes back to a bare ``environment=prod`` — fully backward compatible.
    """
    if not values:
        return None
    out: List[str] = []
    seen: set = set()
    for raw in values:
        for part in str(raw).split(","):
            v = part.strip()
            if v and v not in seen:
                seen.add(v)
                out.append(v)
    return out or None


def validate_choice(
    value: Optional[str], allowed: Sequence[str], *, flag: str
) -> Optional[str]:
    """Return ``value`` if it's None or one of ``allowed``; else a usage error (exit 2).

    Keeps enum-style flags (``--status``) failing fast client-side with a clear
    message, consistent with ``--order``/``--source``/``--kind`` — rather than the
    server's opaque HTTP 400 (exit 1).
    """
    if value is None or value in allowed:
        return value
    raise click.BadParameter(
        f"'{value}' is not valid for {flag}. Choose one of: {', '.join(allowed)}.",
        param_hint=flag,
    )


def validate_limit(limit: Optional[int], *, flag: str = "--limit") -> None:
    """Reject a non-positive row limit up front with a clean usage error (exit 2), rather
    than passing ``0``/negative through to the server, which silently defaults/clamps it to
    a confusing result. Mirrors ``validate_choice`` / ``validate_score_filters``."""
    if limit is not None and limit <= 0:
        raise click.BadParameter("must be a positive integer (at least 1).", param_hint=flag)


def validate_score_filters(values: Optional[Sequence[str]]) -> None:
    """Validate ``--score`` values are ``KEY:MIN..MAX`` (either bound optional).

    Without this a malformed value (no ``:`` or no ``..``) is silently sent and
    dropped server-side, returning the UNFILTERED set — a silent footgun. Raises a
    usage error (exit 2) on a bad value. Accepts e.g. ``helpfulness:0.5..0.8``,
    ``x:..0.5``, ``y:0.9..``.
    """
    for v in values or []:
        key, sep, rng = v.partition(":")
        ok = bool(sep) and bool(key.strip()) and ".." in rng
        if ok:
            lo, _, hi = rng.partition("..")
            # Both bounds empty (`helpfulness:..`) is meaningless: the server silently
            # drops it and returns the UNFILTERED set, so reject it client-side too.
            if lo == "" and hi == "":
                ok = False
            for bound in (lo, hi):
                if bound != "":
                    try:
                        # `float("nan")`/`float("inf")` succeed but the server silently
                        # drops the filter — reject non-finite bounds too.
                        if not math.isfinite(float(bound)):
                            ok = False
                            break
                    except ValueError:
                        ok = False
                        break
        if not ok:
            raise click.BadParameter(
                f"'{v}' is not a valid score filter. Use KEY:MIN..MAX (either bound "
                "optional), e.g. helpfulness:0.5..0.8, tool_efficiency:..0.3, factuality:0.9..",
                param_hint="--score",
            )


# Appended to every subcommand's --help so an agent that jumps straight to
# `fp <command> -h` still learns the argument order + where the global options go.
GLOBALS_EPILOG = (
    "Argument order: `fp [GLOBAL OPTIONS] <command> [<subcommand>] [ARGS] [OPTIONS]`. "
    "**Global** options come *before* the command — `--json`, `--base-url`, `--token`, "
    "`--api-key`, `--insecure`/`--secure`, `--timeout`, `--quiet`, `--no-color`. A command's (or "
    "subcommand's) own options come *after* it. "
    "e.g. `fp --json keys create ci-bot --permission-set read-only` — `--json` is global, "
    "`keys` the command, `create` the subcommand, `--permission-set` its option."
)
