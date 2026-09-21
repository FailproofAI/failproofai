"""Incident triage: incidents list/count/show/ack/assign/resolve/close/archive/clear/comment*/subscribe*/open.

Incidents live under /api/issues but the triage workflow is distinct, so it
gets its own top-level group. The id IS the handle (incidents have no human name), so the
action commands take it directly; the boxed views show a short id + the alert label.
"""

from __future__ import annotations

import re
from typing import List, Optional

import typer

from .. import client as api
from .. import output
from .._context import GLOBALS_EPILOG, AppState, require_auth, validate_limit
from ..errors import ApiError, ForbiddenError, NotFoundError
from . import _write

_SEVERITIES = ("info", "warning", "critical")
# Mirrors `issue_sync::ISSUE_STATES` on the server. `closed` is the second
# TERMINAL state (won't-fix); missing it here would reject `--state closed`
# client-side with exit 2 for a state the server accepts.
_STATES = ("firing", "acknowledged", "resolved", "closed")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _validate_states(value: Optional[str]) -> None:
    """Reject an unknown ``--state`` value up front (exit 2) rather than letting the server
    silently drop it and return a confusing set. Accepts a CSV of firing/acknowledged/resolved/closed."""
    if value is None:
        return
    for s in value.split(","):
        s = s.strip()
        if s and s not in _STATES:
            raise typer.BadParameter(
                f"'{s}' is not a valid state. Choose from: {', '.join(_STATES)} (CSV).",
                param_hint="--state",
            )


def _fail(state: AppState, exc: Exception, *, incident_id: str = "") -> None:
    """Re-raise as a typed error for the central chokepoint to render (JSON envelope under
    ``--json`` on stdout, red box otherwise). A 404 — or a **malformed (non-UUID) id**, which the
    server's path extractor answers with a 400 rather than a 404 — becomes the friendlier
    ``no issue <id>`` (exit 6); every other ApiError/ForbiddenError keeps the server's message
    and exit code."""
    # EXACTLY 400, not a range. This read `>= 500` on the belief that the server answers a
    # malformed id with a 500, and it does not: axum's path extractor rejects it at 400 with a
    # plain-text body, which the dashboard turns into the generic "upstream returned non-JSON
    # response". So the remap never fired — `fp issues show not-a-uuid` exited 1 carrying that
    # internal phrase while `fp audits show not-a-uuid` exited 6 with a usable message, and
    # anything branching on exit 6 to mean not-found silently took the wrong arm.
    #
    # `>= 400` is the obvious fix and it is WRONG, which is why this is spelled out. Issue ids
    # are not required to be UUIDs — `fp issues assign i1 --assignee ...` is a documented call —
    # so a non-UUID id reaches real handlers and collects real 4xx answers. A 422 "a@x.com is
    # not an operator" would then be rewritten as "no issue i1", replacing the one sentence that
    # explains the failure with a claim that is false. Only 400 means "the router refused to
    # parse this id"; every other 4xx got past the extractor and has something to say.
    status = getattr(exc, "status", None) or 0
    malformed = bool(incident_id) and not _UUID_RE.match(incident_id) and status == 400
    if incident_id and (malformed or isinstance(exc, NotFoundError)):
        raise NotFoundError(
            f"no issue {incident_id}", hint="run `fp issues list` to see open issues"
        )
    raise exc


