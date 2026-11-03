// @vitest-environment node
/**
 * `semanticPolicies.add` only reaches a machine through a pack's manifest. In a
 * local or cloud-managed policy file it registers and is never asked, and a
 * `reviewedBy` naming it resolves hard — so loading one has to say so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import type { ResolvedPack } from "@/src/hooks/pack-manifest";

// Pushes to the registries directly, so the test does not depend on a built dist.
const SRC = (tag: string) => `
  // ${tag}
  const g = globalThis;
  if (!Array.isArray(g.__failproofai_custom_hooks__)) g.__failproofai_custom_hooks__ = [];
  if (!Array.isArray(g.__failproofai_semantic_policies__)) g.__failproofai_semantic_policies__ = [];
  g.__failproofai_custom_hooks__.push({ name: "block-prod-db", fn: async () => ({ decision: "allow" }) });
  g.__failproofai_semantic_policies__.push({ name: "prod-db-writes" });
`;

let home: string;
let project: string;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fp-sem-outside-home-"));
  project = mkdtempSync(join(tmpdir(), "fp-sem-outside-project-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("FAILPROOFAI_HOME", join(home, ".failproofai"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  clearCustomHooks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearCustomHooks();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("semanticPolicies.add outside a pack", () => {
  it("in a convention file, is reported as never asked", async () => {
    const dir = join(project, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guards-policies.mjs"), SRC("convention"), "utf8");
    const result = await loadAllCustomHooks(undefined, { sessionCwd: project });
    expect(result.hooks.map((h) => h.name)).toContain("block-prod-db");
    expect(stderr.join("")).toMatch(/guards-policies\.mjs.*semanticPolicies\.add only takes effect in a pack.*prod-db-writes/);
  });

  it("in a pack's own artifact, is said nothing about — the manifest is its source", async () => {
    const path = join(project, "artifact.mjs");
    writeFileSync(path, SRC("pack"), "utf8");
    const pack = {
      id: "acme/db",
      version: "1.0.0",
      source: "github:acme/db@v1.0.0",
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      effect: "enforce",
      policies: [],
      enabled: null,
      clis: null,
    } as unknown as ResolvedPack;
    await loadAllCustomHooks([path], { sessionCwd: project, packs: [pack] });
    expect(stderr.join("")).not.toMatch(/semanticPolicies\.add only takes effect/);
  });
});
