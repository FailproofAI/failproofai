import type { TelemetryConfig } from "@/app/actions/get-telemetry-config";
import { POSTHOG_PRODUCT } from "@/src/posthog-key";

let config: TelemetryConfig | null = null;

export function setClientTelemetryConfig(c: TelemetryConfig): void {
  config = c;
}

export function captureClientEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!config || !config.enabled) return;

  const payload = JSON.stringify({
    api_key: config.apiKey,
    event,
    distinct_id: config.distinctId,
    properties: {
      ...properties,
      $lib: "failproofai-web",
      failproofai_version: config.version,
      product: POSTHOG_PRODUCT,
      $current_url: window.location.href,
      $pathname: window.location.pathname,
    },
  });

  const url = config.host.replace(/\/+$/, "") + "/capture/";

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    // keepalive lets the request outlive a page navigation/unload — without it,
    // events fired right before the page goes away (client_error / unhandled_*
    // from an error boundary, or a share click that opens a new tab) are dropped.
    keepalive: true,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
