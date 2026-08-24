"""Derive the telemetry command/flag catalog from the assembled Typer app.

Hand-maintained allowlists drift: a new command or flag silently goes untracked
(lost signal) or, worse, leaks a value. Instead we walk the real Click command
tree once and build the catalog from it, so coverage is automatic. The anti-drift
test (`tests/test_telemetry_completeness.py`) asserts this stays exhaustive.

Built lazily and cached — the app module imports ``analytics``, so we cannot import
the app at module load without a cycle. Everything here is read-only introspection.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Dict, FrozenSet, List, Set, Tuple

from . import _click_compat as click  # the Click Typer is running; see _click_compat


def _option_tokens(opt: click.Parameter) -> List[str]:
    return list(opt.opts) + list(opt.secondary_opts)


def _canonical(tokens: List[str]) -> str:
    longs = [t for t in tokens if t.startswith("--")]
    return longs[0] if longs else tokens[0]


def _takes_value(opt: click.Parameter) -> bool:
    """True for options that consume a following token (so we can skip the value)."""
    return not getattr(opt, "is_flag", False) and not getattr(opt, "count", False)


def _walk(
    cmd: click.Command,
    prefix: Tuple[str, ...],
    known: Set[str],
    leaves: Dict[str, Set[str]],
    flags: Dict[str, str],
    value_flags: Set[str],
) -> None:
    for param in getattr(cmd, "params", []):
        # `is_option`, not `isinstance(param, Option)`: Typer's vendored Click has no
        # Option class, so an identity test silently matches nothing and this catalog
        # comes back empty. See `_click_compat`.
        if click.is_option(param):
            tokens = _option_tokens(param)
            if not tokens:
                continue
            canon = _canonical(tokens)
            for tok in tokens:
                flags[tok] = canon
            if _takes_value(param):
                value_flags.update(tokens)
    subcommands = getattr(cmd, "commands", None)
    if subcommands:
        for name, sub in subcommands.items():
            if not prefix:
                known.add(name)  # top-level command or group name
            else:
                leaves.setdefault(prefix[0], set()).add(name)  # nested leaf
            _walk(sub, prefix + (name,), known, leaves, flags, value_flags)


@lru_cache(maxsize=1)
def build() -> Tuple[FrozenSet[str], Dict[str, FrozenSet[str]], Dict[str, str], FrozenSet[str]]:
    """Return ``(known_commands, leaf_registry, flag_aliases, value_flags)``."""
    from typer.main import get_command

    from .app import app  # lazy: avoids the app <-> analytics import cycle

    cli = get_command(app)
    known: Set[str] = set()
    leaves: Dict[str, Set[str]] = {}
    flags: Dict[str, str] = {}
    value_flags: Set[str] = set()
    _walk(cli, (), known, leaves, flags, value_flags)
    return (
        frozenset(known),
        {group: frozenset(subs) for group, subs in leaves.items()},
        dict(flags),
        frozenset(value_flags),
    )
