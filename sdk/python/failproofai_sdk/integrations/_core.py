"""The parts every framework adapter shares: failure policy, patching, identity.

An adapter under `failproofai_sdk/integrations/` is supposed to be a **translation
table** and nothing else. Everything that is genuinely hard — never raising into
the customer's call stack, restoring exactly what we replaced, mapping a
framework's run ids onto Failproof AI identity, keeping payloads inside the store's
patience — lives here, in one copy. If an adapter needs something added to this
module, that is a signal the core is wrong, not that the adapter is special.

Three things in here are load-bearing and easy to "fix" into a bug:

* `safe()` catches `Exception`, **never `BaseException`** — see the comment on
  it before you change that.
* `RunTracker` never touches contextvars. `ContextVar.reset(token)` raises
  across asyncio tasks as well as threads, so a callback surface whose start and
  end are separate calls can never hold a token between them.
* `fw_fields()` is a safety rule, not a style rule. `_schema._build()` merges
  extra fields **last**, so an extra named `tool_name` silently overwrites the
  declared one and changes the promoted column.
"""

import dataclasses
import functools
import logging
import re
import threading
import uuid
from collections.abc import Mapping, Sequence
from collections.abc import Set as AbcSet
from typing import Any, Callable, Protocol

from failproofai_sdk import _context, _runtime, _schema
from failproofai_sdk._context import DEFAULT_AGENT_ID, Identity
from failproofai_sdk._events import _RESERVED
from failproofai_sdk._version import __version__
from failproofai_sdk.integrations import _compat

logger = logging.getLogger("failproofai_sdk.integrations")

__all__ = [
    "Adapter",
    "RunTracker",
    "Patcher",
    "safe",
    "call_safely",
    "wrap_callable",
    "is_wrapped",
    "unwrap",
    "strict",
    "set_strict",
    "reset_failures",
    "truncate",
    "payload",
    "fw_fields",
    "guard_extras",
    "framework_fields",
    "normalize_agent_id",
    "ms",
    "FIELD_LIMIT",
    "EVENT_BUDGET",
    "FORBIDDEN_EXTRAS",
]


# ---------------------------------------------------------------------------
# The adapter protocol
# ---------------------------------------------------------------------------

