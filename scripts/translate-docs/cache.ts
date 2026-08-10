import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranslationCache } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, ".translation-cache.json");

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function readCache(): TranslationCache {
  if (!existsSync(CACHE_FILE)) {
    return { sourceHash: "", lastUpdated: "", translations: {} };
  }
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return { sourceHash: "", lastUpdated: "", translations: {} };
  }
}

export function writeCache(cache: TranslationCache): void {
  cache.lastUpdated = new Date().toISOString();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function getCacheKey(sourcePath: string, lang: string): string {
  return `${sourcePath}::${lang}`;
}

export function isCached(
  cache: TranslationCache,
  sourcePath: string,
  lang: string,
  sourceContent: string,
): boolean {
  const key = getCacheKey(sourcePath, lang);
  const entry = cache.translations[key];
  if (!entry) return false;
  return entry.sourceHash === contentHash(sourceContent);
}

export function setCacheEntry(
  cache: TranslationCache,
  sourcePath: string,
  lang: string,
  sourceContent: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const key = getCacheKey(sourcePath, lang);
  cache.translations[key] = {
    sourceHash: contentHash(sourceContent),
    targetLang: lang,
    translatedAt: new Date().toISOString(),
    inputTokens,
    outputTokens,
  };
}
