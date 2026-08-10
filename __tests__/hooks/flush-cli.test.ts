import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/fp-config", () => ({
  readConfig: vi.fn(() => ({ collector: { hooks: true, sessions: true } })),
}));
vi.mock("../../src/hooks/collector-config", () => ({
  readIngestCredential: vi.fn(() => ({ url: "http://localhost:3000/v1/events", key: "k" })),
}));
vi.mock("../../src/hooks/daemon-service", () => ({
  daemonServiceStatus: vi.fn(() => "running"),
  isDaemonSupportedPlatform: vi.fn(() => true),
}));

import { runFlushCommand, pendingBatches, flushRequestPath } from "../../src/hooks/flush-cli";
import { readConfig } from "../../src/hooks/fp-config";
import { readIngestCredential } from "../../src/hooks/collector-config";
import { daemonServiceStatus } from "../../src/hooks/daemon-service";

let home: string;

const spool = (name: string, files: string[]) => {
  // `home` is the HOME dir; the failproofai home is `<home>/.failproofai`.
  const dir = join(home, ".failproofai", "state", "spool", name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "{}\n");
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-flush-"));
  vi.mocked(readConfig).mockReturnValue({ collector: { hooks: true, sessions: true } } as never);
  vi.mocked(readIngestCredential).mockReturnValue({ url: "u", key: "k" } as never);
  vi.mocked(daemonServiceStatus).mockReturnValue("running" as never);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("pendingBatches", () => {
  it("counts .jsonl across every source dir and ignores half-written .tmp", () => {
    spool("claude", ["a.jsonl", "b.jsonl", "c.tmp"]);
    spool("hooks", ["d.jsonl"]);
    expect(pendingBatches(home)).toBe(3);
  });

  it("skips failed/, which is the parked-batch retry lane, not pending delivery", () => {
    spool("claude", ["a.jsonl"]);
    spool("failed", ["parked.jsonl", "parked2.jsonl"]);
    expect(pendingBatches(home)).toBe(1);
  });

  it("is zero when nothing has ever spooled", () => {
    expect(pendingBatches(home)).toBe(0);
  });
});

describe("runFlushCommand preconditions", () => {
  it("refuses when collection is off, and does not write a request", async () => {
    vi.mocked(readConfig).mockReturnValue({ collector: { hooks: false, sessions: false } } as never);
    const r = await runFlushCommand({ home });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("Collection is off");
    expect(existsSync(flushRequestPath(home))).toBe(false);
  });

  it("refuses when the machine is not connected", async () => {
    vi.mocked(readIngestCredential).mockReturnValue(null as never);
    const r = await runFlushCommand({ home });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("not connected");
    expect(existsSync(flushRequestPath(home))).toBe(false);
  });

  it("refuses when the daemon is not running — it is what delivers", async () => {
    spool("claude", ["a.jsonl"]);
    vi.mocked(daemonServiceStatus).mockReturnValue("stopped" as never);
    const r = await runFlushCommand({ home });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("stopped");
    // A request the daemon will never read is worse than no request: it sits
    // on disk and fires whenever the daemon next starts, long after the ask.
    expect(existsSync(flushRequestPath(home))).toBe(false);
  });

  it("succeeds without writing a request when nothing is spooled", async () => {
    const r = await runFlushCommand({ home });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain("Nothing spooled");
    expect(existsSync(flushRequestPath(home))).toBe(false);
  });
});

describe("runFlushCommand request", () => {
  it("writes the request when batches are pending", async () => {
    spool("claude", ["a.jsonl", "b.jsonl"]);
    const r = await runFlushCommand({ home });
    expect(r.exitCode).toBe(0);
    expect(r.pending).toBe(2);
    expect(r.lines[0]).toContain("2 batches spooled");
    expect(existsSync(flushRequestPath(home))).toBe(true);
  });

  it("says 'batch' not 'batches' for one", async () => {
    spool("claude", ["a.jsonl"]);
    const r = await runFlushCommand({ home });
    expect(r.lines[0]).toContain("1 batch spooled");
    expect(r.lines[0]).not.toContain("batches");
  });

  it("--wait returns 0 once the spool drains", async () => {
    spool("claude", ["a.jsonl"]);
    let ticks = 0;
    const sleep = async () => {
      // Simulate the daemon delivering on the second poll.
      if (++ticks === 2)
        rmSync(join(home, ".failproofai", "state", "spool", "claude"), { recursive: true });
    };
    const r = await runFlushCommand({ home, wait: true, timeoutSecs: 10, sleep });
    expect(r.exitCode).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.lines.at(-1)).toBe("Spool drained.");
  });

  it("--wait times out non-zero, and says delivery continues rather than calling it broken", async () => {
    spool("claude", ["a.jsonl"]);
    // Never drains. Advance the clock so the deadline passes without real waiting.
    const realNow = Date.now;
    let t = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => t);
    const sleep = async () => {
      t += 1000;
    };
    const r = await runFlushCommand({ home, wait: true, timeoutSecs: 3, sleep });
    vi.mocked(Date.now).mockRestore();
    expect(r.exitCode).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.lines.join(" ")).toContain("Delivery continues in the background");
  });
});
