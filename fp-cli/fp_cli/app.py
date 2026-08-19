"""Typer application: global options + command registration."""

from __future__ import annotations

import sys
import time
from typing import Optional

import typer

from . import _click_compat as click  # the Click Typer is running; see _click_compat
from . import _context
from . import analytics
from . import config as cfgmod
from . import output
from . import orgs as orgsmod
from ._context import AppState
from ._version import __version__
from .commands import (
    agent_cmds,
    alerts_cmds,
    audits_cmds,
    auth_cmds,
    errors_cmds,
    evals_cmds,
    events_cmds,
    fleet_cmds,
    guardrails_cmds,
    incidents_cmds,
    keys_cmds,
    list_cmds,
    orgs_cmds,
    policies_cmds,
    queries_cmds,
    sessions_cmds,
    settings_cmds,
    usage_cmds,
    users_cmds,
)

_HELP = """\
Query FailproofAI Cloud — **sessions, events, and evaluation results** — from your terminal.

Every data command accepts `--json` for stable, machine-readable output: data on **stdout**, and
on failure a `{"error": …, "exit_code": …}` object on **stdout** too; human status/progress goes to
**stderr**. So it is safe to script and easy for AI agents to parse.

**Getting started**

* `fp --base-url https://cloud.example.com login` — email a one-time code, then paste it
* `fp whoami` — confirm who you are and your permissions
* `fp --json sessions --since 24h` — run a query (results are newest-first)

**Global options come before the command.** `fp --json --base-url URL events` is correct;
`fp events --json` is not. The globals are `--json`, `--base-url`, `--org`, `--token`,
`--api-key`, `--insecure`/`--secure`, `--timeout`, `--quiet`, and `--no-color`.

**In CI, authenticate with an API key** — `--api-key <key>` or `FP_API_KEY` — instead of
a session. The key is never written to disk, and the commands that need a *human* session
(`login`, `logout`, `orgs`, `agent`, `keys update`) exit `2` rather than half-run. Pass `--org
<slug>` if the key can act for more than one org; nothing is inherited from a saved login.

**Multi-tenant:** if you belong to more than one org, pick the active tenant at login
(`fp login --org <slug>`) or per command with `--org <slug>` (or `FP_ORG`).
`fp orgs` lists the orgs you can access; `fp orgs switch <slug>` sets the default.

**Exit codes** (stable, for scripting): `0` success · `1` unexpected error (e.g. an unhandled
server status) · `2` usage error · `3` cannot reach the dashboard · `4` not signed in or session
expired (run `fp login`) · `5` missing the required permission · `6` resource not found.

Run `fp COMMAND -h` (or `--help`) for each command's filters, value formats, and JSON shape.
"""

# Each example is its own paragraph (blank line between) on purpose: Typer collapses single
# newlines within an epilog paragraph into spaces, which would mash a normal Markdown list onto
# one line. Paragraph breaks survive as the single newlines Markdown needs for a clean list.
_EPILOG = """\
**Examples**

* `fp --json sessions --since 7d --status error` — runs that errored in the past week

* `fp --json evals --score helpfulness:..0.5` — evaluations scoring ≤ 0.5 on helpfulness

* `fp evals --aggregate --since 7d --env prod` — rolled-up eval health for the last week in prod

* `fp --json errors --since 24h --env prod` — error summary for the last day in prod

* `fp --json events --session-id run-001 --all | jq '.events[].payload'` — every event payload for one session, ready to pipe into a script
"""

# -h is an alias for --help everywhere (Click reads this from the context).
_CTX = {"help_option_names": ["-h", "--help"]}

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="markdown",
    context_settings=_CTX,
    help=_HELP,
    epilog=_EPILOG,
)


