// @vitest-environment node
/**
 * Policy authority: who has the last word on a policy's verdict once Jev is
 * configured. Every assertion here is about the DEFAULT — anything that is not
 * a clean, complete `reviewable` declaration must come out `hard`, because an
 * authority that silently widened would let Jev clear a deny its author never
 * agreed to hand over.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { effectiveAuthority } from "../../src/hooks/policy-types";
import {
  SEMANTIC_POLICY_NAMES,
  SEMANTIC_REVIEWER_NAMES,
  authorityDeclarationFor,
  authorityFieldsOf,
  authorityProblem,
  manifestAuthority,
  type AuthorityFields,
  resolvePolicyAuthority,
  warnAuthority,
  withMergedAuthority,
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
    ["reviewable with only malformed entries", { authority: "reviewable", reviewedBy: ["", 7, null] }],
  ])("is hard for %s", (_label, decl) => {
    expect(effectiveAuthority(decl as never)).toBe("hard");
  });

  it("is hard for alwaysOn, even with a complete reviewable declaration", () => {
    expect(
      effectiveAuthority({ authority: "reviewable", reviewedBy: ["agent-config-tampering"], alwaysOn: true }),
    ).toBe("hard");
  });

  it("keeps the §7 contract: one usable name is enough, malformed entries are skipped", () => {
    // T3's `authorityOf` is built on exactly this, and filters the list itself.
    // The stricter every-entry rule belongs to REGISTRATION (resolvePolicyAuthority
    // below), which is what the registry stores.
    expect(effectiveAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure", "", 7] } as never)).toBe(
      "reviewable",
    );
    expect(effectiveAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure", 5] } as never)).toBe(
      "reviewable",
    );
    expect(effectiveAuthority({ authority: "reviewable", reviewedBy: ["", "secret-exposure"] })).toBe("reviewable");
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

  it("is a literal list, so the registry never loads Jev's prompts at runtime", () => {
    // policy-registry imports policy-authority. A runtime import of
    // semantic/policies from here put all sixteen prompts on every hook event
    // and into every pack artifact that registers a policy.
    const src = readFileSync(resolve(__dirname, "../../src/hooks/policy-authority.ts"), "utf8");
    const runtimeSemantic = [...src.matchAll(/^import (type )?[^;]*from "\.\/semantic\/[^"]+";/gm)].filter(
      (m) => m[1] !== "type ",
    );
    expect(runtimeSemantic.map((m) => m[0])).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["']\.\/semantic\//);
    expect([...SEMANTIC_POLICY_NAMES]).toEqual(SEMANTIC_POLICIES.map((p) => p.name));
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

  it.each([
    ["a malformed entry", ["secret-exposure", 5]],
    ["an empty-string entry", ["", "secret-exposure"]],
    ["both", ["secret-exposure", "", 7]],
    ["a null entry", ["secret-exposure", null]],
  ])("refuses a reviewedBy with %s, which the §7 contract alone would accept", (_label, reviewedBy) => {
    // Registration is the strict half: skipping the stray entry would let Jev
    // clear the policy on fewer checks than its author wrote down.
    const decl = { authority: "reviewable", reviewedBy };
    expect(effectiveAuthority(decl as never)).toBe("reviewable");
    const r = resolvePolicyAuthority(decl);
    expect(r).toEqual({ authority: "hard", downgraded: "reviewedBy is not a list of semantic policy names" });
  });

  it("never throws on an entry that cannot be printed", () => {
    // A user's own policy file can put anything in the list.
    const odd = [Object.create(null), BigInt(1), Symbol("x"), () => 1];
    for (const entry of odd) {
      expect(resolvePolicyAuthority({ authority: "reviewable", reviewedBy: ["secret-exposure", entry] }).authority).toBe(
        "hard",
      );
      expect(() => authorityProblem({ authority: "reviewable", reviewedBy: [entry] })).not.toThrow();
      expect(() => authorityProblem({ authority: entry })).not.toThrow();
    }
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
    ["one malformed entry beside a real name", { authority: "reviewable", reviewedBy: ["secret-exposure", 7] }],
    ["an empty-string entry beside a real name", { authority: "reviewable", reviewedBy: ["secret-exposure", ""] }],
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

describe("withMergedAuthority — several declarations, one registration", () => {
  /** A record the way the loader has them: other fields beside the two authority ones. */
  type Rec = { id: string } & AuthorityFields;
  const R = (...reviewedBy: string[]): AuthorityFields => ({ authority: "reviewable", reviewedBy });
  const H: AuthorityFields = { authority: "hard" };

  it("is reviewable only when every declaration is, through the union of their checks", () => {
    const a: Rec = { id: "a", ...R("database-destruction") };
    const { merged, overruled } = withMergedAuthority(a, [a, R("secret-exposure", "database-destruction")]);
    expect(merged).toEqual({ id: "a", authority: "reviewable", reviewedBy: ["database-destruction", "secret-exposure"] });
    expect(overruled).toBe(false);
  });

  it.each([
    ["an explicit hard", H],
    ["no declaration at all", {}],
    ["a refused reviewable", R("not-a-check")],
  ])("leans toward hard against %s, whichever order they come in", (_label, other: AuthorityFields) => {
    const reviewable: Rec = { id: "r", ...R("database-destruction") };
    const otherRecord: Rec = { id: "o", ...other };
    const cases: Array<[Rec, Rec[]]> = [
      [reviewable, [reviewable, otherRecord]],
      [reviewable, [otherRecord, reviewable]],
      [otherRecord, [reviewable, otherRecord]],
      [otherRecord, [otherRecord, reviewable]],
    ];
    for (const [record, decls] of cases) {
      const { merged } = withMergedAuthority(record, decls);
      expect(resolvePolicyAuthority(merged).authority).toBe("hard");
      expect(merged.id).toBe(record.id);
    }
  });

  it("hands back the refusal rather than the declaration that was refused", () => {
    // It used to copy the raw declaration forward so that registration would
    // report it, and that was the hole: a declaration is only ever refused
    // relative to a reviewer SET, so one naming a pack's own check resolved hard
    // here, against the builtins, and then reviewable at registration, against
    // the pack's. The merged record now carries the resolution — `hard`, and no
    // `reviewedBy` for anything to re-read — and the reason comes back beside it.
    const typo = R("databse-destruction");
    const { merged, overruled, refused } = withMergedAuthority<Rec>({ id: "x", ...R("database-destruction") }, [
      R("database-destruction"),
      typo,
    ]);
    expect(merged).toEqual({ id: "x", authority: "hard" });
    expect(resolvePolicyAuthority(merged).authority).toBe("hard");
    expect(refused).toMatch(/"databse-destruction"/);
    expect(overruled).toBe(true);
  });

  it("judges the declarations against the reviewer set it is given, not this build's", () => {
    // The shipped pairing: the regex policies name checks that live in another
    // pack, so the names in `reviewedBy` are in neither `SEMANTIC_POLICY_NAMES`
    // nor this build's set. Without the set, both declarations below resolve
    // hard, the merge cannot tell them apart, and the reviewable one wins by
    // being first — which registration then honours.
    const packCheck = new Set(["production-infra-change-v2"]);
    const reviewable: Rec = { id: "r", authority: "reviewable", reviewedBy: ["production-infra-change-v2"] };
    for (const decls of [
      [reviewable, H],
      [H, reviewable],
    ]) {
      const { merged, overruled } = withMergedAuthority<Rec>(reviewable, decls, packCheck);
      expect(merged).toEqual({ id: "r", authority: "hard" });
      expect(overruled).toBe(true);
    }
    // And still reviewable when both packs behind the artifact say so.
    const both = withMergedAuthority<Rec>(reviewable, [reviewable, reviewable], packCheck);
    expect(both.merged).toEqual({ id: "r", authority: "reviewable", reviewedBy: ["production-infra-change-v2"] });
    expect(both.overruled).toBe(false);
  });

  it("drops the fields entirely when the hard vote declared nothing", () => {
    const { merged, overruled } = withMergedAuthority<Rec>({ id: "x", ...R("secret-exposure") }, [
      R("secret-exposure"),
      {},
    ]);
    expect(merged).toEqual({ id: "x" });
    expect(overruled).toBe(true);
  });

  it("hands back the record itself when nothing changes, and reports nothing overruled", () => {
    const plain: Rec = { id: "p" };
    expect(withMergedAuthority(plain, [plain, {}]).merged).toBe(plain);
    expect(withMergedAuthority(plain, [plain, {}]).overruled).toBe(false);
    const hard: Rec = { id: "h", ...H };
    expect(withMergedAuthority(hard, [hard, {}]).merged).toBe(hard);
  });
});

