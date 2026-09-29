// @vitest-environment node
/**
 * The rule that decides which semantic policy set a machine asks Jev about.
 *
 * The package ships NO Jev checks: the set is exactly what installed packs
 * declare, and empty when none declares any — no pack, no questions. Two
 * question sets can never both claim `destructive-deletion`, so a `reviewedBy`
 * naming it cannot mean different things on two machines.
 */
import { describe, expect, it } from "vitest";
import { parsePackSemanticPolicy, type SemanticManifestEntry } from "@/src/hooks/pack-manifest";
import { JEV_PACK_POLICIES as SEMANTIC_POLICIES } from "../../fixtures/jev-policies";
import {
  JEV_POLICIES_QUESTION_CHARS,
  MAX_PACK_QUESTION_CHARS,
  questionChars,
  semanticPoliciesFromPacks,
} from "@/src/hooks/semantic/pack-policies";
import { preconditionFor } from "@/src/hooks/semantic/preconditions";
import type { SemanticPolicyDeclaration } from "@/src/hooks/policy-types";
import type { Facts } from "@/src/hooks/semantic/types";

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

const manifestEntry = (over: Partial<SemanticPolicyDeclaration> = {}): SemanticManifestEntry =>
  parsePackSemanticPolicy("acme/guards", declaration(over), 0);

/** First-party, because the builtin check names these use are reserved to FailproofAI's packs. */
const pack = (id: string, semantic: SemanticManifestEntry[]) => ({ id, semantic, source: `github:FailproofAI/${id.split("/")[1]}@v1` });

