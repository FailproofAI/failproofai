// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { makeNextStartupFilter, makeSkewLogFilter } from "../../scripts/skew-log-filter";

// The exact 3-line block Next's standalone server prints to stderr for a stale
// server-action request (reproduced empirically against the real build).
const SKEW_BLOCK = [
  'Error: Failed to find Server Action "402714e0127fd96b57ab64b8f734f9316459cc9edc". This request might be from an older or newer deployment.',
  "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action",
  "    at ignore-listed frames",
];

describe("makeSkewLogFilter", () => {
  it("drops the entire 3-line skew block", () => {
    const f = makeSkewLogFilter();
    for (const line of SKEW_BLOCK) expect(f(line)).toBeNull();
  });

  it("passes unrelated server output through unchanged", () => {
    const f = makeSkewLogFilter();
    expect(f("▲ Next.js 16.2.9")).toBe("▲ Next.js 16.2.9");
    expect(f("- Local:        http://127.0.0.1:8020")).toBe("- Local:        http://127.0.0.1:8020");
    expect(f("✓ Ready in 0ms")).toBe("✓ Ready in 0ms");
    expect(f("GET /audit 200 in 12ms")).toBe("GET /audit 200 in 12ms");
  });

  it("resumes emitting immediately after a skew block ends", () => {
    const f = makeSkewLogFilter();
    SKEW_BLOCK.forEach((l) => expect(f(l)).toBeNull());
    expect(f("GET /policies 200 in 8ms")).toBe("GET /policies 200 in 8ms");
  });

  it("does NOT swallow a genuine error (and its stack) that follows a skew block", () => {
    const f = makeSkewLogFilter();
    SKEW_BLOCK.forEach((l) => f(l));
    expect(f("Error: database connection refused")).toBe("Error: database connection refused");
    expect(f("    at Object.connect (db.ts:10:5)")).toBe("    at Object.connect (db.ts:10:5)");
  });

  it("never drops stack frames outside a skew block", () => {
    const f = makeSkewLogFilter();
    expect(f("Error: something else broke")).toBe("Error: something else broke");
    expect(f("    at foo (bar.ts:1:1)")).toBe("    at foo (bar.ts:1:1)");
  });

  it("handles multiple skew blocks in one stream", () => {
    const f = makeSkewLogFilter();
    SKEW_BLOCK.forEach((l) => expect(f(l)).toBeNull());
    expect(f("GET / 200")).toBe("GET / 200");
    SKEW_BLOCK.forEach((l) => expect(f(l)).toBeNull());
    expect(f("done")).toBe("done");
  });
});

// Next 16's startup banner, exactly as the standalone server prints it on stdout.
const BANNER = [
  "▲ Next.js 16.3.6",
  "- Local:         http://127.0.0.1:8020",
  "- Network:       http://127.0.0.1:8020",
  "✓ Ready in 0ms",
];

// The same lines as they arrive when the child runs with FORCE_COLOR (picocolors).
const COLOURED_BANNER = [
  "\x1B[1m\x1B[35m▲ Next.js 16.3.6\x1B[39m\x1B[22m",
  "- Local:         http://127.0.0.1:8020",
  "- Network:       http://127.0.0.1:8020",
  "\x1B[32m\x1B[1m✓\x1B[22m\x1B[39m Ready in 112ms",
];

describe("makeNextStartupFilter", () => {
  it("drops Next's four startup lines and reports ready at the last one", () => {
    const onReady = vi.fn();
    const f = makeNextStartupFilter(onReady);
    BANNER.slice(0, 3).forEach((l) => expect(f(l)).toBeNull());
    expect(onReady).not.toHaveBeenCalled();
    expect(f(BANNER[3])).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("matches the lines through the colour codes the child adds on a terminal", () => {
    const onReady = vi.fn();
    const f = makeNextStartupFilter(onReady);
    COLOURED_BANNER.forEach((l) => expect(f(l)).toBeNull());
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("passes every other line through verbatim, colour and all", () => {
    const f = makeNextStartupFilter();
    for (const line of [
      "GET /audit 200 in 12ms",
      "\x1B[33m\x1B[1m⚠\x1B[22m\x1B[39m Invalid next.config.js options detected",
      "\x1B[31m\x1B[1m⨯\x1B[22m\x1B[39m Failed to start server",
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:8020",
      "    at Server.setupListenHandle [as _listen2] (node:net:1940:16)",
      "- Debugger port: 9229",
      "",
      "Local: not a banner line without its dash",
      "Ready to serve, said by something else",
    ]) {
      expect(f(line)).toBe(line);
    }
  });

  it("passes everything through after the ready line, even a banner-shaped one", () => {
    const f = makeNextStartupFilter();
    BANNER.forEach((l) => f(l));
    expect(f("- Local:         http://127.0.0.1:8020")).toBe("- Local:         http://127.0.0.1:8020");
    expect(f("✓ Ready in 5ms")).toBe("✓ Ready in 5ms");
    expect(f("▲ Next.js 16.3.6")).toBe("▲ Next.js 16.3.6");
  });

  it("reports ready once, however many ready lines follow", () => {
    const onReady = vi.fn();
    const f = makeNextStartupFilter(onReady);
    f("✓ Ready in 0ms");
    f("✓ Ready in 0ms");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("leaves the skew filter's own contract alone: it still passes the banner through", () => {
    const skew = makeSkewLogFilter();
    BANNER.forEach((l) => expect(skew(l)).toBe(l));
  });
});
