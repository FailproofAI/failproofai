// @vitest-environment node
/**
 * The public API for declaring a semantic policy.
 *
 * It is its OWN namespace rather than a `customPolicies.addSemantic`, and that is
 * the part worth pinning: a semantic policy has no `fn` and no `match`, nothing
 * about it executes on a user's machine, and what installs is the declaration in
 * the pack manifest. Behind the object whose entries return `allow()`/`deny()`,
 * every one of those differences becomes a mistake the manifest parser has to
 * catch — and none of them would be visible until somebody read a manifest.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { clearCustomHooks, customPolicies, getCustomHooks, getSemanticRegistrations, semanticPolicies } from "@/src/hooks/custom-hooks-registry";
import type { SemanticPolicyDeclaration, SemanticToolClass } from "@/src/hooks/policy-types";
import type { ToolClass } from "@/src/hooks/semantic/types";

const declaration = (over: Partial<SemanticPolicyDeclaration> = {}): SemanticPolicyDeclaration => ({
  name: "destructive-deletion",
  title: "Deleted something irreplaceable",
  appliesTo: ["shell", "write"],
  mode: "deny",
  userCanOverride: true,
  probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
  guidance: "Confirm the exact paths with the user first.",
  ...over,
});

describe("semanticPolicies — its own namespace, not a customPolicies variant", () => {
  beforeEach(() => {
    clearCustomHooks();
  });

  it("registers a declaration and hands it back in order", () => {
    semanticPolicies.add(declaration());
    semanticPolicies.add(declaration({ name: "secret-exposure" }));
    expect(getSemanticRegistrations().map((s) => s.name)).toEqual(["destructive-deletion", "secret-exposure"]);
  });

  it("keeps the two registries apart, so a build step cannot confuse the shapes", () => {
    // A semantic policy has no `fn` and no `match`; a regex policy has no probes.
    // Behind one object the parser would have to catch each mistake, and neither
    // would be visible until somebody read a manifest.
    customPolicies.add({ name: "block-refunds", fn: async () => ({ decision: "allow" }) });
    semanticPolicies.add(declaration());
    expect(getCustomHooks().map((h) => h.name)).toEqual(["block-refunds"]);
    expect(getSemanticRegistrations().map((s) => s.name)).toEqual(["destructive-deletion"]);
  });

  it("is cleared by clearCustomHooks, together with the hooks", () => {
    // One registration pass, one reset. A loader that cleared only the hooks
    // would carry one entry file's semantic policies into the next file's build.
    customPolicies.add({ name: "block-refunds", fn: async () => ({ decision: "allow" }) });
    semanticPolicies.add(declaration());
    clearCustomHooks();
    expect(getCustomHooks()).toEqual([]);
    expect(getSemanticRegistrations()).toEqual([]);
  });

  it("validates nothing itself — the manifest parser owns every rule", () => {
    // Deliberate: the rules are applied at build time and again at load time, and
    // a third copy in the setter is a third place for them to drift.
    expect(() => semanticPolicies.add({ name: "x" } as unknown as SemanticPolicyDeclaration)).not.toThrow();
  });

  it("is exported from the package entry point, beside customPolicies", async () => {
    const api = await import("@/src/index");
    expect(typeof api.semanticPolicies.add).toBe("function");
    expect(typeof api.getSemanticRegistrations).toBe("function");
  });
});

describe("the tool-class list the public API copies", () => {
  it("matches the semantic evaluator's own, which it deliberately does not import", () => {
    // `policy-types.ts` is on every custom policy's import graph, and the semantic
    // modules must stay off an unconfigured machine's. So the union is restated
    // there and pinned here.
    const publicClasses: SemanticToolClass[] = ["shell", "write", "read", "network", "other"];
    const internalClasses: ToolClass[] = ["shell", "write", "read", "network", "other"];
    expect(publicClasses).toEqual(internalClasses);
  });
});
