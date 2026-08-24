import atexit
import collections
import itertools
import json
import logging
import math
import os
import threading
import weakref
from datetime import datetime, timezone

from failproofai_sdk._resolver import get_base_dir


logger = logging.getLogger(__name__)

#: Per-process batch counter, so two batches written inside the same millisecond
#: cannot land on the same filename.
#:
#: The timestamp alone was not enough, and the way it failed was invisible. Two
#: batches in the same millisecond produced the same stem, and the second
#: `os.replace` overwrote the first — no exception, no log line, no trace that
#: the events had ever existed. Three routine situations hit it:
#:
#:   * the atexit flush racing the flush thread's own final cycle, which is
#:     exactly when the last events of a run are written;
#:   * any caller invoking `flush_now()` from more than one thread;
#:   * several agent processes sharing one spool root — the normal deployment.
#:     Nothing in the stem identified the writer, so unrelated processes
#:     silently overwrote each other's batches.
#:
#: Hence the pid as well as the counter: the counter fixes the in-process race
#: and the pid fixes the cross-process one. The daemons require only that a
#: batch file end in `.jsonl` and not `.tmp` (`collector/src/watcher.rs` in
#: AgentEye, `crates/fpai-collect/src/spool.rs` here), so the rest of the stem
#: is ours to make unique — and fpai-collect's own batches carry a run id and a
#: sequence number for the same reason.
_batch_seq = itertools.count()

#: Hard cap on the in-memory queue, matching `_events._PENDING_CAP`.
#:
#: `submit()` is called from the caller's own agent loop and must never block or
#: raise, so it cannot apply backpressure — which leaves an unbounded queue as
#: the only other option, and that is a memory leak wearing a different hat. Any
#: condition that stops the spool draining (a full disk, a read-only mount, a
#: forked child before this module learned to restart its thread) then converts
#: a telemetry outage into an OOM kill of the host agent. Losing the oldest
#: events is the better failure: it is bounded, it is logged, and the events
#: most worth having are the recent ones.
#:
#: At the default 500 ms interval a process would have to emit 20_000
#: events/second to reach it. Anything that does hit this cap is not a busy
#: agent, it is a spool that has stopped.
#:
#: A COUNT alone is not the bound this docstring claims, because it says nothing
#: about how big an event is. `integrations/_core.py` budgets 128 KiB of `fw_*`
#: extras per event on top of the declared fields, so 10_000 of them is ~1.3 GB,
#: not the "roughly 10 MB" this used to promise — an OOM kill of the host agent,
#: which is the exact outcome the cap exists to make impossible. So the queue is
#: bounded by BYTES as well, below.
_QUEUE_CAP = 10_000

#: The ceiling, enforced against MEASURED bytes rather than an estimate. Chosen
#: to sit well under the memory a small container is given (512 MB is the common
#: floor), because the whole point is that a spool which has stopped draining
#: must not take the customer's agent down with it.
#:
#: This was briefly derived from a running average of encoded batch sizes, which
#: is not a bound at all before the first flush has happened: the seed assumed
#: 1 KB/event, so 10_000 events of 128 KiB queued 1.22 GB before the estimate
#: caught up — the exact OOM this exists to prevent, just later. `submit` sizes
#: each entry as it arrives instead. That costs one walk over the entry's NODES
#: (string lengths are O(1)), not over its characters, which is microseconds for
#: an event and is paid on the caller's thread only once per event.
_QUEUE_BYTE_CAP = 64 * 1024 * 1024

#: Per-STRING cap inside one event, mirroring `MAX_FIELD_BYTES` in
#: `crates/fpai-collect/src/spool.rs`. The Rust spool writer has always enforced
#: this; the Python writer publishing into the same directories did not.
_MAX_FIELD_BYTES = 1024 * 1024

