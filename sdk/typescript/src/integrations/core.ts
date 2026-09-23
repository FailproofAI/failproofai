/**
 * The parts every framework adapter shares: failure policy, patching, identity.
 *
 * An adapter under `integrations/` is supposed to be a **translation table**
 * and nothing else. Everything that is genuinely hard — never throwing into the
 * customer's call stack, restoring exactly what we replaced, mapping a
 * framework's run ids onto FailproofAI identity, keeping payloads inside the
 * store's patience — lives here, in one copy. If an adapter needs something
 * added to this module, that is a signal the core is wrong, not that the
 * adapter is special.
 *
 * Three things in here are load-bearing and easy to "fix" into a bug:
 *
 * * `safe()` must also catch a REJECTED PROMISE, not just a synchronous throw.
 *   Half of every framework's callback surface is `async`, and a try/catch does
 *   not see a rejection.
 * * `RunTracker` never touches `AsyncLocalStorage`. A callback surface whose
 *   start and end are separate calls has no single async subtree to bind in, so
 *   identity is carried in a map and passed EXPLICITLY on every emit.
 * * `fwFields()` is a safety rule, not a style rule. The schema merges extra
 *   fields **last**, so an extra named `tool_name` silently overwrites the
 *   declared one and changes the promoted column.
 */

import { randomUUID } from "node:crypto";

import { DEFAULT_AGENT_ID, current as currentIdentity } from "../context.js";
import type { Identity } from "../context.js";
import { onProcessExit } from "../exit.js";
import { logException, logger } from "../logger.js";
import { runtime } from "../runtime.js";
import { DECLARED_FIELD_NAMES } from "../schema.js";
import { VERSION } from "../version.js";
import { envFlag, versionString } from "./compat.js";

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/**
 * What `integrations/<framework>.ts` must export as `adapter`.
 *
 * `install()` must save the **original attribute object** it replaces (use
 * `Patcher`), and `uninstall()` must restore that saved object rather than
 * re-importing or reconstructing it.
 */
export interface Adapter {
  readonly name: string;
  install(options?: Record<string, unknown>): Promise<void> | void;
  uninstall(): void;
}

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

/**
 * Everything under `integrations/` obeys one rule: never throw into the
 * customer's call stack. Observability that takes the process down with it is
 * worse than no observability. `FAILPROOFAI_SDK_STRICT=1` inverts that for
 * tests and for debugging an adapter that has gone quiet — without it you can
 * only ever prove "it didn't crash", never "it swallowed the right thing".
 */
let strictValue: boolean | null = null;

export function strict(): boolean {
  strictValue ??= envFlag("FAILPROOFAI_SDK_STRICT");
  return strictValue;
}

/** Override the flag. `null` re-reads `FAILPROOFAI_SDK_STRICT`. */
export function setStrict(value: boolean | null): void {
  strictValue = value;
}

/**
 * After this many failures at one call site we stop calling it. A broken
 * adapter should cost one log line, not 40% of the process and a full disk.
 */
const MAX_FAILURES = 3;

const failures = new Map<string, number>();
const disabled = new Set<string>();

/** Re-enable every degraded call site (tests; also `uninstrument()`). */
export function resetFailures(): void {
  failures.clear();
  disabled.clear();
}

export function isDegraded(site: string): boolean {
  return disabled.has(site);
}

function recordFailure(site: string, error: unknown): void {
  const count = (failures.get(site) ?? 0) + 1;
  failures.set(site, count);
  const newlyDisabled = count >= MAX_FAILURES && !disabled.has(site);
  if (newlyDisabled) disabled.add(site);

  if (count === 1) {
    // Logged once per site, with the stack. Repeats are silent: a hook that
    // fails on every token of a streaming response would otherwise become the
    // log volume.
    logException(
      `instrumentation hook ${site} failed; the instrumented call was not affected. ` +
        "Set FAILPROOFAI_SDK_STRICT=1 to re-throw.",
      error,
    );
  } else {
    logger.debug(`instrumentation hook ${site} failed again (${count})`);
  }
  if (newlyDisabled) {
    logger.error(
      `instrumentation hook ${site} failed ${count} times and is now disabled for the rest ` +
        "of this process. Events from it will be missing.",
    );
  }
}

/**
 * Call `fn`, swallowing any failure and degrading a repeatedly failing site.
 *
 * A REJECTED PROMISE counts. Most framework callback surfaces are `async`, so a
 * bare try/catch sees nothing at all when the body fails — the rejection lands
 * as an unhandled rejection in the customer's process instead, which in Node 15+
 * terminates it by default. A telemetry hook must never be able to do that.
 */
export function callSafely<T>(fn: (...args: never[]) => T, args: unknown[], site: string): T | undefined {
  if (disabled.has(site)) return undefined;
  let result: T;
  try {
    result = (fn as (...a: unknown[]) => T)(...args);
  } catch (error) {
    if (strict()) throw error;
    recordFailure(site, error);
    return undefined;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    typeof (result as unknown as PromiseLike<unknown>).then === "function"
  ) {
    return (result as unknown as Promise<unknown>).catch((error: unknown) => {
      if (strict()) throw error;
      recordFailure(site, error);
      return undefined;
    }) as unknown as T;
  }
  return result;
}

function siteOf(fn: unknown, namespace: string): string {
  const named = (fn as { name?: unknown }).name;
  return `${namespace}.${typeof named === "string" && named !== "" ? named : "anonymous"}`;
}

