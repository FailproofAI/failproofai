import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { logException, logger } from "./logger.js";
import { redactJsonLine, redactionEnabled } from "./redact.js";
import { getBaseDir } from "./resolver.js";

/**
 * Per-process batch counter, so two batches written inside the same millisecond
 * cannot land on the same filename.
 *
 * The timestamp alone is not enough, and the way it fails is invisible. Two
 * batches in the same millisecond produce the same stem, and the second rename
 * overwrites the first — no exception, no log line, no trace that the events
 * had ever existed. Three routine situations hit it:
 *
 *   * the exit flush racing the interval's own final cycle, which is exactly
 *     when the last events of a run are written;
 *   * any caller invoking `flushNow()` from more than one place;
 *   * several agent processes sharing one spool root — the normal deployment.
 *     Nothing in the stem identifies the writer, so unrelated processes would
 *     silently overwrite each other's batches.
 *
 * Hence the pid as well as the counter: the counter fixes the in-process race
 * and the pid fixes the cross-process one. The daemons require only that a
 * batch file end in `.jsonl` and not `.tmp` (`crates/fpai-collect/src/spool.rs`),
 * so the rest of the stem is ours to make unique.
 */
let batchSeq = 0;

/**
 * Hard cap on the in-memory queue, matching `events.ts`'s `PENDING_CAP`.
 *
 * `submit()` is called from the caller's own agent loop and must never block or
 * throw, so it cannot apply backpressure — which leaves an unbounded queue as
 * the only other option, and that is a memory leak wearing a different hat. Any
 * condition that stops the spool draining (a full disk, a read-only mount) then
 * converts a telemetry outage into an OOM kill of the host agent. Losing the
 * oldest events is the better failure: it is bounded, it is logged, and the
 * events most worth having are the recent ones.
 *
 * At the default 500 ms interval a process would have to emit 20,000
 * events/second to reach it. Anything that does hit this cap is not a busy
 * agent, it is a spool that has stopped.
 *
 * A COUNT alone is not the bound this comment claims, because it says nothing
 * about how big an event is. `integrations/core.ts` budgets 128 KiB of `fw_*`
 * extras per event on top of the declared fields, so 10,000 of them is ~1.3 GB.
 * So the queue is bounded by BYTES as well, below.
 */
const QUEUE_CAP = 10_000;

/**
 * The ceiling, enforced against MEASURED bytes rather than an estimate. Chosen
 * to sit well under the memory a small container is given (512 MB is the common
 * floor), because the whole point is that a spool which has stopped draining
 * must not take the customer's agent down with it.
 */
const QUEUE_BYTE_CAP = 64 * 1024 * 1024;

/**
 * Per-STRING cap inside one event, mirroring `MAX_FIELD_BYTES` in
 * `crates/fpai-collect/src/spool.rs`. The Rust spool writer has always enforced
 * this; an SDK publishing into the same directories must too.
 */
const MAX_FIELD_BYTES = 1024 * 1024;

/**
 * Roll a batch file once it reaches this, mirroring `DEFAULT_MAX_BATCH_BYTES`
 * in `spool.rs` and staying under the uploader's `DEFAULT_MAX_UPLOAD_BYTES`.
 *
 * `uploader.rs` documents the invariant this restores: "A single line longer
 * than max is emitted alone rather than dropped: the spool writer already
 * guarantees no such line exists." `splitLines` can only split on newlines — so
 * one oversized event would be POSTed whole, rejected, and the WHOLE spool file
 * (every unrelated event batched with it) parked, retried three times and
 * poisoned. Never delivered, and nothing in the host process would ever learn.
 */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * An encoded event above this is over-large on its own and gets its fields
 * capped. Sits below `MAX_BATCH_BYTES` so a capped event still leaves room for
 * the batch framing around it.
 */
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * How deep `sanitize` will walk before giving up on a branch. Guards the
 * fallback path against a stack overflow, which would defeat the point of
 * having a fallback at all.
 */
const MAX_SANITIZE_DEPTH = 50;

/**
 * How `JSON.stringify` writes a lone surrogate.
 *
 * Unlike Python's `ensure_ascii=True`, JavaScript emits non-ASCII characters
 * literally, so this substring can only appear because a real lone surrogate
 * was escaped (ES2019 well-formed `JSON.stringify`) or because the payload's
 * own text contained the literal characters `\ud8…`. The second is rare enough
 * to be worth the certainty; it costs one re-encode and changes nothing.
 *
 * The lead nibble matters. `\ud` alone also matches U+D000–U+D7FF, which is
 * most of the Hangul syllable block. Real surrogates are U+D800–U+DFFF, whose
 * escapes all begin `\ud8`, `\ud9`, `\uda`…`\udf`.
 */
