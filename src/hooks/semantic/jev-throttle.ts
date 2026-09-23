/**
 * Cache and rate limit in front of a Jev transport, so a burst of tool calls
 * stays under the provider's limit instead of degrading silently.
 *
 * `throttleTransport(t, opts?)` returns a transport with the same contract as
 * `t`. It adds two things and nothing else:
 *
 * - **An LRU cache** keyed by the SHA-256 of the full request (model, state
 *   and questions, byte for byte as serialized, plus an optional `scope`).
 *   The request is everything Jev sees — no clock, no randomness — so an
 *   identical request is an identical question, and its answer is reused for
 *   a short TTL. The TTL runs from when the answer was fetched; a hit never
 *   extends it. Only answers the evaluator accepts are stored (`readAnswers`:
 *   a probability in [0, 1] for every question asked, from a model it
 *   accepts), bounded by entry count and by size, and
 *   every hit hands back a fresh copy, so a caller mutating its response can
 *   never change what the next caller gets. A side effect worth having: within
 *   the TTL, retrying a denied call gets the same answer rather than a fresh
 *   draw from a model that is ~98% run-to-run stable.
 * - **A token bucket** (default 5 req/s, burst 5; see `ThrottleOptions` for
 *   what those bound) on the calls that actually go upstream; cache hits are
 *   free. Over budget, it throws
 *   `JevError("rate-limited")` at once, so the evaluator degrades and the
 *   caller falls back to the regex result with a recorded reason — visibly,
 *   not silently. `maxWaitMs` lets a call wait briefly for the next token
 *   instead. A provider 429 empties the bucket as of when the 429 arrived
 *   (however long that round-trip took), so the calls right behind it fall
 *   back locally instead of spending more requests on a full window.
 *
 * It never throws on its own except for those two cases: an over-budget call,
 * and a signal that is already aborted (or aborts while waiting for a token).
 * Every error from the wrapped transport is rethrown unchanged — the same
 * object — and never cached. Internal failures (a request that cannot be
 * serialized, say) skip the cache; they never fail the call.
 *
 * **State is module-level.** The daemon's warm worker (`worker-server.ts`) is
 * the only evaluator on a configured machine and lives for hours, so the
 * process is the cache and the bucket is the process's upstream budget: a
 * caller may build a new wrapper per hook event and every wrapper shares both.
 * The worker also serializes `evaluateHookEvent`, so there is never more than
 * one Jev call in flight and no in-flight de-duplication is needed.
 *
 * **No on-disk cache**, deliberately. It would only help the one-shot
 * in-process path, which on a configured machine does not exist (CLAUDE.md,
 * "Enforcement routes through the daemon": only this repo's dogfood configs
 * and not-yet-set-up machines evaluate in-process). And it would be a
 * poisoning surface: every file under `~/.failproofai` is writable by the same
 * user the agent runs as, and the request format is open source, so the agent
 * being judged could compute the digest of the call it is about to make and
 * pre-write an all-clear answer — clearing reviewable denies without Jev ever
 * being asked. The worker's memory has no such surface. Signing the entries
 * would not help: any key the hook can read, the agent can read too.
 *
 * **What a caller wiring this in must do** (T3), because the module cannot see
 * any of it from here:
 *
 * - **Pass `scope`** naming where answers come from, e.g.
 *   `` `${route.via}|${route.endpoint}|${route.model}` `` from T1's route. The
 *   request alone does not say which provider, endpoint or model answered — a
 *   transport may send a model other than `request.model` — and the cache is
 *   process-wide, so without a scope a `jev.json` change in a long-lived
 *   worker serves the old provider's answers under the new one until they
 *   expire. The scope is only ever hashed into the key, never stored, so an
 *   endpoint carrying a credential in its query string is safe to pass. It
 *   cannot default to anything better: the transport's identity changes on
 *   every hook event (a new wrapper each time), which would turn the cache off.
 * - **A hit is the original answer, `usage` included**, returned in ~0 ms.
 *   Anything that sums tokens or cost, or takes latency percentiles, must tell
 *   hits apart. `evaluateSemantic` never exposes the response, so wrap the
 *   throttled transport and ask {@link isCachedJevResponse}:
 *   `async (r, s) => { const res = await throttled(r, s); cached = isCachedJevResponse(res); return res; }`
 *   then record `inputTokens: null` (and flag the latency) when `cached`.
 * - **Tests** that route through a throttled transport share this module's
 *   state across every file bun runs in one process: call
 *   `resetJevThrottle()` in `beforeEach`, or pass
 *   `{ cacheTtlMs: 0, ratePerSec: 1e6 }` where caching and limiting are not
 *   what is under test.
 */