# Render every ClickException as a clean one-line error (`✗ message`) instead of
# Typer's heavy red panel, so failures match the rest of the CLI's line aesthetic
# (`✓` / `○` / `›`). Usage errors keep a `try '… -h'` nudge. Patches the single
# function Typer calls for this; falls back silently if its internals change.
try:  # pragma: no cover - exercised via real command output, not unit assertions
    import typer.rich_utils as _rich_utils

    import re as _re

    from .errors import FpCliError as _FpCliError

    # Global options live BEFORE the command; putting one after it ("sessions --json")
    # is the single most common mistake, so detect it and nudge toward the right form.
    _GLOBAL_FLAGS = frozenset({
        "--json", "--base-url", "--org", "--token", "--api-key", "--timeout",
        "--quiet", "--no-color", "--insecure", "--secure",
    })

    def _flag_placement_hint(message: str) -> "Optional[str]":
        m = _re.search(r"No such option:? '?(--[a-z-]+)'?", message)
        if m and m.group(1) in _GLOBAL_FLAGS:
            return "global options go before the command, e.g. 'fp --json <command>'"
        return None

    def _wants_json() -> bool:
        # output.is_json() is set by the group callback. Errors raised BEFORE it runs (an unknown
        # command, a bad global option) never reached configure(), so fall back to the raw flag/env
        # — otherwise `fp --json <typo>` would print a human box instead of a JSON envelope.
        if output.is_json():
            return True
        import os
        if os.environ.get("FP_JSON", "").strip().lower() in ("1", "true", "yes", "on"):
            return True
        return "--json" in sys.argv

    def _format_error_as_line(error: click.ClickException) -> None:
        # Our typed errors carry a clean message; the HTTP status (for ApiError) rides in the JSON
        # envelope's `status` field instead of being appended to the human text. Other Click
        # exceptions (usage etc.) use their normal rendering.
        if isinstance(error, _FpCliError):
            message = error.message
        else:
            message = error.format_message() if hasattr(error, "format_message") else str(error)
        # Click/Typer sometimes doubles the suggestion ("Did you mean 'x'? Did you
        # mean 'x'?"); collapse the repeat so the one-line error stays clean.
        message = _re.sub(r"(Did you mean [^?]+\?)(\s*\1)+", r"\1", message)
        # A bare group invocation (`fp`, `fp keys`) already printed its help via
        # no_args_is_help; Click then raises a message-less UsageError. Don't render an empty
        # "✗" box (or an `{"error": ""}` envelope) on top of the help — just let Click exit.
        if not message.strip():
            return
        # Hint precedence: an explicit hint on the exception > the global-flag-placement
        # nudge (more useful than the generic -h line) > the usage "try '… -h'" fallback.
        hint = getattr(error, "hint", None)
        if hint is None:
            hint = _flag_placement_hint(message)
        ctx = getattr(error, "ctx", None)
        if hint is None and isinstance(error, click.UsageError) and ctx is not None:
            hint = f"try '{ctx.command_path} -h' for help"
        # Under --json, every failure is a machine-readable object on stdout (data channel),
        # mirroring the success contract — never a Rich box. Click then exits with the same code.
        if _wants_json():
            code = getattr(error, "exit_code", None)
            if not isinstance(code, int):
                code = 2 if isinstance(error, click.UsageError) else 1
            payload = {"error": message, "exit_code": code}
            status = getattr(error, "status", None)
            if isinstance(status, int):
                payload["status"] = status
            # Keep the server's request-id (set on ApiError) so an agent can correlate a failure
            # with server logs — it's no longer appended to the human message.
            request_id = getattr(error, "request_id", None)
            if request_id:
                payload["request_id"] = request_id
            if hint:
                payload["hint"] = hint
            output.emit_json(payload)
        else:
            output.cli_error(message, hint=hint)

    _rich_utils.rich_format_error = _format_error_as_line

    # Replace the TOP-LEVEL help (bare `fp`, `fp --help`/`-h`) with the grouped
    # commands screen; every subcommand's `--help` keeps Typer's default rendering. All three
    # top-level paths flow through `rich_format_help`, so one override covers them.
    _orig_rich_format_help = _rich_utils.rich_format_help

    def _format_help(*, obj, ctx, markup_mode):  # noqa: ANN001
        if getattr(ctx, "parent", None) is None:  # the root `fp` command
            output.render_top_level_help()
        else:
            _orig_rich_format_help(obj=obj, ctx=ctx, markup_mode=markup_mode)

    _rich_utils.rich_format_help = _format_help
except Exception:
    pass


def _version_callback(value: bool) -> None:
    if value:
        print(__version__)
        raise typer.Exit()


def _from_command_line(ctx: typer.Context, param: str) -> bool:
    """True when ``param`` was typed on the command line (not read from its env var).

    `--api-key` and `--token` have DIFFERENT precedence as flags than as env vars, and
    by the time Typer hands us the value the two are indistinguishable. Click records
    the source; ask it. Defaults to False if a Click without the API is ever in play,
    which degrades to "treat it as env" — the conservative direction, since the only
    thing it can cost is the both-flags usage error, never a wrong credential.
    """
    try:
        source = ctx.get_parameter_source(param)
    except Exception:  # pragma: no cover - only if Click drops the API
        return False
    return getattr(source, "name", None) == "COMMANDLINE"


