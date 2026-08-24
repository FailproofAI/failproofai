"""This package is PUBLIC and its wheel is published to PyPI.

It came out of a private monorepo, where naming a live tenant in a fixture or
leaving an internal hostname in a docstring was harmless. Here it is permanent:
a PyPI version cannot be recalled or reused, so anything that ships once ships
forever. The sibling `fp-cloud-cli` hit exactly this during its own move — a real
customer's slug and company name reached the tree in a bulk copy — which is why
this tripwire exists on both packages.

Customer names are held as SHA-256 digests, never in the clear. A deny-list that
spells out the name it exists to keep out of a public wheel publishes that name
just as surely as the fixture did, and this file ships in the sdist. Our OWN
names stay readable: they are already in LICENSE and pyproject.toml, so there is
nothing to withhold, and a contributor who trips over one needs to see which it
was.

The match is over SUBSTRINGS of each token, not whole tokens, because the
original leak was a slug *and* a company name built from it — one name inside a
longer one. To add an identifier:

    python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].lower().encode()).hexdigest())' NAME
"""

from __future__ import annotations

import functools
import hashlib
import pathlib
import re

import failproofai_sdk

PKG = pathlib.Path(failproofai_sdk.__file__).resolve().parent
ROOT = PKG.parent

# Our own organisation names — public in this repo already, so in the clear. A
# fixture must still not use them: they identify a real tenant on a real deployment.
FORBIDDEN_OWN = {
    "exosphere",
    "exospherehost",
}

# Customer / vendor identifiers, digest → what it is (never the name itself).
# Kept in step with fp-cloud-cli/tests/test_no_customer_identifiers.py.
FORBIDDEN_DIGESTS = {
    "140bd3c7a8606c97e18fb1f01c3a94f558eab6e2c5b27a56f9c3f5a940d8e2fd": "a customer's tenant slug",
}

# Internal artefacts from the private monorepo. Unlike the names above these are
# not confidential so much as WRONG to ship: a dev credential in a public
# quickstart gets pasted into production, and an internal-only table name in a
# docstring is an invitation to query something that does not exist for users.
FORBIDDEN_INTERNALS = {
    "dev-admin-key": "the local-dev admin credential",
    "agenteye-enterprise": "the private customer-release org",
    "clickhouse": "an internal storage detail users never touch",
    "org_ch_secret": "an internal server secret name",
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

    ``text`` need not be lowercased by the caller. Returns digests, not matched
    text: a failure message must not echo the identifier into a public CI log.
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
    for name in ("README.md", "CHANGELOG.md", "pyproject.toml"):
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


def _scannable_for_own_names() -> list[pathlib.Path]:
    """As above, minus the one file our own org name legitimately belongs in.

    `pyproject.toml`'s `authors` email is the published maintainer contact — it
    is on the PyPI project page by design, and `fp-cloud-cli` publishes the same one.
    It is still scanned for customer digests and internal artefacts below; only
    the our-own-name rule is lifted, because that rule exists to keep a real
    tenant out of a FIXTURE, not to redact the maintainer.
    """
    return [p for p in _scannable() if p.name != "pyproject.toml"]


def test_no_real_customer_or_vendor_identifiers():
    hits = []
    for p in _scannable_for_own_names():
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            lowered = line.lower()
            for needle in FORBIDDEN_OWN:
                if needle in lowered:
                    hits.append(f"{p.relative_to(ROOT)}:{i}: {needle}")
    # Customer digests are checked over EVERY file, pyproject.toml included —
    # the exemption above is only for our own maintainer contact.
    for p in _scannable():
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            # Report the location and what class of identifier it is — never the name.
            for digest in _hashed_hits(line):
                hits.append(f"{p.relative_to(ROOT)}:{i}: {FORBIDDEN_DIGESTS[digest]}")
    assert not hits, (
        "real organisation names must not appear in a public package — use a fixture "
        f"name such as {sorted(SANCTIONED_FIXTURE_ORGS)}:\n  " + "\n  ".join(hits)
    )


def test_no_internal_artefacts_from_the_private_monorepo():
    """Credentials and internal names that came across in the move."""
    hits = []
    for p in _scannable():
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            lowered = line.lower()
            for needle, what in FORBIDDEN_INTERNALS.items():
                if needle in lowered:
                    hits.append(f"{p.relative_to(ROOT)}:{i}: {what}")
    assert not hits, "internal artefacts in a public package:\n  " + "\n  ".join(hits)


def test_the_scan_actually_has_files_to_scan():
    """Keeps the assertions above from passing vacuously if the layout moves."""
    files = _sources()
    assert len(files) > 15, (
        f"only {len(files)} files scanned — the walk is not finding the package"
    )
    assert any(p.name == "_writer.py" for p in files)
    assert any(p.parent.name == "tests" for p in files)


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
