// @vitest-environment node
/**
 * The audit cache key, and the property that decides whether anybody eats a cold
 * rescan.
 *
 * `engineVersion` keys on-disk audit cache entries, and it hashes the builtin
 * policy bodies and NOTHING else. It used to fold in installed pack identities
 * too, on the reasoning that packs change what a machine would have caught —
 * true of enforcement, and never true of this replay: `initReplay` registers
 * `BUILTIN_POLICIES` and never reads the installed packs, so a pack cannot move
 * an audit result. Keying on one meant every install or removal cold-rescanned
 * the whole history (~104s, per the note on CACHE_TTL_MS) to reproduce answers
 * it already had — survivable while packs were rare, and not once policies ARE
 * packs.
 *
 * The pre-pack formula is still the reference, and still has to match exactly:
 * that is what makes this change free for a machine with no packs, and one
 * rescan for a machine with one.
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

function installPack(id: string, version: string, artifact = ARTIFACT): void {
  const digest = createHash("sha256").update(artifact).digest("hex");
  writeFileSync(join(root, "artifacts", `${digest}.mjs`), artifact);
  writeFileSync(
    join(root, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [{
        id, version,
        source: `github:${id}@${version}`,
        entry: `artifacts/${digest}.mjs`,
        sha256: digest,
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

  it("does NOT change when a pack is installed", async () => {
    // The reported symptom: install core, audit, remove it, and every transcript
    // is re-scanned to produce identical results.
    const before = await engineVersion();
    installPack("acme/finance", "1.2.0");
    expect(await engineVersion()).toBe(before);
  });

  it("does NOT change when the same pack moves to a new version", async () => {
    installPack("acme/finance", "1.2.0");
    const before = await engineVersion();
    installPack("acme/finance", "2.0.0");
    expect(await engineVersion()).toBe(before);
  });

  it("does NOT change when the installed artifact digest changes", async () => {
    installPack("acme/finance", "1.2.0");
    const before = await engineVersion();
    // A different artifact means a different digest, which is what the old key
    // folded in most eagerly.
    installPack("acme/finance", "1.2.0", "export const hooks = [1];\n");
    expect(await engineVersion()).toBe(before);
  });

  it("is the pre-pack hash whether or not a pack is installed", async () => {
    // The two halves of the guarantee in one assertion: a machine with no packs
    // keeps the key it already had, and a machine WITH one converges on the same
    // key rather than carrying its own.
    installPack("acme/finance", "1.2.0");
    expect(await engineVersion()).toBe(prePackEngineVersion());
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