@app.callback()
def main(
    ctx: typer.Context,
    json_output: bool = typer.Option(
        False, "--json", envvar="FP_JSON", help="Emit JSON to stdout instead of a table."
    ),
    base_url: Optional[str] = typer.Option(
        None,
        "--base-url",
        envvar="FP_DASHBOARD_URL",
        metavar="URL",
        help="Dashboard base URL. Defaults to https://app.befailproof.ai; "
        "override for a self-hosted or dev instance (or set FP_DASHBOARD_URL).",
    ),
    org: Optional[str] = typer.Option(
        None,
        "--org",
        envvar="FP_ORG",
        metavar="SLUG",
        help="Active org/tenant slug. Required if you belong to more than one org; "
        "set it once at login (`login --org <slug>`) or here per command.",
    ),
    token: Optional[str] = typer.Option(
        None, "--token", envvar="FP_TOKEN", help="Session token override (for CI/agents)."
    ),
    # `FP_API_KEY`, deliberately NOT the two names that already exist:
    #   * `AGENTEYE_KEY` is the collector's INGEST key, normally `events:add` only —
    #     picking it up here would make every read command 403 for no visible reason.
    #   * `AGENTEYE_API_KEY` is the dashboard service's own admin-grade key. Silently
    #     promoting an operator credential to "the CLI's identity" is a privilege
    #     surprise, and on a dashboard host both variables are typically already set.
    # It also keeps the CLI's own `FP_TOKEN` / `FP_JSON` namespace.
    api_key: Optional[str] = typer.Option(
        None,
        "--api-key",
        envvar="FP_API_KEY",
        metavar="KEY",
        help="Authenticate as an API key against the versioned API instead of a user "
        "session (for CI). Wins over --token's env var; passing both flags is an error. "
        "Never saved to disk.",
    ),
    timeout: float = typer.Option(30.0, "--timeout", help="HTTP timeout in seconds."),
    no_color: bool = typer.Option(
        False, "--no-color", envvar="NO_COLOR", help="Disable coloured output."
    ),
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Suppress status messages on stderr."),
    insecure: Optional[bool] = typer.Option(
        None,
        "--insecure/--secure",
        envvar="FP_INSECURE",
        help="Skip TLS certificate verification (for self-signed/internal dashboards). "
        "Saved at login; pass --secure to re-enable verification.",
    ),
    version: bool = typer.Option(
        False, "--version", callback=_version_callback, is_eager=True, hidden=True,
        help="Show version and exit.",
    ),
) -> None:
    """Resolve global options into the per-invocation AppState (flag > env > config)."""
    if timeout <= 0:
        raise click.BadParameter(
            "must be a positive number of seconds.", param_hint="--timeout"
        )
    cfg = cfgmod.load_config()
    output.configure(no_color=no_color, quiet=quiet, json=json_output)
    # Resolve the credential BEFORE telemetry starts: the distinct-id depends on it.
    # `get_parameter_source` is what separates a flag from its env var — the values
    # alone cannot, and the precedence rules differ between the two (see resolve_auth).
    auth_mode, resolved_api_key, resolved_token = _context.resolve_auth(
        api_key=api_key,
        api_key_on_cli=_from_command_line(ctx, "api_key"),
        token=token,
        token_on_cli=_from_command_line(ctx, "token"),
        saved_token=cfg.session_token,
    )
    # In key mode force the ANONYMOUS distinct id. `_resolve_distinct_id` reads the
    # SAVED config, so a CI box (or a laptop) where a human happens to be logged in
    # would otherwise attribute every key-mode command to that person — an identity
    # the key has nothing to do with.
    analytics.init_analytics(cfg, force_anonymous=auth_mode is _context.AuthMode.API_KEY)
    analytics.note_command(ctx.invoked_subcommand, json_output, auth_mode=auth_mode)
    # Precedence: an explicit --insecure/--secure (or FP_INSECURE) wins; else the saved config.
    resolved_insecure = cfg.insecure if insecure is None else insecure
    if resolved_insecure and ctx.invoked_subcommand not in ("version", "help", None):
        output.warn("⚠ TLS verification disabled (--insecure).")
    # Active tenant: flag > FP_ORG env > saved config. Validate the shape early
    # so a typo is a clean usage error rather than a confusing server rejection.
    resolved_org = org or cfg.org
    if resolved_org and not orgsmod.is_valid_org_slug(resolved_org):
        raise click.BadParameter(
            f"'{resolved_org}' is not a valid org slug "
            "(lowercase letters, digits and single hyphens).",
            param_hint="--org",
        )
    # Base-URL resolution: explicit flag/env > saved config > the public default
    # (`config.DEFAULT_BASE_URL`). An explicit empty string (`--base-url ""`, e.g.
    # an unset CI var) is treated as "unset" and falls through, so a script never
    # errors for lack of a URL — it lands on the hosted product. `or` (not
    # `is not None`) is deliberate here: unlike `--token`, an empty base-url is a
    # public endpoint choice, not an identity, so collapsing "" to the default is
    # safe.
    resolved_base = (base_url or None) or cfg.base_url or cfgmod.DEFAULT_BASE_URL
    # A base-url without a scheme breaks httpx's cookie handling with a raw urllib
    # ValueError (an uncaught traceback) — reject it up front as a clean usage error,
    # mirroring the --org shape check above. (The default always has a scheme, so
    # this only ever fires on a user-supplied value.)
    if not resolved_base.lower().startswith(("http://", "https://")):
        raise click.BadParameter(
            f"'{resolved_base}' must start with http:// or https://.",
            param_hint="--base-url",
        )
    # `resolve_auth` above already applied the whole precedence ladder, including the
    # rule that an EXPLICIT empty `--token ""` / `--api-key ""` (e.g. an unset CI var)
    # means "no override" and must NOT silently fall back to the saved session — so a
    # script can't unknowingly act as the stored identity. `base_url` intentionally
    # differs (see `resolved_base` above): an empty URL is a public endpoint, not an
    # identity, so it defaults.
    #
    # `api_key` is carried on the in-memory AppState ONLY. `CliConfig` has no field for
    # it and must not grow one: a session token expires in ~24h, which bounds a leaked
    # `cli.json`; an API key is valid until revoked, and nothing here could revoke it
    # (`keys disable` needs `keys:disable`, which a scoped CI key will not hold).
    ctx.obj = AppState(
        json=json_output,
        base_url=resolved_base,
        token=resolved_token,
        timeout=timeout,
        config=cfg,
        insecure=resolved_insecure,
        org=resolved_org,
        # `org` here is the global --org flag or FP_ORG env (None if neither) —
        # the explicit choice, distinct from the saved-config fallback in `resolved_org`.
        # Key mode sends ONLY this one (see `_context._org_header`).
        org_explicit=org,
        api_key=resolved_api_key,
        auth_mode=auth_mode,
    )


