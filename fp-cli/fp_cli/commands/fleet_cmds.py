"""The fleet: fleet list / show / deploy / diff / history / rollback / rename.

What each machine is TOLD to enforce. Authoring the policies is `fp policies`;
what they actually did is `fp guardrails`.

## The one thing to understand before reading `deploy`

`PUT /enforcement/deployments/{id}` REPLACES a machine's whole policy set. There
is no merge and no server-side lock. The dashboard deliberately has no deploy
form for this reason — it edits the machine's own current set instead, because a
form that asks you to re-tick policies silently drops whatever you forget.

So `deploy` here defaults to a read-modify-write: it reads what the machine runs,
applies `--add`/`--remove`, shows the resulting FULL set, and writes that.
`--set` is the escape hatch for the declarative case and is the only way to say
"exactly these, drop the rest".
"""
from __future__ import annotations

from typing import List, Optional

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, deny_in_key_mode, require_auth
from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from ..enforcement import (
    RefError,
    RefUsageError,
    check_race,
    disabled_ids,
    latest_versions,
    plan_deploy,
)
from ..errors import ApiError, NotFoundError
from . import _write

_KEY_MODE_REASON = (
    "the fleet is an operator surface and is not exposed on the versioned API that "
    "an API key authenticates against"
)


def _require_machine(cctx, machine_id: str) -> None:
    """Refuse an id no machine has ever reported under.

    Without this, a typo is indistinguishable from a real machine that simply
    has nothing deployed: both render an empty set and exit 0. The id is also
    interpolated into a URL path further down, so an id containing `/` would
    address a different route entirely — the server rejects those, but a clear
    "no machine" beats someone else's 404.
    """
    if machine_id not in {m.machine_id for m in api.list_machines(cctx)}:
        raise NotFoundError(f"no machine {machine_id!r} has checked in")


def fleet_list(ctx: typer.Context) -> None:
    """List machines and how many policies each is told to run.

    Shows `machine · label · pol · intended · applied · seen · events · state`.
    `intended` is the generation deployed, `applied` is the one the machine last
    collected, and `seen` is when it last reported anything — a machine can be
    in sync and dead, or alive and behind, and those are different problems.

    A machine appears from its very first check-in, including the poll that
    finds nothing deployed — that is exactly the machine you are usually looking
    for. Needs `policies:read`. With `--json`: `{machines, deployments}`, where
    each machine carries raw timestamps plus the computed `drifted`.

    Example:

    * `fp fleet list`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet", _KEY_MODE_REASON)
    cctx = require_auth(state)
    machines = api.list_machines(cctx)
    if output.is_json():
        # Only `--json` emits the deployments, and only `--json` pays for them.
        # The table is built entirely from the machine records; fetching them
        # for a human render was a second request whose result was discarded.
        output.emit_json({
            "machines": [m.to_dict() for m in machines],
            "deployments": [d.to_dict() for d in api.list_deployments(cctx)],
        })
        return
    output.render_fleet(machines)


def fleet_show(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
) -> None:
    """Show exactly what one machine is told to enforce.

    The set shown is the set that exists — read this before a `--set`, because
    that flag replaces all of it.

    Also reports whether the machine has actually COLLECTED that deployment. A
    machine can be told to run a policy and not yet have it; the policy list
    alone cannot tell you which, and that is usually the question.

    Needs `policies:read`. With `--json`: `{machine, deployment}` — the machine
    record (including `appliedDeployment`, `drifted`, `lastSeen` and both label
    fields, with raw timestamps) and the deployment, or `deployment: null` when
    nothing is deployed.

    Example:

    * `fp fleet show ci-runner-01`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet show", _KEY_MODE_REASON)
    cctx = require_auth(state)
    # Two reads on purpose. The deployment says what the machine was TOLD to
    # run; only the machine record says whether it has collected it. Showing the
    # first without the second is how this view came to imply a policy was in
    # force when the host had never picked it up.
    machines = api.list_machines(cctx)
    machine = next((m for m in machines if m.machine_id == machine_id), None)
    if machine is None:
        raise NotFoundError(f"no machine {machine_id!r} has checked in")
    dep = api.get_deployment(cctx, machine_id)

    if output.is_json():
        output.emit_json({
            "machine": machine.to_dict(),
            "deployment": dep.to_dict() if dep else None,
        })
        return
    output.render_machine_policies(machine_id, dep, machine)


