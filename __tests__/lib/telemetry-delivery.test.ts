// @vitest-environment node
/**
 * End-to-end delivery tests for lib/telemetry.ts against the REAL posthog-node.
 *
 * This file exists because `__tests__/lib/telemetry.test.ts` mocks `posthog-node`
 * wholesale, and that mock is what let a delivery bug live in the tree: the
 * client was configured with an injected `resilientFetch` that retried for ~40s
 * against posthog-node's own 5s `requestTimeout` deadline, with `flushInterval:
 * 0` disabling the flush timer and `fetchRetryCount: 0` disabling the library's
 * retries. Every one of those is invisible to a mock — the constructor was
 * called with the right shape, so the mock-based suite passed while real events
 * were being stranded in an in-memory queue.
 *
 * So: no mock of posthog-node here. A local HTTP server stands in for PostHog
 * and the assertions are on bytes that actually arrived over a socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

vi.mock("@/lib/telemetry-id", () => ({
  getInstanceId: () => "delivery-test-instance",
}));

import { initTelemetry, trackEvent, shutdownTelemetry } from "@/lib/telemetry";
import { trackHookEvent, flushHookTelemetry } from "@/src/hooks/hook-telemetry";

interface CapturedRequest {
  url: string;
  body: string;
}

interface TestServer {
  url: string;
  server: Server;
  received: CapturedRequest[];
  /** Number of requests answered so far, including failed ones. */
  hits: () => number;
}

/**
 * A stand-in for PostHog's ingestion endpoint. `failFirst` makes the first N
 * requests answer 500 so a retry can be observed; the body is still recorded so
 * a test can prove the retry carried the same payload.
 */
