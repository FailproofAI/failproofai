"""PostHog telemetry for the CLI — a thin, fail-safe wrapper.

Mirrors the dashboard's ``lib/analytics.ts``: import-safe, a no-op until
``init_analytics`` runs, identifies operators by an opaque id only (never email),
and tags every event with ``product`` super-properties. Adapted for a short-lived
process: events are flushed on exit within a hard time bound, and **every** public
function swallows all exceptions so telemetry can never slow or break a command.

Privacy: the generic ``command_executed`` event records only static names (command,
subcommand, flag NAMES) plus coarse booleans/counts and one closed enum
(``auth_mode``). Argument *values* — dashboard URL, session token, API key, email,
session ids, score expressions, file paths — are never sent, in any form: not the
value, not its length, not a prefix.
"""

from __future__ import annotations

import logging
import platform
import threading
import uuid
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from . import analytics_config as acfg
from . import config as cfgmod
from ._version import __version__

# Single client + per-invocation context (the dashboard keeps one posthog-js instance).
# The client is built LAZILY (see _ensure_client) on the first actual send, so a normal
# command never pays the posthog import + client construction on its startup path.
_client: Any = None
_distinct_id: Optional[str] = None
_command: Optional[str] = None
_json_output: bool = False
_auth_mode: str = "none"
_force_anonymous: bool = False
_pending_conf: Any = None
_init_done: bool = False

# Hard cap on how long shutdown may block the CLI waiting on the network.
_FLUSH_TIMEOUT_SECS = 1.5

# Recognised command / flag names. These are the STATIC FALLBACK used only if the
# derived registry (analytics_registry, introspected from the live Typer app) cannot
# be built. The generic event emits ONLY known static strings, so customer data (urls,
# tokens, ids, queries, paths) can never leak through it. The anti-drift test asserts
# the *derived* catalog stays exhaustive, which is the real guarantee of completeness.
_KNOWN_COMMANDS = frozenset(
    {
        "login", "logout", "whoami", "orgs", "events",
        "sessions", "evals", "version", "help",
        "list", "errors", "keys", "query",
        "users", "settings", "alerts", "audits", "issues", "agent",
    }
)
# group -> its leaf subcommand names (static fallback).
_STATIC_LEAVES: Dict[str, FrozenSet[str]] = {
    "list": frozenset({"envs", "agents", "event_types", "score_filters", "models",
                       "hooks", "tools", "error_types"}),
    "orgs": frozenset({"list", "switch", "current", "perms"}),
    "keys": frozenset({"list", "show", "create", "update", "disable", "regenerate"}),
    "query": frozenset({"list", "show", "create", "update", "delete", "run", "schema"}),
    "users": frozenset({"list", "show", "create", "update", "disable", "enable"}),
    "settings": frozenset({"list", "schema", "set"}),
    "alerts": frozenset({"list", "show", "create", "update", "delete", "test"}),
    "audits": frozenset({"list", "show", "create", "edit", "delete", "run", "runs", "findings",
                         "finding", "ack", "mute", "dismiss", "resolve", "reopen", "assign"}),
    "issues": frozenset({"list", "count", "show", "ack", "assign", "resolve", "comment-list",
                         "comment-add", "comment-delete", "subscribers", "subscribe", "unsubscribe", "open"}),
    "agent": frozenset({"health", "models", "chats", "show", "rename", "delete", "ask"}),
}
# Global options that consume a following token (static fallback for value-skipping).
_STATIC_VALUE_FLAGS = frozenset(
    {"--base-url", "--org", "--token", "--api-key", "--timeout", "--email", "-e"}
)

