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
import { customPoliciesDir } from "../../src/hooks/fp-home";

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

  // Running `failproofai policies` from $HOME makes the project and user
  // convention directories the SAME path. The listing walked both, so every
  // file was printed twice — and the second pass rendered them all as
  // "failed to load", because the first pass had already imported the module
  // and the ESM cache short-circuits `customPolicies.add`, so
  // `loadCustomHooks` legitimately returns 0 hooks. Reported from a live
  // install where four working policies all showed ✗.
  it("does not double-list from $HOME, even though the two dirs collide again", async () => {
    // The original defect: run from $HOME and both scopes resolved to the SAME
    // <tmp>/.failproofai/policies, so every file printed twice and the second
    // pass rendered as "failed to load" (the ESM cache short-circuits
    // customPolicies.add, so loadCustomHooks legitimately returns 0 hooks).
    //
    // Layout 2 removes the collision by construction: user convention policies
    // live in policies/custom-policies/, project ones in <cwd>/.failproofai/
    // policies/. They can no longer be the same path, whatever the cwd. The
    // dedup logic still exists for other cases; this asserts the shape that
    // made it necessary is gone.
    // LAYOUT 3 REINTRODUCES THE COLLISION, deliberately: user convention
    // policies moved back to `~/.failproofai/policies/`, so running from $HOME
    // makes user scope and project scope the same directory again. Layout 2
    // made that impossible by construction; layout 3 trades the structural
    // guarantee for a simpler tree and relies on the dedup logic instead.
    //
    // Which makes the assertion below the ONLY thing standing between a user
    // and the original defect, so it is asserted rather than assumed.
    expect(customPoliciesDir(tmp)).toBe(join(tmp, ".failproofai", "policies"));

    seed({ [SHORT_NAME]: policySource("team-rule") });
    vi.stubEnv("HOME", tmp);
    vi.stubEnv("USERPROFILE", tmp);

    await listHooks(tmp);

    // The regression that mattered: one row per file, never "failed to load".
    const rows = lines.filter((l) => l.includes(SHORT_NAME));
    expect(rows).toHaveLength(1);
    expect(rows.join("\n")).not.toContain("failed to load");
  });

  it("still lists both directories when they differ", async () => {
    seed({ [SHORT_NAME]: policySource("team-rule") });
    const otherHome = mkdtempSync(join(tmpdir(), "fp-list-other-"));
    vi.stubEnv("HOME", otherHome);
    vi.stubEnv("USERPROFILE", otherHome);
    try {
      await listHooks(tmp);
      const headers = lines.filter((l) => l.includes("Convention Policies"));
      expect(headers).toHaveLength(1);
      expect(headers[0]).toContain("Project");
      expect(headers[0]).not.toContain("Project + User");
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("renders a dashboard-disabled explicit custom policy as OFF", async () => {
    const policyPath = join(tmp, "custom.mjs");
    writeFileSync(policyPath, policySource("custom-rule"), "utf8");
    mkdirSync(join(tmp, ".failproofai"), { recursive: true });
    writeFileSync(
      join(tmp, ".failproofai", "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        customPoliciesPaths: [policyPath],
        disabledCustomPolicies: [`custom:${policyPath}:custom-rule`],
      }),
      "utf8",
    );

    await listHooks(tmp);

    const row = lines.find((line) => line.includes("custom-rule"));
    expect(row?.replace(/\x1B\[[0-9;]*m/g, "")).toContain("OFF");
    expect(row?.replace(/\x1B\[[0-9;]*m/g, "")).not.toContain("✓");
  });

  it("renders disabled convention policies as OFF while leaving siblings enabled", async () => {
    seed({
      [SHORT_NAME]: `${policySource("enabled-rule")}\n${policySource("disabled-rule")}`,
    });
    writeFileSync(
      join(tmp, ".failproofai", "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        disabledCustomPolicies: [`convention:project:${SHORT_NAME}:disabled-rule`],
      }),
      "utf8",
    );

    await listHooks(tmp);

    const row = lines.find((line) => line.includes(SHORT_NAME));
    const plain = row?.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("MIXED");
    expect(plain).toContain("enabled-rule");
    expect(plain).toContain("disabled-rule (OFF)");
  });
});
