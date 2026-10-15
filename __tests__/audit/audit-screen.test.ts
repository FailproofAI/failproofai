// @vitest-environment node
/**
 * `failproofai audit`'s screen: the design's progress screen with a bar per
 * agent (decision D16), finished in place, then the hand-off to the dashboard.
 *
 * Two halves. The builder is pure, so its lines are pinned exactly at fixed
 * widths, plain and coloured, mid-scan and finished, with the version injected
 * so the release bot's bump cannot turn this red. Then the wiring through
 * `runAuditCli`, with `runAudit` stood in for: piped and NO_COLOR output is the
 * finished screen printed once with no escapes, and a terminal gets live frames
 * that are each ONE write — the old spinner wrote its cursor-up and its lines
 * as separate chunks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AuditCount, AuditProgress, AuditResult, RunAuditOptions } from "../../src/audit/types";

const h = vi.hoisted(() => ({
  trackHookEvent: vi.fn(async () => {}),
  runAudit: vi.fn(),
  writeDashboardCache: vi.fn(() => true),
  openWhenReady: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: h.trackHookEvent }));
vi.mock("../../src/audit/index", () => ({ runAudit: h.runAudit }));
vi.mock("../../src/audit/dashboard-cache", () => ({ writeDashboardCache: h.writeDashboardCache }));
vi.mock("../../src/audit/open-browser", () => ({ openWhenReady: h.openWhenReady }));
vi.mock("../../scripts/launch", () => ({ launch: h.launch }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: () => "test-instance" }));

import { buildAuditScreen, runAuditCli, runPostSetupAudit, type AuditScreenState } from "../../src/audit/cli";

const strip = (s: string): string => s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
const PINK_24 = "38;2;228;88;125";
const MINT_24 = "38;2;102;209;181";
const INK3_24 = "38;2;118;127;139";
const TRACK_24 = "38;2;62;67;76";

function setEnv(env: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const restore = setEnv(env);
  try {
    return fn();
  } finally {
    restore();
  }
}

/** The same, held until an async run settles — the CLI reads the environment after its first await too. */
async function withEnvAsync<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const restore = setEnv(env);
  try {
    return await fn();
  } finally {
    restore();
  }
}
const TRUECOLOR = { COLORTERM: "truecolor", TERM: "xterm-256color", NO_COLOR: undefined };

function count(over: Partial<AuditCount>): AuditCount {
  return {
    name: "x",
    source: "builtin",
    category: "Risky",
    severity: "deny",
    hits: 1,
    projects: 1,
    examples: [],
    displayTitle: "x",
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...over,
  };
}

/** The design's sample, mid-scan. */
const MID: AuditScreenState = {
  agents: [
    { cli: "claude", total: 1284, done: 1284 },
    { cli: "codex", total: 412, done: 301 },
    { cli: "opencode", total: 96, done: 12 },
  ],
  policies: 34,
  hits: {
    "failproofai/block-env-files": 4,
    "failproofai/block-sudo": 2,
    "failproofai/sanitize-api-keys": 1,
    "failproofai/warn-all-files-staged": 18,
    "failproofai/warn-git-amend": 5,
    "failproofai/protect-env-vars": 40,
    "reread-after-edit": 9,
    "redundant-cd-cwd": 3,
  },
};

const RESULT: AuditResult = {
  version: 2,
  scannedAt: "2026-10-11T00:00:00.000Z",
  scope: { cli: ["claude", "codex", "opencode"], projects: "all", since: null },
  transcripts: { scanned: 1792, skipped: 0, errors: 0, durationMs: 0 },
  results: Object.entries(MID.hits).map(([name, hits]) =>
    count({
      name,
      hits,
      source: name.includes("/") ? "builtin" : "audit-detector",
      enabledInConfig: name === "failproofai/block-sudo" || name === "failproofai/block-env-files",
    }),
  ),
  totals: { hits: 82, projectsWithHits: 3 },
  projectsScanned: Array.from({ length: 41 }, (_, i) => `/p${i}`),
  eventsScanned: 18240,
  enabledBuiltinNames: [],
};

