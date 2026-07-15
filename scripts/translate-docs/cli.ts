#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANGUAGES,
  getLanguagesByTier,
  getLanguageByCode,
  getModelForTier,
} from "./config";
import { getEnglishMdxPages, translateMdxPage } from "./mdx-translator";
import { translateReadme } from "./readme-translator";
import {
  getNavigationPageReferences,
  updateDocsJson,
  readDocsConfig,
} from "./mintlify-nav";
import { readCache, writeCache, isCached, setCacheEntry } from "./cache";
import type { TranslationResult } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "..", "docs");

const { values: args } = parseArgs({
  options: {
    languages: { type: "string", short: "l" },
    tier: { type: "string", short: "t" },
    pages: { type: "string", short: "p" },
    "readme-only": { type: "boolean", default: false },
    "docs-only": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", short: "f", default: false },
    "update-nav": { type: "boolean", default: false },
    validate: { type: "boolean", default: false },
    model: { type: "string", short: "m" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Usage: bun scripts/translate-docs/cli.ts [options]

Options:
  -l, --languages <codes>  Comma-separated language codes (e.g. zh,ja,es)
  -t, --tier <n>           Translate all languages up to tier n (1, 2, or 3)
  -p, --pages <files>      Comma-separated page names to translate
      --readme-only        Only translate the README
      --docs-only          Only translate Mintlify docs
      --dry-run            Show what would be translated without calling the API
  -f, --force              Ignore cache, re-translate everything
      --update-nav         Regenerate docs.json navigation after translation
      --validate           Check all nav references resolve to files
  -m, --model <model>      Claude model override (default: Sonnet for Tier 1, Haiku for Tier 2/3)
  -h, --help               Show this help

Environment:
  ANTHROPIC_API_KEY        Required for translation (not needed for --dry-run or --validate)

Examples:
  bun scripts/translate-docs/cli.ts --tier 1              # Translate Tier 1 languages
  bun scripts/translate-docs/cli.ts -l zh,ja --docs-only  # Translate Chinese + Japanese docs only
  bun scripts/translate-docs/cli.ts --dry-run --tier 3    # Preview all translations
  bun scripts/translate-docs/cli.ts --validate            # Check nav references
  bun scripts/translate-docs/cli.ts --update-nav          # Regenerate docs.json
`);
  process.exit(0);
}

function resolveLanguages(): string[] {
  if (args.languages) {
    const codes = args.languages.split(",").map((c) => c.trim());
    for (const code of codes) {
      if (!getLanguageByCode(code)) {
        console.error(`Unknown language code: ${code}`);
        console.error(`Available: ${LANGUAGES.map((l) => l.code).join(", ")}`);
        process.exit(1);
      }
    }
    return codes;
  }
  const tier = args.tier ? parseInt(args.tier, 10) : 1;
  if (tier < 1 || tier > 3) {
    console.error("Tier must be 1, 2, or 3");
    process.exit(1);
  }
  return getLanguagesByTier(tier).map((l) => l.code);
}

async function validateNavReferences(): Promise<boolean> {
  const config = readDocsConfig();
  const nav = config.navigation as Record<string, unknown>;
  let valid = true;
  let total = 0;
  let missing = 0;

  for (const reference of getNavigationPageReferences(nav)) {
    total++;
    const filePath = join(DOCS_DIR, `${reference.page}.mdx`);
    if (!existsSync(filePath)) {
      const context = reference.language ? ` [${reference.language}]` : "";
      console.error(`  MISSING${context}: ${reference.page} -> ${filePath}`);
      missing++;
      valid = false;
    }
  }

  if (valid) {
    console.log(`All ${total} page references are valid.`);
  } else {
    console.error(`\n${missing} of ${total} page references are missing.`);
  }

  return valid;
}

async function main() {
  // Validate mode
  if (args.validate) {
    const valid = await validateNavReferences();
    process.exit(valid ? 0 : 1);
  }

  // Update nav mode
  if (args["update-nav"]) {
    const langCodes = resolveLanguages();
    console.log(`Updating docs.json with languages: ${langCodes.join(", ")}`);
    updateDocsJson(langCodes);
    console.log("docs.json updated.");
    return;
  }

  const langCodes = resolveLanguages();
  const isDryRun = args["dry-run"];
  const isForce = args.force;
  const modelOverride = args.model;

  /** Resolve the model for a language: CLI override wins, otherwise tier-based default. */
  function resolveModel(lang: string): string {
    if (modelOverride) return modelOverride;
    const langConfig = getLanguageByCode(lang);
    return getModelForTier(langConfig?.tier ?? 1);
  }

  console.log(
    `${isDryRun ? "[DRY RUN] " : ""}Translating into: ${langCodes.join(", ")}`,
  );
  if (!modelOverride) {
    console.log(
      `Models: Tier 1 -> ${getModelForTier(1)}, Tier 2/3 -> ${getModelForTier(2)}`,
    );
  } else {
    console.log(`Model override: ${modelOverride}`);
  }

  const results: TranslationResult[] = [];
  const errors: Array<{ lang: string; source: string; error: string }> = [];

  // Read cache once upfront — filter unchanged files before starting work
  const cache = readCache();

  // Concurrency limiter. The gateway behind ANTHROPIC_BASE_URL was
  // empirically saturating past ~2 in flight pre-scale (see #300, #305);
  // post-scale we run at 4 by default and rely on SDK retries (5 attempts,
  // configured in translator.ts) to absorb per-request transient
  // `Connection error.` from LB-induced replica flapping.
  // Override via TRANSLATE_MAX_CONCURRENT (integer >= 1; otherwise default).
  const parsedConcurrent = Number.parseInt(
    process.env.TRANSLATE_MAX_CONCURRENT ?? "",
    10,
  );
  const MAX_CONCURRENT =
    Number.isInteger(parsedConcurrent) && parsedConcurrent > 0
      ? parsedConcurrent
      : 4;
  async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
  ): Promise<T[]> {
    const results: T[] = [];
    let i = 0;
    async function next(): Promise<void> {
      while (i < tasks.length) {
        const idx = i++;
        results[idx] = await tasks[idx]();
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT, tasks.length) }, () =>
        next(),
      ),
    );
    return results;
  }

  // Translate docs
  if (!args["readme-only"]) {
    const pages = getEnglishMdxPages();
    const filteredPages = args.pages
      ? pages.filter((p) => {
          const rel = relative(DOCS_DIR, p).replace(".mdx", "");
          return args.pages!.split(",").some((f) => rel.includes(f.trim()));
        })
      : pages;

    // Read each page once and reuse across languages
    const pageContents = new Map<string, string>();
    for (const page of filteredPages) {
      pageContents.set(page, readFileSync(page, "utf-8"));
    }

    // Split into cached (skip) and uncached (need translation) upfront
    type PageTask = { page: string; relPath: string; lang: string };
    const cachedTasks: PageTask[] = [];
    const uncachedTasks: PageTask[] = [];

    for (const lang of langCodes) {
      for (const page of filteredPages) {
        const relPath = relative(DOCS_DIR, page);
        const task = { page, relPath, lang };
        if (
          !isForce &&
          !isDryRun &&
          isCached(cache, relPath, lang, pageContents.get(page)!)
        ) {
          cachedTasks.push(task);
        } else {
          uncachedTasks.push(task);
        }
      }
    }

    console.log(
      `\n${filteredPages.length} MDX pages x ${langCodes.length} languages = ${filteredPages.length * langCodes.length} total`,
    );
    console.log(`  Cached (unchanged): ${cachedTasks.length}`);
    console.log(`  Need translation: ${uncachedTasks.length}`);

    // Record cached results
    for (const { page, relPath, lang } of cachedTasks) {
      results.push({
        lang,
        sourcePath: page,
        outputPath: join(DOCS_DIR, lang, relPath),
        inputTokens: 0,
        outputTokens: 0,
        cached: true,
      });
    }

    // Translate uncached pages with concurrency limit
    if (uncachedTasks.length > 0) {
      const taskResults = await runWithConcurrency(
        uncachedTasks.map(({ page, relPath, lang }) => async () => {
          try {
            const result = await translateMdxPage(page, lang, {
              force: isForce,
              dryRun: isDryRun,
              model: resolveModel(lang),
              cache,
            });
            const status = isDryRun
              ? "would translate"
              : `translated (${result.inputTokens}+${result.outputTokens} tokens)`;
            console.log(`  ${relPath} [${lang}] -> ${status}`);
            results.push(result);
            if (!result.cached && !isDryRun) {
              setCacheEntry(
                cache,
                relPath,
                lang,
                pageContents.get(page)!,
                result.inputTokens,
                result.outputTokens,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ lang, source: relPath, error: msg });
            console.error(`  ${relPath} [${lang}] -> ERROR: ${msg}`);
          }
        }),
      );
    }
  }

  // Translate README
  if (!args["docs-only"]) {
    console.log(`\nTranslating README...`);

    // Read README once
    const readmeSource = readFileSync(
      join(DOCS_DIR, "..", "README.md"),
      "utf-8",
    );
    const uncachedLangs: string[] = [];
    for (const lang of langCodes) {
      if (
        !isForce &&
        !isDryRun &&
        isCached(cache, "README.md", lang, readmeSource)
      ) {
        console.log(`  README.${lang}.md -> cached`);
        results.push({
          lang,
          sourcePath: join(DOCS_DIR, "..", "README.md"),
          outputPath: join(DOCS_DIR, "i18n", `README.${lang}.md`),
          inputTokens: 0,
          outputTokens: 0,
          cached: true,
        });
      } else {
        uncachedLangs.push(lang);
      }
    }

    if (uncachedLangs.length > 0) {
      await runWithConcurrency(
        uncachedLangs.map((lang) => async () => {
          try {
            const langConfig = getLanguageByCode(lang)!;
            const result = await translateReadme(lang, {
              force: isForce,
              dryRun: isDryRun,
              model: resolveModel(lang),
              cache,
            });
            const status = isDryRun
              ? "would translate"
              : `translated (${result.inputTokens}+${result.outputTokens} tokens)`;
            console.log(
              `  README.${lang}.md -> ${langConfig.nativeName}: ${status}`,
            );
            results.push(result);
            if (!result.cached && !isDryRun) {
              setCacheEntry(
                cache,
                "README.md",
                lang,
                readmeSource,
                result.inputTokens,
                result.outputTokens,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ lang, source: "README.md", error: msg });
            console.error(`  README.${lang}.md -> ERROR: ${msg}`);
          }
        }),
      );
    }
  }

  // Batch write cache once at the end
  if (!isDryRun) {
    writeCache(cache);
  }

  // Summary
  const translated = results.filter((r) => !r.cached && !isDryRun);
  const cached = results.filter((r) => r.cached);
  const totalInput = translated.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = translated.reduce((s, r) => s + r.outputTokens, 0);

  console.log(`\n--- Summary ---`);
  console.log(`Translated: ${translated.length}`);
  console.log(`Cached (skipped): ${cached.length}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
  }
  if (totalInput > 0) {
    console.log(`Total tokens: ${totalInput} input + ${totalOutput} output`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