/** Wrap a callback an adapter exposes so it can never throw into the framework. */
export function safe<Args extends unknown[], Result>(
  namespace: string,
  fn: (...args: Args) => Result,
): (...args: Args) => Result | undefined {
  const site = siteOf(fn, namespace);
  const wrapped = (...args: Args): Result | undefined =>
    callSafely(fn as unknown as (...a: never[]) => Result, args, site);
  Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
  return wrapped;
}

function safeCall(fn: ((...args: unknown[]) => unknown) | undefined, args: unknown[], site: string): unknown {
  if (fn === undefined) return undefined;
  return callSafely(fn as (...a: never[]) => unknown, args, site);
}

// ---------------------------------------------------------------------------
// Shape A — wrapper surfaces
// ---------------------------------------------------------------------------

export interface WrapHooks {
  before?: (...args: unknown[]) => unknown;
  after?: (ctx: unknown, result: unknown) => unknown;
  onError?: (ctx: unknown, error: unknown) => unknown;
}

const WRAPPED = Symbol.for("failproofai.wrapped");

/**
 * Wrap a framework callable so start and end are one frame.
 *
 * The structural guarantee, which is the whole reason this is a function and
 * not hand-written try/catch in four adapters: **the user's call sits in
 * exactly one `try`, whose only job is to re-throw.** Nothing we do can change
 * what the wrapped callable returns or throws, because every one of our own
 * calls is outside that block and inside `callSafely`.
 *
 * Async is handled explicitly rather than by luck: when the original returns a
 * thenable we attach our hooks to ITS settlement and hand the caller back a
 * promise that settles exactly as theirs did — same value, same rejection
 * reason, same identity.
 */
export function wrapCallable<T extends (...args: never[]) => unknown>(
  original: T,
  hooks: WrapHooks,
  namespace = "wrap",
): T {
  const site = `${namespace}.${original.name || "anonymous"}`;
  const wrapper = function failproofaiWrapper(this: unknown, ...args: unknown[]): unknown {
    const ctx = safeCall(hooks.before, args, site);
    let result: unknown;
    try {
      result = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } catch (error) {
      safeCall(hooks.onError, [ctx, error], site);
      throw error;
    }
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          safeCall(hooks.after, [ctx, value], site);
          return value;
        },
        (error: unknown) => {
          safeCall(hooks.onError, [ctx, error], site);
          throw error;
        },
      );
    }
    safeCall(hooks.after, [ctx, result], site);
    return result;
  };
  Object.defineProperty(wrapper, "name", {
    value: original.name,
    configurable: true,
  });
  (wrapper as unknown as Record<symbol, unknown>)[WRAPPED] = original;
  return wrapper as unknown as T;
}

export function isWrapped(value: unknown): boolean {
  return (
    typeof value === "function" && (value as unknown as Record<symbol, unknown>)[WRAPPED] !== undefined
  );
}

/** The object we replaced, or `value` itself if we never wrapped it. */
export function unwrap<T>(value: T): T {
  if (typeof value !== "function") return value;
  const original = (value as unknown as Record<symbol, unknown>)[WRAPPED];
  return (original as T) ?? value;
}

// ---------------------------------------------------------------------------
// Observing a stream without owning it
// ---------------------------------------------------------------------------

/**
 * Pass `source` through untouched, handing each part to `onPart` and calling
 * `done` exactly once — when the stream ends, when it errors, or when the
 * reader cancels it.
 *
 * `done(undefined, false)` is a clean end; `done(error, false)` a stream that
 * errored; `done(reason, true)` a consumer that cancelled (the reason is
 * whatever it passed to `cancel()`, or a generic error when it passed nothing).
 * The cancel is forwarded to `source`, so a provider connection is released.
 *
 * A pull-based re-stream rather than `pipeThrough(new TransformStream())`: a
 * transformer's `flush` runs only on a clean end, with no hook for a consumer
 * that walks away or a source that errors — and a model call observed that
 * way stays open forever in exactly the cases worth recording.
 *
 * `onPart` and `done` run under `callSafely(site)`: an observer that throws
 * never breaks the caller's stream.
 */
