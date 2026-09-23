// @vitest-environment node
/**
 * The four hard-floor builtins through the PACK lane.
 *
 * builtin-pack-conformance.test.ts compares every builtin's verdict between the
 * pack and the compiled build, but none of its corpus commands makes a floor
 * policy deny — so a bundling fault that turned a floor policy into
 * allow-everything in the pack would pass it. This runs a denying command, a
 * fail-closed command and a near miss for each one through both lanes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";
import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import type { PolicyContext, PolicyResult } from "@/src/hooks/policy-types";

const REPO = resolve(__dirname, "../..");

const CASES: Record<string, { deny: string; allow: string }> = {
  "block-disk-destruction": { deny: "sudo dd if=/dev/zero of=/dev/sda bs=1M", allow: "dd if=/dev/zero of=disk.img" },
  "block-gh-destructive": { deny: "gh api -iX DELETE repos/o/r/releases/1", allow: "gh release view v1" },
  "block-indirect-exec": { deny: "R=/bin/rm; $R -rf /tmp/x", allow: "$PYTHON -m pytest" },
  "block-chmod-777": { deny: "chmod -R 1777 /srv/app", allow: "chmod 755 run.sh" },
};

/** Seven nested `bash -c`: every floor policy denies what it cannot read to the end. */
function tooDeep(): string {
  let s = "echo hi";
  for (let i = 0; i < 7; i++) s = `bash -c '${s.replace(/'/g, `'\\''`)}'`;
  return s;
}

let packDir: string;
let scratchCwd: string;
let packHooks: { name: string; fn: (ctx: PolicyContext) => Promise<PolicyResult> | PolicyResult }[];

beforeAll(async () => {
  packDir = mkdtempSync(join(tmpdir(), "fpai-floor-pack-"));
  scratchCwd = mkdtempSync(join(tmpdir(), "fpai-floor-pack-cwd-"));
  execFileSync("bun", ["scripts/build-policy-pack.mjs", "--out", packDir], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  clearCustomHooks();
  // No convention discovery: this repo's own .failproofai/policies must not load.
  const result = await loadAllCustomHooks([join(packDir, "failproofai-pack.mjs")], {
    sessionCwd: scratchCwd,
    customPoliciesEnabled: false,
  });
  packHooks = result.hooks as never;
}, 120_000);

afterAll(() => {
  clearCustomHooks();
  rmSync(packDir, { recursive: true, force: true });
  rmSync(scratchCwd, { recursive: true, force: true });
});

const ctxFor = (command: string): PolicyContext =>
  ({ eventType: "PreToolUse", toolName: "Bash", toolInput: { command }, payload: { tool_name: "Bash", tool_input: { command } },
     params: {}, session: { cwd: scratchCwd } } as unknown as PolicyContext);

describe("floor policies through the pack lane", () => {
  it.each(Object.keys(CASES))("%s denies, fails closed and allows exactly as compiled", async (name) => {
    const packed = packHooks.find((h) => h.name === name || h.name.endsWith(`/${name}`));
    expect(packed).toBeDefined();
    const compiled = BUILTIN_POLICIES.find((p) => p.name === name)!;
    for (const [command, want] of [[CASES[name].deny, "deny"], [tooDeep(), "deny"], [CASES[name].allow, "allow"]] as const) {
      const viaPack = await packed!.fn(ctxFor(command));
      const viaBuild = await compiled.fn(ctxFor(command));
      expect(viaPack.decision).toBe(want);
      expect(viaPack).toEqual(viaBuild);
    }
  });
});
