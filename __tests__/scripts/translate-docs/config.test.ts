// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  LANGUAGES,
  getLanguagesByTier,
  getLanguageByCode,
  getLanguageCodes,
  getModelForTier,
  DO_NOT_TRANSLATE,
  NAV_TRANSLATIONS,
} from "@/scripts/translate-docs/config";

describe("LANGUAGES", () => {
  it("contains 14 languages", () => {
    expect(LANGUAGES).toHaveLength(14);
  });

  it("uses Mintlify's canonical locale without changing the folder code", () => {
    const portuguese = LANGUAGES.find((language) => language.code === "pt-br");

    expect(portuguese?.mintlifyCode).toBe("pt-BR");
  });

  it("has unique codes", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("assigns tiers 1-3", () => {
    const tiers = new Set(LANGUAGES.map((l) => l.tier));
    expect(tiers).toEqual(new Set([1, 2, 3]));
  });

  it("marks RTL languages", () => {
    const rtl = LANGUAGES.filter((l) => l.rtl);
    expect(rtl.map((l) => l.code).sort()).toEqual(["ar", "he"]);
  });
});

describe("getLanguagesByTier", () => {
  it("returns 7 tier-1 languages", () => {
    expect(getLanguagesByTier(1)).toHaveLength(7);
  });

  it("returns 12 tier-1+2 languages", () => {
    expect(getLanguagesByTier(2)).toHaveLength(12);
  });

  it("returns all 14 for tier 3", () => {
    expect(getLanguagesByTier(3)).toHaveLength(14);
  });
});

describe("getLanguageByCode", () => {
  it("finds a known language", () => {
    const ja = getLanguageByCode("ja");
    expect(ja).toBeDefined();
    expect(ja!.name).toBe("Japanese");
    expect(ja!.nativeName).toBe("日本語");
  });

  it("returns undefined for unknown code", () => {
    expect(getLanguageByCode("xx")).toBeUndefined();
  });
});

describe("getLanguageCodes", () => {
  it("returns all codes when no tier specified", () => {
    expect(getLanguageCodes()).toHaveLength(14);
  });

  it("filters by tier", () => {
    expect(getLanguageCodes(1)).toHaveLength(7);
  });
});

describe("getModelForTier", () => {
  it("returns Sonnet for tier 1", () => {
    expect(getModelForTier(1)).toBe("claude-sonnet-4-6");
  });

  it("returns Haiku for tier 2 and 3", () => {
    expect(getModelForTier(2)).toBe("claude-haiku-4-5");
    expect(getModelForTier(3)).toBe("claude-haiku-4-5");
  });

  it("uses model aliases (no dated snapshot suffix) so API keys scoped to the alias work", () => {
    for (const tier of [1, 2, 3]) {
      expect(getModelForTier(tier)).not.toMatch(/-\d{8}$/);
    }
  });
});

describe("DO_NOT_TRANSLATE", () => {
  it("includes key product names", () => {
    expect(DO_NOT_TRANSLATE).toContain("failproofai");
    expect(DO_NOT_TRANSLATE).toContain("Claude Code");
    expect(DO_NOT_TRANSLATE).toContain("Agents SDK");
  });

  it("includes CLI flags", () => {
    expect(DO_NOT_TRANSLATE).toContain("--install");
    expect(DO_NOT_TRANSLATE).toContain("--uninstall");
  });

  it("includes policy names", () => {
    expect(DO_NOT_TRANSLATE).toContain("block-sudo");
    expect(DO_NOT_TRANSLATE).toContain("sanitize-api-keys");
  });
});

describe(".gitattributes", () => {
  // The translated docs are 46% of this repo's tracked files. `.gitattributes`
  // marks them linguist-generated so they collapse in every diff and drop out
  // of the language bar. That list is hand-maintained, so adding a language to
  // LANGUAGES without adding it here would silently un-collapse the new locale
  // — a regression nobody would notice until a PR diff blew up months later.
  const gitattributes = readFileSync(
    join(import.meta.dirname, "..", "..", "..", ".gitattributes"),
    "utf8",
  );

  it("marks every translated docs directory as generated", () => {
    for (const { code } of LANGUAGES) {
      expect(
        gitattributes,
        `docs/${code}/** is missing a linguist-generated rule in .gitattributes`,
      ).toContain(`docs/${code}/**`);
    }
  });

  it("marks no directory that is not a real language", () => {
    const marked = [...gitattributes.matchAll(/^docs\/([^/*\s]+)\/\*\*/gm)].map(
      (m) => m[1],
    );
    expect(marked.sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  it("marks the translated READMEs and both lockfiles", () => {
    expect(gitattributes).toContain("docs/i18n/README.*.md");
    expect(gitattributes).toContain("bun.lock");
    expect(gitattributes).toContain("Cargo.lock");
  });
});

describe("NAV_TRANSLATIONS", () => {
  it("has entries for all 14 languages plus English", () => {
    const expectedCodes = ["en", ...LANGUAGES.map((l) => l.code)];
    for (const code of expectedCodes) {
      expect(NAV_TRANSLATIONS[code]).toBeDefined();
      expect(NAV_TRANSLATIONS[code].docs).toBeTruthy();
      expect(NAV_TRANSLATIONS[code].gettingStarted).toBeTruthy();
      expect(NAV_TRANSLATIONS[code].cli).toBe("CLI"); // CLI stays as-is in all languages
    }
  });
});
