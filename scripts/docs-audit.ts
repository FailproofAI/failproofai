/**
 * A standing audit of the documentation, run weekly on the canary box
 * (integration-suite/local/jobs/docs-audit.sh) and available by hand as
 * `bun run docs:audit`.
 *
 * WHY THIS IS NOT `mintlify validate` OR `validate:mdx`. Those two answer "does
 * this build" — a gate, run per PR, on the pages a PR touches. They pass
 * happily on a corpus that builds perfectly and is quietly wrong: a page nobody
 * has edited since the CLI it documents was rewritten, a page in the nav that
 * no longer exists, a page that exists and is in no nav, a link to a page that
 * was renamed, a translation still describing last quarter's behaviour. None of
 * that fails a build, so nothing catches it — which is exactly the shape of
 * problem a periodic sweep is for and a per-PR gate is not.
 *
 * So this is a REPORT, not a gate. It exits 0 with findings by design; the
 * weekly Slack post is the product. `--fail-on-findings` is there for anyone
 * who later wants it in CI, deliberately off by default: a docs audit that
 * turns the build red on the day a page passes an age threshold would be
 * turned off within a week, and then nobody would have either the gate or the
 * report.
 *
 * Everything below `auditDocs()` is pure and takes its inputs as arguments —
 * the git log, the file list, the cache — so the analysis is unit-testable
 * without a repo, a docs tree, or a clock.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageCodes } from "./translate-docs/config";
import { getEnglishMdxPages } from "./translate-docs/mdx-translator";
import {
  getNavigationPageReferences,
  readDocsConfig,
} from "./translate-docs/mintlify-nav";
import { contentHash, getCacheKey, readCache } from "./translate-docs/cache";
import { findBrokenAssetRefs } from "./validate-mdx";
import type { TranslationCache } from "./translate-docs/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const DOCS_DIR = join(ROOT_DIR, "docs");

/** A page's age, measured from its last CONTENT commit. */
export interface PageAge {
  relPath: string;
  lastChanged: string; // ISO 8601
  ageDays: number;
}

export interface BrokenLink {
  relPath: string;
  line: number;
  target: string;
}

export interface TranslationDrift {
  lang: string;
  stale: string[]; // English source changed since this was translated
  missing: string[]; // cache says translated, file is not on disk
  untranslated: string[]; // never translated at all
}

export interface DocsAuditReport {
  pages: number;
  maxAgeDays: number;
  aged: PageAge[];
  navOrphans: string[]; // on disk, in no nav
  navDangling: string[]; // in the nav, not on disk
  brokenLinks: BrokenLink[];
  brokenAssets: BrokenLink[];
  drift: TranslationDrift[];
}

/**
 * Pages whose last content change is older than the threshold, oldest first.
 *
 * "Content change" is the last commit that touched the file, which is a proxy
 * and a deliberately generous one: a typo fix resets the clock. The alternative
 * — trying to tell a substantive edit from a cosmetic one — would need a
 * judgement this cannot make, and being generous errs toward silence rather
 * than toward a weekly report of things that are fine.
 */