import { createHash } from "node:crypto";
import { JevError, readAnswers, type JevTransport } from "./jev-client";
import type { JevRequest, JevResponse } from "./types";

export interface ThrottleOptions {
  /**
   * Sustained upstream requests per second. Default 5, from the one Cloudflare
   * figure there is: a replay against one key sustained ~6 calls/s before
   * HTTP 429s took over (measured over the replay as a whole, not over any
   * one-second window). Cloudflare publishes its Workers AI limits per
   * minute (300/min for text generation by default, i.e. 5/s); whether
   * `typesafe/jev` is under that default, and so which window a burst runs
   * into, is unconfirmed (R4 or a live check). TypeSafe documents 1,200/min
   * (20/s). Must be a positive finite number, else the default.
   */
  ratePerSec?: number;
  /**
   * Bucket capacity — how many calls may go out back to back. Default: one
   * second's worth (`ratePerSec`, at least 1), so a handful of parallel tool
   * calls after a pause are all judged. A bucket admits at most
   * `burst + ratePerSec` calls in any one-second window (10 with the
   * defaults) and `burst + 60 × ratePerSec` in any minute (305). Against a
   * per-minute limit that is the sustained rate plus one burst; against a
   * strict per-second one it could spend a few calls a provider refuses, and
   * the first 429 then empties the bucket, so the loss stays at a few calls
   * per burst. Pass `burst: 1` to cap any one second at `1 + ratePerSec`.
   */
  burst?: number;
  /** How long a call may wait for the next token before it is rate-limited. Default 0: over budget fails at once. */
  maxWaitMs?: number;
  /** How long an answer is reused, from when it was fetched. Default 5 minutes. 0 disables the cache. */
  cacheTtlMs?: number;
  /** Most answers kept. Default 512. 0 disables the cache. */
  cacheMaxEntries?: number;
  /** Most characters of serialized answers kept (≈ bytes; answers are ASCII JSON). Default 4 MiB. 0 disables the cache. */
  cacheMaxBytes?: number;
  /**
   * Mixed into the cache key (hashed, never stored): where the answers came
   * from — provider, endpoint and the model actually sent, e.g.
   * `` `${via}|${endpoint}|${model}` ``. Answers cached under one scope are
   * never served under another. Default `""`, which every unscoped wrapper in
   * the process shares: a real caller should always pass one (see the module
   * doc).
   */
  scope?: string;
  /** Monotonic clock in milliseconds. For tests; defaults to `performance.now()`. */
  now?: () => number;
}

export const DEFAULT_THROTTLE = Object.freeze({
  ratePerSec: 5,
  maxWaitMs: 0,
  cacheTtlMs: 5 * 60_000,
  cacheMaxEntries: 512,
  cacheMaxBytes: 4 * 1024 * 1024,
});

/** One answer bigger than this is never cached. A full request's answers are a few KB. */
export const MAX_CACHED_ENTRY_CHARS = 64 * 1024;

interface ResolvedOptions {
  ratePerSec: number;
  burst: number;
  maxWaitMs: number;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  scope: string;
  now: () => number;
}

const positive = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
const nonNegative = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

function resolveOptions(opts: ThrottleOptions): ResolvedOptions {
  const ratePerSec = positive(opts.ratePerSec, DEFAULT_THROTTLE.ratePerSec);
  const cacheTtlMs = nonNegative(opts.cacheTtlMs, DEFAULT_THROTTLE.cacheTtlMs);
  const cacheMaxEntries = Math.floor(nonNegative(opts.cacheMaxEntries, DEFAULT_THROTTLE.cacheMaxEntries));
  const cacheMaxBytes = nonNegative(opts.cacheMaxBytes, DEFAULT_THROTTLE.cacheMaxBytes);
  return {
    ratePerSec,
    burst: Math.max(1, positive(opts.burst, ratePerSec)),
    maxWaitMs: nonNegative(opts.maxWaitMs, DEFAULT_THROTTLE.maxWaitMs),
    cacheEnabled: cacheTtlMs > 0 && cacheMaxEntries > 0 && cacheMaxBytes > 0,
    cacheTtlMs,
    cacheMaxEntries,
    cacheMaxBytes,
    scope: typeof opts.scope === "string" ? opts.scope : "",
    now: typeof opts.now === "function" ? opts.now : () => performance.now(),
  };
}

