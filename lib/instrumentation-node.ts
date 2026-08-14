/**
 * Node.js-only instrumentation logic.
 * Dynamically imported from the root instrumentation.ts only when NEXT_RUNTIME === 'nodejs',
 * so that Turbopack/Edge compilation never sees Node.js APIs like process.arch or node:os.
 */
export async function registerNode() {
  const os = await import("node:os");

  const { initLogger } = await import("./logger");
  initLogger();

  const { initTelemetry, trackEvent, flushTelemetry } = await import("./telemetry");
  await initTelemetry();

  const { hashToId } = await import("./telemetry-id");
  const { version } = await import("../package.json");

  trackEvent("app_started", {
    version,
    runtime: typeof globalThis !== "undefined" && "Bun" in globalThis ? "bun" : "node",
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    has_custom_posthog: !!process.env.FAILPROOFAI_POSTHOG_KEY,
    has_projects_path: !!process.env.FAILPROOFAI_PROJECTS_PATH,
    logging_level: process.env.FAILPROOFAI_LOG_LEVEL ?? "default",
    deploy_mode: process.env.NODE_ENV === "production" ? "standalone" : "dev",
    os_release: os.release(),
    uptime: os.uptime(),
    total_memory_gb: Math.round(os.totalmem() / 1e9 * 10) / 10,
    cpu_count: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? "unknown",
    hostname_hash: hashToId(os.hostname()),
  });
  // Fire and forget — telemetry should never block server startup
  flushTelemetry().catch(() => {});
}
