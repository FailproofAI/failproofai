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
from ..enforcement import RefError, check_race, latest_versions, plan_deploy
from ..errors import ApiError, NotFoundError
from . import _write

_KEY_MODE_REASON = (
    "the fleet is an operator surface and is not exposed on the versioned API that "
    "an API key authenticates against"
)


def fleet_list(ctx: typer.Context) -> None:
    """List machines and how many policies each is told to run.

    Shows `machine · label · policies · deployment · last seen`. A machine
    appears from its very first check-in, including the poll that finds nothing
    deployed — that is exactly the machine you are usually looking for.
    Needs `policies:read`. With `--json`: `{machines, deployments}`.

    Example:

    * `fp fleet list`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet", _KEY_MODE_REASON)
    cctx = require_auth(state)
    machines = api.list_machines(cctx)
    deployments = api.list_deployments(cctx)
    if output.is_json():
        output.emit_json({
            "machines": [m.to_dict() for m in machines],
            "deployments": [d.to_dict() for d in deployments],
        })
        return
    output.render_fleet(machines, deployments)


def fleet_show(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
) -> None:
    """Show exactly what one machine is told to enforce.

    The set shown is the set that exists — read this before a `--set`, because
    that flag replaces all of it. Needs `policies:read`.

    Example:

    * `fp fleet show ci-runner-01`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet show", _KEY_MODE_REASON)
    cctx = require_auth(state)
    dep = api.get_deployment(cctx, machine_id)
    if output.is_json():
        output.emit_json(
            dep.to_dict() if dep
            else {"machineId": machine_id, "deployment": None, "policies": []}
        )
        return
    if dep is None:
        output.info(f"{machine_id} has no deployment yet")
        return
    output.render_machine_policies(machine_id, dep)


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
        raise ApiError(
            "nothing to do — pass --add, --remove, or --set",
            hint="`fp fleet show <machine>` prints the current set",
        )

    # The server accepts a deploy to ANY id — that is how a machine can be
    # pre-staged before it ever polls. It also means a typo does not fail: it
    # mints a machine nobody owns, carrying policies nobody will collect, and
    # the only sign is an extra row in `fleet list`. The dashboard cannot hit
    # this because it deploys to a machine picked from a list; a CLI takes free
    # text, so the check has to be here.
    known = {m.machine_id for m in api.list_machines(cctx)}
    if machine_id not in known and not create:
        raise NotFoundError(
            f"no machine {machine_id!r} has checked in — deploying would create it "
            "as a new machine id"
        )

    current = api.get_deployment(cctx, machine_id)
    latest = latest_versions(api.list_policies(cctx))
    try:
        plan = plan_deploy(
            machine_id,
            current=current.policies if current else None,
            base=current.deployment if current else None,
            add=add or (),
            remove=remove or (),
            replace=replace,
            latest=latest,
        )
    except RefError as exc:
        raise ApiError(str(exc))

    if plan.is_noop:
        if output.is_json():
            output.emit_json({"plan": plan.to_dict(), "deployment": None, "applied": False})
            return
        output.info(f"{machine_id} already matches — nothing to deploy")
        return

    if not output.is_json():
        output.render_deploy_plan(plan)
    _write.confirm(
        state,
        f"replace {machine_id}'s policy set with the {len(plan.result)} above",
        assume_yes=yes,
        destructive=bool(plan.removed),
    )

    result = api.deploy_policies(cctx, machine_id, plan.result)
    check_race(plan.base, result.deployment)

    if output.is_json():
        output.emit_json({
            "plan": plan.to_dict(),
            "deployment": result.to_dict(),
            "applied": True,
        })
        return
    output.success(f"{machine_id} is now on deployment {result.deployment}")


def fleet_diff(
    ctx: typer.Context,
    machine_id: Optional[str] = typer.Argument(None, help="Machine id. Omit for the whole fleet."),
) -> None:
    """Show intent vs delivery — what a machine is told to run vs what it last pulled.

    The gap is the interesting part: a machine that has not collected its latest
    deployment is not enforcing what the dashboard says it is, and nothing else
    surfaces that as a single number. Needs `policies:read`.

    Example:

    * `fp fleet diff`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet diff", _KEY_MODE_REASON)
    cctx = require_auth(state)
    machines = api.list_machines(cctx)
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
    drifted = [r for r in rows if r["drifted"]]
    for r in rows:
        mark = "drifted" if r["drifted"] else "in sync"
        output.info(
            f"{r['machineId']}: intended #{r['intended']} · delivered "
            f"#{r['delivered'] if r['delivered'] is not None else '-'} · {mark}"
        )
    if drifted:
        output.warn(f"{len(drifted)} machine(s) have not collected their latest deployment")


def fleet_history(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
) -> None:
    """List a machine's deployment generations, newest first. Needs `policies:read`."""
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet history", _KEY_MODE_REASON)
    cctx = require_auth(state)
    entries = api.deployment_history(cctx, machine_id)
    if output.is_json():
        output.emit_json({"machineId": machine_id, "history": entries})
        return
    if not entries:
        output.info(f"{machine_id} has no deployment history")
        return
    for e in entries:
        pols = ", ".join(
            f"{p.get('id')}@{p.get('version')}" for p in (e.get("policies") or [])
        ) or "(none)"
        output.info(f"#{e.get('deployment')}  {e.get('updatedAt', '')}  {pols}")


def fleet_rollback(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
    deployment: int = typer.Argument(..., help="The generation to reinstate."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Reinstate a past generation's policy set.

    This mints a NEW generation carrying the old set rather than rewinding the
    counter, so history stays append-only. Needs `policies:write`.

    Example:

    * `fp fleet rollback ci-runner-01 3`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet rollback", _KEY_MODE_REASON)
    cctx = require_auth(state)
    current = api.get_deployment(cctx, machine_id)
    _write.confirm(
        state,
        f"reinstate deployment {deployment} on {machine_id} — this replaces its current set",
        assume_yes=yes,
        destructive=True,
    )
    result = api.rollback_deployment(cctx, machine_id, deployment)
    check_race(current.deployment if current else None, result.deployment)
    if output.is_json():
        output.emit_json(result.to_dict())
        return
    output.success(f"{machine_id} rolled back to the set from #{deployment} (now #{result.deployment})")


def fleet_rename(
    ctx: typer.Context,
    machine_id: str = typer.Argument(..., help="Machine id."),
    label: str = typer.Argument(..., help="Human-readable label."),
) -> None:
    """Give a machine a human label. The id itself never changes.

    Needs `policies:write`.
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet rename", _KEY_MODE_REASON)
    cctx = require_auth(state)
    res = api.rename_machine(cctx, machine_id, label)
    if output.is_json():
        output.emit_json(res)
        return
    output.success(f"{machine_id} is now labelled {label!r}")


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