const SURROGATE_ESCAPES: readonly string[] = [..."89abcdefABCDEF"].map((c) => `\\ud${c}`);

const FIELD_TRUNCATION_MARKER = "…[truncated]";
const CYCLE_MARKER = "<circular reference>";
const DEPTH_MARKER = "<max depth exceeded>";

/**
 * Every live writer. Both the exit flush and `flushAllNow()` iterate this
 * rather than binding to one instance.
 *
 * Node has no `fork()` hazard to guard here the way the Python SDK does: a
 * `worker_threads` Worker and a `cluster` child each load this module afresh
 * and get their own writer with its own timer, so there is no inherited queue
 * with no thread to drain it.
 */
const liveWriters = new Set<EventWriter>();

/**
 * A flush interval the timer can actually run on.
 *
 * Rejected at the boundary, where a caller still has a stack trace pointing at
 * their own `configure()` call:
 *
 *     -1   -> a timer that fires immediately and forever
 *     NaN  -> Node coerces to 1 ms; a busy loop rewriting the spool
 *     Inf  -> Node coerces to 1 ms; the same busy loop
 *      0   -> waits not at all; pins a core and rewrites the spool as fast as
 *             the disk allows
 *
 * Every one of those is a telemetry library becoming the reason the host agent
 * is slow, and none of them throws on its own.
 */
export function validatedInterval(flushInterval: number): number {
  const interval = Number(flushInterval);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error(
      `flushInterval must be a finite number greater than zero, got ${String(flushInterval)}`,
    );
  }
  return interval;
}

/**
 * Roughly how many bytes `value` will occupy once encoded.
 *
 * Walks NODES, not characters: `.length` on a string is O(1), so an ordinary
 * event costs microseconds even though it may carry megabytes of text. That is
 * what makes it affordable on `submit`, which runs on the caller's agent loop.
 *
 * Deliberately approximate — it ignores JSON punctuation and escaping — because
 * it backs a backstop against unbounded growth, not an exact quota.
 */
export function approxSize(value: unknown, depth = 0): number {
  if (depth > MAX_SANITIZE_DEPTH) return 16;
  if (value === null || value === undefined) return 8;
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "bigint") return 8;
  if (kind === "string") return (value as string).length;
  // NOTHING here may throw. `submit` runs on the caller's agent loop, so an
  // exception escaping this function is a telemetry call taking down the host
  // agent — the one failure mode this whole module is written to avoid. A
  // getter on the caller's object can throw anything at all.
  try {
    if (ArrayBuffer.isView(value)) return (value).byteLength;
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) total += approxSize(item, depth + 1);
      return total;
    }
    if (value instanceof Map) {
      let total = 0;
      for (const [key, item] of value) {
        total += (typeof key === "string" ? key.length : 16) + approxSize(item, depth + 1);
      }
      return total;
    }
    if (value instanceof Set) {
      let total = 0;
      for (const item of value) total += approxSize(item, depth + 1);
      return total;
    }
    if (kind === "object") {
      let total = 0;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        total += key.length + approxSize(item, depth + 1);
      }
      return total;
    }
  } catch {
    return 16;
  }
  return 16;
}

/** Drop a trailing high surrogate so a slice never invents a lone one. */
function sliceWithoutSplitting(value: string, end: number): string {
  if (end <= 0) return "";
  const code = value.charCodeAt(end - 1);
  const safeEnd = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  return value.slice(0, safeEnd);
}

/**
 * Truncate every string in `value` to `limit`, marking what was cut.
 *
 * Mirrors `truncate_strings` in `crates/fpai-collect/src/spool.rs`, which has
 * always enforced this on the Rust side of the same spool.
 */
export function capFields(value: unknown, limit: number, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return value;
  // Same rule as `approxSize`: never throw. This runs from `encodeEntry`, whose
  // contract is that ONE bad event is dropped alone rather than taking the
  // batch beside it down.
  try {
    if (typeof value === "string" && value.length > limit) {
      return sliceWithoutSplitting(value, limit) + FIELD_TRUNCATION_MARKER;
    }
    if (Array.isArray(value)) return value.map((item) => capFields(item, limit, depth + 1));
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = capFields(item, limit, depth + 1);
      }
      return out;
    }
  } catch {
    return value;
  }
  return value;
}

