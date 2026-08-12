import { describe, it, expect } from "vitest";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import {
  POLICY_PRESETS,
  resolvePreset,
  resolveEverything,
  RECOMMENDED_POLICIES,
  defaultsMissingFromRecommended,
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

describe("RECOMMENDED_POLICIES", () => {
  it("names 15 policies and every one of them is a real non-beta builtin", () => {
    // The count is asserted because it is a product promise the wizard PRINTS
    // ("15 policies · global"). Changing the set is fine; changing it without
    // noticing that the screen now advertises a different number is not.
    expect(RECOMMENDED_POLICIES).toHaveLength(15);
    for (const name of RECOMMENDED_POLICIES) {
      const policy = BUILTIN_POLICIES.find((p) => p.name === name);
      expect(policy, `${name} is not a builtin policy`).toBeDefined();
      expect(policy!.beta, `${name} is beta and cannot be recommended`).toBeFalsy();
    }
  });

  it("contains no duplicates", () => {
    expect(new Set(RECOMMENDED_POLICIES).size).toBe(RECOMMENDED_POLICIES.length);
  });

  it("covers every default-enabled builtin", () => {
    // The drift guard. Recommended is written out by hand rather than derived,
    // so the day somebody adds a new `defaultEnabled` policy it would silently
    // NOT be in the recommended set — and a machine set up by pressing Enter
    // would be guarded less than one set up through the policy list. The
    // failure is invisible from either screen; this is the only thing looking.
    expect(defaultsMissingFromRecommended()).toEqual([]);
  });

  it("excludes the policy families that must never be a default", () => {
    // Each of these has a specific reason recorded next to the list:
    // require-*-before-stop refuses to let the agent finish and does not fire
    // at all on hermes/goose; infra blocking breaks the day job of anyone who
    // runs kubectl; block-read-outside-cwd false-positives constantly.
    const excludedCategories = new Set(["Workflow", "Infra Commands"]);
    for (const name of RECOMMENDED_POLICIES) {
      const policy = BUILTIN_POLICIES.find((p) => p.name === name)!;
      expect(
        excludedCategories.has(policy.category),
        `${name} is in ${policy.category}, which is deliberately not recommended`,
      ).toBe(false);
    }
    expect(RECOMMENDED_POLICIES).not.toContain("block-read-outside-cwd");
    expect(RECOMMENDED_POLICIES).not.toContain("block-work-on-main");
  });

  it("recommends no warn-only policy", () => {
    // Ten warnings is noise, and a warning nobody reads is worse than one that
    // was never shown. Everything recommended actually prevents something.
    expect(RECOMMENDED_POLICIES.filter((n) => n.startsWith("warn-"))).toEqual([]);
  });

  it("includes the three that were off by default and should not have been", () => {
    // The gap that prompted this list: a "recommended" setup that omits
    // catastrophic deletion and force-push is not recommendable.
    expect(RECOMMENDED_POLICIES).toContain("block-rm-rf");
    expect(RECOMMENDED_POLICIES).toContain("block-force-push");
    expect(RECOMMENDED_POLICIES).toContain("block-secrets-write");
  });
});
