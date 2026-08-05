import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES, getLanguageByCode } from "./config";
import { translateValidated } from "./translator";
import {
  stripStrayTrailingFence,
  convertHtmlComments,
  sanitizeJsxAttributes,
} from "./mdx-translator";
import { findTranslationError } from "./validate-translation";
import { readCache, writeCache, isCached, setCacheEntry } from "./cache";
import type { TranslationResult, TranslationCache } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const README_PATH = join(ROOT_DIR, "README.md");
const I18N_DIR = join(ROOT_DIR, "docs", "i18n");

/**
 * Prefix that walks from `docs/i18n/` back to the repo root. Keep in sync with
 * I18N_DIR — the disclaimer and language selector already hard-code the same
 * two levels in their `../../README.md` links.
 */
const TO_REPO_ROOT = "../../";

/** Raw-content base for repo files that must resolve off-GitHub too. */
const RAW_BASE = "https://raw.githubusercontent.com/FailproofAI/failproofai/main/";

const ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|mp4|webm)$/i;

/**
 * Re-point the root README's repo-root-relative paths so they still resolve
 * from `docs/i18n/README.<lang>.md`, two directories deeper.
 *
 * The root README lives AT the repo root, so it writes `readme-arch-hq.gif` and
 * `assets/logos/claude.svg` — correct there. The translator is prompt-forbidden
 * from touching paths ("Preserve all URLs and paths", translator.ts), and
 * rightly so, but that means every translated copy inherited those paths
 * verbatim into a directory two levels down, where they resolve against
 * `docs/i18n/`. Both consumers 404'd: GitHub asked for
 * `docs/i18n/assets/logos/claude.svg` and Mintlify (which also serves these
 * pages, unlisted, at `/i18n/README.<lang>`) asked S3 for `exosphere/i18n/...`.
 * Every logo and the architecture GIF were broken in all 14 languages.
 *
 * The two ref kinds get different treatment because they resolve in different
 * places:
 *  - IMAGES become absolute raw.githubusercontent URLs. A `../../` relative
 *    path would fix GitHub but not Mintlify, whose copy of the page has no
 *    `assets/` tree above it to walk into — an absolute URL is the only form
 *    that renders on BOTH surfaces.
 *  - DOCUMENT links (`./LICENSE`, `./CONTRIBUTING.md`, the translations row's
 *    `./docs/i18n/README.*.md`) get the `../../` prefix instead. GitHub is the
 *    only surface where a link to a repo file resolves at all, and a raw URL
 *    there would serve unrendered plaintext.
 *
 * Left alone: absolute URLs, anchors, `mailto:`, protocol-relative `//`,
 * site-absolute `/`, anything already starting with `../`, and everything
 * inside a fenced code block (where a path is literal sample text, not a ref).
 */
