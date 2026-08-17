"""Shared helpers for write/mutation commands (create / update / delete / …).

Centralising these guarantees every domain behaves the same way:
  * request bodies come from discrete flags **or** ``--file``/stdin JSON,
  * mutations confirm before acting but never block a scripted/`--json` run,
  * created/updated resources render identically,
  * each action emits a privacy-safe telemetry event.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import typer

from .. import _click_compat as click  # the Click Typer is running; see _click_compat
from .. import analytics, output
from .._context import AppState
from ..errors import NotFoundError

# Telemetry properties a write action may carry. Names/enums/coarse counts only —
# never ids, emails, names, URLs, SQL, key plaintext, or any customer value.
# A count is named `<thing>_count`, the form the dashboard and the API's own fields
# use, so the same quantity queries as one series across surfaces. Bare `count` is the
# older spelling, kept only so anything still sending it lands rather than vanishing.
_SAFE_PROP_KEYS = frozenset(
    {"success", "resource", "via", "mode", "destructive", "row_count_bucket",
     "permission_count", "url_count", "trigger_kind", "severity_present", "count"}
)


def resolve_one(
    items,
    handle: str,
    *,
    kind: str,
    list_cmd: str,
    key: str = "name",
    ref: str = "named",
    match_id: bool = True,
    plural: Optional[str] = None,
):
    """Find the single ``items`` entry whose ``key`` (or, as a fallback, ``id``) equals ``handle``.

    The one place name/email→object resolution lives, so every command fails identically:
      * exactly one match → return it,
      * none → ``raise NotFoundError`` (exit 6) with a "run `fp <list_cmd>`" hint,
      * several → ``raise click.UsageError`` (exit 2) telling the caller to use the id.

    The single error chokepoint (app.py) renders the raised exception — JSON envelope under
    ``--json`` (stdout), red box otherwise — so callers never branch on ``state.json`` themselves.
    """
    matches = [it for it in items if getattr(it, key, None) == handle]
    if not matches and match_id:
        matches = [it for it in items if str(getattr(it, "id", "")) == handle]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise NotFoundError(
            f'no {kind} {ref} "{handle}"', hint=f"run `fp {list_cmd}` to list them"
        )
    raise click.UsageError(
        f'"{handle}" matches {len(matches)} {plural or kind + "s"} — disambiguate with the id.'
    )


def read_text_arg(path: str, *, flag: str = "--file") -> str:
    """Read a file's text (or stdin when ``path == "-"``), mapping a missing/unreadable
    path to a clean usage error (exit 2) instead of a raw OSError traceback. Shared by
    every ``--file`` / ``@file`` reader so they all fail the same, predictable way."""
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text()
    except OSError as exc:
        raise click.BadParameter(
            f"cannot read '{path}': {exc.strerror or exc}", param_hint=flag
        )


def read_body(
    state: AppState,
    file: Optional[str],
    inline: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Resolve a request body.

    ``--file PATH`` (or ``--file -`` for stdin) JSON wins and must be a JSON object;
    otherwise the discrete-flag ``inline`` dict is used (``None`` values dropped, so a
    partial PATCH/PUT body stays clean). Giving both a populated ``--file`` and discrete
    flags is a usage error.
    """
    cleaned_inline = {k: v for k, v in (inline or {}).items() if v is not None}
    if file is None:
        return cleaned_inline
    raw = read_text_arg(file)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise click.BadParameter(f"--file is not valid JSON: {exc}", param_hint="--file")
    if not isinstance(parsed, dict):
        raise click.BadParameter("--file must contain a JSON object.", param_hint="--file")
    if cleaned_inline:
        raise click.UsageError("Pass either --file or the discrete flags, not both.")
    return parsed


def confirm(state: AppState, action: str, *, assume_yes: bool, destructive: bool = False) -> None:
    """Confirm a mutation, unless it is safe to skip.

    Skips the prompt when ``--yes`` is given, ``--json`` is set, or stdin is not a TTY
    (all mean a script/agent is driving and a blocking prompt would hang). Otherwise
    prompts and aborts (exit 1) on "no".
    """
    if assume_yes or state.json or not sys.stdin.isatty():
        return
    if destructive:
        output.warn(f"This cannot be undone: {action}.")
    typer.confirm(f"{action}?", default=False, abort=True, err=True)


def should_prompt(state: AppState, assume_yes: bool) -> bool:
    """Whether to actually show an interactive confirm. ``False`` (auto-proceed) when ``--yes``
    is given, ``--json`` is set, or stdin is not a TTY — all mean a script/agent is driving and
    a blocking prompt would hang. Lets a caller render a bespoke confirm (e.g. the users-update
    diff prompt) behind the same guard the shared helpers use."""
    return not (assume_yes or state.json or not sys.stdin.isatty())


def confirm_action(
    state: AppState, action: str, target: str, *, consequence: str, assume_yes: bool,
    glyph: str = "⚠", color: Optional[str] = None, title: str = "confirm",
) -> bool:
    """Confirm a named action. Returns ``True`` to proceed, ``False`` if the user declined.

    Proceeds without prompting under :func:`should_prompt`'s conditions. Otherwise shows the
    shared boxed prompt (default NO) via ``output.confirm_prompt`` — amber ⚠ by default
    (destructive), or a caller-supplied glyph/colour (e.g. the calm ACCENT ``↑`` for
    ``users enable``).
    """
    if not should_prompt(state, assume_yes):
        return True
    return output.confirm_prompt(action, target, consequence, glyph=glyph, color=color, title=title)


def confirm_destructive(
    state: AppState, action: str, target: str, *, consequence: str, assume_yes: bool
) -> bool:
    """Confirm a destructive, named action (regenerate / disable / revoke a key) with the shared
    amber ⚠ prompt. Thin wrapper over :func:`confirm_action` with the destructive defaults."""
    return confirm_action(state, action, target, consequence=consequence, assume_yes=assume_yes)


def _to_dict(resource: Any) -> Any:
    if dataclasses.is_dataclass(resource) and not isinstance(resource, type):
        return dataclasses.asdict(resource)
    return resource


def emit_resource(
    state: AppState,
    resource: Any,
    *,
    action: str,
    title: str,
    summary_fields=None,
) -> None:
    """Render the result of a mutation.

    ``--json``: the resource verbatim. Human: a green success line plus a field/value
    table of ``summary_fields`` (or all fields when omitted).
    """
    data = _to_dict(resource)
    if state.json:
        output.emit_json(data)
        return
    output.success(f"{title} {action}.")
    if isinstance(data, dict):
        keys = summary_fields if summary_fields is not None else list(data.keys())
        rows = [[k, _cell(data.get(k))] for k in keys]
        if rows:
            output.print_table(["Field", "Value"], rows)


def _cell(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def record_action(event: str, **props: Any) -> None:
    """Emit a privacy-safe per-action telemetry event (allowlisted properties only)."""
    safe = {k: v for k, v in props.items() if k in _SAFE_PROP_KEYS}
    analytics.capture(event, safe)