export function findAgedPages(
  ages: PageAge[],
  maxAgeDays: number,
): PageAge[] {
  return ages
    .filter((a) => a.ageDays > maxAgeDays)
    .sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * The two directions a page and the navigation can disagree.
 *
 * `mintlify validate` catches DANGLING (a nav entry with no file) because that
 * breaks the build. It cannot catch an ORPHAN — a page on disk that no nav
 * references — because nothing is broken: the file simply cannot be reached by
 * a reader, which is indistinguishable from deliberate until someone looks.
 */
export function findNavMismatches(
  navRefs: string[],
  pageRelPaths: string[],
): { orphans: string[]; dangling: string[] } {
  const nav = new Set(navRefs.map(normalizeRef));
  const pages = new Set(pageRelPaths.map(normalizeRef));
  return {
    orphans: [...pages].filter((p) => !nav.has(p)).sort(),
    dangling: [...nav].filter((n) => !pages.has(n)).sort(),
  };
}

/** `cli/audit.mdx`, `/cli/audit`, `cli/audit` all name the same page. */
export function normalizeRef(ref: string): string {
  return ref.replace(/^\//, "").replace(/\.mdx?$/, "");
}

/**
 * In-body links to pages that are not there.
 *
 * Only ROOT-RELATIVE links (`/cli/audit`) are checked, because that is the form
 * Mintlify resolves and the only one whose target this can determine without
 * guessing. External URLs, anchors and relative paths are skipped rather than
 * guessed at — a false finding in a weekly report costs more than a missed one,
 * since the first one nobody can reproduce is the one that gets the whole
 * report ignored.
 */
export function findBrokenInternalLinks(
  relPath: string,
  source: string,
  knownPages: Set<string>,
): BrokenLink[] {
  const out: BrokenLink[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const targets = [
      ...lines[i].matchAll(/\]\((\/[^)\s#?]*)/g),
      ...lines[i].matchAll(/href=["'](\/[^"'#?]*)["']/g),
    ].map((m) => m[1]);
    for (const target of targets) {
      if (!target || target === "/") continue;
      // An asset reference, not a page link — findBrokenAssetRefs owns those.
      if (/\.[a-z0-9]{2,5}$/i.test(target) && !/\.mdx?$/i.test(target)) continue;
      const norm = normalizeRef(target);
      if (knownPages.has(norm)) continue;
      const key = `${i}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ relPath, line: i + 1, target });
    }
  }
  return out;
}

/**
 * Where each language stands against the current English source.
 *
 * Three distinct states, kept apart because they need different actions:
 * STALE means the English changed and the translation is now describing older
 * behaviour (the nightly run fixes it by itself); MISSING means the cache
 * claims a translation that is not on disk — the non-convergent case the
 * `existsSync` guard exists for, and worth seeing if it ever recurs;
 * UNTRANSLATED means the page has never been translated into that language at
 * all, which the nightly run also fixes but which shows up here as coverage.
 */
export function findTranslationDrift(
  cache: TranslationCache,
  pages: { relPath: string; hash: string }[],
  langs: string[],
  outputExists: (lang: string, relPath: string) => boolean,
): TranslationDrift[] {
  return langs.map((lang) => {
    const stale: string[] = [];
    const missing: string[] = [];
    const untranslated: string[] = [];
    for (const { relPath, hash } of pages) {
      const entry = cache.translations[getCacheKey(relPath, lang)];
      if (!entry) {
        untranslated.push(relPath);
      } else if (entry.sourceHash !== hash) {
        stale.push(relPath);
      } else if (!outputExists(lang, relPath)) {
        missing.push(relPath);
      }
    }
    return { lang, stale, missing, untranslated };
  });
}

/** Last commit date per file, as ISO strings. Absent from history → null. */
export function lastChangedISO(repoRoot: string, relFile: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", relFile],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function daysBetween(from: string, now: Date): number {
  const then = new Date(from).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function auditDocs(opts: { maxAgeDays: number; now?: Date }): DocsAuditReport {
  const now = opts.now ?? new Date();
  const pageFiles = getEnglishMdxPages();
  const relPaths = pageFiles.map((f) => relative(DOCS_DIR, f));
  const knownPages = new Set(relPaths.map(normalizeRef));

  const ages: PageAge[] = [];
  for (const file of pageFiles) {
    const iso = lastChangedISO(ROOT_DIR, relative(ROOT_DIR, file));
    if (!iso) continue; // never committed — a new page in the working tree
    ages.push({
      relPath: relative(DOCS_DIR, file),
      lastChanged: iso,
      ageDays: daysBetween(iso, now),
    });
  }

  const brokenLinks: BrokenLink[] = [];
  const brokenAssets: BrokenLink[] = [];
  const pages: { relPath: string; hash: string }[] = [];
  for (const file of pageFiles) {
    const rel = relative(DOCS_DIR, file);
    const source = readFileSync(file, "utf8");
    pages.push({ relPath: rel, hash: contentHash(source) });
    brokenLinks.push(...findBrokenInternalLinks(rel, source, knownPages));
    for (const ref of findBrokenAssetRefs(file, source)) {
      brokenAssets.push({ relPath: rel, line: ref.line, target: ref.ref });
    }
  }

  // English nav only. The localized trees are generated from it by
  // `--update-nav`, so auditing them would report every English finding once
  // per language and bury the one that matters.
  const config = readDocsConfig();
  const navRefs = getNavigationPageReferences(config.navigation)
    .filter((r) => !r.language || r.language === "en")
    .map((r) => r.page);
  const { orphans, dangling } = findNavMismatches(navRefs, relPaths);

  const langs = getLanguageCodes();
  const drift = findTranslationDrift(readCache(), pages, langs, (lang, rel) =>
    existsSync(join(DOCS_DIR, lang, rel)),
  );

  return {
    pages: pageFiles.length,
    maxAgeDays: opts.maxAgeDays,
    aged: findAgedPages(ages, opts.maxAgeDays),
    navOrphans: orphans,
    navDangling: dangling,
    brokenLinks,
    brokenAssets,
    drift,
  };
}

/**
 * The weekly Slack post.
 *
 * Ordered by what someone should act on, and CAPPED per section: a report that
 * prints 300 stale translations is one nobody reads past, so each section shows
 * a few and says how many more there are. A clean week says so in one line —
 * the report has to be worth reading in the common case or it stops being read
 * in the uncommon one.
 */
export function formatSlackReport(
  report: DocsAuditReport,
  opts: { ref?: string; sha?: string } = {},
): string {
  const at = [opts.ref, opts.sha].filter(Boolean).join(" @ ");
  const head = `📚 *Weekly docs audit* — ${report.pages} English pages${at ? ` (${at})` : ""}`;
  const sections: string[] = [];
  const cap = 5;
  const more = (n: number) => (n > cap ? `\n  …and ${n - cap} more` : "");

  if (report.navDangling.length) {
    sections.push(
      `*In the nav, not on disk* (${report.navDangling.length})\n` +
        report.navDangling.slice(0, cap).map((p) => `  • ${p}`).join("\n") +
        more(report.navDangling.length),
    );
  }
  if (report.navOrphans.length) {
    sections.push(
      `*On disk, in no nav* (${report.navOrphans.length}) — unreachable by a reader\n` +
        report.navOrphans.slice(0, cap).map((p) => `  • ${p}`).join("\n") +
        more(report.navOrphans.length),
    );
  }
  if (report.brokenLinks.length) {
    sections.push(
      `*Links to pages that do not exist* (${report.brokenLinks.length})\n` +
        report.brokenLinks
          .slice(0, cap)
          .map((l) => `  • ${l.relPath}:${l.line} → ${l.target}`)
          .join("\n") +
        more(report.brokenLinks.length),
    );
  }
  if (report.brokenAssets.length) {
    sections.push(
      `*Images that do not resolve* (${report.brokenAssets.length})\n` +
        report.brokenAssets
          .slice(0, cap)
          .map((l) => `  • ${l.relPath}:${l.line} → ${l.target}`)
          .join("\n") +
        more(report.brokenAssets.length),
    );
  }
  if (report.aged.length) {
    sections.push(
      `*Not touched in over ${report.maxAgeDays} days* (${report.aged.length})\n` +
        report.aged
          .slice(0, cap)
          .map((a) => `  • ${a.relPath} — ${a.ageDays} days`)
          .join("\n") +
        more(report.aged.length),
    );
  }

  const staleTotal = report.drift.reduce((n, d) => n + d.stale.length, 0);
  const missingTotal = report.drift.reduce((n, d) => n + d.missing.length, 0);
  const untranslatedTotal = report.drift.reduce((n, d) => n + d.untranslated.length, 0);
  if (staleTotal || missingTotal || untranslatedTotal) {
    const parts = [
      staleTotal ? `${staleTotal} stale` : "",
      untranslatedTotal ? `${untranslatedTotal} never translated` : "",
      // Worth its own mention: this is the state the existsSync guard exists
      // for, so a non-zero count means either that guard regressed or the
      // nightly job has not run since the pages landed.
      missingTotal ? `*${missingTotal} claimed by the cache but absent from disk*` : "",
    ].filter(Boolean);
    sections.push(
      `*Translations* across ${report.drift.length} languages — ${parts.join(", ")}\n` +
        `  (the nightly translation job closes stale and never-translated by itself)`,
    );
  }

  if (!sections.length) return `${head}\n\n✅ nothing to report.`;
  return `${head}\n\n${sections.join("\n\n")}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const maxAgeDays = Number.parseInt(
    args.find((a) => a.startsWith("--max-age="))?.split("=")[1] ??
      process.env.DOCS_AUDIT_MAX_AGE_DAYS ??
      "180",
    10,
  );
  const report = auditDocs({
    maxAgeDays: Number.isInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 180,
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      formatSlackReport(report, {
        ref: process.env.DOCS_AUDIT_REF,
        sha: process.env.DOCS_AUDIT_SHA,
      }),
    );
  }

  const findings =
    report.aged.length +
    report.navOrphans.length +
    report.navDangling.length +
    report.brokenLinks.length +
    report.brokenAssets.length;
  // Exit 0 with findings BY DESIGN — see the header. The flag is for a future
  // caller that wants a gate, never for the weekly report.
  process.exit(args.includes("--fail-on-findings") && findings > 0 ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
