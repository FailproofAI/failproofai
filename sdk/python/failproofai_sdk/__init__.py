from failproofai_sdk._version import __version__
from failproofai_sdk._environment import set_environment
from failproofai_sdk._events import EventNamespace
from failproofai_sdk._resolver import set_base_dir
from failproofai_sdk._writer import EventWriter, _validated_interval

_writer = EventWriter()
event = EventNamespace(_writer)


def configure(
    *,
    base_dir=None,
    flush_interval: float = 0.5,
    environment: str | None = None,
) -> None:
    """Configure the SDK. Call once at startup before any event.* calls.

    Args:
        base_dir: Override the default ~/.agenteye root directory.
                  Pass None to use the default ($AGENTEYE_HOME if set,
                  else Path.home() / ".agenteye").
        flush_interval: Seconds between flush cycles. Default 0.5 (500ms).
        environment: Deployment environment label (e.g. "production", "staging").
                     Can also be set via the AGENTEYE_ENVIRONMENT env var.
                     Defaults to "dev" when neither is set.

    Raises:
        ValueError: if `flush_interval` is not a finite number greater than zero.
            Checked here, before anything is applied, so a rejected call leaves
            the SDK exactly as it was rather than with a new base_dir and the old
            interval.
    """
    flush_interval = _validated_interval(flush_interval)
    set_base_dir(base_dir)
    _writer.set_flush_interval(flush_interval)
    set_environment(environment)
