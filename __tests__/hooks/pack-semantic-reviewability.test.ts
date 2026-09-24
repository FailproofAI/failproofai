// @vitest-environment node
/**
 * The diagnostic has to count against the set the machine can actually ask.
 *
 * A pack that ships both tiers replaces the compiled-in semantic set where it
 * installs, so its regex policies name its OWN checks in `reviewedBy`. Counted
 * against this build's sixteen, every one of those names is "a check this build
 * does not have" — so `jev status` would say "0 of 38 enabled policies are
 * reviewable" and point at the remedy, on exactly the machines that already took
 * it. A diagnostic that lies on the state it was written for is worse than no
 * diagnostic: it sends people to re-take a pack they are already running.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countReviewable, reviewableProblem, reviewableSummary, surveyReviewableCoverage } from "@/src/hooks/policy-reviewability";
import { SEMANTIC_REVIEWER_NAMES } from "@/src/hooks/policy-authority";
import { forgetEffectiveReviewerNames } from "@/src/hooks/effective-reviewers";

const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR"] as const;

const SEMANTIC = {
  name: "pack-destructive-deletion",
  title: "Deleted something irreplaceable",
  appliesTo: ["shell"],
  mode: "deny",
  userCanOverride: true,
  probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
  guidance: "g",
};

const regex = (over: Record<string, unknown> = {}) => ({
  name: "block-refunds",
  description: "d",
  category: "Finance",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  ...over,
});

let home: string;
let project: string;
let packRoot: string;
let cloudRoot: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-packrev-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-packrev-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-packrev-packs-"));
  cloudRoot = mkdtempSync(join(tmpdir(), "fpai-packrev-cloud-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  writeFileSync(join(home, "policies-config.json"), JSON.stringify({ enabledPolicies: [] }));
  forgetEffectiveReviewerNames();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [home, project, packRoot, cloudRoot]) rmSync(dir, { recursive: true, force: true });
  forgetEffectiveReviewerNames();
});

function installPack(policies: Array<Record<string, unknown>>, semantic?: Array<Record<string, unknown>>): void {
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
          id: "FailproofAI/jev-policies",
          version: "0.2.0",
          source: "github:FailproofAI/jev-policies@v0.2.0",
          entry: `artifacts/${digest}.mjs`,
          sha256: digest,
          policies,
          ...(semantic ? { semantic } : {}),
        },
      ],
    }),
  );
  forgetEffectiveReviewerNames();
}

describe("countReviewable with an explicit reviewer set", () => {
  it("counts a name the set has", () => {
    const names = new Set(["pack-destructive-deletion"]);
    expect(countReviewable([{ authority: "reviewable", reviewedBy: ["pack-destructive-deletion"] }], names)).toEqual({
      enabled: 1,
      reviewable: 1,
    });
  });

  it("counts the same name as hard against this build's set", () => {
    expect(SEMANTIC_REVIEWER_NAMES.has("pack-destructive-deletion")).toBe(false);
    expect(countReviewable([{ authority: "reviewable", reviewedBy: ["pack-destructive-deletion"] }])).toEqual({
      enabled: 1,
      reviewable: 0,
    });
  });

  it("still requires EVERY name, because reviewedBy is a conjunction", () => {
    const names = new Set(["pack-destructive-deletion"]);
    expect(
      countReviewable([{ authority: "reviewable", reviewedBy: ["pack-destructive-deletion", "typo"] }], names),
    ).toEqual({ enabled: 1, reviewable: 0 });
  });
});

describe("surveyReviewableCoverage on a machine running a two-tier pack", () => {
  it("reports the pack's own reviewers as clears, not as zero", () => {
    installPack(
      [
        regex({ authority: "reviewable", reviewedBy: ["pack-destructive-deletion"] }),
        regex({ name: "require-note" }),
      ],
      [SEMANTIC],
    );
    // Three enabled: the pack's two, plus the compiled-in `alwaysOn`
    // self-protection guard, which registers always and is hard always — so it
    // can only ever lower this ratio.
    const coverage = surveyReviewableCoverage(project);
    expect(coverage.enabled).toBe(3);
    expect(coverage.reviewable).toBe(1);
    expect(reviewableSummary(coverage)).toContain("1 of 3 enabled policies are reviewable");
    // And no remedy is offered, because there is nothing wrong here.
    expect(reviewableProblem(coverage)).toBeNull();
  });

  it("counts a builtin name as hard once a pack has replaced the semantic set", () => {
    // Not a nicety: that question will never be asked on this machine, so a
    // clear counted for it is a clear that cannot happen.
    installPack([regex({ authority: "reviewable", reviewedBy: ["secret-exposure"] })], [SEMANTIC]);
    const coverage = surveyReviewableCoverage(project);
    expect(coverage).toEqual({ enabled: 2, reviewable: 0, customFiles: 0 });
    expect(reviewableProblem(coverage)).toContain("it can never clear one");
  });

  it("keeps counting against this build's set for a pack with no semantic entries", () => {
    installPack([regex({ authority: "reviewable", reviewedBy: ["secret-exposure"] })]);
    expect(surveyReviewableCoverage(project).reviewable).toBe(1);
  });

  it("ignores the pack's `enabled` narrowing when collecting reviewers", () => {
    // `enabled` selects which REGEX policies register; a pack's semantic set is
    // not selectable, so narrowing must not make its reviewers disappear.
    installPack(
      [regex({ authority: "reviewable", reviewedBy: ["pack-destructive-deletion"] }), regex({ name: "require-note" })],
      [SEMANTIC],
    );
    const manifestPath = join(packRoot, "installed.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { packs: Array<Record<string, unknown>> };
    manifest.packs[0].enabled = ["block-refunds"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    forgetEffectiveReviewerNames();

    const coverage = surveyReviewableCoverage(project);
    expect(coverage).toEqual({ enabled: 2, reviewable: 1, customFiles: 0 });
  });
});