/**
 * A string with any lone surrogate made inert.
 *
 * `\ud800`-`\udfff` outside a valid pair is what a byte sequence that is not
 * valid UTF-8 becomes when it is decoded leniently — a filesystem path, a
 * truncated tool output. `JSON.stringify` escapes them happily, so nothing
 * fails locally, and then the SERVER skips the whole event: verified against a
 * live ingest, `{"accepted":0,"skipped":1}` at 200 OK. Replacing each with its
 * visible escape keeps the byte in the payload instead of dropping it.
 */
export function scrubSurrogates(value: string): string {
  // Matches a high surrogate not followed by a low one, or a low surrogate not
  // preceded by a high one.
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Rewrite one payload into something `JSON.stringify` can definitely encode.
 *
 * Only ever reached from `encodeEntry`'s fallback, so it may be slow; it must
 * not be lossy in the ordinary case, and it must not throw.
 *
 * `seen` tracks the objects on the CURRENT PATH, not every object visited. A
 * payload that mentions the same object twice as siblings is a DAG, not a
 * cycle, and JSON encodes it fine — flagging it would corrupt a perfectly good
 * event.
 */
export function sanitize(value: unknown, seen: Set<object>, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return DEPTH_MARKER;
  if (value === undefined || value === null) return null;
  const kind = typeof value;
  // NaN / Infinity / -Infinity. `JSON.stringify` already writes these as `null`,
  // but making it explicit here means the sanitized copy and the strict copy
  // agree rather than differing by an encoder default.
  if (kind === "number") return Number.isFinite(value) ? value : null;
  if (kind === "bigint") return (value as bigint).toString();
  if (kind === "boolean") return value;
  if (kind === "string") return scrubSurrogates(value as string);
  if (kind === "function" || kind === "symbol") return null;

  const object = value;
  if (seen.has(object)) return CYCLE_MARKER;

  try {
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? null : object.toISOString();
    }
    if (ArrayBuffer.isView(object)) return null;

    seen.add(object);
    try {
      if (Array.isArray(object)) {
        return object.map((item) => sanitize(item, seen, depth + 1));
      }
      if (object instanceof Set) {
        return [...object].map((item) => sanitize(item, seen, depth + 1));
      }
      const entries =
        object instanceof Map
          ? [...object.entries()].map(([k, v]) => [String(k), v] as const)
          : Object.entries(object as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        // Keys go through the SAME surrogate scrub as values. A filesystem
        // path, the realistic source, is most naturally a KEY
        // (`{path: contents}`). An unscrubbed key reaches the wire as a JSON
        // lone-surrogate escape, ingest answers 200 `{"accepted":0,"skipped":1}`,
        // and the uploader parks that batch and poisons it after three retries
        // — so one bad key loses every event batched with it.
        out[scrubSurrogates(key)] = sanitize(item, seen, depth + 1);
      }
      return out;
    } finally {
      seen.delete(object);
    }
  } catch {
    seen.delete(object);
    return null;
  }
}

/**
 * The replacer for the FAST path. Handles the values `JSON.stringify` cannot,
 * and nothing else — this is the encoder that must stay byte-identical for
 * every payload that was already valid JSON.
 *
 * Mirrors Python's `default=str`: the values that have an obvious textual form
 * get one, and everything else falls through to the sanitized rebuild below.
 * Functions and symbols are DROPPED rather than stringified — Python's
 * `default=str` would put a lambda's source location on the wire, which is
 * worse than an absent key.
 */
function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * One event as a JSON line, or null if it cannot be encoded at all.
 *
 * THE POINT IS ISOLATION. A single `JSON.stringify` over the whole batch means
 * one unencodable payload takes every event beside it down: the flush restores
 * the batch, the next interval retries the identical batch, and the spool never
 * advances again. An object holding a back-reference — an ordinary thing to
 * hand a telemetry call, and the shape of every framework's run context —
 * permanently ends recording for the process.
 *
 * So: try strict first (the fast path, byte-identical to the plain encoder for
 * every payload that was already valid JSON), fall back to a sanitised copy,
 * and only then give up on that ONE event.
 */
