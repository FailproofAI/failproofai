"""Telemetry for AI agents: emit events, spool them, let the daemon ship them.

Three surfaces, in the order most people meet them:

* **Scopes** — `session()`, `agent()`, `tool_call()`. Context managers that bind
  run identity and, for the latter two, bracket a run with its own events. Work
  under `with` and `async with`.
* **Adapters** — `instrument()`. Auto-detects LangChain/LangGraph, CrewAI,
  LlamaIndex and Pydantic AI in the process and wires them to the scopes above.
* **`event.*`** — the 15 event methods, for anything the adapters do not cover.

`session_id` and `agent_id` are optional on every event method: omitted, they
resolve from the enclosing scope. Nothing bound and nothing passed is an error,
never a silent drop — ingest skips an event with no session and answers 200.
"""

from typing import Any

from failproofai_sdk._version import __version__
from failproofai_sdk._environment import set_environment
from failproofai_sdk._resolver import set_base_dir
from failproofai_sdk._context import Identity, current, propagate
from failproofai_sdk._runtime import event
from failproofai_sdk._scopes import agent, session, tool_call
from failproofai_sdk._writer import _validated_interval
from failproofai_sdk import _runtime

__all__ = [
    "__version__",
    "configure",
    "event",
    "session",
    "agent",
    "tool_call",
    "current",
    "Identity",
    "propagate",
    "instrument",
    "uninstrument",
    "_writer",
]


def configure(
    *,
    base_dir=None,
    flush_interval: float = 0.5,
    environment: str | None = None,
) -> None:
    """Configure the SDK. Call once at startup before any event.* calls.

    Args:
        base_dir: Override the spool root. Pass None to resolve it:
                  $AGENTEYE_HOME if set, else ~/.failproofai/custom-agents
                  (honouring $FAILPROOFAI_HOME).

                  The default moved here from ~/.agenteye. `failproofaid`
                  watches both roots, so on a host running it this only
                  changes which directory the files appear in, and batches
                  already spooled under the old root are still collected.
                  A host running the older `agenteye-collector` — which reads
                  $AGENTEYE_HOME or ~/.agenteye and nothing else — sets
                  AGENTEYE_HOME=~/.agenteye.
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
    _runtime.writer.set_flush_interval(flush_interval)
    set_environment(environment)


def instrument(framework: str | None = None, **options: Any):
    """Install the framework adapters.

    With no argument, auto-detects the frameworks already imported in this
    process. Pass a name (`"langchain"`, `"crewai"`, `"llama_index"`,
    `"pydantic_ai"`) to install exactly one.

    The import is inside the function on purpose: `failproofai_sdk.integrations`
    reaches for framework packages, and `import failproofai_sdk` is
    contractually zero-dependency — a promise `tests/test_zero_dependencies.py`
    enforces both by scanning the core modules and by launching a fresh
    interpreter to prove no framework lands in `sys.modules`.
    """
    from failproofai_sdk.integrations import instrument as _impl

    return _impl(framework, **options)


def uninstrument(framework: str | None = None):
    """Reverse `instrument()`, restoring the original attributes.

    Lazy-imported for the same reason as `instrument()`.
    """
    from failproofai_sdk.integrations import uninstrument as _impl

    return _impl(framework)


# MUST be last: any `import failproofai_sdk.<sub>` binds the *module* onto this
# package as `failproofai_sdk._writer`. Rebinding it here to the instance is what
# keeps the published `failproofai_sdk._writer.flush_now()` recipe working — and
# is why a test reaching for the MODULE has to go through
# `sys.modules["failproofai_sdk._writer"]`.
_writer = _runtime.writer
