// @vitest-environment node
/**
 * An agent `failproofai config` does not trace still has its calls evaluated.
 *
 * Hooks for an unticked agent can be there on purpose: committed to a
 * repository's project scope, or read by VS Code's agent mode from a file
 * another integration wrote. The decision of record is that such an event is
 * evaluated exactly as usual and only noted, once per session. Allowing it for
 * being untraced would turn a guard somebody installed into a hole.
 *
 * untraced-note.test.ts checks the note on its own, and every other handler
 * test runs with no saved selection, where every agent is traced. This is the
 * one place a selection and a real evaluation meet, through the real engine
 * and the real block-sudo builtin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/hooks/hook-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hook-logger")>();
  return { ...actual, hookLogInfo: vi.fn() };
});

import { evaluateHookEvent } from "../../src/hooks/handler";
import { hookLogInfo } from "../../src/hooks/hook-logger";
import { updateConfig } from "../../src/hooks/fp-config";
import { untracedNotePath } from "../../src/hooks/untraced-note";

const ENV = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "CLAUDE_PROJECT_DIR"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
let root: string;
let project: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fpai-untraced-eval-"));
  const home = join(root, "home");
  project = join(home, "project");
  mkdirSync(join(home, ".failproofai"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "packs"), { recursive: true });
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = join(root, "packs");
  delete process.env.CLAUDE_PROJECT_DIR;
  writeFileSync(
    join(home, ".failproofai", "policies-config.json"),
    JSON.stringify({ enabledPolicies: ["block-sudo"] }),
  );
  vi.mocked(hookLogInfo).mockClear();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const sudo = (sessionId: string) =>
  JSON.stringify({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "sudo rm -rf /var/lib/thing" },
  });

/** Claude's PreToolUse deny is JSON on stdout at exit 0. */
const permissionDecision = (stdout: string): string | undefined => {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
};

const untracedNotes = () => vi.mocked(hookLogInfo).mock.calls.filter(([m]) => String(m).includes("not one of the agents"));

describe("an untraced agent's hook event", () => {
  it("is still denied by a builtin, and noted once per session", async () => {
    // Claude is not in the selection: only Codex is traced.
    updateConfig({ agents: { selected: ["codex"], seen: ["codex", "claude"] } });

    const first = await evaluateHookEvent("PreToolUse", "claude", sudo("s-untraced"));
    expect(permissionDecision(first.stdout), first.stdout).toBe("deny");
    expect(first.evaluation?.decision).toBe("deny");
    expect(first.evaluation?.policyName).toContain("block-sudo");
    expect(untracedNotes()).toHaveLength(1);
    expect(JSON.parse(readFileSync(untracedNotePath(), "utf8"))).toEqual(["claude:s-untraced"]);

    // The same session again: denied again, and not noted a second time.
    const second = await evaluateHookEvent("PreToolUse", "claude", sudo("s-untraced"));
    expect(permissionDecision(second.stdout), second.stdout).toBe("deny");
    expect(untracedNotes()).toHaveLength(1);
    expect(JSON.parse(readFileSync(untracedNotePath(), "utf8"))).toEqual(["claude:s-untraced"]);
  });

  it("gets the same verdict as a traced one", async () => {
    // The control: without it, a deny above could come from something other
    // than block-sudo evaluating normally.
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });

    const traced = await evaluateHookEvent("PreToolUse", "claude", sudo("s-traced"));
    expect(permissionDecision(traced.stdout), traced.stdout).toBe("deny");
    expect(traced.evaluation?.policyName).toContain("block-sudo");
    expect(untracedNotes()).toHaveLength(0);
    expect(existsSync(untracedNotePath())).toBe(false);
  });
});
