// @vitest-environment node
/**
 * Five events where failproofai emitted a deny the CLI does not read.
 *
 * Each was a silent non-enforcement: the policy ran, the evaluator produced a
 * verdict, the activity store recorded `decision: "deny"` and telemetry counted
 * one — and the CLI submitted the prompt or ran the command anyway, because the
 * shape we sent matched nothing it parses. The CLI could block on every one of
 * these; the gap was ours, not the vendor's.
 *
 * Shapes verified against the shipped vendor builds (see
 * src/hooks/enforcement-capability.ts for byte offsets) and, for Pi, against
 * the installed package's own .d.ts.
 */
import { describe, it, expect } from "vitest";
import { evaluatePolicies } from "@/src/hooks/policy-evaluator";
import { registerPolicy, clearPolicies } from "@/src/hooks/policy-registry";
import { deny } from "@/src/hooks/policy-helpers";
import type { SessionMetadata, IntegrationType } from "@/src/hooks/types";

function session(cli: IntegrationType): SessionMetadata {
  return { sessionId: "t", transcriptPath: "/dev/null", cwd: "/tmp", cli };
}

async function denyOn(cli: IntegrationType, eventType: string, payload = {}) {
  clearPolicies();
  registerPolicy("test/blocker", "blocks", async () => deny("nope"), {}, 0);
  const result = await evaluatePolicies(
    eventType as Parameters<typeof evaluatePolicies>[0],
    payload,
    session(cli),
  );
  return { result, stdout: result.stdout ? JSON.parse(result.stdout) : null };
}

describe("deny shapes the CLI actually reads", () => {
  it("copilot UserPromptSubmit uses {decision:'block'} at exit 0, not exit 2", async () => {
    // Copilot logs exit 2 as `Hook command exited with code 2 (warning)` for
    // EVERY event — it is never a deny channel there.
    const { result, stdout } = await denyOn("copilot", "UserPromptSubmit", { prompt: "hi" });
    expect(result.exitCode).toBe(0);
    expect(stdout.decision).toBe("block");
    expect(typeof stdout.reason).toBe("string");
    expect(stdout.reason.length).toBeGreaterThan(0);
  });

  it("copilot PermissionRequest uses a FLAT {behavior,message}", async () => {
    // The Codex-shaped nested hookSpecificOutput.decision normalizes to `{}` on
    // copilot, so the permission prompt proceeded as if no policy existed.
    const { result, stdout } = await denyOn("copilot", "PermissionRequest", { tool_name: "Bash" });
    expect(result.exitCode).toBe(0);
    expect(stdout.behavior).toBe("deny");
    expect(typeof stdout.message).toBe("string");
    expect(stdout.hookSpecificOutput).toBeUndefined();
  });

  it("cursor UserPromptSubmit uses {continue:false}, not {permission:'deny'}", async () => {
    // beforeSubmitPrompt's only block key is `continue === false`; an object
    // with unknown keys validates and is dropped.
    const { result, stdout } = await denyOn("cursor", "UserPromptSubmit", { prompt: "hi" });
    expect(result.exitCode).toBe(0);
    expect(stdout.continue).toBe(false);
    expect(typeof stdout.user_message).toBe("string");
    expect(stdout.permission).toBeUndefined();
  });

  it("cursor tool events still use the flat permission shape", async () => {
    // Regression guard: the UserPromptSubmit branch must not swallow the tool
    // path, which genuinely does read `permission`.
    const { stdout } = await denyOn("cursor", "PreToolUse", { tool_name: "Bash" });
    expect(stdout.permission).toBe("deny");
    expect(stdout.continue).toBeUndefined();
  });

  it("copilot Stop keeps its force-retry shape", async () => {
    const { stdout } = await denyOn("copilot", "Stop");
    expect(stdout.decision).toBe("block");
    expect(stdout.reason).toContain("MANDATORY ACTION REQUIRED");
  });

  // `pre_verify` is Hermes's turn-end gate — the event CLAUDE.md claimed did not
  // exist, which made the 5 require-*-before-stop builtins dead there. Upstream
  // reads {decision:"block"} as "block the stop", i.e. keep going, and injects
  // `reason` as a synthetic user message. So the reason must be the instruction
  // we want the model to act on, not a refusal notice.
  it("hermes Stop (pre_verify) carries the MANDATORY-ACTION instruction", async () => {
    const { result, stdout } = await denyOn("hermes", "Stop");
    expect(result.exitCode).toBe(0);
    expect(stdout.decision).toBe("block");
    expect(stdout.reason).toContain("MANDATORY ACTION REQUIRED");
    // Upstream requires a non-empty message or the continue is downgraded.
    expect(stdout.reason.trim().length).toBeGreaterThan(0);
  });

  it("hermes non-Stop events keep the plain blocked message", async () => {
    const { stdout } = await denyOn("hermes", "PreToolUse", { tool_name: "Bash" });
    expect(stdout.decision).toBe("block");
    expect(stdout.reason).not.toContain("MANDATORY ACTION REQUIRED");
  });
});
