// @vitest-environment node
/**
 * `failproofai audit` and the four hard-floor builtins.
 *
 * The audit replays EVERY builtin, enabled or not, so adding the floor changes
 * what an audit reports and scores for every user — the four are
 * `defaultEnabled: false` and Jev can be off, and they still show up. That is
 * the audit's design (it shows what could be caught, and the projected score
 * credits enabling them), and it applies to the floor like every other opt-in
 * builtin. These tests pin that, and pin the floor's absence from the persona
 * signal map.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit";
import { resetReplay } from "../../src/audit/replay";
import { SIGNAL_MAP } from "../../src/audit/features";
import { deriveScore } from "../../src/audit/scoring";
import type { AuditResult } from "../../src/audit/types";

function transcript(cwd: string, sessionId: string, commands: string[]): string {
  const lines: object[] = [];
  let prevUuid: string | null = null;
  for (const command of commands) {
    const uuid = `uuid-${lines.length}`;
    lines.push({
      type: "assistant",
      uuid,
      parentUuid: prevUuid,
      sessionId,
      cwd,
      timestamp: new Date(2026, 8, 1, 0, lines.length).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: `tu-${lines.length}`, name: "Bash", input: { command } }],
      },
    });
    prevUuid = uuid;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

describe("the floor stays out of the persona signal map", () => {
  // features.ts documents the omission in a comment; this is what enforces it.
  // Mapping any of the four moves the lift baselines, so a calibration that
  // wants them has to revisit those too.
  it.each([
    "block-disk-destruction", "block-gh-destructive", "block-indirect-exec", "block-chmod-777",
  ])("%s carries no archetype signal", (name) => {
    expect(SIGNAL_MAP[name]).toBeUndefined();
  });
});

describe("runAudit() over a transcript with floor-policy commands", () => {
  let tmpRoot: string;
  let origEnv: string | undefined;
  let result: AuditResult;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "failproofai-audit-floor-"));
    origEnv = process.env.CLAUDE_PROJECTS_PATH;
    process.env.CLAUDE_PROJECTS_PATH = join(tmpRoot, "projects");
    // A real directory that is not a git repository, so the branch-reading
    // builtins (block-work-on-main) have nothing to find.
    const cwd = join(tmpRoot, "work");
    mkdirSync(cwd, { recursive: true });
    const projectDir = join(tmpRoot, "projects", "-tmp-floor");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "22222222-3333-4444-5555-666666666666";
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcript(cwd, sessionId, [
      "chmod 777 deploy.sh",
      "wipefs -a /dev/sdb",
      // Not `gh release delete`: that one is the pre-existing block-gh-pipeline's
      // hit, since the floor is appended AFTER every existing policy and the
      // replay attributes an event to the first policy that denies it.
      "gh api -iX DELETE repos/o/r/releases/1",
      "R=/bin/rm; $R -rf /tmp/x",
      ...Array(20).fill("ls"),
    ]));
    resetReplay();
    result = await runAudit({ clis: ["claude"], noCache: true, noReport: true });
  }, 60_000);

  afterAll(() => {
    if (origEnv) process.env.CLAUDE_PROJECTS_PATH = origEnv;
    else delete process.env.CLAUDE_PROJECTS_PATH;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const row = (suffix: string) => result.results.find((r) => r.name === suffix || r.name.endsWith(`/${suffix}`));

  it("reports every floor hit as an opt-in builtin", () => {
    for (const name of ["block-chmod-777", "block-disk-destruction", "block-gh-destructive", "block-indirect-exec"]) {
      expect(row(name)).toMatchObject({ hits: 1, severity: "deny", source: "builtin" });
    }
  });

  it("pins the score of the fixture", () => {
    expect(deriveScore(result)).toBe(SCORE);
  });
});

/** The audit score of the fixture above. Moves only when scoring or a builtin's verdict on it does. */
const SCORE = 60;
