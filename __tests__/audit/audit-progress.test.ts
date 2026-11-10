// @vitest-environment node
/**
 * `runAudit`'s progress callback, on real transcripts from two agents.
 *
 * The callback feeds `failproofai audit`'s per-agent bars (decision D16), so
 * what is pinned here is what those bars are drawn from: one `discovered` with
 * every agent's total before any transcript reports, then exactly one report per
 * transcript, by agent, whose hits add up to the result. And the two promises
 * that let it be optional: the audit is the same with or without a listener,
 * and a listener that throws changes nothing.
 *
 * Every path the scan reads is a fixture under a temp dir — Claude through
 * CLAUDE_PROJECTS_PATH, Factory through FACTORY_HOME, the cache through
 * FAILPROOFAI_HOME — and the audit is restricted to those agents, so nothing
 * here reads the real home.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit";
import { resetReplay } from "../../src/audit/replay";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import type { AuditProgress, AuditResult } from "../../src/audit/types";
import type { IntegrationType } from "../../src/hooks/types";

const CLIS: IntegrationType[] = ["claude", "factory"];

function claudeTranscript(cwd: string, sessionId: string, commands: Array<[string, Record<string, unknown>]>): string {
  return commands
    .map(([name, input], i) =>
      JSON.stringify({
        type: "assistant",
        uuid: `${sessionId}-${i}`,
        parentUuid: i === 0 ? null : `${sessionId}-${i - 1}`,
        sessionId,
        cwd,
        timestamp: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: `tu-${sessionId}-${i}`, name, input }] },
      }),
    )
    .join("\n");
}

function factoryTranscript(cwd: string, sessionId: string, command: string): string {
  return [
    { type: "session_start", id: sessionId, cwd },
    {
      type: "message",
      timestamp: "2026-10-01T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Execute", input: { command } }] },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

let root: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-audit-progress-"));
  for (const key of ["CLAUDE_PROJECTS_PATH", "FACTORY_HOME", "FAILPROOFAI_HOME"]) saved[key] = process.env[key];
  process.env.CLAUDE_PROJECTS_PATH = join(root, "claude-projects");
  process.env.FACTORY_HOME = join(root, "factory");
  process.env.FAILPROOFAI_HOME = join(root, "fp");

  const claudeProject = join(root, "claude-projects", "-tmp-alpha");
  mkdirSync(claudeProject, { recursive: true });
  writeFileSync(
    join(claudeProject, "11111111-2222-4333-8444-555555555551.jsonl"),
    claudeTranscript("/tmp/alpha", "11111111-2222-4333-8444-555555555551", [
      ["Bash", { command: "sudo ls -la /root" }],
      ["Bash", { command: "env" }],
    ]),
  );
  writeFileSync(
    join(claudeProject, "11111111-2222-4333-8444-555555555552.jsonl"),
    claudeTranscript("/tmp/alpha", "11111111-2222-4333-8444-555555555552", [
      ["Bash", { command: "cd /tmp/alpha && pnpm test" }],
      ["Edit", { file_path: "/tmp/alpha/foo.ts", old_string: "a", new_string: "b" }],
      ["Read", { file_path: "/tmp/alpha/foo.ts" }],
    ]),
  );

  const factoryProject = join(root, "factory", "sessions", "-tmp-beta");
  mkdirSync(factoryProject, { recursive: true });
  writeFileSync(
    join(factoryProject, "22222222-3333-4444-8555-666666666661.jsonl"),
    factoryTranscript("/tmp/beta", "22222222-3333-4444-8555-666666666661", "sudo whoami"),
  );
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetReplay();
});

const transcriptsOf = (events: AuditProgress[]) =>
  events.filter((e): e is Extract<AuditProgress, { kind: "transcript" }> => e.kind === "transcript");

/** Hits summed across every transcript report, by name. */
function summed(events: AuditProgress[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of transcriptsOf(events)) {
    for (const [name, n] of Object.entries(e.hitsByName)) out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

const hitsOf = (result: AuditResult) => Object.fromEntries(result.results.map((r) => [r.name, r.hits]));

/** The parts of a result that do not depend on the clock. */
const comparable = (result: AuditResult) => ({
  ...result,
  scannedAt: "",
  transcripts: { ...result.transcripts, durationMs: 0 },
});

describe("runAudit progress", () => {
  it("reports every agent's total once, before any transcript", async () => {
    const events: AuditProgress[] = [];
    await runAudit({ clis: CLIS, noCache: true, onProgress: (p) => events.push(p) });

    expect(events[0]?.kind).toBe("discovered");
    expect(events.filter((e) => e.kind === "discovered")).toHaveLength(1);
    const discovered = events[0] as Extract<AuditProgress, { kind: "discovered" }>;
    // In scan order, as the bars draw them.
    expect(discovered.agents).toEqual([
      { cli: "claude", transcripts: 2 },
      { cli: "factory", transcripts: 1 },
    ]);
  });

  it("counts the policies a replay can actually fire, not every builtin", async () => {
    const events: AuditProgress[] = [];
    await runAudit({ clis: CLIS, noCache: true, onProgress: (p) => events.push(p) });
    const discovered = events[0] as Extract<AuditProgress, { kind: "discovered" }>;

    // Every builtin the replay registers (all but warn-repeated-tool-calls),
    // minus the Stop-only require-*-before-stop gates a replay never asks.
    const expected = BUILTIN_POLICIES.filter(
      (p) =>
        p.name !== "warn-repeated-tool-calls" &&
        (!p.match.events?.length || p.match.events.some((e) => e === "PreToolUse" || e === "PostToolUse")),
    ).length;
    expect(discovered.policies).toBe(expected);
    expect(discovered.policies).toBeLessThan(BUILTIN_POLICIES.length - 1);
  });

  it("reports each transcript once, by agent, and the hits add up to the result", async () => {
    const events: AuditProgress[] = [];
    const result = await runAudit({ clis: CLIS, noCache: true, onProgress: (p) => events.push(p) });

    const reports = transcriptsOf(events);
    expect(reports).toHaveLength(3);
    expect(reports.filter((r) => r.cli === "claude")).toHaveLength(2);
    expect(reports.filter((r) => r.cli === "factory")).toHaveLength(1);
    expect(summed(events)).toEqual(hitsOf(result));

    // Both agents found something, so both halves of the plumbing are live.
    // Builtins arrive under their qualified names, detectors under their own.
    expect(reports.find((r) => r.cli === "factory")?.hitsByName).toEqual({ "failproofai/block-sudo": 1 });
    expect(summed(events)).toHaveProperty("redundant-cd-cwd");
  });

  it("is the same audit with or without a listener", async () => {
    const without = await runAudit({ clis: CLIS, noCache: true });
    resetReplay();
    const withListener = await runAudit({ clis: CLIS, noCache: true, onProgress: () => {} });
    expect(comparable(withListener)).toEqual(comparable(without));
  });

  it("ignores a listener that throws, rather than counting it as a scan error", async () => {
    const baseline = await runAudit({ clis: CLIS, noCache: true });
    resetReplay();
    const result = await runAudit({
      clis: CLIS,
      noCache: true,
      onProgress: () => {
        throw new Error("a broken progress display");
      },
    });
    expect(result.transcripts.errors).toBe(0);
    expect(result.transcripts.skipped).toBe(0);
    expect(comparable(result)).toEqual(comparable(baseline));
  });

  it("still reports a transcript the cache answers", async () => {
    // The first run fills the per-transcript cache under FAILPROOFAI_HOME; the
    // second is answered from it without a scan, and must still move the bars.
    await runAudit({ clis: CLIS });
    resetReplay();
    const events: AuditProgress[] = [];
    const result = await runAudit({ clis: CLIS, onProgress: (p) => events.push(p) });

    expect(transcriptsOf(events)).toHaveLength(3);
    expect(summed(events)).toEqual(hitsOf(result));
  });

  it("lists an agent with nothing to scan as zero", async () => {
    const empty = mkdtempSync(join(tmpdir(), "fpai-audit-progress-goose-"));
    const prev = process.env.GOOSE_HOME;
    process.env.GOOSE_HOME = empty;
    try {
      const events: AuditProgress[] = [];
      await runAudit({ clis: [...CLIS, "goose"], noCache: true, onProgress: (p) => events.push(p) });
      const discovered = events[0] as Extract<AuditProgress, { kind: "discovered" }>;
      expect(discovered.agents).toContainEqual({ cli: "goose", transcripts: 0 });
      expect(transcriptsOf(events).filter((r) => r.cli === "goose")).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.GOOSE_HOME;
      else process.env.GOOSE_HOME = prev;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
