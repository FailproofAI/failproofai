/**
 * Opt-out telemetry for Failproof AI.
 *
 * Set FAILPROOFAI_TELEMETRY_DISABLED=1 to disable all telemetry.
 * When disabled every export is a zero-cost no-op.
 *
 * The PostHog API key is write-only (safe to commit).
 * The client is stored on globalThis to survive Next.js HMR.
 */

import { getInstanceId } from "./telemetry-id";
import { isTelemetryEnabled } from "./telemetry-enabled";
import { version } from "../package.json";
import { POSTHOG_API_KEY, POSTHOG_PRODUCT } from "../src/posthog-key";

const DEFAULT_API_KEY = POSTHOG_API_KEY;
const DEFAULT_HOST = "https://us.i.posthog.com";

declare global {
  var __FAILPROOFAI_POSTHOG__: PostHogClient | undefined;
}

/** Minimal interface for the subset of PostHog we use. */
interface PostHogClient {
  capture(event: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface PostHogOptions {
  host: string;
  flushAt: number;
  flushInterval: number;
  requestTimeout?: number;
  fetchRetryCount?: number;
  fetchRetryDelay?: number;
}

/**
 * Returns true unless the user has explicitly opted out, via either
 * `FAILPROOFAI_TELEMETRY_DISABLED=1` or `[telemetry] enabled = false` in
 * config.toml. Re-exported from the shared resolver so all four dispatchers
 * cannot drift — see lib/telemetry-enabled.ts.
 */
export { isTelemetryEnabled };

/**
 * Lazily import posthog-node and create a client.
 *
 * No-op when telemetry is disabled. **Never throws** — callers (the
 * Next.js API routes and the CLI subcommands) can `await initTelemetry()`
 * unguarded and a posthog init failure can't 500 a valid auth response.
 * The outer try/catch is the single source of truth; do NOT add a
 * per-call wrapper at the call sites.
 */
export async function initTelemetry(): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;
    if (globalThis.__FAILPROOFAI_POSTHOG__) return;

    const mod: { PostHog: new (key: string, opts: PostHogOptions) => PostHogClient } =
      await import("posthog-node");
    const apiKey = process.env.FAILPROOFAI_POSTHOG_KEY ?? DEFAULT_API_KEY;
    const host = process.env.FAILPROOFAI_POSTHOG_HOST ?? DEFAULT_HOST;
    // Delivery-critical options. Every one of these was previously set to a
    // value that lost events; see __tests__/lib/telemetry-delivery.test.ts,
    // which pins the contract against the REAL library rather than a mock.
    //
    // No custom `fetch`. There used to be a `resilientFetch` wrapper here that
    // retried five times over ~40s and then returned a synthetic 200 so
    // posthog-node would never log a network error. It could not work: the
    // library does not merely hand its abort signal to an injected fetch, it
    // *races* that fetch against its own `requestTimeout` deadline
    // (`Promise.race([fetchPromise, deadline])`) precisely because an injected
    // fetch may ignore the signal — which ours did, by stripping it. With a
    // ~40s budget racing a 5s deadline the wrapper could never return in time,
    // so the synthetic 200 was unreachable, the `console.error` it existed to
    // prevent fired anyway, and its retries ran on detached from the client that
    // had already given up. Plain global fetch is what the library expects.
    //
    // `fetchRetryCount` was 0, which disabled retries entirely and left the
    // wrapper above as the only thing retrying — the wrong layer. The library
    // retries inside a single flush, knows which errors are retryable, and
    // keeps its queue coherent while doing it.
    //
    // `flushInterval` was 0, which is falsy and therefore disables the flush
    // timer completely. That is the one that actually stranded events: on a
    // network error posthog-node deliberately does NOT dequeue the batch (it
    // treats the failure as transient and keeps it for a later attempt), so
    // with no timer armed those retained events had nothing scheduled to
    // resend them and sat in memory until an unrelated later event happened to
    // trigger a flush.
    //
    // `flushAt: 1` is deliberate and stays. Volume here is a handful of events
    // per process, so batching buys nothing, and posthog-node's queue is
    // memory-only (`PostHogMemoryStorage`) — anything still queued when the
    // process dies is gone. Sending immediately is the best available defense.
    globalThis.__FAILPROOFAI_POSTHOG__ = new mod.PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 10_000,
      requestTimeout: 10_000,
      fetchRetryCount: 3,
      fetchRetryDelay: 3_000,
    });

    // Flush pending events when the process exits. This drain is the last line
    // of defense for the memory-only queue, so it must not fight itself:
    // `beforeExit` re-fires every time a handler schedules more async work, and
    // an unguarded handler starts a fresh `shutdown()` — each with its own 30s
    // budget — on every one of those passes.
    let draining = false;
    const onExit = () => {
      if (draining) return;
      draining = true;
      globalThis.__FAILPROOFAI_POSTHOG__?.shutdown().catch(() => {});
    };
    process.on("beforeExit", onExit);
    process.on("SIGTERM", onExit);
    process.on("SIGINT", onExit);
  } catch (err) {
    // Always log init failures — silent swallowing makes standalone debugging impossible
    console.warn("[failproofai:telemetry] init failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Track a named event. No-op when telemetry is disabled or the client
 * has not been initialised.
 */
export function trackEvent(
  name: string,
  properties?: Record<string, unknown>,
): void {
  if (!isTelemetryEnabled()) return;
  const client = globalThis.__FAILPROOFAI_POSTHOG__;
  if (!client) return;

  client.capture({
    distinctId: getInstanceId(),
    event: name,
    properties: { ...properties, $lib: "failproofai", failproofai_version: version, product: POSTHOG_PRODUCT },
  });
}

/** Flush pending events without tearing down the client. */
export async function flushTelemetry(): Promise<void> {
  const client = globalThis.__FAILPROOFAI_POSTHOG__;
  if (!client) return;
  await client.flush();
}

/** Flush pending events and tear down the client. */
export async function shutdownTelemetry(): Promise<void> {
  const client = globalThis.__FAILPROOFAI_POSTHOG__;
  if (!client) return;
  await client.shutdown();
}
