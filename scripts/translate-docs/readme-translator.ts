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
        // convert HTML comments to MDX — then wrap in disclaimer + selector +
        // RTL div.
        const cleaned = convertHtmlComments(
          stripStrayTrailingFence(sanitizeJsxAttributes(raw)),
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
