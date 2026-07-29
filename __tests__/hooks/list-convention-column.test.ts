// @vitest-environment node
//
// `failproofai policies` pads the convention-policy filename column to
// `nameColWidth`, which is sized to the longest BUILTIN policy name. A
// convention filename can be longer, and `padEnd` to a width below the string
// length is a no-op — so the hook count ran straight into the filename with no
// separator at all:
//
//   ✓  enforce-bengaluru-event-links-policies.mjs1 hook(s): enforce-links-...
//
// Reported from a live install. These assert the gutter survives.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listHooks } from "@/src/hooks/manager";

const LONG_NAME = "enforce-bengaluru-event-links-policies.mjs";
const SHORT_NAME = "team-policies.mjs";

function policySource(hookName: string): string {
  return `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({
      name: ${JSON.stringify(hookName)},
      description: "test policy",
      match: { events: ["PreToolUse"] },
      fn: async () => allow(),
    });
  `;
}

describe("listHooks — convention policy column width", () => {
  let tmp: string;
  let emptyHome: string;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fp-list-"));
    emptyHome = mkdtempSync(join(tmpdir(), "fp-list-home-"));
    // Keep the developer's own user-scope policies out of the output.
    vi.stubEnv("HOME", emptyHome);
    vi.stubEnv("USERPROFILE", emptyHome);
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  function seed(files: Record<string, string>) {
    const dir = join(tmp, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, "utf8");
    }
  }

  it("keeps a gap between a long filename and its hook count", async () => {
    seed({ [LONG_NAME]: policySource("enforce-links-in-bengaluru-events") });

    await listHooks(tmp);

    const row = lines.find((l) => l.includes(LONG_NAME));
    expect(row).toBeDefined();
    // The regression: `...policies.mjs1 hook(s)` with no separator.
    expect(row).not.toMatch(new RegExp(`${LONG_NAME.replace(/\./g, "\\.")}\\d`));
    expect(row).toMatch(/\.mjs\s+1 hook\(s\)/);
  });

  it("aligns short and long filenames to the same column", async () => {
    seed({
      [LONG_NAME]: policySource("enforce-links-in-bengaluru-events"),
      [SHORT_NAME]: policySource("team-rule"),
    });

    await listHooks(tmp);

    const columnOf = (filename: string) => {
      const row = lines.find((l) => l.includes(filename))!;
      return row.replace(/\[[0-9;]*m/g, "").indexOf("1 hook(s)");
    };

    expect(columnOf(LONG_NAME)).toBeGreaterThan(0);
    expect(columnOf(SHORT_NAME)).toBe(columnOf(LONG_NAME));
  });
});
