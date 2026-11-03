#!/usr/bin/env python3
"""Version arithmetic for the two Python packages, `fp-cloud-cli` and `failproofai-sdk`.

Both publish workflows call this; it is the ONE place the release scheme is written
down, so the two pipelines cannot drift into disagreeing about what comes next.

    resolve <version-file> [<dist>]     -> key=value lines for $GITHUB_OUTPUT
    write   <version-file> <version>    -> rewrite __version__ in place

Given a dist name, `resolve` also emits the release tag: `<dist>-v<version>`, e.g.
`fp-cloud-cli-v0.0.1b1`. Namespaced rather than the bare `vX.Y.Z` the npm package uses,
because three release lines share one repository and one tag namespace — a bare
`v0.0.1b1` would read as a release of `failproofai` itself, and `gh release list`
would interleave all three with no way to tell them apart.

THE SCHEME. It mirrors `publish.yml`'s npm rule, spelled in PEP 440 rather than
semver, because PyPI has no dist-tags: there is no movable `beta` pointer to
publish behind, so the pre-release marker in the version string is the entire
channel mechanism.

    beta    X.Y.ZbN  ->  X.Y.Zb(N+1)      another beta off the same base
    stable  X.Y.Z    ->  X.Y.(Z+1)b0      open the next patch's beta line

`b` and not `-beta.`: `0.1.0-beta.1` is not a PEP 440 version at all, and pip
would reject the sdist name. `b0` and not `b1` after a stable, because that is
what npm's rule does (`X.Y.(Z+1)-beta.0`) and a release scheme that differs
between two of this repo's registries for no reason is a scheme nobody can
recite from memory.

WHY NON-CANONICAL SPELLINGS ARE REJECTED RATHER THAN ACCEPTED. `0.0.01b1`,
`0.0.1b01`, `1.2.3-beta.1` and `v1.2.3` are all legal PEP 440 and all normalise to
something else on the way to PyPI — so the file would say one thing, the wheel
another, and preflight's "is this already published" check would ask PyPI about a
third. Every consumer here compares version STRINGS, so this module normalises and
refuses anything that is not already in its final form, naming what PyPI would have
turned it into.

Stdlib only, and deliberately: this runs in the preflight job, which is the one
job in those workflows that has no publishing identity precisely BECAUSE it runs
before anything is installed. A dependency here would put third-party code back
into it.
"""

from __future__ import annotations

import re
import sys

# `__version__ = "..."` — matched, never exec'd. Importing the module would run
# whatever else the file grew, in a job that is about to be handed a token.
_ASSIGNMENT = re.compile(r"""(__version__\s*=\s*)(["'])([^"']+)(\2)""")

# The two shapes the scheme knows how to advance.
_STABLE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_BETA = re.compile(r"^(\d+)\.(\d+)\.(\d+)b(\d+)$")

# PEP 440's own pre-release spellings, and the canonical form each collapses to.
_PRE_LABELS = {
    "alpha": "a",
    "a": "a",
    "beta": "b",
    "b": "b",
    "c": "rc",
    "pre": "rc",
    "preview": "rc",
    "rc": "rc",
}

# PEP 440, verbatim from the spec's appendix. Used to normalise, and to tell "a
# version this scheme will not advance" (an rc, a .post, a .dev — publishable, no
# auto-bump) apart from "not a version at all" (a typo — refuse before a build).
_PEP440 = re.compile(
    r"""^\s*v?
    (?:(?P<epoch>[0-9]+)!)?
    (?P<release>[0-9]+(?:\.[0-9]+)*)
    (?P<pre>[-_.]?(?P<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?P<pre_n>[0-9]+)?)?
    (?P<post>(?:-(?P<post_n1>[0-9]+))|(?:[-_.]?(?P<post_l>post|rev|r)[-_.]?(?P<post_n2>[0-9]+)?))?
    (?P<dev>[-_.]?dev[-_.]?(?P<dev_n>[0-9]+)?)?
    (?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?
    \s*$""",
    re.VERBOSE | re.IGNORECASE,
)


class VersionError(Exception):
    """A message a maintainer can act on, printed without a traceback."""


def read_version(path: str) -> str:
    """The `__version__` literal in a `_version.py`, exactly as written."""
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise VersionError(f"cannot read {path}: {exc}") from exc

    found = _ASSIGNMENT.findall(text)
    if not found:
        raise VersionError(f"no __version__ assignment in {path}")
    if len(found) > 1:
        # Two assignments means the last one wins at import time and the first
        # one is what a careless regex edit would rewrite. Refuse rather than
        # guess which is live.
        raise VersionError(f"{len(found)} __version__ assignments in {path}; expected exactly 1")
    return found[0][2]


