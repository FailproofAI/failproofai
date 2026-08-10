// @vitest-environment node
/**
 * Two cloud-managed policies whose SOURCE IS BYTE-IDENTICAL.
 *
 * Artifacts are content-addressed — `artifacts/<sha256>.mjs` — so identical
 * source means identical sha256 means ONE file on disk. The loader keys its
 * cloud-policy lookup by resolved path, and `loadedPaths` then imports that file
 * exactly once (deliberately: `customPolicies.add` is an unconditional push, so
 * a second import would register every hook twice and run the policy twice per
 * event).
 *
 * So the two policies must be merged, and WHICH ONE WINS decides enforcement. A
 * plain `new Map(entries)` let the last one silently replace the first: one id
 * vanished from `failproofai policies` and from the decision log, and its effect
 * decided nothing — an `enforce` policy sharing bytes with an `observe` one was
 * downgraded to observation, which is a silent enforcement gap.
 *
 * The layout-2 tree could not produce this: `deployments/<n>/<id>.mjs` gave every
 * policy its own path even when the bytes matched. Flattening to one `artifacts/`
 * directory is what made it reachable, so this is the test that flattening owes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import type { CloudManagedPolicyArtifact } from "@/src/hooks/cloud-managed-policies";

const SRC = `
  import { customPolicies, allow } from "failproofai";
  customPolicies.add({
    name: "shared-source",
    description: "two deployments, one artifact",
    match: { events: ["PreToolUse"] },
    fn: async () => allow(),
  });
`;

let root: string;
let artifact: string;

/** Both policies point at the ONE artifact their identical bytes hash to. */
function pair(first: "enforce" | "observe", second: "enforce" | "observe"): CloudManagedPolicyArtifact[] {
  const sha256 = createHash("sha256").update(SRC).digest("hex");
  return [
    { id: "alpha", version: 1, effect: first, sha256, path: artifact, deployment: 7 },
    { id: "beta", version: 4, effect: second, sha256, path: artifact, deployment: 7 },
  ];
}

async function loadWith(policies: CloudManagedPolicyArtifact[]) {
  const result = await loadAllCustomHooks([artifact], {
    sessionCwd: root,
    cloudManagedPolicies: policies,
  });
  return result.hooks[0] as { __cloudManaged?: CloudManagedPolicyArtifact; __policyId?: string };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-artifact-collision-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  artifact = join(artifacts, `${createHash("sha256").update(SRC).digest("hex")}.mjs`);
  writeFileSync(artifact, SRC, "utf8");
  clearCustomHooks();
});

afterEach(() => {
  clearCustomHooks();
  rmSync(root, { recursive: true, force: true });
});

describe("two cloud policies sharing one content-addressed artifact", () => {
  it("registers the policy exactly once", async () => {
    // The file is one file. Importing it twice would double every verdict.
    const result = await loadAllCustomHooks([artifact], {
      sessionCwd: root,
      cloudManagedPolicies: pair("enforce", "observe"),
    });
    expect(result.hooks).toHaveLength(1);
  });

  it("enforces when EITHER of them asks to enforce, whichever came first", async () => {
    // The direction is the whole point. Over-enforcing is visible to whoever
    // hits it; under-enforcing is silent, and silent is the failure mode this
    // codebase exists to remove. Both orderings, because "last wins" passed one
    // of them by luck.
    expect((await loadWith(pair("enforce", "observe"))).__cloudManaged?.effect).toBe("enforce");
    clearCustomHooks();
    expect((await loadWith(pair("observe", "enforce"))).__cloudManaged?.effect).toBe("enforce");
  });

  it("still observes when NEITHER asks to enforce", async () => {
    // The merge must not manufacture enforcement out of two observations — that
    // would turn a measurement-only rollout into live denials.
    expect((await loadWith(pair("observe", "observe"))).__cloudManaged?.effect).toBe("observe");
  });
});
