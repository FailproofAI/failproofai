// @vitest-environment node
/**
 * The fail-closed path, against the real evaluation engine.
 *
 * `forceDecision` is what `bin/failproofai.mjs` reaches for when a
 * daemon-configured machine cannot reach its daemon. It is the single most
 * consequential branch in the product — it denies EVERYTHING, on every CLI —
 * and it had no test at all: `grep -rn forceDecision __tests__/` returned
 * nothing, and the only coverage was a pair of shell scripts that hardcode an
 * absolute developer path, are outside the vitest glob, and run in no workflow.
 *
 * Deliberately unmocked apart from telemetry. What matters here is the exact
 * bytes an agent receives, and a mocked `policy-evaluator` would assert the
 * shape of a stub instead of the shape of a deny.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

import { evaluateHookEvent } from "../../src/hooks/handler";

const FORCED = {
  decision: "deny" as const,
  reason: "failproofaid could not be reached.",
};

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fpai-fail-closed-"));
  mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function stdin(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: "s1", cwd: projectDir, ...extra });
}

/** Claude's PreToolUse deny is JSON on stdout at exit 0, not a nonzero exit. */
function permissionDecisionOf(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
}

describe("hooks/handler forceDecision (fail-closed)", () => {
  it("denies a tool call and gives the operator the reason verbatim", async () => {
    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
    expect(`${result.stdout}${result.stderr}`).toContain("failproofaid could not be reached");
  });

  it("denies a command no policy would ever object to", async () => {
    // The point of fail-closed: the verdict does not depend on the command.
    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Read",
      tool_input: { file_path: join(projectDir, "README.md") },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
  });

  // The synthetic policy registers with `match: {}` (handler.ts), which matches
  // EVERY event — including the one that carries what the user typed. So a
  // machine whose daemon is down cannot merely not run tools; it cannot hold a
  // conversation. That is the difference between "enforcement is degraded" and
  // "the product is bricked", and it is the reason a repair route exists at all
  // (see `probeDaemonEndToEnd` and `healDaemonFlag`). Pinned as the current,
  // deliberate behaviour so that changing it is a decision rather than an
  // accident.
  it("also denies UserPromptSubmit — the user cannot even talk to their agent", async () => {
    const result = await evaluateHookEvent("UserPromptSubmit", "claude", stdin({ prompt: "hello" }), {
      forceDecision: FORCED,
    });

    expect(`${result.stdout}${result.stderr}`).toContain("failproofaid could not be reached");
    expect(result.exitCode !== 0 || permissionDecisionOf(result.stdout) === "deny").toBe(true);
  });

  it("loads no project policy config — an unreachable daemon ran none of it", async () => {
    // A custom policy file that would throw if it were ever imported. The
    // fail-closed branch must not touch the project's configuration at all:
    // the daemon it could not reach never evaluated any of it either, so
    // loading it here would report a decision no daemon made.
    const policyPath = join(projectDir, "exploding-policies.mjs");
    writeFileSync(policyPath, `throw new Error("must never be imported on the fail-closed path");\n`);
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], customPoliciesPaths: [policyPath] }),
    );

    const result = await evaluateHookEvent("PreToolUse", "claude", stdin({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }), { forceDecision: FORCED });

    expect(permissionDecisionOf(result.stdout)).toBe("deny");
    expect(`${result.stdout}${result.stderr}`).not.toContain("must never be imported");
  });
});
