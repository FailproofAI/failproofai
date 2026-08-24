"""This package is PUBLIC and its wheel is published to PyPI.

A real customer's tenant slug and company name reached this tree once, in a source
comment that shipped in the wheel and in four test files. It came across in a bulk
copy out of a private monorepo, where naming a live tenant in a fixture was harmless.

Fixtures must use obviously-fake names. This is the tripwire.

Customer names are held as SHA-256 digests, never in the clear. A deny-list that
spells out the name it exists to keep out of a public wheel publishes that name just
as surely as the fixture did — and this file ships in the sdist. Our OWN names stay
readable: they are already in LICENSE, SECURITY.md and package.json, so there is
nothing to withhold, and a contributor who trips over one needs to see which it was.

The match is over SUBSTRINGS of each token, not whole tokens, because the original
leak was both a bare tenant slug and a longer company name built from that same slug
— one name inside the other. To add an identifier:

    python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].lower().encode()).hexdigest())' NAME
"""

from __future__ import annotations

import functools
import hashlib
import pathlib
import re

import fp_cli

PKG = pathlib.Path(fp_cli.__file__).resolve().parent
ROOT = PKG.parent

# Our own organisation names — public in this repo already, so in the clear. A fixture
# must still not use them: they identify a real tenant on a real deployment.
FORBIDDEN_OWN = {
    "exosphere",
    "exospherehost",
}

# Customer / vendor identifiers, digest → what it is (never the name itself).
FORBIDDEN_DIGESTS = {
    "140bd3c7a8606c97e18fb1f01c3a94f558eab6e2c5b27a56f9c3f5a940d8e2fd": "a customer's tenant slug",
}

# The vocabulary fixtures are supposed to use.
SANCTIONED_FIXTURE_ORGS = {"acme", "globex", "example", "initech", "umbrella"}

_TOKEN = re.compile(r"[a-z0-9]+")
_URL = re.compile(r"https?://([a-z0-9.-]+)", re.I)

# Substring lengths considered when hashing. The floor keeps the scan off two- and
# three-letter noise; the ceiling bounds the work on long tokens (hex digests, base64).
_MIN_LEN = 5
_MAX_LEN = 24


@functools.lru_cache(maxsize=None)
def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _hashed_hits(text: str, needles: frozenset[str] | None = None) -> set[str]:
    """Digests from ``needles`` whose plaintext appears anywhere in ``text``.

    ``text`` need not be lowercased by the caller. Returns digests, not matched text:
    a failure message must not echo the identifier into a public CI log.
    """
    want = FORBIDDEN_DIGESTS.keys() if needles is None else needles
    found = set()
    for token in set(_TOKEN.findall(text.lower())):
        for start in range(len(token)):
            stop = min(len(token), start + _MAX_LEN)
            for end in range(start + _MIN_LEN, stop + 1):
                d = _digest(token[start:end])
                if d in want:
                    found.add(d)
    return found


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


def _scannable() -> list[pathlib.Path]:
    """Everything but this file, which names our own orgs to deny them."""
    return [p for p in _sources() if p.name != pathlib.Path(__file__).name]


def test_no_real_customer_or_vendor_identifiers():
    hits = []
    for p in _scannable():
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            lowered = line.lower()
            for needle in FORBIDDEN_OWN:
                if needle in lowered:
                    hits.append(f"{p.relative_to(ROOT)}:{i}: {needle}")
            # Report the location and what class of identifier it is — never the name.
            for digest in _hashed_hits(line):
                hits.append(f"{p.relative_to(ROOT)}:{i}: {FORBIDDEN_DIGESTS[digest]}")
    assert not hits, (
        "real organisation names must not appear in a public package — use a fixture "
        f"name such as {sorted(SANCTIONED_FIXTURE_ORGS)}:\n  " + "\n  ".join(hits)
    )


def test_the_scan_actually_has_files_to_scan():
    """Keeps the assertion above from passing vacuously if the layout moves."""
    files = _sources()
    assert len(files) > 40, f"only {len(files)} files scanned — the walk is not finding the package"


def test_the_hashed_scan_matches_substrings_and_only_them():
    """The digests are opaque, so prove the matcher on a planted, invented name.

    Without this, an off-by-one in the substring window turns the whole hashed
    deny-list into an assertion that passes because it matches nothing.
    """
    planted = frozenset({_digest("quuxcorp")})
    assert _hashed_hits("slug: quuxcorp", planted) == planted            # bare token
    assert _hashed_hits('name: "QuuxcorpInc"', planted) == planted       # inside a longer name
    assert _hashed_hits("host: quuxcorp-prod.example.com", planted) == planted
    assert not _hashed_hits("slug: acme, name: Globex Corp", planted)    # sanctioned fixtures
    assert not _hashed_hits("quux corp", planted)                        # not one token


def test_this_file_does_not_name_the_customers_it_denies():
    """The deny-list must not restate, in the clear, what it holds as a digest.

    ``_scannable()`` skips this file so the ``FORBIDDEN_OWN`` literals above do not
    trip the scan on themselves. That exemption is about OUR names, which are public
    in this repo already. It must never extend to a customer's: this file ships in
    the sdist, so a name written here is published exactly like the fixture that
    started all this. It needs its own test precisely because the exemption is what
    blinds the main scan to it.
    """
    src = pathlib.Path(__file__)
    hits = [
        f"{src.name}:{i}: {FORBIDDEN_DIGESTS[digest]}"
        for i, line in enumerate(src.read_text(encoding="utf-8", errors="replace").split("\n"), 1)
        for digest in _hashed_hits(line)
    ]
    assert not hits, (
        "this file names, in the clear, an identifier it exists to keep out of a "
        "public package:\n  " + "\n  ".join(hits)
    )


def test_no_internal_hostnames_leaked():
    """A customer's deployment hostname identifies them as surely as their name."""
    hits = []
    for p in _scannable():
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            for host in _URL.findall(line):
                labels = host.lower().split(".")
                if any(label in FORBIDDEN_OWN for label in labels) or _hashed_hits(host):
                    hits.append(f"{p.relative_to(ROOT)}:{i}")
    assert not hits, f"internal/customer hostnames in a public package: {hits}"
