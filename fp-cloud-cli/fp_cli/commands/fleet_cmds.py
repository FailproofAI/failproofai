"""The fleet: fleet list / show / deploy / jev-mode / diff / history / rollback / rename.

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
    JEV_MODES,
    RefError,
    RefUsageError,
    check_race,
    disabled_ids,
    jev_mode_after,
    latest_versions,
    plan_deploy,
    version_kinds,
)
from ..errors import ApiError, AuthError, FpCliError, NotFoundError
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
    `state` reads `N errors` when the machine reported policies it could not
    apply (`fp fleet show <machine>` lists them).

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

    Shows the Jev mode FailproofAI Cloud sets on the machine (`local` when it
    sets none) and the policy errors the machine last reported: a policy it
    could not load, a Jev mode it cannot act on (`jev_unconfigured`: its key
    does not carry Jev; `transcripts_disabled`: it was connected with
    `--no-transcripts`), FailproofAI Cloud Jev refusing or failing its calls
    (`jev_rate_limited`: over the organization's Jev rate limit;
    `jev_unavailable`: it skips a failing Cloud Jev for a minute at a time), an
    installed pack's check left out for the question budget (`jev_budget`) or
    because an organization Cloud check has its name (`jev_name_clash`).
    Anything listed there is not enforcing, whatever the deployment says.

    Needs `policies:read`. With `--json`: `{machine, deployment}` — the machine
    record (including `appliedDeployment`, `drifted`, `lastSeen`, both label
    fields, `jevMode` and `policyErrors`/`policyErrorsAt` when reported, with raw
    timestamps) and the deployment, or `deployment: null` when nothing is
    deployed.

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
        help="Add or update a policy: `id`, `id@version`, `id:effect` or `id@version:effect`. "
             "`observe` on a `both` policy observes its JavaScript and withholds its Jev checks.",
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
    jev_mode: Optional[str] = typer.Option(
        None, "--jev-mode",
        help="Set the machine's Jev mode from FailproofAI Cloud: off, observe, enforce (Jev's "
             "checks BLOCK calls as well as clearing what they review) — or local to stop "
             "overriding the machine's own. Jev checks run on FailproofAI Cloud; nothing is "
             "installed on the machine. Machine-wide: installed packs' checks too. "
             "Omitted: unchanged.",
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Change what a machine enforces, showing the full resulting set first.

    `--add`/`--remove` read the machine's current set and apply a delta, so
    nothing you did not mention is disturbed. A bare `--add` on a policy the
    machine already runs keeps its pinned version rather than silently
    upgrading; pass `id@version` to move it.

    `--set` replaces everything — the only way to drop policies you do not name.

    Any kind deploys the same way. Jev checks run on FailproofAI Cloud; nothing
    is installed on the machine: a `both` policy sends the machine its
    JavaScript, and the machine asks FailproofAI Cloud about each checked tool
    call while its Jev mode is `observe` or `enforce`. An effect applies to
    JavaScript only — an `observe` `both` policy observes its JavaScript and its
    Jev checks are not asked — and a `jev` policy is watched through the Jev
    MODE instead: `--jev-mode observe` asks Jev and logs what it says while the
    regex policies decide; `enforce` lets Jev's checks BLOCK calls (every `jev`
    policy's deny checks) as well as clear the regex verdicts they review; `off`
    stops Jev on the machine; `local` hands the choice back to the machine. The
    mode is the MACHINE's: it also governs the checks of any pack installed
    there, and it overrides the machine's own mode and `jev.json`, a local
    `off` included. Without `--jev-mode` it is left as it is.

    `--jev-mode` with no change to the set changes ONLY the mode (the same as
    `fp fleet jev-mode`): the policy set — disabled policies' assignments
    included — is not read back and rewritten.

    **Concurrency.** The write is a full replace with no server-side lock, so the
    CLI records the generation it read and refuses if the result is not exactly
    one higher: that means somebody else deployed in between and a replace does
    not merge. Needs `policies:write`. With `--json`: the plan plus the resulting
    deployment.

    Examples:

    * `fp fleet deploy ci-runner-01 --add no-force-push`
    * `fp fleet deploy ci-runner-01 --add prod-guard@1:observe --remove old-rule`
    * `fp fleet deploy ci-runner-01 --set no-force-push --set no-secret-echo`
    * `fp fleet deploy ci-runner-01 --add prod-db-intent --jev-mode observe`
    * `fp fleet deploy ci-runner-01 --jev-mode local`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet deploy", _KEY_MODE_REASON)
    cctx = require_auth(state)

    if not add and not remove and replace is None and jev_mode is None:
        # Exit 2 for the same reason `--set` with `--add` is: no flag
        # combination was given that this command can act on. Both are the
        # caller's command line, not the server's answer.
        raise click.UsageError(
            "nothing to do — pass --add, --remove, --set, or --jev-mode. "
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
            jev_mode=jev_mode,
            current_jev_mode=current.jev_mode if current else None,
            kinds=version_kinds(published),
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

    # The mode alone: its own route, which never touches the policy set. A
    # deploy is a full replace of the set the CLI read, and that set leaves out
    # disabled policies' assignments — so a mode change sent as a deploy deleted
    # them, and reverted anything changed since the read (CONTRACT C9.1). A
    # machine with no deployment yet has nothing to lose and no mode to change:
    # its first deploy, carrying the mode, is how it gets one.
    if plan.jev_mode is not None and not plan.set_changes and current is not None:
        _apply_jev_modes(state, cctx, [(machine_id, current.jev_mode)], plan.jev_mode, yes=yes, plan=plan)
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

    result = api.deploy_policies(cctx, machine_id, plan.result, jev_mode=jev_mode)
    check_race(plan.base, result.deployment)

    if output.is_json():
        output.emit_json({
            "plan": plan.to_dict(),
            "deployment": result.to_dict(),
            "applied": True,
        })
        return
    output.deployment_applied(machine_id, result.deployment, len(result.policies))


def _jev_mode_consequence(mode: str, count: int) -> str:
    what = f"{count} machine{'s' if count != 1 else ''}"
    tail = {
        "enforce": "; in enforce Jev's deny checks BLOCK calls, and it covers installed packs' checks too",
        "observe": "; in observe Jev only records what it would have decided",
        "off": "; Jev stops on them, a local jev.json included",
        "local": "; each machine's own jev.json decides again",
    }.get(mode, "")
    return f"this sets the Jev mode to {mode} on {what} and leaves their policy sets untouched{tail}"


def _apply_jev_modes(
    state: AppState,
    cctx,
    targets: List[tuple],
    mode: str,
    *,
    yes: bool,
    plan=None,
) -> None:
    """Set `mode` on each `(machine_id, current_mode)`, through the mode-only route.

    Shared by `fleet jev-mode` and `fleet deploy --jev-mode` with no set change.
    A machine already on `mode` is left alone; one that fails is reported and
    the rest still go ahead (exit 1 at the end, naming them).
    """
    after = jev_mode_after(mode)
    rows = [
        {"machineId": mid, "from": cur or "local", "to": after or "local", "changed": (cur or None) != after}
        for mid, cur in targets
    ]
    todo = [r for r in rows if r["changed"]]
    if not todo:
        if output.is_json():
            out = {"mode": mode, "machines": rows, "applied": False}
            if plan is not None:
                out = {"plan": plan.to_dict(), "deployment": None, "applied": False}
            output.emit_json(out)
            return
        output.jev_mode_unchanged([r["machineId"] for r in rows], mode)
        return

    if not output.is_json():
        output.render_jev_mode_plan(rows)
    if not _write.confirm_destructive(
        state, "change the Jev mode on",
        todo[0]["machineId"] if len(todo) == 1 else f"{len(todo)} machines",
        consequence=_jev_mode_consequence(mode, len(todo)),
        assume_yes=yes,
    ):
        if output.is_json():
            output.emit_json({"cancelled": True, "applied": False, "machines": rows})
        else:
            output.print_cancelled()
        return

    failed = []
    last = None
    for row in todo:
        try:
            result, changed = api.set_jev_mode(cctx, row["machineId"], mode)
        except AuthError:
            raise
        except FpCliError as exc:
            # One machine's refusal (a 404, a 403, a 422) is that machine's;
            # the rest still go ahead, and the exit code says it was not all.
            row["error"] = exc.format_message() if hasattr(exc, "format_message") else str(exc)
            failed.append(row["machineId"])
            continue
        last = result
        row["deployment"] = result.deployment
        row["changed"] = changed

    if output.is_json():
        if plan is not None:
            output.emit_json({
                "plan": plan.to_dict(),
                "deployment": last.to_dict() if last is not None else None,
                "applied": last is not None,
                "jevModeOnly": True,
            })
        else:
            output.emit_json({"mode": mode, "machines": rows, "applied": not failed})
    else:
        output.jev_mode_applied(rows)
    if failed:
        raise ApiError(
            f"the Jev mode could not be changed on {', '.join(failed)}"
            + ("" if len(failed) == len(todo) else " — the other machines were changed"),
        )


def fleet_jev_mode(
    ctx: typer.Context,
    args: Optional[List[str]] = typer.Argument(
        None, metavar="[MACHINE]... MODE",
        help="The machines, then the mode: off, observe, enforce or local. With --all, just the mode.",
    ),
    all_machines: bool = typer.Option(
        False, "--all", help="Every machine that has a deployment (machines with none are skipped).",
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Set the Jev mode FailproofAI Cloud gives machines, and nothing else.

    `off`, `observe` or `enforce` override each machine's own mode and
    `jev.json`, a local `off` included; `local` hands the choice back to the
    machine. Jev checks run on FailproofAI Cloud; nothing is installed on the
    machine: under `observe` or `enforce` it sends each checked tool call to
    FailproofAI Cloud. `observe` asks Jev and records what it says while the
    regex policies decide. `enforce` lets Jev's checks BLOCK calls — every `jev`
    policy's deny checks — as well as clear the regex verdicts they review. The
    mode is the machine's: it also governs the checks of every pack installed
    there. A machine connected with `--no-transcripts` never asks, and reports
    `transcripts_disabled`.

    Only the mode changes: each machine's policy set, disabled policies'
    assignments included, is left exactly as it is, and a machine already on
    the mode is skipped. Each change is a new generation in `fp fleet history`.
    A machine with no deployment has no mode to change — `fp fleet deploy
    <machine> --jev-mode <mode>` gives it its first deployment with one.

    Needs `policies:write`. With `--json`: `{mode, applied, machines:[{machineId,
    from, to, changed, deployment?, error?}]}`.

    Examples:

    * `fp fleet jev-mode ci-runner-01 observe`
    * `fp fleet jev-mode ci-runner-01 ci-runner-02 enforce`
    * `fp fleet jev-mode --all local`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet jev-mode", _KEY_MODE_REASON)
    words = list(args or [])
    if not words:
        raise click.UsageError("pass the mode: off, observe, enforce or local")
    mode, machine_ids = words[-1], list(dict.fromkeys(words[:-1]))
    if mode not in JEV_MODES:
        raise click.UsageError(f"{mode!r} is not a Jev mode — one of {', '.join(JEV_MODES)}")
    if all_machines and machine_ids:
        raise click.UsageError("--all sets every machine; do not name machines as well")
    if not all_machines and not machine_ids:
        raise click.UsageError("name at least one machine, or pass --all")
    cctx = require_auth(state)

    deployments = {d.machine_id: d for d in api.list_deployments(cctx)}
    if all_machines:
        targets = [(mid, deployments[mid].jev_mode) for mid in sorted(deployments)]
    else:
        known = {m.machine_id for m in api.list_machines(cctx)} | set(deployments)
        unknown = [mid for mid in machine_ids if mid not in known]
        if unknown:
            raise NotFoundError(f"no machine {', '.join(repr(u) for u in unknown)} has checked in")
        bare = [mid for mid in machine_ids if mid not in deployments]
        if bare:
            raise ApiError(
                f"{', '.join(bare)} {'has' if len(bare) == 1 else 'have'} no deployment, so there is no Jev "
                "mode to change",
                hint=f"`fp fleet deploy <machine> --jev-mode {mode}` gives a machine its first deployment with the mode",
            )
        targets = [(mid, deployments[mid].jev_mode) for mid in machine_ids]
    if not targets:
        if output.is_json():
            output.emit_json({"mode": mode, "machines": [], "applied": False})
        else:
            output.info("no machine has a deployment yet — nothing to set")
        return
    _apply_jev_modes(state, cctx, targets, mode, yes=yes)


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
    — appears as an ordinary entry, and so does a Jev mode change. Each
    generation shows the Jev mode FailproofAI Cloud set with it (`local` when it
    set none), which is the mode a rollback to it restores. Needs
    `policies:read`. With `--json`: `{machineId, history:[{deployment, policies,
    updatedAt, jevMode}]}`.

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
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Reinstate a past generation's policy set.

    This mints a NEW generation carrying the old set rather than rewinding the
    counter, so history stays append-only. A generation containing a policy that
    has since been disabled or deleted cannot be reinstated; the server says so.

    It restores that generation's Jev mode too, `local` included: the prompt
    and the result say `jev mode <now> → <then>` when that changes it.

    Needs `policies:write`. With `--json`: the resulting deployment plus
    `jevModeBefore` (the mode it replaced), or `{"cancelled": true}` if you
    decline.

    Example:

    * `fp fleet rollback ci-runner-01 3`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "fleet rollback", _KEY_MODE_REASON)
    cctx = require_auth(state)
    _require_machine(cctx, machine_id)
    current = api.get_deployment(cctx, machine_id)
    # The mode that generation carried comes back with it, NULL (`local`)
    # included — a rollback past an `--jev-mode off` turns enforcement back on.
    # Read it first, so the prompt says so rather than the fleet finding out.
    target = next(
        (e for e in api.deployment_history(cctx, machine_id) if e.get("deployment") == deployment), None)
    mode_before = (current.jev_mode if current else None) or "local"
    mode_target = (target.get("jevMode") or "local") if target is not None else None
    consequence = "this REPLACES the machine's current set with the one from that generation"
    if mode_target is not None and mode_target != mode_before:
        consequence += f", and its Jev mode: jev mode {mode_before} → {mode_target}"
    if not _write.confirm_destructive(
        state, f"reinstate deployment #{deployment} on", machine_id,
        consequence=consequence,
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
        output.emit_json({**result.to_dict(), "jevModeBefore": mode_before})
        return
    output.deployment_rolled_back(
        machine_id, deployment, result.deployment,
        jev_from=mode_before, jev_to=result.jev_mode or "local",
    )


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
        help="The fleet and what each machine enforces (list / show / deploy / jev-mode / diff / history / rollback / rename).",
    )
    fleet_app.command("list", epilog=GLOBALS_EPILOG)(fleet_list)
    fleet_app.command("show", epilog=GLOBALS_EPILOG)(fleet_show)
    fleet_app.command("deploy", epilog=GLOBALS_EPILOG)(fleet_deploy)
    fleet_app.command("jev-mode", epilog=GLOBALS_EPILOG)(fleet_jev_mode)
    fleet_app.command("diff", epilog=GLOBALS_EPILOG)(fleet_diff)
    fleet_app.command("history", epilog=GLOBALS_EPILOG)(fleet_history)
    fleet_app.command("rollback", epilog=GLOBALS_EPILOG)(fleet_rollback)
    fleet_app.command("rename", epilog=GLOBALS_EPILOG)(fleet_rename)
    app.add_typer(fleet_app, name="fleet")
