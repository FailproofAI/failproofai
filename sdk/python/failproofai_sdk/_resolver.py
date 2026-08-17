import os
from pathlib import Path

_base_dir: Path | None = None


#: Opt-in: "a daemon that watches the failproofai umbrella root is installed here".
SPOOL_OPT_IN_ENV = "AGENTEYE_SPOOL_TO_FAILPROOFAI"

_TRUTHY = {"1", "true", "yes", "on"}


def get_base_dir() -> Path:
    """Where this SDK writes its event spool.

    Resolution order, most explicit first:

      1. ``set_base_dir()``          — a caller said so outright
      2. ``$AGENTEYE_HOME``          — an operator said so
      3. ``~/.failproofai/custom-agents``  — only with the opt-in below
      4. ``~/.agenteye``             — the default

    Step 3 is the failproofai umbrella, and it requires BOTH
    ``$AGENTEYE_SPOOL_TO_FAILPROOFAI`` to be truthy AND the directory to exist.

    THE OPT-IN IS THE WHOLE POINT, so do not "simplify" it back to an
    existence check. A spool is only useful if something reads it, and the two
    candidate daemons do not read the same roots:

      * ``failproofaid`` — the daemon THIS repository ships — watches both
        roots. ``crates/fpai-collect/src/config.rs`` builds ``spool_dirs`` from
        ``custom_agents_events_dir()`` AND ``agenteye_events_dir()``, and the
        comment above that list says both stay watched indefinitely.
      * ``agenteye-collector`` — the older collector, which lives in the
        private AgentEye repository — resolves its base from ``$AGENTEYE_HOME``
        or ``~/.agenteye`` and nothing else (``collector/src/config.rs`` there),
        and watches that single events directory non-recursively.

    So "the umbrella directory exists" does not imply "a daemon watches the
    umbrella directory". Merely installing failproofai alongside a normal
    agenteye-collector once created that directory, silently moved this SDK's
    output into it, and left the collector watching an empty ``~/.agenteye``.
    Nothing errors: batches accumulate on disk forever, and an unread spool
    looks exactly like an idle one, so the first sign of trouble is a dashboard
    with no data and no explanation.

    Defaulting to ``~/.agenteye`` cannot cause that. The worst case for the
    default is that a failproofaid host writes to the older of the two roots
    that failproofaid already watches — which costs nothing.
    """
    if _base_dir is not None:
        return _base_dir

    env_override = os.environ.get("AGENTEYE_HOME")
    if env_override:
        return Path(env_override)

    if os.environ.get(SPOOL_OPT_IN_ENV, "").strip().lower() in _TRUTHY:
        umbrella = failproofai_custom_agents_dir()
        if umbrella is not None and umbrella.is_dir():
            return umbrella

    return Path.home() / ".agenteye"


def failproofai_custom_agents_dir() -> Path | None:
    """``~/.failproofai/custom-agents``, honouring ``$FAILPROOFAI_HOME``.

    Mirrors ``customAgentsDir()`` in ``src/hooks/fp-home.ts`` and
    ``custom_agents_events_dir()`` in ``crates/fpai-collect/src/config.rs``. The
    three must agree; a divergence would mean this SDK writes somewhere the
    daemon never reads.

    All three now live in THIS repository, so the agreement is checkable rather
    than hoped for — ``tests/test_spool_contract.py`` reads the Rust and the
    TypeScript and fails if either drifts from what this module resolves.

    Being able to check it does not make the opt-in unnecessary. This path
    being correct says nothing about whether anything on the *host* is running,
    which is why :func:`get_base_dir` still will not select it unasked.
    """
    fp_home = os.environ.get("FAILPROOFAI_HOME")
    base = Path(fp_home) if fp_home else Path.home() / ".failproofai"
    return base / "custom-agents"


def set_base_dir(path: "str | Path | None") -> None:
    global _base_dir
    _base_dir = Path(path) if path is not None else None
