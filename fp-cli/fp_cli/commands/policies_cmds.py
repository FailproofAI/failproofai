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
from .. import output
from .._context import GLOBALS_EPILOG, AppState, deny_in_key_mode, require_auth
from ..enforcement import RefError, read_source
from ..errors import ApiError, NotFoundError
from . import _write

#: Every command here is session-only. These endpoints are ROOT-ONLY on the
#: server — deliberately absent from `/v1`, because `/v1` is internet-facing and
#: publish/deploy/rollback are operator writes. Failing here beats translating a
#: path that would 404 with no explanation.
_KEY_MODE_REASON = (
    "cloud-managed policies are an operator surface and are not exposed on the "
    "versioned API an key authenticates against"
)


def policies_list(ctx: typer.Context) -> None:
    """List published policies — newest version of each, and its state.

    Shows `policy · version · state · description`. `state` is active, disabled
    (kept but not enforced) or archived (deleted; machines already carrying it
    keep it until redeployed). Needs `policies:read`. With `--json`: the server's
    policy list verbatim.

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
    match = next((p for p in api.list_policies(cctx) if p.id == policy_id), None)
    if match is None:
        raise NotFoundError(f"no policy named {policy_id}")
    if output.is_json():
        output.emit_json(match.to_dict())
        return
    output.render_policy_published(match)
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
) -> None:
    """Publish a policy — mints a NEW VERSION; it never edits one in place.

    Source can come from a path, `@path`, a pipe, `-`, or an interactive paste
    when you give none and stdin is a terminal.

    **Publishing deploys nothing.** A new version sits unused until
    `fp fleet deploy` puts it on a machine. Needs `policies:write`.
    With `--json`: the created version `{id, version, sha256, ...}`.

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
    except RefError as exc:
        raise ApiError(str(exc))
    if not text.strip():
        raise ApiError("policy source is empty — nothing to publish")

    created = api.publish_policy(cctx, policy_id, text, description)
    if output.is_json():
        output.emit_json(created.to_dict())
        return
    output.render_policy_published(created, deployed_to=1)


def policies_enable(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
) -> None:
    """Re-enable a disabled policy. Needs `policies:write`."""
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies enable", _KEY_MODE_REASON)
    cctx = require_auth(state)
    res = api.set_policy_enabled(cctx, policy_id, True)
    if output.is_json():
        output.emit_json(res)
        return
    output.success(f"enabled {policy_id}")


def policies_disable(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Disable a policy — machines stop enforcing it, the versions are kept.

    Reversible with `policies enable`. Needs `policies:write`.
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies disable", _KEY_MODE_REASON)
    cctx = require_auth(state)
    _write.confirm(state, f"disable {policy_id} — machines stop enforcing it",
                   assume_yes=yes)
    res = api.set_policy_enabled(cctx, policy_id, False)
    if output.is_json():
        output.emit_json(res)
        return
    output.success(f"disabled {policy_id}")


def policies_delete(
    ctx: typer.Context,
    policy_id: str = typer.Argument(..., help="Policy id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
) -> None:
    """Archive a policy. This cannot be undone from the CLI.

    Archiving hides it from `policies list` and from future deployments. A
    machine already carrying it keeps enforcing it until something redeploys —
    deleting is not a way to stop enforcement everywhere, and `disable` is.

    Needs `policies:write`.
    """
    state: AppState = ctx.obj
    deny_in_key_mode(state, "policies delete", _KEY_MODE_REASON)
    cctx = require_auth(state)
    _write.confirm(
        state,
        f"archive {policy_id} — machines already carrying it keep enforcing until "
        "redeployed, and `fp policies disable` is what stops enforcement",
        assume_yes=yes,
        destructive=True,
    )
    res = api.delete_policy(cctx, policy_id)
    if output.is_json():
        output.emit_json(res)
        return
    output.success(f"archived {policy_id}")


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
    app.add_typer(policies_app, name="policies")
