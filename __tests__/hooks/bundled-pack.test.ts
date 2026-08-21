// @vitest-environment node
/**
 * Installing the pack that ships inside the npm package, from disk.
 *
 * This is the thing that makes removing the builtins from the bundle
 * survivable: a machine that has just installed failproofai already HAS them,
 * so setup can enable them with no network. Without it, a fresh offline install
 * would be a machine enforcing nothing while reporting healthy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installBundledPack, bundledPackDir } from "@/src/hooks/pack-store";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";
import { resetHome } from "@/src/hooks/fp-reset";
import { LAYOUT_VERSION, packsDir } from "@/src/hooks/fp-home";

const POLICIES = [
  { name: "block-alpha", description: "d", category: "Sanitize", defaultEnabled: true, match: { events: ["PreToolUse"] } },
  { name: "block-beta", description: "d", category: "Git", defaultEnabled: false, match: { events: ["PreToolUse"] } },
];
const ENTRY = "export const hooks = [];\n";

let packDir: string;
let pkgRoot: string;
let prevPackDir: string | undefined;
let prevRoot: string | undefined;

function writeBundle(over: {
  policies?: unknown[];
  breakDigest?: boolean;
  id?: unknown;
  version?: unknown;
  effect?: unknown;
} = {}): void {
  const dir = join(pkgRoot, "policy-pack");
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.stringify({
    id: over.id ?? "failproofai/builtins", version: over.version ?? "1.0.0",
    policies: over.policies ?? POLICIES,
    ...(over.effect !== undefined ? { effect: over.effect } : {}),
  });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  writeFileSync(join(dir, "failproofai-pack.json"), manifest);
  writeFileSync(join(dir, "failproofai-pack.mjs"), ENTRY);
  writeFileSync(
    join(dir, "SHA256SUMS"),
    `${sha(manifest)}  failproofai-pack.json\n` +
    `${over.breakDigest ? "0".repeat(64) : sha(ENTRY)}  failproofai-pack.mjs\n`,
  );
}

beforeEach(() => {
  packDir = mkdtempSync(join(tmpdir(), "fpai-bundled-packs-"));
  pkgRoot = mkdtempSync(join(tmpdir(), "fpai-bundled-root-"));
  prevPackDir = process.env.FAILPROOFAI_PACK_DIR;
  prevRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  process.env.FAILPROOFAI_PACK_DIR = packDir;
  process.env.FAILPROOFAI_PACKAGE_ROOT = pkgRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries({
    FAILPROOFAI_PACK_DIR: prevPackDir, FAILPROOFAI_PACKAGE_ROOT: prevRoot,
  })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(packDir, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

describe("installBundledPack", () => {
  it("installs from disk with no network, honouring the pack's defaults", () => {
    writeBundle();
    const result = installBundledPack();
    expect(result.installed).toBe(true);
    expect(result.id).toBe("failproofai/builtins");
    expect(result.available).toEqual(["block-alpha", "block-beta"]);
    expect(result.enabled).toEqual(["block-alpha"]);

    const { packs, errors } = readInstalledPacks();
    expect(errors).toEqual([]);
    expect(packs[0].id).toBe("failproofai/builtins");
  });

  it("records a bundled: source, not a github one", () => {
    // `pack add` on this id would otherwise look like a re-fetch of something
    // that was never fetched.
    writeBundle();
    installBundledPack();
    expect(readInstalledPacks().packs[0].source).toBe("bundled:failproofai/builtins@1.0.0");
  });

  it("copies the artifact into the pack dir rather than loading it in place", () => {
    // A `sudo npm i -g` package directory is root-owned, and the loader writes
    // its rewritten tree BESIDE the source — so loading in place gives a
    // non-root hook EACCES and the pack silently never loads.
    writeBundle();
    const result = installBundledPack();
    expect(result.installed).toBe(true);
    const entry = readInstalledPacks().packs[0].path;
    expect(entry.startsWith(packDir)).toBe(true);
    expect(entry.startsWith(pkgRoot)).toBe(false);
  });

  it("verifies the digest even though nothing crossed a network", () => {
    // The recorded digest is what the hook path re-checks before every import,
    // so it has to describe the bytes actually installed. A tarball can be
    // corrupt on disk like anything else.
    writeBundle({ breakDigest: true });
    const result = installBundledPack();
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("failed integrity verification");
    expect(existsSync(join(packDir, "installed.json"))).toBe(false);
  });

  it("refuses a bundled pack the loader itself would reject", () => {
    writeBundle({ policies: [{ ...POLICIES[0], alwaysOn: true }] });
    const result = installBundledPack();
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("alwaysOn");
  });

  it.each([
    [{ id: "failproofai/builtins/extra" }, /unsafe pack id/],
    [{ version: "release/1" }, /invalid version/],
    [{ effect: "audit" }, /unknown effect/],
  ])("refuses loader-invalid identity before activation: %j", (over, message) => {
    writeBundle(over);
    const result = installBundledPack();
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(message);
    expect(existsSync(join(packDir, "installed.json"))).toBe(false);
  });

  it("is idempotent, and keeps a selection across a re-run", () => {
    writeBundle();
    installBundledPack({ only: ["block-beta"] });
    expect(readInstalledPacks().packs[0].enabled).toEqual(["block-beta"]);
    // A second setup run must not quietly switch the rest back on.
    installBundledPack();
    expect(readInstalledPacks().packs).toHaveLength(1);
    expect(readInstalledPacks().packs[0].enabled).toEqual(["block-beta"]);
  });

  it("reports plainly when the build ships no bundled pack", () => {
    // A dev checkout that has not run `build:pack` is a normal state, not an
    // error worth throwing over.
    expect(bundledPackDir()).toBeNull();
    const result = installBundledPack();
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("no bundled pack");
  });

  it("returns null for the dir when the package root is unknown", () => {
    delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    expect(bundledPackDir()).toBeNull();
  });

  it("restores the bundled pack after a home reset removes packs", () => {
    const previousHome = process.env.FAILPROOFAI_HOME;
    delete process.env.FAILPROOFAI_PACK_DIR;
    process.env.FAILPROOFAI_HOME = packDir;
    try {
      writeBundle();
      expect(installBundledPack().installed).toBe(true);
      expect(existsSync(packsDir())).toBe(true);
      resetHome(LAYOUT_VERSION);
      expect(readInstalledPacks().packs.map((pack) => pack.id)).toEqual(["failproofai/builtins"]);
    } finally {
      process.env.FAILPROOFAI_PACK_DIR = packDir;
      if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
      else process.env.FAILPROOFAI_HOME = previousHome;
    }
  });
});
