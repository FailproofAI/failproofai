import os
from pathlib import Path

_base_dir: Path | None = None


def get_base_dir() -> Path:
    """Where this SDK writes its event spool.

    Resolution order, most explicit first:

      1. ``set_base_dir()``               — a caller said so outright
      2. ``$AGENTEYE_HOME``               — an operator said so
      3. ``~/.failproofai/custom-agents`` — the default

    THE DEFAULT MOVED, AND THE OLD ROOT IS STILL READ.

    It used to be ``~/.agenteye``, with the umbrella reachable only behind an
    ``AGENTEYE_SPOOL_TO_FAILPROOFAI`` opt-in that also required the directory to
    already exist. Nothing created that directory — not this SDK, not
    ``failproofaid``, not either installer — so the second condition was never
    true and the opt-in never fired. The umbrella was documented, tested, and
    unreachable.

    The daemon this SDK ships beside, ``failproofaid``, watches BOTH roots and
    always has (``crates/fpai-collect/src/config.rs`` builds ``spool_dirs`` from
    ``custom_agents_events_dir()`` AND ``agenteye_events_dir()``, and both stay
    watched indefinitely). So on a host running it, this change moves where the
    files land and nothing else: they are collected either way.

    **Batches already sitting in ``~/.agenteye/events`` are not orphaned.** They
    stay where they are and are still drained by whichever collector owns that
    root. The directory simply stops growing. Nothing needs to be moved by hand.

    ## The one case that breaks, and its escape hatch

    ``agenteye-collector`` — the older daemon in the private AgentEye repository
    — resolves its base from ``$AGENTEYE_HOME`` or ``~/.agenteye`` and NOTHING
    else (``collector/src/config.rs``, ``base_dir()``). It has no idea the
    umbrella exists. On a host running that collector and this SDK, the default
    below writes where it does not look, and the failure is silent: no error on
    either side, batches accumulate forever, and an unread spool is
    indistinguishable from an idle one.

    That host sets::

        AGENTEYE_HOME=~/.agenteye

    which is step 2 above and predates this change. It is the documented escape
    hatch precisely because both daemons already honour it, so it cannot itself
    desynchronise them.

    ``test_spool_contract.py`` reads the Rust and the TypeScript that define
    these roots and fails if either drifts from what this module resolves.
    """
    if _base_dir is not None:
        return _base_dir

    env_override = os.environ.get("AGENTEYE_HOME")
    if env_override:
        return Path(env_override)

    return failproofai_custom_agents_dir()


def failproofai_custom_agents_dir() -> Path:
    """``~/.failproofai/custom-agents``, honouring ``$FAILPROOFAI_HOME``.

    Mirrors ``customAgentsDir()`` in ``src/hooks/fp-home.ts`` and
    ``custom_agents_events_dir()`` in ``crates/fpai-collect/src/config.rs``. The
    three must agree; a divergence would mean this SDK writes somewhere the
    daemon never reads.

    All three live in THIS repository, so the agreement is checkable rather than
    hoped for — ``tests/test_spool_contract.py`` reads the Rust and the
    TypeScript and fails if either drifts.

    Returns a path unconditionally and never checks whether it exists. The
    caller creates it: ``_writer._write_batch`` already does
    ``mkdir(parents=True, exist_ok=True)`` on the directory it is about to write
    into. An existence check here is what made the old opt-in dead — a spool
    root that must pre-exist can never be the place a first batch is written.
    """
    fp_home = os.environ.get("FAILPROOFAI_HOME")
    base = Path(fp_home) if fp_home else Path.home() / ".failproofai"
    return base / "custom-agents"


def legacy_agenteye_dir() -> Path:
    """``~/.agenteye`` — the root this SDK wrote to before the default moved.

    Not part of resolution any more. Kept as a named constant because the
    migration notes, the tests and the ``AGENTEYE_HOME`` escape hatch all refer
    to it, and spelling it in four places is how the two sides drift apart.
    """
    return Path.home() / ".agenteye"


def set_base_dir(path: "str | Path | None") -> None:
    global _base_dir
    _base_dir = Path(path) if path is not None else None
