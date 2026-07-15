import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageByCode } from "./config";
import { translateContent } from "./translator";
import { readCache, writeCache, isCached, setCacheEntry } from "./cache";
import type { TranslationResult, TranslationCache } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "..", "docs");

/**
 * Strip stray ASCII `"` that appear right after a JSX attribute's closing
 * quote — e.g. `<Tab title="Tab „Richtlinien"">`. The translator sometimes
 * wraps an inner phrase in language-specific typographic quotes (`„…"`,
 * `「…」`, etc.) but uses an ASCII `"` for the closing instead of the
 * proper U+201D, which terminates the attribute and leaves the real
 * closing `"` as a stray character that breaks `mintlify validate`.
 *
 * Also drops unmatched typographic opening quotes inside the same attribute
 * value so the rendered title doesn't end with a dangling `„` after we strip
 * the extras.
 */
export function sanitizeJsxAttributes(content: string): string {
  // Each pair must use an OPENER that is unambiguously an opener — i.e. the
  // codepoint never serves as a CLOSER of a different pair. That's why we
  // skip English curly “…” (U+201C/U+201D): U+201C is also the German
  // closer, so processing English curly after German would strip the very
  // German closer we just preserved.
  const openings: Array<[string, string]> = [
    ["„", "“"], // German „ … "
    ["«", "»"], // French « … »
    ["‹", "›"], // French single ‹ … ›
    ["「", "」"], // Japanese 「 … 」
    ["『", "』"], // Japanese 『 … 』
  ];
  return content.replace(
    /([a-zA-Z_-]+=")([^"\n]*)"+(?=\s|\/|>)/g,
    (match, prefix: string, value: string) => {
      // If the original had exactly one closing " (i.e. no extras),
      // leave it alone — the regex's `"+` would still match a single
      // quote, so we need to re-check the match length to be safe.
      const expectedMinLen = `${prefix}${value}"`.length;
      if (match.length === expectedMinLen) return match;
      let cleaned = value;
      for (const [open, close] of openings) {
        const opens = cleaned.split(open).length - 1;
        const closes = cleaned.split(close).length - 1;
        // Drop only the surplus unmatched openers, removing from the right.
        // A value like `„Foo“ und „Bar` (one matched pair plus one stray
        // opener) keeps the leading `„Foo“` intact and only the dangling
        // `„Bar` opener gets stripped.
        let surplus = opens - closes;
        while (surplus-- > 0) {
          const i = cleaned.lastIndexOf(open);
          if (i < 0) break;
          cleaned = cleaned.slice(0, i) + cleaned.slice(i + open.length);
        }
      }
      return `${prefix}${cleaned}"`;
    },
  );
}

/**
 * Drop a stray trailing code-fence line that the model sometimes appends to
 * the very end of long translations (empirically observed on streamed Sonnet
 * runs of large pages, e.g. README.he.md / README.tr.md after the streaming
 * switch). Only fires when the total count of fence-lines is odd — the last
 * unmatched fence is stripped, preserving every balanced pair before it.
 *
 * The Mintlify MDX parser interprets an unmatched ``` as opening a code
 * block that consumes everything to EOF, including the wrapper `</div>` for
 * RTL pages, which surfaces as `Expected a closing tag for <div>`.
 */
export function stripStrayTrailingFence(content: string): string {
  const lines = content.split("\n");
  const fenceLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Match exactly three backticks at start of line — `^```(?!`)` excludes
    // longer-fence markers (```` etc.) so an inner ``` *inside* a quad-tick
    // block isn't miscounted as a marker.
    if (/^```(?!`)/.test(lines[i])) fenceLineIndices.push(i);
  }
  if (fenceLineIndices.length % 2 === 0) return content;
  const dropIdx = fenceLineIndices[fenceLineIndices.length - 1];
  lines.splice(dropIdx, 1);
  return lines.join("\n");
}

