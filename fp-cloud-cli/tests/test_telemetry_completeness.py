"""Anti-drift guard: every command and flag must be tracked by telemetry.

Introspects the assembled Typer/Click app and asserts the derived telemetry catalog
covers every command, every leaf subcommand, and every option token. This fails the
moment a new command or flag is added without being trackable — so usage signal can
never silently go missing and a flag VALUE can never leak (a flag must be allowlisted
by name to be emitted at all).
"""

from __future__ import annotations

import pytest
from typer.main import get_command

from fp_cli import _click_compat as click  # the Click Typer is running
from fp_cli import analytics
from fp_cli import analytics_registry as reg
from fp_cli.app import app


def _leaf_commands():
    """Yield (path_tuple, click.Command) for every leaf command in the app."""
    cli = get_command(app)

    def walk(cmd, prefix):
        subs = getattr(cmd, "commands", None)
        if subs:
            for name, sub in subs.items():
                yield from walk(sub, prefix + (name,))
        else:
            yield prefix, cmd

    yield from walk(cli, ())


def _all_option_tokens():
    cli = get_command(app)
    tokens = set()

    def walk(cmd):
        for p in getattr(cmd, "params", []):
            if click.is_option(p):
                tokens.update(p.opts)
                tokens.update(p.secondary_opts)
        for sub in (getattr(cmd, "commands", None) or {}).values():
            walk(sub)

    walk(cli)
    return tokens


def test_every_command_is_known():
    known, leaves, _flags, _vf = reg.build()
    missing = []
    for path, _cmd in _leaf_commands():
        group = path[0]
        if group not in known:
            missing.append(group)
        if len(path) >= 2 and path[1] not in leaves.get(group, frozenset()):
            missing.append(" ".join(path))
    assert not missing, f"commands not tracked by telemetry catalog: {sorted(set(missing))}"


def test_every_option_is_tracked():
    _known, _leaves, flags, _vf = reg.build()
    untracked = sorted(t for t in _all_option_tokens() if t not in flags)
    assert not untracked, f"option flags missing from telemetry catalog: {untracked}"


def test_resolve_command_path_for_nested_groups():
    # A nested invocation resolves to (group, leaf) using only static catalog names.
    assert analytics._resolve_command_path(["--json", "orgs", "list"]) == ("orgs", "list")
    assert analytics._resolve_command_path(["orgs", "switch", "acme"]) == ("orgs", "switch")
    assert analytics._resolve_command_path(["--org", "acme", "agent", "show", "s1"]) == ("agent", "show")
    assert analytics._resolve_command_path(["whoami"]) == ("whoami", None)


def test_sanitize_flags_never_emits_values_for_any_command():
    # For every leaf command, feed its own option tokens with fake values and assert
    # the sanitised output contains only known flag names (never the values).
    _known, _leaves, flags, _vf = reg.build()
    for path, cmd in _leaf_commands():
        argv = list(path)
        for p in getattr(cmd, "params", []):
            if click.is_option(p) and p.opts:
                argv += [p.opts[0], "SECRET-VALUE"]
        emitted = analytics._sanitize_flags(argv)
        assert "SECRET-VALUE" not in emitted
        for f in emitted:
            assert f in set(flags.values()), f"{f} not a canonical flag name"
