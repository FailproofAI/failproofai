// @vitest-environment node
//
// `failproofai policies` (listHooks) hardcoded ANSI escapes in
// src/hooks/manager.ts, so it printed color even when NO_COLOR=1 / --no-color
// was set under a TTY — every other surface routes through tui.ts's
// `colorsEnabled` predicate, and manager.ts was the holdout (issue #688).
//
// These assert the gate both ways: colored when a TTY has color on, and zero
// ESC bytes the moment NO_COLOR is set — with stdout.isTTY forced true so the
// off-TTY short-circuit is not what is being measured.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listHooks } from "@/src/hooks/manager";

const ESC = "\x1B[";

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

describe("listHooks — NO_COLOR / --no-color gating", () => {
  let tmp: string;
  let emptyHome: string;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fp-nocolor-"));
    emptyHome = mkdtempSync(join(tmpdir(), "fp-nocolor-home-"));
    vi.stubEnv("HOME", emptyHome);
    vi.stubEnv("USERPROFILE", emptyHome);
    // Seed a convention policy so a colored "✓ ON" status row is produced.
    const dir = join(tmp, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "team-policies.mjs"), policySource("team-rule"), "utf8");

    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    // The escapes short-circuit off a TTY; force one so we measure the
    // NO_COLOR gate, not the isTTY gate.
    origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("emits ANSI escapes on a color TTY", async () => {
    // Register NO_COLOR with vi.stubEnv (empty = unset) so afterEach's
    // vi.unstubAllEnvs() restores the worker's original value instead of
    // leaving it deleted for later tests.
    vi.stubEnv("NO_COLOR", "");
    await listHooks(tmp);
    const out = lines.join("\n");
    // The convention-policy section renders a colored status for the seeded
    // team-policies.mjs (a green "✓ ON" when its `import "failproofai"` resolves,
    // or a red "✗ failed to load" when the bare specifier can't resolve in this
    // env). Either way manager.ts wraps that span in an ANSI escape — assert on
    // the row so the test measures manager.ts's own gated output, not incidental
    // color from elsewhere.
    expect(out).toContain("team-policies.mjs");
    expect(out).toMatch(/\x1B\[3[0-9]m/); // a foreground-color span from the status row
  });

  it("emits zero ESC bytes when NO_COLOR is set", async () => {
    vi.stubEnv("NO_COLOR", "1");
    await listHooks(tmp);
    const out = lines.join("\n");
    expect(out).not.toContain(ESC);
    // The same rows still render as plain text — the header and the convention
    // section's status/filename — proving only the color wrapping was dropped.
    expect(out).toContain("Failproof AI");
    expect(out).toContain("team-policies.mjs");
  });
});
