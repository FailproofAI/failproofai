import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageByCode } from "./config";
import { translateValidated } from "./translator";
import { findTranslationError } from "./validate-translation";
import {
  readCache,
  writeCache,
  isCached,
  setCacheEntry,
  getCacheKey,
} from "./cache";
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
 * Convert HTML comments (`<!-- ... -->`) into MDX brace-slash-star comments.
 *
 * Mintlify parses every page as MDX, where a top-level HTML comment is a hard
 * syntax error ("Unexpected character `!` (U+0021) before name …") that fails
 * the whole deployment — the remedy Mintlify itself suggests is switching to
 * MDX's own comment form. The root README keeps HTML-comment syntax (GitHub
 * renders it invisibly), so its translated copies under docs/i18n/ have to be
 * rewritten to the MDX form or the docs deploy breaks.
 *
 * Comments inside fenced code blocks are left untouched — there `<!-- -->` is
 * literal sample text (e.g. the plist snippet in the AgentEye collector docs),
 * not a comment to convert. Any `*`+`/` sequence inside a body is broken up so
 * the generated JS block comment can't be terminated early.
 */
export function convertHtmlComments(content: string): string {
  // Map out fenced-code ranges so comments inside them stay literal. Per
  // CommonMark, a fence opens with ≥3 backticks or tildes and closes only on a
  // later line using the SAME character and at least the same length. A naive
  // "any ``` toggles" counter misfires on a ```` block that embeds ``` or on
  // mixed ```/~~~ fences — the toggle desyncs and a real top-level comment
  // after the block would be left unconverted (breaking the deploy we fix here).
  const fenceRanges: Array<[number, number]> = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/gm;
  let fenceMatch: RegExpExecArray | null;
  let open: { char: string; length: number; start: number } | null = null;
  while ((fenceMatch = fenceRe.exec(content)) !== null) {
    const marker = fenceMatch[1];
    if (!open) {
      open = { char: marker[0], length: marker.length, start: fenceMatch.index };
    } else if (marker[0] === open.char && marker.length >= open.length) {
      const lineEnd = content.indexOf("\n", fenceRe.lastIndex);
      fenceRanges.push([open.start, lineEnd === -1 ? content.length : lineEnd]);
      open = null;
    }
    // A different char or shorter marker while a fence is open is inner content.
  }
  // An unterminated fence runs to the end of the document.
  if (open) fenceRanges.push([open.start, content.length]);

  const isInsideFence = (offset: number): boolean =>
    fenceRanges.some(([start, end]) => offset >= start && offset < end);

  return content.replace(
    /<!--([\s\S]*?)-->/g,
    (match: string, body: string, offset: number) => {
      if (isInsideFence(offset)) return match;
      // Neutralize any `*/` so it can't close the JS block comment early.
      const safeBody = body.replace(/\*\//g, "* /");
      return `{/*${safeBody}*/}`;
    },
  );
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
    /** Override the docs root. Tests point this at a fixture tree. */
    docsDir?: string;
  } = {},
): Promise<TranslationResult> {
  const docsDir = options.docsDir ?? DOCS_DIR;
  const relPath = relative(docsDir, sourcePath);
  const outputPath = join(docsDir, lang, relPath);
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

  // Translate and validate the exact bytes we will write. The render callback
  // reproduces the historical sanitize + link-rewrite chain byte-for-byte
  // (strip stray JSX-attribute quotes, drop an unmatched trailing fence,
  // convert HTML comments to MDX, then add the language prefix to links), so
  // the validated bytes ARE the written bytes and a pass here equals a pass in
  // the deploy. On exhaustion translateValidated throws before we reach the
  // write, so an invalid page is never written or cached.
  const { rendered, inputTokens, outputTokens, attempts } =
    await translateValidated({
      source: sourceContent,
      lang,
      langName: langConfig.name,
      model: options.model,
      label: `${relPath} [${lang}]`,
      render: (raw) =>
        rewriteInternalLinks(
          convertHtmlComments(stripStrayTrailingFence(sanitizeJsxAttributes(raw))),
          lang,
        ),
      validate: (bytes) => findTranslationError(bytes, sourceContent),
    });

  // Write output
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);

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
    attempts,
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

/** Every `.mdx` file under `dir`, recursively. */
function collectMdxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectMdxFiles(full));
    } else if (entry.endsWith(".mdx")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Delete translated pages whose English source no longer exists, and drop
 * their cache entries.
 *
 * Translation only ever moves forward: `getEnglishMdxPages()` drives what gets
 * written, so when an English page is deleted upstream (the agenteye sync does
 * this routinely) its 14 translations are simply never revisited. They linger
 * on disk and `--update-nav` drops them from `docs.json`, which hides them from
 * the sidebar but does *not* unpublish them — Mintlify still serves and indexes
 * any `.mdx` present, so non-English readers can land on a page documenting a
 * removed feature with no navigation out. Left unpruned these also accumulate
 * as permanent `validate:mdx` surface area for content no English source can
 * ever correct.
 *
 * Returns the docs-dir-relative paths that were (or, when `dryRun`, would be)
 * removed.
 */
export function pruneOrphanedTranslations(
  langCodes: string[],
  options: {
    dryRun?: boolean;
    cache?: TranslationCache;
    /** Override the docs root. Tests point this at a fixture tree. */
    docsDir?: string;
  } = {},
): string[] {
  const docsDir = options.docsDir ?? DOCS_DIR;
  const removed: string[] = [];

  for (const lang of langCodes) {
    const langDir = join(docsDir, lang);
    if (!existsSync(langDir)) continue;

    for (const file of collectMdxFiles(langDir)) {
      // docs/zh/agenteye/foo.mdx -> agenteye/foo.mdx -> docs/agenteye/foo.mdx
      const relPath = relative(langDir, file);
      if (existsSync(join(docsDir, relPath))) continue;

      removed.push(relative(docsDir, file));
      if (!options.dryRun) {
        rmSync(file);
        if (options.cache) {
          delete options.cache.translations[getCacheKey(relPath, lang)];
        }
      }
    }
  }

  return removed.sort();
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
