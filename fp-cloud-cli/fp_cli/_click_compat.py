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
* ``Abort`` — ``typer.prompt`` raises the ``Abort`` **typer** exports on closed stdin
  (0.27.2 moved that class out of the vendored Click entirely), so a pip-Click
  ``except click.Abort`` stops matching and the clean "no TTY, pass a slug" usage error
  becomes a bare abort.
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

# `Abort` is resolved from `typer` itself rather than from either Click, because it is
# the one symbol here that is not stably a Click class: typer 0.27.2 moved it out of the
# vendored `typer._click.exceptions` into a plain `typer.exceptions.Abort(RuntimeError)`.
# `typer.Abort` tracks that move — it is `click.Abort` before 0.26, the vendored class
# through 0.27.1, the RuntimeError from 0.27.2 — and it is by construction the class
# `typer.prompt` raises and typer's own `_main` catches, which is the only property
# `select.py`'s `except click.Abort` needs.
from typer import Abort as Abort

# Pick the Click ONCE, on whether typer vendors one at all, then import every symbol
# from that choice. Deciding per symbol — a single `try` around the whole vendored
# import block, falling back to pip `click` on any ImportError — is what shipped
# through 0.27.1 and it failed exactly as silently as this module exists to prevent:
# 0.27.2 removing `typer._click.exceptions.Abort` made that one missing name rebind ALL
# SIX symbols to pip Click, so every typed error escaped Typer's handler as exit 1 with
# an empty stderr. A name that goes missing inside the chosen Click must raise here, at
# import, where it is a CLI that refuses to start rather than one that silently stops
# reporting errors.
try:
    import typer._click as _typer_click  # typer >= 0.26 vendors its own Click
except ImportError:  # typer < 0.26 drives the pip `click` distribution directly
    _typer_click = None  # type: ignore[assignment]

if _typer_click is not None:
    # pip `click` may well still be installed — it is simply not the Click in play, so
    # binding to it here would reintroduce the whole class of bug.
    from typer._click import ClickException, Command, Parameter
    from typer._click.exceptions import BadParameter, UsageError
else:
    from click import (  # type: ignore[assignment]
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
