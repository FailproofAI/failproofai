// @vitest-environment node
/**
 * The diagnostic that makes a silent two-tier evaluator audible.
 *
 * The state under test is the one an upgrade actually produces: the customer
 * installs this release, configures their own Jev key, and takes their policies
 * from a pack published BEFORE this release — which declares no `authority`,
 * because `scripts/build-policy-pack.mjs` is what writes that field and it
 * ships with this release. Every policy then resolves to `hard`, nothing was
 * downgraded so `warnAuthority` says nothing, and `combine.ts` returns early
 * for every one of them. Jev denies, Jev instructs, and Jev can never clear a
 * thing. Before this module nothing on any surface said so.
 *
 * So: a pack-shaped policy set with no authority fields must report zero-of-N
 * with the remedy, this build's builtins must report the fifteen Jev may clear,
 * and neither may change what any policy is allowed to do.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackPolicy } from "@/src/hooks/pack-manifest";
import { SEMANTIC_REVIEWER_NAMES, resolvePolicyAuthority } from "@/src/hooks/policy-authority";
import { POLICY_CATALOG } from "@/src/hooks/policy-catalog";
import {
  RETAKE_PACK_COMMAND,
  countReviewable,
  reviewableProblem,
  reviewableSummary,
  surveyReviewableCoverage,
} from "@/src/hooks/policy-reviewability";
import { effectiveAuthority } from "@/src/hooks/policy-types";

/** Every builtin a pack may carry: `alwaysOn` is refused in a pack manifest. */
const PACKABLE = POLICY_CATALOG.filter((p) => !p.alwaysOn);
/** The fifteen in this build; pinned by `policy-authority-table.test.ts` too. */
const REVIEWABLE_BUILTINS = POLICY_CATALOG.filter((p) => effectiveAuthority(p) === "reviewable");

/**
 * The core pack as it was published before this release: the same policies, put
 * through the real manifest parser, with the two authority fields never written.
 */
function packEntriesWithoutAuthority(): ReturnType<typeof parsePackPolicy>[] {
  return PACKABLE.map((p, i) => {
    const { authority: _a, reviewedBy: _r, ...rest } = p;
    return parsePackPolicy("FailproofAI/policies", { ...rest }, i);
  });
}