def incidents_list(
    ctx: typer.Context,
    state_filter: Optional[str] = typer.Option(None, "--state", help="Filter by state(s): firing, acknowledged, resolved, closed (CSV)."),
    alert_id: Optional[str] = typer.Option(None, "--alert-id", help="Only incidents for this alert."),
    limit: int = typer.Option(50, "--limit", "-n", help="Max incidents to return."),
    show_id: bool = typer.Option(False, "--show-id", help="Show the full incident id instead of the short form (always full in --json)."),
) -> None:
    """List incidents in a boxed table (newest-opened first).

    Shows `id · title · source · severity · state · opened · assignees` — the id is the handle the
    action commands take (short by default, full with `--show-id`); `title` is the issue's own
    identifying line (every issue has one, unlike `alert_name`); `source` is where it came from
    (`manual`/`alert`/`audit`) and trails the alert name when there is one; severity is
    colour-coded, state as `● firing`/`● acknowledged`/`○ resolved`, `opened` the compact age.
    A footer breaks down the state distribution. Needs `issues:read`. With `--json`:
    `{"issues": [{id, title, source, source_finding_id, alert_name, alert_severity, state,
    opened_at, assignees, ...}]}`.

    Example:

    * `fp issues list --state firing`
    """
    state: AppState = ctx.obj
    _validate_states(state_filter)
    validate_limit(limit)
    cctx = require_auth(state)
    incidents = api.list_incidents(cctx, state=state_filter, alert_id=alert_id, limit=limit)
    if state.json:
        output.emit_json({"issues": incidents})
        return
    output.render_incidents(incidents, show_id=show_id)
    output.incidents_footer(incidents)


def incidents_count(
    ctx: typer.Context,
    state_filter: Optional[str] = typer.Option(None, "--state", help="Filter by state(s) (CSV)."),
) -> None:
    """Count incidents (optionally by state) as a compact stat card.

    With no `--state` the server counts the open ones (firing + acknowledged). Needs
    `issues:read`. With `--json`: `{"count": N}`.

    Example:

    * `fp issues count --state firing`
    """
    state: AppState = ctx.obj
    _validate_states(state_filter)
    cctx = require_auth(state)
    count = api.count_incidents(cctx, state=state_filter)
    if state.json:
        output.emit_json({"count": count})
    else:
        output.render_incident_count(count, state=state_filter)


