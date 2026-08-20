// @vitest-environment node
/**
 * The audit cache key, and the one property that decides whether shipping pack
 * support costs every existing user a cold rescan.
 *
 * `engineVersion` keys on-disk audit cache entries. A machine that has never
 * installed a pack must hash EXACTLY as it did before packs existed — otherwise
 * merely upgrading invalidates the cache and forces a full re-scan of every
 * transcript (~104s, per the note on CACHE_TTL_MS) for a feature nobody is using.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";

/** Exactly the pre-pack formula, reproduced here so the test is independent of
 *  the implementation it checks. */
function prePackEngineVersion(): string {
  const blob = BUILTIN_POLICIES.map((p) => `${p.name}|${p.fn.toString()}`).sort().join("\n");
  return createHash("sha1").update(blob).digest("hex").slice(0, 16);
}

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let root: string;
let prevEnv: string | undefined;

/** Fresh module each time — engineVersion memoizes per process. */
async function engineVersion(): Promise<string> {
  const { getEngineVersionForTest } = await import("@/src/audit/cache");
  return getEngineVersionForTest();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-ev-packs-"));
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  prevEnv = process.env.FAILPROOFAI_PACK_DIR;
  process.env.FAILPROOFAI_PACK_DIR = root;
  vi.resetModules();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
  else process.env.FAILPROOFAI_PACK_DIR = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

import { vi } from "vitest";

function installPack(id: string, version: string): void {
  writeFileSync(
    join(root, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [{
        id, version,
        source: `github:${id}@${version}`,
        entry: `artifacts/${DIGEST}.mjs`,
        sha256: DIGEST,
        policies: [],
      }],
    }),
  );
}

describe("engineVersion with packs", () => {
  it("is UNCHANGED from the pre-pack formula when no pack is installed", async () => {
    // The upgrade-cost guarantee. If this ever fails, shipping the change cold-
    // rescans every existing user's whole transcript history.
    expect(await engineVersion()).toBe(prePackEngineVersion());
  });

  it("changes once a pack is installed", async () => {
    installPack("acme/finance", "1.2.0");
    vi.resetModules();
    expect(await engineVersion()).not.toBe(prePackEngineVersion());
  });

  it("changes again when the same pack moves to a new version", async () => {
    installPack("acme/finance", "1.2.0");
    vi.resetModules();
    const at120 = await engineVersion();
    installPack("acme/finance", "1.3.0");
    vi.resetModules();
    expect(await engineVersion()).not.toBe(at120);
  });

  it("falls back to the builtin-only hash when the manifest is unreadable", async () => {
    // A corrupt manifest must not change the cache key: the packs did not load,
    // so the audit that runs is a builtin-only audit and should hit the cache a
    // builtin-only audit wrote.
    writeFileSync(join(root, "installed.json"), "not json");
    vi.resetModules();
    expect(await engineVersion()).toBe(prePackEngineVersion());
  });
});
