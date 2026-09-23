// @vitest-environment node
/**
 * The floor's fail-closed fixes, end to end through the real evaluatePolicies,
 * with ONE floor policy enabled — the way the reviewers reproduced them. Each
 * floor policy is opt-in on its own, so none may rely on another being enabled
 * to deny what it could not read.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// A policy that throws makes the evaluator report it with the instance id;
// keep that off the real machine should a regression ever get there.
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: () => "test-instance" }));

import { evaluatePolicies } from "../../src/hooks/policy-evaluator";
import { registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { clearPolicies } from "../../src/hooks/policy-registry";
import type { SessionMetadata } from "../../src/hooks/types";

const session: SessionMetadata = { sessionId: "t", transcriptPath: "/dev/null", cwd: "/home/u/proj", cli: "claude" };

async function verdict(enabled: string, command: string) {
  clearPolicies();
  registerBuiltinPolicies([enabled]);
  const r = await evaluatePolicies("PreToolUse", { tool_name: "Bash", tool_input: { command } }, session);
  return r.decision;
}

function nestBashC(levels: number, inner: string): string {
  let s = inner;
  for (let i = 0; i < levels; i++) s = `bash -c '${s.replace(/'/g, `'\\''`)}'`;
  return s;
}

describe("floor policies through evaluatePolicies, each enabled alone", () => {
  beforeEach(() => clearPolicies());

  it.each([
    ["block-disk-destruction", "constructor -x; dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "diskutil; dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", nestBashC(7, "dd if=/dev/zero of=/dev/sda")],
    ["block-disk-destruction", "dd if=/dev/zero of=../../../../dev/sda"],
    ["block-disk-destruction", "pkexec dd if=/dev/zero of=/dev/sda"],
    ["block-mass-kill", "constructor -x; killall node"],
    ["block-mass-kill", nestBashC(7, "echo hi")],
    ["block-no-verify", "constructor -x; git commit --no-verify"],
    // ROUND 7: the VALUE of a `core.hooksPath` a commit brings with it is no
    // longer read — an empty hooks directory skips every hook exactly as
    // `/dev/null` does. Pinned as an allow before.
    ["block-no-verify", "git -c core.hooksPath=.husky commit -m x"],
    ["block-chmod-777", "constructor -x; chmod 777 /etc/passwd"],
    ["block-chmod-777", "chmod 1777 secrets.txt"],
    ["block-gh-destructive", "constructor -x; gh release delete v1"],
    ["block-gh-destructive", "gh api -iX DELETE repos/o/r/releases/1"],
    ["block-indirect-exec", 'A=rm; B=$A; A=$B; cd "$A" 2>/dev/null; $B important.txt'],
  ])("%s denies %s", async (name, command) => {
    expect(await verdict(name, command)).toBe("deny");
  });

  it.each([
    ["block-disk-destruction", "diskutil list"],
    ["block-disk-destruction", "dd if=/dev/zero of=../disk.img"],
    ["block-chmod-777", "mkdir -m 1777 /tmp/shared"],
    // A PERSISTENT write is not a commit: this is how hook managers install.
    ["block-no-verify", "git config core.hooksPath .husky"],
  ])("%s allows %s", async (name, command) => {
    expect(await verdict(name, command)).toBe("allow");
  });
});