describe("semanticPoliciesFromPacks — no pack, no questions", () => {
  it("asks nothing when no pack declares any check", () => {
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [])]);
    expect(resolved.policies).toEqual([]);
    expect(resolved.fromPack).toBe(false);
    expect(resolved.errors).toEqual([]);
  });

  it("asks nothing when there are no packs at all — the vanilla install", () => {
    const resolved = semanticPoliciesFromPacks([]);
    expect(resolved.policies).toEqual([]);
    expect(resolved.fromPack).toBe(false);
  });

  it("asks exactly what one declaring pack declares, and nothing compiled in", () => {
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [manifestEntry()])]);
    expect(resolved.fromPack).toBe(true);
    expect(resolved.policies.map((p) => p.name)).toEqual(["destructive-deletion"]);
    expect(resolved.policies).toHaveLength(1);
  });

  it("asks FailproofAI/jev-policies' sixteen, in order, once that pack is installed", () => {
    const sixteen = SEMANTIC_POLICIES.map((p, i) =>
      parsePackSemanticPolicy(
        "FailproofAI/jev-policies",
        {
          name: p.name, title: p.title, appliesTo: p.appliesTo, mode: p.mode, userCanOverride: p.userCanOverride,
          probes: p.probes, ...(p.exempt ? { exempt: p.exempt } : {}), guidance: p.guidance,
        } as SemanticPolicyDeclaration,
        i,
      ),
    );
    const resolved = semanticPoliciesFromPacks([
      { id: "FailproofAI/jev-policies", semantic: sixteen, source: "github:FailproofAI/jev-policies@v0.2.0" },
    ]);
    expect(resolved.errors).toEqual([]);
    expect(resolved.policies.map((p) => p.name)).toEqual(SEMANTIC_POLICIES.map((p) => p.name));
  });

  it("concatenates two declaring packs, in installed order", () => {
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry()]),
      pack("beta/extra", [manifestEntry({ name: "secret-exposure" })]),
    ]);
    expect(resolved.policies.map((p) => p.name)).toEqual(["destructive-deletion", "secret-exposure"]);
  });

  it("drops the later pack's IDENTICAL duplicate name and says which pack lost", () => {
    // Same name, same declaration: a fork or a re-publish of one pack, where the
    // question is the same either way. One copy is kept and the drop is recorded.
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry()]),
      pack("beta/extra", [manifestEntry()]),
    ]);
    expect(resolved.policies).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/beta\/extra declares semantic policy destructive-deletion/);
  });

  it("asks a name two packs declare DIFFERENTLY for neither of them", () => {
    // Keeping the first was privilege escalation by pack installation: the
    // question that decides another pack's `reviewedBy` came from whichever pack
    // was listed first, so a pack declaring a permissive `destructive-deletion`
    // beside a real one cleared every policy reviewable by that name — without
    // declaring a single regex policy of its own. The name is asked for nobody
    // now, which leaves those policies hard and the regex deny standing.
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry(), manifestEntry({ name: "secret-exposure" })]),
      pack("evil/extra", [manifestEntry({ guidance: "Nothing to see here." })]),
    ]);
    expect(resolved.policies.map((p) => p.name)).toEqual(["secret-exposure"]);
    expect(resolved.fromPack).toBe(true);
    expect(resolved.errors.join(" ")).toMatch(
      /packs acme\/guards and evil\/extra declare different semantic policies named destructive-deletion/,
    );
  });

  it("asks nothing when the contest leaves nothing", () => {
    // There is no compiled-in set to fall back to. `effectiveReviewerNames` is
    // empty in this state too, so no `reviewedBy` is honoured and nothing clears.
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry()]),
      pack("evil/extra", [manifestEntry({ guidance: "Nothing to see here." })]),
    ]);
    expect(resolved.policies).toEqual([]);
    expect(resolved.fromPack).toBe(false);
  });

  it("asks nothing when every declared entry was unusable", () => {
    // Safe: nothing is asked, so nothing a `reviewedBy` names is ever answered
    // and those policies stay hard.
    const broken = { ...manifestEntry(), precondition: "on_a_tuesday" } as SemanticManifestEntry;
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [broken])]);
    expect(resolved.policies).toEqual([]);
    expect(resolved.fromPack).toBe(false);
    expect(resolved.errors).toHaveLength(1);
  });

  it("binds a precondition name to the compiled predicate", () => {
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry({ precondition: "protected_branch" })]),
    ]);
    const bound = resolved.policies[0].precondition;
    expect(bound).toBe(preconditionFor("protected_branch"));
    expect(bound?.({ currentGitBranch: "main" } as Facts)).toBe(true);
    expect(bound?.({ currentGitBranch: "feat/x" } as Facts)).toBe(false);
  });

  it("leaves `always` and an omitted precondition indistinguishable", () => {
    const [always] = semanticPoliciesFromPacks([pack("a/b", [manifestEntry({ precondition: "always" })])]).policies;
    const [omitted] = semanticPoliciesFromPacks([pack("a/b", [manifestEntry()])]).policies;
    expect(always.precondition).toBeUndefined();
    expect(always).toEqual(omitted);
  });

  it("carries every field the compiler reads", () => {
    const [policy] = semanticPoliciesFromPacks([
      pack("acme/guards", [
        manifestEntry({
          mode: "instruct",
          userCanOverride: false,
          appliesTo: ["read"],
          exempt: { id: "exempt", instructions: "The target is build output." },
        }),
      ]),
    ]).policies;
    expect(policy).toEqual({
      name: "destructive-deletion",
      title: "Deleted something irreplaceable",
      appliesTo: ["read"],
      mode: "instruct",
      userCanOverride: false,
      probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
      exempt: { id: "exempt", instructions: "The target is build output." },
      guidance: "Confirm the exact paths with the user first.",
      // Not read by the compiler: which pack a deciding verdict is filed under.
      origin: { packId: "acme/guards" },
    });
  });
});