def incidents_show(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
) -> None:
    """Show one incident in full — a stack of cards: identity, comments, subscribers, activity.

    The identity card is headed by the issue's own title and shows severity · state · source ·
    opened, who acknowledged/is assigned, and the breach; empty sections are omitted. Not-found →
    `✗ no incident <short id>`, exit 6. Needs `issues:read`. With `--json`: the full `Incident`
    (including `title`, `source`, `source_finding_id`, and untouched
    comments/subscribers/activity).

    Example:

    * `fp issues show <id>`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        incident = api.get_incident(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    if state.json:
        output.emit_json(incident)
        return
    output.render_incident_show(incident)


def incidents_ack(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
) -> None:
    """Acknowledge an incident (no confirm — it isn't destructive).

    Needs `issues:read` (ack rides on read). With `--json`: `{"acknowledged": true, "id": "<id>"}`.

    Example:

    * `fp issues ack <id>`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        api.ack_incident(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_acked", resource="incident", success=True)
    if state.json:
        output.emit_json({"acknowledged": True, "id": incident_id})
    else:
        output.incident_acked(incident_id)


def incidents_assign(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    assignee: Optional[List[str]] = typer.Option(None, "--assignee", help="Operator email to assign (repeatable; omit to clear all)."),
) -> None:
    """Set an incident's assignees (replaces the list; omit `--assignee` to clear).

    Needs `issues:create`. The server rejects the whole call if any email is not an operator —
    that's surfaced as a clean `✗ <message>`. With `--json`: `{"assignees": [...], "id": "<id>"}`.

    Example:

    * `fp issues assign <id> --assignee a@example.com --assignee b@example.com`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    assignees = assignee or []
    try:
        api.assign_incident(cctx, incident_id, assignees)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_assigned", resource="incident", success=True)
    if state.json:
        output.emit_json({"assignees": assignees, "id": incident_id})
    else:
        output.incident_assigned(incident_id, assignees)


def incidents_resolve(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Resolve (close) an incident, after a calm confirm.

    Needs `issues:close`. With `--json`: `{"resolved": true, "id": "<id>"}` (or `{cancelled: true}`
    on a declined prompt).

    Example:

    * `fp issues resolve <id> --yes`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    if _write.should_prompt(state, yes):
        alert_name = None
        try:
            alert_name = api.get_incident(cctx, incident_id).alert_name
        except NotFoundError as exc:
            _fail(state, exc, incident_id=incident_id)
        except (ApiError, ForbiddenError):
            alert_name = None
        if not output.confirm_incident_resolve(incident_id, alert_name):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing changed")
            return
    try:
        api.resolve_incident(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_resolved", resource="incident", success=True)
    if state.json:
        output.emit_json({"resolved": True, "id": incident_id})
    else:
        output.incident_resolved(incident_id)


def incidents_close(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Issue id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Close an issue — "we're done with it", not "we fixed it".

    The difference from `resolve` is what happens next. A **resolved** issue REOPENS if its
    audit finding recurs: someone claimed a fix and the fix did not hold, which is worth
    knowing. A **closed** issue does not — closing records a decision (won't fix, not a
    problem, stale), and a recurrence is not news about a decision.

    For an issue that came from an audit, this also marks the finding `dismissed`. It does
    NOT write the finding's org-wide suppression: closing one issue never hides that pattern
    in your other audits. Use `fp audits finding-status <id> --action dismiss` for that.

    Needs `issues:close`. Exits 9 (conflict) if the issue already ended — an issue ends once,
    and closing must not overwrite the record that someone believed they had fixed it.

    With `--json`: `{"closed": true, "id": "<id>"}` (or `{cancelled: true}` on a declined
    prompt).

    Example:

    * `fp issues close <id> --yes`
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    if _write.should_prompt(state, yes):
        alert_name = None
        try:
            alert_name = api.get_incident(cctx, incident_id).alert_name
        except NotFoundError as exc:
            _fail(state, exc, incident_id=incident_id)
        except (ApiError, ForbiddenError):
            alert_name = None
        if not output.confirm_incident_close(incident_id, alert_name):
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing changed")
            return
    try:
        api.close_incident(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_closed", resource="incident", success=True)
    if state.json:
        output.emit_json({"closed": True, "id": incident_id})
    else:
        output.incident_closed(incident_id)


def incidents_archive(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Issue id."),
) -> None:
    """Take an issue off the issues board, keeping its history.

    Archiving is separate from state: it does not resolve or close anything, and an issue
    that has already ended keeps the record of HOW it ended. It works on a live issue too —
    you should not have to triage something in order to stop looking at it — because the
    safety net is on the other side: a fresh alert breach or a recurring audit finding puts
    a live issue back on the board automatically. Archive can hide a problem; it cannot keep
    hiding one that is still happening. A closed (won't-fix) issue is the exception and stays
    hidden, since nobody asked for it back.

    No confirmation: archiving destroys nothing and `fp issues unarchive` undoes it.

    Needs `issues:close`. With `--json`: `{"archived": true, "id": "<id>"}`.

    Example:

    * `fp issues archive <id>`
    """
    _set_archived(ctx, incident_id, True)


def incidents_unarchive(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Issue id."),
) -> None:
    """Put an archived issue back on the issues board. See `fp issues archive`.

    Needs `issues:close`. With `--json`: `{"archived": false, "id": "<id>"}`.

    Example:

    * `fp issues unarchive <id>`
    """
    _set_archived(ctx, incident_id, False)


def _set_archived(ctx: typer.Context, incident_id: str, archived: bool) -> None:
    """Shared body of archive/unarchive. Two commands rather than one with a flag, so each
    reads as the verb it is and neither can be invoked meaning the opposite."""
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        api.set_incident_archived(cctx, incident_id, archived)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action(
        "incident_archived" if archived else "incident_unarchived",
        resource="incident", success=True,
    )
    if state.json:
        output.emit_json({"archived": archived, "id": incident_id})
    else:
        output.incident_archived(incident_id, archived)


def incidents_clear(
    ctx: typer.Context,
    audit_id: Optional[str] = typer.Option(None, "--audit", help="Clear only the issues this audit raised."),
    all_audits: bool = typer.Option(False, "--all-audits", help="Clear every issue any audit raised. Alert and hand-opened issues are left alone."),
    everything: bool = typer.Option(False, "--everything", help="Clear every open issue in the workspace, whatever opened it."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print what would be cleared and change nothing."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Resolve every open issue in a scope — a fresh start after changing your agents.

    Exactly one of `--audit <id>`, `--all-audits` or `--everything` is required: the three
    have very different blast radii, so there is deliberately no default.

    This is the same thing as resolving each issue by hand, including what it does NOT do.
    **Nothing is deleted, and nothing is suppressed.** A pattern your agent changes genuinely
    fixed stays gone; one they did not opens a NEW issue on the next audit run. If you want a
    pattern silenced for good, that is `fp audits finding-status <id> --action mute`, which is
    a different and much bigger hammer.

    Run it with `--dry-run` first: the count comes from the server and is taken with the same
    scope predicate the write uses, so the number you see is the number of rows that change.

    Needs `issues:close` AND `audits:write` — clearing resolves the audit findings behind the
    issues, so a key that cannot touch one finding cannot resolve all of them at once.

    With `--json`: `{"issues": n, "findings": n, "dry_run": bool, "scope": "..."}` (or
    `{cancelled: true}` on a declined prompt).

    Examples:

    * `fp issues clear --all-audits --dry-run`
    * `fp issues clear --audit <id> --yes`
    """
    state: AppState = ctx.obj
    picked = [bool(audit_id), all_audits, everything]
    if sum(picked) != 1:
        raise typer.BadParameter(
            "choose exactly one of --audit <id>, --all-audits, or --everything.",
            param_hint="--all-audits",
        )
    if audit_id:
        scope, label = "audit", "this audit"
    elif all_audits:
        scope, label = "all_audits", "every audit"
    else:
        scope, label = "everything", "the whole workspace"

    cctx = require_auth(state)

    # The dry run is also the preview behind the prompt, so a `--dry-run` call and a
    # confirmed clear count the same rows the same way.
    try:
        preview = api.clear_issues(cctx, scope=scope, audit_id=audit_id, dry_run=True)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc)
        return
    issues = int(preview.get("issues") or 0)
    findings = int(preview.get("findings") or 0)

    if dry_run:
        if state.json:
            output.emit_json(preview)
        else:
            output.issues_cleared(issues, findings, dry_run=True)
        return

    if issues == 0:
        # Nothing to do is not a failure, and prompting to confirm zero rows is noise.
        if state.json:
            output.emit_json({"issues": 0, "findings": 0, "dry_run": False, "scope": scope})
        else:
            output.issues_cleared(0, 0)
        return

    if _write.should_prompt(state, yes) and not output.confirm_issues_clear(label, issues, findings):
        if state.json:
            output.emit_json({"cancelled": True})
        else:
            output.cancelled_plain("nothing changed")
        return

    try:
        result = api.clear_issues(cctx, scope=scope, audit_id=audit_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc)
        return
    # `mode` and `count` are both on _SAFE_PROP_KEYS, and both are shape: a closed enum we
    # authored and an integer. Never an audit id or an issue title.
    _write.record_action(
        "issues_cleared", resource="incident", success=True, destructive=True,
        mode=scope, count=int(result.get("issues") or 0),
    )
    if state.json:
        output.emit_json(result)
    else:
        output.issues_cleared(int(result.get("issues") or 0), int(result.get("findings") or 0))


def incidents_comment_list(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
) -> None:
    """List an incident's comments in a boxed table.

    Shows `author · when · body` (the body wraps; a deleted comment shows a dim `(deleted)`).
    Needs `issues:read`. With `--json`: `{"comments": [{id, author_email, body, created_at, ...}]}`.
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        comments = api.list_incident_comments(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    if state.json:
        output.emit_json({"comments": comments})
        return
    output.render_incident_comments(comments)


def incidents_comment_add(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    body: Optional[str] = typer.Option(None, "--body", help="Comment text (or use --file/-)."),
    file: Optional[str] = typer.Option(None, "--file", help="Read the comment body from a file, or `-` for stdin."),
) -> None:
    """Add a comment to an incident (rendered as a green "comment added" card).

    Needs `issues:read` (commenting rides on read). Provide exactly one of `--body` or `--file`/stdin. With `--json`: the
    created comment.

    Example:

    * `fp issues comment-add <id> --body "looking into it"`
    """
    state: AppState = ctx.obj
    if (body is None) == (file is None):
        raise typer.BadParameter("Provide exactly one of --body or --file.")
    text = body if body is not None else _write.read_text_arg(file)
    cctx = require_auth(state)
    try:
        comment = api.create_incident_comment(cctx, incident_id, text)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_comment_added", resource="incident", success=True)
    if state.json:
        output.emit_json(comment)
    else:
        output.render_incident_comment_added(comment)


def incidents_comment_delete(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    comment_id: str = typer.Argument(..., help="Comment id."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt. The prompt only appears on an interactive terminal: under --json, or with stdin redirected, this command proceeds without asking."),
) -> None:
    """Delete an incident comment, after an amber preview + confirm.

    Resolves the comment first (so an unknown comment id → `✗ no comment …`, exit 6), previews it,
    then confirms. Needs `issues:read` to delete your own comment, `issues:close` to moderate others'. With `--json`: `{"deleted": true, "id": "<comment_id>"}`
    (or `{cancelled: true}` on a declined prompt).
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        comments = api.list_incident_comments(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    match = next((c for c in comments if c.id == comment_id), None)
    if match is None:
        raise NotFoundError(f"no comment {comment_id}")
    if _write.should_prompt(state, yes):
        output.render_incident_comment_delete_preview(match)
        if not output.confirm_incident_comment_delete():
            if state.json:
                output.emit_json({"cancelled": True})
            else:
                output.cancelled_plain("nothing deleted")
            return
    try:
        api.delete_incident_comment(cctx, incident_id, comment_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_comment_deleted", resource="incident", success=True, destructive=True)
    if state.json:
        output.emit_json({"deleted": True, "id": comment_id})
    else:
        output.incident_comment_deleted()


def incidents_subscribers(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
) -> None:
    """List who is subscribed to an incident in a boxed table.

    Shows `email · source · subscribed`. Needs `issues:read`. With `--json`:
    `{"subscribers": [{email, source, subscribed_at, ...}]}`.
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        subs = api.list_incident_subscribers(cctx, incident_id)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    if state.json:
        output.emit_json({"subscribers": subs})
        return
    output.render_incident_subscribers(subs)


def incidents_subscribe(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    email: Optional[str] = typer.Option(None, "--email", help="Email to subscribe (default: you)."),
) -> None:
    """Subscribe to an incident's notifications.

    With `--json`: `{"subscribed": true, "id": "<id>"}`.
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        api.subscribe_incident(cctx, incident_id, email)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_subscribed", resource="incident", success=True)
    if state.json:
        output.emit_json({"subscribed": True, "id": incident_id})
    else:
        output.incident_subscribed(incident_id, email)


def incidents_unsubscribe(
    ctx: typer.Context,
    incident_id: str = typer.Argument(..., help="Incident id."),
    email: Optional[str] = typer.Option(None, "--email", help="Email to unsubscribe (default: you)."),
) -> None:
    """Unsubscribe from an incident's notifications.

    With `--json`: `{"unsubscribed": true, "id": "<id>"}`.
    """
    state: AppState = ctx.obj
    cctx = require_auth(state)
    try:
        api.unsubscribe_incident(cctx, incident_id, email)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=incident_id)
    _write.record_action("incident_unsubscribed", resource="incident", success=True)
    if state.json:
        output.emit_json({"unsubscribed": True, "id": incident_id})
    else:
        output.incident_unsubscribed(incident_id, email)


def incidents_open(
    ctx: typer.Context,
    summary: str = typer.Option(..., "--summary", help="Short description of the incident."),
    title: Optional[str] = typer.Option(None, "--title", help="Short title. Required unless --alert-id is given."),
    alert_id: Optional[str] = typer.Option(None, "--alert-id", help="Link to an alert (inherits its severity)."),
    severity: Optional[str] = typer.Option(None, "--severity", help=f"Severity for a standalone incident: {', '.join(_SEVERITIES)}."),
) -> None:
    """Open a manual incident (standalone, or linked to an alert) — rendered as a green card.

    Needs `issues:create`. `--title` is required for a standalone incident (there's no parent
    alert whose name it could borrow) and optional with `--alert-id`, where it defaults to the
    alert's name. A missing `--title` or an invalid `--severity` → exit 2. With `--json`:
    `{id, newly_opened, state}`.

    Examples:

    * `fp issues open --title "checkout 500s" --summary "manual page" --severity critical`
    * `fp issues open --alert-id <id> --summary "paging on this again"`
    """
    state: AppState = ctx.obj
    if severity and severity not in _SEVERITIES:
        raise typer.BadParameter(f"severity must be one of: {', '.join(_SEVERITIES)}.")
    if not alert_id and not (title or "").strip():
        raise typer.BadParameter("--title is required for a standalone issue (or pass --alert-id).")
    cctx = require_auth(state)
    try:
        result = api.open_incident(cctx, summary=summary, alert_id=alert_id, severity=severity, title=title)
    except (ApiError, ForbiddenError, NotFoundError) as exc:
        _fail(state, exc, incident_id=alert_id or "")
    _write.record_action("incident_opened", resource="incident", success=True)
    if state.json:
        output.emit_json(result)
        return
    # The open response is minimal ({id, newly_opened, state}); re-fetch the canonical incident
    # for a richer card (its real severity — esp. a linked incident inheriting the alert's).
    inc = None
    try:
        inc = api.get_incident(cctx, str(result.get("id", "")))
    except Exception:
        inc = None
    sev = (inc.alert_severity if inc else None) or severity or ""
    st = (inc.state if inc else None) or str(result.get("state", "") or "")
    # Prefer the server's stored title — on the linked path it may have been
    # defaulted to the alert's name rather than anything we sent.
    hero = (inc.title if inc else None) or str(result.get("title", "") or "") or (title or "")
    output.render_incident_opened(summary=summary, severity=sev, state=st, title=hero)


def register(app: typer.Typer) -> None:
    inc = typer.Typer(
        no_args_is_help=True,
        rich_markup_mode="markdown",
        context_settings={"help_option_names": ["-h", "--help"]},
        help="Triage issues (list / count / show / ack / assign / resolve / close / archive / unarchive / clear / comment-* / subscribe* / open).",
    )
    inc.command("list", epilog=GLOBALS_EPILOG)(incidents_list)
    inc.command("count", epilog=GLOBALS_EPILOG)(incidents_count)
    inc.command("show", epilog=GLOBALS_EPILOG)(incidents_show)
    inc.command("ack", epilog=GLOBALS_EPILOG)(incidents_ack)
    inc.command("assign", epilog=GLOBALS_EPILOG)(incidents_assign)
    inc.command("resolve", epilog=GLOBALS_EPILOG)(incidents_resolve)
    inc.command("close", epilog=GLOBALS_EPILOG)(incidents_close)
    inc.command("archive", epilog=GLOBALS_EPILOG)(incidents_archive)
    inc.command("unarchive", epilog=GLOBALS_EPILOG)(incidents_unarchive)
    inc.command("clear", epilog=GLOBALS_EPILOG)(incidents_clear)
    inc.command("comment-list", epilog=GLOBALS_EPILOG)(incidents_comment_list)
    inc.command("comment-add", epilog=GLOBALS_EPILOG)(incidents_comment_add)
    inc.command("comment-delete", epilog=GLOBALS_EPILOG)(incidents_comment_delete)
    inc.command("subscribers", epilog=GLOBALS_EPILOG)(incidents_subscribers)
    inc.command("subscribe", epilog=GLOBALS_EPILOG)(incidents_subscribe)
    inc.command("unsubscribe", epilog=GLOBALS_EPILOG)(incidents_unsubscribe)
    inc.command("open", epilog=GLOBALS_EPILOG)(incidents_open)
    app.add_typer(inc, name="issues")