export function encodeEntry(entry: Record<string, unknown>): string | null {
  let encoded: string | null = null;
  // Not a narrow catch on TypeError. A `toJSON()` or a getter runs the CALLER'S
  // code, which can throw anything at all — a RuntimeError out of a lazy ORM
  // attribute, an error out of a property that touches the network. Those would
  // propagate out of the batch write and put the whole batch back on the queue
  // to be retried identically forever: the exact wedge this function exists to
  // prevent, reached through a different error type.
  try {
    encoded = JSON.stringify(entry, replacer) ?? null;
  } catch {
    encoded = null;
  }

  if (encoded !== null && !SURROGATE_ESCAPES.some((escape) => encoded.includes(escape))) {
    return capEncoded(entry, encoded);
  }

  try {
    const sanitized = sanitize(entry, new Set()) as Record<string, unknown>;
    const text = JSON.stringify(sanitized, replacer);
    if (text === undefined) return null;
    return capEncoded(sanitized, text);
  } catch (error) {
    // Nothing left to try. Losing this event is the correct outcome; losing the
    // batch around it is not.
    logException(
      `could not serialize an event (type=${String(entry?.type)}); dropping it`,
      error,
    );
    return null;
  }
}

/**
 * Bound ONE event, re-encoding only when it is actually over-large.
 *
 * Why it has to happen at all: `uploader.rs` states the invariant it relies on
 * — "A single line longer than max is emitted alone rather than dropped: the
 * spool writer already guarantees no such line exists." The Rust spool writer
 * does guarantee it (`truncate_strings` at `MAX_FIELD_BYTES`). An SDK writer
 * publishing into the same directories must too — or one
 * `toolResult({ output: <a large file> })` is written as a single line, POSTed
 * whole because `splitLines` can only split on newlines, rejected, and the
 * ENTIRE spool file parked, retried three times and poisoned. Every unrelated
 * event batched alongside it goes too, and nothing in the host process ever
 * learns.
 */
function capEncoded(entry: Record<string, unknown>, encoded: string): string {
  // `encoded.length` is UTF-16 units, not bytes, so the cheap check has to be
  // the byte count — `Buffer.byteLength` is a native scan and costs far less
  // than the walk it guards.
  if (Buffer.byteLength(encoded, "utf8") <= MAX_EVENT_BYTES) return encoded;
  const capped = capFields(entry, MAX_FIELD_BYTES);
  let recoded: string;
  try {
    const text = JSON.stringify(capped, replacer);
    if (text === undefined) return encoded;
    recoded = text;
  } catch {
    return encoded;
  }
  logger.warn(
    `truncated an oversized event (type=${String(entry?.type)}) from ` +
      `${Buffer.byteLength(encoded, "utf8")} to ${Buffer.byteLength(recoded, "utf8")} bytes; ` +
      `fields above ${MAX_FIELD_BYTES} bytes were cut so the batch stays deliverable`,
  );
  return recoded;
}

interface EncodedLine {
  readonly text: string;
  readonly bytes: number;
}

