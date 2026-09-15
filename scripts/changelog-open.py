#!/usr/bin/env python3
"""Open a stub CHANGELOG section for the version a release just moved to.

    changelog-open.py <changelog> <version> <published> [<date>]

The companion to `changelog-section.py`, which REFUSES a release whose version has
no section. Both PyPI publish workflows call this from `bump`, in the same commit
that moves `_version.py`, so the two files can never disagree about which version
`main` is open on.

WHY THIS EXISTS AS AUTOMATION RATHER THAN A RULE. `bump` used to move the version
alone, which left `main` on a version with no section — the exact state
`changelog-section.py` refuses at release time and that
`__tests__/ci/python-version-pipeline.test.ts` asserts against. Bump commits carry
a skip-ci marker, so nothing went red until the next unrelated PR ran CI and came
back failing for a reason that had nothing to do with it. That happened at the
first publish (repaired by hand in #755, which named the recurrence and left it),
and again at the second. It is not a rule a maintainer can be asked to remember:
the commit that creates the state is written by a workflow, not a person.

IDEMPOTENT ON PURPOSE. A re-run of `bump` against a `main` that already carries
the section must be a no-op, not a second heading — two `## <version>` headings
would put only the first one's body in the GitHub Release, silently. The version
is matched with the same trailing word boundary the extractor uses, so `0.0.1b1`
is not answered by `0.0.1b10`.

The stub is deliberately non-empty prose, not a bare heading: an empty section
fails `changelog-section.py` just as a missing one does, so a stub that could not
release would only move the failure.

Stdlib only, same reason as its two siblings: it runs in a job that installs
nothing precisely because it is handed a token.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone

# The heading grammar CLAUDE.md fixes for the root changelog and both per-package
# files follow — an EM DASH, and a date. Matched with `\b` after the version so a
# request to open `0.0.1b1` is not satisfied by an existing `0.0.1b10`.
_HEADING = "## {version} — {date}"

#: What lands under the new heading. Non-empty by construction (see the module
#: docstring), and it says who wrote it so the next reader does not go looking for
#: the human who did not.
_STUB = """Open for the next release. `{published}` published on {date} and the `bump` job
moved the version here automatically; nothing has landed against `{version}` yet.
Add entries as changes merge — this section becomes the GitHub Release body when
it ships.
"""


class ChangelogError(Exception):
    """A message a maintainer can act on, printed without a traceback."""


def has_section(text: str, version: str) -> bool:
    return re.search(rf"^##[ \t]+{re.escape(version)}\b", text, re.MULTILINE) is not None


def open_section(text: str, version: str, published: str, date: str) -> str:
    """`text` with a stub section for `version` above the topmost existing one."""
    if has_section(text, version):
        return text

    block = _HEADING.format(version=version, date=date) + "\n\n" + _STUB.format(
        published=published, version=version, date=date
    )

    # Above the newest existing section, never at the end: the file is
    # reverse-chronological, and its preamble (title, and the grammar note the
    # extractor depends on) sits above the first heading and must stay there.
    first = re.search(r"^##[ \t]", text, re.MULTILINE)
    if first:
        return text[: first.start()] + block + "\n" + text[first.start() :]

    # No sections yet — the first release off a fresh file. Keep the preamble and
    # append, with exactly one blank line between.
    return text.rstrip("\n") + "\n\n" + block


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__ or "", file=sys.stderr)
        return 2
    path, version, published = argv[1], argv[2], argv[3]
    date = argv[4] if len(argv) >= 5 else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ChangelogError(f"'{date}' is not a YYYY-MM-DD date")

    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise ChangelogError(f"cannot read {path}: {exc}") from exc

    if has_section(text, version):
        print(f"{path} already has a '## {version}' section — nothing to open.")
        return 0

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(open_section(text, version, published, date))
    print(f"opened '## {version} — {date}' in {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except ChangelogError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
