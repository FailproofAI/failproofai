"""Cloud-managed policies: policies list / show / publish / enable / disable / delete.

Where a policy VERSION is written. Deploying one to a machine is `fp fleet`, and
seeing what it actually did is `fp guardrails` — three commands because they are
three jobs, done by different people at different times, exactly as the
dashboard splits them across three pages.

Publishing mints a new version and changes nothing on any machine. That is the
single most surprising thing here, so every success path says so.
"""
from __future__ import annotations

from typing import Optional

import typer

from .. import client as api
from .. import output, theme
from .._context import GLOBALS_EPILOG, AppState, deny_in_key_mode, require_auth
from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from ..enforcement import RefError, RefUsageError, read_source
from ..policy_check import check_syntax, run_policy
from ..errors import ApiError, NotFoundError
from . import _write

#: Every command here is session-only. These endpoints are ROOT-ONLY on the
#: server — deliberately absent from `/v1`, because `/v1` is internet-facing and
#: publish/deploy/rollback are operator writes. Failing here beats translating a
#: path that would 404 with no explanation.
_KEY_MODE_REASON = (
    "cloud-managed policies are an operator surface and are not exposed on the "
    "versioned API that an API key authenticates against"
)


def policies_list(ctx: typer.Context) -> None:
    """List every published policy version, newest of each policy first.

    Shows `policy · version · state · description`, one row per VERSION —
    versions are immutable and every one stays addressable, so a policy
    published three times is three rows. The title counts distinct policies and
    captions the version total, the way the dashboard's library does.

    `state` is active, disabled (kept but not enforced) or archived (deleted;
    machines already carrying it keep it until redeployed). Needs
    `policies:read`. With `--json`: the server's policy list verbatim — also
    every version, so deduplicate on `id` if you want one row per policy.

    Example:

    * `fp policies list`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies", _KEY_MODE_REASON)
    cctx = require_auth(state)
    items = api.list_policies(cctx)
    if output.is_json():
        output.emit_json({"policies": [p.to_dict() for p in items]})
        return
    output.render_policies(items)


def policies_show(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
) -> None:
    """Show one policy, including its full source.

    Needs `policies:read`. With `--json`: the policy object with `source`.

    Example:

    * `fp policies show no-force-push`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies show", _KEY_MODE_REASON)
    cctx = require_auth(state)
    # Explicitly the newest version, not the first one the server happened to
    # list. `next(...)` returned whichever came back first, so the source shown
    # was correct only for as long as the endpoint kept returning descending
    # versions — and a stale source rendered identically to a current one.
    versions = [p for p in api.list_policies(cctx) if p.id == policy_id]
    if not versions:
        raise NotFoundError(f"no policy named {policy_id}")
    match = max(versions, key=lambda p: p.version)
    if output.is_json():
        output.emit_json(match.to_dict())
        return
    carriers = {
        d.machine_id: ref.version
        for d in api.list_deployments(cctx)
        for ref in d.policies
        if ref.id == policy_id
    }
    output.render_policy_published(match, carriers=carriers,
                                   source_bytes=len((match.source or "").encode("utf-8")))
    if match.source:
        output.info(match.source)