/** Split encoded lines into batches that each stay under `limit` bytes. */
export function roll(lines: readonly EncodedLine[], limit: number): EncodedLine[][] {
  const chunks: EncodedLine[][] = [];
  let chunk: EncodedLine[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = line.bytes + 1; // the newline this line will be joined with
    if (chunk.length > 0 && size + cost > limit) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function batchStem(): string {
  // `2026-09-23T12-34-56-789Z`: the timestamp orders batches for a human
  // reading the directory, and the pid+counter suffix is what makes the name
  // unique. See `batchSeq` above.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  batchSeq += 1;
  return `event-${stamp}-${process.pid}-${batchSeq - 1}`;
}

interface InFlight {
  readonly chunks: EncodedLine[][];
  /** Incremented in the SAME synchronous tick as the rename that made a chunk durable. */
  done: number;
}

export class EventWriter {
  private queue: Record<string, unknown>[] = [];
  /**
   * Encoded lines from a failed write, retried ahead of the queue.
   *
   * A plain "put the entries back" would re-encode them and, when a batch had
   * already rolled into several files and only a later one failed, rewrite the
   * files that succeeded — duplicating every event in them. Holding the
   * ENCODED lines instead means a partial failure retries exactly what did not
   * land.
   */
  private pending: EncodedLine[] = [];
  private flushInterval: number;
  private dropped = 0;
  private queuedBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private inFlight: InFlight | null = null;
  private closed = false;

  constructor(flushInterval = 0.5) {
    this.flushInterval = validatedInterval(flushInterval);
    this.startTimer();
    liveWriters.add(this);
    ensureExitHook();
  }

  private startTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        // Recording must never die permanently because one flush hit a
        // transient filesystem error. `flush` restores the encoded lines before
        // rejecting, so the next interval retries them.
        logException("event flush failed; buffered events will be retried", error);
      });
    }, this.flushInterval * 1000);
    // The single most important line in this file for not being noticed: an
    // un-unref'd interval keeps the Node event loop alive forever, so a script
    // that merely imports this SDK never exits. `unref` makes the timer stop
    // counting as a reason to stay running, exactly like the daemon thread the
    // Python SDK uses.
    this.timer.unref?.();
  }

  submit(entry: Record<string, unknown>): void {
    if (this.closed) return;
    const size = approxSize(entry);
    // BOTH bounds, and the byte one against measured sizes. A count alone is
    // not a memory bound (the adapters budget 128 KiB of extras per event, so
    // 10,000 of them is ~1.3 GB), and an average-based byte bound is not one
    // either until the average has been learned.
    while (
      this.queue.length > 0 &&
      (this.queue.length >= QUEUE_CAP || this.queuedBytes + size > QUEUE_BYTE_CAP)
    ) {
      const evicted = this.queue.shift();
      if (evicted === undefined) break;
      this.queuedBytes = Math.max(0, this.queuedBytes - approxSize(evicted));
      this.dropped += 1;
      // Powers of ten, so a stuck spool says so without becoming the thing that
      // fills the disk it is complaining about.
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        logger.warn(
          `event queue is full (${this.queue.length} events, ${this.queuedBytes} bytes); ` +
            `discarding oldest. ${this.dropped} dropped so far — the spool is not draining.`,
        );
      }
    }
    this.queue.push(entry);
    this.queuedBytes += size;
  }

  setFlushInterval(interval: number): void {
    // Validate first, assign second: a rejected value must leave the writer
    // running on the interval it already had, not on a half-applied one.
    this.flushInterval = validatedInterval(interval);
    // Restart so the new interval applies from now, not from the end of a cycle
    // that may be an hour long.
    if (!this.closed) this.startTimer();
  }

  getFlushInterval(): number {
    return this.flushInterval;
  }

  /** Drain and write any buffered entries immediately. */
  async flushNow(): Promise<void> {
    await this.flush();
  }

  /**
   * The synchronous flush, for a signal handler or `process.on("exit")`.
   *
   * `exit` handlers may not await, so the periodic path's async writes are no
   * use there. This one blocks, which is exactly right at the end of a process
   * and exactly wrong in a steady-state agent loop.
   */
  flushSync(): void {
    const carried = this.takeInFlightRemainder();
    const lines = [...carried, ...this.drainToLines()];
    if (lines.length === 0) return;
    for (const chunk of roll(lines, MAX_BATCH_BYTES)) {
      try {
        this.writeOneFileSync(chunk);
      } catch (error) {
        logException("final flush failed; buffered events were lost", error);
        return;
      }
    }
  }

  /**
   * Chunks an in-flight async write had not yet renamed.
   *
   * A chunk whose `renameSync` already ran is durable and complete on disk even
   * though the promise that would have recorded it never resolved, so taking it
   * again here would publish a byte-identical duplicate. `done` is incremented
   * in the same synchronous tick as that rename precisely so this check has no
   * window to be wrong in.
   */
  private takeInFlightRemainder(): EncodedLine[] {
    const active = this.inFlight;
    this.inFlight = null;
    if (active === null) return [];
    return active.chunks.slice(active.done).flat();
  }

  private drainToLines(): EncodedLine[] {
    const entries = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    const carried = this.pending;
    this.pending = [];
    return [...carried, ...this.encode(entries)];
  }

  /**
   * Encode BEFORE touching the filesystem. An unencodable event is a permanent
   * condition — retrying it produces the identical failure — so it is dropped
   * here, while a filesystem error is raised from the write and the whole batch
   * goes back to be retried.
   */
  private encode(entries: readonly Record<string, unknown>[]): EncodedLine[] {
    const lines: EncodedLine[] = [];
    let dropped = 0;
    const redact = redactionEnabled(getBaseDir());
    for (const entry of entries) {
      let encoded = encodeEntry(entry);
      if (encoded === null) {
        dropped += 1;
        continue;
      }
      if (redact) {
        try {
          encoded = redactJsonLine(encoded);
        } catch (error) {
          // A redactor that throws must not publish the unredacted line it was
          // handed. Dropping the event is the only safe answer: the whole
          // reason this runs is that the line may carry a credential.
          logException("redaction failed; dropping the event rather than publishing it", error);
          dropped += 1;
          continue;
        }
      }
      lines.push({ text: encoded, bytes: Buffer.byteLength(encoded, "utf8") });
    }
    if (dropped > 0) {
      logger.error(
        `dropped ${dropped} unpublishable event(s) from a batch of ${entries.length}; ` +
          "the rest of the batch was published",
      );
    }
    return lines;
  }

  /**
   * Serialised, so a batch is never drained by two callers at once and — the
   * case that actually bites — so a `flushNow()` from a signal handler waits
   * for an in-flight write instead of racing it.
   */
  private flush(): Promise<void> {
    if (this.flushing !== null) return this.flushing;
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    const lines = this.drainToLines();
    if (lines.length === 0) return;
    const chunks = roll(lines, MAX_BATCH_BYTES);
    const active: InFlight = { chunks, done: 0 };
    this.inFlight = active;
    try {
      for (const chunk of chunks) {
        await this.writeOneFile(chunk, active);
      }
    } catch (error) {
      // Only what did NOT land goes back, at the FRONT — the events that
      // already reached disk must not be published twice.
      const remainder = active.chunks.slice(active.done).flat();
      this.pending = [...remainder, ...this.pending];
      this.queuedBytes += remainder.reduce((total, line) => total + line.bytes, 0);
      this.boundPending();
      throw error;
    } finally {
      if (this.inFlight === active) this.inFlight = null;
    }
  }

  /**
   * The retry buffer obeys the same ceilings as the queue. A spool that has
   * stopped draining must not turn into unbounded growth just because the
   * events are already encoded.
   */
  private boundPending(): void {
    while (
      this.pending.length > 0 &&
      (this.pending.length > QUEUE_CAP || this.queuedBytes > QUEUE_BYTE_CAP)
    ) {
      const evicted = this.pending.shift();
      if (evicted === undefined) break;
      this.queuedBytes = Math.max(0, this.queuedBytes - evicted.bytes);
      this.dropped += 1;
    }
  }

  private eventsDir(): string {
    return join(getBaseDir(), "events");
  }

  private content(lines: readonly EncodedLine[]): Buffer {
    return Buffer.from(`${lines.map((line) => line.text).join("\n")}\n`, "utf8");
  }

  private async writeOneFile(lines: readonly EncodedLine[], active?: InFlight): Promise<void> {
    const dir = this.eventsDir();
    // 0700, and the batch below 0600. These files are not metadata: they carry
    // goals, prompt text, tool arguments and tool output straight from the host
    // agent. Under the ordinary umask 022 they would land 0644 inside 0755
    // directories, so on any shared host — a build box, a bastion, a container
    // with several service accounts — every other local user could read every
    // agent transcript this SDK spools, for the whole flush+upload window and
    // forever if no daemon is running. The daemon reads these as the SAME user,
    // so tightening them costs no delivery.
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const stem = batchStem();
    const tmpPath = join(dir, `${stem}.tmp`);
    const finalPath = join(dir, `${stem}.jsonl`);
    const body = this.content(lines);

    try {
      // O_EXCL + an explicit 0600. The mode is applied at CREATE, so the payload
      // is never briefly world-readable the way a follow-up chmod would leave it.
      const handle = await open(
        tmpPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      try {
        await handle.write(body);
        // fsync BEFORE the rename. A rename is atomic with respect to readers,
        // but atomic is not durable: it orders nothing against the page cache,
        // so a power loss or kernel crash can leave a correctly-named,
        // zero-length or truncated `.jsonl`. The collector reads whatever is
        // there, POSTs it, and then DELETES the file (`remove_file` in
        // `crates/fpai-collect/src/uploader.rs`) — so the loss is permanent and
        // silent, and an empty batch is accepted with a 200. This repo's own
        // Rust spool writer calls `sync_all()` here for exactly this reason.
        await handle.sync();
      } finally {
        await handle.close();
      }

      // SYNCHRONOUS rename, deliberately, in an otherwise-async write. It is a
      // metadata operation measured in microseconds, and doing it synchronously
      // is what lets `done` be incremented in the same tick — so `flushSync`
      // can never see a chunk as un-written after it has become durable, and
      // never publishes a duplicate at exit.
      renameSync(tmpPath, finalPath);
      if (active) active.done += 1;
    } catch (error) {
      // Clean up the partial file on ANY failure. Each flush picks a fresh
      // stem, so without this a persistent fault — a full disk, a read-only
      // mount, a cross-device rename — strands one `.tmp` per flush cycle:
      // roughly 170,000 files a day at the default interval, on the very disk
      // that is already the problem. The watcher ignores them by extension, so
      // nothing else would ever notice or collect them.
      //
      // The batch itself is NOT lost by this: the caller returns the lines to
      // the retry buffer and the next cycle rewrites them under a new name.
      rmSync(tmpPath, { force: true });
      throw error;
    }

    this.syncDirectory(dir);
  }

  private writeOneFileSync(lines: readonly EncodedLine[]): void {
    const dir = this.eventsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const stem = batchStem();
    const tmpPath = join(dir, `${stem}.tmp`);
    const finalPath = join(dir, `${stem}.jsonl`);
    const body = this.content(lines);

    try {
      const fd = openSync(
        tmpPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, finalPath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }

    this.syncDirectory(dir);
  }

  /**
   * fsync the DIRECTORY, or the rename itself can be lost while the file's
   * contents survive — leaving the batch on disk under its `.tmp` name, which
   * the watcher ignores by design.
   *
   * Best-effort: opening a directory for fsync is POSIX behaviour, and
   * platforms that refuse it (Windows) still get the content fsync above, which
   * is the half that prevents a truncated delivery.
   */
  private syncDirectory(dir: string): void {
    let fd: number;
    try {
      fd = openSync(dir, fsConstants.O_RDONLY);
    } catch {
      return;
    }
    try {
      fsyncSync(fd);
    } catch {
      /* platform dependent */
    } finally {
      closeSync(fd);
    }
  }

  /** Stop the timer and drop this writer from the exit hook. Tests only. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    liveWriters.delete(this);
    releaseExitHook();
  }

  /** Diagnostics for tests and for anyone debugging a spool that is not draining. */
  stats(): { queued: number; queuedBytes: number; dropped: number; pending: number } {
    return {
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      dropped: this.dropped,
      pending: this.pending.length,
    };
  }
}

/** Final synchronous flush for every live writer. */
export function flushAllSync(): void {
  for (const writer of [...liveWriters]) {
    try {
      writer.flushSync();
    } catch (error) {
      logException("final flush failed; buffered events were lost", error);
    }
  }
}

/** Await a flush of every live writer. Exposed as `failproofai.flush()`. */
export async function flushAllNow(): Promise<void> {
  await Promise.all(
    [...liveWriters].map(async (writer) => {
      try {
        await writer.flushNow();
      } catch (error) {
        logException("flush failed", error);
      }
    }),
  );
}

/**
 * Register the exit flush, once, and only once there is something to flush.
 *
 * `exit` is the last point at which anything in this process runs, and it runs
 * on a normal return, on an unhandled rejection that terminates, and on an
 * explicit `process.exit()`. It may not await, which is why `flushSync` exists.
 *
 * Registered LAZILY and released when the last writer goes, for two reasons.
 * It keeps a process that merely imports this package from carrying a hook it
 * will never use — and, more practically, it stops the listener count growing
 * when this module is evaluated more than once in one process, which happens
 * whenever both halves of the dual build are loaded (a CommonJS app with an ESM
 * dependency that also uses this SDK) and which Node reports as a
 * `MaxListenersExceededWarning` in the host's own output.
 *
 * Exceptions are swallowed inside `flushAllSync` on purpose: an uncaught one
 * here prints a full stack into the host agent's stderr during shutdown, where
 * it reads as a crash in the application rather than a telemetry flush that
 * failed.
 *
 * SIGINT/SIGTERM are NOT installed. Registering a signal handler CHANGES the
 * process's behaviour — Node's default is to terminate, and a listener
 * suppresses that — so a telemetry library that installed one would silently
 * stop Ctrl-C from working. The README documents the two-line handler instead.
 */
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", flushAllSync);
}

function releaseExitHook(): void {
  if (!exitHookInstalled || liveWriters.size > 0) return;
  exitHookInstalled = false;
  process.removeListener("exit", flushAllSync);
}
