"""The Click that Typer is actually running. Import Click through here, never directly.

Typer 0.26 vendored Click into ``typer._click`` and dropped its dependency on the pip
``click`` distribution. The vendored classes are *different class objects* from pip
Click's, so every place we hand Click an object, or ask Click about one, breaks when
the two disagree — and each break is silent, because the code still imports, still
compiles, and every happy path still passes:

* ``ClickException`` — Typer's command runner catches only *its* Click's exception
  class. Errors subclassing pip Click's escape **uncaught**: a typed failure that
  should print ``✗ …`` and exit 5 exits **1 with an empty stderr**, and the
  ``rich_format_error`` hook in ``app.py`` (reached only *after* that catch) never
  runs. Same for the ``UsageError``/``BadParameter`` we raise by hand.
* ``Abort`` — ``typer.prompt`` raises its own Click's ``Abort`` on closed stdin, so a
  pip-Click ``except click.Abort`` stops matching and the clean "no TTY, pass a slug"
  usage error becomes a bare abort.
* Options — Typer 0.26+ has no ``Option`` class in its vendored Click *at all*: every
  option in a Typer-built tree is a ``typer.core.TyperOption``, subclassing
  ``Parameter`` directly. ``isinstance(param, click.Option)`` is then quietly always
  False, which emptied the telemetry flag catalog (``analytics_registry``) while its
  own anti-drift test stayed green — the test asked the same broken question.

So: resolve the Click that Typer imported, and speak that one.
``tests/test_click_compat.py`` asserts the package never imports ``click`` directly
again, and that our errors are still the class Typer catches.
"""

from __future__ import annotations

try:
    # typer >= 0.26. pip `click` may well still be installed — it is simply not the
    # Click in play, so binding to it here would reintroduce the whole class of bug.
    from typer._click import ClickException, Command, Parameter
    from typer._click.exceptions import Abort, BadParameter, UsageError
except ImportError:  # typer < 0.26 drives the pip `click` distribution directly
    from click import (  # type: ignore[assignment]
        Abort,
        BadParameter,
        ClickException,
        Command,
        Parameter,
        UsageError,
    )

__all__ = [
    "Abort",
    "BadParameter",
    "ClickException",
    "Command",
    "Parameter",
    "UsageError",
    "is_option",
]


def is_option(param: Parameter) -> bool:
    """True if ``param`` is an option (``--flag``), not a positional argument.

    Class identity cannot answer this across both Clicks — the vendored one has no
    ``Option`` class to test against — so read the ``param_type_name`` that Click sets
    on every parameter (``"option"`` / ``"argument"``). That holds for pip Click's
    ``Option`` and for ``TyperOption`` alike.
    """
    return getattr(param, "param_type_name", None) == "option"