export function rebaseReadmePaths(content: string): string {
  const fenceRanges = findFenceRanges(content);
  const insideFence = (offset: number): boolean =>
    fenceRanges.some(([start, end]) => offset >= start && offset < end);

  const rebase = (path: string): string | null => {
    if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null; // scheme
    if (path.startsWith("#") || path.startsWith("/")) return null; // anchor, site-absolute
    if (path.startsWith("../")) return null; // already rebased
    const bare = path.replace(/^\.\//, "");
    if (bare === "" || bare.startsWith("../")) return null;
    return ASSET_RE.test(bare.split(/[?#]/)[0])
      ? `${RAW_BASE}${bare}`
      : `${TO_REPO_ROOT}${bare}`;
  };

  // Markdown links and images: `](path)` / `](path "title")`.
  let out = content.replace(
    /(\]\()([^)\s]+)/g,
    (match, prefix: string, path: string, offset: number) => {
      if (insideFence(offset)) return match;
      const next = rebase(path);
      return next === null ? match : `${prefix}${next}`;
    },
  );

  // HTML/JSX attributes: the README's logo table is a raw <table> of <img>.
  out = out.replace(
    /((?:src|href)=(["']))(.*?)\2/g,
    (match, prefix: string, quote: string, path: string, offset: number) => {
      if (insideFence(offset)) return match;
      const next = rebase(path);
      return next === null ? match : `${prefix}${next}${quote}`;
    },
  );

  // `srcset` needs its own pass: each logo cell is a <picture> whose dark-mode
  // <source srcset="assets/logos/*-dark.svg"> sits beside the <img src>. Miss
  // it and half the table stays broken for dark-theme readers only — the half
  // least likely to be noticed in review.
  out = out.replace(
    /(srcset=(["']))(.*?)\2/g,
    (match, prefix: string, quote: string, value: string, offset: number) => {
      if (insideFence(offset)) return match;
      return `${prefix}${rebaseSrcset(value)}${quote}`;
    },
  );

  return out;

  /**
   * Rebase every candidate in a `srcset` value, preserving each one's optional
   * density/width descriptor (`logo.svg 2x`, `wide.png 800w`) and the original
   * comma spacing.
   */
  function rebaseSrcset(value: string): string {
    return value
      .split(",")
      .map((candidate) => {
        const [, lead, url, descriptor] =
          /^(\s*)(\S+)(.*)$/.exec(candidate) ?? [];
        if (url === undefined) return candidate; // whitespace-only candidate
        const next = rebase(url);
        return `${lead}${next ?? url}${descriptor}`;
      })
      .join(",");
  }
}

/**
 * Byte ranges covered by fenced code blocks, per CommonMark: a fence opens with
 * ≥3 backticks or tildes and closes only on a later line using the SAME
 * character at ≥ the same length.
 *
 * Follows the scanner in `mdx-translator.convertHtmlComments`, with one
 * correction: a CLOSING fence may carry only trailing whitespace, never an info
 * string. Accepting ```` ```ts ```` as a close would end the block at the first
 * *nested* opener inside it and leave the real code that follows looking like
 * prose — whose sample paths this function exists to protect.
 */
function findFenceRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/gm;
  let match: RegExpExecArray | null;
  let open: { char: string; length: number; start: number } | null = null;
  while ((match = fenceRe.exec(content)) !== null) {
    const [, marker, rest] = match;
    if (!open) {
      open = { char: marker[0], length: marker.length, start: match.index };
    } else if (
      marker[0] === open.char &&
      marker.length >= open.length &&
      rest.trim() === ""
    ) {
      const lineEnd = content.indexOf("\n", fenceRe.lastIndex);
      ranges.push([open.start, lineEnd === -1 ? content.length : lineEnd]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, content.length]);
  return ranges;
}

function buildLanguageSelector(currentLang: string): string {
  const flags: Record<string, string> = {
    en: "\ud83c\uddfa\ud83c\uddf8",
    zh: "\ud83c\udde8\ud83c\uddf3",
    ja: "\ud83c\uddef\ud83c\uddf5",
    ko: "\ud83c\uddf0\ud83c\uddf7",
    es: "\ud83c\uddea\ud83c\uddf8",
    "pt-br": "\ud83c\udde7\ud83c\uddf7",
    de: "\ud83c\udde9\ud83c\uddea",
    fr: "\ud83c\uddeb\ud83c\uddf7",
    ru: "\ud83c\uddf7\ud83c\uddfa",
    hi: "\ud83c\uddee\ud83c\uddf3",
    tr: "\ud83c\uddf9\ud83c\uddf7",
    vi: "\ud83c\uddfb\ud83c\uddf3",
    it: "\ud83c\uddee\ud83c\uddf9",
    ar: "\ud83c\uddf8\ud83c\udde6",
    he: "\ud83c\uddee\ud83c\uddf1",
  };

  const links: string[] = [];

  // English link (to root README)
  if (currentLang !== "en") {
    links.push(`[${flags.en} English](../../README.md)`);
  }

  for (const lang of LANGUAGES) {
    const flag = flags[lang.code] || "";
    if (lang.code === currentLang) {
      links.push(`**${flag} ${lang.nativeName}**`);
    } else {
      links.push(`[${flag} ${lang.nativeName}](README.${lang.code}.md)`);
    }
  }

  return links.join(" | ");
}

export async function translateReadme(
  lang: string,
  options: { force?: boolean; dryRun?: boolean; model?: string; cache?: TranslationCache } = {},
): Promise<TranslationResult> {
  const outputPath = join(I18N_DIR, `README.${lang}.md`);
  const sourceContent = readFileSync(README_PATH, "utf-8");

  const langConfig = getLanguageByCode(lang);
  if (!langConfig) throw new Error(`Unknown language: ${lang}`);

  // Check cache — use provided cache object or read from disk
  if (!options.force && !options.dryRun) {
    const cache = options.cache ?? readCache();
    if (isCached(cache, "README.md", lang, sourceContent)) {
      return {
        lang,
        sourcePath: README_PATH,
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
      sourcePath: README_PATH,
      outputPath,
      inputTokens: 0,
      outputTokens: 0,
      cached: false,
    };
  }

  // Compute the wrapper (disclaimer, language selector, RTL <div>) up front so
  // the render callback can assemble the FINAL bytes on every attempt. The
  // assembled bytes — not the raw model output — are what gets validated: the
  // swallowed-`</div>` class is introduced by the wrapper AFTER the model
  // returns, and `mintlify validate` never sees the README at all, so this gate
  // is the only thing standing between a broken README and the deploy.
  const disclaimer = langConfig.rtl
    ? `> **\u26a0\ufe0f** \u0647\u0630\u0647 \u062a\u0631\u062c\u0645\u0629 \u0622\u0644\u064a\u0629. \u0644\u0644\u0627\u0637\u0644\u0627\u0639 \u0639\u0644\u0649 \u0623\u062d\u062f\u062b \u0625\u0635\u062f\u0627\u0631\u060c \u0631\u0627\u062c\u0639 [English README](../../README.md).`
    : `> **\u26a0\ufe0f** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!`;

  const langSelector = buildLanguageSelector(lang);
  const rtlOpen = langConfig.rtl ? `<div dir="rtl">\n\n` : "";
  const rtlClose = langConfig.rtl ? `\n\n</div>` : "";

  // Translate and validate the assembled bytes, re-translating on failure.
  const { rendered, inputTokens, outputTokens, attempts } =
    await translateValidated({
      source: sourceContent,
      lang,
      langName: langConfig.name,
      model: options.model,
      label: `README.${lang}.md`,
      render: (raw) => {
        // Same MDX sanitizers as translateMdxPage — the README emits JSX (the
        // logo table), so strip stray attribute quotes, drop any unmatched
        // trailing code fence (which would swallow the RTL `</div>`), and
        // convert HTML comments to MDX — then re-point the root README's
        // repo-root-relative paths for this file's depth, and wrap in
        // disclaimer + selector + RTL div.
        //
        // The rebase runs on the model output ONLY, never on the wrapper: the
        // disclaimer's `../../README.md` and the selector's sibling
        // `README.<lang>.md` links are already written for `docs/i18n/`.
        const cleaned = rebaseReadmePaths(
          convertHtmlComments(
            stripStrayTrailingFence(sanitizeJsxAttributes(raw)),
          ),
        );
        return `${disclaimer}\n\n${langSelector}\n\n---\n${rtlOpen}\n${cleaned}\n${rtlClose}`;
      },
      validate: (bytes) => findTranslationError(bytes, sourceContent),
    });

  // Write output
  mkdirSync(I18N_DIR, { recursive: true });
  writeFileSync(outputPath, rendered);

  // Update cache — skip if caller manages the cache (batch write)
  if (!options.cache) {
    const cache = readCache();
    setCacheEntry(cache, "README.md", lang, sourceContent, inputTokens, outputTokens);
    writeCache(cache);
  }

  return {
    lang,
    sourcePath: README_PATH,
    outputPath,
    inputTokens,
    outputTokens,
    cached: false,
    attempts,
  };
}

/**
 * Build the language selector line to add to the main README.
 */
export function buildMainReadmeLanguageLinks(): string {
  const flags: Record<string, string> = {
    zh: "\ud83c\udde8\ud83c\uddf3",
    ja: "\ud83c\uddef\ud83c\uddf5",
    ko: "\ud83c\uddf0\ud83c\uddf7",
    es: "\ud83c\uddea\ud83c\uddf8",
    "pt-br": "\ud83c\udde7\ud83c\uddf7",
    de: "\ud83c\udde9\ud83c\uddea",
    fr: "\ud83c\uddeb\ud83c\uddf7",
    ru: "\ud83c\uddf7\ud83c\uddfa",
    hi: "\ud83c\uddee\ud83c\uddf3",
    tr: "\ud83c\uddf9\ud83c\uddf7",
    vi: "\ud83c\uddfb\ud83c\uddf3",
    it: "\ud83c\uddee\ud83c\uddf9",
    ar: "\ud83c\uddf8\ud83c\udde6",
    he: "\ud83c\uddee\ud83c\uddf1",
  };

  const links = LANGUAGES.map(
    (l) => `[${flags[l.code] || ""} ${l.nativeName}](docs/i18n/README.${l.code}.md)`,
  );

  return `**Translations**: ${links.join(" | ")}`;
}