export function observeStream<T>(
  source: ReadableStream<T>,
  onPart: (part: T) => void,
  done: (error: unknown, cancelled: boolean) => void,
  site: string,
): ReadableStream<T> {
  const reader = source.getReader();
  let finished = false;
  const finish = (error: unknown, cancelled: boolean): void => {
    if (finished) return;
    finished = true;
    callSafely(done, [error, cancelled], site);
  };
  return new ReadableStream<T>({
    async pull(controller) {
      let chunk: { done: boolean; value?: T };
      try {
        chunk = await reader.read();
      } catch (error) {
        finish(error, false);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        finish(undefined, false);
        controller.close();
        return;
      }
      callSafely(onPart, [chunk.value], site);
      controller.enqueue(chunk.value as T);
    },
    cancel(reason) {
      finish(reason ?? new Error("stream cancelled"), true);
      return reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------------------
// Install / uninstall discipline
// ---------------------------------------------------------------------------

interface PatchRecord {
  target: object;
  property: string;
  original: unknown;
  installed: unknown;
  existed: boolean;
}

/**
 * Records what an `install()` replaced so `uninstall()` can put it back.
 *
 * Two rules, both of which exist because instrumentation libraries are
 * routinely installed alongside each other:
 *
 * 1. **Restore the saved object, never a re-import.** Re-importing to restore
 *    hands back whatever the *current* value of the attribute's source is,
 *    which is how two instrumentation libraries silently un-patch each other.
 * 2. **If the attribute is no longer ours, leave it alone.** Somebody patched
 *    on top of us; restoring would delete their patch. We log at WARN and keep
 *    our record, so the customer can see it happened.
 */
export class Patcher {
  private records: PatchRecord[] = [];

  /** Set `target[property] = replacement`, remembering the exact object replaced. */
  patch(target: object, property: string, replacement: unknown): boolean {
    const existed = property in target;
    const original = (target as Record<string, unknown>)[property];
    // An ESM namespace object and a frozen class both refuse assignment —
    // silently in sloppy mode, loudly here. Reporting it lets the caller fall
    // back to a supported wrapping API instead of believing it installed.
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor && !descriptor.configurable && !descriptor.writable) return false;
    try {
      (target as Record<string, unknown>)[property] = replacement;
    } catch {
      return false;
    }
    if ((target as Record<string, unknown>)[property] !== replacement) return false;
    this.records.push({ target, property, original, installed: replacement, existed });
    return true;
  }

  /** Undo every patch, newest first. Never throws. */
  restoreAll(): void {
    const records = [...this.records].reverse();
    this.records = [];
    for (const { target, property, original, installed, existed } of records) {
      try {
        const currentValue = (target as Record<string, unknown>)[property];
        if (currentValue !== installed) {
          logger.warn(
            `not restoring ${describeTarget(target)}.${property} — it is no longer the object ` +
              "this SDK installed (something else patched on top). Leaving the current value " +
              "in place rather than deleting their patch.",
          );
          continue;
        }
        if (existed) {
          (target as Record<string, unknown>)[property] = original;
        } else {
          delete (target as Record<string, unknown>)[property];
        }
      } catch (error) {
        logException(`failed to restore ${describeTarget(target)}.${property}`, error);
      }
    }
  }

  get size(): number {
    return this.records.length;
  }
}

function describeTarget(target: object): string {
  const named = target as { name?: unknown; constructor?: { name?: unknown } };
  if (typeof named.name === "string") return named.name;
  if (typeof named.constructor?.name === "string") return named.constructor.name;
  return "object";
}

// ---------------------------------------------------------------------------
// Payload discipline
// ---------------------------------------------------------------------------

export const TRUNCATION_MARKER = "…[truncated]";
export const FIELD_LIMIT = 8192;

/**
 * How many MAX-SIZE fields one event may carry before `payload()` starts
 * dropping keys. The budget is DERIVED from the field limit rather than being a
 * second independent number, because the two are not independent: raising one
 * without the other silently changes how much survives.
 *
 * This matters because of HOW `payload()` runs out: past the budget it does not
 * shorten the next field, it OMITS THE KEY. A caller raising `fieldLimit`
 * therefore has to raise the budget in step or it trades shortened values for
 * missing ones, which is strictly worse — the event stops saying that anything
 * is absent.
 */
const FIELDS_PER_EVENT = 16;

export const EVENT_BUDGET = FIELD_LIMIT * FIELDS_PER_EVENT;
const MAX_ITEMS = 100;
const MAX_DEPTH = 6;

/** Mutable "did we cut anything" flag, threaded through the recursion. */
class Cut {
  hit = false;
}

/** Remaining bytes for a whole event, spent as `truncateValue` emits. */
class Budget {
  remaining: number;
  constructor(total: number) {
    this.remaining = total;
  }
  spend(n: number): void {
    this.remaining -= n;
  }
  get spentOut(): boolean {
    return this.remaining <= 0;
  }
}

/**
 * Shrink a payload value to something a column store will tolerate.
 *
 * Framework payloads are prompts, retrieved documents and tool outputs — the
 * three largest strings in the process. None of these are promoted columns, so
 * querying them means a JSON extraction over the payload, which has already
 * caused a production memory blowup in the events store. Payload discipline is
 * not optional.
 */
export function truncate(value: unknown, limit: number = FIELD_LIMIT): unknown {
  return truncateValue(value, limit, new Cut(), 0);
}

function truncateValue(
  value: unknown,
  limit: number,
  cut: Cut,
  depth: number,
  budget?: Budget,
): unknown {
  if (value === null || value === undefined) {
    budget?.spend(8);
    return value === undefined ? null : value;
  }
  const kind = typeof value;
  if (kind === "boolean" || kind === "number") {
    budget?.spend(8);
    return value;
  }
  if (kind === "bigint") {
    budget?.spend(8);
    return (value as bigint).toString();
  }
  if (kind === "function" || kind === "symbol") {
    return truncateValue(render(value), limit, cut, MAX_DEPTH, budget);
  }
  if (kind === "string") {
    let text = value as string;
    if (text.length > limit) {
      cut.hit = true;
      text = text.slice(0, Math.max(limit - TRUNCATION_MARKER.length, 0)) + TRUNCATION_MARKER;
    }
    // The per-field limit bounds ONE string; the budget bounds the whole event.
    // A structure whose leaves each fit under the limit would otherwise sail
    // past the budget entirely.
    if (budget) {
      if (text.length > budget.remaining) {
        cut.hit = true;
        const keep = Math.max(budget.remaining - TRUNCATION_MARKER.length, 0);
        text = text.slice(0, keep) + TRUNCATION_MARKER;
      }
      budget.spend(text.length);
    }
    return text;
  }
  if (depth >= MAX_DEPTH) {
    cut.hit = true;
    return truncateValue(render(value), limit, cut, MAX_DEPTH, budget);
  }
  if (value instanceof Date) {
    return truncateValue(
      Number.isNaN(value.getTime()) ? null : value.toISOString(),
      limit,
      cut,
      depth,
      budget,
    );
  }
  if (Array.isArray(value) || value instanceof Set) {
    const items = Array.isArray(value) ? value : [...value];
    const out: unknown[] = [];
    for (const [i, item] of items.slice(0, MAX_ITEMS).entries()) {
      if (budget?.spentOut) {
        cut.hit = true;
        out.push(`[${items.length - i} more items truncated]`);
        return out;
      }
      out.push(truncateValue(item, limit, cut, depth + 1, budget));
    }
    if (items.length > MAX_ITEMS) {
      cut.hit = true;
      out.push(`[${items.length - MAX_ITEMS} more items truncated]`);
    }
    return out;
  }
  const mapping = asMapping(value);
  if (mapping !== null) {
    const entries = Object.entries(mapping);
    const out: Record<string, unknown> = {};
    for (const [i, [key, item]] of entries.entries()) {
      if (i >= MAX_ITEMS) {
        cut.hit = true;
        out["…"] = `[${entries.length - MAX_ITEMS} more keys truncated]`;
        return out;
      }
      if (budget) {
        if (budget.spentOut) {
          cut.hit = true;
          out["…"] = `[${entries.length - i} more keys truncated]`;
          return out;
        }
        budget.spend(key.length);
      }
      out[key] = truncateValue(item, limit, cut, depth + 1, budget);
    }
    return out;
  }
  // An object with no JSON shape is rendered, not cut — `fw_truncated` means
  // "data was lost", and a rendering that fits has lost nothing a JSON encoder
  // would have kept.
  return truncateValue(render(value), limit, cut, MAX_DEPTH, budget);
}

/**
 * A plain object view of `value`, or null.
 *
 * Shallow on purpose. A deep clone would duplicate the whole tree before
 * `truncateValue` gets to decide it only wanted the first 8 KB. Reading the top
 * level and handing it back lets the existing walk apply the field limit, the
 * item cap and the depth cap on the way down.
 *
 * Everything here can execute the caller's own code — a getter, a `toJSON`, a
 * Zod schema's accessor — so all of it is guarded, and a failure falls through
 * to `render`.
 */
function asMapping(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) out[String(key)] = item;
      return out;
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (ArrayBuffer.isView(value)) return null;
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      const dumped: unknown = (toJSON as () => unknown).call(value);
      return typeof dumped === "object" && dumped !== null && !Array.isArray(dumped)
        ? (dumped as Record<string, unknown>)
        : null;
    }
    // Own enumerable properties only. Walking the prototype chain would pull in
    // a framework class's accessors, half of which are lazy and some of which
    // make network calls.
    return { ...(value as Record<string, unknown>) };
  } catch {
    return null;
  }
}

