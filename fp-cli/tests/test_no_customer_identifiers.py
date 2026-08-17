"""This package is PUBLIC and its wheel is published to PyPI.

A real customer's tenant slug and company name reached this tree once, in a source
comment that shipped in the wheel and in four test files. It came across in a bulk
copy out of a private monorepo, where naming a live tenant in a fixture was harmless.

Fixtures must use obviously-fake names. This is the tripwire.
"""

from __future__ import annotations

import pathlib
import re

import fp_cli

PKG = pathlib.Path(fp_cli.__file__).resolve().parent
ROOT = PKG.parent

# Names of real organisations that have appeared, or could plausibly be pasted in
# from an internal fixture, a support ticket or a screenshot. Lowercase.
FORBIDDEN = {
    "testsigma",
    "exosphere",
    "exospherehost",
}

# The vocabulary fixtures are supposed to use.
SANCTIONED_FIXTURE_ORGS = {"acme", "globex", "example", "initech", "umbrella"}


def _sources() -> list[pathlib.Path]:
    out = []
    for base in (PKG, ROOT / "tests"):
        out.extend(p for p in base.rglob("*.py") if "__pycache__" not in p.parts)
    for name in ("README.md", "CHANGELOG.md"):
        p = ROOT / name
        if p.is_file():
            out.append(p)
    for p in (ROOT / "skill").rglob("*"):
        if p.is_file() and p.suffix in {".md", ".yaml", ".yml"}:
            out.append(p)
    return out


def test_no_real_customer_or_vendor_identifiers():
    hits = []
    for p in _sources():
        if p.name == pathlib.Path(__file__).name:
            continue
        text = p.read_text(encoding="utf-8", errors="replace").lower()
        for needle in FORBIDDEN:
            if needle in text:
                for i, line in enumerate(text.split("\n"), 1):
                    if needle in line:
                        hits.append(f"{p.relative_to(ROOT)}:{i}: {needle}")
    assert not hits, (
        "real organisation names must not appear in a public package — use a fixture "
        f"name such as {sorted(SANCTIONED_FIXTURE_ORGS)}:\n  " + "\n  ".join(hits)
    )


def test_the_scan_actually_has_files_to_scan():
    """Keeps the assertion above from passing vacuously if the layout moves."""
    files = _sources()
    assert len(files) > 40, f"only {len(files)} files scanned — the walk is not finding the package"


def test_no_internal_hostnames_leaked():
    """A customer's deployment hostname identifies them as surely as their name."""
    pattern = re.compile(r"https?://[a-z0-9.-]*\.(?:testsigma|exosphere)\.[a-z]+", re.I)
    hits = []
    for p in _sources():
        if p.name == pathlib.Path(__file__).name:
            continue
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            if pattern.search(line):
                hits.append(f"{p.relative_to(ROOT)}:{i}")
    assert not hits, f"internal/customer hostnames in a public package: {hits}"
