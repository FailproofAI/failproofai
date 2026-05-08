/**
 * Runs the failproofai binary as a subprocess for E2E hook tests.
 *
 * Invokes bin/failproofai.mjs --hook <event> via bun, exactly as Claude Code does —
 * no Node.js bridge, no mocks.
 *
 * Run `bun build src/index.ts --outdir dist --target node --format cjs` once before
 * running these tests (required for custom hook files that import from 'failproofai').
 */
import { expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function getBinaryPath(): string {
  return resolve(REPO_ROOT, "bin/failproofai.mjs");
}

function getDistPath(): string {
  return resolve(REPO_ROOT, "dist");
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout JSON, or null if stdout is empty / not valid JSON. */
  parsed: Record<string, unknown> | null;
}

/**
 * Invoke `failproofai --hook <event>` with the given payload on stdin.
 *
 * @param event  - Hook event type, e.g. "PreToolUse"
 * @param payload - JSON payload written to stdin
 * @param opts.homeDir - Override HOME so ~/.failproofai doesn't leak into tests
 */
export function runHook(
  event: string,
  payload: Record<string, unknown>,
  opts?: { homeDir?: string; cli?: "claude" | "codex" | "copilot" | "cursor" | "opencode" | "pi" | "gemini" },
): HookRunResult {
  const binaryPath = getBinaryPath();

  if (!existsSync(binaryPath)) {
    throw new Error(`E2E binary not found: ${binaryPath}`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAILPROOFAI_TELEMETRY_DISABLED: "1",
    FAILPROOFAI_DIST_PATH: getDistPath(),
    ...(opts?.homeDir ? { HOME: opts.homeDir } : {}),
  };

  const args = [binaryPath, "--hook", event];
  if (opts?.cli) args.push("--cli", opts.cli);
  const result = spawnSync("bun", args, {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
    timeout: 15_000,
  });

  const exitCode = result.status ?? 1;
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  let parsed: Record<string, unknown> | null = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // stdout is not JSON — leave parsed as null
    }
  }

  return { exitCode, stdout, stderr, parsed };
}

// ── Assertion helpers ──────────────────────────────────────────────────────

export function assertAllow(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
}

export function assertPreToolUseDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  expect(output?.permissionDecision).toBe("deny");
}

/** Codex PermissionRequest deny: hookSpecificOutput.decision.behavior === "deny". */
export function assertPermissionRequestDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  const decision = output?.decision as Record<string, unknown> | undefined;
  expect(decision?.behavior).toBe("deny");
}

export function assertPostToolUseDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  expect(output?.additionalContext).toMatch(/Blocked/i);
}

export function assertInstruct(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  expect(output?.additionalContext).toMatch(/^Instruction from failproofai:/);
}

export function assertStopInstruct(result: HookRunResult): void {
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBeTruthy();
}

// ── Cursor-shaped assertions ───────────────────────────────────────────────
// Cursor uses a flat `{permission, user_message, agent_message}` JSON shape
// (no `hookSpecificOutput` wrapper) — see https://cursor.com/docs/hooks.

export function assertCursorDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.permission).toBe("deny");
  expect(result.parsed?.user_message).toMatch(/Blocked/i);
  expect(result.parsed?.agent_message).toMatch(/Blocked/i);
}

export function assertCursorInstruct(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.permission).toBe("allow");
  expect(result.parsed?.additional_context).toMatch(/^Instruction from failproofai:/);
}

export function assertCursorStopInstruct(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.followup_message).toMatch(/^Instruction from failproofai:/);
}

export function assertCursorStopBlock(result: HookRunResult): void {
  // Cursor's stop / subagentStop hooks honor `{followup_message}` on stdout
  // (exit 0) — auto-submitted as next user message, capped at loop_limit
  // (default 5). The flat `{permission: "deny"}` shape is ignored on Stop.
  // Mirrors assertCopilotStopBlock and assertGeminiStopBlock.
  // Ref: https://cursor.com/docs/hooks
  expect(result.exitCode).toBe(0);
  expect(typeof result.parsed?.followup_message).toBe("string");
  expect(result.parsed?.followup_message).toMatch(/MANDATORY ACTION REQUIRED/);
}

/**
 * Pi emits a flat `{permission, reason}` JSON shape — the pi-extension shim
 * parses this and translates `permission === "deny"` into a `{block, reason}`
 * return from its `pi.on("tool_call", ...)` handler.
 */
export function assertPiDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.permission).toBe("deny");
  expect(typeof result.parsed?.reason).toBe("string");
  expect(result.parsed?.reason).toMatch(/Blocked/i);
  // Pi uses the flat shape — no Claude-style hookSpecificOutput wrapper.
  expect(result.parsed?.hookSpecificOutput).toBeUndefined();
}

export function assertPiInstruct(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.permission).toBe("allow");
  expect(result.parsed?.reason).toMatch(/^Instruction from failproofai:/);
}

export function assertPiAllow(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  // Allow can be either an empty stdout or a flat `{permission: "allow"}`
  // (when there are info-only allow entries). The shim treats both as no-block.
  if (result.parsed) {
    expect(result.parsed.permission).not.toBe("deny");
  }
}

// ── Gemini-shaped assertions ───────────────────────────────────────────────
// Gemini uses a flat `{decision: "deny", reason}` JSON shape per its "Golden
// Rule" exit-0 contract. Stop policies emit `{decision: "block", reason}` to
// trigger AfterAgent's force-retry. Context injection uses Claude's
// `{hookSpecificOutput: {hookEventName, additionalContext}}` shape but with
// the hookEventName carrying the raw Gemini event name (BeforeTool/AfterTool/
// BeforeAgent/SessionStart). Ref: https://geminicli.com/docs/hooks/

export function assertGeminiDeny(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.decision).toBe("deny");
  expect(typeof result.parsed?.reason).toBe("string");
  expect(result.parsed?.reason).toMatch(/Blocked/i);
  // Gemini uses the flat shape — no Claude-style hookSpecificOutput wrapper.
  expect(result.parsed?.hookSpecificOutput).toBeUndefined();
}

export function assertGeminiStopBlock(result: HookRunResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.decision).toBe("block");
  expect(typeof result.parsed?.reason).toBe("string");
  expect(result.parsed?.reason).toMatch(/MANDATORY ACTION REQUIRED/);
}

export function assertCopilotStopBlock(result: HookRunResult): void {
  // Copilot's `agentStop` honors `{decision: "block", reason}` JSON on stdout
  // (exit 0) — the reason becomes the next-turn prompt and the agent retries.
  // Exit-2 is logged as `[WARNING] Hook warning: ...` but does NOT trigger
  // retry (verified empirically against Copilot CLI 1.0.41 events.jsonl).
  expect(result.exitCode).toBe(0);
  expect(result.parsed?.decision).toBe("block");
  expect(typeof result.parsed?.reason).toBe("string");
  expect(result.parsed?.reason).toMatch(/MANDATORY ACTION REQUIRED/);
}

export function assertGeminiInstruct(result: HookRunResult, hookEventName: string): void {
  expect(result.exitCode).toBe(0);
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  expect(output?.hookEventName).toBe(hookEventName);
  expect(output?.additionalContext).toMatch(/^Instruction from failproofai:/);
}