@app.command()
def version(ctx: typer.Context) -> None:
    """Show the CLI version in a small branded box.

    Follows the global option format — the **global** `--json` (before the command) makes it
    emit `{"version": "<x.y.z>"}` and nothing else: `fp --json version`. For a bare,
    unboxed string use `fp --version`.
    """
    if getattr(ctx.obj, "json", False):
        output.emit_json({"version": __version__})
    else:
        output.version_banner(__version__)


@app.command("help")
def help_cmd(ctx: typer.Context) -> None:
    """Show this help and the available commands."""
    output.render_top_level_help()


auth_cmds.register(app)
orgs_cmds.register(app)
events_cmds.register(app)
sessions_cmds.register(app)
evals_cmds.register(app)
errors_cmds.register(app)
usage_cmds.register(app)
list_cmds.register(app)
keys_cmds.register(app)
queries_cmds.register(app)
users_cmds.register(app)
settings_cmds.register(app)
alerts_cmds.register(app)
audits_cmds.register(app)
incidents_cmds.register(app)
agent_cmds.register(app)
policies_cmds.register(app)
fleet_cmds.register(app)
guardrails_cmds.register(app)


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def main_entry() -> None:
    """Console-script entry point: run the CLI, then emit one telemetry event.

    Wraps ``app()`` so a single ``command_executed`` event (carrying the exit code and
    duration) is captured however the command ends, then flushed. The original exit
    code is preserved exactly — standalone Click has already printed any error and
    raised ``SystemExit`` with the right status (see ``errors.py``). Tests invoke
    ``app`` directly via ``CliRunner``, so they bypass this wrapper entirely.
    """
    start = time.monotonic()
    code = 0
    try:
        app()
    except SystemExit as exc:  # normal path: Click exits with its status code
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except BaseException:  # escaped Click (e.g. KeyboardInterrupt): record, then re-raise unchanged
        analytics.capture_command(1, _elapsed_ms(start), sys.argv[1:])
        analytics.shutdown()
        raise
    analytics.capture_command(code, _elapsed_ms(start), sys.argv[1:])
    analytics.shutdown()
    sys.exit(code)
