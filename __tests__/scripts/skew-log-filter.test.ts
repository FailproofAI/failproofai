// @vitest-environment node
import { describe, it, expect } from "vitest";
import { makeSkewLogFilter } from "../../scripts/skew-log-filter";

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
