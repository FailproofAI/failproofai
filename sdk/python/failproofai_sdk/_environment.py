import logging

_DEFAULT_ENVIRONMENT = "dev"
_environment: str | None = None

#: Set once the comma warning below has been emitted. `get_environment()` runs
#: from `to_dict()`, i.e. once per event on the caller's own thread, and the
#: warning had no once-flag at all — so an `AGENTEYE_ENVIRONMENT` with a comma
#: put one WARNING line into the host application's log for every event emitted,
#: for the life of the process. At the SDK's documented ceiling that is a
#: logging-driven throughput collapse in a library whose first constraint is not
#: to disrupt the host agent. The comment two lines below already promised
#: "Warn once"; this is what makes that true.
_warned_comma = False

logger = logging.getLogger("failproofai_sdk")


def _reject_comma(env: str, source: str) -> None:
    """A comma in `environment` makes ingest skip EVERY event carrying it.

    The endpoint splits this field on commas to build its filter facets, so a
    line whose `environment` contains one is discarded — the whole line, not the
    field. It answers 200 with `{"accepted":0,"skipped":N}`, the daemon deletes
    the delivered batch, and the run that produced it is simply never in the
    dashboard: no exception here, nothing in the agent's output, and an empty
    session list that looks exactly like an agent nobody ran.

    `failproofaid` already refuses a comma in `collector.environment` for this
    reason (`crates/fpai-collect/src/config.rs`). The SDK is the other writer of
    the same field and did not, so `AGENTEYE_ENVIRONMENT="prod,eu"` — a wholly
    reasonable thing to type — silently threw away everything the process
    emitted.
    """
    if "," in env:
        raise ValueError(
            f"environment must not contain a comma (got {env!r} from {source}). "
            "The ingest endpoint skips every event whose environment has one, so "
            "this would silently discard all telemetry from this process. Use a "
            "single label, e.g. 'prod-eu'."
        )


def get_environment() -> str:
    if _environment is not None:
        return _environment
    import os

    raw = os.environ.get("AGENTEYE_ENVIRONMENT")
    if not raw:
        return _DEFAULT_ENVIRONMENT
    if "," in raw:
        # Raising here would blow up inside `to_dict()` on an arbitrary event,
        # far from the thing that set it, and take the caller's agent down with
        # it — a telemetry library must not do that. Warn once and fall back to
        # a label ingest will actually accept, so the events land under a
        # visibly-wrong environment instead of vanishing.
        global _warned_comma
        if not _warned_comma:
            _warned_comma = True
            logger.warning(
                "failproofai_sdk: AGENTEYE_ENVIRONMENT=%r contains a comma, which makes "
                "the ingest endpoint skip every event carrying it. Falling back to %r. "
                "Use a single label, e.g. 'prod-eu'.",
                raw,
                _DEFAULT_ENVIRONMENT,
            )
        return _DEFAULT_ENVIRONMENT
    return raw


def set_environment(env: str | None) -> None:
    global _environment, _warned_comma
    if env:
        _reject_comma(env, "configure(environment=...)")
    _environment = env if env else None
    # A new label means the env var may be worth complaining about again.
    _warned_comma = False