describe("authorityProblem / manifestAuthority — what a build may publish", () => {
  it("publishes a clean declaration as the registry will resolve it", () => {
    expect(manifestAuthority({ name: "p", authority: "reviewable", reviewedBy: ["secret-exposure", "secret-exposure"] }))
      .toEqual({ authority: "reviewable", reviewedBy: ["secret-exposure"] });
    expect(manifestAuthority({ name: "p", authority: "hard" })).toEqual({ authority: "hard" });
    expect(manifestAuthority({ name: "p" })).toEqual({ authority: "hard" });
    // An empty list on a hard policy says nothing, and is not a problem.
    expect(authorityProblem({ authority: "hard", reviewedBy: [] })).toBeUndefined();
  });

  it("refuses a reviewable declaration naming a check this build does not have, naming the policy", () => {
    // The guard build-policy-pack.mjs relies on for the core pack: it builds
    // every manifest entry's authority through this call.
    expect(() =>
      manifestAuthority({ name: "block-env-files", authority: "reviewable", reviewedBy: ["secret-exposure-v2"] }),
    ).toThrow(/^block-env-files: authority "reviewable" was refused — reviewedBy names "secret-exposure-v2"/);
  });

  it.each([
    ["a misspelled value", { authority: "Reviewable", reviewedBy: ["secret-exposure"] }, /authority must be "hard" or "reviewable", and is "Reviewable"/],
    ["a non-string value", { authority: 1 }, /authority must be "hard" or "reviewable", and is a number/],
    ["a string reviewedBy", { authority: "reviewable", reviewedBy: "secret-exposure" }, /reviewedBy must be a list/],
    ["a malformed entry", { authority: "hard", reviewedBy: ["secret-exposure", 3] }, /reviewedBy must be a list/],
    ["reviewable with nothing named", { authority: "reviewable" }, /was refused — reviewedBy does not name any/],
    ["reviewable on alwaysOn", { authority: "reviewable", reviewedBy: ["secret-exposure"], alwaysOn: true }, /was refused — it is alwaysOn/],
  ])("refuses %s", (_label, decl, message) => {
    expect(authorityProblem(decl)).toMatch(message);
    expect(() => manifestAuthority({ name: "p", ...decl })).toThrow(message);
  });
});

describe("warnAuthority — only where Jev can act on it, once", () => {
  let home: string;
  let saved: string | undefined;
  let stderr: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fpai-authority-warn-"));
    saved = process.env.FAILPROOFAI_HOME;
    process.env.FAILPROOFAI_HOME = home;
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it("says nothing without a Jev config, where authority decides nothing", () => {
    warnAuthority("unit: no jev config");
    expect(stderr.join("")).toBe("");
  });

  it("warns once per process once Jev is configured", () => {
    writeFileSync(join(home, "jev.json"), "{}", { mode: 0o600 });
    warnAuthority("unit: with jev config");
    warnAuthority("unit: with jev config");
    expect(stderr.join("").match(/unit: with jev config/g)).toHaveLength(1);
    warnAuthority("unit: a different message");
    expect(stderr.join("")).toMatch(/unit: a different message/);
  });

  it("does not use up the once when it stayed silent", () => {
    // A long-lived worker that starts before jev.json exists must still say it
    // once the file appears.
    warnAuthority("unit: before and after");
    writeFileSync(join(home, "jev.json"), "{}", { mode: 0o600 });
    warnAuthority("unit: before and after");
    expect(stderr.join("").match(/unit: before and after/g)).toHaveLength(1);
  });
});
