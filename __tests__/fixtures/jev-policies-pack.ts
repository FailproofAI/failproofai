/**
 * A stand-in for the published `FailproofAI/jev-policies` pack: FailproofAI's
 * sixteen Jev checks, as a pack's manifest declares them.
 *
 * This build asks no Jev check of its own — the checks come only from
 * installed packs — so every test that exercises Jev's decisions on the
 * sixteen has to install them first, exactly as a user runs
 * `policies add FailproofAI/jev-policies`. Built from `SEMANTIC_POLICIES`, the
 * definitions that pack is written from, and through the loader's own parser,
 * so what a test installs is what a machine reading the real manifest holds.
 *
 * Two ways in:
 *
 * - {@link installJevPoliciesPack} writes a real `installed.json` and a
 *   digest-pinned artifact into a pack directory, for tests that go through
 *   the real reader and have no builtin regex policies to keep.
 * - {@link withJevPoliciesPack} adds the pack to a `readInstalledPacks()`
 *   result, for a `vi.mock` of `pack-manifest`. It leaves `installed.json`
 *   alone, so the handler's migration shim keeps registering this build's
 *   builtin regex policies beside it — the regex half those tests are about.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Types only from `pack-manifest`: tests `vi.mock` that module with a factory
// that imports THIS file, and a runtime import back into it would deadlock.
import type { ResolvedPack, SemanticManifestEntry } from "../../src/hooks/pack-manifest";
import { SEMANTIC_POLICIES } from "../../src/hooks/semantic/policies";

export const JEV_POLICIES_ID = "FailproofAI/jev-policies";
export const JEV_POLICIES_VERSION = "0.2.0";
export const JEV_POLICIES_SOURCE = `github:${JEV_POLICIES_ID}@v${JEV_POLICIES_VERSION}`;

/**
 * The precondition NAME the pack gives each builtin predicate. A manifest
 * cannot carry a function, so the two gated checks name theirs; the bodies in
 * `preconditions.ts` are the same tests `policies.ts` writes inline, which
 * `pack-preconditions.test.ts` pins.
 */
const PRECONDITION_NAMES: Record<string, string> = {
  "commit-on-protected-branch": "protected_branch",
  "read-outside-workspace": "paths_outside_project",
};

/**
 * The sixteen as `FailproofAI/jev-policies` declares them, already in the shape
 * the loader's parser returns: `jev-checks-pack-only.test.ts` pins that each
 * survives `parsePackSemanticPolicy` unchanged.
 */
export const JEV_POLICIES_SEMANTIC: SemanticManifestEntry[] = SEMANTIC_POLICIES.map((p) => {
  const precondition = PRECONDITION_NAMES[p.name];
  if (p.precondition && !precondition) throw new Error(`no precondition name for ${p.name}`);
  return {
    name: p.name,
    title: p.title,
    appliesTo: [...p.appliesTo],
    mode: p.mode,
    userCanOverride: p.userCanOverride,
    probes: p.probes.map((probe) => ({ ...probe })),
    // The parser keys an exemption `exempt` whatever the manifest wrote.
    ...(p.exempt ? { exempt: { ...p.exempt, id: "exempt" } } : {}),
    ...(precondition ? { precondition } : {}),
    guidance: p.guidance,
  } as SemanticManifestEntry;
});

/** An entry that registers nothing: the pack is Jev checks only. */
const ARTIFACT = "export {};\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

/** The manifest record `policies add` writes for the pack. */
export function jevPoliciesRecord(): Record<string, unknown> {
  return {
    id: JEV_POLICIES_ID,
    version: JEV_POLICIES_VERSION,
    source: JEV_POLICIES_SOURCE,
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    effect: "enforce",
    policies: [],
    semantic: JEV_POLICIES_SEMANTIC,
  };
}

let scratch: string | undefined;

/** Write the artifact into `packDir` (a scratch directory when none), returning its absolute path. */
function writeArtifact(packDir?: string): string {
  if (!packDir) packDir = scratch ??= mkdtempSync(join(tmpdir(), "fpai-jev-policies-"));
  mkdirSync(join(packDir, "artifacts"), { recursive: true });
  const path = join(packDir, "artifacts", `${DIGEST}.mjs`);
  writeFileSync(path, ARTIFACT);
  return path;
}

/**
 * Install the pack for real: `installed.json` (with any `others` records first)
 * and its artifact. Note that an installed pack switches the handler's legacy
 * builtin shim off, as it does on a real machine.
 */
export function installJevPoliciesPack(packDir: string, others: Record<string, unknown>[] = []): void {
  writeArtifact(packDir);
  writeFileSync(join(packDir, "installed.json"), JSON.stringify({ schemaVersion: 1, packs: [...others, jevPoliciesRecord()] }));
}

/** The pack as `readInstalledPacks` resolves it, with its artifact written into `packDir`. */
export function jevPoliciesResolvedPack(packDir?: string): ResolvedPack {
  return {
    id: JEV_POLICIES_ID,
    version: JEV_POLICIES_VERSION,
    source: JEV_POLICIES_SOURCE,
    path: writeArtifact(packDir),
    sha256: DIGEST,
    effect: "enforce",
    policies: [],
    semantic: JEV_POLICIES_SEMANTIC,
    enabled: null,
    clis: null,
  };
}

/**
 * A `readInstalledPacks()` result with the pack added, for a `vi.mock` of
 * `pack-manifest`. `packDir` is where its (empty) artifact is written.
 */
export function withJevPoliciesPack<T extends { packs: ResolvedPack[] }>(result: T, packDir?: string): T {
  if (result.packs.some((p) => p.id === JEV_POLICIES_ID)) return result;
  return { ...result, packs: [...result.packs, jevPoliciesResolvedPack(packDir)] };
}
