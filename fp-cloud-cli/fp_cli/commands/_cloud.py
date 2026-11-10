"""Shared output and auth for the additive Cloud command surface."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .. import _click_compat as click
from .. import output
from .. import cloud_output
from .._context import deny_in_key_mode
from ..errors import KeyModeUnsupportedError


def session_only(state, command: str) -> None:
    try:
        deny_in_key_mode(state, command, "there is no /v1 route")
    except KeyModeUnsupportedError:
        raise KeyModeUnsupportedError(
            f"`fp {command}` needs a signed-in session: run `fp login`"
        ) from None


def rows(data: Any, key: str) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get(key), list):
        return data[key]
    raise click.UsageError(f"Cloud returned an invalid {key} collection")


def emit(state, data: Any, title: str, **render_options) -> None:
    if state is not None and state.json:
        output.emit_json(data)
        return
    cloud_output.render(data, title, **render_options)


def write_file(path: str, text: str) -> None:
    try:
        # Exclusive creation: never silently replace a user's source or export.
        with Path(path).open("x", encoding="utf-8") as dest:
            dest.write(text)
    except OSError as exc:
        raise click.BadParameter(f"cannot write '{path}': {exc}", param_hint="--out") from exc
