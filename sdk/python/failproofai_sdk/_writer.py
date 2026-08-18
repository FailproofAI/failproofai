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
#: 10_000 events is roughly 10 MB of dicts, and at the default 500 ms interval a
#: process would have to emit 20_000 events/second to reach it. Anything that
#: does hit this cap is not a busy agent, it is a spool that has stopped.
_QUEUE_CAP = 10_000

#: How deep `_sanitize` will walk before giving up on a branch. Guards the
#: fallback path against a RecursionError, which would defeat the point of
#: having a fallback at all.
_MAX_SANITIZE_DEPTH = 50

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
    if isinstance(value, dict):
        if id(value) in seen:
            return _CYCLE_MARKER
        seen = seen | {id(value)}
        # Non-str keys are the common half of this bug: `json.dumps(default=...)`
        # is never consulted for keys, so a tuple-keyed cache raises TypeError
        # no matter what default is passed.
        return {
            (k if isinstance(k, str) else str(k)): _sanitize(v, seen, depth + 1)
            for k, v in value.items()
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

    So: try strict first (the fast path, byte-identical to what shipped before),
    fall back to a sanitised copy, and only then give up on that ONE event.
    """
    try:
        return json.dumps(entry, default=str)
    except (TypeError, ValueError, RecursionError):
        pass

    try:
        return json.dumps(_sanitize(entry, frozenset()), default=str)
    except Exception:
        # Nothing left to try. Losing this event is the correct outcome; losing
        # the batch around it is not.
        logger.exception(
            "Failproof AI could not serialize an event (type=%r); dropping it",
            entry.get("type") if isinstance(entry, dict) else None,
        )
        return None


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
        self._flush_lock = threading.Lock()
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
        self._flush_lock = threading.Lock()
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
        if len(self._queue) >= _QUEUE_CAP:
            try:
                self._queue.popleft()
            except IndexError:  # pragma: no cover - drained concurrently
                pass
            self._dropped += 1
            # Powers of ten, so a stuck spool says so without becoming the thing
            # that fills the disk it is complaining about.
            if self._dropped == 1 or self._dropped % 1000 == 0:
                logger.warning(
                    "Failproof AI event queue is full (%d events); discarding oldest. "
                    "%d dropped so far — the spool is not draining.",
                    _QUEUE_CAP,
                    self._dropped,
                )
        self._queue.append(entry)

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
            if entries:
                try:
                    self._write_batch(entries)
                except Exception:
                    # Preserve FIFO order when returning the drained batch to the
                    # front of entries submitted concurrently during the write.
                    for entry in reversed(entries):
                        self._queue.appendleft(entry)
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

        events_dir = get_base_dir() / "events"
        events_dir.mkdir(parents=True, exist_ok=True)

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
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, final_path)