class Adapter(Protocol):
    """What `failproofai_sdk/integrations/<framework>.py` must expose as `adapter`.

    `module` is the framework module that must already be in `sys.modules` for
    auto-detection to pick this adapter up; the registry keeps its own copy of
    that mapping so detection never has to import anything.

    `install()` must save the **original attribute object** it replaces (use
    `Patcher`), and `uninstall()` must restore that saved object rather than
    re-importing or reconstructing it.
    """

    name: str
    module: str

    def install(self, **options: Any) -> None:
        pass

    def uninstall(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Failure policy
# ---------------------------------------------------------------------------

# Everything under `integrations/` obeys one rule: never raise into the
# customer's call stack. Observability that takes the process down with it is
# worse than no observability. FAILPROOFAI_SDK_STRICT=1 inverts that for tests and for
# debugging an adapter that has gone quiet — without it you can only ever prove
# "it didn't crash", never "it swallowed the right thing".
_strict: bool | None = None


def strict() -> bool:
    global _strict
    if _strict is None:
        _strict = _compat._env_flag("FAILPROOFAI_SDK_STRICT")
    return _strict


def set_strict(value: bool | None) -> None:
    """Override the flag. `None` re-reads `FAILPROOFAI_SDK_STRICT`."""
    global _strict
    _strict = value


# After this many failures at one call site we stop calling it. A broken adapter
# should cost one log line, not 40% of the process and a full disk.
_MAX_FAILURES = 3

_failures: dict[str, int] = {}
_disabled: set[str] = set()
_failure_lock = threading.Lock()


def reset_failures() -> None:
    """Re-enable every degraded call site (tests; also `uninstrument()`)."""
    with _failure_lock:
        _failures.clear()
        _disabled.clear()


def is_degraded(site: str) -> bool:
    return site in _disabled


def _site_of(fn: Callable[..., Any]) -> str:
    module = getattr(fn, "__module__", None) or "?"
    qualname = getattr(fn, "__qualname__", None) or getattr(fn, "__name__", None) or repr(fn)
    return f"{module}.{qualname}"


def call_safely(fn: Callable[..., Any], args: tuple, kwargs: dict, site: str) -> Any:
    """Call `fn`, swallowing `Exception` and degrading a repeatedly failing site.

    Catches `Exception` and **not** `BaseException` on purpose.
    `asyncio.CancelledError` has been a `BaseException` since Python 3.8, as is
    `KeyboardInterrupt` and `SystemExit`; swallowing those would silently break
    cancellation in every instrumented async application — the task gets
    cancelled, our handler eats the CancelledError, and the framework carries on
    running work that was supposed to stop. `GeneratorExit` is the same story
    for generators. If you are here to "fix" this to `BaseException`, don't.
    """
    if site in _disabled:
        return None
    try:
        return fn(*args, **kwargs)
    except Exception:
        if strict():
            raise
        count = 0
        newly_disabled = False
        with _failure_lock:
            count = _failures.get(site, 0) + 1
            _failures[site] = count
            if count >= _MAX_FAILURES and site not in _disabled:
                _disabled.add(site)
                newly_disabled = True
        if count == 1:
            # Logged once per site, with the traceback. Repeats are silent:
            # a hook that fails on every token of a streaming response would
            # otherwise become the log volume.
            logger.warning(
                "failproofai_sdk: instrumentation hook %s failed; the instrumented call was "
                "not affected. Set FAILPROOFAI_SDK_STRICT=1 to re-raise.",
                site,
                exc_info=True,
            )
        else:
            logger.debug("failproofai_sdk: instrumentation hook %s failed again (%d)", site, count)
        if newly_disabled:
            logger.error(
                "failproofai_sdk: instrumentation hook %s failed %d times and is now disabled "
                "for the rest of this process. Events from it will be missing.",
                site,
                count,
            )
        return None


def safe(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Decorator form of `call_safely`. Put it on every callback an adapter exposes."""
    site = _site_of(fn)

    @functools.wraps(fn)
    def _failproofai_safe(*args: Any, **kwargs: Any) -> Any:
        return call_safely(fn, args, kwargs, site)

    _failproofai_safe.__failproofai_safe__ = True  # type: ignore[attr-defined]
    return _failproofai_safe


def _safe_call(fn: Callable[..., Any] | None, *args: Any, **kwargs: Any) -> Any:
    if fn is None:
        return None
    return call_safely(fn, args, kwargs, _site_of(fn))


# ---------------------------------------------------------------------------
# Shape A — wrapper surfaces
# ---------------------------------------------------------------------------

def wrap_callable(
    original: Callable[..., Any],
    *,
    before: Callable[..., Any] | None = None,
    after: Callable[..., Any] | None = None,
    on_error: Callable[..., Any] | None = None,
) -> Callable[..., Any]:
    """Wrap a framework callable so start and end are one frame.

    * `before(*args, **kwargs)` -> an opaque ctx handed back to the others;
    * `after(ctx, result)`;
    * `on_error(ctx, exc)` — then the exception is re-raised, always.

    The structural guarantee, which is the whole reason this is a function and
    not hand-written try/except in five adapters: **the user's call sits in
    exactly one `try`, whose only job is to re-raise.** Nothing we do can change
    what the wrapped callable returns or raises, because every one of our own
    calls is outside that block and inside `call_safely`. That is auditable in
    nine lines, and there is a test asserting the exception comes back out with
    its `is` identity intact even when all three hooks raise.
    """

    @functools.wraps(original)
    def _failproofai_wrapper(*args: Any, **kwargs: Any) -> Any:
        ctx = _safe_call(before, *args, **kwargs)
        try:
            result = original(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - re-raised unconditionally
            _safe_call(on_error, ctx, exc)
            raise
        _safe_call(after, ctx, result)
        return result

    _failproofai_wrapper.__failproofai_wrapped__ = original  # type: ignore[attr-defined]
    return _failproofai_wrapper


def is_wrapped(obj: Any) -> bool:
    return hasattr(obj, "__failproofai_wrapped__")


def unwrap(obj: Any) -> Any:
    """The object we replaced, or `obj` itself if we never wrapped it."""
    return getattr(obj, "__failproofai_wrapped__", obj)


# ---------------------------------------------------------------------------
# Install / uninstall discipline
# ---------------------------------------------------------------------------

class Patcher:
    """Records what an `install()` replaced so `uninstall()` can put it back.

    Two rules, both of which exist because instrumentation libraries are
    routinely installed alongside each other:

    1. **Restore the saved object, never a re-import.** Re-importing to restore
       hands back whatever the *current* value of the attribute's source is,
       which is how two instrumentation libraries silently un-patch each other.
    2. **If the attribute is no longer ours, leave it alone.** Somebody patched
       on top of us; restoring would delete their patch. We log at WARNING and
       keep our record, so the customer can see it happened.
    """

    __slots__ = ("_records", "_lock")

    def __init__(self) -> None:
        self._records: list[tuple[Any, str, Any, Any, bool]] = []
        self._lock = threading.Lock()

    def patch(self, obj: Any, attr: str, new: Any) -> None:
        """Set `obj.attr = new`, remembering the exact object replaced."""
        existed = hasattr(obj, attr)
        original = getattr(obj, attr, None)
        try:
            new.__failproofai_wrapped__ = original
        except (AttributeError, TypeError):
            # builtins, slots, C functions — the marker is best-effort, the
            # identity check below falls back to `is` against what we stored.
            pass
        setattr(obj, attr, new)
        with self._lock:
            self._records.append((obj, attr, original, new, existed))

    def restore_all(self) -> None:
        """Undo every patch, newest first. Never raises."""
        with self._lock:
            records = list(reversed(self._records))
            self._records.clear()
        for obj, attr, original, installed, existed in records:
            try:
                current = getattr(obj, attr, None)
                if current is not installed:
                    logger.warning(
                        "failproofai_sdk: not restoring %s.%s — it is no longer the object "
                        "failproofai_sdk installed (something else patched on top). Leaving "
                        "the current value in place rather than deleting their patch.",
                        getattr(obj, "__name__", type(obj).__name__),
                        attr,
                    )
                    continue
                if existed:
                    setattr(obj, attr, original)
                else:
                    delattr(obj, attr)
            except Exception:
                logger.warning(
                    "failproofai_sdk: failed to restore %s.%s", obj, attr, exc_info=True
                )

    def __len__(self) -> int:
        return len(self._records)


# ---------------------------------------------------------------------------
# Payload discipline
# ---------------------------------------------------------------------------

TRUNCATION_MARKER = "…[truncated]"
FIELD_LIMIT = 8192

#: How many MAX-SIZE fields one event may carry before `payload()` starts
#: dropping keys. The budget is DERIVED from the field limit rather than being a
#: second independent number, because the two are not independent: raising one
#: without the other silently changes how much survives.
#:
#: Measured against real traffic before choosing it — a live event from each of
#: the five framework adapters carries 7-8 `fw_*` fields, so 16 leaves roughly
#: 2x headroom at the theoretical maximum. It matches the ratio the LangChain
#: adapter shipped with (32 KiB budget over a 2 KiB field limit), which is where
#: the number comes from; it is a preserved property, not a fresh guess.
#:
#: This matters because of HOW `payload()` runs out: past the budget it does not
#: shorten the next field, it OMITS THE KEY (see the `remaining <= 0` branch).
#: A caller raising `field_limit` therefore has to raise the budget in step or
#: it trades shortened values for missing ones, which is strictly worse — the
#: event stops saying that anything is absent.
_FIELDS_PER_EVENT = 16

EVENT_BUDGET = FIELD_LIMIT * _FIELDS_PER_EVENT
_MAX_ITEMS = 100
_MAX_DEPTH = 6


class _Cut:
    """Mutable 'did we cut anything' flag, threaded through the recursion."""

    __slots__ = ("hit",)

    def __init__(self) -> None:
        self.hit = False


def truncate(value: Any, limit: int = FIELD_LIMIT) -> Any:
    """Shrink a payload value to something a column store will tolerate.

    Framework payloads are prompts, retrieved documents and tool outputs — the
    three largest strings in the process. None of these are promoted columns, so
    querying them means `JSONExtract` over the payload, which has already caused
    a production memory blowup in the events store here. Payload discipline is not optional.
    """
    return _truncate(value, limit, _Cut(), 0)


def _truncate(value: Any, limit: int, cut: _Cut, depth: int) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= limit:
            return value
        cut.hit = True
        return value[: max(limit - len(TRUNCATION_MARKER), 0)] + TRUNCATION_MARKER
    if isinstance(value, bytes):
        return _truncate(value.decode("utf-8", "replace"), limit, cut, depth)
    if depth >= _MAX_DEPTH:
        cut.hit = True
        return _truncate(repr(value), limit, cut, _MAX_DEPTH)
    # `Mapping`/`Sequence`, not `dict`/`list`. The concrete types missed every
    # mapping a framework actually hands us that is not literally a dict —
    # `MappingProxyType` (what `model_json_schema()` and any frozen config
    # returns), `ChainMap`, and every third-party mapping — and those fell
    # through to the repr branch at the bottom. A tool's JSON schema then
    # reached the events store as the STRING
    # `"mappingproxy({'title': 'From Unit', 'type': 'string'})"`: valid JSON
    # holding a Python repr, so `JSONExtract` over it returns nothing and the
    # field is unqueryable rather than merely ugly. Verified in a real stored
    # row — a crewai `model_request.tools[0]…properties.from_unit`.
    if isinstance(value, Mapping):
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= _MAX_ITEMS:
                cut.hit = True
                out["…"] = f"[{len(value) - _MAX_ITEMS} more keys truncated]"
                break
            out[str(k)] = _truncate(v, limit, cut, depth + 1)
        return out
    # `str`/`bytes` are Sequences too and are handled above, so they cannot
    # reach here; `Set` is a separate ABC and is not a `Sequence`.
    if isinstance(value, (Sequence, AbcSet)):
        items = list(value)
        out_list = [_truncate(v, limit, cut, depth + 1) for v in items[:_MAX_ITEMS]]
        if len(items) > _MAX_ITEMS:
            cut.hit = True
            out_list.append(f"[{len(items) - _MAX_ITEMS} more items truncated]")
        return out_list
    # A dataclass or a pydantic model is DATA, and every framework hands us
    # them: a tool's argument model, its structured return, a settings object on
    # a model request. They have no JSON shape by the checks above, so they were
    # rendered — `Weather(city='Faro', celsius=21)` — which is a Python repr
    # sitting inside a JSON string, unqueryable by `JSONExtract` and unfilterable
    # in the dashboard. Each adapter was starting to unwrap them itself; doing it
    # once here means an adapter that has not thought about it still records
    # something readable.
    shaped = _as_mapping(value)
    if shaped is not None:
        # Same depth, not depth + 1: the object is REPLACED by its mapping
        # rather than nested inside one, and the Mapping branch above does the
        # descending (and the per-field limits) from here.
        return _truncate(shaped, limit, cut, depth)

    # An object with no JSON shape is rendered, not cut — `fw_truncated` means
    # "data was lost", and a repr that fits has lost nothing a JSON encoder
    # would have kept.
    return _truncate(repr(value), limit, cut, _MAX_DEPTH)


def _as_mapping(value: Any) -> "dict | None":
    """A dataclass instance or pydantic model as a plain dict, or None.

    Shallow on purpose. `dataclasses.asdict` and `model_dump` both recurse and
    both COPY, so on a large object they duplicate the whole tree before
    `_truncate` gets to decide it only wanted the first 8 KB. Reading the top
    level and handing it back lets the existing walk apply the field limit, the
    item cap and the depth cap on the way down, as it does for a dict.

    Everything here can execute the caller's own code — a pydantic validator, a
    property behind `getattr` — so all of it is guarded, and a failure falls
    through to `repr`, which is what happened before this existed.
    """
    if isinstance(value, type):  # the CLASS, not an instance of it
        return None
    if dataclasses.is_dataclass(value):
        try:
            return {f.name: getattr(value, f.name) for f in dataclasses.fields(value)}
        except Exception:
            return None
    # `model_dump` and not `dict`: pydantic v2 names it distinctively, whereas
    # half the objects in a typical process have some attribute called `dict`
    # and calling it would be a coin flip.
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump()
        except Exception:
            return None
        return dumped if isinstance(dumped, Mapping) else None
    return None


def _size(value: Any, _depth: int = 0) -> int:
    if value is None or isinstance(value, (bool, int, float)):
        return 8
    if isinstance(value, str):
        return len(value)
    if _depth >= _MAX_DEPTH:
        return len(repr(value))
    # Same ABCs as `_truncate`, for the same reason: a size computed off `repr`
    # for a value that `_truncate` will expand into JSON budgets the wrong
    # number, and the budget is what decides which fields survive.
    if isinstance(value, Mapping):
        return sum(len(str(k)) + _size(v, _depth + 1) for k, v in value.items())
    if isinstance(value, (Sequence, AbcSet)):
        return sum(_size(v, _depth + 1) for v in value)
    return len(repr(value))


def payload(fields: dict, *, limit: int = FIELD_LIMIT, budget: int = EVENT_BUDGET) -> dict:
    """Apply the per-field limit and the per-event budget to a dict of extras.

    Anything cut sets `fw_truncated=True`, so a surprising-looking payload in
    the dashboard is self-explaining rather than a mystery.
    """
    out: dict[str, Any] = {}
    remaining = budget
    cut = _Cut()
    for key, value in fields.items():
        shrunk = _truncate(value, limit, cut, 0)
        if remaining <= 0:
            cut.hit = True
            continue
        size = _size(shrunk)
        if size > remaining:
            cut.hit = True
            shrunk = _truncate(shrunk, remaining, cut, 0)
            size = _size(shrunk)
        remaining -= size
        out[key] = shrunk
    if cut.hit:
        out["fw_truncated"] = True
    return out


# Every field name declared on any event dataclass, plus the five names
# `_events._RESERVED` blocks. Derived rather than hand-listed so that adding a
# field to `_schema.py` cannot leave a stale copy here.
def _declared_field_names() -> frozenset[str]:
    names: set[str] = set(_RESERVED)
    for obj in vars(_schema).values():
        if dataclasses.is_dataclass(obj) and isinstance(obj, type):
            names.update(f.name for f in dataclasses.fields(obj))
    names.discard("extra_fields")
    return frozenset(names)


# Deliberate exceptions: these are top-level by design. `duration_ms` is how an
# adapter reports a model call's real latency (it is not a declared parameter of
# `model_response`, and `durationOf` prefers it); `usage` is read by both the
# server summary and the dashboard as a token fallback; `request_id` pairs
# model events; `framework*` label every event.
ALLOWED_TOP_LEVEL = frozenset(
    {
        "request_id",
        "duration_ms",
        "usage",
        "traceback",
        "framework",
        "framework_version",
        "integration_version",
    }
)

# An extra whose name collides with a declared field SILENTLY OVERWRITES it:
# `_schema._build()` ends with `result.update(extra)`. An adapter reflecting a
# framework's kwargs into extras would then change `tool_name`, `model`,
# `outcome` or `input_tokens` — i.e. the promoted columns and the
# server's computed summary — and every test would still pass.
FORBIDDEN_EXTRAS = _declared_field_names() - ALLOWED_TOP_LEVEL

_FW_PREFIX = "fw_"


def fw_fields(**kw: Any) -> dict:
    """Build the `fw_*` extra-field namespace.

        fw_fields(run_id=run_id, node="retrieve", tags=None)
        -> {"fw_run_id": "...", "fw_node": "retrieve"}

    Keys are prefixed unless they already are, or are one of the deliberate
    top-level names. `None` values are dropped (the schema omits None optionals
    anyway, and an extra explicitly set to None would still occupy a key).
    Values go through `truncate`. Flat only — `payload_key_expr` on the server
    is single-level, so a nested dict is not queryable.
    """
    out: dict[str, Any] = {}
    for key, value in kw.items():
        if value is None:
            continue
        if key in ALLOWED_TOP_LEVEL or key.startswith(_FW_PREFIX):
            name = key
        else:
            name = _FW_PREFIX + key
        out[name] = truncate(value)
    return guard_extras(out)


def guard_extras(fields: dict) -> dict:
    """Strip (or, in strict mode, reject) extras that would shadow a real field.

    Called on every emit, so even an adapter that builds its extras by hand
    cannot silently rewrite a promoted column.
    """
    bad = FORBIDDEN_EXTRAS & fields.keys()
    if not bad:
        return fields
    names = sorted(bad)
    message = (
        f"failproofai_sdk: extra fields {names} would overwrite declared event fields "
        f"(schema merges extras last). Namespace them as fw_* instead."
    )
    if strict():
        raise ValueError(message)
    logger.warning("%s Dropping them.", message)
    return {k: v for k, v in fields.items() if k not in bad}


def framework_fields(name: str, dist: str | None = None) -> dict:
    """The `framework` / `framework_version` / `integration_version` triple.

    Payload-only, so **not** server-side filterable; promoting it later is a
    five-file hand-mirrored change, so it is done on demand, not speculatively.
    """
    out = {"framework": name, "integration_version": __version__}
    version = _compat.version_string(dist) if dist else None
    if version:
        out["framework_version"] = version
    return out


_ID_SEPARATORS = re.compile(r"[\s\-_.:/]+")
_EMBEDDED_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                            r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_HEX = frozenset("0123456789abcdefABCDEF")
_AGENT_ID_LIMIT = 64


def normalize_agent_id(raw: Any, default: str = DEFAULT_AGENT_ID) -> str:
    """Turn a framework's label into something safe for `agent_id`.

    `agent_id` is a `LowCardinality(String)` column and the primary facet on
    every dashboard surface. A UUID in it poisons that facet permanently —
    LowCardinality degrades, and the filter dropdown fills with one entry per
    run. So a value that looks like an id becomes `default` and the real id goes
    to `fw_agent_id` / `fw_run_id` where it belongs.
    """
    if raw is None:
        return default
    text = " ".join(str(raw).split())
    if not text:
        return default
    if _looks_like_id(text):
        return default
    text = _strip_embedded_id(text)
    if not text:
        return default
    return text[:_AGENT_ID_LIMIT]


def _looks_like_id(text: str) -> bool:
    """True for UUIDs and long bare hex strings."""
    try:
        uuid.UUID(text)
        return True
    except (ValueError, AttributeError, TypeError):
        pass
    bare = text.replace("-", "").replace("_", "")
    return len(bare) >= 16 and all(c in _HEX for c in bare)


def _strip_embedded_id(text: str) -> str:
    """Drop a per-run id that a readable prefix is carrying.

    `_looks_like_id` only fires on a value that is an id ALL THE WAY THROUGH, so
    it caught a bare UUID and missed `agent-<uuid>`, `crew_<uuid>`,
    `task-3f9a1c…` — a readable name with a per-run suffix, which is the shape
    frameworks actually produce and precisely the one the docs warn against
    ("a role containing a UUID, timestamp, or per-run suffix"). Those went
    through untouched, one distinct value per run, into a
    `LowCardinality(String)` column that is the primary facet on every dashboard
    surface. That is the same poisoning the whole-string guard exists to stop,
    reached by the more common route.

    Stripping rather than falling back to `default`: `agent-<uuid>` still knows
    it is an agent, and collapsing every such label to `main` would throw away
    the one readable thing in it. A segment is dropped only if it is a UUID or a
    hex run of 16+ characters, so a name like `agent-v2` or `step-3` is
    untouched — and a value with nothing left after stripping falls back, which
    is what the caller wanted for a bare id anyway.
    """
    # Dashed UUIDs first, and as a substring: splitting on separators would
    # break `task-3f9a1c2b-...` into five segments none of which is an id on its
    # own, so the most standard shape of all would survive the segment pass.
    stripped = _EMBEDDED_UUID.sub(" ", text)
    parts = [p for p in _ID_SEPARATORS.split(stripped) if p]
    kept = [p for p in parts if not _looks_like_id(p)]
    # Nothing was an id: hand back the ORIGINAL, separators and all. Rejoining
    # on spaces would rewrite every `node_a_b` in the process into `node a b`,
    # which is a rename of the primary facet in exchange for nothing. (The
    # empty segments a leading or trailing separator produces are dropped
    # before the comparison, or `node_x_` alone would look like a change.)
    if stripped == text and len(kept) == len(parts):
        return text
    return " ".join(kept).strip()


def ms(delta_seconds: Any) -> int:
    """Whole milliseconds, as an `int`.

    The server stores `duration_ms` as a u32 and its JSON parser drops floats
    (`as_u64()` -> None), so a float silently NULLs the column: the dashboard
    then shows no duration and nobody sees an error. Negative deltas (clock
    adjustments, a framework handing us an end before its start) clamp to 0.
    """
    seconds = getattr(delta_seconds, "total_seconds", None)
    value = seconds() if callable(seconds) else float(delta_seconds)
    return max(round(value * 1000), 0)


# ---------------------------------------------------------------------------
# Shape B — callback surfaces
# ---------------------------------------------------------------------------

@dataclasses.dataclass(slots=True)
class _Run:
    identity: Identity
    parent_key: Any


class RunTracker:
    """Maps a framework's own run ids onto Failproof AI identity.

    This is Shape B: the surface where a start and its end are **separate
    callbacks**, possibly on different threads (CrewAI dispatches handlers on a
    ten-worker pool) or different asyncio tasks. Such an adapter can never use
    contextvars — `ContextVar.reset(token)` raises `ValueError: Token was created
    in a different Context` across tasks as well as threads, so a token cannot be
    held between two callbacks. Instead we keep the mapping here and pass
    `session_id=` / `agent_id=` **explicitly** on every emit.

    Bounded (`max_open`, FIFO eviction) because orphaned starts are normal: a
    crashed run, a stream nobody consumed, a framework that forgot an end
    callback. Unbounded, that is a memory leak in a long-lived server.
    """

    __slots__ = (
        "name", "_max_open", "_base_fields", "_runs", "_links", "_lock", "_warned",
        "_field_limit", "_budget",
    )

    def __init__(
        self,
        name: str,
        *,
        max_open: int = 10_000,
        base_fields: dict | None = None,
        field_limit: int | None = None,
    ) -> None:
        self.name = name
        self._max_open = max_open
        self._base_fields = dict(base_fields or {})
        # One place decides how much of a value survives, for both halves of an
        # event: the declared parameters (`input`, `output`, `messages`) and the
        # `fw_*` extras. They used to be truncated by two different rules — the
        # adapter's own constant on the way in, `FIELD_LIMIT` here — so an
        # adapter that tightened its limit still had its declared fields cut at
        # the core default, and raising the adapter's constant changed only half
        # the event.
        self._field_limit = FIELD_LIMIT if field_limit is None else int(field_limit)
        self._budget = self._field_limit * _FIELDS_PER_EVENT
        self._runs: dict[Any, _Run] = {}
        self._links: dict[Any, Any] = {}
        # RLock: `start_agent` resolves a parent while already holding it.
        self._lock = threading.RLock()
        self._warned = False

    # -- identity ---------------------------------------------------------

    def identity(self, key: Any, parent_key: Any = None, *, warn: bool = True) -> Identity | None:
        """Resolve a run to an Failproof AI identity, in this order:

        1. the exact `key`;
        2. the `parent_key` chain, walked through every link we have seen — a
           framework's own parent_run_id is a *better* parent chain than a
           contextvar stack, because it survives task hops and thread pools;
        3. **`failproofai_sdk.current()`** — this is the whole interop story. An
           adapter running inside a hand-written `with failproofai_sdk.agent("planner")`
           joins that same session and gets `parent_id="planner"`, so mixing the
           manual API and an adapter produces one tree, not two;
        4. otherwise the event is dropped and we log **once**.
        """
        with self._lock:
            if key is not None:
                run = self._runs.get(key)
                if run is not None:
                    return run.identity
            walked = self._walk(parent_key)
        if walked is not None:
            return walked

        ambient = self._ambient(coerce_agent=True)
        if ambient is not None:
            return ambient

        if warn:
            self._warn_unresolved(key)
        return None

    @staticmethod
    def _ambient(*, coerce_agent: bool) -> Identity | None:
        """Step 3: the identity a hand-written scope has bound, if any.

        The one copy of this. When resolving an event we coerce a missing
        agent_id to `main`, but when resolving a *parent* we must not: inside a
        bare `with failproofai_sdk.session(...)` there is no open agent, and claiming
        `parent_id="main"` would point at an agent that never emitted an
        `agent_start` — which makes the dashboard synthesize a never-ending root
        span that stays `ongoing` forever.
        """
        cur = _context.current()
        if cur.session_id is None:
            return None
        return Identity(
            session_id=cur.session_id,
            agent_id=cur.agent_id or (DEFAULT_AGENT_ID if coerce_agent else None),
            parent_id=cur.parent_id,
            depth=cur.depth,
        )

    def _walk(self, parent_key: Any) -> Identity | None:
        """Caller holds the lock."""
        seen: set[Any] = set()
        key = parent_key
        while key is not None and key not in seen:
            seen.add(key)
            run = self._runs.get(key)
            if run is not None:
                return run.identity
            key = self._links.get(key)
        return None

    def _warn_unresolved(self, key: Any) -> None:
        if self._warned:
            return
        self._warned = True
        logger.warning(
            "failproofai_sdk: %s could not resolve a session for run %r and is dropping its "
            "events. Wrap the call in `with failproofai_sdk.session():` (or "
            "`with failproofai_sdk.agent(...):`) if you want them attributed. This is logged "
            "once per tracker.",
            self.name,
            key,
        )

    def link(self, key: Any, parent_key: Any) -> None:
        """Record a run's parent without making it an agent.

        Intermediate framework runs (a LangChain chain, a CrewAI task) do not
        become Failproof AI spans, but their children still need to find the agent
        above them. This is what makes step 2 of `identity()` work more than one
        hop up.
        """
        if key is None or parent_key is None or key == parent_key:
            return
        with self._lock:
            self._evict(self._links)
            self._links[key] = parent_key

    def _evict(self, table: dict) -> None:
        """Caller holds the lock. FIFO — dicts keep insertion order."""
        while len(table) >= self._max_open:
            table.pop(next(iter(table)), None)

    # -- agents -----------------------------------------------------------

    def start_agent(
        self,
        key: Any,
        *,
        agent_id: str,
        parent_key: Any = None,
        session_id: str | None = None,
        goal: str | None = None,
        **fields: Any,
    ) -> Identity:
        """Register a run as an agent and emit `agent_start`."""
        parent = self._resolve_parent(parent_key)
        sid = session_id or (parent.session_id if parent else None) or uuid.uuid4().hex
        aid = normalize_agent_id(agent_id)
        identity = Identity(
            session_id=sid,
            agent_id=aid,
            parent_id=parent.agent_id if parent else None,
            depth=(parent.depth + 1) if parent else 1,
        )
        with self._lock:
            self._evict(self._runs)
            self._runs[key] = _Run(identity=identity, parent_key=parent_key)
            if parent_key is not None:
                self._evict(self._links)
                self._links[key] = parent_key
        self._emit(
            "agent_start",
            identity,
            goal=truncate(goal) if goal is not None else None,
            parent_id=identity.parent_id,
            **fields,
        )
        return identity

    def end_agent(
        self,
        key: Any,
        *,
        outcome: str = "success",
        summary: str | None = None,
        **fields: Any,
    ) -> None:
        """Emit `agent_end` and forget the run.

        `outcome` is `"failed"`, never `"failure"` — the server only counts
        `error|failed|timeout|rejected` as a failure.
        """
        with self._lock:
            run = self._runs.pop(key, None)
        identity = run.identity if run is not None else self.identity(key)
        if identity is None:
            return
        self._emit(
            "agent_end",
            identity,
            outcome=outcome,
            summary=truncate(summary) if summary is not None else None,
            **fields,
        )

    def open_agents(self) -> tuple[Any, ...]:
        with self._lock:
            return tuple(self._runs)

    def close_open_agents(self, *, outcome: str = "cancelled") -> None:
        """Close every still-open agent, newest first.

        A session that dies with an open `agent_start` renders as `ongoing`
        forever, so teardown closes what it opened.
        """
        for key in reversed(self.open_agents()):
            self.end_agent(key, outcome=outcome)

    def reset(self) -> None:
        with self._lock:
            self._runs.clear()
            self._links.clear()
            self._warned = False

    # -- everything else --------------------------------------------------

    def emit(self, method: str, key: Any, *, parent_key: Any = None, **fields: Any) -> None:
        """Emit any `failproofai_sdk.event.*` method against a run's identity.

            tracker.emit("tool_use", run_id, parent_key=parent_run_id,
                         tool_name=name, tool_call_id=str(run_id))

        Drops the event (with one warning) when nothing resolves, rather than
        inventing a session id: a synthesized session splits one run into many.
        """
        if parent_key is not None:
            self.link(key, parent_key)
        identity = self.identity(key, parent_key)
        if identity is None:
            return
        self._emit(method, identity, **fields)

    def _emit(self, method: str, identity: Identity, **fields: Any) -> None:
        call_safely(self._emit_now, (method, identity, fields), {}, f"{self.name}.{method}")

    def _emit_now(self, method: str, identity: Identity, fields: dict) -> None:
        # Two kinds of keyword here, and the split is by NAME, not by meaning:
        # `fw_*` (plus whatever the adapter set as base fields) are payload
        # extras and go through the guard and the size budget; everything else
        # is a real parameter of the `event.*` method — `tool_name`, `input`,
        # `outcome` — and is passed straight through. Those still get truncated,
        # because `input`/`output`/`messages`/`content` are exactly the fields a
        # framework fills with a 200KB prompt.
        declared: dict[str, Any] = {}
        extras: dict[str, Any] = {}
        for key, value in fields.items():
            if value is None:
                continue
            if key.startswith(_FW_PREFIX):
                extras[key] = value
            else:
                declared[key] = truncate(value, self._field_limit)
        merged = payload(
            guard_extras({**self._base_fields, **extras}),
            limit=self._field_limit,
            budget=self._budget,
        )
        # A base field named like a real parameter would be a duplicate keyword
        # (TypeError inside the customer's callback); the explicit value wins.
        merged = {k: v for k, v in merged.items() if k not in declared}
        emit = getattr(_runtime.event, method)
        emit(session_id=identity.session_id, agent_id=identity.agent_id, **declared, **merged)

    def _resolve_parent(self, parent_key: Any) -> Identity | None:
        with self._lock:
            walked = self._walk(parent_key)
        if walked is not None:
            return walked
        # Same three steps as `identity()`, minus the exact-key lookup (a run
        # cannot be its own parent) and minus the warning (a root agent with no
        # ambient scope is normal, not a dropped event).
        return self._ambient(coerce_agent=False)