# Any flag token (long or short) -> its canonical long name (static fallback).
_FLAG_ALIASES: Dict[str, str] = {
    "--json": "--json",
    "--base-url": "--base-url",
    "--org": "--org",
    "--token": "--token",
    "--api-key": "--api-key",
    "--timeout": "--timeout",
    "--no-color": "--no-color",
    "--quiet": "--quiet", "-q": "--quiet",
    "--insecure": "--insecure", "--secure": "--secure",
    "--version": "--version",
    "--email": "--email", "-e": "--email",
    "--environment": "--environment", "--env": "--environment",
    "--agent-id": "--agent-id",
    "--status": "--status",
    "--score": "--score",
    "--since": "--since", "--from": "--from", "--to": "--to",
    "--limit": "--limit", "-n": "--limit",
    "--cursor": "--cursor",
    "--all": "--all",
    "--page-size": "--page-size",
    "--fields": "--fields",
    "--arg": "--arg", "--param": "--param", "--force": "--force",
    "--session-id": "--session-id",
    "--event-type": "--event-type",
    "--audit": "--audit", "--run-id": "--run-id", "--offset": "--offset",
    "--reason": "--reason", "--to": "--to", "--show-id": "--show-id",
    "--scope": "--scope", "--sensitivity": "--sensitivity", "--top-k": "--top-k",
    "--window-mode": "--window-mode", "--channels": "--channels",
    "--latest-per-session": "--latest-per-session",
    "--events-limit": "--events-limit",
    "--no-events": "--no-events", "--no-eval": "--no-eval",
    "--output": "--output", "-o": "--output",
    "--source": "--source",
    "--help": "--help", "-h": "--help",
}


def _catalog() -> "tuple":
    """``(known_commands, leaf_registry, flag_aliases, value_flags)``.

    Prefers the live derived catalog; falls back to the static tables if introspection
    fails (telemetry is best-effort and must never raise into a command).
    """
    try:
        from . import analytics_registry as reg

        known, leaves, flags, value_flags = reg.build()
        if known and flags:
            return known, leaves, flags, value_flags
    except Exception:
        pass
    return _KNOWN_COMMANDS, _STATIC_LEAVES, _FLAG_ALIASES, _STATIC_VALUE_FLAGS

# The CLOSED set of auth modes we will emit. Mirrors `client.AuthMode`, but stated as
# a literal allowlist so an unexpected value degrades to "none" rather than being
# forwarded verbatim — this property must never become a channel for anything but
# these three words.
_AUTH_MODES: Dict[str, str] = {"session": "session", "api_key": "api_key", "none": "none"}

# Exit code -> coarse error class (derived from errors.py / Click conventions).
_EXIT_CATEGORY: Dict[int, Optional[str]] = {
    0: None,  # success
    2: "usage",
    3: "network",
    4: "auth",
    5: "forbidden",
    6: "not_found",
}


def init_analytics(conf: cfgmod.CliConfig, *, force_anonymous: bool = False) -> None:
    """Record config for a LAZILY-constructed PostHog client (resolve + build on first send).

    Deferring the posthog import + client construction keeps them off every command's startup
    path; an invocation that never emits an event (the common case, and every opted-out user)
    pays nothing. :func:`_ensure_client` does the real work the first time a send is attempted.

    ``force_anonymous`` is set in API-key mode. :func:`_resolve_distinct_id` reads the
    SAVED config, so a machine where a human is logged in would attribute a CI key's
    commands to that person — a wrong identity, silently, forever.
    """
    global _pending_conf, _init_done, _client, _distinct_id, _force_anonymous
    _pending_conf = conf
    _init_done = False
    _client = None
    _distinct_id = None
    _force_anonymous = bool(force_anonymous)


def _ensure_client() -> None:
    """Build the PostHog client on first use (idempotent). Any failure leaves telemetry off."""
    global _client, _distinct_id, _init_done
    if _init_done:
        return
    _init_done = True
    conf = _pending_conf
    if conf is None:
        return
    settings = acfg.resolve_config()
    if not settings.enabled:
        return
    try:
        from posthog import Posthog

        _distinct_id = (
            _ensure_anonymous_id(conf) if _force_anonymous else _resolve_distinct_id(conf)
        )
        _client = Posthog(
            settings.api_key,
            host=settings.host,
            flush_at=1,          # a CLI fires few events then exits — send promptly
            max_retries=1,       # don't retry-storm a blocked/slow network
            timeout=3,           # short per-request timeout
            disable_geoip=True,  # don't resolve the caller's IP to a location
            super_properties=_super_properties(),
        )
        # The CLI owns stderr; keep posthog's own logger from printing onto it.
        logging.getLogger("posthog").setLevel(logging.CRITICAL)
    except Exception:
        _client = None


