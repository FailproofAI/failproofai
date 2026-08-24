"""FailproofAI Cloud CLI — a command-line client for the FailproofAI Cloud API.

The query layer lives in :mod:`fp_cli.client` as pure functions that take a
``ClientContext`` and return plain dataclasses. They never print and never import
Typer/Rich, so a future MCP server can wrap them with zero duplication.
"""

from ._version import __version__

__all__ = ["__version__"]
