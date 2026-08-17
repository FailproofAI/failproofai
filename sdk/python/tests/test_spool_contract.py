"""The SDK must write where the shipped daemons read.

This is the cross-component test, and it exists because the divergence it checks
for is invisible from either side alone: the SDK's own tests pass while writing
to a directory nothing watches, and the daemon's own tests pass while watching a
directory nothing writes to. Both suites green, zero events uploaded, no error
anywhere. Silent total data loss is the failure mode this file is here to make
loud.

Two daemons read this SDK's spool, and only one of them is in this repository:

  * ``failproofaid`` — here, in ``crates/fpai-collect``. Watches BOTH roots.
    Checkable, and checked below without skipping.
  * ``agenteye-collector`` — in the private AgentEye repository. Watches only
    ``$AGENTEYE_HOME`` / ``~/.agenteye``. Checkable only when a checkout is on
    disk, so it is opt-in via ``FP_AGENTEYE_ROOT``.

The predecessor of this file gated EVERY test in it on a source file from that
other repository, so all four skipped in normal runs — including the three that
assert nothing but this SDK's own behaviour and need no other repo at all. A
test that always skips is not a guard. Hence the split below, and hence
``FAILPROOFAI_SDK_REQUIRE_CONTRACT=1``, which CI sets to turn the remaining
skips into failures so "the file moved" can never quietly read as "green".
"""
import os
import re
from pathlib import Path

import pytest

from failproofai_sdk import _resolver

# tests/ -> python/ -> sdk/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
FPAI_COLLECT_CONFIG = REPO_ROOT / "crates" / "fpai-collect" / "src" / "config.rs"
FP_HOME_TS = REPO_ROOT / "src" / "hooks" / "fp-home.ts"

#: Set by CI. Turns "the source I read is missing" from a skip into a failure.
REQUIRE = os.environ.get("FAILPROOFAI_SDK_REQUIRE_CONTRACT", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _read_sibling(path: Path) -> str:
    """Source of a same-repo file, or skip/fail depending on ``REQUIRE``.

    Missing means one of two things: this is an installed sdist (fine — there is
    no repo to read), or somebody moved the file (not fine). ``REQUIRE``
    distinguishes them, because from in here they look identical.
    """
    if path.is_file():
        return path.read_text(encoding="utf-8")
    message = (
        f"{path.relative_to(REPO_ROOT) if REPO_ROOT in path.parents else path} is "
        "missing. In a packaged sdist that is expected. In the repository it means "
        "the file moved, and this contract is now unguarded — re-point this test at "
        "the new location rather than deleting it."
    )
    if REQUIRE:
        pytest.fail(message)
    pytest.skip(message)


# ─────────────────────────────────────────────────────────────────────────────
# This SDK's own resolution rule. Depends on nothing outside this package, so
# it never skips, ever.
# ─────────────────────────────────────────────────────────────────────────────


def test_sdk_default_is_dot_agenteye(tmp_path, monkeypatch):
    """No configuration, no umbrella: the legacy root both daemons watch."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    monkeypatch.delenv(_resolver.SPOOL_OPT_IN_ENV, raising=False)
    _resolver.set_base_dir(None)

    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_umbrella_present_but_unasked_still_resolves_to_dot_agenteye(tmp_path, monkeypatch):
    """The exact reported incident: failproofai installed, plain collector running.

    Before the opt-in, merely creating this directory moved the SDK's spool and
    stranded every batch under a collector that was watching elsewhere.
    """
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("AGENTEYE_HOME", raising=False)
    monkeypatch.delenv(_resolver.SPOOL_OPT_IN_ENV, raising=False)
    _resolver.set_base_dir(None)
    (tmp_path / ".failproofai" / "custom-agents").mkdir(parents=True)

    assert _resolver.get_base_dir() == tmp_path / ".agenteye"


def test_agenteye_home_overrides_everything_below_it(tmp_path, monkeypatch):
    """$AGENTEYE_HOME is the one override every component honours."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("AGENTEYE_HOME", str(tmp_path / "shared"))
    _resolver.set_base_dir(None)

    assert _resolver.get_base_dir() == tmp_path / "shared"


# ─────────────────────────────────────────────────────────────────────────────
# failproofaid — same repository, so these are hard assertions.
# ─────────────────────────────────────────────────────────────────────────────


def test_failproofaid_watches_the_legacy_agenteye_root():
    """``crates/fpai-collect`` must keep reading ``~/.agenteye``.

    This is the assertion that protects every already-deployed SDK. Dropping
    this root from the daemon does not break a build or a test on the Rust side
    — it just means an unupgraded SDK writes into a directory nothing reads.
    """
    src = _read_sibling(FPAI_COLLECT_CONFIG)

    assert "fn agenteye_events_dir()" in src, (
        "crates/fpai-collect no longer defines agenteye_events_dir(). Every SDK "
        "release to date writes to ~/.agenteye/events by default; removing that "
        "root silently strands all of them."
    )
    assert 'var_os("AGENTEYE_HOME")' in src
    assert '".agenteye"' in src
    assert 'join("events")' in src


def test_failproofaid_watches_both_roots_in_one_list():
    """Both spool roots must be in the daemon's watch list, not just defined."""
    src = _read_sibling(FPAI_COLLECT_CONFIG)

    match = re.search(r"for sdk_spool in \[([^\]]*)\]", src)
    assert match, (
        "the spool_dirs loop in crates/fpai-collect/src/config.rs was "
        "restructured. Find where the daemon now assembles the directories it "
        "watches and re-point this assertion; a defined-but-unwatched root reads "
        "as working from every side."
    )
    watched = match.group(1)
    assert "custom_agents_events_dir" in watched
    assert "agenteye_events_dir" in watched


def test_umbrella_path_agrees_with_rust_and_typescript():
    """``~/.failproofai/custom-agents`` is spelled the same in all three languages."""
    rust = _read_sibling(FPAI_COLLECT_CONFIG)
    typescript = _read_sibling(FP_HOME_TS)

    assert 'join("custom-agents")' in rust
    assert '"custom-agents"' in typescript
    assert 'atHome(home, "custom-agents")' in typescript, (
        "src/hooks/fp-home.ts no longer derives customAgentsDir from atHome(). "
        "atHome() is what applies FAILPROOFAI_HOME, which _resolver mirrors."
    )
    # The SDK's own spelling of the same path, under a fake home.
    assert _resolver.failproofai_custom_agents_dir().name == "custom-agents"


def test_failproofai_home_is_honoured_the_same_way_on_both_sides(tmp_path, monkeypatch):
    """``FAILPROOFAI_HOME`` moves the umbrella root for the SDK and the TS alike."""
    typescript = _read_sibling(FP_HOME_TS)
    assert "process.env.FAILPROOFAI_HOME" in typescript

    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path / "elsewhere"))
    assert _resolver.failproofai_custom_agents_dir() == (
        tmp_path / "elsewhere" / "custom-agents"
    )