def note_command(
    command: Optional[str], json_output: bool, auth_mode: Any = None
) -> None:
    """Record (from the main callback) which command ran, whether ``--json`` is set, and
    which credential it used.

    Authoritative — taken from the parsed Typer context, not re-parsed from argv. Uses the
    cheap STATIC command set (no Typer→Click tree build on the startup path). Safe to call
    when telemetry is disabled (it only sets module state).

    ``auth_mode`` is an ``AuthMode`` (a ``str`` enum we authored, so the property is a
    closed set: ``session`` | ``api_key`` | ``none``). Never the key, its length, or a
    prefix — the mode is the whole signal, and it is what makes "is anyone actually
    running this in CI?" answerable.
    """
    global _command, _json_output, _auth_mode
    _command = command if command in _KNOWN_COMMANDS else None
    _json_output = bool(json_output)
    _auth_mode = _AUTH_MODES.get(str(getattr(auth_mode, "value", auth_mode)), "none")


def capture(event: str, properties: Optional[Dict[str, Any]] = None) -> None:
    """Send one event. No-op until initialised; never raises."""
    _ensure_client()
    if _client is None:
        return
    try:
        # Keyword form. `posthog>=7` is `capture(self, event, **kwargs)` —
        # everything after `event` is keyword-only — so the posthog-3 positional
        # order `(distinct_id, event, …)` raised `TypeError: Client.capture()
        # takes 2 positional arguments but 3 were given`, and the failure was
        # invisible from three directions at once: posthog's own `@no_throw`
        # swallowed it, `_ensure_client` sets the posthog logger to CRITICAL so
        # the log it wrote was suppressed, and the `except Exception: pass` below
        # would have swallowed it too. Nothing sent, nothing logged, nothing
        # raised. (Dead today — `TELEMETRY_DISABLED` is True — which is precisely
        # why it could sit here unnoticed until someone flipped that flag.)
        _client.capture(event, distinct_id=_distinct_id, properties=properties or {})
    except Exception:
        pass


def capture_command(exit_code: int, duration_ms: int, argv: List[str]) -> None:
    """Emit the generic ``command_executed`` event with an allowlisted payload.

    ``command``/``subcommand`` come from resolving argv against the known command
    tree, so every group's leaf (``keys create``, ``orgs switch``, …) is distinguished —
    not just the top-level command. Both are static names from the catalog; values never leak.
    """
    _ensure_client()
    if _client is None:
        return
    group, leaf = _resolve_command_path(argv)
    command = _command if _command is not None else group
    subcommand = leaf if (command is not None and command == group) else None
    capture(
        "command_executed",
        {
            "command": command,
            "subcommand": subcommand,
            "success": exit_code == 0,
            "exit_code": exit_code,
            "error_category": _EXIT_CATEGORY.get(exit_code, "error"),
            "duration_ms": duration_ms,
            "flags": _sanitize_flags(argv),
            "json_output": _json_output,
            "auth_mode": _auth_mode,
        },
    )


def identify(user_id: Optional[str]) -> None:
    """Link this machine's prior anonymous activity to the operator id (called on login).

    Mirrors the dashboard's ``posthog.identify(id)`` by the opaque operator id only.
    No-op when telemetry is off or there is nothing to link.
    """
    _ensure_client()
    if _client is None or not user_id:
        return
    try:
        conf = cfgmod.load_config()
        if conf.anonymous_id and conf.anonymous_id != user_id:
            _client.alias(previous_id=conf.anonymous_id, distinct_id=user_id)
    except Exception:
        pass


def reset() -> None:
    """Rotate the local anonymous id on logout so later anon events aren't tied to the user.

    posthog-python has no client-side reset; this is local state only (the analog of
    the dashboard's ``posthog.reset()``). Runs **regardless** of whether telemetry is
    currently enabled: ``anonymous_id`` is persistent config state and the opt-out
    flag can be toggled between runs, so the unlink-on-logout invariant must hold even
    when this invocation has telemetry off (otherwise a later re-enabled run could
    reuse an id still aliased to the operator who just logged out).
    """
    try:
        conf = cfgmod.load_config()
        conf.anonymous_id = uuid.uuid4().hex
        cfgmod.save_config(conf)
    except Exception:
        pass


