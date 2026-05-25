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
  fetch?: (url: string, options: Record<string, unknown>) => Promise<Response>;
}

/**
 * Wraps native fetch with retry logic and silent failure for non-critical telemetry.
 * Prevents posthog-node's internal console.error from firing on network errors.
 */
async function resilientFetch(
  url: string,
  options: Record<string, unknown>,
): Promise<Response> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 1000;
  const TIMEOUT_MS = 5000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { signal: _, ...rest } = options;
      const res = await fetch(url, {
        ...(rest as RequestInit),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return res;
      // Non-2xx (e.g. 502) — treat like a transient failure and retry
    } catch {
      // Network error (ETIMEDOUT, etc.) — retry
    }
    if (attempt < MAX_ATTEMPTS) {
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // All attempts failed — return fake OK so PostHog doesn't log errors.
  // This is anonymous telemetry; silently dropping events is acceptable.
  return new Response("{}", { status: 200 });
}

/** Returns true unless the user has explicitly opted out. */
export function isTelemetryEnabled(): boolean {
  return process.env.FAILPROOFAI_TELEMETRY_DISABLED !== "1";
}

/**
 * Lazily import posthog-node and create a client.
 * No-op when telemetry is disabled.
 */
export async function initTelemetry(): Promise<void> {
  if (!isTelemetryEnabled()) return;
  if (globalThis.__FAILPROOFAI_POSTHOG__) return;

  try {
    const mod: { PostHog: new (key: string, opts: PostHogOptions) => PostHogClient } =
      await import("posthog-node");
    const apiKey = process.env.FAILPROOFAI_POSTHOG_KEY ?? DEFAULT_API_KEY;
    const host = process.env.FAILPROOFAI_POSTHOG_HOST ?? DEFAULT_HOST;
    globalThis.__FAILPROOFAI_POSTHOG__ = new mod.PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: 5000,
      fetchRetryCount: 0,
      fetch: resilientFetch,
    });

    // Flush pending events when the process exits
    const onExit = () => {
      globalThis.__FAILPROOFAI_POSTHOG__?.shutdown().catch(() => {});
    };
    process.on("beforeExit", onExit);
    process.on("SIGTERM", onExit);
    process.on("SIGINT", onExit);
  } catch (err) {
    // Always log init failures — silent swallowing makes standalone debugging impossible
    console.warn("[failproofai:telemetry] PostHog init failed:", err instanceof Error ? err.message : err);
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