#: Roll a batch file once it reaches this, mirroring `DEFAULT_MAX_BATCH_BYTES`
#: in `spool.rs` and staying under the uploader's `DEFAULT_MAX_UPLOAD_BYTES`.
#:
#: `uploader.rs` documents the invariant this restores: "A single line longer
#: than max is emitted alone rather than dropped: the spool writer already
#: guarantees no such line exists." No SDK-side writer guaranteed that, and
#: `split_lines` can only split on newlines — so one oversized event was POSTed
#: whole, rejected, and the WHOLE spool file (every unrelated event batched with
#: it) was parked, retried three times and poisoned. Never delivered, and nothing
#: in the host process ever learned.
_MAX_BATCH_BYTES = 8 * 1024 * 1024

#: An encoded event above this is over-large on its own and gets its fields
#: capped. Sits below `_MAX_BATCH_BYTES` so a capped event still leaves room for
#: the batch framing around it.
_MAX_EVENT_BYTES = 4 * 1024 * 1024

#: How deep `_sanitize` will walk before giving up on a branch. Guards the
#: fallback path against a RecursionError, which would defeat the point of
#: having a fallback at all.
_MAX_SANITIZE_DEPTH = 50

#: How `json.dumps(ensure_ascii=True)` writes a lone surrogate. Cheap to scan
#: for, and the only in-band signal that one is present — encoding never fails.
#:
#: The lead nibble matters. `\\ud` alone also matches U+D000–U+D7FF, which is most
#: of the Hangul syllable block — `json.dumps("한")` is `"\\ud55c"` — so every event
#: carrying ordinary Korean text took the rebuild path. That was documented as
#: costing nothing ("merely re-encoded to the same bytes"), and it is not:
#: `_sanitize` replaces anything past `_MAX_SANITIZE_DEPTH` with a marker, so a
#: payload the strict encoder had handled perfectly was silently truncated the
#: moment it also contained a Korean character. Real surrogates are U+D800–U+DFFF,
#: whose escapes all begin `\\ud8`, `\\ud9`, `\\uda`…`\\udf`.
_SURROGATE_ESCAPES = tuple(f"\\ud{c}" for c in "89abcdefABCDEF")

_FIELD_TRUNCATION_MARKER = "…[truncated]"

_CYCLE_MARKER = "<circular reference>"
_DEPTH_MARKER = "<max depth exceeded>"

#: Every live writer, weakly. Both the fork handler and the atexit flush iterate
#: this rather than binding to one instance, which is what lets the atexit hook
#: be registered once at module scope instead of once per writer —
#: `atexit.register(self._flush)` stored a strong reference to a bound method and
#: so made every EventWriter ever built immortal.
#:
#: Weak references do NOT make a writer collectable on their own: its flush
#: thread targets `self._flush_loop`, and a running thread holds its target. So
#: in practice a writer lives as long as its thread does, which is for the life
#: of the process. The weakness earns its keep on the fork path, where a dead
#: referent must be skipped rather than restarted, and it stops this list being a
#: second, independent reason a writer can never go away.
_live_writers: "list[weakref.ref[EventWriter]]" = []


def _validated_interval(flush_interval: float) -> float:
    """A flush interval `_flush_loop` can actually wait on.

    The wait happens BEFORE the loop's try/except, deliberately — a flush that
    raises must be retried next cycle, and wrapping the wait would mean a bad
    interval retries forever at full speed instead. The cost of that choice is
    that an unwaitable interval kills the thread outright, and the thread dying
    is the worst failure this class has: `submit()` keeps accepting events, the
    queue fills to `_QUEUE_CAP` and then starts discarding, and the caller sees
    no error until the process exits and takes everything with it.

    So the value is rejected at the boundary instead, where a caller still has a
    stack trace pointing at their own `configure()` call:

        -1   -> ValueError from Event.wait, thread dies
        nan  -> ValueError from Event.wait, thread dies
        inf  -> OverflowError from Event.wait, thread dies
        0    -> waits not at all; a busy loop pinning a core and rewriting the
                spool as fast as the disk allows
    """
    interval = float(flush_interval)
    if not math.isfinite(interval) or interval <= 0:
        raise ValueError(
            f"flush_interval must be a finite number greater than zero, got {flush_interval!r}"
        )
    return interval


