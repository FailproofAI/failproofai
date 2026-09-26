// @vitest-environment node
/**
 * The rule that decides which semantic policy set a machine asks Jev about.
 *
 * The replacement rule is the load-bearing half: a pack that declares at least
 * one `semantic` entry replaces the compiled-in set WHOLESALE, mirroring the rule
 * already in force for the regex builtins. Anything softer — merging, or
 * preferring one on a name collision — means two question sets can both claim
 * `destructive-deletion`, and a `reviewedBy` naming it would mean different
 * things on two machines.
 */
import { describe, expect, it } from "vitest";
import { parsePackSemanticPolicy, type SemanticManifestEntry } from "@/src/hooks/pack-manifest";
import { SEMANTIC_POLICIES } from "@/src/hooks/semantic/policies";
import {
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

describe("semanticPoliciesFromPacks — the replacement rule", () => {
  it("returns the compiled-in set, by identity, when no pack declares any", () => {
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [])]);
    expect(resolved.policies).toBe(SEMANTIC_POLICIES);
    expect(resolved.fromPack).toBe(false);
    expect(resolved.errors).toEqual([]);
  });

  it("returns the compiled-in set when there are no packs at all", () => {
    expect(semanticPoliciesFromPacks([]).policies).toBe(SEMANTIC_POLICIES);
  });

  it("replaces the compiled-in set wholesale once one pack declares any", () => {
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [manifestEntry()])]);
    expect(resolved.fromPack).toBe(true);
    expect(resolved.policies.map((p) => p.name)).toEqual(["destructive-deletion"]);
    // Not merged: the other fifteen builtins are gone, so no name can be claimed
    // twice and a `reviewedBy` cannot mean two things.
    expect(resolved.policies).toHaveLength(1);
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

  it("falls back to the compiled-in set when the contest leaves nothing", () => {
    // The same rule as the unusable-entry case below, and it matters that the two
    // agree: `effectiveReviewerNames` falls back in this state too, so the names
    // a `reviewedBy` may use are the names of the questions being asked.
    const resolved = semanticPoliciesFromPacks([
      pack("acme/guards", [manifestEntry()]),
      pack("evil/extra", [manifestEntry({ guidance: "Nothing to see here." })]),
    ]);
    expect(resolved.policies).toBe(SEMANTIC_POLICIES);
    expect(resolved.fromPack).toBe(false);
  });

  it("falls back to the compiled-in set when every declared entry was unusable", () => {
    // Honest (it is what the machine ran yesterday) and safe: what a pack's regex
    // half names in `reviewedBy` will not match the builtin set, so those
    // policies stay hard rather than being cleared by questions nobody validated.
    const broken = { ...manifestEntry(), precondition: "on_a_tuesday" } as SemanticManifestEntry;
    const resolved = semanticPoliciesFromPacks([pack("acme/guards", [broken])]);
    expect(resolved.policies).toBe(SEMANTIC_POLICIES);
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
