"""Guardrails: what enforcement actually did — `summary` and `timeline`.

The counterpart to `fp fleet`. That command says what the control plane
INTENDED; this says what happened — whether the fleet is really covered, what
got blocked, and which policies earn their place.

The two halves come from different stores and that is worth knowing when a
number looks wrong: coverage is Postgres (the deployments), while the decision
counts are ClickHouse (hook telemetry the machines reported). A machine can be
deployed-to and silent, or reporting and undeployed, and only the first half
moves when you run `fp fleet deploy`.
"""
from __future__ import annotations

from typing import Optional

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, deny_in_key_mode, require_auth
from ..errors import NotFoundError

_KEY_MODE_REASON = (
    "guardrails reads an operator surface that is not exposed on the versioned "
    "API that an API key authenticates against"
)


def _require_machine(cctx, machine_id: Optional[str]) -> None:
    """Refuse a `--machine` id nobody has ever reported under.

    Both views answer "what happened here", and both answer an unknown machine
    with an empty window — which reads as "this machine was quiet", not as "you
    typed the id wrong". `fp fleet` refuses the same mistake everywhere else;
    the check costs one request, and only when the flag is actually used.
    """
    if machine_id is None:
        return
    if machine_id not in {m.machine_id for m in api.list_machines(cctx)}:
        raise NotFoundError(f"no machine {machine_id!r} has checked in")


def _hours(since: str) -> int:
    """`1h`/`6h`/`24h`/`7d` → hours. The CLI's `--since` vocabulary, one window only.

    `15m` is deliberately NOT here. These two endpoints take a whole-hour window
    and nothing finer, so `15m` mapped to 1 and produced a request byte-identical
    to `--since 1h`: the window was silently widened 4x with no tell anywhere —
    `timeline` renders no window label at all, and `summary`'s title comes from
    the server's echoed hours, so it read `guardrails · 1h` while contradicting
    the flag the operator typed. An operator watching a rollout would read
    denials from before their change as caused by it. Refusing it is honest;
    accepting it and rounding is not.
    """
    table = {"1h": 1, "6h": 6, "24h": 24, "7d": 168}
    if since in table:
        return table[since]
    # A usage error, not a runtime one: exit 2 like every other bad flag value,
    # rather than the exit 1 an uncaught ValueError would produce.
    raise typer.BadParameter(
        f"invalid --since value {since!r}; choose one of {', '.join(table)}"
    )


def guardrails_summary(
    ctx: typer.Context,
    since: str = typer.Option("24h", "--since", help="Window: 1h, 6h, 24h, 7d."),
    machine: Optional[str] = typer.Option(None, "--machine", help="Scope to one machine id."),
) -> None:
    """Coverage, blocks, and the per-policy table for a window.

    Shows evaluated/blocked totals, how many machines are enforcing versus
    merely reporting, a 24-bin sparkline of denies, and each policy's
    fired/blocked/instructed/p95.

    A `(no policy)` row is normal, not a gap: most evaluations are allows that
    no policy objected to, and the row keeps the denominator on screen — "14
    blocked" means little without the 933 it came from.

    Needs `policies:read`. With `--json`: the server summary plus the timeline.

    Examples:

    * `fp guardrails`
    * `fp guardrails --since 7d --machine ci-runner-01`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "guardrails", _KEY_MODE_REASON)
    cctx = require_auth(state)
    hours = _hours(since)
    _require_machine(cctx, machine)
    summary = api.enforcement_summary(cctx, hours=hours, machine_id=machine)
    timeline = api.decision_timeline(cctx, hours=hours, machine_id=machine)
    if output.is_json():
        output.emit_json({"summary": summary, "timeline": timeline})
        return
    output.render_guardrails(summary, timeline)


def guardrails_timeline(
    ctx: typer.Context,
    since: str = typer.Option("24h", "--since", help="Window: 1h, 6h, 24h, 7d."),
    machine: Optional[str] = typer.Option(None, "--machine", help="Scope to one machine id."),
) -> None:
    """When enforcement bit, and how hard — one row per time bucket.

    Shows `time · activity · total · denied · instructed`. The bar is scaled to
    the busiest bucket in the window, with the blocked share drawn in red inside
    it, so a quiet hour and a heavily-blocked hour are distinguishable at a
    glance rather than by reading numbers.

    Times are UTC, and the label follows the bucket size the server chose — a
    clock for hourly buckets, a date for daily ones.

    Needs `policies:read`. With `--json`: the server's timeline verbatim.

    Example:

    * `fp guardrails timeline --since 24h`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "guardrails timeline", _KEY_MODE_REASON)
    cctx = require_auth(state)
    hours = _hours(since)
    _require_machine(cctx, machine)
    data = api.decision_timeline(cctx, hours=hours, machine_id=machine)
    if output.is_json():
        output.emit_json(data)
        return
    output.render_decision_timeline(data)


def register(app: typer.Typer) -> None:
    # A pure container, like every other group in this CLI: bare `fp guardrails`
    # prints its help rather than running something. It used to run the summary
    # from a callback, which made it the only group that did — and put `--since`
    # in two places, where the group-level copy silently shadowed nothing and
    # taught the wrong shape.
    guardrails_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="What enforcement actually did (summary / timeline).",
    )
    guardrails_app.command("summary", epilog=GLOBALS_EPILOG)(guardrails_summary)
    guardrails_app.command("timeline", epilog=GLOBALS_EPILOG)(guardrails_timeline)
    app.add_typer(guardrails_app, name="guardrails")
