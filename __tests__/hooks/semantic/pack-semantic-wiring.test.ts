// @vitest-environment node
/**
 * The one wiring point: `prepareSemantic` asks about the set an installed pack
 * declared, and about the compiled-in set when no pack declares one.
 *
 * Driven through the real reader with a real manifest and a real digest, because
 * the thing worth proving is not that the resolver returns the right array — the
 * unit tests beside this do that — but that the evaluator actually consults it,
 * and that a machine with no pack is unchanged.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSemantic } from "@/src/hooks/semantic/evaluator";
import { SEMANTIC_POLICIES } from "@/src/hooks/semantic/policies";
import { resolveSemanticPolicies, _resetSemanticWarningsForTest } from "@/src/hooks/semantic/pack-policies";
import type { SemanticInput } from "@/src/hooks/semantic/types";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

const semanticEntry = (over: Record<string, unknown> = {}) => ({
  name: "pack-destructive-deletion",
  title: "Deleted something irreplaceable",
  appliesTo: ["shell", "write", "read", "network", "other"],
  mode: "deny",
  userCanOverride: true,
  probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
  guidance: "Confirm the exact paths with the user first.",
  ...over,
});

let root: string;
let saved: string | undefined;

function writeManifest(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "acme/guards",
          version: "1.0.0",
          source: "github:acme/guards@v1.0.0",
          entry: `artifacts/${DIGEST}.mjs`,
          sha256: DIGEST,
          policies: [
            { name: "block-refunds", description: "d", category: "C", defaultEnabled: true, match: { events: ["PreToolUse"] } },
          ],
          ...over,
        },
      ],
    }),
  );
}

const input: SemanticInput = {
  eventType: "PreToolUse",
  toolName: "Bash",
  toolInput: { command: "rm -rf /" },
  userSaid: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-semantic-wiring-"));
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = process.env.FAILPROOFAI_PACK_DIR;
  process.env.FAILPROOFAI_PACK_DIR = root;
  _resetSemanticWarningsForTest();
});

afterEach(() => {
  if (saved === undefined) delete process.env.FAILPROOFAI_PACK_DIR;
  else process.env.FAILPROOFAI_PACK_DIR = saved;
  rmSync(root, { recursive: true, force: true });
  _resetSemanticWarningsForTest();
});

describe("resolveSemanticPolicies", () => {
  it("is the compiled-in set with no manifest at all", () => {
    expect(resolveSemanticPolicies()).toBe(SEMANTIC_POLICIES);
  });

  it("is the compiled-in set when the manifest is unreadable", () => {
    // The same fail-open posture every other reader of this file takes — and here
    // it also fails safe: a pack's `reviewedBy` will not match the builtin names,
    // so nothing is cleared by a question nobody could read.
    writeFileSync(join(root, "installed.json"), "{ not json");
    expect(resolveSemanticPolicies()).toBe(SEMANTIC_POLICIES);
  });

  it("is the pack's set once it declares one", () => {
    writeManifest({ semantic: [semanticEntry()] });
    expect(resolveSemanticPolicies().map((p) => p.name)).toEqual(["pack-destructive-deletion"]);
  });

  it("says once, not per call, why it dropped something", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeManifest({ semantic: [semanticEntry(), semanticEntry({ mode: "warn" })] });
      resolveSemanticPolicies();
      const first = warn.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      resolveSemanticPolicies();
      // The warm worker evaluates thousands of calls; a per-call warning on the
      // hook's stderr is read as the deny text itself by some CLIs.
      expect(warn.mock.calls.length).toBe(first);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("prepareSemantic consults the resolved set", () => {
  it("asks the compiled-in questions when no pack declares any", () => {
    writeManifest();
    const prepared = prepareSemantic(input);
    const names = prepared.selected.map((p) => p.name);
    expect(names).toContain("destructive-deletion");
    expect(names.every((n) => SEMANTIC_POLICIES.some((p) => p.name === n))).toBe(true);
  });

  it("asks the pack's questions instead once it declares any", () => {
    writeManifest({ semantic: [semanticEntry()] });
    const prepared = prepareSemantic(input);
    expect(prepared.selected.map((p) => p.name)).toEqual(["pack-destructive-deletion"]);
    // Wholesale: the builtin question ids are not in the request either.
    expect(Object.keys(prepared.compiled.request.questions)).toContain("pack-destructive-deletion.destroys");
    expect(Object.keys(prepared.compiled.request.questions)).not.toContain("destructive-deletion.destroys");
  });

  it("still lets a caller supply its own set, for a replay or an ablation", () => {
    writeManifest({ semantic: [semanticEntry()] });
    const only = SEMANTIC_POLICIES.filter((p) => p.name === "secret-exposure");
    expect(prepareSemantic(input, { policies: only }).selected.map((p) => p.name)).toEqual(["secret-exposure"]);
  });

  it("applies a pack policy's precondition, so an ungated question is not asked everywhere", () => {
    writeManifest({ semantic: [semanticEntry({ precondition: "protected_branch" })] });
    // No git branch in these facts, so the gate is false and nothing is asked —
    // which is also what makes a request of zero questions cost nothing.
    const prepared = prepareSemantic({ ...input, cwd: root });
    expect(prepared.selected).toEqual([]);
    expect(Object.keys(prepared.compiled.request.questions)).toEqual([]);
  });
});
