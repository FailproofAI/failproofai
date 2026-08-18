// @vitest-environment node
/**
 * Corroboration decides whether a pack is promoted to every customer machine,
 * so it has two ways to be wrong and both are expensive.
 *
 * Too strict and nothing ever promotes: the local table is a union accumulated
 * over weeks, and a single lab run cannot match it key for key. Too loose and a
 * pack from a bad run sails through on no evidence at all.
 *
 * The tests below are mostly about the middle: what counts as evidence, and
 * what only looks like it.
 */
import { describe, it, expect } from "vitest";
import { corroborateContractPack } from "../../src/hooks/contract-corroborate";

/** One CLI record in either a pack or a local table. */
function cli(version: string, tools: Record<string, string[]>, event = "PreToolUse") {
  return { version, hooks: { [event]: { envelope: [], tools } } };
}

const run = (pack: Record<string, unknown>, local: Record<string, unknown>) =>
  corroborateContractPack({ clis: pack }, { clis: local });

describe("agreement", () => {
  it("corroborates when both sides saw the same shape", () => {
    const r = run(
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
    );
    expect(r.verdict).toBe("corroborated");
    expect(r.agreed).toBe(1);
    expect(r.comparedClis).toEqual(["goose"]);
  });

  it("corroborates when this machine has accumulated an extra optional key", () => {
    // The property that makes this usable at all. A local table is a union over
    // weeks of real sessions; a lab run is one session. Demanding key-for-key
    // equality would mean nothing is ever promoted.
    const r = run(
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
      { goose: cli("1.43.0", { write: ["content", "path", "encoding", "mode"] }) },
    );
    expect(r.verdict).toBe("corroborated");
  });

  it("corroborates when both sides agree that something IS broken", () => {
    // Agreement is not "no findings" — it is "the same findings". Two machines
    // both seeing an unreadable key is exactly the case worth promoting fast.
    const r = run(
      { copilot: cli("1.0.94", { read: ["uri"] }) },
      { copilot: cli("1.0.94", { read: ["uri"] }) },
    );
    expect(r.verdict).toBe("corroborated");
  });
});

describe("disagreement", () => {
  it("contradicts when the two sides would produce different findings", () => {
    const r = run(
      { goose: cli("1.43.0", { write: ["content", "uri"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
    );
    expect(r.verdict).toBe("contradicted");
    expect(r.disagreements[0]).toMatchObject({ cli: "goose", tool: "write", version: "1.43.0" });
    expect(r.disagreements[0].detail).toContain("do not lead to the same finding");
  });

  it("one disagreement is enough, however much else agreed", () => {
    const r = run(
      { goose: cli("1.43.0", { write: ["content", "path"], view: ["uri"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"], view: ["path"] }) },
    );
    expect(r.agreed).toBe(1);
    expect(r.verdict).toBe("contradicted");
  });
});

describe("what it refuses to compare", () => {
  it("does not treat a version difference as a contradiction", () => {
    // The single most important exclusion. If the lab drove a newer CLI, a
    // difference IS the vendor moving — the thing the pack exists to report.
    // Comparing across versions would block exactly the promotions that matter.
    const r = run(
      { goose: cli("1.44.0", { write: ["content", "uri"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
    );
    expect(r.verdict).toBe("no-overlap");
    expect(r.disagreements).toEqual([]);
    expect(r.skipped[0].reason).toContain("lab drove 1.44.0");
  });

  it("ignores tools only one side exercised", () => {
    const r = run(
      { goose: cli("1.43.0", { view: ["path"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
    );
    expect(r.verdict).toBe("no-overlap");
    expect(r.skipped[0].reason).toContain("no tool was exercised on both sides");
  });

  it("ignores CLIs this machine does not run", () => {
    const r = run(
      { devin: cli("3000.1.0", { exec: ["command"] }) },
      { goose: cli("1.43.0", { write: ["content", "path"] }) },
    );
    expect(r.verdict).toBe("no-overlap");
    expect(r.skipped).toEqual([{ cli: "devin", reason: "this machine does not run it" }]);
  });

  it("skips a CLI missing a version on either side rather than guessing", () => {
    const noVersion = { hooks: { PreToolUse: { envelope: [], tools: { write: ["path"] } } } };
    expect(run({ goose: cli("1.43.0", { write: ["path"] }) }, { goose: noVersion }).verdict).toBe(
      "no-overlap",
    );
    expect(run({ goose: noVersion }, { goose: cli("1.43.0", { write: ["path"] }) }).verdict).toBe(
      "no-overlap",
    );
  });
});

describe("no-overlap is not a pass", () => {
  it("returns no-overlap, never corroborated, when nothing was comparable", () => {
    // Promotion requires evidence. "We could not check" is not evidence, and a
    // machine that runs none of the lab's CLIs must not wave a pack through.
    expect(run({}, {}).verdict).toBe("no-overlap");
    expect(run({ goose: cli("1.43.0", { write: ["path"] }) }, {}).verdict).toBe("no-overlap");
  });

  it("never throws on malformed input from either side", () => {
    // This gates a pull request from a scheduled job; a crash must read as "did
    // not corroborate", not take the job down.
    for (const bad of [null, "nope", 42, [], { clis: "x" }, { clis: { goose: 5 } }]) {
      expect(() => corroborateContractPack(bad, bad)).not.toThrow();
      expect(corroborateContractPack(bad, bad).verdict).toBe("no-overlap");
    }
  });
});