// ── Module state (shared by every wrapper in the process) ────────────────────

interface Entry {
  body: string;
  expiresAt: number;
  size: number;
}

const cache = new Map<string, Entry>();
let cacheChars = 0;
/** Tokens may go negative: a waiting call reserves the next one. NaN = not yet used. */
const bucket = { tokens: Number.NaN, last: Number.NaN };
const counters = { hits: 0, misses: 0, rateLimited: 0, upstreamErrors: 0, evictions: 0 };
/** Responses this module handed out from the cache; see {@link isCachedJevResponse}. */
let servedFromCache = new WeakSet<object>();

export interface JevThrottleStats {
  /** Answers served from the cache. */
  hits: number;
  /** Lookups that found nothing (cache enabled only). */
  misses: number;
  /** Calls refused locally because the bucket was empty. */
  rateLimited: number;
  /** Errors the wrapped transport threw (passed through). */
  upstreamErrors: number;
  /** Entries dropped to stay within the size bounds (not counting expiry). */
  evictions: number;
  /** Answers currently cached. */
  entries: number;
  /** Characters currently cached. */
  chars: number;
}

export function jevThrottleStats(): JevThrottleStats {
  return { ...counters, entries: cache.size, chars: cacheChars };
}

/** Empties the cache and the bucket and zeroes the counters. */
export function resetJevThrottle(): void {
  cache.clear();
  cacheChars = 0;
  bucket.tokens = Number.NaN;
  bucket.last = Number.NaN;
  counters.hits = 0;
  counters.misses = 0;
  counters.rateLimited = 0;
  counters.upstreamErrors = 0;
  counters.evictions = 0;
  servedFromCache = new WeakSet<object>();
}

/**
 * True when `response` came from the cache rather than the network — for a
 * caller that wants to record it. A hit costs nothing and takes ~0 ms, but it
 * still carries the original answer's `usage`: token and cost totals must
 * skip it. Through `evaluateSemantic`, wrap the throttled transport to see
 * the response (module doc).
 */
export function isCachedJevResponse(response: unknown): boolean {
  return typeof response === "object" && response !== null && servedFromCache.has(response);
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * The cache key: SHA-256 over the scope and the full request exactly as
 * serialized. Exported so a replay (R4) can measure hit rates with the same
 * key the worker uses. Throws if the request cannot be serialized.
 */
export function jevRequestDigest(request: JevRequest, scope = ""): string {
  return createHash("sha256").update(scope).update("\0").update(JSON.stringify(request)).digest("hex");
}

function keyFor(cfg: ResolvedOptions, request: JevRequest): string | null {
  if (!cfg.cacheEnabled) return null;
  try {
    return jevRequestDigest(request, cfg.scope);
  } catch {
    return null; // Unserializable: no cache for this call, never an error.
  }
}

function dropEntry(key: string, entry: Entry): void {
  cache.delete(key);
  cacheChars -= entry.size;
}

function cacheGet(key: string, now: number): JevResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    dropEntry(key, entry);
    return null;
  }
  // Most recently used goes last; eviction takes from the front.
  cache.delete(key);
  cache.set(key, entry);
  try {
    return JSON.parse(entry.body) as JevResponse;
  } catch {
    dropEntry(key, entry);
    return null;
  }
}

/**
 * Only an answer the evaluator could use is worth keeping. The rule is the
 * evaluator's own (`readAnswers`: a probability in [0, 1] for every question,
 * and a model it accepts), not a copy of it, so the two cannot drift apart: a
 * wrong-model answer the evaluator rejects is never pinned for the TTL.
 */
function isUsableAnswer(request: JevRequest, response: JevResponse): boolean {
  try {
    readAnswers(request, response);
    return true;
  } catch {
    return false;
  }
}