function render(value: unknown): string {
  try {
    if (typeof value === "object" && value !== null) {
      const name = value.constructor?.name;
      return name && name !== "Object" ? `[${name}]` : "[object]";
    }
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    return String(value);
  } catch {
    return "[unrenderable]";
  }
}

function sizeOf(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 8;
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "bigint") return 8;
  if (kind === "string") return (value as string).length;
  if (depth >= MAX_DEPTH) return render(value).length;
  try {
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) total += sizeOf(item, depth + 1);
      return total;
    }
    if (value instanceof Set) {
      let total = 0;
      for (const item of value) total += sizeOf(item, depth + 1);
      return total;
    }
    const mapping = asMapping(value);
    if (mapping !== null) {
      let total = 0;
      for (const [key, item] of Object.entries(mapping)) total += key.length + sizeOf(item, depth + 1);
      return total;
    }
  } catch {
    return 16;
  }
  return render(value).length;
}

/**
 * Apply the per-field limit and the per-event budget to a set of extras.
 *
 * Anything cut sets `fw_truncated=true`, so a surprising-looking payload in the
 * dashboard is self-explaining rather than a mystery.
 */
export function payload(
  fields: Record<string, unknown>,
  options: { limit?: number; budget?: number; cut?: Cut } = {},
): Record<string, unknown> {
  const limit = options.limit ?? FIELD_LIMIT;
  // Shared with the caller when it also truncated something — the tracker cuts
  // the DECLARED parameters itself, and `fw_truncated` has to mean "this event
  // lost data", not "one of its metadata extras did".
  const cut = options.cut ?? new Cut();
  const spend = new Budget(options.budget ?? EVENT_BUDGET);

  // SMALLEST FIRST, spent in that order and emitted in the caller's. The budget
  // binds either way, but insertion order decides WHICH keys survive it, and
  // the adapters put the big payload before the metadata: an oversized
  // `fw_inputs` would consume the whole event and take `fw_run_id` and
  // `fw_node` with it — the two fields that say which run the payload belongs
  // to. Sizing first costs a walk over the node count, not the character count.
  const sized = Object.entries(fields)
    .map(([key, value]) => ({ key, value, size: sizeOf(value) + key.length }))
    .sort((a, b) => a.size - b.size);

  const kept = new Map<string, unknown>();
  for (const { key, value } of sized) {
    if (spend.spentOut) {
      // Past the budget a field does not arrive short, it does not arrive at
      // all — which is why the limit and the budget cannot move independently.
      cut.hit = true;
      continue;
    }
    spend.spend(key.length);
    kept.set(key, truncateValue(value, limit, cut, 0, spend));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (kept.has(key)) out[key] = kept.get(key);
  }
  if (cut.hit) out.fw_truncated = true;
  return out;
}

/**
 * Deliberate exceptions: these are top-level by design. `duration_ms` is how an
 * adapter reports a model call's real latency; `usage` is read by both the
 * server summary and the dashboard as a token fallback; `request_id` pairs
 * model events; `framework*` label every event.
 */
export const ALLOWED_TOP_LEVEL: ReadonlySet<string> = new Set([
  "request_id",
  "duration_ms",
  "usage",
  "traceback",
  "framework",
  "framework_version",
  "integration_version",
]);