const BAR30 = "━".repeat(30);

describe("the audit screen, built", () => {
  it("names the phase it has no bars for while transcripts are listed", () => {
    expect(buildAuditScreen({ agents: null, policies: 0, hits: {} }, { version: "1.0.11", cols: 80, fit: true })).toEqual([
      "failproof ai  v1.0.11  ·  Audit",
      "",
      // The dashboard's first stage, in its words — `AUDIT_STAGES[0]`.
      "SCANNING HISTORY  discovering transcripts",
      "",
      "ctrl+c stop",
    ]);
  });

  it("draws the design's progress screen mid-scan, at 104 columns", () => {
    expect(buildAuditScreen(MID, { version: "1.0.11", cols: 104, fit: true })).toEqual([
      "failproof ai  v1.0.11  ·  Audit",
      "",
      "SCANNING HISTORY  3 agents, 34 policies",
      `  claude    ${BAR30}  ✓ 1,284 sessions`,
      // Colour off, the empty part of a bar is blank: one unbroken run of ━
      // would show no progress at all.
      `  codex     ${"━".repeat(22)}${" ".repeat(8)}  301 of 412 sessions`,
      `  opencode  ${"━".repeat(4)}${" ".repeat(26)}  12 of 96 sessions`,
      "",
      "FOUND SO FAR",
      "  would block  46: protect-env-vars 40, block-env-files 4, block-sudo 2",
      "  would warn   24: warn-all-files-staged 18, warn-git-amend 5, sanitize-api-keys 1",
      "  audit only   12: reread-after-edit 9, redundant-cd-cwd 3",
      "",
      "ctrl+c stop",
    ]);
  });

  it("fits the found rows to 80 columns by dropping whole names, never cutting one", () => {
    const lines = buildAuditScreen(MID, { version: "1.0.11", cols: 60, fit: true });
    const block = lines.find((l) => l.startsWith("  would block"))!;
    expect(block).toBe("  would block  46: protect-env-vars 40, block-env-files 4, …");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // The bar gave up width before the counts did.
    expect(lines.find((l) => l.startsWith("  codex"))).toMatch(/301 of 412 sessions$/);
  });

  it("always shows the first name, however narrow", () => {
    const lines = buildAuditScreen(MID, { version: "1.0.11", cols: 20, fit: true });
    expect(lines.find((l) => l.startsWith("  would block"))).toBe("  would block  46: protect-env-vars 40, …");
  });

  it("cuts nothing when fitting is off — piped output is never cut", () => {
    const lines = buildAuditScreen(MID, { version: "1.0.11", cols: 60 });
    expect(lines.find((l) => l.startsWith("  would block"))).toBe(
      "  would block  46: protect-env-vars 40, block-env-files 4, block-sudo 2",
    );
  });

  it("files each finding by what the policy would do, not by the score's heuristic", () => {
    const lines = buildAuditScreen(
      {
        agents: [{ cli: "claude", total: 1, done: 1 }],
        policies: 34,
        hits: {
          // protect-* and prefer-* deny, though the score files them as warn.
          "failproofai/protect-env-vars": 1,
          "failproofai/prefer-package-manager": 1,
          // warn-* instructs; sanitize-* acts after the call ran, so it cannot block.
          "failproofai/warn-git-amend": 1,
          "failproofai/sanitize-jwt": 1,
          // An audit-only detector has no runtime policy at all.
          "sleep-polling-loop": 1,
        },
      },
      { version: "1.0.11", cols: 104 },
    );
    expect(lines).toContain("  would block  2: prefer-package-manager 1, protect-env-vars 1");
    expect(lines).toContain("  would warn   2: sanitize-jwt 1, warn-git-amend 1");
    expect(lines).toContain("  audit only   1: sleep-polling-loop 1");
  });

  it("shows zero rows rather than hiding them, so the block does not jump", () => {
    const lines = buildAuditScreen(
      { agents: [{ cli: "claude", total: 3, done: 0 }], policies: 34, hits: {} },
      { version: "1.0.11", cols: 80, fit: true },
    );
    expect(lines).toContain("  would block  0");
    expect(lines).toContain("  would warn   0");
    expect(lines).toContain("  audit only   0");
    expect(lines).toContain(`  claude    ${" ".repeat(30)}  0 of 3 sessions`);
  });

  it("finishes in place: every bar done, the headings past tense, the summary where the keys were", () => {
    expect(buildAuditScreen(MID, { version: "1.0.11", cols: 104, fit: true, result: RESULT })).toEqual([
      "failproof ai  v1.0.11  ·  Audit",
      "",
      "SCANNED HISTORY  3 agents, 34 policies",
      `  claude    ${BAR30}  ✓ 1,284 sessions`,
      `  codex     ${BAR30}  ✓ 412 sessions`,
      `  opencode  ${BAR30}  ✓ 96 sessions`,
      "",
      "FOUND",
      "  would block  46: protect-env-vars 40, block-env-files 4, block-sudo 2",
      "  would warn   24: warn-all-files-staged 18, warn-git-amend 5, sanitize-api-keys 1",
      "  audit only   12: reread-after-edit 9, redundant-cd-cwd 3",
      "",
      "✓ Scanned 18,240 tool calls across 1,792 sessions in 41 projects.",
      "  6 patterns are slipping through, and 2 are already covered by your policies.",
    ]);
  });

  it("takes the finished counts from the result, which is what the dashboard shows", () => {
    const lines = buildAuditScreen(
      { agents: [{ cli: "claude", total: 1, done: 1 }], policies: 34, hits: { "failproofai/block-sudo": 99 } },
      { version: "1.0.11", cols: 80, result: { ...RESULT, results: [count({ name: "failproofai/block-sudo", hits: 2 })] } },
    );
    expect(lines).toContain("  would block  2: block-sudo 2");
  });

  it("finishes a scan with no sessions on the summary alone, with no empty blocks", () => {
    const empty: AuditResult = {
      ...RESULT,
      results: [],
      totals: { hits: 0, projectsWithHits: 0 },
      transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 },
      projectsScanned: [],
      eventsScanned: 0,
    };
    const expected = ["failproof ai  v1.0.11  ·  Audit", "", "✓ Scanned 0 tool calls across 0 sessions."];
    // Every agent listed, none with anything to scan…
    expect(buildAuditScreen({ agents: [], policies: 34, hits: {} }, { version: "1.0.11", cols: 80, result: empty })).toEqual(
      expected,
    );
    // …or a scan that finished without ever saying what it found.
    expect(buildAuditScreen({ agents: null, policies: 0, hits: {} }, { version: "1.0.11", cols: 80, result: empty })).toEqual(
      expected,
    );
  });

  it("drops the key hint when the scan stopped, because nothing is running", () => {
    const lines = buildAuditScreen(MID, { version: "1.0.11", cols: 80, stopped: true });
    expect(lines).not.toContain("ctrl+c stop");
    expect(lines).toContain("SCANNING HISTORY  3 agents, 34 policies");
  });

  it("paints by role in colour, and says the same thing", () => {
    const plain = buildAuditScreen(MID, { version: "1.0.11", cols: 104, fit: true });
    const painted = withEnv(TRUECOLOR, () => buildAuditScreen(MID, { version: "1.0.11", cols: 104, fit: true, color: true }));
    // In colour the empty part of a bar is the track, drawn rather than blank.
    expect(painted.map(strip)).toEqual(plain.map((l) => l.replace(/━ +(?= {2}\d)/, (run) => "━".repeat(run.length))));
    const codex = painted.find((l) => strip(l).startsWith("  codex"))!;
    expect(codex).toContain(`\x1B[${PINK_24}m${"━".repeat(22)}\x1B[0m`);
    expect(codex).toContain(`\x1B[${TRACK_24}m${"━".repeat(8)}\x1B[0m`);
    expect(painted.find((l) => strip(l).startsWith("  claude"))).toContain(`\x1B[${MINT_24}m✓\x1B[0m`);
    expect(painted).toContain(`\x1B[${INK3_24}mctrl+c stop\x1B[0m`);
    expect(painted).toContain(`\x1B[1mSCANNING HISTORY\x1B[0m  \x1B[${INK3_24}m3 agents, 34 policies\x1B[0m`);
  });

  it("emits no escape at all with colour off", () => {
    const all = [
      ...buildAuditScreen(MID, { version: "1.0.11", cols: 80, fit: true }),
      ...buildAuditScreen(MID, { version: "1.0.11", cols: 80, result: RESULT }),
    ].join("\n");
    expect(all).not.toContain("\x1B");
  });

  it("uses only the design's glyphs", () => {
    const all = buildAuditScreen(MID, { version: "1.0.11", cols: 104, result: RESULT }).join("");
    expect(all).not.toMatch(/[✦🛡!│◆◇└⠋⠙⠹]/u);
  });
});

