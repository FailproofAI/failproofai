"""Framework adapters: the registry behind `failproofai_sdk.instrument()`.

    import failproofai_sdk
    failproofai_sdk.instrument()            # every framework already imported
    failproofai_sdk.instrument("crewai")    # exactly one
    failproofai_sdk.uninstrument()          # put everything back

**This module is stdlib only, and imports no adapter until asked.** The registry
maps a name to a dotted module path *as a string*; `importlib.import_module`
runs on demand. That is what keeps `import failproofai_sdk` free of LangChain.

Auto-detection reads `sys.modules`, deliberately **not**
`importlib.util.find_spec`. `find_spec` would report "installed", and acting on
that means importing a framework the user is not using — 200ms and a pile of
transitive imports charged to a library that was supposed to be invisible. If
the framework is not imported, there is nothing to instrument.

Writing an adapter
------------------
A module registered here must expose a module-level object named `adapter`
implementing `failproofai_sdk.integrations._core.Adapter`:

    name: str          # the registry name
    module: str        # the framework module auto-detect looks for in sys.modules
    def install(**options) -> None
    def uninstall() -> None

`install()` must save the **original attribute object** it replaces — use
`_core.Patcher`, which also does the "somebody patched on top of us" check — and
`uninstall()` must restore that saved object. Never re-import to restore: that
hands back whatever the current value happens to be, which is how two
instrumentation libraries silently un-patch each other.

Every callback the adapter hands to the framework goes through `_core.safe`, and
every event goes through a `_core.RunTracker`. Adapters own the translation
table and nothing else.

The four names are registered here **now**, before their modules exist, so that
adding an adapter is one new file rather than an edit to this one.
"""

import importlib
import logging
import sys
import threading
from typing import Any

from failproofai_sdk.integrations import _compat, _core
from failproofai_sdk.integrations._core import Adapter

logger = logging.getLogger("failproofai_sdk.integrations")

__all__ = ["instrument", "uninstrument", "active", "available"]

# name -> dotted module path. A string, imported on demand.
_REGISTRY: dict[str, str] = {
    "langchain": "failproofai_sdk.integrations.langchain",
    "crewai": "failproofai_sdk.integrations.crewai",
    "llama_index": "failproofai_sdk.integrations.llama_index",
    "pydantic_ai": "failproofai_sdk.integrations.pydantic_ai",
}

# Spellings people actually type. LangGraph is served by the LangChain adapter
# because LangGraph runs on langchain-core's callback manager.
_ALIASES: dict[str, str] = {
    "langgraph": "langchain",
    "langchain_core": "langchain",
    "llamaindex": "llama_index",
    "llama-index": "llama_index",
    "pydantic-ai": "pydantic_ai",
    "pydanticai": "pydantic_ai",
}

# name -> the framework modules whose presence in sys.modules means "this
# framework is in use". Kept here rather than read off `adapter.module` so that
# detection imports nothing at all, not even our own adapter module.
_DETECT: dict[str, tuple[str, ...]] = {
    "langchain": ("langchain_core", "langchain", "langgraph"),
    "crewai": ("crewai",),
    "llama_index": ("llama_index", "llama_index.core"),
    "pydantic_ai": ("pydantic_ai",),
}

# Guards _ACTIVE and every install/uninstall. `instrument()` is called from
# application startup, which in a web server can be several threads at once.
_LOCK = threading.Lock()
_ACTIVE: dict[str, Adapter] = {}


def available() -> tuple[str, ...]:
    """Every registry name that can be instrumented, aliases excluded."""
    return tuple(sorted(_REGISTRY))


def active() -> tuple[str, ...]:
    """Names currently instrumented."""
    with _LOCK:
        return tuple(sorted(_ACTIVE))


def _canonical(name: str) -> str:
    key = str(name).strip().lower().replace(" ", "")
    key = _ALIASES.get(key, key)
    if key not in _REGISTRY:
        valid = ", ".join(sorted(set(_REGISTRY) | set(_ALIASES)))
        raise ValueError(
            f"failproofai_sdk: unknown framework {name!r}. Valid names are: {valid}. "
            f"(Call failproofai_sdk.instrument() with no argument to auto-detect.)"
        )
    return key


def _detected() -> list[str]:
    """Registry names whose framework is already imported in this process."""
    found = []
    for name in _REGISTRY:
        modules = _DETECT.get(name, (name,))
        if any(module in sys.modules for module in modules):
            found.append(name)
    return found


def _load(name: str) -> Adapter:
    module = importlib.import_module(_REGISTRY[name])
    adapter = getattr(module, "adapter", None)
    if adapter is None:
        # A module that is itself the adapter is fine too; the attribute is the
        # convention, not the contract.
        adapter = module
    for attribute in ("install", "uninstall"):
        if not callable(getattr(adapter, attribute, None)):
            raise TypeError(
                f"failproofai_sdk: adapter {_REGISTRY[name]!r} does not implement "
                f"{attribute}() — see failproofai_sdk.integrations._core.Adapter."
            )
    return adapter  # type: ignore[return-value]