def shutdown() -> None:
    """Flush pending events, bounded so telemetry never stalls the CLI on exit.

    Idempotent. The flush runs on a daemon thread joined for at most
    ``_FLUSH_TIMEOUT_SECS``; if the network is slow/blocked the thread is abandoned
    (it dies with the process) and the event is dropped — telemetry is best-effort.

    TODO(telemetry-nonblocking): this bounds only the *final* flush. The client build
    and first ``capture()`` connect (in ``_ensure_client`` / ``capture_command``) are
    NOT bounded, so a blocked PostHog host stalls the CLI ~5s/command before this runs.
    Telemetry is currently disabled via ``analytics_config.TELEMETRY_DISABLED``; before
    re-enabling, move the whole capture+flush onto this bounded daemon thread (or set an
    aggressive connect timeout on the client) so no command can ever block on it.
    """
    global _client
    client = _client
    _client = None  # a second call is a no-op
    if client is None:
        return

    def _drain() -> None:
        try:
            client.flush()
        except Exception:
            pass
        try:
            client.shutdown()
        except Exception:
            pass

    thread = threading.Thread(target=_drain, name="posthog-flush", daemon=True)
    thread.start()
    thread.join(_FLUSH_TIMEOUT_SECS)


# --- internals -------------------------------------------------------------------


def _super_properties() -> Dict[str, str]:
    """Tags merged into every event (the analog of ``posthog.register``)."""
    return {
        "product": acfg.PRODUCT,
        "cli_version": __version__,
        "os": platform.system(),  # coarse: "Linux" / "Darwin" / "Windows"
        "python_version": platform.python_version(),
    }


def _resolve_distinct_id(conf: cfgmod.CliConfig) -> str:
    """Opaque operator id when logged in, else a stable per-machine anonymous id.

    ``user_id`` is used only alongside a stored session token, so a logged-out machine
    falls back to its anonymous id (which :func:`reset` rotates on logout).
    """
    if conf.user_id and conf.session_token:
        return conf.user_id
    return _ensure_anonymous_id(conf)


def _ensure_anonymous_id(conf: cfgmod.CliConfig) -> str:
    """Return the persisted anonymous id, generating and saving one on first use."""
    if conf.anonymous_id:
        return conf.anonymous_id
    anon = uuid.uuid4().hex
    conf.anonymous_id = anon
    try:
        cfgmod.save_config(conf)
    except Exception:
        pass  # fall back to an in-memory id for this run
    return anon


def _resolve_command_path(argv: List[str]) -> Tuple[Optional[str], Optional[str]]:
    """Resolve ``(group, leaf)`` from argv against the known command tree.

    Walks tokens, skipping global/option flags (and the value of a value-taking option),
    to find the first known top-level command (``group``) and then, if that group has
    subcommands, the first matching leaf. Only ever returns static names from the
    catalog, so argument values can never be emitted. Generalises the old
    ``session``-only detection to every group.
    """
    known, leaves, _flags, value_flags = _catalog()
    group: Optional[str] = None
    leaf: Optional[str] = None
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("-"):
            name = tok.split("=", 1)[0]
            if "=" not in tok and name in value_flags:
                i += 2  # skip the option's value token
                continue
            i += 1
            continue
        if group is None:
            if tok in known:
                group = tok
            i += 1
            continue
        if leaf is None and tok in leaves.get(group, frozenset()):
            leaf = tok
            break
        i += 1
    return group, leaf


def _detect_subcommand(argv: List[str]) -> Optional[str]:
    """Back-compat shim: the leaf subcommand for the resolved command (or None)."""
    return _resolve_command_path(argv)[1]


def _sanitize_flags(argv: List[str]) -> List[str]:
    """Flag NAMES present in argv, intersected with the known set — never values.

    ``--opt=value`` is split so the value is dropped, and any unknown token (including
    a value that happens to start with ``-``) is discarded.
    """
    aliases = _catalog()[2]
    seen: List[str] = []
    for tok in argv:
        if not tok.startswith("-"):
            continue
        canonical = aliases.get(tok.split("=", 1)[0])
        if canonical and canonical not in seen:
            seen.append(canonical)
    return seen
