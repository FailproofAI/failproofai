import { describe, it, expect } from "vitest";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import {
  POLICY_PRESETS,
  resolvePreset,
  resolveEverything,
} from "../../src/hooks/policy-presets";

describe("policy-presets", () => {
  it("exposes the four themed presets in wizard order", () => {
    expect(POLICY_PRESETS.map((p) => p.id)).toEqual(["secrets", "git", "ship", "infra"]);
  });

  it("every preset resolves to at least one real builtin policy", () => {
    const known = new Set(BUILTIN_POLICIES.map((p) => p.name));
    for (const preset of POLICY_PRESETS) {
      const resolved = resolvePreset(preset.id);
      expect(resolved.length).toBeGreaterThan(0);
      for (const name of resolved) expect(known.has(name)).toBe(true);
    }
  });

  it("secrets preset covers Sanitize + Environment + block-secrets-write, not git", () => {
    const r = resolvePreset("secrets");
    expect(r).toContain("sanitize-api-keys");
    expect(r).toContain("protect-env-vars");
    expect(r).toContain("block-env-files");
    expect(r).toContain("block-read-outside-cwd");
    expect(r).toContain("block-secrets-write");
    expect(r).not.toContain("block-force-push");
  });

  it("git preset is exactly the Git category", () => {
    const gitNames = BUILTIN_POLICIES.filter((p) => !p.beta && p.category === "Git").map((p) => p.name);
    expect(new Set(resolvePreset("git"))).toEqual(new Set(gitNames));
  });

  it("ship preset is the require-*-before-stop workflow policies", () => {
    const r = resolvePreset("ship");
    expect(r).toContain("require-commit-before-stop");
    expect(r).toContain("require-push-before-stop");
    expect(r).toContain("require-ci-green-before-stop");
  });

  it("infra preset blocks the cloud/infra CLIs", () => {
    const r = resolvePreset("infra");
    expect(r).toContain("block-kubectl");
    expect(r).toContain("block-terraform");
    expect(r).toContain("block-aws-cli");
  });

  it("resolveEverything returns all non-beta builtins", () => {
    const expected = BUILTIN_POLICIES.filter((p) => !p.beta).map((p) => p.name);
    expect(resolveEverything().length).toBe(expected.length);
    expect(new Set(resolveEverything())).toEqual(new Set(expected));
  });

  it("unknown preset id resolves to empty", () => {
    expect(resolvePreset("does-not-exist")).toEqual([]);
  });
});