/**
 * An extra whose name collides with a declared field SILENTLY OVERWRITES it:
 * the schema ends with a merge of the extras. An adapter reflecting a
 * framework's options into extras would then change `tool_name`, `model`,
 * `outcome` or `input_tokens` — i.e. the promoted columns and the server's
 * computed summary — and every test would still pass.
 */
export const FORBIDDEN_EXTRAS: ReadonlySet<string> = new Set(
  [...DECLARED_FIELD_NAMES].filter((name) => !ALLOWED_TOP_LEVEL.has(name)),
);

const FW_PREFIX = "fw_";

/**
 * Build the `fw_*` extra-field namespace.
 *
 *     fwFields({ run_id: runId, node: "retrieve", tags: undefined })
 *     -> { fw_run_id: "...", fw_node: "retrieve" }
 *
 * Keys are prefixed unless they already are, or are one of the deliberate
 * top-level names. Nullish values are dropped (the schema omits absent
 * optionals anyway, and an extra explicitly set to null would still occupy a
 * key, reach the wire as JSON null, and NULL out a promoted column).
 *
 * Flat only — the server's payload key expression is single-level, so a nested
 * object is not queryable.
 *
 * Values are NOT truncated here. Doing it at this layer would pin every `fw_*`
 * extra at the module-level default while `instrument(..., { captureLimit })`
 * raised the ceiling for the declared fields — half the event honouring the
 * option and half not, with nothing saying which. `payload()`, which receives
 * the tracker's real limit, is the one place that bounds them.
 */
export function fwFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const name = ALLOWED_TOP_LEVEL.has(key) || key.startsWith(FW_PREFIX) ? key : FW_PREFIX + key;
    out[name] = value;
  }
  return guardExtras(out);
}

/**
 * Strip (or, in strict mode, reject) extras that would shadow a real field.
 *
 * Called on every emit, so even an adapter that builds its extras by hand
 * cannot silently rewrite a promoted column.
 */
