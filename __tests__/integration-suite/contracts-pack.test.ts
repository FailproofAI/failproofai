// @vitest-environment node
/**
 * The pack the lab publishes, pinned.
 *
 * `pack-sample.json` is not hand-written — it is the real output of
 * `contracts-local.sh` driving a live goose 1.43.0 session. It exists so the
 * consumer and the producer cannot drift apart silently: the lab lives in its
 * own repo on its own release cadence, so nothing else in CI would notice if
 * the file it publishes stopped being the file this build can read.
 *
 * The property that matters is that a pack IS an observation table. The lab
 * adds `generatedAt` and a per-CLI `probe` block, and the comparator must read
 * straight through them — same code path, same findings, whether the table came
 * from this machine or from the lab.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareContractTable } from "../../src/hooks/contract-compare";

const PACK = join(__dirname, "..", "fixtures", "contracts", "pack-sample.json");
const pack = JSON.parse(readFileSync(PACK, "utf8")) as Record<string, any>;

describe("the published pack", () => {
  it("is shaped like an observation table, so one parser reads both", () => {
    expect(pack.clis).toBeTruthy();
    const goose = pack.clis.goose;
    expect(goose.version).toBe("1.43.0");
    expect(Object.keys(goose.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    // Recorded from the vendor, not from us: goose delivers the file tools'
    // path as `path`, which GOOSE_TOOL_INPUT_MAP translates.
    expect(goose.hooks.PreToolUse.tools.write.sort()).toEqual(["content", "path"]);
  });

  it("carries the lab's own metadata without confusing the comparator", () => {
    expect(pack.generatedAt).toEqual(expect.any(String));
    expect(pack.clis.goose.probe.verdict).toBe("OK");
    const [goose] = compareContractTable(pack);
    expect(goose.cli).toBe("goose");
    expect(goose.version).toBe("1.43.0");
    expect(goose.findings).toEqual([]);
  });

  it("still parses when the lab adds fields this build has never seen", () => {
    // The lab ships from its own repo and will grow fields before a client
    // release knows about them. Tolerating that is the whole reason there is no
    // schema version to disagree about.
    const future = {
      ...pack,
      newTopLevel: { anything: true },
      clis: {
        ...pack.clis,
        goose: { ...pack.clis.goose, capturedBy: "lab-2", timings: [1, 2, 3] },
      },
    };
    const [goose] = compareContractTable(future);
    expect(goose.findings).toEqual([]);
    expect(goose.version).toBe("1.43.0");
  });

  it("reports drift when a CLI in the pack sends something we cannot read", () => {
    // The same pack a day after a vendor renames a key: the file still parses,
    // and the finding is about the vendor rather than about the format.
    const drifted = {
      ...pack,
      clis: {
        ...pack.clis,
        copilot: {
          version: "1.0.94",
          probe: { verdict: "OK", note: "tool ran and we were called" },
          hooks: { PreToolUse: { envelope: [], tools: { read: ["uri"] } } },
        },
      },
    };
    const findings = compareContractTable(drifted).flatMap((c) => c.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0].cli).toBe("copilot");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].missing).toEqual(["file_path", "path"]);
  });
});
