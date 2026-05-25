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

export async function trackHookEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (process.env.FAILPROOFAI_TELEMETRY_DISABLED === "1") return;

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