/**
 * Rewrite internal doc links to include the language prefix.
 * e.g. href="/built-in-policies" -> href="/es/built-in-policies"
 *      [Getting started](/getting-started) -> [Getting started](/es/getting-started)
 */
export function rewriteInternalLinks(content: string, lang: string): string {
  const shouldPreservePath = (path: string): boolean =>
    path.startsWith("/http") ||
    path === "/" ||
    /\.(?:png|jpe?g|gif|svg|webp|ico)(?:#.*)?$/i.test(path);

  // Rewrite MDX component href attributes pointing to internal paths
  let result = content.replace(/href="(\/[^"]*?)"/g, (_match, path: string) => {
    if (shouldPreservePath(path)) return `href="${path}"`;
    return `href="/${lang}${path}"`;
  });

  // Rewrite Markdown links with internal paths
  result = result.replace(/\]\((\/[^)]*?)\)/g, (_match, path: string) => {
    if (shouldPreservePath(path)) return `](${path})`;
    return `](/${lang}${path})`;
  });

  return result;
}

/**
 * Translate a single MDX doc page for a given language.
 */
export async function translateMdxPage(
  sourcePath: string,
  lang: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
    model?: string;
    cache?: TranslationCache;
  } = {},
): Promise<TranslationResult> {
  const relPath = relative(DOCS_DIR, sourcePath);
  const outputPath = join(DOCS_DIR, lang, relPath);
  const sourceContent = readFileSync(sourcePath, "utf-8");

  const langConfig = getLanguageByCode(lang);
  if (!langConfig) throw new Error(`Unknown language: ${lang}`);

  // Check cache — use provided cache object or read from disk
  if (!options.force && !options.dryRun) {
    const cache = options.cache ?? readCache();
    if (isCached(cache, relPath, lang, sourceContent)) {
      return {
        lang,
        sourcePath,
        outputPath,
        inputTokens: 0,
        outputTokens: 0,
        cached: true,
      };
    }
  }

  if (options.dryRun) {
    return {
      lang,
      sourcePath,
      outputPath,
      inputTokens: 0,
      outputTokens: 0,
      cached: false,
    };
  }

  // Translate
  const { translated, inputTokens, outputTokens } = await translateContent(
    sourceContent,
    lang,
    langConfig.name,
    options.model,
  );

  // Strip stray quote artifacts from JSX attribute values, drop any
  // unmatched trailing code fence the model sometimes hallucinates, then
  // rewrite links.
  const sanitized = stripStrayTrailingFence(sanitizeJsxAttributes(translated));
  const withLinks = rewriteInternalLinks(sanitized, lang);

  // Write output
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, withLinks);

  // Update cache — skip if caller manages the cache (batch write)
  if (!options.cache) {
    const cache = readCache();
    setCacheEntry(
      cache,
      relPath,
      lang,
      sourceContent,
      inputTokens,
      outputTokens,
    );
    writeCache(cache);
  }

  return {
    lang,
    sourcePath,
    outputPath,
    inputTokens,
    outputTokens,
    cached: false,
  };
}

/**
 * Get all MDX page paths from the docs directory (English only, no language subdirs).
 */
export function getEnglishMdxPages(): string[] {
  const results: string[] = [];

  function walk(dir: string, prefix: string = "") {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        // Skip language directories at the top level
        if (!prefix && isLanguageDir(entry)) continue;
        // Skip non-page asset and localization directories.
        if (!prefix && (entry === "logo" || entry === "i18n")) continue;
        walk(full, rel);
      } else if (entry.endsWith(".mdx")) {
        results.push(full);
      }
    }
  }

  walk(DOCS_DIR);
  return results.sort();
}

function isLanguageDir(name: string): boolean {
  const langCodes = [
    "zh",
    "ja",
    "ko",
    "es",
    "pt-br",
    "de",
    "fr",
    "ru",
    "hi",
    "tr",
    "vi",
    "it",
    "ar",
    "he",
  ];
  return langCodes.includes(name);
}
