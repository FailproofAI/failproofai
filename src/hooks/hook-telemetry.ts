/**
 * Lightweight PostHog telemetry for the compiled hook binary.
 *
 * Uses fetch() directly instead of posthog-node, since the binary
 * doesn't have access to node_modules at runtime.
 */

import { version } from "../../package.json";
import { POSTHOG_API_KEY, POSTHOG_PRODUCT } from "../posthog-key";

const API_KEY = POSTHOG_API_KEY;
const CAPTURE_URL = "https://us.i.posthog.com/capture/";

/**
 * In-flight telemetry POSTs. The hook binary is short-lived — `bin/failproofai.mjs`
 * calls `process.exit()` the moment `handleHookEvent` returns, which kills any
 * fetch that a caller fired with `void trackHookEvent(...)` (i.e. did not await).
 * We track every send here so `flushHookTelemetry()` can await them all at the
 * process-exit boundary, making delivery reliable regardless of whether the
 * individual call site awaited. Without this, un-awaited events (custom_hooks_loaded,
 * convention_policies_loaded, the *_error events) are dropped on the common
 * allow path, since no trailing await holds the event loop open.
 */
const pending = new Set<Promise<void>>();

async function sendEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    api_key: process.env.FAILPROOFAI_POSTHOG_KEY ?? API_KEY,
    event,
    distinct_id: distinctId,
    properties: { ...properties, $lib: "failproofai-hooks", failproofai_version: version, product: POSTHOG_PRODUCT },
  });

  try {
    await fetch(
      process.env.FAILPROOFAI_POSTHOG_HOST
        ? `${process.env.FAILPROOFAI_POSTHOG_HOST}/capture/`
        : CAPTURE_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch {
    // Telemetry is best-effort — never fail the hook
  }
}

export async function trackHookEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (process.env.FAILPROOFAI_TELEMETRY_DISABLED === "1") return;

  const p = sendEvent(distinctId, event, properties);
  pending.add(p);
  // Deregister on settle so the set doesn't grow unbounded in long-lived
  // callers (tests, the dashboard server). `sendEvent` never rejects, but
  // `.finally` is defensive.
  void p.finally(() => pending.delete(p));
  await p;
}

/**
 * Await every in-flight telemetry POST. Call this immediately before
 * `process.exit()` on any short-lived path so `void trackHookEvent(...)` events
 * are delivered instead of being cut off by the exit. No-op (resolves instantly)
 * when nothing is pending. Never throws — `sendEvent` swallows its own errors.
 */
export async function flushHookTelemetry(): Promise<void> {
  // Loop in case a settling promise's `.finally` races a newly-added send;
  // in practice one pass suffices because no send spawns another.
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