# ─────────────────────────────────────────────────────────────────────────────
# agenteye-collector — private repository. Opt-in via FP_AGENTEYE_ROOT.
# ─────────────────────────────────────────────────────────────────────────────

_AGENTEYE_ROOT = os.environ.get("FP_AGENTEYE_ROOT")
_agenteye_collector_config = (
    Path(_AGENTEYE_ROOT) / "collector" / "src" / "config.rs" if _AGENTEYE_ROOT else None
)

requires_agenteye_checkout = pytest.mark.skipif(
    _agenteye_collector_config is None or not _agenteye_collector_config.is_file(),
    reason="set FP_AGENTEYE_ROOT to an AgentEye checkout to verify the older collector",
)


@requires_agenteye_checkout
def test_agenteye_collector_still_reads_only_agenteye_home_and_dot_agenteye():
    """Pins the premise the SDK default rests on, on the older collector."""
    src = _agenteye_collector_config.read_text(encoding="utf-8")
    start = src.find("pub fn base_dir()")
    assert start != -1, (
        "the AgentEye collector's `pub fn base_dir()` is gone. It is the other "
        "half of this contract — find where it now resolves its spool root and "
        "re-point this test at it rather than deleting the test."
    )
    end = src.find("\nfn ", start)
    body = src[start : end if end != -1 else len(src)]

    assert 'var("AGENTEYE_HOME")' in body
    assert '".agenteye"' in body
    # The load-bearing half: if that collector ever learns the umbrella root,
    # this fails and the SDK's opt-in can be revisited on purpose.
    assert "failproofai" not in body.lower(), (
        "the AgentEye collector now mentions failproofai in base_dir(). If it "
        "genuinely watches ~/.failproofai/custom-agents, the SDK's "
        f"{_resolver.SPOOL_OPT_IN_ENV} opt-in could become the default — but "
        "make that an explicit decision, not a silent one."
    )
