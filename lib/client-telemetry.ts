import type { TelemetryConfig } from "@/app/actions/get-telemetry-config";
import { POSTHOG_PRODUCT } from "@/src/posthog-key";

let config: TelemetryConfig | null = null;

export function setClientTelemetryConfig(c: TelemetryConfig): void {
  config = c;
}

/**
 * The dashboard's pages, as the `app/` directory defines them.
 *
 * Events name the page by its pattern, never by its address. The address is
 * this machine's data: `[name]` is the project slug, which is the project's
 * absolute directory (`-home-alice-acme-merger`), `[sessionId]` names one
 * session, and the query string holds filters and project names. All of it
 * used to reach PostHog in `$current_url` and `$pathname` (FailproofAI/agenteye#1799).
 * A page missing here is reported as `[other]`; a test fails until it is added.
 */
const PAGE_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/$/, "/"],
  [/^\/audit\/?$/, "/audit"],
  [/^\/policies\/?$/, "/policies"],
  [/^\/projects\/?$/, "/projects"],
  [/^\/settings\/?$/, "/settings"],
  [/^\/project\/[^/]+\/?$/, "/project/[name]"],
  [/^\/project\/[^/]+\/session\/[^/]+\/?$/, "/project/[name]/session/[sessionId]"],
];

/** The route pattern a path belongs to, or `[other]`. Never any part of the path itself. */
export function telemetryRoute(pathname: string): string {
  for (const [pattern, route] of PAGE_ROUTES) if (pattern.test(pathname)) return route;
  return "[other]";
}

/**
 * Free text from the page: an error message can hold anything that was on it
 * (a file path, a project name, a snippet of a transcript in a JSON parse
 * error). Never sent, whoever passes it. The error's name, digest and script
 * location still are, which is enough to find the failing code.
 */
const FREE_TEXT_PROPERTIES = new Set(["error_message"]);

/** A location in the app (a path, a page or a script URL) reduced to its route; never the user's part. */
function locationRoute(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const { pathname } = new URL(value, window.location.href);
    // Bundles live under /_next/ and are named by the route pattern, not its values.
    return pathname.startsWith("/_next/") ? pathname : telemetryRoute(pathname);
  } catch {
    return undefined;
  }
}

/** A string that names a place in this app: a path, or an address on this origin. */
function isAppLocation(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("/") || value.startsWith(`${window.location.origin}/`));
}

function scrubbed(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (FREE_TEXT_PROPERTIES.has(key)) continue;
    // `error_filename`, and any value a caller passes that is a location in the
    // app (the navbar's `from_path` was one), goes as its route.
    out[key] = key === "error_filename" || isAppLocation(value) ? locationRoute(value) : value;
  }
  return out;
}

export function captureClientEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!config || !config.enabled) return;

  const route = telemetryRoute(window.location.pathname);
  const payload = JSON.stringify({
    api_key: config.apiKey,
    event,
    distinct_id: config.distinctId,
    properties: {
      ...scrubbed(properties),
      $lib: "failproofai-web",
      failproofai_version: config.version,
      product: POSTHOG_PRODUCT,
      // The page's pattern in both, so a PostHog insight keyed on either keeps
      // working, minus the user's paths and ids.
      $current_url: route,
      $pathname: route,
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
