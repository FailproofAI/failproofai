"""CLI exception hierarchy.

Errors subclass ``ClickException``, so Typer/Click catch them automatically, print the
message to stderr, and exit with ``exit_code``. The base class comes from
:mod:`._click_compat`, **not** from a plain ``import click``: Typer 0.26+ vendors its
own Click and catches only that one, so subclassing pip Click's ``ClickException``
makes every typed error escape uncaught as exit 1 with an empty stderr. See
``_click_compat`` for the full failure mode.
"""

from __future__ import annotations

from typing import Optional

from . import _click_compat as click  # the Click Typer is running; see _click_compat


class FpCliError(click.ClickException):
    """Base class for all CLI errors.

    Carries an optional ``hint`` (a short "what to do next" line). The single error
    chokepoint in ``app.py`` renders it — under ``--json`` as a ``"hint"`` field, else
    as the dim second line of the red error box — so commands just ``raise`` a typed
    error with a hint instead of hand-rolling a JSON-vs-box branch per call site.
    """

    exit_code = 1

    def __init__(self, message: str, *, hint: Optional[str] = None) -> None:
        super().__init__(message)
        self.hint = hint


class KeyModeUnsupportedError(FpCliError):
    """This command cannot work with an API key (`--api-key` / ``FP_API_KEY``).

    Reuses **exit 2 (usage error)**, deliberately: the exit-code table is a scripted
    contract restated in ``app.py``'s help, ``cli/skill/SKILL.md`` and
    ``enterprise-docs/cli.md``, so a seventh code would have to be added to all three
    at once — and "you asked for something this credential can never do" IS a usage
    error. Every raise site fires BEFORE any HTTP call, so an unsupported command
    never half-runs.

    Like every error here it subclasses through ``_click_compat``; bind it to pip
    Click and Typer 0.26+ lets it escape as exit 1 with an empty stderr.
    """

    exit_code = 2


class NetworkError(FpCliError):
    """The dashboard could not be reached."""

    exit_code = 3


class AuthError(FpCliError):
    """Not logged in, or the stored session has expired."""

    exit_code = 4


class ForbiddenError(FpCliError):
    """Authenticated, but the account lacks the required permission."""

    exit_code = 5


class NotFoundError(FpCliError):
    """The requested resource does not exist."""

    exit_code = 6


class ApiError(FpCliError):
    """The dashboard returned an unexpected error status."""

    exit_code = 1

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        request_id: Optional[str] = None,
        hint: Optional[str] = None,
    ) -> None:
        super().__init__(message, hint=hint)
        self.status = status
        self.request_id = request_id

    def format_message(self) -> str:
        parts = [self.message]
        if self.status is not None:
            parts.append(f"(HTTP {self.status})")
        if self.request_id:
            parts.append(f"[request-id: {self.request_id}]")
        return " ".join(parts)
