// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  contentHash,
  getCacheKey,
  isCached,
  setCacheEntry,
} from "@/scripts/translate-docs/cache";
import type { TranslationCache } from "@/scripts/translate-docs/types";

describe("contentHash", () => {
  it("returns a 16-character hex string", () => {
    const hash = contentHash("hello world");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same hash for the same content", () => {
    expect(contentHash("test")).toBe(contentHash("test"));
  });

  it("returns different hashes for different content", () => {
    expect(contentHash("foo")).not.toBe(contentHash("bar"));
  });
});

describe("getCacheKey", () => {
  it("combines sourcePath and lang", () => {
    expect(getCacheKey("introduction.mdx", "zh")).toBe("introduction.mdx::zh");
  });

  it("handles nested paths", () => {
    expect(getCacheKey("cli/dashboard.mdx", "ja")).toBe(
      "cli/dashboard.mdx::ja",
    );
  });
});

describe("isCached", () => {
  it("returns false when entry does not exist", () => {
    const cache: TranslationCache = {
      sourceHash: "",
      lastUpdated: "",
      translations: {},
    };
    expect(isCached(cache, "intro.mdx", "zh", "content")).toBe(false);
  });

  it("returns true when source hash matches", () => {
    const content = "some content";
    const hash = contentHash(content);
    const cache: TranslationCache = {
      sourceHash: "",
      lastUpdated: "",
      translations: {
        "intro.mdx::zh": {
          sourceHash: hash,
          targetLang: "zh",
          translatedAt: "2024-01-01",
          inputTokens: 100,
          outputTokens: 200,
        },
      },
    };
    expect(isCached(cache, "intro.mdx", "zh", content)).toBe(true);
  });

  it("returns false when source hash does not match (content changed)", () => {
    const cache: TranslationCache = {
      sourceHash: "",
      lastUpdated: "",
      translations: {
        "intro.mdx::zh": {
          sourceHash: "oldhash123456789",
          targetLang: "zh",
          translatedAt: "2024-01-01",
          inputTokens: 100,
          outputTokens: 200,
        },
      },
    };
    expect(isCached(cache, "intro.mdx", "zh", "updated content")).toBe(false);
  });
});

describe("setCacheEntry", () => {
  it("creates a new entry in the cache", () => {
    const cache: TranslationCache = {
      sourceHash: "",
      lastUpdated: "",
      translations: {},
    };
    setCacheEntry(cache, "intro.mdx", "zh", "content", 100, 200);

    const key = "intro.mdx::zh";
    expect(cache.translations[key]).toBeDefined();
    expect(cache.translations[key].targetLang).toBe("zh");
    expect(cache.translations[key].sourceHash).toBe(contentHash("content"));
    expect(cache.translations[key].inputTokens).toBe(100);
    expect(cache.translations[key].outputTokens).toBe(200);
    expect(cache.translations[key].translatedAt).toBeTruthy();
  });

  it("overwrites an existing entry", () => {
    const cache: TranslationCache = {
      sourceHash: "",
      lastUpdated: "",
      translations: {
        "intro.mdx::zh": {
          sourceHash: "old",
          targetLang: "zh",
          translatedAt: "2024-01-01",
          inputTokens: 50,
          outputTokens: 50,
        },
      },
    };
    setCacheEntry(cache, "intro.mdx", "zh", "new content", 300, 400);

    const entry = cache.translations["intro.mdx::zh"];
    expect(entry.sourceHash).toBe(contentHash("new content"));
    expect(entry.inputTokens).toBe(300);
    expect(entry.outputTokens).toBe(400);
  });
});
