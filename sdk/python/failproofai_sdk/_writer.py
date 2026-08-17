import atexit
import collections
import itertools
import json
import logging
import math
import os
import threading
import time
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


def _validated_interval(flush_interval: float) -> float:
    """A flush interval `_flush_loop` can actually sleep on.

    `time.sleep()` is called BEFORE the loop's try/except, deliberately — a flush
    that raises must be retried next cycle, and wrapping the sleep would mean a
    bad interval retries forever at full speed instead. The cost of that choice is
    that an unsleepable interval kills the thread outright, and the thread dying
    is the worst failure this class has: `submit()` keeps accepting events, the
    queue keeps growing, nothing is ever written, and the caller sees no error
    until the process exits and takes everything with it.

    So the value is rejected at the boundary instead, where a caller still has a
    stack trace pointing at their own `configure()` call:

        -1   -> ValueError from sleep, thread dies
        nan  -> ValueError from sleep, thread dies
        inf  -> OverflowError from sleep, thread dies
        0    -> sleeps not at all; a busy loop pinning a core and rewriting the
                spool as fast as the disk allows
    """
    interval = float(flush_interval)
    if not math.isfinite(interval) or interval <= 0:
        raise ValueError(
            f"flush_interval must be a finite number greater than zero, got {flush_interval!r}"
        )
    return interval


class EventWriter:
    def __init__(self, flush_interval: float = 0.5) -> None:
        self._queue: collections.deque[dict] = collections.deque()
        self._flush_interval = _validated_interval(flush_interval)
        self._thread = threading.Thread(
            target=self._flush_loop, daemon=True, name="failproofai-sdk-flush"
        )
        self._thread.start()
        atexit.register(self._flush)

    def submit(self, entry: dict) -> None:
        self._queue.append(entry)

    def set_flush_interval(self, interval: float) -> None:
        # Validate first, assign second: a rejected value must leave the writer
        # running on the interval it already had, not on a half-applied one.
        self._flush_interval = _validated_interval(interval)

    def flush_now(self) -> None:
        """Drain and write any buffered entries immediately (for testing)."""
        self._flush()

    def _flush_loop(self) -> None:
        while True:
            time.sleep(self._flush_interval)
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

        # Telemetry payloads commonly contain datetime/UUID/Decimal and other
        # useful objects. Coerce unsupported leaves to strings instead of
        # dropping the entire batch or terminating the writer thread.
        content = "\n".join(json.dumps(e, default=str) for e in entries) + "\n"
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, final_path)
