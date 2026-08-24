#!/usr/bin/env python3
"""Print one version's section out of a CHANGELOG, for a GitHub Release body.

    changelog-section.py <changelog> <version>

Both PyPI publish workflows call this from `preflight` — BEFORE anything is built
and long before anything is uploaded — so a release with no notes fails at the one
point in the pipeline where failing is free. It cannot be fixed afterwards: PyPI
never releases a version for reuse, so "publish it again, with notes this time" is
not an available remedy, and the GitHub Release would stand empty against a
version that is permanently on the index.

The heading grammar is the one CLAUDE.md fixes for the root changelog and which
the per-package files follow:

    ## 0.0.1b1 — 2026-08-24

The date is not parsed; only the version is matched, and it is matched with a
trailing word boundary so a request for `0.0.1b1` cannot be answered by
`0.0.1b10`'s section — which is a real hazard once a beta counter passes nine,
and one that would put the WRONG release's notes on a tag with no error anywhere.

Stdlib only, same reason as `python-version.py`: it runs in the job that holds no
publishing identity precisely because it installs nothing.
"""

from __future__ import annotations

import re
import sys


class SectionError(Exception):
    """A message a maintainer can act on, printed without a traceback."""


def extract(text: str, version: str) -> str:
    """The body under `## <version>`, up to the next `## ` heading."""
    heading = re.compile(rf"^##[ \t]+{re.escape(version)}\b.*$", re.MULTILINE)
    match = heading.search(text)
    if not match:
        raise SectionError(
            f"no '## {version}' section — add one before releasing, or the tag "
            f"gets a release with nothing in it"
        )

    rest = text[match.end():]
    nxt = re.search(r"^##[ \t]", rest, re.MULTILINE)
    body = (rest[: nxt.start()] if nxt else rest).strip()

    if not body:
        # A heading with nothing under it is the same failure as no heading at
        # all, and is what you get from stamping a version onto an empty section.
        raise SectionError(f"the '## {version}' section is empty")
    return body


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__ or "", file=sys.stderr)
        return 2
    path, version = argv[1], argv[2]
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise SectionError(f"cannot read {path}: {exc}") from exc
    print(extract(text, version))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except SectionError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
