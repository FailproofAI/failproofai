/**
 * Shared PostHog API key used by both the Next.js telemetry client
 * and the compiled hook binary telemetry. Write-only (safe to commit).
 */
export const POSTHOG_API_KEY = "phc_Ac1Ww1GqKc0z1SyrRWbmatEeQdlOQIsDEEdP8l8JRgX";

/**
 * Product identifier attached to the `product` property of every PostHog
 * event, across all telemetry channels (hooks, web, server, install).
 * Single source of truth so the value never drifts between channels.
 * The standalone npm-lifecycle script (scripts/install-telemetry.mjs) can't
 * import this TS module at install time, so it inlines the same literal.
 */
export const POSTHOG_PRODUCT = "failproofai-oss";
