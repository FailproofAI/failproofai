// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit";
import { resetReplay } from "../../src/audit/replay";

/**
 * Builds a minimal Claude JSONL transcript with three tool-use events:
 *   1. Bash(env)        — should trigger protect-env-vars (builtin)
 *   2. Bash(cd <cwd> && pnpm test) — should trigger redundant-cd-cwd (detector)
 *   3. Edit(file_path) then Read(file_path) — should trigger reread-after-edit
 */
function buildFixtureTranscript(cwd: string, sessionId: string): string {
  const lines: object[] = [];
  let prevUuid: string | null = null;
  function pushAssistantToolUse(name: string, input: Record<string, unknown>) {
    const uuid = `uuid-${lines.length}`;
    lines.push({
      type: "assistant",
      uuid,
      parentUuid: prevUuid,
      sessionId,
      cwd,
      timestamp: new Date(2026, 4, 21, lines.length).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: `tu-${lines.length}`, name, input }],
      },
    });
    prevUuid = uuid;
  }
  pushAssistantToolUse("Bash", { command: "env" });
  pushAssistantToolUse("Bash", { command: `cd ${cwd} && pnpm test` });
  pushAssistantToolUse("Edit", { file_path: `${cwd}/foo.ts`, old_string: "a", new_string: "b" });
  pushAssistantToolUse("Read", { file_path: `${cwd}/foo.ts` });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

describe("runAudit() end-to-end on a fixture transcript", () => {
  let tmpRoot: string;
  let origEnv: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "failproofai-audit-fixture-"));
    origEnv = process.env.CLAUDE_PROJECTS_PATH;
    process.env.CLAUDE_PROJECTS_PATH = tmpRoot;

    // Create one project with one transcript.
    const projectDir = join(tmpRoot, "-tmp-myproj");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    const transcriptCwd = "/tmp/myproj";
    writeFileSync(transcriptPath, buildFixtureTranscript(transcriptCwd, sessionId));
    resetReplay();
  });

  afterAll(() => {
    if (origEnv) process.env.CLAUDE_PROJECTS_PATH = origEnv;
    else delete process.env.CLAUDE_PROJECTS_PATH;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("counts builtin + detector hits across the fixture transcript", async () => {
    const result = await runAudit({ clis: ["claude"], noCache: true, noReport: true });
    expect(result.transcripts.scanned).toBeGreaterThanOrEqual(1);

    const names = result.results.map((r) => r.name);
    // Builtin policy hit.
    expect(names.some((n) => n.includes("protect-env-vars"))).toBe(true);
    // Audit-only detector hits.
    expect(names).toContain("redundant-cd-cwd");
    expect(names).toContain("reread-after-edit");
  });

  it("filters by --policy", async () => {
    const result = await runAudit({
      clis: ["claude"],
      noCache: true,
      noReport: true,
      policies: ["redundant-cd-cwd"],
    });
    expect(result.results.map((r) => r.name)).toEqual(["redundant-cd-cwd"]);
  });
});