export function guardExtras(fields: Record<string, unknown>): Record<string, unknown> {
  const bad = Object.keys(fields).filter((key) => FORBIDDEN_EXTRAS.has(key));
  if (bad.length === 0) return fields;
  const message =
    `extra fields ${JSON.stringify(bad.sort())} would overwrite declared event fields ` +
    "(the schema merges extras last). Namespace them as fw_* instead.";
  if (strict()) throw new Error(message);
  logger.warn(`${message} Dropping them.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FORBIDDEN_EXTRAS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The `framework` / `framework_version` / `integration_version` triple.
 *
 * Payload-only, so **not** server-side filterable; promoting it later is a
 * hand-mirrored change across several files, so it is done on demand, not
 * speculatively.
 */
export function frameworkFields(name: string, pkg?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { framework: name, integration_version: VERSION };
  const version = pkg ? versionString(pkg) : null;
  if (version) out.framework_version = version;
  return out;
}

const ID_SEPARATORS = /[\s\-_.:/]+/;
const EMBEDDED_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const UUID_EXACT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const AGENT_ID_LIMIT = 64;

/**
 * Turn a framework's label into something safe for `agentId`.
 *
 * `agent_id` is a `LowCardinality(String)` column and the primary facet on
 * every dashboard surface. A UUID in it poisons that facet permanently —
 * LowCardinality degrades, and the filter dropdown fills with one entry per
 * run. So a value that looks like an id becomes `fallback` and the real id goes
 * to `fw_agent_id` / `fw_run_id` where it belongs.
 */
export function normalizeAgentId(raw: unknown, fallback: string = DEFAULT_AGENT_ID): string {
  if (raw === null || raw === undefined) return fallback;
  const text = (typeof raw === "string" ? raw : render(raw)).split(/\s+/).filter(Boolean).join(" ");
  if (text === "") return fallback;
  if (looksLikeId(text)) return fallback;
  const stripped = stripEmbeddedId(text);
  if (stripped === "") return fallback;
  return stripped.slice(0, AGENT_ID_LIMIT);
}

/** True for UUIDs and long bare hex strings. */
function looksLikeId(text: string): boolean {
  if (UUID_EXACT.test(text)) return true;
  const bare = text.replaceAll("-", "").replaceAll("_", "");
  return bare.length >= 16 && HEX_ONLY.test(bare);
}

/**
 * Drop a per-run id that a readable prefix is carrying.
 *
 * `looksLikeId` only fires on a value that is an id ALL THE WAY THROUGH, so it
 * catches a bare UUID and misses `agent-<uuid>`, `crew_<uuid>`, `task-3f9a1c…`
 * — a readable name with a per-run suffix, which is the shape frameworks
 * actually produce and precisely the one the docs warn against. Those would go
 * through untouched, one distinct value per run, into a `LowCardinality(String)`
 * column that is the primary facet on every dashboard surface.
 *
 * Stripping rather than falling back: `agent-<uuid>` still knows it is an
 * agent, and collapsing every such label to `main` would throw away the one
 * readable thing in it. A segment is dropped only if it is a UUID or a hex run
 * of 16+ characters, so a name like `agent-v2` or `step-3` is untouched.
 */
function stripEmbeddedId(text: string): string {
  // Dashed UUIDs first, and as a substring: splitting on separators would break
  // `task-3f9a1c2b-...` into five segments none of which is an id on its own,
  // so the most standard shape of all would survive the segment pass.
  const stripped = text.replace(EMBEDDED_UUID, " ");
  const parts = stripped.split(ID_SEPARATORS).filter(Boolean);
  const kept = parts.filter((part) => !looksLikeId(part));
  // Nothing was an id: hand back the ORIGINAL, separators and all. Rejoining on
  // spaces would rewrite every `node_a_b` in the process into `node a b`, which
  // is a rename of the primary facet in exchange for nothing.
  if (stripped === text && kept.length === parts.length) return text;
  return kept.join(" ").trim();
}

/**
 * Whole milliseconds, as an integer.
 *
 * The server stores `duration_ms` as a u32 and its JSON parser drops
 * non-integers, so a float silently NULLs the column: the dashboard then shows
 * no duration and nobody sees an error. Negative deltas (clock adjustments, a
 * framework handing us an end before its start) clamp to 0.
 */
export function ms(deltaMs: number): number {
  return Math.max(Math.round(deltaMs), 0);
}

// ---------------------------------------------------------------------------
// Shape B — callback surfaces
// ---------------------------------------------------------------------------

interface Run {
  identity: Identity;
  parentKey: unknown;
  /**
   * The run joined an enclosing `agent()` scope of the same name instead of
   * opening its own agent, so it emits neither `agent_start` nor `agent_end`.
   */
  joined?: boolean;
}

export type EventMethod =
  | "toolUse"
  | "toolResult"
  | "modelRequest"
  | "modelResponse"
  | "agentStart"
  | "agentEnd"
  | "agentPause"
  | "agentResume"
  | "hookTriggered"
  | "hookCompleted"
  | "error"
  | "humanWait"
  | "humanInput"
  | "humanPause"
  | "humanInterrupt";

/**
 * Maps a framework's own run ids onto FailproofAI identity.
 *
 * This is Shape B: the surface where a start and its end are **separate
 * callbacks**, possibly on different async branches. Such an adapter can never
 * use `AsyncLocalStorage` — there is no single subtree to run the pair inside,
 * and `enterWith` in the start callback would bind identity into whatever
 * unrelated context happened to dispatch it. Instead we keep the mapping here
 * and pass `sessionId` / `agentId` **explicitly** on every emit.
 *
 * Bounded (`maxOpen`, FIFO eviction) because orphaned starts are normal: a
 * crashed run, a stream nobody consumed, a framework that forgot an end
 * callback. Unbounded, that is a memory leak in a long-lived server.
 */
/** The event methods that end the run they are keyed on. */
const CLOSING_METHODS: ReadonlySet<string> = new Set(["toolResult", "modelResponse", "hookCompleted"]);


export class RunTracker {
  readonly name: string;
  private readonly maxOpen: number;
  private readonly baseFields: Record<string, unknown>;
  private readonly fieldLimit: number;
  private readonly budget: number;
  private readonly runs = new Map<unknown, Run>();
  private readonly links = new Map<unknown, unknown>();
  /**
   * Open pauses per agent key. A run paused on a human (a LangGraph interrupt,
   * a suspended Mastra workflow) is deliberately left open: another process
   * may take the answer and resume it from the checkpoint. Closing it at this
   * process's exit would end a run that is not over.
   */
  private readonly pauses = new Map<unknown, number>();
  private warned = false;

  constructor(
    name: string,
    options: {
      maxOpen?: number;
      baseFields?: Record<string, unknown>;
      fieldLimit?: number;
    } = {},
  ) {
    this.name = name;
    this.maxOpen = options.maxOpen ?? 10_000;
    this.baseFields = { ...(options.baseFields ?? {}) };
    // One place decides how much of a value survives, for both halves of an
    // event: the declared parameters (`input`, `output`, `messages`) and the
    // `fw_*` extras. Two different rules would mean raising the adapter's limit
    // changed only half the event.
    this.fieldLimit = options.fieldLimit ?? FIELD_LIMIT;
    this.budget = this.fieldLimit * FIELDS_PER_EVENT;
    // A framework run still open when the process exits (a deploy's SIGTERM
    // mid-graph) would otherwise render as running forever. Held weakly, so a
    // tracker an adapter drops is not kept alive by this registration.
    const self = new WeakRef(this);
    const unregister = onProcessExit((exitCode) => {
      const tracker = self.deref();
      if (tracker === undefined) {
        unregister();
        return;
      }
      tracker.closeAtExit(exitCode);
    });
  }

  // -- identity ---------------------------------------------------------

  /**
   * Resolve a run to an identity, in this order:
   *
   * 1. the exact `key`;
   * 2. the `parentKey` chain, walked through every link we have seen — a
   *    framework's own parent run id is a *better* parent chain than an
   *    ambient stack, because it survives async hops;
   * 3. **`failproofai.current()`** — this is the whole interop story. An
   *    adapter running inside a hand-written `agent("planner", ...)` joins that
   *    same session and gets `parentId: "planner"`, so mixing the manual API
   *    and an adapter produces one tree, not two;
   * 4. otherwise the event is dropped and we log **once**.
   */
  identity(key: unknown, parentKey?: unknown, warnOnMiss = true): Identity | null {
    if (key !== undefined && key !== null) {
      const run = this.runs.get(key);
      if (run) return run.identity;
    }
    const walked = this.walk(parentKey);
    if (walked) return walked;

    const ambient = RunTracker.ambient(true);
    if (ambient) return ambient;

    if (warnOnMiss) this.warnUnresolved(key);
    return null;
  }

  /**
   * Step 3: the identity a hand-written scope has bound, if any.
   *
   * When resolving an event we coerce a missing agent id to `main`, but when
   * resolving a *parent* we must not: inside a bare `session(...)` there is no
   * open agent, and claiming `parentId: "main"` would point at an agent that
   * never emitted an `agent_start` — which makes the dashboard synthesize a
   * never-ending root span that stays `ongoing` forever.
   */
  private static ambient(coerceAgent: boolean): Identity | null {
    const identity = currentIdentity();
    if (identity.sessionId === null) return null;
    return {
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? (coerceAgent ? DEFAULT_AGENT_ID : null),
      parentId: identity.parentId,
      depth: identity.depth,
    };
  }

  private walk(parentKey: unknown): Identity | null {
    const seen = new Set<unknown>();
    let key = parentKey;
    while (key !== undefined && key !== null && !seen.has(key)) {
      seen.add(key);
      const run = this.runs.get(key);
      if (run) return run.identity;
      key = this.links.get(key);
    }
    return null;
  }

  private warnUnresolved(key: unknown): void {
    if (this.warned) return;
    this.warned = true;
    logger.warn(
      `${this.name} could not resolve a session for run ${String(key)} and is dropping its ` +
        "events. Wrap the call in `await failproofai.session(fn)` (or " +
        "`await failproofai.agent('name', fn)`) if you want them attributed. This is logged " +
        "once per tracker.",
    );
  }

  /**
   * Record a run's parent without making it an agent.
   *
   * Intermediate framework runs (a LangChain chain, a Mastra step) do not
   * become spans, but their children still need to find the agent above them.
   * This is what makes step 2 of `identity()` work more than one hop up.
   */
  link(key: unknown, parentKey: unknown): void {
    if (key === undefined || key === null) return;
    if (parentKey === undefined || parentKey === null || key === parentKey) return;
    // Delete first so a re-link refreshes the entry's age: the FIFO cap below
    // must evict the runs that have been around longest, not the ones that
    // happened to be linked first.
    this.links.delete(key);
    this.evict(this.links);
    this.links.set(key, parentKey);
  }

  /**
   * Forget a run's link. Call it when the run ENDS.
   *
   * A link is only needed while the run is live — it is how that run's own
   * closing event, and its children's, find the agent above. Kept past that,
   * the table fills to its cap with runs that finished long ago, and the FIFO
   * cap then evicts the links of runs that are STILL RUNNING: on a busy server
   * a model call that outlived ~10k other runs lost its `model_response` to
   * "could not resolve a session". `emit()` does this itself for the closing
   * event types; an adapter that links a run which emits nothing (an
   * intermediate chain) must call it.
   */
  unlink(key: unknown): void {
    this.links.delete(key);
  }

  /** FIFO — a `Map` keeps insertion order. */
  private evict(table: Map<unknown, unknown>): void {
    while (table.size >= this.maxOpen) {
      const oldest = table.keys().next();
      if (oldest.done) break;
      table.delete(oldest.value);
    }
  }

  // -- agents -----------------------------------------------------------

  /** Register a run as an agent and emit `agent_start`. */
  startAgent(
    key: unknown,
    options: {
      agentId: string;
      parentKey?: unknown;
      sessionId?: string;
      goal?: string;
    } & Record<string, unknown>,
  ): Identity {
    const { agentId, parentKey, sessionId, goal, ...fields } = options;
    const parent = this.resolveParent(parentKey);
    const sid = sessionId ?? parent?.sessionId ?? randomUUID().replace(/-/g, "");
    const aid = normalizeAgentId(agentId);
    // `await agent("support", () => graph.invoke(...))` around a graph also
    // named "support" is the user saying "this run IS my agent", not "my agent
    // contains an agent of the same name". Opening a second one gave every run
    // two agent_start/agent_end pairs and an agent listed as its own parent.
    // So a framework root that lands directly inside a hand-written scope of
    // the same name, in the same session, joins it. Differently named, it
    // still nests — that is a real tree.
    if (
      parent !== null &&
      parent.agentId === aid &&
      parent.sessionId === sid &&
      this.walk(parentKey) === null
    ) {
      this.runs.delete(key);
      this.evict(this.runs);
      this.runs.set(key, { identity: parent, parentKey, joined: true });
      this.link(key, parentKey);
      return parent;
    }
    const identity: Identity = {
      sessionId: sid,
      agentId: aid,
      parentId: parent?.agentId ?? null,
      depth: parent ? parent.depth + 1 : 1,
    };
    this.runs.delete(key);
    this.evict(this.runs);
    this.runs.set(key, { identity, parentKey });
    this.link(key, parentKey);
    this.emitWith("agentStart", identity, {
      goal: goal === undefined ? undefined : truncate(goal, this.fieldLimit),
      parentId: identity.parentId,
      ...fields,
    });
    return identity;
  }

  /**
   * Emit `agent_end` and forget the run.
   *
   * `outcome` is `"failed"`, never `"failure"` — the server only counts
   * `error|failed|timeout|rejected` as a failure.
   */
  endAgent(
    key: unknown,
    options: { outcome?: string; summary?: string } & Record<string, unknown> = {},
  ): void {
    const { outcome = "success", summary, ...fields } = options;
    const run = this.runs.get(key);
    this.runs.delete(key);
    this.pauses.delete(key);
    const identity = run?.identity ?? this.identity(key);
    this.links.delete(key);
    if (identity === null) return;
    // A joined run's agent belongs to the enclosing scope, which ends it — and
    // records the failure, if the error propagates out of the framework call.
    if (run?.joined === true) return;
    this.emitWith("agentEnd", identity, {
      outcome,
      summary: summary === undefined ? undefined : truncate(summary, this.fieldLimit),
      ...fields,
    });
  }

  openAgents(): unknown[] {
    return [...this.runs.keys()];
  }

  /** Whether `key` is an open agent. O(1) — `openAgents()` copies every key. */
  isOpen(key: unknown): boolean {
    return this.runs.has(key);
  }

  /**
   * Drop an agent and its link WITHOUT emitting anything.
   *
   * For an agent this process will never close but must stop holding: a run
   * paused on a human and resumed by another worker. Closing it here would put
   * a second `agent_end` into a session the other worker ends; keeping it
   * would hold a slot in the table live runs need.
   */
  forget(key: unknown): void {
    this.runs.delete(key);
    this.links.delete(key);
    this.pauses.delete(key);
  }

  /** @internal Table sizes, for the tests that prove nothing is retained. */
  stats(): { runs: number; links: number } {
    return { runs: this.runs.size, links: this.links.size };
  }

  /**
   * Close every still-open agent, newest first.
   *
   * A session that dies with an open `agent_start` renders as `ongoing`
   * forever, so teardown closes what it opened.
   */
  closeOpenAgents(outcome = "cancelled"): void {
    for (const key of this.openAgents().reverse()) this.endAgent(key, { outcome });
  }

  /**
   * The process is exiting: end every open agent as `failed`, newest first —
   * except one paused on a human, which is waiting, not abandoned (`pauses`).
   */
  closeAtExit(exitCode = 0): void {
    // Open tools, hooks and model calls were already closed, in the `leaves`
    // phase, by the event namespace every adapter emits through (exit.ts).
    const message = `the process exited (code ${exitCode}) while this run was still running`;
    for (const key of this.openAgents().reverse()) {
      if ((this.pauses.get(key) ?? 0) > 0) continue;
      const identity = this.runs.get(key)?.identity;
      if (identity && this.runs.get(key)?.joined !== true) {
        // `error` strictly before `agent_end`, as a scope that threw would.
        this.emitWith("error", identity, { errorType: "ProcessExit", message });
      }
      this.endAgent(key, { outcome: "failed", summary: "the process exited while this run was open" });
    }
  }

  reset(): void {
    this.runs.clear();
    this.links.clear();
    this.pauses.clear();
    this.warned = false;
  }

  // -- everything else --------------------------------------------------

  /**
   * Emit any `failproofai.event.*` method against a run's identity.
   *
   * Drops the event (with one warning) when nothing resolves, rather than
   * inventing a session id: a synthesized session splits one run into many.
   */
  emit(
    method: EventMethod,
    key: unknown,
    fields: { parentKey?: unknown } & Record<string, unknown> = {},
  ): void {
    const { parentKey, ...rest } = fields;
    if (parentKey !== undefined && parentKey !== null) this.link(key, parentKey);
    if (method === "agentPause") this.pauses.set(key, (this.pauses.get(key) ?? 0) + 1);
    if (method === "agentResume") {
      const open = (this.pauses.get(key) ?? 0) - 1;
      if (open > 0) this.pauses.set(key, open);
      else this.pauses.delete(key);
    }
    const identity = this.identity(key, parentKey);
    // A closing event ends the run it is keyed on, so its link is done with.
    // Its children closed before it, and anything later that still names it
    // resolves through its parent chain or the ambient scope — see `unlink`.
    if (CLOSING_METHODS.has(method)) this.links.delete(key);
    if (identity === null) return;
    this.emitWith(method, identity, rest);
  }

  private emitWith(method: EventMethod, identity: Identity, fields: Record<string, unknown>): void {
    callSafely(
      () => {
        this.emitNow(method, identity, fields);
      },
      [],
      `${this.name}.${method}`,
    );
  }

  private emitNow(method: EventMethod, identity: Identity, fields: Record<string, unknown>): void {
    // Two kinds of key here, and the split is by NAME, not by meaning: `fw_*`
    // (plus whatever the adapter set as base fields) are payload extras and go
    // through the guard and the size budget; everything else is a real option
    // of the `event.*` method — `toolName`, `input`, `outcome` — and is passed
    // straight through. Those still get truncated, because `input`, `output`,
    // `messages` and `content` are exactly the fields a framework fills with a
    // 200 KB prompt.
    const declared: Record<string, unknown> = {};
    const extras: Record<string, unknown> = {};
    // ONE `Cut` across both halves. A throwaway one per declared field would
    // set `fw_truncated` — the only machine-readable "this event lost data"
    // signal — when a small `fw_*` extra was cut and NOT when the prompt or the
    // completion was. Exactly the wrong way round: `output` is cut on
    // essentially every real tool loop.
    const cut = new Cut();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (key.startsWith(FW_PREFIX) || ALLOWED_TOP_LEVEL.has(key)) {
        extras[key] = value;
      } else {
        declared[key] = truncateValue(value, this.fieldLimit, cut, 0);
      }
    }
    const merged = payload(guardExtras({ ...this.baseFields, ...extras }), {
      limit: this.fieldLimit,
      budget: this.budget,
      cut,
    });
    // A base field named like a real option would be a duplicate key; the
    // explicit value wins.
    for (const key of Object.keys(declared)) delete merged[key];

    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with `.call` below, so `this` is explicit
    const emit = runtime.event[method] as (options: Record<string, unknown>) => void;
    emit.call(runtime.event, {
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      ...declared,
      ...merged,
    });
  }

  private resolveParent(parentKey: unknown): Identity | null {
    const walked = this.walk(parentKey);
    if (walked) return walked;
    // Same three steps as `identity()`, minus the exact-key lookup (a run
    // cannot be its own parent) and minus the warning (a root agent with no
    // ambient scope is normal, not a dropped event).
    return RunTracker.ambient(false);
  }
}
