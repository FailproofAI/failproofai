// @vitest-environment node
/**
 * The `pack` command's OUTPUT, which is the only thing this layer owns.
 *
 * Two behaviours here are deliberate rather than incidental: a partially-taken
 * pack names what it left out (a count reads as fine right up until someone
 * discovers which ones), and a pack that is installed but refuses to load exits
 * NON-ZERO — the machine is enforcing less than its manifest claims, which is
 * the state a person most needs told about.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packAddSource, runPackCommand } from "@/src/hooks/pack-cli";

// Registers exactly what the manifest below declares. `pack list` imports the
// artifact now — a listing that reports a pack healthy while the machine denies
// every tool call because of it is worse than no listing — so a stub artifact
// IS the broken pack, not a stand-in for a working one.
const ARTIFACT = `
  import { customPolicies } from "failproofai";
  customPolicies.add({ name: "block-big-refund", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });
  customPolicies.add({ name: "require-note", description: "d",
    match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });
`;
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");
const POLICIES = [
  { name: "block-big-refund", description: "Block big refunds", category: "Finance", defaultEnabled: true, match: {} },
  { name: "require-note", description: "Require a note", category: "Finance", defaultEnabled: true, match: {} },
];

let root: string;
let prev: string | undefined;
let prevPackageRoot: string | undefined;
/** A package root carrying a freshly built `policy-pack/`, shared by the file. */
let packageRoot: string;

function install(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [{
        id: "acme/finance", version: "1.2.0", source: "github:acme/finance@v1.2.0",
        entry: `artifacts/${DIGEST}.mjs`, sha256: DIGEST, policies: POLICIES, ...over,
      }],
    }),
  );
}

beforeAll(() => {
  packageRoot = mkdtempSync(join(tmpdir(), "fpai-pack-cli-pkg-"));
  execFileSync(
    "bun",
    ["scripts/build-policy-pack.mjs", "--out", join(packageRoot, "policy-pack")],
    { cwd: resolve(__dirname, "../.."), stdio: ["pipe", "pipe", "inherit"] },
  );
}, 120_000);

afterAll(() => {
  rmSync(packageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-cli-"));
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  prev = process.env.FAILPROOFAI_PACK_DIR;
  process.env.FAILPROOFAI_PACK_DIR = root;
  // `core` reads the pack VENDORED in the package. Pointing at the repo root
  // works locally and fails in CI: `test` and `build` are separate jobs, so
  // `policy-pack/` does not exist there. Generate it, like the conformance test.
  prevPackageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  process.env.FAILPROOFAI_PACKAGE_ROOT = packageRoot;
});

afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
  else process.env.FAILPROOFAI_PACK_DIR = prev;
  if (prevPackageRoot === undefined) delete process.env.FAILPROOFAI_PACKAGE_ROOT;
  else process.env.FAILPROOFAI_PACKAGE_ROOT = prevPackageRoot;
  rmSync(root, { recursive: true, force: true });
});

const text = (r: { lines: string[] }) => r.lines.join("\n");

describe("the short name for our own policies", () => {
  // `failproofai pack add FailproofAI/policies` is the honest form and nobody
  // types it. `core` resolves to the copy inside the package, so it is also the
  // one install that cannot fail on a proxy.
  it.each(["core", "failproofai", "official"])("takes `%s` as the source", async (alias) => {
    const r = await runPackCommand(["add", alias]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(/no network needed/);
  });

  it("takes one policy by name, and does not read the flag's value as the source", async () => {
    const r = await runPackCommand(["add", "core", "--policy", "block-rm-rf"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(/enabled \(1\//);
    expect(text(r)).toContain("block-rm-rf");
  });

  it("still takes --only, so anything scripted against it keeps working", async () => {
    const r = await runPackCommand(["add", "core", "--only", "block-rm-rf"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(/enabled \(1\//);
  });

  it("takes a whole category", async () => {
    const r = await runPackCommand(["add", "core", "--category", "dangerous-commands"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toContain("block-sudo");
  });

  it("names the categories that exist when given one that does not", async () => {
    const r = await runPackCommand(["add", "core", "--category", "nope"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(/no such category: nope/);
    expect(text(r)).toContain("dangerous-commands");
  });

  it("suggests the selection flags when it did not install everything", async () => {
    const r = await runPackCommand(["add", "core"]);
    expect(text(r)).toContain("--policy");
    expect(text(r)).toContain("--category");
    expect(text(r)).toContain("--all");
  });
});

describe("pack list", () => {
  it("tells a user with no packs how to get one", async () => {
    const r = await runPackCommand(["list"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toContain("No packs installed.");
    expect(text(r)).toContain("policies add github:owner/repo@tag");
  });

  it("marks every policy on or off, including the ones not taken", async () => {
    install({ enabled: ["block-big-refund"] });
    const r = await runPackCommand(["list"]);
    expect(r.exitCode).toBe(0);
    // Chips, not bare words: the state has to survive NO_COLOR, so it carries a
    // symbol and a word rather than a colour.
    expect(text(r)).toContain("✓ ON     block-big-refund");
    expect(text(r)).toContain("· OFF    require-note");
    expect(text(r)).toContain("github:acme/finance@v1.2.0");
  });

  it("exits non-zero and names a pack that will not load", async () => {
    // Enforcing less than the manifest claims. Reporting success here is how a
    // machine ends up quietly unprotected.
    install({ sha256: "0".repeat(64) });
    const r = await runPackCommand(["list"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("NOT LOADED");
    expect(text(r)).toContain("acme/finance");
  });

  it("defaults to list with no subcommand", async () => {
    expect((await runPackCommand([])).exitCode).toBe(0);
  });
});

describe("pack remove", () => {
  it("removes an installed pack", async () => {
    install();
    const r = await runPackCommand(["remove", "acme/finance"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toContain("Removed acme/finance");
    expect(text(await runPackCommand(["list"]))).toContain("No packs installed.");
  });

  it("fails on an id that is not installed", async () => {
    const r = await runPackCommand(["remove", "nope/nope"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("No installed pack with id nope/nope");
  });

  it("needs an id", async () => {
    expect((await runPackCommand(["remove"])).exitCode).toBe(1);
  });
});

describe("pack add usage", () => {
  it("does not mistake separate flag values for the source", () => {
    expect(packAddSource(["--only", "block-refunds", "acme/support-agent"]))
      .toBe("acme/support-agent");
    expect(packAddSource(["--category", "finance", "acme/support-agent", "--all"]))
      .toBe("acme/support-agent");
    expect(packAddSource(["--only=block-refunds", "acme/support-agent"]))
      .toBe("acme/support-agent");
  });

  it("needs a source", async () => {
    const r = await runPackCommand(["add"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("Usage:");
  });

  it("rejects an empty --only rather than silently taking everything", async () => {
    const r = await runPackCommand(["add", "github:a/b@v1", "--only"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("at least one policy name");
  });

  it("reports a bad source as a failure, not a crash", async () => {
    const r = await runPackCommand(["add", "not-a-source"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("Could not install pack");
  });
});

describe("unknown subcommand", () => {
  it("lists what it accepts", async () => {
    const r = await runPackCommand(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("add, remove, list");
  });
});
