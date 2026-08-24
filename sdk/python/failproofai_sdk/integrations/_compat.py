"""Version and capability probes for the framework adapters.

Extras (`failproofai_sdk[langchain]`) express a *floor*, not enforcement: most users
already have the framework and will never install an extra. So the real check
happens here, at `instrument()` time, in three tiers:

1. **framework not importable** -> a hard `ImportError` whose message contains
   the literal install command. Instrumenting is an explicit user action, so
   silently doing nothing is never the right answer.
2. **importable but outside the declared range** -> `FailproofAICompatWarning`,
   once, then best-effort. A ceiling exists because without one a clean build a
   year from now pulls the next major, the callback API shifts, and the adapter
   stops receiving events *while raising nothing*.
3. **a capability probe fails** -> warn and no-op **that hook only**, never the
   whole adapter.

`FAILPROOFAI_SDK_STRICT_INTEGRATIONS=1` promotes every warning here to an exception.
Warn-by-default is only defensible because there is a supported way to make it
fail loudly.

Why the version comparison is naive
-----------------------------------
`import failproofai_sdk` is contractually zero-dependency, so this cannot use
`packaging`. `parse_version` therefore reads the **leading numeric components
only** and stops at the first component that is not purely numeric:

    "1.5.2"      -> (1, 5, 2)
    "2.0.0b1"    -> (2, 0, 0)      # pre-release suffix ignored
    "0.14.23.post1" -> (0, 14, 23) # local/post segments ignored
    "1.2.dev0"   -> (1, 2)

That means `2.0.0b1` compares **equal** to `2.0.0`, so a pre-release of a major
we have declared a ceiling against will not be flagged. That is deliberate:
the alternative is shipping a PEP 440 parser, and being wrong about a release
candidate is much cheaper than a runtime dependency.

Versions are always read with `importlib.metadata.version(dist)` and **never**
`module.__version__` — that attribute is not guaranteed to exist and several of
the frameworks we target do not define it.
"""

import importlib
import importlib.metadata
import logging
import os
import threading
import warnings
from types import ModuleType
from typing import Any, Callable

logger = logging.getLogger("failproofai_sdk.integrations")

__all__ = [
    "FailproofAICompatWarning",
    "parse_version",
    "version_string",
    "version_tuple",
    "require_module",
    "check_version",
    "probe",
    "warn",
    "strict_integrations",
    "set_strict_integrations",
    "reset_warnings",
]


class FailproofAICompatWarning(UserWarning):
    """A framework is outside the range this adapter was written against."""


_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _env_flag(name: str) -> bool:
    """Read a boolean env var. Shared with `_core` so both flags parse alike."""
    return os.environ.get(name, "").strip().lower() in _TRUTHY


# Cached, because it is read on every warning and every `safe()` failure, and
# resettable, because a test that cannot flip the switch cannot test the policy.
# Same shape as `failproofai_sdk._environment`: a module global that overrides the env
# var, with None meaning "not decided yet, go look".
_strict_integrations: bool | None = None


def strict_integrations() -> bool:
    global _strict_integrations
    if _strict_integrations is None:
        _strict_integrations = _env_flag("FAILPROOFAI_SDK_STRICT_INTEGRATIONS")
    return _strict_integrations


def set_strict_integrations(value: bool | None) -> None:
    """Override the flag. `None` re-reads `FAILPROOFAI_SDK_STRICT_INTEGRATIONS`."""
    global _strict_integrations
    _strict_integrations = value


_warned: set[str] = set()
_warn_lock = threading.Lock()


def reset_warnings() -> None:
    """Forget which warnings have already fired (tests; also `uninstrument()`)."""
    with _warn_lock:
        _warned.clear()


