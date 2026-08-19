"""The CLI writes into a home another component owns, so both halves must agree.

`~/.failproofai/` is a governed layout. `src/hooks/fp-home.ts` is its register —
"nothing outside this file may join a path onto the failproofai home" — and
`resettablePaths()` is a *filter over* `HOME_CLASSES`, so what protects the
CLI's credential from a reset is its entry in that table, not the fact that the
file happens to exist.

Until this file existed, nothing checked that the two sides agreed. `config.py`
said so itself, in a comment above `FPCLI_SUBDIR`: *"Mirrors ``fpcliDir`` in
``src/hooks/fp-home.ts`` — change one, change the other; nothing checks."*
Verified by experiment: renaming `fpcliDir` to `fp-cli` in the TypeScript and
leaving Python alone left 53 TS tests and 59 Python tests all passing, with the
register describing a directory nothing writes and the real credential sitting
at a path the register had never heard of.

That is the same shape as the SDK's `tests/test_spool_contract.py` next door,
which reads the Rust and the TypeScript that define its spool root. This is the
CLI's version of it.

The assertions run against source text rather than a running Node, because
requiring a toolchain to test a Python package would mean this skips in every
environment that matters and guards nothing — the failure mode the SDK's own
contract test had for its whole life before it moved into this repo.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from fp_cli import config as cfg

# tests/ -> fp-cli/ -> repo root.
#
# Guarded: `parents[2]` raises IndexError on a shallower tree, and a shallower
# tree is exactly the packaged-sdist case `_read_source` below handles. Raising
# here would be a COLLECTION error, which aborts the whole suite instead of
# skipping the one file that needs the repository.
_HERE = Path(__file__).resolve()
REPO_ROOT = _HERE.parents[2] if len(_HERE.parents) > 2 else _HERE.parent
FP_HOME_TS = REPO_ROOT / "src" / "hooks" / "fp-home.ts"

#: Set by CI. Turns "the source I read is missing" from a skip into a failure.
REQUIRE = os.environ.get("FP_CLI_REQUIRE_CONTRACT", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _read_source() -> str:
    """`fp-home.ts`, or skip/fail depending on ``REQUIRE``.

    Missing means one of two things: this is an installed sdist (fine — there is
    no repo to read), or the file moved (not fine). ``REQUIRE`` distinguishes
    them, because from in here they look identical.
    """
    if FP_HOME_TS.is_file():
        return FP_HOME_TS.read_text(encoding="utf-8")
    message = (
        f"{FP_HOME_TS} is missing. In a packaged sdist that is expected. In the "
        "repository it means the layout register moved, and this contract is now "
        "unguarded — re-point this test at the new location rather than deleting it."
    )
    if REQUIRE:
        pytest.fail(message)
    pytest.skip(message)


def _declared(pattern: str, source: str, what: str) -> str:
    """The single capture of `pattern`, failing loudly if it matched 0 or 2+.

    A regex over source that quietly matches nothing is worse than no test: it
    passes forever while checking a file that has been rewritten around it.
    """
    matches = re.findall(pattern, source)
    assert len(matches) == 1, (
        f"expected exactly one declaration of {what} in fp-home.ts, found "
        f"{len(matches)}. The register was restructured; re-anchor this test "
        f"rather than loosening the pattern."
    )
    return matches[0]


# ─────────────────────────────────────────────────────────────────────────────
# The paths themselves
# ─────────────────────────────────────────────────────────────────────────────


def test_the_subdirectory_name_agrees():
    """`fpcliDir` in TypeScript vs `FPCLI_SUBDIR` here."""
    source = _read_source()
    declared = _declared(
        r'export const fpcliDir = \(home\?: string\) => atHome\(home, "([^"]+)"\)',
        source,
        "fpcliDir",
    )
    assert declared == cfg.FPCLI_SUBDIR, (
        f"fp-home.ts registers the CLI directory as {declared!r} and this package "
        f"writes {cfg.FPCLI_SUBDIR!r}. The credential would sit at a path the "
        f"layout register has never heard of, so nothing protects it from a reset "
        f"the moment somebody classifies its parent."
    )


def test_the_credential_filename_agrees():
    source = _read_source()
    declared = _declared(
        r'export const fpcliAuthFile = \(home\?: string\) => resolve\(fpcliDir\(home\), "([^"]+)"\)',
        source,
        "fpcliAuthFile",
    )
    assert declared == cfg.config_path().name


def test_the_home_directory_name_agrees():
    """Both sides hardcode `.failproofai`; neither imports it from the other."""
    source = _read_source()
    declared = _declared(
        r'return process\.env\.FAILPROOFAI_HOME \|\| resolve\(homedir\(\), "([^"]+)"\)',
        source,
        "the failproofai home",
    )
    home = cfg.base_dir().parent.name
    assert declared == home, f"fp-home.ts says {declared!r}, this package writes {home!r}"


def test_the_shared_home_override_variable_agrees():
    """`FAILPROOFAI_HOME` relocates the whole layout; the CLI must follow it."""
    source = _read_source()
    assert "process.env.FAILPROOFAI_HOME" in source
    assert "FAILPROOFAI_HOME" in Path(cfg.__file__).read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# The classification — what actually keeps a reset off the credential
# ─────────────────────────────────────────────────────────────────────────────


def test_the_credential_is_registered_as_user_typed():
    """This entry, not the file's existence, is what survives `resettablePaths()`.

    `resettablePaths()` filters `HOME_CLASSES`, so an unregistered path survives
    only by accident — and only until someone lists its parent. `user-typed` is
    the class that says "a person typed this; nothing regenerates it", which is
    exactly a login.
    """
    source = _read_source()
    assert re.search(r"\{\s*path:\s*fpcliAuthFile,\s*class:\s*\"user-typed\"\s*\}", source), (
        "fpcliAuthFile is no longer classified `user-typed` in HOME_CLASSES. A "
        "reset walks that table; the CLI's session is not regenerable and must "
        "never be on the delete list."
    )


def test_the_directory_itself_is_deliberately_unclassified():
    """`auditDir`'s rule: classify the children, never the parent.

    A `user-typed` parent would protect a cache added later; a `derived` parent
    would delete the session beside it.
    """
    source = _read_source()
    assert not re.search(r"\{\s*path:\s*fpcliDir,\s*class:", source), (
        "fpcliDir is now classified as a whole. If the directory has grown a "
        "second file, classify that file — one class cannot be right for a "
        "credential and a cache at once."
    )


# ─────────────────────────────────────────────────────────────────────────────
# The anchors, so none of the above can pass vacuously
# ─────────────────────────────────────────────────────────────────────────────


def test_the_register_still_contains_what_these_patterns_anchor_on():
    """Every regex above reads source text, and source text gets rewritten.

    If `fp-home.ts` is restructured so the patterns stop matching, the tests
    above fail loudly via `_declared`. This one covers the rest of the file:
    the names must still be exported and still be mentioned in the class table.
    """
    source = _read_source()
    for anchor in (
        "export const fpcliDir",
        "export const fpcliAuthFile",
        "export const HOME_CLASSES",
        "fpcliAuthFile, class:",
    ):
        assert anchor in source, f"fp-home.ts no longer contains {anchor!r}"


def test_this_file_can_be_imported_outside_the_repository():
    """A collection error here would abort the whole CLI suite, not just this file."""
    assert REPO_ROOT.is_absolute()
