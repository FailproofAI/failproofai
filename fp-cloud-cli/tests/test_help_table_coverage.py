"""The top-level help screen is a HAND-MAINTAINED table, not Click's command tree.

`output.render_top_level_help` renders `_TOP_LEVEL_GROUPS`, a literal list. A command
registered on the Typer app but missing from that list works perfectly and is invisible
in `fp help` forever — there is no error, no warning, and no other test that looks.

These tests close that gap in both directions, and additionally assert the help text
carries the current command name, which is the thing a rename silently leaves stale
(Click derives its own `Usage:` line from argv[0], so the auto-generated half updates
itself and the hand-written half does not).
"""

from __future__ import annotations

import re

from typer.main import get_command

from fp_cli import output
from fp_cli.app import app


def _registered_commands() -> set[str]:
    """Every command name Click actually knows about."""
    cmd = get_command(app)
    return set(cmd.commands)  # type: ignore[attr-defined]


def _help_table_commands() -> set[str]:
    """Every command name the hand-maintained help table advertises."""
    names = set()
    for _group, entries in output._TOP_LEVEL_GROUPS:
        for entry in entries:
            names.add(entry[0])
    return names


def test_every_registered_command_appears_in_the_help_table():
    missing = _registered_commands() - _help_table_commands()
    assert not missing, (
        f"these commands are registered but absent from output._TOP_LEVEL_GROUPS, so "
        f"`fp help` will never mention them: {sorted(missing)}"
    )


def test_the_help_table_never_advertises_a_command_that_does_not_exist():
    extra = _help_table_commands() - _registered_commands()
    assert not extra, (
        f"output._TOP_LEVEL_GROUPS advertises commands that are not registered — "
        f"`fp <name>` would be a usage error: {sorted(extra)}"
    )


def test_the_help_table_is_not_empty():
    """Guards the assertions above from passing vacuously if the structure changes."""
    assert len(_help_table_commands()) >= 15


def test_help_chrome_carries_no_retired_product_name():
    """A rename updates Click's generated usage for free and the prose not at all."""
    rendered = "\n".join(
        str(entry) for _group, entries in output._TOP_LEVEL_GROUPS for entry in entries
    )
    examples = "\n".join(f"{cmd} {why}" for cmd, why in output._TOP_LEVEL_EXAMPLES)
    haystack = f"{rendered}\n{examples}".lower()
    assert "agenteye" not in haystack, "retired product name still present in help chrome"


def test_the_help_examples_use_the_current_command_name():
    cmds = [cmd for cmd, _why in output._TOP_LEVEL_EXAMPLES]
    assert cmds, "no examples to check"
    assert all(c.startswith("fp ") for c in cmds), (
        f"help examples must invoke `fp`: {[c for c in cmds if not c.startswith('fp ')]}"
    )


def test_no_module_advertises_the_retired_env_var_namespace():
    """`FP_*` is this CLI's namespace. `AGENTEYE_*` names that remain must be explicit
    references to OTHER components (the collector's ingest key, the dashboard's admin
    key, the SDK/collector spool dir) and never something this CLI reads."""
    import pathlib

    pkg = pathlib.Path(output.__file__).resolve().parent
    allowed = {"AGENTEYE_KEY", "AGENTEYE_API_KEY", "AGENTEYE_HOME"}
    found = set()
    for mod in pkg.rglob("*.py"):
        for m in re.finditer(r"AGENTEYE" + r"_[A-Z_]+", mod.read_text()):
            found.add(m.group(0))
    assert found <= allowed, (
        f"these retired env vars are still referenced in the package: {sorted(found - allowed)}"
    )


def test_every_subcommand_the_hint_column_advertises_actually_exists():
    """The THIRD element of each row was never checked against anything.

    `_help_table_commands()` reads `entry[0]` only, so the ten standalone leaves
    and the thirteen group names were guarded in both directions and every
    advertised SUBCOMMAND was not. `issues` listed a bare `comment`, which is not
    a command — the group exposes `comment-add`, `comment-list` and
    `comment-delete` — so `fp help` told users to run something that exits 2 with
    "No such command 'comment'".

    A `*` suffix is a deliberate wildcard (`comment-*`, `context-*`); a leading
    `-` is a flag, not a subcommand. Everything else must be real.
    """
    cmd = get_command(app)
    bad = []
    for _group, entries in output._TOP_LEVEL_GROUPS:
        for entry in entries:
            name, hint = entry[0], (entry[2] if len(entry) > 2 else "")
            group = cmd.commands.get(name)  # type: ignore[attr-defined]
            subcommands = set(getattr(group, "commands", {}) or {})
            if not subcommands:
                continue  # a standalone leaf; its hint is prose, not a command list
            for token in hint.split():
                if token.startswith("-"):
                    continue
                if token.endswith("*"):
                    prefix = token[:-1]
                    if not any(sub.startswith(prefix) for sub in subcommands):
                        bad.append(f"{name}: '{token}' matches no subcommand")
                    continue
                if token not in subcommands:
                    bad.append(f"{name}: '{token}' is not a subcommand of `fp {name}`")

    assert not bad, "the help screen advertises commands that do not exist:\n  " + "\n  ".join(bad)