def normalize(version: str) -> str:
    """The form PyPI will store, per PEP 440's normalisation rules."""
    match = _PEP440.match(version)
    if not match:
        raise VersionError(f"'{version}' is not a valid PEP 440 version")

    out = ""
    epoch = match.group("epoch")
    if epoch and int(epoch):
        out += f"{int(epoch)}!"
    out += ".".join(str(int(part)) for part in match.group("release").split("."))
    if match.group("pre"):
        out += _PRE_LABELS[match.group("pre_l").lower()] + str(int(match.group("pre_n") or 0))
    if match.group("post"):
        out += f".post{int(match.group('post_n1') or match.group('post_n2') or 0)}"
    if match.group("dev"):
        out += f".dev{int(match.group('dev_n') or 0)}"
    local = match.group("local")
    if local:
        out += "+" + local.lower().replace("_", ".").replace("-", ".")
    return out


def classify(version: str) -> tuple[str, str]:
    """`(scheme, next_version)`. `next_version` is empty when the scheme cannot advance."""
    canonical = normalize(version)
    if canonical != version:
        # Checked before the scheme, not inside it, so it also catches the shapes
        # the scheme does not advance — `1.2.3-beta.1` publishes as `1.2.3b1`, and
        # a preflight that asked PyPI about the former learned nothing about the
        # version actually going up.
        raise VersionError(
            f"'{version}' is not canonical — PyPI would normalise it to '{canonical}', "
            "so the file, the wheel and the published version would disagree"
        )

    match = _BETA.match(version)
    if match:
        major, minor, patch, beta = (int(g) for g in match.groups())
        return "beta", f"{major}.{minor}.{patch}b{beta + 1}"

    match = _STABLE.match(version)
    if match:
        major, minor, patch = (int(g) for g in match.groups())
        return "stable", f"{major}.{minor}.{patch + 1}b0"

    # Canonical, valid, and not one of the two shapes: an rc, a .post, a .dev, an
    # epoch. PyPI takes it, so publishing is not blocked — but nothing here knows
    # what should follow it, and inventing a successor is how a release line
    # silently forks. The workflow warns and leaves main's version for a human.
    return "other", ""


def is_prerelease(version: str) -> bool:
    match = _PEP440.match(version)
    if not match:
        raise VersionError(f"'{version}' is not a valid PEP 440 version")
    return bool(match.group("pre") or match.group("dev"))


#: Tag prefixes this repository already uses, and must not be confused with. The
#: npm package tags bare `vX.Y.Z`; a Python release tag must never be mistakable
#: for one, in `gh release list`, in the repo's release feed, or by the CLI, which
#: builds its daemon download URLs out of `v<version>` tags.
_RESERVED_TAG_PREFIX = "v"


def release_tag(dist: str, version: str) -> str:
    tag = f"{dist}-v{version}"
    if not dist or dist.startswith(_RESERVED_TAG_PREFIX) and dist[1:2].isdigit():
        raise VersionError(f"dist name '{dist}' would produce a tag mistakable for an npm release tag")
    return tag


def resolve(path: str, dist: str | None = None) -> str:
    version = read_version(path)
    scheme, following = classify(version)
    lines = [
        f"version={version}",
        f"scheme={scheme}",
        f"is_prerelease={'true' if is_prerelease(version) else 'false'}",
        f"next_version={following}",
    ]
    if dist:
        lines.append(f"tag={release_tag(dist, version)}")
    return "\n".join(lines)


def write(path: str, version: str) -> str:
    """Rewrite the literal in place, leaving every other byte of the file alone."""
    scheme, _ = classify(version)  # refuses a typo before it reaches a commit
    if scheme == "other":
        # `write` is only ever called with a version this module computed, so
        # reaching here means someone wired it to an arbitrary string.
        raise VersionError(f"'{version}' is outside the release scheme; set it by hand")

    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    replaced, count = _ASSIGNMENT.subn(
        lambda m: f"{m.group(1)}{m.group(2)}{version}{m.group(4)}", text
    )
    if count != 1:
        raise VersionError(f"expected exactly 1 __version__ assignment in {path}, found {count}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(replaced)
    return version


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "resolve":
        print(resolve(argv[2], argv[3] if len(argv) >= 4 else None))
        return 0
    if len(argv) >= 4 and argv[1] == "write":
        print(write(argv[2], argv[3]))
        return 0
    print(__doc__ or "", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except VersionError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
