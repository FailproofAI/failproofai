/**
 * Unit tests for the weekly docs audit's analysis.
 *
 * Every detector is pinned in BOTH directions — it fires on the bad case and
 * stays silent on the good one. The second half matters as much as the first
 * here: this report's only failure mode that actually costs anything is a
 * finding nobody can reproduce, because the first irreproducible one is what
 * gets the whole weekly post ignored.
 */
import { describe, expect, it } from "vitest";
import {
  countActionable,
  formatMarkdownReport,
  daysBetween,
  findAgedPages,
  findBrokenInternalLinks,
  findNavMismatches,
  findTranslationDrift,
  formatSlackReport,
  normalizeRef,
  type DocsAuditReport,
} from "../../scripts/docs-audit";
import type { TranslationCache } from "../../scripts/translate-docs/types";

const NOW = new Date("2026-08-13T00:00:00Z");

function age(relPath: string, ageDays: number) {
  return {
    relPath,
    lastChanged: new Date(NOW.getTime() - ageDays * 86_400_000).toISOString(),
    ageDays,
  };
}

describe("findAgedPages", () => {
  it("reports only pages past the threshold, oldest first", () => {
    const out = findAgedPages(
      [age("a.mdx", 10), age("b.mdx", 400), age("c.mdx", 200)],
      180,
    );
    expect(out.map((p) => p.relPath)).toEqual(["b.mdx", "c.mdx"]);
  });

  it("is silent on a freshly-maintained corpus", () => {
    expect(findAgedPages([age("a.mdx", 3), age("b.mdx", 179)], 180)).toEqual([]);
  });

  it("treats the threshold as exclusive, so a page does not flip on its birthday", () => {
    expect(findAgedPages([age("a.mdx", 180)], 180)).toEqual([]);
    expect(findAgedPages([age("a.mdx", 181)], 180)).toHaveLength(1);
  });
});

describe("daysBetween", () => {
  it("counts whole days", () => {
    expect(daysBetween("2026-08-03T00:00:00Z", NOW)).toBe(10);
  });

  it("returns 0 rather than NaN for an unparseable date", () => {
    // A NaN would propagate into `ageDays > maxAgeDays` as false, which is the
    // right outcome, but it would also print "NaN days" in the Slack post.
    expect(daysBetween("not a date", NOW)).toBe(0);
  });
});

describe("normalizeRef", () => {
  it("collapses the three ways the same page gets written", () => {
    expect(normalizeRef("cli/audit.mdx")).toBe("cli/audit");
    expect(normalizeRef("/cli/audit")).toBe("cli/audit");
    expect(normalizeRef("cli/audit")).toBe("cli/audit");
  });
});

describe("findNavMismatches", () => {
  it("finds a page on disk that no nav reaches", () => {
    const { orphans, dangling } = findNavMismatches(
      ["cli/audit"],
      ["cli/audit.mdx", "cli/secret-page.mdx"],
    );
    expect(orphans).toEqual(["cli/secret-page"]);
    expect(dangling).toEqual([]);
  });

  it("finds a nav entry with no page behind it", () => {
    const { orphans, dangling } = findNavMismatches(
      ["cli/audit", "cli/deleted"],
      ["cli/audit.mdx"],
    );
    expect(dangling).toEqual(["cli/deleted"]);
    expect(orphans).toEqual([]);
  });

  it("is silent when the nav and the disk agree, whatever form the refs take", () => {
    const { orphans, dangling } = findNavMismatches(
      ["/cli/audit", "introduction"],
      ["cli/audit.mdx", "introduction.mdx"],
    );
    expect(orphans).toEqual([]);
    expect(dangling).toEqual([]);
  });
});