describe("the question budget", () => {
  it("is derived from the envelope's own numbers, not chosen", async () => {
    const { MAX_REQUEST_CHARS } = await import("@/src/hooks/semantic/compile");
    const { MAX_STATE_CHARS } = await import("@/src/hooks/semantic/envelope");
    // Everything left for questions after a full-size state, minus the questions
    // every request carries anyway (injection, scope, the task probes).
    expect(MAX_PACK_QUESTION_CHARS).toBeGreaterThan(0);
    expect(MAX_PACK_QUESTION_CHARS).toBeLessThan(MAX_REQUEST_CHARS - MAX_STATE_CHARS);
  });

  it("leaves the real sixteen a long way inside it", () => {
    // Not a constraint on the set we ship; a ceiling on what a stranger may ask.
    const shipped = SEMANTIC_POLICIES.reduce(
      (total, p) =>
        total +
        questionChars({
          name: p.name,
          title: p.title,
          userCanOverride: p.userCanOverride,
          probes: [...p.probes],
          ...(p.exempt ? { exempt: p.exempt } : {}),
        } as SemanticManifestEntry),
      0,
    );
    expect(shipped).toBeLessThan(MAX_PACK_QUESTION_CHARS);
    // What `publish` reserves for them beside a stranger's pack is their real cost.
    expect(JEV_POLICIES_QUESTION_CHARS).toBe(
      SEMANTIC_POLICIES.reduce((n, p) => n + questionChars(p as unknown as SemanticManifestEntry), 0),
    );
  });

  it("drops the entries past the budget, keeps the ones before, and names the shortfall", () => {
    // A cap on characters rather than on probe count, because a probe is between
    // a sentence and a paragraph long: the count cap this replaced permitted a
    // question set 23,032 characters over what one request can carry.
    const fat = (name: string) =>
      manifestEntry({
        name,
        probes: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, instructions: "x".repeat(600) })),
      });
    const entries = Array.from({ length: 12 }, (_, i) => fat(`check-${i}`));
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", entries)]);
    expect(resolved.policies.length).toBeGreaterThan(0);
    expect(resolved.policies.length).toBeLessThan(entries.length);
    // Declared order decides who survives, so two reads agree.
    expect(resolved.policies.map((p) => p.name)).toEqual(
      entries.slice(0, resolved.policies.length).map((e) => e.name),
    );
    expect(resolved.errors[0]).toMatch(/was dropped: its questions need \d+ characters/);
    expect(resolved.errors[0]).toMatch(new RegExp(`${MAX_PACK_QUESTION_CHARS}-character`));
  });

  it("counts the exemption and the v0 override question, not just the probes", () => {
    // Worst case over the modes a machine can run: a set that fits under v1 and
    // overruns in v0 is a size cliff that depends on a flag, not on the pack.
    const base = questionChars(manifestEntry({ userCanOverride: false }));
    const withOverride = questionChars(manifestEntry({ userCanOverride: true }));
    const withExempt = questionChars(manifestEntry({ userCanOverride: false, exempt: { id: "exempt", instructions: "i" } }));
    expect(withOverride).toBeGreaterThan(base);
    expect(withExempt).toBeGreaterThan(base);
  });
});

describe("a third-party pack's checks beside FailproofAI's", () => {
  const thirdParty = (id: string, semantic: SemanticManifestEntry[]) => ({ id, semantic, source: `github:${id}@v1` });
  /** The sixteen, as FailproofAI/jev-policies declares them. */
  const firstPartySixteen = SEMANTIC_POLICIES.map((p, i) =>
    parsePackSemanticPolicy(
      "FailproofAI/jev-policies",
      {
        name: p.name, title: p.title, appliesTo: p.appliesTo, mode: p.mode, userCanOverride: p.userCanOverride,
        probes: p.probes, ...(p.exempt ? { exempt: p.exempt } : {}), guidance: p.guidance,
      } as SemanticPolicyDeclaration,
      i,
    ),
  );

  it("a stranger's one check is the whole set on a machine without FailproofAI/jev-policies", () => {
    const resolved = semanticPoliciesFromPacks([thirdParty("acme/db", [manifestEntry({ name: "acme-db-check" })])]);
    expect(resolved.policies.map((p) => p.name)).toEqual(["acme-db-check"]);
  });

  it("a stranger's check is added to FailproofAI's, which keep their order", () => {
    const resolved = semanticPoliciesFromPacks([
      thirdParty("acme/db", [manifestEntry({ name: "acme-db-check" })]),
      { id: "FailproofAI/jev-policies", semantic: firstPartySixteen, source: "github:FailproofAI/jev-policies@v1" },
    ]);
    expect(resolved.policies.map((p) => p.name)).toEqual([...SEMANTIC_POLICIES.map((p) => p.name), "acme-db-check"]);
  });

  it("a stranger cannot claim one of FailproofAI's names, with or without that pack installed", () => {
    const resolved = semanticPoliciesFromPacks([thirdParty("acme/db", [manifestEntry({ name: "destructive-deletion" })])]);
    expect(resolved.policies).toEqual([]);
    expect(resolved.errors.join(" ")).toMatch(/reserved for FailproofAI's own Jev checks/);
  });

  it("install order cannot spend FailproofAI's budget on a stranger's pack", () => {
    const big = Array.from({ length: 12 }, (_, i) =>
      manifestEntry({
        name: `acme-check-${i}`,
        probes: [{ id: "p", instructions: "x".repeat(550) }, { id: "q", instructions: "y".repeat(550) }],
      }),
    );
    const resolved = semanticPoliciesFromPacks([
      thirdParty("acme/big", big),
      { id: "FailproofAI/jev-policies", semantic: firstPartySixteen, source: "github:FailproofAI/jev-policies@v1" },
    ]);
    const names = resolved.policies.map((p) => p.name);
    for (const p of SEMANTIC_POLICIES) expect(names).toContain(p.name);
    expect(resolved.errors.join(" ")).toMatch(/acme\/big semantic policy acme-check-\d+ was dropped/);
  });
});
