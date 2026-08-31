// @vitest-environment node
/**
 * A transcript that GREW must produce the same audit as one scanned whole.
 *
 * The cache used to be all-or-nothing per file: validity was an exact
 * `(mtime, size)` match, so a 15 MB session gaining one line was re-parsed and
 * re-replayed from byte zero. The files that gain lines are the long-lived
 * ones, which are also the largest, so an audit cost what was still being
 * written to rather than what had been written since.
 *
 * Resuming introduces two failure modes that a "does it still work" test would
 * not see, because both produce a plausible number:
 *
 *   • re-scanning bytes already accounted for → every hit counted twice
 *   • starting after the boundary → the events straddling it lost for good
 *
 * So the assertion is EQUIVALENCE, against the same transcript scanned in one
 * go, rather than any hand-written expectation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit";
import { resetReplay } from "../../src/audit/replay";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/tmp/myproj";

let root: string;
let home: string;
let transcript: string;

/** Tool-use lines in the shape the Claude adapter parses. */
function lines(from: number, specs: Array<[string, Record<string, unknown>]>): string {
  return specs
    .map(([name, input], i) =>
      JSON.stringify({
        type: "assistant",
        uuid: `uuid-${from + i}`,
        parentUuid: from + i === 0 ? null : `uuid-${from + i - 1}`,
        sessionId: SESSION,
        cwd: CWD,
        timestamp: new Date(2026, 4, 21, from + i).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: `tu-${from + i}`, name, input }],
        },
      }),
    )
    .join("\n") + "\n";
}

const FIRST: Array<[string, Record<string, unknown>]> = [
  ["Bash", { command: "env" }],
  ["Bash", { command: `cd ${CWD} && pnpm test` }],
];
const SECOND: Array<[string, Record<string, unknown>]> = [
  ["Bash", { command: "sudo rm -rf /" }],
  ["Edit", { file_path: `${CWD}/foo.ts`, old_string: "a", new_string: "b" }],
  ["Read", { file_path: `${CWD}/foo.ts` }],
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-incr-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const projects = join(root, "projects");
  const projectDir = join(projects, "-tmp-myproj");
  mkdirSync(projectDir, { recursive: true });
  transcript = join(projectDir, `${SESSION}.jsonl`);
  process.env.CLAUDE_PROJECTS_PATH = projects;
  process.env.FAILPROOFAI_HOME = home;
  resetReplay();
});

afterEach(() => {
  delete process.env.CLAUDE_PROJECTS_PATH;
  delete process.env.FAILPROOFAI_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** Only the parts an audit is actually claiming: what was found, how often. */
function shape(r: Awaited<ReturnType<typeof runAudit>>) {
  return {
    eventsScanned: r.eventsScanned,
    hits: Object.fromEntries(
      r.results.map((x) => [x.name, x.hits]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  };
}

describe("a transcript that grew between audits", () => {
  it("gives the same answer as scanning the whole thing at once", async () => {
    // Whole file, one pass, no cache to resume from.
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    const whole = shape(await runAudit({ clis: ["claude"], noCache: true }));

    // Now the same content, arriving in two parts, with a cached audit between.
    rmSync(join(home, "audit"), { recursive: true, force: true });
    writeFileSync(transcript, lines(0, FIRST));
    await runAudit({ clis: ["claude"] });          // populates the cache
    appendFileSync(transcript, lines(FIRST.length, SECOND));
    const resumed = shape(await runAudit({ clis: ["claude"] }));

    expect(resumed).toEqual(whole);
  });

  it("does not re-count what it already scanned", async () => {
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    const first = shape(await runAudit({ clis: ["claude"] }));
    // Nothing appended: a second audit must be a plain cache hit and must not
    // add a single event to the totals.
    const second = shape(await runAudit({ clis: ["claude"] }));
    expect(second).toEqual(first);
  });

  it("carries stateful detectors across the boundary", async () => {
    // reread-after-edit pairs an Edit with a later Read of the same path, and
    // its countdown spans tool calls. Split exactly between the two halves of
    // that pair: starting the detector empty on resume loses the pairing, and
    // the hit silently disappears.
    writeFileSync(transcript, lines(0, [["Edit", { file_path: `${CWD}/foo.ts`, old_string: "a", new_string: "b" }]]));
    await runAudit({ clis: ["claude"] });
    appendFileSync(transcript, lines(1, [["Read", { file_path: `${CWD}/foo.ts` }]]));
    const resumed = await runAudit({ clis: ["claude"] });

    const names = resumed.results.filter((r) => r.hits > 0).map((r) => r.name);
    expect(names).toContain("reread-after-edit");
  });

  it("re-scans from scratch when the file was rewritten rather than appended", async () => {
    // A compaction replaces content instead of adding to it. The recorded
    // offset then points into different bytes, and resuming there would report
    // an audit of a file that no longer exists.
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    await runAudit({ clis: ["claude"] });

    const replacement = lines(0, [["Bash", { command: "sudo rm -rf /" }]]);
    // Longer than the original, so "it grew" is true and only the anchor check
    // can catch it.
    writeFileSync(transcript, replacement + lines(1, [["Bash", { command: "env" }]]) + "\n".repeat(5000));
    const after = shape(await runAudit({ clis: ["claude"] }));

    const expected = shape(await runAudit({ clis: ["claude"], noCache: true }));
    expect(after).toEqual(expected);
  });

  it("does not lose an event written as a partial line", async () => {
    // Transcripts are appended to WHILE the audit reads them, so the tail is
    // routinely half a line. It must not be parsed, and the resume point must
    // sit before it — recording the file size instead would step over that
    // event permanently.
    writeFileSync(transcript, lines(0, FIRST));
    const partial = lines(FIRST.length, SECOND);
    const cut = Math.floor(partial.length / 2);
    appendFileSync(transcript, partial.slice(0, cut));   // ends mid-line
    await runAudit({ clis: ["claude"] });
    appendFileSync(transcript, partial.slice(cut));      // completes it
    const resumed = shape(await runAudit({ clis: ["claude"] }));

    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    const whole = shape(await runAudit({ clis: ["claude"], noCache: true }));
    expect(resumed).toEqual(whole);
  });

  it("does not drop the last line when the file has no trailing newline", async () => {
    // Everything up to the last newline is unambiguously complete; what
    // follows is either a line still being written or the final line of a
    // finished transcript. Treating the second as the first silently loses the
    // last event of every completed session — which is what a full scan is,
    // since it now reads through the same boundary-aware path.
    const body = lines(0, [...FIRST, ...SECOND]);
    writeFileSync(transcript, body.replace(/\n$/, "")); // no trailing newline
    const withoutNewline = shape(await runAudit({ clis: ["claude"], noCache: true }));

    writeFileSync(transcript, body);
    const withNewline = shape(await runAudit({ clis: ["claude"], noCache: true }));

    expect(withoutNewline).toEqual(withNewline);
  });

  it("records a resume point, so the next run has one to use", async () => {
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    await runAudit({ clis: ["claude"] });
    const dir = join(home, "audit", "cache");
    const files = require("node:fs").readdirSync(dir) as string[];
    const entry = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
    expect(entry.bytesScanned).toBeGreaterThan(0);
    expect(typeof entry.anchorHash).toBe("string");
  });
});
