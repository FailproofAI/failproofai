// @vitest-environment node
/**
 * The contracts probe's oracle, in isolation.
 *
 * A daily lab that reports "clean" when it is actually broken is worse than no
 * lab, because it converts an unknown into a false assurance. Every outcome
 * below is therefore pinned, especially the ones that must NOT be quiet:
 *
 *  - DRIFT is the finding the whole lab exists for, and it is the one no real
 *    CLI produces on demand — a live run can only reach it by a vendor actually
 *    breaking. Asking for it directly is the only way it is ever exercised.
 *  - The two ERROR rows are the traps. Upstream steps (credentials, install)
 *    are deliberately non-fatal, so a CLI that never started yields an empty
 *    observation table — byte-identical to a healthy CLI that was simply idle.
 *    Exit status is what separates them, and it must stay loud.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROBE = path.join(__dirname, "..", "..", "integration-suite", "contracts-probe.sh");

function runProbe(args: string[], env: Record<string, string> = {}) {
  try {
    const out = execFileSync("bash", [PROBE, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { exitCode: 0, ...parse(out) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { exitCode: e.status, ...parse(e.stdout) };
  }
}

function decide(acted: 0 | 1, events: string[], driveRc = 0) {
  return runProbe(["--decide", "claude", String(acted), JSON.stringify(events), String(driveRc)]);
}

function parse(out: string): { verdict: string; note: string } {
  const line = out.split("\n").find((l) => l.startsWith("CONTRACTS_JSON "));
  if (!line) throw new Error(`no verdict line in: ${out}`);
  return JSON.parse(line.slice("CONTRACTS_JSON ".length)) as { verdict: string; note: string };
}

describe("contracts probe: the oracle", () => {
  it("is OK only when a tool ran AND we were called", () => {
    const r = decide(1, ["PreToolUse", "Stop"]);
    expect(r.verdict).toBe("OK");
    expect(r.exitCode).toBe(0);
  });

  it("reports DRIFT when the tool ran and no PreToolUse arrived", () => {
    // The class of failure no customer machine can report: when a vendor
    // rejects our config nothing reaches us, so silence at our end is
    // indistinguishable from a quiet day. The created file is the independent
    // witness that something DID happen without us.
    const r = decide(1, []);
    expect(r.verdict).toBe("DRIFT");
    expect(r.exitCode).toBe(1);
  });

  it("still reports DRIFT when other events arrive but PreToolUse does not", () => {
    // A partial subscription is drift too: the session events prove the config
    // was accepted, which makes the missing tool event a wiring change rather
    // than a rejected file.
    expect(decide(1, ["SessionStart", "Stop"]).verdict).toBe("DRIFT");
  });

  it("is INCONCLUSIVE, quietly, when hooks fired but the model did nothing", () => {
    // The one benign miss. Hooks demonstrably work, so there is nothing to
    // wake anyone for.
    const r = decide(0, ["SessionStart"]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.exitCode).toBe(0);
  });

  it("is LOUD when the CLI itself failed to run", () => {
    const r = decide(0, [], 127);
    expect(r.verdict).toBe("ERROR");
    expect(r.exitCode).toBe(2);
    expect(r.note).toContain("could not run the CLI");
  });

  it("is LOUD when the CLI exited clean and we received nothing at all", () => {
    // Distinct from the row above and easy to collapse into it by accident:
    // this is what a rejected config looks like from our side.
    const r = decide(0, [], 0);
    expect(r.verdict).toBe("ERROR");
    expect(r.exitCode).toBe(2);
    expect(r.note).toContain("no events at all");
  });

  it("still reports when the probe dies before reaching a verdict", () => {
    // `set -u` turns a single unset CANARY_* model variable into an immediate
    // exit from inside drive(). Without the exit trap the outer job collects
    // NOTHING for that CLI — no line, no artifact, indistinguishable from a CLI
    // that was never scheduled. Silence is the one report this lab must never
    // produce, so every death is made to speak.
    const home = mkdtempSync(path.join(tmpdir(), "fpai-probe-"));
    try {
      const r = runProbe(["claude"], { HOME: home, CONTRACTS_REPO_DIR: "/nonexistent" });
      expect(r.verdict).toBe("ERROR");
      expect(r.note).toContain("died before reaching a verdict");
      // 2 is "could not check". 1 would read as "findings remain", which is a
      // claim a run that never happened cannot support.
      expect(r.exitCode).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never calls an empty observation table clean", () => {
    // The single property that keeps the lab honest: no combination of inputs
    // yields OK without evidence that a tool ran and reached us.
    for (const acted of [0, 1] as const) {
      for (const rc of [0, 1, 127]) {
        expect(decide(acted, [], rc).verdict).not.toBe("OK");
      }
    }
  });
});
