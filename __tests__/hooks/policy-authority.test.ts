// @vitest-environment node
/**
 * Policy authority: who has the last word on a policy's verdict once Jev is
 * configured. Every assertion here is about the DEFAULT — anything that is not
 * a clean, complete `reviewable` declaration must come out `hard`, because an
 * authority that silently widened would let Jev clear a deny its author never
 * agreed to hand over.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { effectiveAuthority } from "../../src/hooks/policy-types";
import {
  SEMANTIC_REVIEWER_NAMES,
  authorityDeclarationFor,
  authorityFieldsOf,
  resolvePolicyAuthority,
} from "../../src/hooks/policy-authority";
import { SEMANTIC_POLICIES, INJECTION_PROBE, SCOPE_PROBE, TASK_PROBES } from "../../src/hooks/semantic/policies";
import { clearPolicies, getAllPolicies, registerPolicy } from "../../src/hooks/policy-registry";
import { parsePackPolicy } from "../../src/hooks/pack-manifest";
import type { PolicyCatalogEntry } from "../../src/hooks/policy-types";

const allow = () => ({ decision: "allow" as const });

describe("effectiveAuthority — shape only", () => {
  it.each([
    ["absent", {}],
    ["hard", { authority: "hard", reviewedBy: ["secret-exposure"] }],
    ["an unknown value", { authority: "soft", reviewedBy: ["secret-exposure"] }],
    ["a non-string value", { authority: 1, reviewedBy: ["secret-exposure"] }],
    ["reviewable with no reviewedBy", { authority: "reviewable" }],
    ["reviewable with an empty reviewedBy", { authority: "reviewable", reviewedBy: [] }],
    ["reviewable with a string reviewedBy", { authority: "reviewable", reviewedBy: "secret-exposure" }],
    ["reviewable with one malformed entry", { authority: "reviewable", reviewedBy: ["secret-exposure", 5] }],
    ["reviewable with an empty-string entry", { authority: "reviewable", reviewedBy: ["", "secret-exposure"] }],
  ])("is hard for %s", (_label, decl) => {
    expect(effectiveAuthority(decl as never)).toBe("hard");
  });

  it("is hard for alwaysOn, even with a complete reviewable declaration", () => {
    expect(
      effectiveAuthority({ authority: "reviewable", reviewedBy: ["agent-config-tampering"], alwaysOn: true }),
    ).toBe("hard");
  });

  it("is reviewable only for a complete declaration", () => {
    expect(effectiveAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure"] })).toBe("reviewable");
    expect(
      effectiveAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure"], alwaysOn: false }),
    ).toBe("reviewable");
  });
});

describe("SEMANTIC_REVIEWER_NAMES", () => {
  it("is exactly the semantic policy names", () => {
    expect([...SEMANTIC_REVIEWER_NAMES].sort()).toEqual(SEMANTIC_POLICIES.map((p) => p.name).sort());
    expect(SEMANTIC_REVIEWER_NAMES.size).toBe(16);
  });

  it("does not accept a probe as a reviewer", () => {
    // Probes feed Jev's own decision; they are not checks a regex verdict can
    // be cleared by, so naming one must not make a policy reviewable.
    for (const probe of [INJECTION_PROBE, SCOPE_PROBE, ...TASK_PROBES]) {
      expect(SEMANTIC_REVIEWER_NAMES.has(probe.id)).toBe(false);
      expect(resolvePolicyAuthority({ authority: "reviewable", reviewedBy: [probe.id] }).authority).toBe("hard");
    }
  });
});

describe("resolvePolicyAuthority", () => {
  it("resolves a complete declaration to reviewable, deduplicated in declared order", () => {
    expect(
      resolvePolicyAuthority({
        authority: "reviewable",
        reviewedBy: ["secret-exposure", "env-secrets-dump", "secret-exposure"],
      }),
    ).toEqual({ authority: "reviewable", reviewedBy: ["secret-exposure", "env-secrets-dump"] });
  });

  it("is hard, with no warning, when nothing asked for reviewable", () => {
    expect(resolvePolicyAuthority(undefined)).toEqual({ authority: "hard" });
    expect(resolvePolicyAuthority({})).toEqual({ authority: "hard" });
    expect(resolvePolicyAuthority({ authority: "hard", reviewedBy: ["secret-exposure"] })).toEqual({
      authority: "hard",
    });
    // An unknown VALUE is not a request for reviewable either — it is a typo
    // that already resolves to the safe answer.
    expect(resolvePolicyAuthority({ authority: "Reviewable", reviewedBy: ["secret-exposure"] })).toEqual({
      authority: "hard",
    });
  });

  it("refuses a name that is not a semantic policy in this build — the whole declaration, not the name", () => {
    // reviewedBy is a conjunction. Dropping the unknown name would let Jev clear
    // the policy on fewer checks than its author asked for.
    const r = resolvePolicyAuthority({
      authority: "reviewable",
      reviewedBy: ["secret-exposure", "secret-exposure-v2"],
    });
    expect(r.authority).toBe("hard");
    expect(r.reviewedBy).toBeUndefined();
    expect(r.downgraded).toMatch(/"secret-exposure-v2"/);
    expect(r.downgraded).toMatch(/is not a semantic policy/);
  });

  it("says why a reviewable claim was refused", () => {
    expect(resolvePolicyAuthority({ authority: "reviewable" }).downgraded).toMatch(/does not name any/);
    expect(resolvePolicyAuthority({ authority: "reviewable", reviewedBy: [] }).downgraded).toMatch(/does not name any/);
    expect(resolvePolicyAuthority({ authority: "reviewable", reviewedBy: [7] }).downgraded).toMatch(
      /not a list of semantic policy names/,
    );
    expect(
      resolvePolicyAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure"], alwaysOn: true }).downgraded,
    ).toMatch(/alwaysOn/);
  });

  it("does not hand back the caller's own array", () => {
    const names = ["secret-exposure"];
    const r = resolvePolicyAuthority({ authority: "reviewable", reviewedBy: names });
    names.push("read-outside-workspace");
    expect(r.reviewedBy).toEqual(["secret-exposure"]);
  });
});

describe("registerPolicy stores the RESOLVED authority", () => {
  beforeEach(() => clearPolicies());

  const only = () => {
    const all = getAllPolicies();
    expect(all).toHaveLength(1);
    return all[0];
  };

  it("leaves both fields absent when the caller declares nothing", () => {
    registerPolicy("p", "d", allow, {});
    const p = only();
    expect("authority" in p).toBe(false);
    expect("reviewedBy" in p).toBe(false);
    expect(effectiveAuthority(p)).toBe("hard");
  });

  it("records hard explicitly when a declaration was given and is hard", () => {
    registerPolicy("p", "d", allow, {}, 0, undefined, { authority: "hard" });
    expect(only()).toMatchObject({ authority: "hard" });
    expect("reviewedBy" in only()).toBe(false);
  });

  it("records reviewable with a clean reviewedBy", () => {
    registerPolicy("p", "d", allow, {}, 0, undefined, {
      authority: "reviewable",
      reviewedBy: ["read-outside-workspace", "read-outside-workspace"],
    });
    const p = only();
    expect(p.authority).toBe("reviewable");
    expect(p.reviewedBy).toEqual(["read-outside-workspace"]);
    expect(effectiveAuthority(p)).toBe("reviewable");
  });

  it.each([
    ["an invalid value", { authority: "yes", reviewedBy: ["secret-exposure"] }],
    ["no reviewedBy", { authority: "reviewable" }],
    ["an unknown semantic policy", { authority: "reviewable", reviewedBy: ["made-up"] }],
    ["a malformed reviewedBy", { authority: "reviewable", reviewedBy: [null] }],
    ["alwaysOn", { authority: "reviewable", reviewedBy: ["agent-config-tampering"], alwaysOn: true }],
  ])("registers %s as hard with no reviewedBy", (_label, meta) => {
    registerPolicy("p", "d", allow, {}, 0, undefined, meta as never);
    const p = only();
    expect(p.authority).toBe("hard");
    expect("reviewedBy" in p).toBe(false);
    // What T3's combine step calls on a registered policy: it has no alwaysOn
    // to consult, so the registry must already hold the effective value.
    expect(effectiveAuthority(p)).toBe("hard");
  });

  it("replaces the authority along with the policy on re-registration", () => {
    registerPolicy("p", "d", allow, {}, 0, undefined, { authority: "reviewable", reviewedBy: ["secret-exposure"] });
    registerPolicy("p", "d", allow, {}, 0, undefined, { authority: "hard" });
    expect(only().authority).toBe("hard");
    expect("reviewedBy" in only()).toBe(false);
  });
});

describe("authorityFieldsOf — for parsers", () => {
  it("keeps shape-valid fields and copies the list", () => {
    const list = ["secret-exposure"];
    const out = authorityFieldsOf({ authority: "reviewable", reviewedBy: list });
    expect(out).toEqual({ authority: "reviewable", reviewedBy: ["secret-exposure"] });
    expect(out.reviewedBy).not.toBe(list);
  });

  it("drops malformed fields independently, never throwing", () => {
    expect(authorityFieldsOf({ authority: "maybe", reviewedBy: ["secret-exposure"] })).toEqual({
      reviewedBy: ["secret-exposure"],
    });
    expect(authorityFieldsOf({ authority: "reviewable", reviewedBy: ["ok", 3] })).toEqual({ authority: "reviewable" });
    expect(authorityFieldsOf({ authority: "hard", reviewedBy: [] })).toEqual({ authority: "hard" });
    expect(authorityFieldsOf({})).toEqual({});
  });

  it("leaves unknown-but-well-formed names to registration, where the build decides", () => {
    // A pack built against a newer semantic set is shape-valid here; this build
    // judges the names when it registers the policy.
    expect(authorityFieldsOf({ authority: "reviewable", reviewedBy: ["from-the-future"] })).toEqual({
      authority: "reviewable",
      reviewedBy: ["from-the-future"],
    });
  });
});

describe("authorityDeclarationFor — which source decides", () => {
  const hook = { name: "guard", authority: "reviewable" as const, reviewedBy: ["secret-exposure"] };

  it("takes a local policy file's own declaration", () => {
    expect(authorityDeclarationFor(hook, {})).toEqual({ authority: "reviewable", reviewedBy: ["secret-exposure"] });
  });

  it("takes the CLOUD ARTIFACT's declaration, never the code's", () => {
    expect(authorityDeclarationFor(hook, { cloudManaged: {} })).toEqual({
      authority: undefined,
      reviewedBy: undefined,
    });
    expect(
      authorityDeclarationFor({ name: "guard" }, {
        cloudManaged: { authority: "reviewable", reviewedBy: ["database-destruction"] },
      }),
    ).toEqual({ authority: "reviewable", reviewedBy: ["database-destruction"] });
  });

  it("takes the PACK MANIFEST's entry for that name, never the code's", () => {
    const policies = [
      { name: "guard", authority: "hard" },
      { name: "other", authority: "reviewable", reviewedBy: ["system-modification"] },
    ] as unknown as PolicyCatalogEntry[];
    expect(authorityDeclarationFor(hook, { pack: { policies } })).toEqual({ authority: "hard", reviewedBy: undefined });
    expect(authorityDeclarationFor({ name: "other" }, { pack: { policies } })).toEqual({
      authority: "reviewable",
      reviewedBy: ["system-modification"],
    });
  });

  it("gives an artifact-only (undeclared) pack policy nothing to be reviewable with", () => {
    const decl = authorityDeclarationFor(hook, { pack: { policies: [] } });
    expect(resolvePolicyAuthority(decl)).toEqual({ authority: "hard" });
  });

  it("lets a cloud assignment win over a pack when a hook somehow carries both", () => {
    const policies = [{ name: "guard", authority: "reviewable", reviewedBy: ["secret-exposure"] }] as never;
    expect(authorityDeclarationFor(hook, { cloudManaged: {}, pack: { policies } })).toEqual({
      authority: undefined,
      reviewedBy: undefined,
    });
  });
});

describe("parsePackPolicy — authority fields", () => {
  const base = {
    name: "block-prod-deploy",
    description: "d",
    category: "Ops",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
  };

  it("returns an entry with no authority fields untouched", () => {
    expect(parsePackPolicy("acme/ops", base, 0)).toBe(base);
  });

  it("keeps valid fields where they were", () => {
    const raw = { ...base, authority: "reviewable", reviewedBy: ["production-infra-change"] };
    const parsed = parsePackPolicy("acme/ops", raw, 0);
    expect(parsed.authority).toBe("reviewable");
    expect(parsed.reviewedBy).toEqual(["production-infra-change"]);
    expect(Object.keys(parsed)).toEqual(Object.keys(raw));
  });

  it("drops an invalid field instead of refusing the pack", () => {
    // Refusing would fail the pack closed — a machine-wide deny over an
    // optional field. Dropping it makes this one policy hard.
    const parsed = parsePackPolicy(
      "acme/ops",
      { ...base, authority: "always", reviewedBy: "production-infra-change" },
      0,
    );
    expect("authority" in parsed).toBe(false);
    expect("reviewedBy" in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual(Object.keys(base));
    expect(resolvePolicyAuthority(parsed).authority).toBe("hard");
  });

  it("still refuses alwaysOn, whatever the authority says", () => {
    expect(() =>
      parsePackPolicy("acme/ops", { ...base, alwaysOn: true, authority: "reviewable", reviewedBy: ["x"] }, 0),
    ).toThrow(/alwaysOn/);
  });
});
