// @vitest-environment node
/**
 * When the project root IS the home directory — a normal setup for a gateway,
 * and the default when the CLI is run from `~` — project and user convention
 * discovery resolve to the SAME directory. Loading both lists registers every
 * hook twice, because `customPolicies.add` is an unconditional push. Every
 * policy then fires twice per event: a counting policy double-counts and trips
 * its ceiling at half the real number.
 *
 * This was masked, not prevented, by the runtime. Bun caches dynamic imports by
 * resolved path and ignores the `?v=` cache-buster, so the second import was a
 * no-op; Node honours the query and re-executes. The shipped binary runs under
 * Bun and this suite runs under Node — so the bug was invisible from the
 * production side and would have fired here. These tests run on the side that
 * can actually see it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import { customPoliciesDir } from "../../src/hooks/fp-home";

const SRC = `
  import { customPolicies, allow } from "failproofai";
  customPolicies.add({
    name: "dedup-probe",
    description: "test policy",
    match: { events: ["PreToolUse"] },
    fn: async () => allow(),
  });
`;

describe("convention discovery deduplicates overlapping directories", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-dedup-"));
    mkdirSync(customPoliciesDir(home), { recursive: true });
    writeFileSync(join(customPoliciesDir(home), "probe-policies.mjs"), SRC, "utf8");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    clearCustomHooks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearCustomHooks();
    rmSync(home, { recursive: true, force: true });
  });

  it("registers each hook once when project and user dirs are the same", async () => {
    const result = await loadAllCustomHooks(undefined, { sessionCwd: home });

    expect(result.hooks).toHaveLength(1);
    expect(result.hooks.map((h) => h.name)).toEqual(["dedup-probe"]);
  });

  it("reports the file once, not once per scope", async () => {
    const result = await loadAllCustomHooks(undefined, { sessionCwd: home });

    const entries = result.conventionSources.filter((s) => s.file === "probe-policies.mjs");
    expect(entries).toHaveLength(1);
  });
});
