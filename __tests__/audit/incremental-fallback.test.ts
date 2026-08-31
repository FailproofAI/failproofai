// @vitest-environment node
/**
 * What happens when a resume is GRANTED and then cannot be honoured.
 *
 * The cache decides a transcript grew and hands back a prefix result plus a
 * byte offset. The reader is the one that finds out whether that offset is
 * still good — a transcript truncated or rewritten under it returns null — and
 * it answers by reading the WHOLE file instead. Merging the cached prefix onto
 * a whole-file result counts everything before the offset twice, and the two
 * halves of that decision sit in different functions, which is why it was
 * possible to write.
 *
 * The null paths are a concurrent truncation and an I/O error, neither of which
 * a black-box audit can trigger on purpose, so the reader is forced here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Flipped on for the run that must fall back. */
let refuseResume = false;

vi.mock("../../src/audit/cli-adapters/claude", async () => {
  const real = await vi.importActual<typeof import("../../src/audit/cli-adapters/claude")>(
    "../../src/audit/cli-adapters/claude",
  );
  return {
    ...real,
    streamClaudeEventsFrom: (...args: Parameters<typeof real.streamClaudeEventsFrom>) =>
      refuseResume ? Promise.resolve(null) : real.streamClaudeEventsFrom(...args),
  };
});

const { runAudit } = await import("../../src/audit");
const { resetReplay } = await import("../../src/audit/replay");

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/tmp/myproj";
let root: string;
let home: string;
let transcript: string;

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
        message: { role: "assistant", content: [{ type: "tool_use", id: `tu-${from + i}`, name, input }] },
      }),
    )
    .join("\n") + "\n";
}

const FIRST: Array<[string, Record<string, unknown>]> = [
  ["Bash", { command: "sudo rm -rf /tmp/a" }],
  ["Bash", { command: "sudo systemctl restart nginx" }],
];
const SECOND: Array<[string, Record<string, unknown>]> = [
  ["Bash", { command: "sudo apt-get install curl" }],
];

beforeEach(() => {
  refuseResume = false;
  root = mkdtempSync(join(tmpdir(), "fpai-fallback-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const projectDir = join(root, "projects", "-tmp-myproj");
  mkdirSync(projectDir, { recursive: true });
  transcript = join(projectDir, `${SESSION}.jsonl`);
  process.env.CLAUDE_PROJECTS_PATH = join(root, "projects");
  process.env.FAILPROOFAI_HOME = home;
  resetReplay();
});

afterEach(() => {
  delete process.env.CLAUDE_PROJECTS_PATH;
  delete process.env.FAILPROOFAI_HOME;
  rmSync(root, { recursive: true, force: true });
});

function shape(r: Awaited<ReturnType<typeof runAudit>>) {
  return {
    eventsScanned: r.eventsScanned,
    hits: Object.fromEntries(r.results.filter((x) => x.hits > 0).map((x) => [x.name, x.hits])),
  };
}

describe("a resume the reader could not honour", () => {
  it("does not count the prefix twice", async () => {
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    const truth = shape(await runAudit({ clis: ["claude"], noCache: true }));
    expect(truth.eventsScanned).toBeGreaterThan(0);

    rmSync(join(home, "audit"), { recursive: true, force: true });
    writeFileSync(transcript, lines(0, FIRST));
    await runAudit({ clis: ["claude"] });               // caches a prefix + offset
    appendFileSync(transcript, lines(FIRST.length, SECOND));

    // The cache still grants the resume; the READER refuses it and reads the
    // whole file. The prefix must not be merged onto that.
    refuseResume = true;
    expect(shape(await runAudit({ clis: ["claude"] }))).toEqual(truth);
  });

  it("still merges when the resume WAS honoured", async () => {
    writeFileSync(transcript, lines(0, [...FIRST, ...SECOND]));
    const truth = shape(await runAudit({ clis: ["claude"], noCache: true }));

    rmSync(join(home, "audit"), { recursive: true, force: true });
    writeFileSync(transcript, lines(0, FIRST));
    await runAudit({ clis: ["claude"] });
    appendFileSync(transcript, lines(FIRST.length, SECOND));
    expect(shape(await runAudit({ clis: ["claude"] }))).toEqual(truth);
  });
});