def fleet_deploy(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
    add: Optional[List[str]] = typer.Option(
        None, "--add",
        help="Add or update a policy: `id`, `id@version`, `id:effect` or `id@version:effect`.",
    ),
    remove: Optional[List[str]] = typer.Option(None, "--remove", help="Remove a policy by id."),
    replace: Optional[List[str]] = typer.Option(
        None, "--set",
        help="REPLACE the whole set with exactly these. Cannot be combined with --add/--remove.",
    ),
    create: bool = typer.Option(
        False, "--create",
        help="Allow deploying to a machine id that has not checked in yet (pre-staging).",
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Change what a machine enforces, showing the full resulting set first.

    `--add`/`--remove` read the machine's current set and apply a delta, so
    nothing you did not mention is disturbed. A bare `--add` on a policy the
    machine already runs keeps its pinned version rather than silently
    upgrading; pass `id@version` to move it.

    `--set` replaces everything — the only way to drop policies you do not name.

    **Concurrency.** The write is a full replace with no server-side lock, so the
    CLI records the generation it read and refuses if the result is not exactly
    one higher: that means somebody else deployed in between and a replace does
    not merge. Needs `policies:write`. With `--json`: the plan plus the resulting
    deployment.

    Examples:

    * `fp fleet deploy ci-runner-01 --add no-force-push`
    * `fp fleet deploy ci-runner-01 --add prod-guard@1:observe --remove old-rule`
    * `fp fleet deploy ci-runner-01 --set no-force-push --set no-secret-echo`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet deploy", _KEY_MODE_REASON)
    cctx = require_auth(state)

    if not add and not remove and replace is None:
        # Exit 2 for the same reason `--set` with `--add` is: no flag
        # combination was given that this command can act on. Both are the
        # caller's command line, not the server's answer.
        raise click.UsageError(
            "nothing to do — pass --add, --remove, or --set. "
            "`fp fleet show <machine>` prints the current set."
        )

    # The server accepts a deploy to ANY id — that is how a machine can be
    # pre-staged before it ever polls. It also means a typo does not fail: it
    # mints a machine nobody owns, carrying policies nobody will collect, and
    # the only sign is an extra row in `fleet list`. The dashboard cannot hit
    # this because it deploys to a machine picked from a list; a CLI takes free
    # text, so the check has to be here.
    if not create:
        try:
            _require_machine(cctx, machine_id)
        except NotFoundError:
            raise NotFoundError(
                f"no machine {machine_id!r} has checked in — deploying would create "
                "it as a new machine id. Pass --create if that is deliberate."
            )

    current = api.get_deployment(cctx, machine_id)
    published = api.list_policies(cctx)
    latest = latest_versions(published)
    try:
        plan = plan_deploy(
            machine_id,
            current=current.policies if current else None,
            base=current.deployment if current else None,
            add=add or (),
            remove=remove or (),
            replace=replace,
            latest=latest,
            disabled=disabled_ids(published),
        )
    except RefUsageError as exc:
        # Exit 2, like every other bad flag value in this CLI (`--since`,
        # `--expect`, `--file`). These are retype-the-command mistakes; exit 1
        # says "the server refused", which is a different thing to script on.
        raise click.UsageError(str(exc))
    except RefError as exc:
        raise ApiError(str(exc))

    # A no-op exits 0 WITHOUT writing, which is desired-state semantics: a
    # retrying harness re-running the same deploy should succeed, not error.
    # Two consequences worth knowing rather than discovering:
    #   * `applied: false` in --json is the only way to tell "I changed it" from
    #     "it already matched" — the exit code is 0 either way, on purpose.
    #   * the short-circuit happens BEFORE the write, so a reader without
    #     `policies:write` also gets 0 here. They have not gained anything (the
    #     state already held and nothing was written), but the exit code alone
    #     is not proof of write access.
    if plan.is_noop:
        if output.is_json():
            output.emit_json({"plan": plan.to_dict(), "deployment": None, "applied": False})
            return
        output.deployment_unchanged(machine_id)
        return

    if not output.is_json():
        output.render_deploy_plan(plan)
    dropped = len(plan.removed)
    if not _write.confirm_destructive(
        state, "replace the policy set on", machine_id,
        consequence=(f"this REPLACES the whole set with the {len(plan.result)} shown above"
                     + (f"; {dropped} would be removed" if dropped else "")),
        assume_yes=yes,
    ):
        if output.is_json():
            output.emit_json({"plan": plan.to_dict(), "cancelled": True, "applied": False})
        else:
            output.print_cancelled()
        return

    result = api.deploy_policies(cctx, machine_id, plan.result)
    check_race(plan.base, result.deployment)

    if output.is_json():
        output.emit_json({
            "plan": plan.to_dict(),
            "deployment": result.to_dict(),
            "applied": True,
        })
        return
    output.deployment_applied(machine_id, result.deployment, len(result.policies))


def fleet_diff(
    ctx: typer.Context,
    machine_id: Optional[str] = typer.Argument(None, help="Machine id. Omit for the whole fleet."),
) -> None:
    """Show intent vs delivery — what a machine is told to run vs what it last pulled.

    The gap is the interesting part: a machine that has not collected its latest
    deployment is not enforcing what the dashboard says it is, and nothing else
    surfaces that as a single number. Needs `policies:read`. With `--json`:
    `{machines:[{machineId, intended, delivered, drifted}]}` — `drifted` is the
    field the CLI computes, so a harness need not derive it.

    Example:

    * `fp fleet diff`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet diff", _KEY_MODE_REASON)
    cctx = require_auth(state)
    machines = api.list_machines(cctx)
    # Every other machine-scoped command refuses an id nobody has reported
    # under; this one filtered to nothing and exited 0 saying "no machines have
    # checked in yet" — false, and indistinguishable from a healthy fleet. The
    # list is already in hand, so the check costs no extra request.
    if machine_id and machine_id not in {m.machine_id for m in machines}:
        raise NotFoundError(f"no machine {machine_id!r} has checked in")
    rows = []
    for m in sorted(machines, key=lambda x: x.machine_id):
        if machine_id and m.machine_id != machine_id:
            continue
        rows.append({
            "machineId": m.machine_id,
            "intended": m.deployment,
            "delivered": m.applied_deployment,
            "drifted": m.drifted,
        })
    if output.is_json():
        output.emit_json({"machines": rows})
        return
    output.render_fleet_diff(rows)


def fleet_history(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
) -> None:
    """List a machine's deployment generations, newest first.

    A reissue — the server rewriting a deployment because a policy was disabled
    — appears as an ordinary entry. Needs `policies:read`. With `--json`:
    `{machineId, history:[{deployment, policies, updatedAt}]}`.

    Example:

    * `fp fleet history ci-runner-01`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet history", _KEY_MODE_REASON)
    cctx = require_auth(state)
    _require_machine(cctx, machine_id)
    entries = api.deployment_history(cctx, machine_id)
    if output.is_json():
        output.emit_json({"machineId": machine_id, "history": entries})
        return
    output.render_deployment_history(machine_id, entries)


def fleet_rollback(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
    deployment: int = typer.Argument(..., help="The generation to reinstate."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Reinstate a past generation's policy set.

    This mints a NEW generation carrying the old set rather than rewinding the
    counter, so history stays append-only. A generation containing a policy that
    has since been disabled or deleted cannot be reinstated; the server says so.

    Needs `policies:write`. With `--json`: the resulting deployment, or
    `{"cancelled": true}` if you decline.

    Example:

    * `fp fleet rollback ci-runner-01 3`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet rollback", _KEY_MODE_REASON)
    cctx = require_auth(state)
    _require_machine(cctx, machine_id)
    current = api.get_deployment(cctx, machine_id)
    if not _write.confirm_destructive(
        state, f"reinstate deployment #{deployment} on", machine_id,
        consequence="this REPLACES the machine's current set with the one from that generation",
        assume_yes=yes,
    ):
        if output.is_json():
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    result = api.rollback_deployment(cctx, machine_id, deployment)
    check_race(current.deployment if current else None, result.deployment)
    if output.is_json():
        output.emit_json(result.to_dict())
        return
    output.deployment_rolled_back(machine_id, deployment, result.deployment)


def fleet_rename(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
    label: str = typer.Argument(..., help="Human-readable label."),
) -> None:
    """Give a machine a human label. The id itself never changes.

    Needs `policies:write`. With `--json`: `{machineId, labelOverride}` — the
    server stores the label as an override beside the machine's self-asserted
    one rather than replacing it.

    Example:

    * `fp fleet rename ci-runner-01 "CI runner (eu-west)"`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet rename", _KEY_MODE_REASON)
    cctx = require_auth(state)
    res = api.rename_machine(cctx, machine_id, label)
    if output.is_json():
        output.emit_json(res)
        return
    output.machine_renamed(machine_id, label)


def register(app: typer.Typer) -> None:
    fleet_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="The fleet and what each machine enforces (list / show / deploy / diff / history / rollback / rename).",
    )
    fleet_app.command("list", epilog=GLOBALS_EPILOG)(fleet_list)
    fleet_app.command("show", epilog=GLOBALS_EPILOG)(fleet_show)
    fleet_app.command("deploy", epilog=GLOBALS_EPILOG)(fleet_deploy)
    fleet_app.command("diff", epilog=GLOBALS_EPILOG)(fleet_diff)
    fleet_app.command("history", epilog=GLOBALS_EPILOG)(fleet_history)
    fleet_app.command("rollback", epilog=GLOBALS_EPILOG)(fleet_rollback)
    fleet_app.command("rename", epilog=GLOBALS_EPILOG)(fleet_rename)
    app.add_typer(fleet_app, name="fleet")