async function startServer(opts: { failFirst?: number } = {}): Promise<TestServer> {
  const received: CapturedRequest[] = [];
  let hits = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits++;
      // posthog-node gzips the batch body (`content-encoding: gzip`). Reading it
      // raw yields binary, which silently parses as "no events delivered" — so
      // decompress here rather than letting a green test mean nothing.
      const raw = Buffer.concat(chunks);
      const body =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf-8")
          : raw.toString("utf-8");
      received.push({ url: req.url ?? "", body });
      if (opts.failFirst && hits <= opts.failFirst) {
        res.writeHead(500, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: 1 }));
    });
  });

  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}`, server, received, hits: () => hits });
    });
  });
}

/** Poll until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every event name carried in the batches the server actually received. */
function deliveredEvents(received: CapturedRequest[]): string[] {
  const names: string[] = [];
  for (const req of received) {
    try {
      const parsed = JSON.parse(req.body) as { batch?: Array<{ event?: string }> };
      for (const item of parsed.batch ?? []) {
        if (item.event) names.push(item.event);
      }
    } catch {
      // A body we can't parse is not a delivered event; the assertions will say so.
    }
  }
  return names;
}

describe("lib/telemetry delivery (real posthog-node)", () => {
  let ph: TestServer | undefined;

  beforeEach(() => {
    globalThis.__FAILPROOFAI_POSTHOG__ = undefined;
    // vitest.config.mts sets this globally; delivery is exactly what it suppresses.
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
    process.env.FAILPROOFAI_POSTHOG_KEY = "phc_delivery_test";
  });

  afterEach(async () => {
    await shutdownTelemetry().catch(() => {});
    globalThis.__FAILPROOFAI_POSTHOG__ = undefined;
    delete process.env.FAILPROOFAI_POSTHOG_KEY;
    delete process.env.FAILPROOFAI_POSTHOG_HOST;
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    await new Promise<void>((done) => {
      if (!ph) return done();
      ph.server.close(() => done());
    });
    ph = undefined;
  });

  it("delivers a captured event to the ingestion endpoint", async () => {
    ph = await startServer();
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;

    await initTelemetry();
    trackEvent("app_started", { runtime: "node" });

    await waitFor(() => deliveredEvents(ph!.received).includes("app_started"), 10_000);

    expect(deliveredEvents(ph.received)).toContain("app_started");
    expect(ph.received.map((r) => r.url)).toContain("/batch/");

    // The payload is the point — assert the properties survived the trip, not
    // just that some request arrived.
    const batch = ph.received
      .map((r) => JSON.parse(r.body) as { batch?: Array<Record<string, unknown>> })
      .flatMap((p) => p.batch ?? []);
    const event = batch.find((e) => e.event === "app_started");
    expect(event).toBeDefined();
    expect(event!.distinct_id).toBe("delivery-test-instance");
    expect(event!.properties).toMatchObject({
      runtime: "node",
      product: "failproofai-oss",
      failproofai_version: expect.any(String),
    });

    // `$lib` is NOT ours on this path, despite trackEvent() setting it to
    // "failproofai": posthog-node owns that reserved property and overwrites it
    // with its own name and version on every event. (The raw-fetch dispatcher in
    // src/hooks/hook-telemetry.ts has no SDK to overwrite it, so its
    // "failproofai-hooks" value does survive — the two paths disagree by
    // construction.) Attribution that actually holds across both is `product`,
    // asserted above; pinned here so nobody "fixes" trackEvent to fight the SDK.
    expect((event!.properties as Record<string, unknown>).$lib).toBe("posthog-node");
  }, 15_000);

  it("does not log a flush error when delivery succeeds", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    ph = await startServer();
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;

    await initTelemetry();
    trackEvent("app_started");
    await waitFor(() => deliveredEvents(ph!.received).includes("app_started"), 10_000);

    // posthog-node reports flush failures through a hardcoded console.error
    // (`logFlushError`) on a fire-and-forget internal promise — no `.catch()` at
    // our call sites can intercept it, so this is the only way to assert it.
    const flushErrors = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes("Error while flushing PostHog"),
    );
    expect(flushErrors).toEqual([]);
    consoleError.mockRestore();
  }, 15_000);

  it("retries a failed send and still delivers the event", async () => {
    // The regression this guards: `fetchRetryCount: 0` meant a single transient
    // failure dropped the batch out of the only delivery attempt it would get.
    ph = await startServer({ failFirst: 1 });
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;

    await initTelemetry();
    trackEvent("app_started");

    // posthog-node's first retry waits `fetchRetryDelay` (3s), so budget past it.
    await waitFor(() => ph!.hits() >= 2, 20_000);

    expect(ph.hits()).toBeGreaterThanOrEqual(2);
    // Both the failed attempt and the retry carried the event.
    expect(deliveredEvents(ph.received).filter((n) => n === "app_started").length).toBeGreaterThanOrEqual(2);
  }, 25_000);
});

/**
 * The other dispatcher, and the one carrying the most traffic: every hook event
 * across all 11 CLIs plus the audit CLI's `cli_audit_*` events (37 call sites)
 * goes through `trackHookEvent`. `__tests__/hooks/hook-telemetry.test.ts` covers
 * the payload shape against a stubbed global fetch; these assert that bytes
 * actually reach a listening socket, which a stub cannot show.
 */
describe("hook-telemetry delivery (real socket)", () => {
  let ph: TestServer | undefined;

  beforeEach(() => {
    delete process.env.FAILPROOFAI_TELEMETRY_DISABLED;
  });

  afterEach(async () => {
    delete process.env.FAILPROOFAI_POSTHOG_HOST;
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";
    await new Promise<void>((done) => {
      if (!ph) return done();
      ph.server.close(() => done());
    });
    ph = undefined;
  });

  it("delivers an awaited hook event to the capture endpoint", async () => {
    ph = await startServer();
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;

    await trackHookEvent("hook-instance", "hooks_installed", { count: 1 });

    expect(ph.received).toHaveLength(1);
    expect(ph.received[0].url).toBe("/capture/");
    const body = JSON.parse(ph.received[0].body) as Record<string, unknown>;
    expect(body.event).toBe("hooks_installed");
    expect(body.distinct_id).toBe("hook-instance");
    expect(body.properties).toMatchObject({
      count: 1,
      product: "failproofai-oss",
      // Unlike the posthog-node path, no SDK overwrites $lib here, so the
      // dispatcher's own tag is what lands.
      $lib: "failproofai-hooks",
    });
  }, 15_000);

  it("flushHookTelemetry lands events the caller never awaited", async () => {
    ph = await startServer();
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;

    // The `void trackHookEvent(...)` shape used on the allow path, where no
    // trailing await holds the event loop open before process.exit(). This is
    // the guarantee flushHookTelemetry exists to provide.
    void trackHookEvent("hook-instance", "custom_hooks_loaded", { n: 2 });
    void trackHookEvent("hook-instance", "convention_policies_loaded", { n: 3 });

    await flushHookTelemetry();

    const names = ph.received.map((r) => (JSON.parse(r.body) as { event: string }).event);
    expect(names.sort()).toEqual(["convention_policies_loaded", "custom_hooks_loaded"]);
  }, 15_000);

  it("sends nothing once telemetry is opted out", async () => {
    ph = await startServer();
    process.env.FAILPROOFAI_POSTHOG_HOST = ph.url;
    process.env.FAILPROOFAI_TELEMETRY_DISABLED = "1";

    await trackHookEvent("hook-instance", "hooks_installed");
    await flushHookTelemetry();

    expect(ph.received).toEqual([]);
  }, 15_000);
});