def _approx_size(value, depth: int = 0) -> int:
    """Roughly how many bytes `value` will occupy once encoded.

    Walks NODES, not characters: `len()` on a string is O(1), so an ordinary
    event costs microseconds even though it may carry megabytes of text. That is
    what makes it affordable on `submit`, which runs on the caller's agent loop.

    Deliberately approximate — it ignores JSON punctuation and escaping — because
    it backs a backstop against unbounded growth, not an exact quota.
    """
    if depth > _MAX_SANITIZE_DEPTH:
        return 16
    if value is None or isinstance(value, (bool, int, float)):
        return 8
    if isinstance(value, str):
        return len(value)
    if isinstance(value, bytes):
        return len(value)
    # NOTHING here may raise. `submit` runs on the caller's agent loop, so an
    # exception escaping this function is a telemetry call taking down the host
    # agent — the one failure mode this whole module is written to avoid. A key
    # is measured only when it is ALREADY a `str`: calling `str()` on it would
    # run the caller's `__str__`, which can raise anything at all (this is not
    # hypothetical — `tests/test_encoding.py` plants exactly that object).
    try:
        if isinstance(value, dict):
            return sum(
                (len(k) if isinstance(k, str) else 16) + _approx_size(v, depth + 1)
                for k, v in value.items()
            )
        if isinstance(value, (list, tuple, set, frozenset)):
            return sum(_approx_size(v, depth + 1) for v in value)
    except Exception:  # pragma: no cover - a container whose iteration raises
        return 16
    return 16


