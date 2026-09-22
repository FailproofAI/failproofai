// @vitest-environment node
/**
 * `failproofai audit` and the six hard-floor builtins.
 *
 * The audit replays EVERY builtin, enabled or not, so adding the floor changes
 * what an audit reports and scores for every user — the six are
 * `defaultEnabled: false` and Jev can be off, and they still show up. That is
 * the audit's design (it shows what could be caught, and the projected score
 * credits enabling them), and it applies to the floor like every other opt-in
 * builtin. What it must not do is charge one event twice: `git commit
 * --no-verify` is already the `git-commit-no-verify` detector's hit, so the
 * block-no-verify deny on that same event is dropped. These tests pin both.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit";
import {
  DETECTOR_COVERED_POLICIES,
  resetReplay,
  withoutDetectorDuplicates,
  type ReplayHit,
} from "../../src/audit/replay";
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

const hit = (policyName: string): ReplayHit => ({ policyName, decision: "deny", reason: "x", eventType: "PreToolUse" });

describe("withoutDetectorDuplicates", () => {
  it("drops block-no-verify on an event the git-commit-no-verify detector counted", () => {
    const hits = [hit("failproofai/block-no-verify"), hit("failproofai/block-chmod-777")];
    expect(withoutDetectorDuplicates(hits, new Set(["git-commit-no-verify"])).map((h) => h.policyName))
      .toEqual(["failproofai/block-chmod-777"]);
  });

  it("keeps it when the detector did not fire (git push --no-verify, HUSKY=0 …)", () => {
    const hits = [hit("failproofai/block-no-verify")];
    expect(withoutDetectorDuplicates(hits, new Set())).toEqual(hits);
    expect(withoutDetectorDuplicates(hits, new Set(["reread-after-edit"]))).toEqual(hits);
  });

  it("reads the flat policy name too", () => {
    expect(withoutDetectorDuplicates([hit("block-no-verify")], new Set(["git-commit-no-verify"]))).toEqual([]);
  });

  it("covers only block-no-verify", () => {
    expect([...DETECTOR_COVERED_POLICIES]).toEqual([["failproofai/block-no-verify", "git-commit-no-verify"]]);
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
      ...Array(5).fill("git commit --no-verify -m wip"),
      "git push --no-verify origin feature",
      "chmod 777 deploy.sh",
      "pkill -f node",
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

  it("counts each --no-verify commit once, under the detector", () => {
    expect(row("git-commit-no-verify")?.hits).toBe(5);
    // Only the push: the five commits are the detector's.
    expect(row("block-no-verify")?.hits).toBe(1);
    expect(row("block-no-verify")?.severity).toBe("deny");
  });

  it("reports the other floor hits as opt-in builtins", () => {
    expect(row("block-chmod-777")).toMatchObject({ hits: 1, severity: "deny", source: "builtin" });
    expect(row("block-mass-kill")).toMatchObject({ hits: 1, severity: "deny", source: "builtin" });
    expect(row("block-disk-destruction")).toBeUndefined();
  });

  it("pins the score, and shows the double count would have cost more", () => {
    const score = deriveScore(result);
    expect(score).toBe(SCORE);
    const doubled: AuditResult = {
      ...result,
      results: result.results.map((r) => (r.name.endsWith("/block-no-verify") ? { ...r, hits: r.hits + 5 } : r)),
    };
    expect(deriveScore(doubled)).toBeLessThan(score);
  });
});

/** The audit score of the fixture above. Moves only when scoring or a builtin's verdict on it does. */
const SCORE = 44;