describe("findBrokenInternalLinks", () => {
  const known = new Set(["cli/audit", "introduction"]);

  it("finds a markdown link to a page that is not there", () => {
    const out = findBrokenInternalLinks(
      "a.mdx",
      "see [the old page](/cli/removed) for details",
      known,
    );
    expect(out).toEqual([{ relPath: "a.mdx", line: 1, target: "/cli/removed" }]);
  });

  it("finds a broken href as well as a broken markdown link", () => {
    const out = findBrokenInternalLinks("a.mdx", '<a href="/gone">x</a>', known);
    expect(out.map((l) => l.target)).toEqual(["/gone"]);
  });

  it("stays silent on links that resolve", () => {
    expect(
      findBrokenInternalLinks("a.mdx", "[ok](/cli/audit) and [ok](/introduction)", known),
    ).toEqual([]);
  });

  it("does not guess at forms it cannot resolve", () => {
    // External URLs, anchors, query strings and relative paths are skipped on
    // purpose — a false finding costs more than a missed one here.
    const source = [
      "[ext](https://example.com/nope)",
      "[anchor](#section)",
      "[rel](../sibling)",
      "[mail](mailto:x@y.z)",
    ].join("\n");
    expect(findBrokenInternalLinks("a.mdx", source, known)).toEqual([]);
  });

  it("leaves asset references to the asset checker", () => {
    // findBrokenAssetRefs owns these; reporting them here would double-count
    // every broken image in the weekly post.
    expect(
      findBrokenInternalLinks("a.mdx", "![logo](/logo/dark.svg)", known),
    ).toEqual([]);
  });

  it("reports a repeated broken link once per line, not once per occurrence", () => {
    const out = findBrokenInternalLinks(
      "a.mdx",
      "[a](/gone) then [a](/gone) again",
      known,
    );
    expect(out).toHaveLength(1);
  });
});

describe("findTranslationDrift", () => {
  const pages = [
    { relPath: "a.mdx", hash: "h-a" },
    { relPath: "b.mdx", hash: "h-b" },
  ];
  const cache = (t: TranslationCache["translations"]): TranslationCache => ({
    sourceHash: "",
    lastUpdated: "",
    translations: t,
  });
  const entry = (sourceHash: string) => ({
    sourceHash,
    targetLang: "zh",
    translatedAt: "2026-01-01T00:00:00Z",
    inputTokens: 0,
    outputTokens: 0,
  });

  it("separates stale, missing and never-translated", () => {
    const [zh] = findTranslationDrift(
      cache({ "a.mdx::zh": entry("OLD-HASH") }),
      pages,
      ["zh"],
      () => true,
    );
    expect(zh.stale).toEqual(["a.mdx"]);
    expect(zh.untranslated).toEqual(["b.mdx"]);
    expect(zh.missing).toEqual([]);
  });

  it("calls a current entry with no file on disk MISSING, not stale", () => {
    // This is the non-convergent state the existsSync guard exists for. It has
    // a different cause and a different fix from a stale translation, so
    // merging the two would hide a regression of that guard.
    const [zh] = findTranslationDrift(
      cache({ "a.mdx::zh": entry("h-a"), "b.mdx::zh": entry("h-b") }),
      pages,
      ["zh"],
      (_lang, rel) => rel !== "a.mdx",
    );
    expect(zh.missing).toEqual(["a.mdx"]);
    expect(zh.stale).toEqual([]);
    expect(zh.untranslated).toEqual([]);
  });

  it("is silent when every page is current and present", () => {
    const [zh] = findTranslationDrift(
      cache({ "a.mdx::zh": entry("h-a"), "b.mdx::zh": entry("h-b") }),
      pages,
      ["zh"],
      () => true,
    );
    expect(zh).toEqual({ lang: "zh", stale: [], missing: [], untranslated: [] });
  });

  it("reports each language separately", () => {
    const out = findTranslationDrift(
      cache({ "a.mdx::zh": entry("h-a"), "b.mdx::zh": entry("h-b") }),
      pages,
      ["zh", "ja"],
      () => true,
    );
    expect(out.map((d) => d.lang)).toEqual(["zh", "ja"]);
    expect(out[1].untranslated).toEqual(["a.mdx", "b.mdx"]);
  });
});