def warn(message: str, *, key: str | None = None) -> None:
    """Warn once per `key`, or raise if strict.

    Deduplicated because these fire from `install()` *and* from hot callbacks:
    a per-call warning on a chatty framework is its own outage.
    """
    if strict_integrations():
        raise FailproofAICompatWarning(message)
    dedup = key or message
    with _warn_lock:
        if dedup in _warned:
            return
        _warned.add(dedup)
    warnings.warn(message, FailproofAICompatWarning, stacklevel=3)
    logger.warning("%s", message)


def parse_version(text: str) -> tuple[int, ...]:
    """Leading numeric components of a version string. See the module docstring."""
    parts: list[int] = []
    for chunk in str(text).split("."):
        digits = ""
        for ch in chunk:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            break
        parts.append(int(digits))
        if len(digits) != len(chunk):
            # A partially numeric component ("0b1", "dev0", "post1") ends the
            # numeric prefix — everything after it is a pre/post/local segment.
            break
    return tuple(parts)


def version_string(dist: str) -> str | None:
    """The installed version of a distribution, or None if it is not installed.

    `dist` is the *distribution* name (`langchain-core`), which is frequently
    not the module name (`langchain_core`).
    """
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:  # pragma: no cover - a broken METADATA must not break us
        logger.debug("failproofai_sdk: could not read version of %r", dist, exc_info=True)
        return None


def version_tuple(dist: str) -> tuple[int, ...] | None:
    text = version_string(dist)
    return parse_version(text) if text else None


def require_module(module: str, *, dist: str, extra: str) -> ModuleType:
    """Import a framework module or raise with the literal install command.

    Tier 1. `instrument("langchain")` on a machine without LangChain is a
    mistake the user can fix in one command, so we hand them the command.
    """
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        raise ImportError(
            f"failproofai_sdk: cannot instrument {extra!r} because {module!r} is not importable. "
            f"Install it with:  pip install 'failproofai_sdk[{extra}]'  "
            f"(or install {dist} directly)."
        ) from exc


def check_version(
    framework: str,
    dist: str,
    *,
    minimum: str | None = None,
    below: str | None = None,
    reason: str | None = None,
) -> bool:
    """Tier 2. True when `dist` is inside [minimum, below); warns once if not.

    Returns True (best effort) for an unknown version too — a framework
    installed from a git checkout has no usable metadata, and refusing to
    instrument it would be a worse answer than trying.
    """
    found = version_string(dist)
    if found is None:
        return True
    got = parse_version(found)
    if not got:
        return True

    if minimum is not None and got < parse_version(minimum):
        warn(
            f"failproofai_sdk: {dist} {found} is older than the {minimum} this {framework} "
            f"adapter was written against"
            + (f" ({reason})" if reason else "")
            + ". Instrumenting anyway; some events may be missing.",
            key=f"{framework}:{dist}:min",
        )
        return False
    if below is not None and got >= parse_version(below):
        warn(
            f"failproofai_sdk: {dist} {found} is newer than the <{below} this {framework} "
            f"adapter was written against. Instrumenting anyway, but a callback API "
            f"change would make it stop recording silently — please report this.",
            key=f"{framework}:{dist}:max",
        )
        return False
    return True


def probe(framework: str, hook: str, check: Callable[[], Any]) -> bool:
    """Tier 3. Run a capability probe; on failure warn and disable ONE hook.

        if probe("langchain", "on_interrupt", lambda: langgraph.callbacks.GraphCallbackHandler):
            ...wire it up...

    A missing capability is never a reason to abandon the whole adapter: the
    other 90% of the events are still correct and still worth having.
    """
    try:
        ok = bool(check())
    except Exception as exc:
        warn(
            f"failproofai_sdk: {framework} capability probe for {hook!r} failed ({exc!r}); "
            f"that hook is disabled, the rest of the adapter is unaffected.",
            key=f"{framework}:{hook}",
        )
        return False
    if not ok:
        warn(
            f"failproofai_sdk: {framework} does not provide {hook!r} in this version; "
            f"that hook is disabled, the rest of the adapter is unaffected.",
            key=f"{framework}:{hook}",
        )
    return ok