def policies_publish(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id (letters, numbers, '.', '_', '-')."),
    source: Optional[str] = typer.Argument(
        None,
        help="Path to the policy source, @path, or - for stdin. Omit to paste it.",
    ),
    description: str = typer.Option("", "--description", help="One-line description."),
    no_verify: bool = typer.Option(
        False, "--no-verify", help="Skip the JavaScript syntax check before publishing."
    ),
) -> None:
    """Publish a policy — mints a NEW VERSION; it never edits one in place.

    The source is parse-checked with node before it is sent. Nothing downstream
    does this: the server validates the id and a size ceiling, and a broken
    policy otherwise fails on the machine at enforcement time. `--no-verify`
    skips it; a host without node publishes with a warning rather than a block.

    Source can come from a path, `@path`, a pipe, `-`, or an interactive paste
    when you give none and stdin is a terminal.

    **Publishing deploys nothing.** A new version sits unused until
    `fp fleet deploy` puts it on a machine. Needs `policies:write`.
    With `--json`: the created version plus `carriers` — a map of machine id to
    the version of this policy it currently runs, so a harness can tell what a
    publish left behind without a second call.

    Examples:

    * `fp policies publish no-force-push ./rule.mjs`
    * `cat rule.mjs | fp policies publish no-force-push`
    * `fp policies publish no-force-push -` — read stdin explicitly
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies publish", _KEY_MODE_REASON)
    cctx = require_auth(state)

    def _paste_prompt() -> None:
        output.hint("paste the policy source, then press Ctrl-D")

    try:
        text = read_source(source, prompt=_paste_prompt)
    except RefUsageError as exc:
        raise click.UsageError(str(exc))
    except RefError as exc:
        raise ApiError(str(exc))
    if not text.strip():
        raise ApiError("policy source is empty — nothing to publish")

    # Nothing downstream parses this. The server checks the id and a size
    # ceiling; the machines find out at enforcement time, which is the worst
    # place for a syntax error to surface. `--no-verify` exists because a
    # machine without node should still be able to publish, not because
    # skipping is ever a good idea.
    if not no_verify:
        syn = check_syntax(text)
        if not syn.ok:
            raise ApiError(
                f"{policy_id} is not parseable JavaScript — refusing to publish it:\n"
                f"{syn.message}",
                hint="fix the syntax, or pass --no-verify to publish it anyway",
            )
        if not syn.checked and not output.is_json():
            output.warn(syn.message)

    created = api.publish_policy(cctx, policy_id, text, description)

    # Which machines already carry this policy, and at which version. Publishing
    # deploys nothing, so this is the one thing the card must not guess at: it
    # used to state "not deployed anywhere" unconditionally, which was wrong for
    # every policy that already had a version in the field.
    carriers = {
        d.machine_id: ref.version
        for d in api.list_deployments(cctx)
        for ref in d.policies
        if ref.id == policy_id
    }
    if output.is_json():
        # `syntax` included, exactly as `policies test` does. `SyntaxResult.checked`
        # exists so that "we did not look" can never render as "we looked and it
        # passed" — and the only report of it was gated on `not output.is_json()`,
        # so on the automated path an UNCHECKED publish was byte-identical to a
        # verified one. A CI container without node published unparsed source,
        # the harness read success, and the syntax error surfaced at enforcement
        # time on the machines — the one place `policy_check`'s docstring exists
        # to move it away from.
        output.emit_json({**created.to_dict(), "carriers": carriers, "syntax": syn.to_dict()})
        return
    output.render_policy_published(created, carriers=carriers,
                                   source_bytes=len(text.encode("utf-8")))


def policies_enable(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Re-enable a disabled policy, restoring it to the machines that lost it.

    The exact inverse of `disable`: the server puts the policy back into every
    deployment it was removed from, advancing each machine's generation again.
    Nothing needs redeploying by hand.

    Needs `policies:write`. With `--json`: `{id, disabled, archived,
    machinesUpdated}` — `machinesUpdated` counts the deployments rewritten, and
    matches the count the preceding `disable` reported.

    Example:

    * `fp policies enable no-force-push --yes`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies enable", _KEY_MODE_REASON)
    cctx = require_auth(state)
    # Confirmed, like its exact inverse. `disable` took `--yes` and prompted;
    # this fired the moment it was typed, with no prompt and no way to withhold
    # one — on a fleet-wide mutation with the same blast radius in the opposite
    # direction: re-arming a policy can start denying tool calls on every machine
    # at its next poll. It was the only deployment-mutating command in the CLI
    # with neither (`fleet deploy`, `fleet rollback`, `policies disable` and
    # `policies delete` all confirm), and a mistyped id reached the server
    # unchecked. Calm glyph rather than the destructive ⚠, matching `users
    # enable`: this is restorative, not dangerous — but it is not a read.
    if not _write.confirm_action(
        state, "enable policy", policy_id,
        consequence=("it is added back to every deployment it was removed from, "
                     "minting a new generation on each"),
        assume_yes=yes, glyph="↑", color=theme.ACCENT,
    ):
        if output.is_json():
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    res = api.set_policy_enabled(cctx, policy_id, True)
    if output.is_json():
        output.emit_json(res)
        return
    output.policy_lifecycle_changed(policy_id, "enabled")


def policies_disable(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Disable a policy. It is removed from every deployment carrying it.

    Not just "machines stop enforcing it": the server reissues each affected
    machine's deployment WITHOUT this policy, advancing that machine's
    generation. `fp fleet history` shows the reissue as an ordinary entry.

    `policies enable` is the exact inverse: it puts the policy back into every
    deployment it was removed from, so nothing needs redeploying by hand.

    Needs `policies:write`. With `--json`: `{id, disabled, archived,
    machinesUpdated}` — `machinesUpdated` is how many deployments were rewritten
    to drop it, and is the number to check if you expected this to be a no-op.

    Example:

    * `fp policies disable no-force-push --yes`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies disable", _KEY_MODE_REASON)
    cctx = require_auth(state)
    if not _write.confirm_destructive(
        state, "disable policy", policy_id,
        consequence=("it is REMOVED from every deployment carrying it, minting a new "
                     "generation on each; `policies enable` puts it back the same way"),
        assume_yes=yes,
    ):
        if output.is_json():
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    res = api.set_policy_enabled(cctx, policy_id, False)
    if output.is_json():
        output.emit_json(res)
        return
    output.policy_lifecycle_changed(policy_id, "disabled")


def policies_delete(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Archive a policy. This cannot be undone from the CLI.

    Archiving hides it from `policies list` and from future deployments. A
    machine already carrying it keeps enforcing it until something redeploys —
    deleting is not a way to stop enforcement everywhere, and `disable` is.

    Needs `policies:write`. With `--json`: `{id, disabled, archived,
    machinesUpdated}`, or `{"cancelled": true}` if you decline.

    Example:

    * `fp policies delete old-rule --yes`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies delete", _KEY_MODE_REASON)
    cctx = require_auth(state)
    if not _write.confirm_destructive(
        state, "archive policy", policy_id,
        consequence=("machines already carrying it keep enforcing until redeployed — "
                     "`policies disable` is what stops enforcement"),
        assume_yes=yes,
    ):
        if output.is_json():
            output.emit_json({"cancelled": True})
        else:
            output.print_cancelled()
        return
    res = api.delete_policy(cctx, policy_id)
    if output.is_json():
        output.emit_json(res)
        return
    output.policy_lifecycle_changed(policy_id, "archived")


def policies_test(
    ctx: typer.Context,
    source: Optional[str] = typer.Argument(
        None, help="Policy file, @path, or - for stdin. Omit to paste it."
    ),
    tool: str = typer.Option("Bash", "--tool", help="Tool name the hook fired for."),
    command: Optional[str] = typer.Option(None, "--command", help="Bash command to test against."),
    file_path: Optional[str] = typer.Option(None, "--file", help="File path to test against."),
    event: str = typer.Option("PreToolUse", "--event", help="Hook event type."),
    expect: Optional[str] = typer.Option(
        None, "--expect",
        help="Assert the decision is allow/deny/instruct; exit 1 if it is not.",
    ),
) -> None:
    """Run a policy locally and print what it would decide. No server, no fleet.

    Executes the real file — bare `import { deny } from "failproofai"` and all —
    against a context you describe, and prints allow / deny / instruct per
    registered policy. Nothing is published and nothing is installed.

    Needs `node` on PATH. This is a dry run, not the enforcement path: it proves
    the policy parses, registers and decides for the input given. It cannot
    prove the daemon feeds it the same context.

    With `--json`: `{ok, decision, policies:[{name, decision, reason}]}` — the
    overall `decision` is the strictest any policy returned.

    Examples:

    * `fp policies test ./rule.mjs --command "git push --force"`
    * `fp policies test ./rule.mjs --tool Write --file .env`
    """
    # No `require_auth` and no `deny_in_key_mode`: this command talks to node,
    # not to the dashboard, so it works logged out and under an API key alike.

    def _paste_prompt() -> None:
        output.hint("paste the policy source, then press Ctrl-D")

    try:
        text = read_source(source, prompt=_paste_prompt)
    except RefUsageError as exc:
        raise click.UsageError(str(exc))
    except RefError as exc:
        raise ApiError(str(exc))
    if not text.strip():
        raise ApiError("policy source is empty — nothing to test")

    # Checked before the syntax check runs, so a bad --expect reports itself
    # rather than being masked by whatever node says about the file. A usage
    # error should never depend on the content of an argument.
    if expect is not None and expect not in ("allow", "deny", "instruct"):
        raise typer.BadParameter(
            f"invalid --expect value {expect!r}; choose one of allow, deny, instruct"
        )

    syn = check_syntax(text)
    if not syn.ok:
        if output.is_json():
            output.emit_json({"ok": False, "syntax": syn.to_dict(), "policies": []})
            raise typer.Exit(1)
        raise ApiError(f"the policy is not parseable JavaScript:\n{syn.message}")

    run = run_policy(text, tool=tool, command=command, file_path=file_path, event=event)

    # A policy that correctly denies is a SUCCESSFUL test, so the decision does
    # not set the exit code on its own — otherwise `policies test` would fail
    # whenever the policy worked. `--expect` is how CI asserts instead: it turns
    # "what did it decide" into "did it decide what I meant".
    met = expect is None or run.decision == expect
    if output.is_json():
        output.emit_json({**run.to_dict(), "syntax": syn.to_dict(),
                          "expected": expect, "met": met})
        raise typer.Exit(0 if (run.ok and met) else 1)
    if not run.ok:
        raise ApiError(run.error)
    output.render_policy_test(run, tool=tool, command=command, file_path=file_path,
                              expected=expect)
    if not met:
        raise typer.Exit(1)


def policies_compose(
    ctx: typer.Context,
    prompt: str = typer.Argument(..., help="What the policy should do, in plain English."),
    out: Optional[str] = typer.Option(None, "--out", help="Write the draft to this file."),
    publish_as: Optional[str] = typer.Option(
        None, "--publish", help="Publish the draft immediately under this policy id."
    ),
) -> None:
    """Draft a policy from a description, using the Cloud assistant.

    The assistant writes the source; **you** decide whether it ships. By default
    the draft is printed and nothing else happens — a generated policy that
    deploys itself is a generated policy nobody read.

    `--out` saves it; `--publish <id>` publishes it, still syntax-checked first.
    Needs `policies:write` — for the draft as well as the publish. The route is
    `POST /api/agent/compose-policy`, which the dashboard exports as
    `withAuth("policies:write", …)`; `agent:use` gates the assistant's other
    routes (chat, answer, conversations) and is NOT checked on this one. So a
    role holding only `agent:use` is refused here, and one holding
    `policies:write` without it works. Session-only.

    With `--json`: `{prompt, source, syntax, published}`.

    Examples:

    * `fp policies compose "block force pushes to main"`
    * `fp policies compose "deny reading .env" --out env.mjs`
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies compose", _KEY_MODE_REASON)
    cctx = require_auth(state)

    with output.thinking("drafting…", enabled=not output.is_json()):
        res = api.compose_policy(cctx, prompt)
    source = (res or {}).get("source") or (res or {}).get("policy") or ""
    if not source.strip():
        raise ApiError(
            "the assistant returned no policy source",
            hint="check `fp agent health` — the assistant may not be configured here",
        )

    syn = check_syntax(source)

    # Saved BEFORE anything that can fail. `--out` used to run after the
    # publish, so a publish that was refused — bad syntax, no `policies:write`,
    # a network blip — threw away the draft the user had just paid an assistant
    # to write, with no way to get that same text back.
    if out:
        try:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(source)
        except OSError as exc:
            raise ApiError(f"cannot write {out}: {exc.strerror or exc}")

    published = None
    if publish_as:
        if not syn.ok:
            raise ApiError(
                f"the drafted policy is not parseable JavaScript — refusing to publish:\n"
                f"{syn.message}",
                hint=("fix it and publish it with `fp policies publish`"
                      if out else "save it with --out, fix it, then publish"),
            )
        published = api.publish_policy(cctx, publish_as, source, f"drafted: {prompt}"[:500])

    if output.is_json():
        output.emit_json({
            "prompt": prompt, "source": source, "syntax": syn.to_dict(),
            "published": published.to_dict() if published else None,
            "savedTo": out,
        })
        return
    output.render_composed_policy(prompt, source, syn, saved_to=out)
    if published:
        output.policy_published_brief(published)


def register(app: typer.Typer) -> None:
    policies_app = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="Write and manage cloud-managed policies (list / show / publish / enable / disable / delete).",
    )
    policies_app.command("list", epilog=GLOBALS_EPILOG)(policies_list)
    policies_app.command("show", epilog=GLOBALS_EPILOG)(policies_show)
    policies_app.command("publish", epilog=GLOBALS_EPILOG)(policies_publish)
    policies_app.command("enable", epilog=GLOBALS_EPILOG)(policies_enable)
    policies_app.command("disable", epilog=GLOBALS_EPILOG)(policies_disable)
    policies_app.command("delete", epilog=GLOBALS_EPILOG)(policies_delete)
    policies_app.command("test", epilog=GLOBALS_EPILOG)(policies_test)
    policies_app.command("compose", epilog=GLOBALS_EPILOG)(policies_compose)
    app.add_typer(policies_app, name="policies")