describe("formatSlackReport", () => {
  const empty: DocsAuditReport = {
    pages: 48,
    maxAgeDays: 180,
    aged: [],
    navOrphans: [],
    navDangling: [],
    brokenLinks: [],
    brokenAssets: [],
    drift: [{ lang: "zh", stale: [], missing: [], untranslated: [] }],
  };

  it("says so plainly on a clean week", () => {
    const out = formatSlackReport(empty);
    expect(out).toContain("nothing to report");
    expect(out).toContain("48 English pages");
  });

  it("caps each section and says how many it left out", () => {
    // A post that prints 300 findings is one nobody reads past.
    const out = formatSlackReport({
      ...empty,
      navOrphans: Array.from({ length: 9 }, (_, i) => `p${i}.mdx`),
    });
    expect(out).toContain("(9)");
    expect(out).toContain("…and 4 more");
    expect(out).not.toContain("p8.mdx");
  });

  it("calls out a cache-claims-it-but-it-is-absent count distinctly", () => {
    const out = formatSlackReport({
      ...empty,
      drift: [{ lang: "zh", stale: [], missing: ["a.mdx"], untranslated: [] }],
    });
    expect(out).toMatch(/claimed by the cache but absent from disk/);
  });

  it("names the ref and sha it audited when given them", () => {
    expect(formatSlackReport(empty, { ref: "origin/main", sha: "abc1234" })).toContain(
      "origin/main @ abc1234",
    );
  });
});

describe("countActionable", () => {
  const base: DocsAuditReport = {
    pages: 48, maxAgeDays: 180, aged: [], navOrphans: [], navDangling: [],
    brokenLinks: [], brokenAssets: [],
    drift: [{ lang: "zh", stale: [], missing: [], untranslated: [] }],
  };

  it("counts the structural findings", () => {
    expect(countActionable({ ...base, navOrphans: ["a.mdx"], aged: [age("b.mdx", 400)] })).toBe(2);
  });

  it("counts a translation the cache claims but disk lacks", () => {
    // The non-convergent state the existsSync guard exists for — a non-zero
    // count means that guard regressed or the nightly job has not run.
    expect(countActionable({
      ...base,
      drift: [{ lang: "zh", stale: [], missing: ["a.mdx"], untranslated: [] }],
    })).toBe(1);
  });

  it("does NOT count stale or never-translated", () => {
    // The nightly translation closes both by itself. Counting them would hold
    // the tracking issue open forever, which is the only way it can fail.
    expect(countActionable({
      ...base,
      drift: [{ lang: "zh", stale: ["a.mdx"], missing: [], untranslated: ["b.mdx", "c.mdx"] }],
    })).toBe(0);
  });
});

describe("formatMarkdownReport", () => {
  const base: DocsAuditReport = {
    pages: 48, maxAgeDays: 180, aged: [], navOrphans: [], navDangling: [],
    brokenLinks: [], brokenAssets: [],
    drift: [{ lang: "zh", stale: [], missing: [], untranslated: [] }],
  };

  it("says plainly when there is nothing to report", () => {
    const md = formatMarkdownReport(base);
    expect(md).toContain("Nothing to report");
  });

  it("renders findings as markdown, not Slack mrkdwn", () => {
    const md = formatMarkdownReport({ ...base, navOrphans: ["cli/x.mdx"] });
    expect(md).toContain("### On disk, in no nav");
    expect(md).toContain("- `cli/x.mdx`");
    expect(md).not.toContain("•");
  });

  it("flags cache-claims-but-absent separately from stale", () => {
    const md = formatMarkdownReport({
      ...base,
      drift: [{ lang: "zh", stale: ["s.mdx"], missing: ["m.mdx"], untranslated: [] }],
    });
    expect(md).toContain("Claimed by the translation cache but absent from disk");
    expect(md).toContain("`zh/m.mdx`");
    // stale is mentioned only as a footnote, never as an action item
    expect(md).toMatch(/<sub>Translations across 1 languages: 1 stale/);
  });

  it("caps long lists so the issue body stays readable", () => {
    const md = formatMarkdownReport({
      ...base,
      navOrphans: Array.from({ length: 40 }, (_, i) => `p${i}.mdx`),
    });
    expect(md).toContain("(40)");
    expect(md).toContain("…and 15 more");
  });
});