describe("counting what Jev may clear", () => {
  it("reports zero of N, and why, for a pack that declares no authority", () => {
    const entries = packEntriesWithoutAuthority();
    // The premise: the parser kept no authority field, from any of them.
    expect(entries.every((e) => !("authority" in e) && !("reviewedBy" in e))).toBe(true);

    const coverage = { ...countReviewable(entries), customFiles: 0 };
    expect(coverage).toEqual({ enabled: PACKABLE.length, reviewable: 0, customFiles: 0 });
    expect(reviewableSummary(coverage)).toBe(`0 of ${PACKABLE.length} enabled policies are reviewable.`);

    const problem = reviewableProblem(coverage);
    expect(problem).toContain("it can never clear one");
    expect(problem).toContain("published before this release carries no such marks");
    expect(problem).toContain(RETAKE_PACK_COMMAND);
  });

  it("reports the fifteen reviewable builtins, and diagnoses nothing", () => {
    const coverage = { ...countReviewable(POLICY_CATALOG), customFiles: 0 };
    expect(coverage.reviewable).toBe(15);
    expect(REVIEWABLE_BUILTINS.map((p) => p.name)).toEqual([
      // Catalog order. The nine after `block-read-outside-cwd` arrived with the pack
      // work; `block-sudo` and `block-curl-pipe-sh` pass the same pairing test and are
      // deliberately absent, being on by default with overridable reviewers.
      "protect-env-vars",
      "block-env-files",
      "block-read-outside-cwd",
      "block-rm-rf",
      "block-kubectl",
      "block-terraform",
      "block-aws-cli",
      "block-gcloud",
      "block-az-cli",
      "block-helm",
      "block-secrets-write",
      "block-force-push",
      "warn-git-amend",
      "warn-destructive-sql",
      "warn-global-package-install",
    ]);
    expect(reviewableSummary(coverage)).toBe(
      `15 of ${POLICY_CATALOG.length} enabled policies are reviewable: ` +
        "Jev may clear a deny or an instruction from those, and from no others.",
    );
    expect(reviewableProblem(coverage)).toBeNull();
  });

  it("counts by the authority a policy will REGISTER with, so a declaration that does not hold does not count", () => {
    // Each of these asks to be reviewable and is hard anyway: the
    // self-protection guard, an empty `reviewedBy`, and a `reviewedBy` that is
    // not a list of names. Both rules refuse all four.
    const wishful = [
      { authority: "reviewable", reviewedBy: ["secret-exposure"], alwaysOn: true },
      { authority: "reviewable", reviewedBy: [] },
      { authority: "reviewable", reviewedBy: "secret-exposure" },
      { authority: "reviewable" },
    ];
    expect(countReviewable(wishful)).toEqual({ enabled: 4, reviewable: 0 });
  });

  it("counts a reviewer this build does not have as hard, and says so", () => {
    // The case where the two rules disagree, and the only one that could make
    // this module lie: a pack built against a NEWER semantic set, where
    // `future-check` is a reviewer, installed on this build, where it is not.
    // `effectiveAuthority` — the §7 contract asked at EVALUATION time, of
    // records registration has already cleaned — sees one usable name and says
    // reviewable. `resolvePolicyAuthority`, which is what `registerPolicy`
    // stores, makes the whole declaration hard, because `reviewedBy` is a
    // conjunction and this build cannot ask that check at all. The count has to
    // follow registration: counting these as clears reports a clear that can
    // never happen, and silences the one diagnostic that would have explained
    // why `cleared` says `nothing` forever.
    const fromANewerPack = [
      { authority: "reviewable", reviewedBy: ["future-check"] },
      { authority: "reviewable", reviewedBy: ["secret-exposure", "future-check"] },
    ];
    expect(SEMANTIC_REVIEWER_NAMES.has("future-check")).toBe(false);
    expect(fromANewerPack.map((p) => effectiveAuthority(p))).toEqual(["reviewable", "reviewable"]);
    expect(fromANewerPack.map((p) => resolvePolicyAuthority(p).authority)).toEqual(["hard", "hard"]);

    const coverage = { ...countReviewable(fromANewerPack), customFiles: 0 };
    expect(coverage).toEqual({ enabled: 2, reviewable: 0, customFiles: 0 });
    expect(reviewableSummary(coverage)).toBe("0 of 2 enabled policies are reviewable.");
    expect(reviewableProblem(coverage)).toContain(RETAKE_PACK_COMMAND);
  });

  it("says there is nothing to clear, rather than blaming a pack, for an empty set", () => {
    const empty = { enabled: 0, reviewable: 0, customFiles: 0 };
    expect(reviewableSummary(empty)).toBe("No policies are enabled here, so there is nothing for Jev to clear.");
    expect(reviewableProblem(empty)).toBeNull();
  });

  it("admits the policies it did not read", () => {
    expect(reviewableSummary({ enabled: 4, reviewable: 0, customFiles: 2 })).toBe(
      "0 of 4 enabled policies are reviewable (policies from your own files are not counted).",
    );
    expect(reviewableSummary({ enabled: 1, reviewable: 1, customFiles: 1 })).toBe(
      "1 of 1 enabled policy is reviewable: Jev may clear a deny or an instruction from those, " +
        "and from no others (policies from your own files are not counted).",
    );
  });
});

