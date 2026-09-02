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
 * It also guards the two claims most likely to be caught out by a reader: that
 * the twelve are TWO classes (ten coding CLIs, two gateways) with the Python SDK
 * as a separate door rather than a third class, and that the SDK is never
 * described as carrying policies — it reports events, it does not sit in the
 * tool-call path, so it observes without enforcing.
 *
 * SCOPE: this repo only. The landing site (befailproof.ai) lives in a different
 * repo and carries the same counts in app/layout.js and app/llms.txt/route.js;
 * it needs its own check. See FailproofAI/agenteye#629.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
      harnesses: 16,
      // 39, not 40: `block-self-pause` and `block-failproofai-commands` are one
      // alwaysOn guard now — an agent that can disable either can disable
      // enforcement, so they were never two decisions.
      policies: 39,
      events: 29,
      preToolUseBlocks: 16,
      stopBlocks: 10,
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

  it("every translation link resolves to a file on disk", () => {
    // The bug this guards was a link pointing at a real file in the WRONG tree,
    // so "not docs-old" alone would not have caught a typo'd locale either.
    const links = [...read("README.md").matchAll(/\]\((\.\/docs\/i18n\/[^)]+)\)/g)].map(
      (m) => m[1],
    );
    expect(links.length).toBe(14);
    for (const href of links) {
      expect({ href, exists: existsSync(resolve(ROOT, href)) }).toEqual({ href, exists: true });
    }
  });

  it("README names every shipped harness, in the class it belongs to", () => {
    // The sixteen are TWO classes: fourteen coding CLIs and two gateways. The
    // Python SDK is a separate door, not a third class of the sixteen — and it
    // reports events rather than sitting in the tool-call path, so it observes
    // without enforcing. Copy that folds it in overstates what it does, which is
    // the single easiest way for a reader to catch us out.
    //
    // These two words are spelled out rather than derived from
    // INTEGRATION_TYPES.length on purpose: the point is that a HUMAN re-read the
    // opening paragraph, which is the first support statement anyone sees. A
    // computed count would keep this green while the surrounding prose rotted —
    // which is exactly what happened between the 12th and 16th integrations.
    const text = read("README.md");
    expect(text).toMatch(/Sixteen harnesses in two classes/);
    expect(text).toMatch(/fourteen coding CLIs/);
    expect(text).toMatch(/Hermes, OpenClaw/);
    // The SDK must never be described as carrying policies.
    const sdkClaim = /Python SDK[^.]*same polic/i;
    expect(sdkClaim.test(text)).toBe(false);
  });

  it("the harnesses page agrees with the source list, harness for harness", () => {
    const page = read("docs/reference/harnesses.mdx");
    const NAMES: Record<(typeof INTEGRATION_TYPES)[number], string> = {
      claude: "Claude Code",
      codex: "Codex",
      copilot: "GitHub Copilot CLI",
      cursor: "Cursor",
      opencode: "OpenCode",
      pi: "Pi",
      hermes: "Hermes",
      openclaw: "OpenClaw",
      factory: "Factory Droid",
      devin: "Devin CLI",
      antigravity: "Antigravity CLI",
      goose: "Goose",
      grok: "grok CLI",
      qwen: "Qwen Code",
      ori: "Ori",
      cline: "Cline",
    };
    // Adding an integration without documenting it is the drift this catches.
    expect(Object.keys(NAMES).sort()).toEqual([...INTEGRATION_TYPES].sort());
    for (const display of Object.values(NAMES)) expect(page).toContain(display);
  });

  it("the enforcement split stated in the docs matches the capability matrix", () => {
    // README and quickstart print these flat, without hedging, which is only
    // defensible because enforcement-capability.ts carries the probed version on
    // every row. If a re-probe moves a row, the prose has to move with it.
    const quickstart = read("docs/start/quickstart.mdx");
    expect(quickstart).toContain("verified on all 16");
    expect(TRUTH.preToolUseBlocks).toBe(16);
    expect(quickstart).toMatch(/verified on 10\b/);
    expect(TRUTH.stopBlocks).toBe(10);
  });
});
