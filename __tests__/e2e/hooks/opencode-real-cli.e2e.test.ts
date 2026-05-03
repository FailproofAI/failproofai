/**
 * E2E: real `opencode` binary smoke test.
 *
 * Skipped automatically when the `opencode` binary is not on PATH (e.g. in
 * CI without opencode installed). When present, exercises the surface our
 * dashboard adapters depend on:
 *   • `opencode debug paths` returns the documented standard paths
 *   • `opencode debug config` returns a JSON object with `plugin_origins`
 *   • `opencode db --format json "<sql>"` works with read-only queries
 * These are what `lib/opencode-projects.ts` and `lib/opencode-sessions.ts`
 * shell out to. If opencode's contract drifts in a future release, this
 * test catches it before we hit users.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

function hasOpenCodeBinary(): boolean {
  try {
    // Probe the binary directly so this works in environments without `which`
    // (Windows, minimal containers, etc.).
    execFileSync("opencode", ["--version"], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENCODE = hasOpenCodeBinary();
const describeIfOpenCode = HAS_OPENCODE ? describe : describe.skip;

describeIfOpenCode("E2E: opencode binary smoke test", () => {
  it("opencode debug paths emits the documented set of standard paths", () => {
    const out = execFileSync("opencode", ["debug", "paths"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    // The output is a key-value table; just check the documented keys appear.
    expect(out).toMatch(/\bhome\b/);
    expect(out).toMatch(/\bdata\b/);
    expect(out).toMatch(/\bconfig\b/);
    expect(out).toMatch(/\bcache\b/);
    expect(out).toMatch(/\bstate\b/);
  });

  it("opencode debug config emits valid JSON with a 'plugin' array", () => {
    const out = execFileSync("opencode", ["debug", "config"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const config = JSON.parse(out);
    expect(config).toHaveProperty("plugin");
    expect(Array.isArray(config.plugin)).toBe(true);
  });

  it("opencode db --format json supports read-only SELECT queries", () => {
    // A bare schema query — works on any non-empty install. Returns [] if
    // the session table has no rows yet, but never fails.
    const out = execFileSync("opencode", [
      "db", "--format", "json",
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const tables = JSON.parse(out) as Array<{ name: string }>;
    expect(Array.isArray(tables)).toBe(true);
    const tableNames = tables.map((t) => t.name);
    // The lib/opencode-{projects,sessions}.ts modules SELECT from these.
    expect(tableNames).toContain("session");
    expect(tableNames).toContain("project");
    expect(tableNames).toContain("message");
    expect(tableNames).toContain("part");
  });

  it("opencode db --format json returns [] for empty result sets (not an error)", () => {
    const out = execFileSync("opencode", [
      "db", "--format", "json",
      "SELECT * FROM session WHERE id = 'definitely-not-a-real-session-id'",
    ], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out.trim() === "[]" || out.trim() === "").toBe(true);
  });
});
