import os
from pathlib import Path

_base_dir: Path | None = None


def get_base_dir() -> Path:
    """Where this SDK writes its event spool.

    Resolution order, most explicit first:

      1. ``set_base_dir()``               — a caller said so outright
      2. ``~/.failproofai/custom-agents`` — always

    There is no environment variable that redirects the spool off the umbrella,
    and that is the point. ``FAILPROOFAI_HOME`` (honoured by
    ``failproofai_custom_agents_dir()`` below) MOVES the umbrella; it cannot
    take you outside it, because the ``custom-agents`` segment is appended
    unconditionally. Wherever the home is, the spool is inside it.

    ## Why ``$AGENTEYE_HOME`` no longer resolves here

    It used to sit at step 2 and win over the default, which made it possible to
    aim this SDK at ``~/.agenteye`` — or anywhere else — from the environment.
    That is a redirect with no confirmation and no error: batches land in a
    directory, something may or may not read it, and an unread spool is
    indistinguishable from an idle one. A variable named for a product this
    package no longer belongs to is a poor thing to have that power, and an
    operator who exports it for the OTHER component that reads it (the older
    ``agenteye-collector``, which resolves ``$AGENTEYE_HOME`` or ``~/.agenteye``
    and nothing else) moved this SDK's spool as a side effect they never asked
    for.

    So it is gone from resolution. The variable itself still exists and still
    means something — just not here.

    ## Nothing is stranded by this

    ``failproofaid``, the daemon this SDK ships beside, watches BOTH
    ``~/.failproofai/custom-agents/events`` AND ``~/.agenteye/events``, and
    keeps doing so (``crates/fpai-collect/src/config.rs``, ``spool_dirs``). An
    SDK old enough to write only the legacy root is still collected. Batches
    already sitting there still drain. What changed is only that THIS version
    has no way to be pointed at that root by accident — it writes to the
    umbrella, and the daemon reads both.

    ## The one case that needs a deliberate choice

    A host running the older ``agenteye-collector`` and nothing else. That
    collector never learned the umbrella, so it does not watch where this SDK
    now writes. Setting ``AGENTEYE_HOME`` no longer bridges that gap from this
    side; the supported bridges are, in order of preference:

      * run ``failproofaid`` instead — it watches both roots, so nothing is
        configured at all; or
      * point the collector AT the SDK by setting its own
        ``AGENTEYE_HOME=~/.failproofai/custom-agents``, which makes it watch
        ``~/.failproofai/custom-agents/events``; or
      * ``set_base_dir("~/.agenteye")`` in the application, which is explicit,
        visible at the call site, and cannot happen by inheriting somebody
        else's environment.

    ``test_spool_contract.py`` reads the Rust and the TypeScript that define
    these roots and fails if either drifts from what this module resolves.
    """
    if _base_dir is not None:
        return _base_dir

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

    Not part of resolution any more, and no environment variable can put it
    back — see ``get_base_dir``. Kept as a named constant because the migration
    notes and the tests still refer to it, and because ``failproofaid`` goes on
    watching ``~/.agenteye/events`` for SDKs old enough to write there. Spelling
    it in four places is how the two sides drift apart.
    """
    return Path.home() / ".agenteye"


def set_base_dir(path: "str | Path | None") -> None:
    global _base_dir
    # `expanduser`, because the migration bridge this module itself prescribes —
    # `configure(base_dir="~/.agenteye")`, listed in `get_base_dir`'s docstring
    # and in README.md as the explicit, visible-at-the-call-site option — is a
    # RELATIVE path whose first segment is the literal character `~`. Without
    # this, `_write_batch`'s `mkdir(parents=True)` cheerfully created a `~`
    # directory under the process's cwd and spooled into it: nothing on the
    # machine watches that path, so 100% of the telemetry was lost, which is the
    # precise "an unread spool is indistinguishable from an idle one" failure
    # the prose above it is written to prevent.
    _base_dir = Path(path).expanduser() if path is not None else None