function cachePut(cfg: ResolvedOptions, key: string, request: JevRequest, response: JevResponse, now: number): void {
  if (!isUsableAnswer(request, response)) return;
  let body: string;
  try {
    body = JSON.stringify(response);
  } catch {
    return;
  }
  const size = key.length + body.length;
  if (size > MAX_CACHED_ENTRY_CHARS || size > cfg.cacheMaxBytes) return;
  const prev = cache.get(key);
  if (prev) dropEntry(key, prev);
  cache.set(key, { body, expiresAt: now + cfg.cacheTtlMs, size });
  cacheChars += size;
  for (const [k, e] of cache) {
    const expired = now >= e.expiresAt;
    if (!expired && cache.size <= cfg.cacheMaxEntries && cacheChars <= cfg.cacheMaxBytes) break;
    dropEntry(k, e);
    if (!expired) counters.evictions++;
  }
}

// ── Token bucket ─────────────────────────────────────────────────────────────

/** Error codes meaning the provider itself refused for rate: `http-429` from the HTTP layer, or a transport's own `rate-limited`. */
const PROVIDER_WINDOW_FULL = new Set(["http-429", "rate-limited"]);

function refill(cfg: ResolvedOptions, now: number): void {
  if (!Number.isFinite(bucket.last) || !Number.isFinite(bucket.tokens)) {
    bucket.tokens = cfg.burst;
    bucket.last = now;
    return;
  }
  const elapsed = Math.max(0, now - bucket.last);
  bucket.last = now;
  bucket.tokens = Math.min(cfg.burst, bucket.tokens + (elapsed * cfg.ratePerSec) / 1000);
}

function abortedError(signal: AbortSignal): JevError {
  const name = (signal.reason as { name?: unknown } | undefined)?.name;
  return name === "TimeoutError"
    ? new JevError("timeout", "Jev did not answer in time")
    : new JevError("aborted", "the Jev request was aborted");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Takes one token, waiting up to `maxWaitMs` for it, or throws `rate-limited`. */
async function acquire(cfg: ResolvedOptions, signal: AbortSignal | undefined): Promise<void> {
  refill(cfg, cfg.now());
  bucket.tokens -= 1;
  if (bucket.tokens >= 0) return;
  const waitMs = (-bucket.tokens / cfg.ratePerSec) * 1000;
  if (waitMs > cfg.maxWaitMs) {
    bucket.tokens += 1;
    counters.rateLimited++;
    throw new JevError(
      "rate-limited",
      `local Jev budget of ${cfg.ratePerSec} request(s)/s is spent; next slot in ${Math.ceil(waitMs)} ms`,
    );
  }
  try {
    await sleep(waitMs, signal);
  } catch (err) {
    bucket.tokens += 1; // The reserved slot was never used.
    throw err;
  }
}

// ── The wrapper ──────────────────────────────────────────────────────────────

/**
 * `t` behind the shared cache and token bucket. `opts` is read once, here;
 * every call through the returned transport uses it.
 */
export function throttleTransport(t: JevTransport, opts?: ThrottleOptions | null): JevTransport {
  const cfg = resolveOptions(opts ?? {});
  return async (request, signal) => {
    // The type says a signal is always passed; a caller that omits one still gets no throw from here.
    if (signal?.aborted) throw abortedError(signal);

    const key = keyFor(cfg, request);
    if (key !== null) {
      const hit = cacheGet(key, cfg.now());
      if (hit) {
        counters.hits++;
        servedFromCache.add(hit);
        return hit;
      }
      counters.misses++;
    }

    await acquire(cfg, signal);

    let response: JevResponse;
    try {
      response = await t(request, signal);
    } catch (err) {
      counters.upstreamErrors++;
      // The provider's window is full: the calls right behind this one fall
      // back locally until the bucket refills, rather than each spending a
      // request to learn the same thing. Refill to now first: the bucket was
      // last stamped when this call was admitted, so without it the next
      // refill would credit the whole round-trip (hundreds of ms against a
      // real provider, i.e. one or more tokens) and undo the emptying.
      if (err instanceof JevError && PROVIDER_WINDOW_FULL.has(err.code)) {
        refill(cfg, cfg.now());
        bucket.tokens = Math.min(bucket.tokens, 0);
      }
      throw err;
    }

    if (key !== null) cachePut(cfg, key, request, response, cfg.now());
    return response;
  };
}
