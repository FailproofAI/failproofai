"""Shared output and auth for the additive Cloud command surface."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .. import _click_compat as click
from .. import output
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


def emit(state, data: Any, title: str) -> None:
    if state is not None and state.json:
        output.emit_json(data)
        return
    if isinstance(data, list) and all(isinstance(r, dict) for r in data):
        columns = list(dict.fromkeys(k for row in data for k in row))
        output.print_table(columns, [[cell(r.get(k)) for k in columns] for r in data], title=title)
    elif isinstance(data, dict):
        output.print_table(["Field", "Value"], [[k, cell(v)] for k, v in data.items()], title=title)
    else:
        output.print_table(["Value"], [[cell(data)]], title=title)


def cell(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)


def write_file(path: str, text: str) -> None:
    try:
        # Exclusive creation: never silently replace a user's source or export.
        with Path(path).open("x", encoding="utf-8") as dest:
            dest.write(text)
    except OSError as exc:
        raise click.BadParameter(f"cannot write '{path}': {exc}", param_hint="--out") from exc