// ── through runAuditCli ──────────────────────────────────────────────────────

const DISCOVERED: AuditProgress = {
  kind: "discovered",
  agents: [
    { cli: "claude", transcripts: 2 },
    { cli: "codex", transcripts: 1 },
    { cli: "goose", transcripts: 0 },
  ],
  policies: 34,
};
const REPORTS: AuditProgress[] = [
  { kind: "transcript", cli: "claude", hitsByName: { "failproofai/block-sudo": 2 } },
  { kind: "transcript", cli: "claude", hitsByName: { "failproofai/warn-git-amend": 1, "reread-after-edit": 3 } },
  { kind: "transcript", cli: "codex", hitsByName: { "failproofai/protect-env-vars": 5, "failproofai/sanitize-api-keys": 1 } },
];
const SCANNED: AuditResult = {
  ...RESULT,
  scope: { cli: ["claude", "codex", "goose"], projects: "all", since: null },
  transcripts: { scanned: 3, skipped: 0, errors: 0, durationMs: 0 },
  results: [
    count({ name: "failproofai/protect-env-vars", hits: 5 }),
    count({ name: "reread-after-edit", hits: 3, source: "audit-detector" }),
    count({ name: "failproofai/block-sudo", hits: 2, enabledInConfig: true }),
    count({ name: "failproofai/warn-git-amend", hits: 1 }),
    count({ name: "failproofai/sanitize-api-keys", hits: 1 }),
  ],
  totals: { hits: 12, projectsWithHits: 2 },
  projectsScanned: ["/a", "/b"],
  eventsScanned: 40,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in scan that reports like the real one, pausing between reports so a terminal gets frames mid-scan. */
function scanReporting(pause = 0) {
  return async (opts: RunAuditOptions): Promise<AuditResult> => {
    if (pause) await sleep(5);
    opts.onProgress?.(DISCOVERED);
    for (const report of REPORTS) {
      if (pause) await sleep(pause);
      opts.onProgress?.(report);
    }
    if (pause) await sleep(pause);
    return SCANNED;
  };
}

let written: string[];
let home: string;
let prevHome: string | undefined;
let prevTTY: boolean | undefined;
let prevColumns: number | undefined;
const stdout = process.stdout as unknown as { isTTY?: boolean; columns?: number };

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-audit-screen-"));
  process.env.FAILPROOFAI_HOME = home;
  prevTTY = stdout.isTTY;
  prevColumns = stdout.columns;
  vi.clearAllMocks();
  h.writeDashboardCache.mockReturnValue(true);
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevTTY === undefined) delete stdout.isTTY;
  else stdout.isTTY = prevTTY;
  if (prevColumns === undefined) delete stdout.columns;
  else stdout.columns = prevColumns;
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const output = () => written.join("");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("failproofai audit, piped", () => {
  it("prints the finished screen once, with no escapes and no progress frames", async () => {
    delete stdout.isTTY;
    h.runAudit.mockImplementation(scanReporting());
    await withEnvAsync({ ...TRUECOLOR, FORCE_COLOR: undefined }, () => runAuditCli([]));

    const text = output();
    expect(text).not.toContain("\x1B");
    expect(occurrences(text, "SCANNED HISTORY")).toBe(1);
    expect(text).not.toContain("SCANNING HISTORY");
    expect(text).not.toContain("ctrl+c stop\n");
    // An agent with nothing to scan has no bar.
    expect(text).not.toContain("goose");
    expect(text).toContain(`  claude    ${BAR30}  ✓ 2 sessions`);
    expect(text).toContain(`  codex     ${BAR30}  ✓ 1 session`);
    expect(text).toContain("  would block  7: protect-env-vars 5, block-sudo 2");
    expect(text).toContain("  would warn   2: sanitize-api-keys 1, warn-git-amend 1");
    expect(text).toContain("  audit only   3: reread-after-edit 3");
    expect(text).toContain("✓ Scanned 40 tool calls across 3 sessions in 2 projects.");
    expect(text).toContain("  4 patterns are slipping through, and 1 is already covered by your policies.");
  });

  it("hands off to the dashboard with one result line and the key hint, and no logomark", async () => {
    delete stdout.isTTY;
    h.runAudit.mockImplementation(scanReporting());
    await runAuditCli([]);

    const text = output();
    expect(text).toContain("✓ The audit is ready:  http://localhost:8020/audit\n\nctrl+c stop the dashboard\n");
    expect(text).not.toMatch(/[▀▄█]/u);
    expect(text).not.toContain("starting the dashboard");
    expect(h.openWhenReady).toHaveBeenCalledWith(8020, "/audit");
    expect(h.launch).toHaveBeenCalledWith("start", { screen: false });
  });

  it("does not colour a pipe for FORCE_COLOR, the same as every other screen", async () => {
    delete stdout.isTTY;
    h.runAudit.mockImplementation(scanReporting());
    await withEnvAsync({ ...TRUECOLOR, FORCE_COLOR: "1" }, () => runAuditCli([]));
    expect(output()).not.toContain("\x1B");
  });

  it("says what changes an empty history instead of opening the dashboard", async () => {
    delete stdout.isTTY;
    h.runAudit.mockResolvedValue({
      ...SCANNED,
      results: [],
      totals: { hits: 0, projectsWithHits: 0 },
      transcripts: { scanned: 0, skipped: 0, errors: 0, durationMs: 0 },
      projectsScanned: [],
      eventsScanned: 0,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);

    await expect(runAuditCli([])).rejects.toThrow("__EXIT_0__");
    expect(output()).toContain("✓ Scanned 0 tool calls across 0 sessions.\n\nRun it again after using your agent:  failproofai audit\n");
    expect(output()).not.toContain("discovering transcripts");
    // The audit reads each agent's own history, hooks or not — so the old
    // pointer at `policies --install` sent people to the wrong fix.
    expect(output()).not.toContain("policies --install");
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("names a cache it could not save, above the hand-off", async () => {
    delete stdout.isTTY;
    h.runAudit.mockImplementation(scanReporting());
    h.writeDashboardCache.mockReturnValue(false);
    await runAuditCli([]);
    expect(output()).toContain(
      "▲ Could not save the audit, so the dashboard may show nothing.\n✓ The audit is ready:  http://localhost:8020/audit",
    );
  });
});

describe("failproofai audit, on a terminal", () => {
  it("under NO_COLOR prints the finished screen once, with no escapes and no frames", async () => {
    stdout.isTTY = true;
    stdout.columns = 100;
    h.runAudit.mockImplementation(scanReporting(20));
    await withEnvAsync({ ...TRUECOLOR, NO_COLOR: "1" }, () => runAuditCli([]));

    const text = output();
    expect(text).not.toContain("\x1B");
    expect(occurrences(text, "SCANNED HISTORY")).toBe(1);
    expect(text).not.toContain("SCANNING HISTORY");
  });

  it("draws live frames, each ONE atomic write, and gives the cursor back", async () => {
    stdout.isTTY = true;
    stdout.columns = 100;
    // Pauses longer than the 100 ms tempo, so frames land mid-scan.
    h.runAudit.mockImplementation(scanReporting(130));
    await withEnvAsync(TRUECOLOR, () => runAuditCli([]));

    const frames = written.filter((w) => w.includes("\x1B[?2026h"));
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      // Opened and closed in the same write: the terminal holds the frame.
      expect(frame.startsWith("\x1B[?2026h")).toBe(true);
      expect(frame.endsWith("\x1B[?2026l")).toBe(true);
    }
    // A cursor-up-and-clear never arrives on its own — that lone write is the
    // blank flash the atomic repaint exists to prevent.
    expect(written.filter((w) => /\x1B\[\d+A\x1B\[J/.test(w) && !w.includes("Audit"))).toEqual([]);

    // Hidden with the first frame, shown again with the last.
    expect(frames[0]).toContain("\x1B[?25l");
    expect(strip(frames[0])).toContain("SCANNING HISTORY  discovering transcripts");
    const last = frames[frames.length - 1];
    expect(last).toContain("\x1B[?25h");
    expect(strip(last)).toContain("SCANNED HISTORY  2 agents, 34 policies");
    expect(strip(last)).toContain("✓ Scanned 40 tool calls across 3 sessions in 2 projects.");
    // It replaced the live frame rather than printing under it.
    expect(last).toMatch(/\x1B\[\d+A\x1B\[J/);

    // Somewhere in between, a real mid-scan frame with a bar part-way.
    const mid = frames.slice(1, -1).map(strip);
    expect(mid.some((f) => f.includes("1 of 2 sessions") || f.includes("0 of 2 sessions"))).toBe(true);
    expect(mid.some((f) => f.includes("FOUND SO FAR"))).toBe(true);

    // And the hand-off follows the finished frame, outside it.
    expect(strip(output())).toContain("✓ The audit is ready:  http://localhost:8020/audit");
  });

  it("holds frames to the 100 ms tempo when reports arrive faster", async () => {
    stdout.isTTY = true;
    stdout.columns = 100;
    // Every report arrives at once: one frame before the scan, and the finished
    // frame after it, with nothing drawn for the reports in between.
    h.runAudit.mockImplementation(scanReporting(0));
    await withEnvAsync(TRUECOLOR, () => runAuditCli([]));
    expect(written.filter((w) => w.includes("\x1B[?2026h"))).toHaveLength(2);
  });

  it("leaves the screen as far as it got, without the key hint, when the scan fails", async () => {
    stdout.isTTY = true;
    stdout.columns = 100;
    h.runAudit.mockImplementation(async (opts: RunAuditOptions) => {
      opts.onProgress?.(DISCOVERED);
      throw new TypeError("disk exploded");
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);

    await expect(withEnvAsync(TRUECOLOR, () => runAuditCli([]))).rejects.toThrow("__EXIT_1__");
    const frames = written.filter((w) => w.includes("\x1B[?2026h"));
    const last = frames[frames.length - 1];
    expect(last).toContain("\x1B[?25h");
    expect(strip(last)).toContain("SCANNING HISTORY  2 agents, 34 policies");
    expect(strip(last)).not.toContain("ctrl+c stop");
  });
});

describe("the onboarding audit", () => {
  afterEach(() => {
    delete process.env.FAILPROOFAI_NO_AUTO_AUDIT;
  });

  it("draws the same screen, then says nothing is enforced on a machine with no packs", async () => {
    delete stdout.isTTY;
    h.runAudit.mockImplementation(scanReporting());
    await runPostSetupAudit();

    const text = output();
    expect(text).not.toContain("\x1B");
    expect(text).not.toContain("now running");
    expect(occurrences(text, "SCANNED HISTORY")).toBe(1);
    expect(text).toContain("▲ None of this is enforced yet.  ·  failproofai policies add FailproofAI/policies");
  });

  it("names the fix when its scan fails, and does not throw", async () => {
    delete stdout.isTTY;
    h.runAudit.mockRejectedValue(new TypeError("disk exploded"));
    await expect(runPostSetupAudit()).resolves.toBeUndefined();
    expect(output()).toContain("✕ The audit could not finish.  ·  failproofai audit");
  });
});
