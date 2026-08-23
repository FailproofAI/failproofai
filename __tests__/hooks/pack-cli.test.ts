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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packAddSource, runPackCommand } from "@/src/hooks/pack-cli";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");
const POLICIES = [
  { name: "block-big-refund", description: "Block big refunds", category: "Finance", defaultEnabled: true, match: {} },
  { name: "require-note", description: "Require a note", category: "Finance", defaultEnabled: true, match: {} },
];

let root: string;
let prev: string | undefined;

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-cli-"));
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  prev = process.env.FAILPROOFAI_PACK_DIR;
  process.env.FAILPROOFAI_PACK_DIR = root;
});

afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
  else process.env.FAILPROOFAI_PACK_DIR = prev;
  rmSync(root, { recursive: true, force: true });
});

const text = (r: { lines: string[] }) => r.lines.join("\n");

describe("pack list", () => {
  it("tells a user with no packs how to get one", async () => {
    const r = await runPackCommand(["list"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toContain("No packs installed.");
    expect(text(r)).toContain("pack add github:owner/repo@tag");
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
