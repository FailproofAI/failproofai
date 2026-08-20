// @vitest-environment node
/**
 * Drift guard for the NUMBERS AND HARNESS NAMES in user-facing prose.
 *
 * The positioning rewrite put four counts into copy read by nearly everyone who
 * meets this project — 12 harnesses, 40 built-in policies, 29 canonical events,
 * and blocking verified on 12/12 PreToolUse and 8/12 Stop. Those counts are only
 * worth printing flat, without hedging, because `enforcement-capability.ts` is a
 * machine-readable matrix with the probed version on every row. A stale count
 * turns that asset into a liability: an engineer who checks one number and finds
 * it wrong has a reason to discount the whole claim.
 *
 * This is not hypothetical. Before this file existed, README.md advertised "30
 * built-in policies" in three places and the landing site's schema.org block said
 * 39 — while the real count was 40, and had been for some time. Both were
 * hand-maintained, nothing read them, so both rotted silently. Same failure mode
 * __tests__/hooks/dogfood-configs.test.ts was written to catch for the dogfood
 * configs.
 *
 * SCOPE: this repo only. The landing site (befailproof.ai) lives in a different
 * repo and carries the same counts in app/layout.js and app/llms.txt/route.js;
 * it needs its own check. See FailproofAI/agenteye#629.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INTEGRATION_TYPES, HOOK_EVENT_TYPES } from "@/src/hooks/types";
import { ENFORCEMENT_CAPABILITY } from "@/src/hooks/enforcement-capability";
import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Every count asserted below, derived from source rather than restated. */
const TRUTH = {
  harnesses: INTEGRATION_TYPES.length,
  policies: BUILTIN_POLICIES.length,
  events: HOOK_EVENT_TYPES.length,
  preToolUseBlocks: INTEGRATION_TYPES.filter(
    (c) => ENFORCEMENT_CAPABILITY[c]?.PreToolUse === "block",
  ).length,
  stopBlocks: INTEGRATION_TYPES.filter((c) => ENFORCEMENT_CAPABILITY[c]?.Stop === "block").length,
};

/**
 * Files that state a count in prose a reader acts on. Deliberately short: this
 * guards the strings with the most readers, not every mention in the tree.
 */
const COPY_FILES = ["README.md", "package.json", "docs/index.mdx"];

describe("copy counts match source", () => {
  it("the derived counts are what the copy claims", () => {
    // Fails loudly if someone adds a harness or a policy without re-reading the
    // copy. Update this block ONLY together with every string it guards.
    expect(TRUTH).toEqual({
      harnesses: 12,
      policies: 40,
      events: 29,
      preToolUseBlocks: 12,
      stopBlocks: 8,
    });
  });

  it.each(COPY_FILES)("%s states no stale policy count", (file) => {
    const text = read(file);
    const claimed = [...text.matchAll(/(\d+)\s+built-in polic/gi)].map((m) => Number(m[1]));
    for (const n of claimed) expect(n).toBe(TRUTH.policies);
  });

  it.each(COPY_FILES)("%s states no stale harness count", (file) => {
    const text = read(file);
    const claimed = [...text.matchAll(/(\d+)\s+(?:agent\s+)?harness(?:es)?\b/gi)].map((m) =>
      Number(m[1]),
    );
    for (const n of claimed) expect(n).toBe(TRUTH.harnesses);
  });

  it("README names only harnesses that ship", () => {
    const text = read("README.md").toLowerCase();
    // Named on marketing surfaces but absent from INTEGRATION_TYPES. Keeping
    // them out of the README is what makes the harness list checkable.
    for (const absent of ["gemini cli", "langgraph", "deep agents"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("README names the two harnesses that prove the product is not coding-only", () => {
    // The whole positioning rests on the harness list spanning classes. Hermes
    // (Slack/Telegram gateway) and OpenClaw (self-hosted assistant) are the two
    // shipped integrations that were never coding tools; if a future edit drops
    // them from the hero, the breadth claim silently loses its evidence.
    const text = read("README.md").toLowerCase();
    expect(text).toContain("hermes");
    expect(text).toContain("openclaw");
  });

  it("the translated READMEs are linked from the tree the pipeline maintains", () => {
    // docs-old/i18n/ was frozen when the Mintlify site replaced it; the
    // translation workflow writes docs/i18n/. Linking the frozen copies means
    // non-English readers get a README that is never updated again.
    expect(read("README.md")).not.toContain("docs-old/i18n/");
  });
});