describe("surveying a real machine", () => {
  const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR"] as const;
  let home: string;
  let project: string;
  let packRoot: string;
  let cloudRoot: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fpai-reviewability-home-"));
    // A directory with no `.failproofai/` anywhere above it, so the survey sees
    // the seeded global config and not this repo's own dogfood one.
    project = mkdtempSync(join(tmpdir(), "fpai-reviewability-project-"));
    packRoot = mkdtempSync(join(tmpdir(), "fpai-reviewability-packs-"));
    cloudRoot = mkdtempSync(join(tmpdir(), "fpai-reviewability-cloud-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.FAILPROOFAI_HOME = home;
    process.env.FAILPROOFAI_PACK_DIR = packRoot;
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const dir of [home, project, packRoot, cloudRoot]) rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(home, "policies-config.json"), JSON.stringify(config));
  }

  /** An installed pack, through the real manifest the loader verifies. */
  function installPack(policies: Array<Record<string, unknown>>, enabled?: string[]): void {
    const artifact = "// a pack artifact this test never executes\n";
    const digest = createHash("sha256").update(artifact).digest("hex");
    mkdirSync(join(packRoot, "artifacts"), { recursive: true });
    writeFileSync(join(packRoot, "artifacts", `${digest}.mjs`), artifact);
    writeFileSync(
      join(packRoot, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            id: "FailproofAI/policies",
            version: "0.9.0",
            source: "github:FailproofAI/policies@v0.9.0",
            entry: `artifacts/${digest}.mjs`,
            sha256: digest,
            policies,
            ...(enabled ? { enabled } : {}),
          },
        ],
      }),
    );
  }

  it("a pack from before this release: zero of N, with the remedy", () => {
    // The machine's own `enabledPolicies` is deliberately full: once a pack is
    // installed the migration shim stops registering builtins, so counting them
    // here would report fifteen clears that cannot happen.
    writeConfig({ enabledPolicies: POLICY_CATALOG.map((p) => p.name) });
    installPack(packEntriesWithoutAuthority() as unknown as Array<Record<string, unknown>>);

    const coverage = surveyReviewableCoverage(project);
    // The pack's policies, plus the one guard that ships compiled in and
    // registers whatever else is enabled.
    expect(coverage).toEqual({ enabled: PACKABLE.length + 1, reviewable: 0, customFiles: 0 });
    expect(reviewableSummary(coverage)).toContain(`0 of ${PACKABLE.length + 1} enabled policies are reviewable`);
    expect(reviewableProblem(coverage)).toContain(RETAKE_PACK_COMMAND);
  });

  it("a pack built by this release: the fifteen it marks, and no complaint", () => {
    writeConfig({ enabledPolicies: [] });
    installPack(PACKABLE as unknown as Array<Record<string, unknown>>);

    const coverage = surveyReviewableCoverage(project);
    expect(coverage).toEqual({ enabled: PACKABLE.length + 1, reviewable: 15, customFiles: 0 });
    expect(reviewableProblem(coverage)).toBeNull();
  });

  it("a pack built against a NEWER semantic set: hard here, with the remedy", () => {
    // Version skew in the other direction, end to end through the real
    // manifest parser (which keeps the names verbatim — whether a name is a
    // check is a property of the BUILD reading it). Registration will make
    // every one of these hard, so the count must say zero and the diagnostic
    // must fire: this is the machine whose `cleared` says `nothing` forever.
    writeConfig({ enabledPolicies: [] });
    installPack(
      PACKABLE.map((p) =>
        effectiveAuthority(p) === "reviewable" ? { ...p, reviewedBy: ["future-check"] } : p,
      ) as unknown as Array<Record<string, unknown>>,
    );

    const coverage = surveyReviewableCoverage(project);
    expect(coverage).toEqual({ enabled: PACKABLE.length + 1, reviewable: 0, customFiles: 0 });
    expect(reviewableProblem(coverage)).toContain(RETAKE_PACK_COMMAND);
  });

  it("counts only what a pack's owner actually took from it", () => {
    writeConfig({ enabledPolicies: [] });
    installPack(PACKABLE as unknown as Array<Record<string, unknown>>, ["block-sudo", "protect-env-vars"]);

    const coverage = surveyReviewableCoverage(project);
    // Two selected + the always-on guard; one of the two is reviewable.
    expect(coverage).toEqual({ enabled: 3, reviewable: 1, customFiles: 0 });
  });

  it("falls back to this build's builtins while no pack is installed", () => {
    writeConfig({ enabledPolicies: REVIEWABLE_BUILTINS.map((p) => p.name).concat("block-sudo") });

    const coverage = surveyReviewableCoverage(project);
    expect(coverage).toEqual({ enabled: 17, reviewable: 15, customFiles: 0 });
    expect(reviewableProblem(coverage)).toBeNull();
  });

  it("reads a cloud assignment's authority, which only the deployment decides", () => {
    writeConfig({ enabledPolicies: [] });
    const artifact = "// a cloud artifact this test never executes\n";
    const digest = createHash("sha256").update(artifact).digest("hex");
    writeFileSync(join(cloudRoot, `${digest}.mjs`), artifact);
    writeFileSync(
      join(cloudRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        deployment: 7,
        policies: [
          { id: "deploy-guard", version: 1, sha256: digest, path: `${digest}.mjs`, authority: "reviewable", reviewedBy: ["production-infra-change"] },
          { id: "audit-only", version: 1, sha256: digest, path: `${digest}.mjs` },
        ],
      }),
    );

    const coverage = surveyReviewableCoverage(project);
    // Two assignments + the always-on guard, one of them reviewable.
    expect(coverage).toEqual({ enabled: 3, reviewable: 1, customFiles: 0 });
  });

  it("counts the custom policy files it cannot read without running them", () => {
    writeConfig({ enabledPolicies: [], customPoliciesPaths: ["/nowhere/a.mjs", "/nowhere/b.mjs"] });
    expect(surveyReviewableCoverage(project).customFiles).toBe(2);
  });

  it("never throws on an unreadable machine, and reports what it could read", () => {
    writeFileSync(join(home, "policies-config.json"), "{ not json");
    writeFileSync(join(packRoot, "installed.json"), "{ not json");
    writeFileSync(join(cloudRoot, "active.json"), "{ not json");
    // The guard that ships compiled in is all that is left, and it is hard.
    expect(surveyReviewableCoverage(project)).toEqual({ enabled: 1, reviewable: 0, customFiles: 0 });
  });
});
