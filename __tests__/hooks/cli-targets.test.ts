// @vitest-environment node
/**
 * `--cli` on a pack, which had two silent failures and reported success for
 * both.
 *
 * Both matter more than they look, because the whole point of the flag is to
 * NARROW what a pack guards. Getting it wrong does not throw and does not warn
 * — it produces a machine that is guarded less than its owner believes, which
 * is the failure mode this product exists to prevent.
 *
 *  - An unknown name was accepted: `--cli claud` installed the pack, printed
 *    "Installed", exited 0, and guarded nothing, because the misspelling
 *    matched no agent.
 *  - A space-separated list was truncated to its first entry, because this lane
 *    split on commas while the other lane split on spaces. `--cli claude codex`
 *    recorded ["claude"] and dropped codex.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packAddSource, selectionFromForTest } from "../../src/hooks/pack-cli";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

// `runPackCommand` resolves ~/.failproofai unless told otherwise, so without
// this a test that reaches it writes into the developer's REAL home — and into
// whatever other test files happen to share the worker. Every case below is
// meant to fail at argument parsing, before any of that; the isolation is here
// because "meant to" is not a guarantee, and a test that can touch the real
// home is a bug whether or not it currently does.
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-cli-targets-"));
  process.env.FAILPROOFAI_HOME = home;
});
afterAll(() => {
  delete process.env.FAILPROOFAI_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("finding the pack among a flag's values", () => {
  // `--cli` consumes several tokens, so it has to know where its own list
  // ends. "Not a flag" is not enough — that swallows the source.
  const cases: Array<[string[], string | undefined]> = [
    [["acme/x"], "acme/x"],
    [["--cli", "claude", "codex", "acme/x"], "acme/x"],
    [["--cli", "claude,codex", "acme/x"], "acme/x"],
    [["acme/x", "--cli", "claude", "codex"], "acme/x"],
    [["--policy", "block-sudo", "--cli", "claude", "codex", "acme/x"], "acme/x"],
    [["--cli=claude,codex", "acme/x"], "acme/x"],
    [["--cli", "claude", "--policy", "block-sudo", "acme/x"], "acme/x"],
  ];
  it.each(cases)("finds the source in %j", (argv, want) => {
    expect(packAddSource(argv as string[])).toBe(want);
  });

  it("skips the values of flags this lane does not even act on", () => {
    // `--scope` and `--custom` are handled by the caller and passed through
    // untouched — and their values were being read as the pack to install, so
    // `policies add --scope project acme/x` went looking for a pack called
    // "project". A flag this file ignores still has a value it must skip.
    expect(packAddSource(["--scope", "project", "acme/x"])).toBe("acme/x");
    expect(packAddSource(["--custom", "./p.mjs", "acme/x"])).toBe("acme/x");
    expect(packAddSource(["-c", "./p.mjs", "acme/x"])).toBe("acme/x");
    expect(packAddSource(["--cli", "claude", "codex", "--scope", "project", "acme/x"])).toBe("acme/x");
  });

  it("separates the list from the source by SHAPE, not by knowing the names", () => {
    // An unknown name still has to be consumed, so it can be REJECTED. Stopping
    // at it would hand it to the source parser instead, and the reply would be
    // about pack syntax rather than about the typo.
    expect(packAddSource(["--cli", "claud", "acme/x"])).toBe("acme/x");
  });
});

describe("every agent named, in either spelling", () => {
  // THE bug: this lane split on commas while the other split on spaces, so a
  // space-separated list was silently truncated to its first entry. Nobody was
  // told; the install reported success and the pack guarded one agent instead
  // of two. Both spellings work now because being given a different answer to
  // the one you typed is the failure being fixed.
  it("takes a space-separated list", () => {
    expect(selectionFromForTest(["acme/x", "--cli", "claude", "codex"]).clis)
      .toEqual(["claude", "codex"]);
  });

  it("takes a comma-separated list", () => {
    expect(selectionFromForTest(["acme/x", "--cli", "claude,codex"]).clis)
      .toEqual(["claude", "codex"]);
  });

  it("takes them mixed, because somebody will", () => {
    expect(selectionFromForTest(["acme/x", "--cli", "claude,codex", "cursor"]).clis)
      .toEqual(["claude", "codex", "cursor"]);
  });

  it("takes the =-joined form", () => {
    expect(selectionFromForTest(["acme/x", "--cli=claude,codex"]).clis)
      .toEqual(["claude", "codex"]);
  });

  it("stops at the source rather than eating it", () => {
    expect(selectionFromForTest(["--cli", "claude", "codex", "acme/x"]).clis)
      .toEqual(["claude", "codex"]);
  });

  it("leaves clis unset when the flag is absent, meaning every agent", () => {
    // Undefined and empty are different answers: absent means "all of them",
    // and a pack that quietly narrowed to none would enforce nowhere.
    expect(selectionFromForTest(["acme/x"]).clis).toBeUndefined();
  });
});

describe("which agents a pack is scoped to", () => {
  // Driven through the real command so the parse, the validation and what
  // lands in the manifest are all one path — the bug was that they were not.
  async function scope(argv: string[]): Promise<{ exitCode: number; text: string }> {
    const { runPackCommand } = await import("../../src/hooks/pack-cli");
    const r = await runPackCommand(argv);
    return { exitCode: r.exitCode, text: r.lines.join("\n") };
  }

  it("refuses a name that is not an agent, and says which", async () => {
    const r = await scope(["add", "acme/x", "--cli", "claud"]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/Not an agent/);
    expect(r.text).toMatch(/claud/);
  });

  it("suggests the agent that was meant", async () => {
    const r = await scope(["add", "acme/x", "--cli", "claud"]);
    expect(r.text).toMatch(/did you mean claude/);
  });

  it("names every agent it will take, from the one list there is", async () => {
    // Not a list written out in the message: `bin/failproofai.mjs` already
    // keeps a second hand-maintained copy, and a third would be the one that
    // drifts when a thirteenth CLI lands.
    const r = await scope(["add", "acme/x", "--cli", "nope"]);
    for (const known of INTEGRATION_TYPES) {
      expect(r.text, `${known} should be offered`).toContain(known);
    }
  });

  it("refuses before it fetches anything", async () => {
    // A pack scoped to an agent that does not exist enforces on nothing, and
    // saying so after the download is no use to a script that already read
    // exit 0 and moved on.
    const r = await scope(["add", "acme/does-not-exist", "--cli", "claud"]);
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/Not an agent/);
    expect(r.text).not.toMatch(/fetch|download|releases/i);
  });
});
