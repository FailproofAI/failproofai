// @vitest-environment node
/**
 * A policy file must be imported at most ONCE per `loadAllCustomHooks` call,
 * however many discovery routes point at it.
 *
 * `convention-dir-dedup.test.ts` covers the project-dir/user-dir overlap. This
 * covers the other one: an explicit `customPoliciesPath` that points INTO
 * `.failproofai/policies/` at a file whose name also matches the convention, so
 * step 1 and step 2 both load it. That is an ordinary setup, not a contrived
 * one — `failproofai policies -i -c .failproofai/policies/my-policies.mjs`
 * produces exactly it.
 *
 * `customPolicies.add` is an unconditional push, so the second import registers
 * every hook again and the policy runs twice per event, doubling side effects
 * and any counter it keeps.
 *
 * Node-only, which is why it needs pinning here: Bun caches dynamic imports by
 * resolved path and ignores the `?v=` cache-buster, so the duplicate import is
 * a silent no-op there, while Node — which runs the published `dist/cli.mjs`
 * and this suite — honours the query and re-executes the module body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";

const SRC = `
  import { customPolicies, allow } from "failproofai";
  customPolicies.add({
    name: "dedup-probe",
    description: "test policy",
    match: { events: ["PreToolUse"] },
    fn: async () => allow(),
  });
`;

describe("loadAllCustomHooks deduplicates customPoliciesPath against convention files", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    // Keep HOME isolated and distinct from the project root, so the user-scope
    // pass is a genuinely separate directory and cannot mask the overlap.
    home = mkdtempSync(join(tmpdir(), "fp-home-"));
    project = mkdtempSync(join(tmpdir(), "fp-proj-"));
    mkdirSync(join(project, ".failproofai", "policies"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    clearCustomHooks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearCustomHooks();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("registers the hook once when customPoliciesPath is also a convention file", async () => {
    const file = join(project, ".failproofai", "policies", "shared-policies.mjs");
    writeFileSync(file, SRC, "utf8");

    const result = await loadAllCustomHooks(file, { sessionCwd: project });

    expect(result.hooks.filter((h) => h.name === "dedup-probe")).toHaveLength(1);
  });

  it("does not report it as a convention source once step 1 has loaded it", async () => {
    const file = join(project, ".failproofai", "policies", "shared-policies.mjs");
    writeFileSync(file, SRC, "utf8");

    const result = await loadAllCustomHooks(file, { sessionCwd: project });

    expect(result.conventionSources.filter((s) => s.file === "shared-policies.mjs")).toHaveLength(0);
  });

  it("still loads a customPoliciesPath that is not a convention file", async () => {
    const outside = join(project, "standalone.mjs");
    writeFileSync(outside, SRC, "utf8");

    const result = await loadAllCustomHooks(outside, { sessionCwd: project });

    expect(result.hooks.filter((h) => h.name === "dedup-probe")).toHaveLength(1);
  });

  it("still loads convention files when no customPoliciesPath is set", async () => {
    const file = join(project, ".failproofai", "policies", "conv-policies.mjs");
    writeFileSync(file, SRC, "utf8");

    const result = await loadAllCustomHooks(undefined, { sessionCwd: project });

    expect(result.hooks.filter((h) => h.name === "dedup-probe")).toHaveLength(1);
    expect(result.conventionSources.map((s) => s.file)).toContain("conv-policies.mjs");
  });
});