def instrument(framework: str | None = None, **options: Any) -> tuple[str, ...]:
    """Install the adapters. Returns the names newly instrumented.

    With no argument, instruments every framework already imported in this
    process. Instrumenting something already active is a no-op that returns
    `()`, so calling this from two code paths (or from a reloading dev server)
    cannot double-record.

    An unknown name raises `ValueError` listing the valid ones — a typo that
    silently records nothing is the worst outcome available. An adapter whose
    `install()` raises is logged and skipped; the others still install, because
    a broken LlamaIndex should not cost you LangGraph. `FAILPROOFAI_SDK_STRICT=1` turns
    that skip back into a raise.
    """
    if framework is None:
        names = _detected()
        if not names:
            # WARNING, not debug. This fires only when somebody explicitly asked
            # for instrumentation and got none — the import-order mistake of
            # calling instrument() above the `import langchain` line — and the
            # result is a process that records nothing at all, with the adapter
            # installed and the docs followed. At debug level the message that
            # names the exact fix was invisible under every default logging
            # config, which made the one mistake that costs you all your
            # telemetry the one mistake we said nothing about.
            logger.warning(
                "failproofai_sdk: instrument() found no supported framework in sys.modules, "
                "so NOTHING was instrumented. Import your framework before calling "
                "instrument(), or name one explicitly: %s.",
                # The names this call would have accepted, rather than one
                # hardcoded example. A reader who is not using CrewAI has to
                # work out for themselves whether the message is a suggestion
                # or a diagnosis, which is a poor use of the one line they get.
                ", ".join(f"instrument({name!r})" for name in sorted(_REGISTRY)),
            )
    else:
        names = [_canonical(framework)]

    installed: list[str] = []
    with _LOCK:
        for name in names:
            if name in _ACTIVE:
                continue
            adapter = None
            try:
                adapter = _load(name)
                adapter.install(**options)
            except Exception as exc:
                # An install is NOT atomic, so a failure part-way through leaves
                # global state behind. `langchain.install()` sets `_STATE.enabled`,
                # registers an append-only configure hook whose own uninstall
                # comment says "There is no deregister API", builds the tracer and
                # exports an env var — and only THEN probes a capability that can
                # raise (a `_compat.probe` under FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1
                # always does). Catching here left the adapter fully patched and
                # never recorded in `_ACTIVE`, so `active()` denied it existed and
                # `uninstrument()` — which iterates `_ACTIVE` — could never undo it.
                # It recorded for the life of the process and could not be removed.
                if adapter is not None:
                    try:
                        adapter.uninstall()
                    except Exception:
                        logger.debug(
                            "failproofai_sdk: rollback of a failed %r install did not "
                            "complete cleanly",
                            name,
                            exc_info=True,
                        )
                if _core.strict():
                    raise
                # `FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1` is documented as the
                # supported way to make a compat problem loud — `_compat.py`'s
                # own docstring calls warn-by-default "only defensible because
                # there is a supported way to make it fail loudly". It was not
                # one: the flag makes `_compat.warn` RAISE, this handler caught
                # it, and the operator got neither behaviour — not the raise the
                # flag promises, and not the best-effort instrumentation the
                # warning text promises ("Instrumenting anyway"). An adapter
                # silently recorded nothing while the log said it was fine.
                if isinstance(exc, _compat.FailproofAICompatWarning) and (
                    _compat.strict_integrations()
                ):
                    raise
                logger.warning(
                    "failproofai_sdk: could not instrument %r; the rest of your process is "
                    "unaffected and other adapters still installed. Set "
                    "FAILPROOFAI_SDK_STRICT=1 to raise instead.",
                    name,
                    exc_info=True,
                )
                continue
            _ACTIVE[name] = adapter
            installed.append(name)
    return tuple(installed)


def uninstrument(framework: str | None = None) -> tuple[str, ...]:
    """Reverse `instrument()`. Returns the names removed. Never raises.

    With no argument, removes everything. An unknown name, or a name that was
    never instrumented, is a no-op — teardown that can fail is teardown people
    stop calling.
    """
    if framework is None:
        with _LOCK:
            names = list(_ACTIVE)
    else:
        try:
            names = [_canonical(framework)]
        except ValueError as exc:
            logger.warning("%s", exc)
            return ()

    removed: list[str] = []
    with _LOCK:
        for name in names:
            adapter = _ACTIVE.pop(name, None)
            if adapter is None:
                continue
            try:
                adapter.uninstall()
            except Exception:
                logger.warning(
                    "failproofai_sdk: %r did not uninstall cleanly; it is no longer "
                    "registered, but some patches may remain.",
                    name,
                    exc_info=True,
                )
            removed.append(name)
        if not _ACTIVE:
            # Nothing is instrumented any more, so a later instrument() starts
            # from a clean slate rather than inheriting a degraded call site or
            # a warning that has "already been shown".
            _core.reset_failures()
            _compat.reset_warnings()
    return tuple(removed)
