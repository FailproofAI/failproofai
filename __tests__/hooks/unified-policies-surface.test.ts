// @vitest-environment node
//
// `policies`, `policy` and `pack` were three commands for one idea — two of them
// a single letter apart, doing unrelated things. They are one command now, and
// the old spellings are TRANSLATED rather than rejected, because they are
// printed in shipped help, in the docs, and in the release notes of every pack
// published so far.
//
// The translation happens as argv rewriting at the top of `bin/failproofai.mjs`,
// above `SUBCOMMANDS` and every dispatch, so no branch below has to remember the
// aliases. That is not reachable from a module import, so these drive the real
// binary and read what it printed.
//
// The property under test is EQUIVALENCE: an alias must not merely work, it must
// produce byte-identical output to the canonical spelling. A near-copy that
// drifts is exactly what having three commands cost in the first place.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_ALIASES } from "../../src/hooks/pack-store";
import { runPolicyPicker } from "../../src/hooks/pack-cli";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");

const HOME = mkdtempSync(join(tmpdir(), "fpai-surface-"));
let fpHome: string;

beforeEach(() => {
  fpHome = mkdtempSync(join(tmpdir(), "fpai-surface-home-"));
  mkdirSync(fpHome, { recursive: true });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

/** `offline: true` proves a path reaches no network, rather than assuming it. */
function cli(args: string[], opts: { offline?: boolean } = {}): Run {
  const result = spawnSync("bun", [BINARY, ...args], {
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      FAILPROOFAI_HOME: fpHome,
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
      ...(opts.offline ? { FAILPROOFAI_NO_DOWNLOAD: "1" } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { exitCode: result.status ?? 1, stdout, stderr, all: stdout + stderr };
}

describe("the old spellings still answer, and answer identically", () => {
  it("takes `pack list` as the bare listing, which is the question it was asking", () => {
    const canonical = cli(["policies"]);
    const alias = cli(["pack", "list"]);
    expect(canonical.exitCode).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it("takes `p` for the same listing", () => {
    expect(cli(["p"]).stdout).toBe(cli(["policies"]).stdout);
  });

  it("routes `pack list <source>` to `show`, the OTHER question it was asking", () => {
    // One word was doing two jobs: with no argument it described this machine,
    // with one it described a pack somewhere else. Those are different
    // questions and they are different words now.
    const viaAlias = cli(["pack", "list", "acme/nothing-here"], { offline: true });
    const viaShow = cli(["policies", "show", "acme/nothing-here"], { offline: true });
    expect(viaAlias.all).toBe(viaShow.all);
    expect(viaAlias.exitCode).toBe(viaShow.exitCode);
  });

  it("takes `policy add` and `policies add` as one command", () => {
    expect(cli(["policy", "add", "--help"]).stdout).toBe(cli(["policies", "add", "--help"]).stdout);
  });

  it("resolves `pack build` to `publish`, which is what it always was minus the release", () => {
    const built = cli(["pack", "build"]);
    // Usage, not "unknown command" — the word still means something.
    expect(built.all).toMatch(/failproofai publish/);
    expect(built.all).toMatch(/--repo <owner>\/<repo>/);
  });
});

describe("a name or a source, told apart by the slash", () => {
  // A policy name matches /^[A-Za-z0-9._-]+$/, so a slash is already illegal in
  // one and unambiguous in the other. No flag to discover before you can install
  // somebody else's policies.

  it("sends a slashed argument to the pack lane", () => {
    const r = cli(["policies", "add", "acme/nothing-here"], { offline: true });
    expect(r.exitCode).not.toBe(0);
    // The pack lane's own refusal, which names fetching.
    expect(r.all).toMatch(/fetch|download|FAILPROOFAI_NO_DOWNLOAD/i);
  });

  it("sends a bare name to the policy lane, and fails DIFFERENTLY", () => {
    const bare = cli(["policies", "add", "no-such-policy-here"], { offline: true });
    const slashed = cli(["policies", "add", "acme/nothing-here"], { offline: true });
    expect(bare.all).not.toBe(slashed.all);
    // A bare name is never a fetch — nothing about the network can appear.
    expect(bare.all).not.toMatch(/FAILPROOFAI_NO_DOWNLOAD/);
  });

  it("sends a github: source to the pack lane even with no slash-leading owner", () => {
    const r = cli(["policies", "add", "github:acme/nothing-here"], { offline: true });
    expect(r.all).toMatch(/fetch|download|FAILPROOFAI_NO_DOWNLOAD/i);
  });

  it("sends every core alias to the pack lane, though none of them has a slash", () => {
    // Read from the layer that OWNS the aliases. Restating them here is the
    // drift that already shipped once, when the dashboard could not resolve a
    // name the CLI could.
    expect(CORE_ALIASES.size).toBeGreaterThan(0);
    for (const alias of CORE_ALIASES) {
      const r = cli(["policies", "add", alias, "--policy", "block-rm-rf"]);
      expect(r.exitCode, `${alias} should install our pack`).toBe(0);
      expect(r.all).toMatch(/failproofai\/core/);
    }
  });

  it("is case-insensitive about those aliases, because nobody types Core on purpose", () => {
    const r = cli(["policies", "add", "CORE", "--policy", "block-rm-rf"]);
    expect(r.exitCode).toBe(0);
    expect(r.all).toMatch(/failproofai\/core/);
  });
});

describe("`policies add` with nothing after it", () => {
  it("refuses from a script rather than silently confirming what is already true", async () => {
    // `multiSelect` degrades on a non-TTY by returning its PRE-CHECKED set. That
    // is the right degradation for a wizard step and the wrong one here: it
    // would report success for a run that changed nothing and answered nothing.
    const result = await runPolicyPicker("add", {
      stdin: { isTTY: false } as never,
      stdout: { isTTY: false, columns: 80 } as never,
    });
    expect(result.exitCode).not.toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("policies add <policy-name>");
    expect(text).toContain("--all");
  });

  it("tells a machine with no packs where policies come from, and exits clean", async () => {
    // No packs is a FRESH machine, not a broken one — and since the wizard
    // stopped choosing policies, it is what every new install looks like. A
    // person at a terminal gets an answer, not an error.
    const empty = mkdtempSync(join(tmpdir(), "fpai-surface-packs-"));
    const before = process.env.FAILPROOFAI_PACK_DIR;
    process.env.FAILPROOFAI_PACK_DIR = empty;
    try {
      const result = await runPolicyPicker("add", {
        // isTTY on BOTH, so the refusal above does not fire; the empty-state
        // branch returns before any prompt is drawn, so nothing needs a stream.
        stdin: { isTTY: true } as never,
        stdout: { isTTY: true, columns: 80 } as never,
      });
      expect(result.exitCode).toBe(0);
      const text = result.lines.join("\n");
      expect(text).toContain("No policies are installed yet.");
      expect(text).toContain("failproofai policies add core");
      expect(text).toContain("<owner>/<repo>");
    } finally {
      if (before === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
      else process.env.FAILPROOFAI_PACK_DIR = before;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses through the real binary too, where stdin is a pipe", () => {
    const r = cli(["policies", "add"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toMatch(/needs a terminal/);
    expect(r.all).toMatch(/<owner>\/<repo>/);
  });
});

describe("what the unified command actually does", () => {
  it("installs part of a pack and reports the part it did not take", () => {
    const r = cli(["policies", "add", "core", "--policy", "block-rm-rf"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/enabled \(1\//);
    expect(r.stdout).toMatch(/not enabled/);
  });

  it("uninstalls a whole pack by its id, which has a slash and so is a source", () => {
    cli(["policies", "add", "core", "--policy", "block-rm-rf"]);
    const removed = cli(["policies", "remove", "failproofai/core"]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toMatch(/Removed failproofai\/core/);
    expect(cli(["policies"]).stdout).not.toMatch(/✓ PACK/);
  });

  it("keeps the artifact after a remove, so re-adding it needs no network", () => {
    cli(["policies", "add", "core", "--policy", "block-rm-rf"]);
    cli(["policies", "remove", "failproofai/core"]);
    const again = cli(["policies", "add", "core", "--policy", "block-rm-rf"], { offline: true });
    expect(again.exitCode).toBe(0);
  });

  it("suggests the new spelling, never the retired one, when it has more to offer", () => {
    const r = cli(["policies", "add", "core", "--policy", "block-rm-rf"]);
    expect(r.stdout).not.toMatch(/failproofai pack (add|list)/);
  });
});