def _cap_fields(value, limit: int, depth: int = 0):
    """Truncate every string in `value` to `limit`, marking what was cut.

    Mirrors `truncate_strings` in `crates/fpai-collect/src/spool.rs`, which has
    always enforced this on the Rust side of the same spool.
    """
    if depth > _MAX_SANITIZE_DEPTH:
        return value
    # Same rule as `_approx_size`: never raise. This runs from `_encode_entry`,
    # whose contract is that ONE bad event is dropped alone rather than taking
    # the batch beside it down.
    try:
        if isinstance(value, str) and len(value) > limit:
            return value[:limit] + _FIELD_TRUNCATION_MARKER
        if isinstance(value, dict):
            return {k: _cap_fields(v, limit, depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_cap_fields(v, limit, depth + 1) for v in value]
    except Exception:  # pragma: no cover - a container whose iteration raises
        return value
    return value


def _scrub_key(key) -> str:
    """A dict key as a string with any lone surrogate made inert.

    Mirrors the string branch of `_sanitize`; kept separate because a key must
    always come back a `str`, whatever it started as.
    """
    if not isinstance(key, str):
        key = str(key)
    return key.encode("utf-8", "backslashreplace").decode("utf-8")


def _sanitize(value, seen: frozenset, depth: int = 0):
    """Rewrite one payload into something `json.dumps` can definitely encode.

    Only ever reached from `_encode_entry`'s fallback, so it may be slow; it
    must not be lossy in the ordinary case, and it must not raise.

    `seen` tracks the ids on the CURRENT PATH, not every id visited. A payload
    that mentions the same dict twice as siblings is a DAG, not a cycle, and
    json encodes it fine — flagging it would corrupt a perfectly good event.
    """
    if depth > _MAX_SANITIZE_DEPTH:
        return _DEPTH_MARKER
    # NaN / inf / -inf. `json.dumps` writes these as the bare tokens NaN,
    # Infinity and -Infinity, which are a Python extension and not valid JSON —
    # a strict NDJSON reader rejects the line, and the whole event is lost for
    # one field. There is no in-band JSON value for them, so None it is: the
    # field reads as absent rather than as a number that is not one.
    if isinstance(value, float) and not math.isfinite(value):
        return None
    # Lone surrogates. `os.fsdecode` and `bytes.decode(errors="surrogateescape")`
    # — the standard way Python carries bytes that are not valid UTF-8, and what
    # a filesystem path or a truncated tool output arrives as — produce these.
    # `json.dumps` escapes them happily as \udcff, so nothing fails locally, and
    # then the SERVER skips the whole event: verified against a live ingest,
    # `{"accepted":0,"skipped":1}` at 200 OK. `backslashreplace` keeps the byte
    # visible in the payload instead of dropping it to a `?`.
    if isinstance(value, str):
        return value.encode("utf-8", "backslashreplace").decode("utf-8")
    if isinstance(value, dict):
        if id(value) in seen:
            return _CYCLE_MARKER
        seen = seen | {id(value)}
        # Non-str keys are the common half of this bug: `json.dumps(default=...)`
        # is never consulted for keys, so a tuple-keyed cache raises TypeError
        # no matter what default is passed.
        #
        # Keys go through the SAME surrogate scrub as values. They used to pass
        # through untouched, which left the scrub applied to every value and to
        # no key — and a filesystem path, the source this module names as the
        # realistic one, is most naturally a KEY (`{path: contents}`). An
        # unscrubbed key reaches the wire as a JSON lone-surrogate escape, ingest
        # answers 200 `{"accepted":0,"skipped":1}`, and the uploader now parks
        # that batch and poisons it after three retries — so one bad key loses
        # every event batched with it.
        return {
            _scrub_key(k): _sanitize(v, seen, depth + 1) for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        if id(value) in seen:
            return _CYCLE_MARKER
        seen = seen | {id(value)}
        return [_sanitize(v, seen, depth + 1) for v in value]
    return value


def _encode_entry(entry: dict) -> "str | None":
    """One event as a JSON line, or None if it cannot be encoded at all.

    THE POINT IS ISOLATION. This used to be a single `json.dumps` over the whole
    batch, which meant one unencodable payload took every event beside it down:
    `_flush` restored the batch and re-raised, `_flush_loop` logged and retried
    the identical batch on the next interval, and the spool never advanced again.
    A tuple-keyed dict or an object holding a back-reference — both ordinary
    things to hand a telemetry call — permanently ended recording for the
    process, and the only outward sign was a traceback at exit.

    `default=str` does not prevent it. It is consulted for unsupported *values*
    only, so it rescues datetime and UUID but not a non-str key and not a cycle:

        {"k": {(1, 2): "v"}}  -> TypeError: keys must be str, int, float, ...
        d = {}; d["self"] = d -> ValueError: Circular reference detected

    `allow_nan=False` is part of "strict" here. Left at its default, `json.dumps`
    emits the bare tokens `NaN`, `Infinity` and `-Infinity` — a Python extension
    that is NOT valid JSON and that a strict NDJSON reader rejects. Worse, it
    does not raise, so the fallback below never ran and the malformed line went
    out looking fine. With it off, a non-finite float raises like any other
    unencodable value and `_sanitize` maps it to None.

    So: try strict first (the fast path, byte-identical to what shipped before
    for every payload that was already valid JSON), fall back to a sanitised
    copy, and only then give up on that ONE event.
    """
    # `except Exception`, not a list of the three encoder errors. `default=str`
    # runs the CALLER'S `__repr__`/`__str__`, which can raise anything at all —
    # a RuntimeError out of a lazy ORM attribute, an OSError out of a property
    # that touches the network. Those escaped the narrow clause, propagated out
    # of `_write_batch`, and put the whole batch back on the queue to be retried
    # identically forever: the exact wedge this function exists to prevent,
    # reached through a different exception type.
    #
    # BaseException is deliberately NOT caught — a KeyboardInterrupt during a
    # flush must still interrupt.
    try:
        encoded = json.dumps(entry, default=str, allow_nan=False)
    except Exception:
        encoded = None

    if encoded is not None:
        # `ensure_ascii` is on, so a lone surrogate leaves here as the literal
        # text \udXXX rather than raising — which is exactly why it needed
        # finding by inspection. One substring scan per line, and only a line
        # that actually contains one pays for the rewrite below. A payload whose
        # own text happens to contain a real surrogate escape trips this too and
        # is merely re-encoded, which is rare enough to be worth the certainty.
        if not any(esc in encoded for esc in _SURROGATE_ESCAPES):
            return _cap_encoded(entry, encoded)

    try:
        sanitized = _sanitize(entry, frozenset())
        return _cap_encoded(sanitized, json.dumps(sanitized, default=str, allow_nan=False))
    except Exception:
        # Nothing left to try. Losing this event is the correct outcome; losing
        # the batch around it is not.
        logger.exception(
            "Failproof AI could not serialize an event (type=%r); dropping it",
            entry.get("type") if isinstance(entry, dict) else None,
        )
        return None


def _roll(lines: list, limit: int):
    """Split encoded lines into batches that each stay under `limit` bytes."""
    chunk, size = [], 0
    for line in lines:
        cost = len(line) + 1  # the newline this line will be joined with
        if chunk and size + cost > limit:
            yield chunk
            chunk, size = [], 0
        chunk.append(line)
        size += cost
    if chunk:
        yield chunk


def _cap_encoded(entry: dict, encoded: str) -> str:
    """Bound ONE event, re-encoding only when it is actually over-large.

    `ensure_ascii` is on, so the encoded string is ASCII and `len` is its byte
    count exactly. The check is therefore free on the fast path and the walk is
    paid only by the events that need it.

    Why it has to happen at all: `uploader.rs` states the invariant it relies on
    — "A single line longer than max is emitted alone rather than dropped: the
    spool writer already guarantees no such line exists." The Rust spool writer
    does guarantee it (`truncate_strings` at `MAX_FIELD_BYTES`). The Python
    writer, publishing into the same directories, did not — so one
    `tool_result(output=<a large file>)` was written as a single line, POSTed
    whole because `split_lines` can only split on newlines, rejected, and the
    ENTIRE spool file was parked, retried three times and poisoned. Every
    unrelated event batched alongside it went too, and nothing in the host
    process ever learned.
    """
    if len(encoded) <= _MAX_EVENT_BYTES:
        return encoded
    capped = _cap_fields(entry, _MAX_FIELD_BYTES)
    try:
        recoded = json.dumps(capped, default=str, allow_nan=False)
    except Exception:  # pragma: no cover - `entry` already encoded once
        return encoded
    logger.warning(
        "Failproof AI truncated an oversized event (type=%r) from %d to %d bytes; "
        "fields above %d bytes were cut so the batch stays deliverable",
        entry.get("type") if isinstance(entry, dict) else None,
        len(encoded),
        len(recoded),
        _MAX_FIELD_BYTES,
    )
    return recoded


def _flush_all_at_exit() -> None:
    """Final flush for every live writer.

    Registered once, at module scope, rather than per instance: `atexit` holds a
    strong reference to whatever it is given, so `atexit.register(self._flush)`
    made every EventWriter immortal.

    Exceptions are swallowed here on purpose. An uncaught one at this point
    prints `Exception ignored in atexit callback` plus a full traceback into the
    host agent's stderr, during interpreter shutdown, where it reads as a crash
    in the application rather than a telemetry flush that failed.

    `_flush` takes `_flush_lock`, so this BLOCKS on any batch the flush thread
    is part-way through rather than racing it. That matters more than it looks:
    a batch is drained from the queue before it is written, so a flush thread
    stopped mid-write — which is what happens to a daemon thread once the
    interpreter starts finalizing — takes those events with it and leaves a
    stray `.tmp` behind. atexit callbacks run BEFORE threads are hung, so
    waiting here is enough for the in-flight write to finish normally.
    """
    for ref in list(_live_writers):
        writer = ref()
        if writer is None:
            continue
        try:
            writer._flush()
        except Exception:
            logger.exception("Failproof AI final flush failed; buffered events were lost")


def _reinit_all_after_fork() -> None:
    """Make every inherited writer usable again in a freshly-forked child.

    Threads do not survive `fork()`. Without this the child inherits a queue,
    an atexit hook and no thread to drain either: `submit()` keeps accepting,
    nothing is ever published, and the events appear only if the child happens
    to exit through a normal interpreter shutdown. A prefork worker (gunicorn,
    celery, multiprocessing's default start method on Linux) never does — it is
    killed — so telemetry from the workers, which is all of the telemetry,
    silently never arrives.
    """
    survivors = []
    for ref in _live_writers:
        writer = ref()
        if writer is None:
            continue
        survivors.append(ref)
        try:
            writer._reinit_after_fork()
        except Exception:  # pragma: no cover - defensive
            logger.exception("Failproof AI could not restart its flush thread after fork")
    _live_writers[:] = survivors


atexit.register(_flush_all_at_exit)

if hasattr(os, "register_at_fork"):  # pragma: no branch - absent only on Windows
    os.register_at_fork(after_in_child=_reinit_all_after_fork)


class EventWriter:
    def __init__(self, flush_interval: float = 0.5) -> None:
        self._queue: collections.deque[dict] = collections.deque()
        self._flush_interval = _validated_interval(flush_interval)
        self._dropped = 0
        # Waited on instead of `time.sleep` so `set_flush_interval` takes effect
        # on the current cycle rather than the next one. It matters at startup:
        # the thread begins its first wait at import, before `configure()` has
        # been called, so a caller asking for a 50 ms interval used to get one
        # 500 ms cycle first — long enough for a fork or an exit to land inside
        # it and take the events with it.
        self._wake = threading.Event()
        # Serialises `_flush`, so a batch is never being drained by two threads
        # at once and — the case that actually bites — so the atexit flush waits
        # for an in-flight write instead of racing interpreter shutdown against
        # it. Never taken by `submit`, which must stay lock-free.
        #
        # RLock, not Lock, and that is load-bearing: signal handlers run on the
        # MAIN thread, interrupting whatever bytecode it was executing. The
        # SIGTERM recipe this SDK publishes (SKILL.md, docs/reference/custom-agents
        # .mdx) calls `flush_now()` from a handler, so a plain Lock deadlocks the
        # host process outright whenever the main thread is already inside
        # `_flush` — a second SIGTERM during the first handler's flush, an app
        # that calls `flush_now()` itself, or a SIGTERM landing during the atexit
        # flush, which runs on this same thread. Once wedged the process cannot
        # be signalled out of it: every further SIGTERM re-enters the deadlocked
        # handler. Re-entering the write is safe — the outer call has already
        # drained its batch into a local list, `_batch_seq` is atomic, and the
        # nested batch simply lands under its own filename.
        self._flush_lock = threading.RLock()
        # Measured bytes currently queued. Maintained by `submit` and reset by
        # `_flush`, which drains under the lock — so it self-corrects every cycle
        # and any drift from a concurrent lock-free `submit` is bounded by one
        # flush interval.
        self._queued_bytes = 0
        self._start_thread()
        _live_writers.append(weakref.ref(self))

    def _start_thread(self) -> None:
        self._thread = threading.Thread(
            target=self._flush_loop, daemon=True, name="failproofai-sdk-flush"
        )
        self._thread.start()

    def _reinit_after_fork(self) -> None:
        """Restore this writer inside the child half of a `fork()`.

        The inherited queue is DISCARDED rather than published. Those events
        belong to the parent, which still holds them and will write them itself;
        publishing them here too produced a genuine duplicate of every event
        buffered at the moment of the fork. Ingest would most likely collapse
        them — its dedup key hashes the canonical payload and these are
        byte-identical — but "the server will probably clean it up" is not a
        property this SDK gets to rely on.

        `self._wake` is rebuilt rather than reused: `threading.Event` is backed
        by a lock, and a lock held by the flush thread at the instant of the
        fork is inherited locked, by a thread that no longer exists. Setting it
        would then deadlock the child.
        """
        inherited = len(self._queue)
        self._queue.clear()
        self._wake = threading.Event()
        # RLock for the same reason as the constructor: the child may install the
        # documented SIGTERM handler too.
        self._flush_lock = threading.RLock()
        self._queued_bytes = 0
        self._start_thread()
        if inherited:
            logger.debug(
                "Failproof AI discarded %d event(s) inherited from the parent process; "
                "the parent still holds them",
                inherited,
            )

    def submit(self, entry: dict) -> None:
        # Bounded, and bounded without a lock: `len` and `popleft` on a deque are
        # each a single atomic operation, and `submit` runs on the caller's agent
        # loop where a lock is a latency risk and, on the fork path, a deadlock.
        # A momentary overshoot under concurrent submits is fine; the cap is a
        # backstop against unbounded growth, not an exact quota.
        size = _approx_size(entry)
        # BOTH bounds, and the byte one against measured sizes. A count alone is
        # not a memory bound (the adapters budget 128 KiB of extras per event, so
        # 10_000 of them is ~1.3 GB), and an average-based byte bound is not one
        # either until the average has been learned.
        while self._queue and (
            len(self._queue) >= _QUEUE_CAP
            or self._queued_bytes + size > _QUEUE_BYTE_CAP
        ):
            try:
                evicted = self._queue.popleft()
            except IndexError:  # pragma: no cover - drained concurrently
                break
            self._queued_bytes = max(0, self._queued_bytes - _approx_size(evicted))
            self._dropped += 1
            # Powers of ten, so a stuck spool says so without becoming the thing
            # that fills the disk it is complaining about.
            if self._dropped == 1 or self._dropped % 1000 == 0:
                logger.warning(
                    "Failproof AI event queue is full (%d events, %d bytes); discarding "
                    "oldest. %d dropped so far — the spool is not draining.",
                    len(self._queue),
                    self._queued_bytes,
                    self._dropped,
                )
        self._queue.append(entry)
        self._queued_bytes += size

    def set_flush_interval(self, interval: float) -> None:
        # Validate first, assign second: a rejected value must leave the writer
        # running on the interval it already had, not on a half-applied one.
        self._flush_interval = _validated_interval(interval)
        # Cut the current wait short so the new interval applies from now, not
        # from the end of a cycle that may be an hour long.
        self._wake.set()

    def flush_now(self) -> None:
        """Drain and write any buffered entries immediately (for testing)."""
        self._flush()

    def _flush_loop(self) -> None:
        while True:
            self._wake.wait(self._flush_interval)
            self._wake.clear()
            try:
                self._flush()
            except Exception:
                # Recording must never die permanently because one flush hit a
                # transient filesystem error. `_flush` restores the drained
                # entries before re-raising, so the next interval retries them.
                logger.exception(
                    "Failproof AI event flush failed; buffered events will be retried"
                )

    def _flush(self) -> None:
        # The emptiness check is INSIDE the lock, and that is the whole point of
        # having one. Outside it, a caller arriving while the flush thread had
        # already drained the queue saw it empty and returned immediately — so
        # the atexit flush did not wait, the interpreter finalised, and the
        # thread died part-way through writing a batch it had already taken
        # ownership of. The events were gone and the only trace was a stray
        # `.tmp` — sometimes not even that.
        with self._flush_lock:
            if not self._queue:
                return
            entries = []
            while self._queue:
                try:
                    entries.append(self._queue.popleft())
                except IndexError:
                    break
            # Authoritative reset: everything the queue held is now in `entries`.
            # Whatever a concurrent `submit` appended after the drain re-adds
            # itself, so this both clears the total and corrects any drift.
            self._queued_bytes = 0
            if entries:
                try:
                    self._write_batch(entries)
                except Exception:
                    # Preserve FIFO order when returning the drained batch to the
                    # front of entries submitted concurrently during the write.
                    for entry in reversed(entries):
                        self._queue.appendleft(entry)
                    self._queued_bytes = sum(_approx_size(e) for e in self._queue)
                    raise

    def _write_batch(self, entries: list[dict]) -> None:
        # Encode BEFORE touching the filesystem. An unencodable event is a
        # permanent condition — retrying it produces the identical failure — so
        # it is dropped here, while a filesystem error raises from below and the
        # whole batch goes back on the queue to be retried.
        lines = []
        dropped = 0
        for entry in entries:
            encoded = _encode_entry(entry)
            if encoded is None:
                dropped += 1
                continue
            lines.append(encoded)

        if dropped:
            logger.error(
                "Failproof AI dropped %d unserializable event(s) from a batch of %d; "
                "the rest of the batch was published",
                dropped,
                len(entries),
            )
        if not lines:
            return

        # Roll into as many files as the cap needs. `uploader.rs` posts a spool
        # file whole when it fits and splits it on newlines when it does not, so
        # oversizing a batch is survivable — but rolling here keeps each POST
        # within `DEFAULT_MAX_UPLOAD_BYTES` without relying on that, and matches
        # what the Rust spool writer already does with `DEFAULT_MAX_BATCH_BYTES`.
        # Every line is individually under `_MAX_EVENT_BYTES` by now, so each
        # chunk is non-empty and the loop always terminates.
        for chunk in _roll(lines, _MAX_BATCH_BYTES):
            self._write_one_file(chunk)

    def _write_one_file(self, lines: list[str]) -> None:

        events_dir = get_base_dir() / "events"
        # 0700, and the batch below 0600. These files are not metadata: they
        # carry goals, prompt text, tool arguments and tool output straight from
        # the host agent. Under the ordinary umask 022 they landed 0644 inside
        # 0755 directories, so on any shared host — a build box, a bastion, a
        # container with several service accounts — every other local user could
        # read every agent transcript this SDK spools, for the whole flush+upload
        # window and forever if no daemon is running. The sibling `fp-cli`
        # already does exactly this for its credential (`config.py`), and the
        # daemon reads these as the SAME user (the unit is `User=<user>` with
        # `HOME` set to that user's home), so tightening them costs no delivery.
        events_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

        now = datetime.now(timezone.utc)
        ts_str = now.strftime("%Y-%m-%dT%H-%M-%S") + f"-{now.microsecond // 1000:03d}Z"
        # See `_batch_seq` above: the timestamp orders batches for a human
        # reading the directory, and the pid+counter suffix is what makes the
        # name unique. `next()` on an itertools.count is atomic under CPython's
        # GIL and, being a single C-level call, remains so on free-threaded
        # builds — no lock, which matters because this runs on the atexit path
        # where a lock held by a killed thread would hang the interpreter.
        stem = f"event-{ts_str}-{os.getpid()}-{next(_batch_seq)}"

        tmp_path = events_dir / f"{stem}.tmp"
        final_path = events_dir / f"{stem}.jsonl"

        content = "\n".join(lines) + "\n"

        # fsync BEFORE the rename. `os.replace` is atomic with respect to
        # readers, but atomic is not durable: it orders nothing against the page
        # cache, so a power loss or kernel crash can leave a correctly-named,
        # zero-length or truncated `.jsonl`. The collector reads whatever is
        # there, POSTs it, and then DELETES the file (`remove_file` in
        # `crates/fpai-collect/src/uploader.rs`) — so the loss is permanent and
        # silent, and an empty batch is accepted with a 200.
        #
        # This is not a hypothetical asymmetry: this repo's own Rust spool
        # writer already calls `sync_all()` here for exactly this reason
        # (`crates/fpai-collect/src/spool.rs`), with the same comment. The
        # Python writer publishing into the same directories was the odd one out.
        # Clean up the partial file on ANY failure. Each flush picks a fresh
        # stem, so without this a persistent fault — a full disk, a read-only
        # mount, a cross-device rename — strands one `.tmp` per flush cycle:
        # roughly 170_000 files a day at the default interval, on the very disk
        # that is already the problem. The watcher ignores them by extension, so
        # nothing else would ever notice or collect them.
        #
        # The batch itself is NOT lost by this: `_flush` returns the entries to
        # the queue and the next cycle rewrites them under a new name.
        try:
            # O_EXCL + an explicit 0600 rather than `open(..., "wb")`, whose mode
            # is 0666 & ~umask. The mode is applied at CREATE, so the payload is
            # never briefly world-readable the way a follow-up chmod would leave it.
            fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with open(fd, "wb") as handle:
                handle.write(content.encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())

            os.replace(tmp_path, final_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

        # And fsync the DIRECTORY, or the rename itself can be lost while the
        # file's contents survive — leaving the batch on disk under its `.tmp`
        # name, which the watcher ignores by design.
        #
        # Best-effort: opening a directory for fsync is a POSIX behaviour, and
        # platforms that refuse it (Windows) still get the content fsync above,
        # which is the half that prevents a truncated delivery.
        try:
            dir_fd = os.open(events_dir, os.O_RDONLY)
        except OSError:  # pragma: no cover - platform dependent
            return
        try:
            os.fsync(dir_fd)
        except OSError:  # pragma: no cover - platform dependent
            pass
        finally:
            os.close(dir_fd)
