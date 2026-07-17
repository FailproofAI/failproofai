// @vitest-environment node
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLanguageNav,
  generateLanguagesArray,
  getNavigationPageReferences,
  localizeProductsNavigation,
  readDocsConfig,
} from "@/scripts/translate-docs/mintlify-nav";

const DOCS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
);

describe("docs.json redirects", () => {
  interface Redirect {
    source: string;
    destination: string;
  }
  const redirects = (readDocsConfig().redirects ?? []) as Redirect[];

  it("points every redirect at a page that exists", () => {
    const broken = redirects.filter(
      (r) => !existsSync(join(DOCS_DIR, `${r.destination}.mdx`)),
    );
    expect(broken).toEqual([]);
  });

  it("never shadows a live page with a redirect", () => {
    // A redirect whose source still resolves to a real .mdx would make that
    // page permanently unreachable.
    const shadowing = redirects.filter((r) =>
      existsSync(join(DOCS_DIR, `${r.source}.mdx`)),
    );
    expect(shadowing).toEqual([]);
  });
});

const sampleEnglishTabs = [
  {
    tab: "Docs",
    groups: [
      {
        group: "Getting Started",
        pages: ["introduction", "getting-started"],
      },
      {
        group: "Core Concepts",
        pages: ["built-in-policies", "custom-policies"],
      },
      {
        group: "CLI",
        pages: ["cli/dashboard", "cli/install-policies"],
      },
    ],
  },
  {
    tab: "Examples",
    groups: [
      {
        group: "Examples",
        pages: ["examples"],
      },
    ],
  },
];

describe("buildLanguageNav", () => {
  it("prefixes all page paths with the language code", () => {
    const nav = buildLanguageNav(sampleEnglishTabs, "es");
    const allPages = nav.tabs.flatMap((t) => t.groups.flatMap((g) => g.pages));
    for (const page of allPages) {
      expect(page).toMatch(/^es\//);
    }
  });

  it("translates tab names", () => {
    const nav = buildLanguageNav(sampleEnglishTabs, "es");
    expect(nav.tabs[0].tab).toBe("Documentaci\u00f3n");
    expect(nav.tabs[1].tab).toBe("Ejemplos");
  });

  it("translates group names", () => {
    const nav = buildLanguageNav(sampleEnglishTabs, "ja");
    const groups = nav.tabs[0].groups;
    expect(groups[0].group).toBe("\u306f\u3058\u3081\u306b");
    expect(groups[1].group).toBe("\u57fa\u672c\u6982\u5ff5");
    expect(groups[2].group).toBe("CLI");
  });

  it("keeps CLI as-is for all languages", () => {
    for (const lang of ["zh", "ja", "ko", "es", "de", "fr", "ar"]) {
      const nav = buildLanguageNav(sampleEnglishTabs, lang);
      const cliGroup = nav.tabs[0].groups.find((g) => g.group === "CLI");
      expect(cliGroup).toBeDefined();
    }
  });

  it("sets the language code", () => {
    const nav = buildLanguageNav(sampleEnglishTabs, "ko");
    expect(nav.language).toBe("ko");
  });

  it("preserves nested page paths with prefix", () => {
    const nav = buildLanguageNav(sampleEnglishTabs, "zh");
    const cliGroup = nav.tabs[0].groups.find((g) => g.group === "CLI");
    expect(cliGroup!.pages).toContain("zh/cli/dashboard");
    expect(cliGroup!.pages).toContain("zh/cli/install-policies");
  });

  it("throws for unknown language code", () => {
    expect(() => buildLanguageNav(sampleEnglishTabs, "xx")).toThrow(
      "No nav translations for language: xx",
    );
  });
});

describe("generateLanguagesArray", () => {
  it("puts English first as default language", () => {
    const langs = generateLanguagesArray(sampleEnglishTabs, ["es", "ja"]);
    expect(langs[0].language).toBe("en");
  });

  it("includes English tabs unchanged (no prefix)", () => {
    const langs = generateLanguagesArray(sampleEnglishTabs, ["es"]);
    const enPages = langs[0].tabs.flatMap((t) =>
      t.groups.flatMap((g) => g.pages),
    );
    // English pages should NOT have any prefix
    for (const page of enPages) {
      expect(page).not.toMatch(/^en\//);
    }
  });

  it("creates entries for each requested language", () => {
    const langs = generateLanguagesArray(sampleEnglishTabs, ["es", "ja", "zh"]);
    expect(langs).toHaveLength(4); // en + 3
    expect(langs.map((l) => l.language)).toEqual(["en", "es", "ja", "zh"]);
  });

  it("each language has the same number of tabs and groups", () => {
    const langs = generateLanguagesArray(sampleEnglishTabs, ["fr", "de"]);
    for (const lang of langs) {
      expect(lang.tabs).toHaveLength(sampleEnglishTabs.length);
      for (let i = 0; i < sampleEnglishTabs.length; i++) {
        expect(lang.tabs[i].groups).toHaveLength(
          sampleEnglishTabs[i].groups.length,
        );
      }
    }
  });

  it("each non-English language has prefixed page paths", () => {
    const langs = generateLanguagesArray(sampleEnglishTabs, ["ko"]);
    const koPages = langs[1].tabs.flatMap((t) =>
      t.groups.flatMap((g) => g.pages),
    );
    for (const page of koPages) {
      expect(page).toMatch(/^ko\//);
    }
  });
});

describe("getNavigationPageReferences", () => {
  it("collects localized and English-only product pages", () => {
    const references = getNavigationPageReferences({
      products: [
        {
          product: "FailproofAI",
          languages: [
            { language: "en", tabs: sampleEnglishTabs },
            {
              language: "es",
              tabs: [
                {
                  tab: "Documentación",
                  groups: [{ group: "Inicio", pages: ["es/introduction"] }],
                },
              ],
            },
          ],
        },
        {
          product: "AgentEye",
          tabs: [
            {
              tab: "Docs",
              groups: [{ group: "Start", pages: ["agenteye/getting-started"] }],
            },
          ],
        },
      ],
    });

    expect(references).toContainEqual({
      page: "introduction",
      language: "en",
    });
    expect(references).toContainEqual({
      page: "es/introduction",
      language: "es",
    });
    expect(references).toContainEqual({
      page: "agenteye/getting-started",
      language: undefined,
    });
  });
});

describe("localizeProductsNavigation", () => {
  it("converts an English-only product to localized navigation", () => {
    const [product] = localizeProductsNavigation(
      [
        {
          product: "AgentEye",
          icon: "eye",
          tabs: [
            {
              tab: "Docs",
              groups: [
                { group: "Getting Started", pages: ["agenteye/overview"] },
              ],
            },
          ],
        },
      ],
      ["es", "ja"],
    );

    expect(product.tabs).toBeUndefined();
    const languages = product.languages as Array<{
      language: string;
      tabs: typeof sampleEnglishTabs;
    }>;
    expect(languages.map((entry) => entry.language)).toEqual([
      "en",
      "es",
      "ja",
    ]);
    expect(languages[1].tabs[0].groups[0].pages).toEqual([
      "es/agenteye/overview",
    ]);
  });

  it("uses Mintlify's canonical Portuguese locale with existing paths", () => {
    const portuguese = buildLanguageNav(sampleEnglishTabs, "pt-br");

    expect(portuguese.language).toBe("pt-BR");
    expect(portuguese.tabs[0].groups[0].pages[0]).toBe("pt-br/introduction");
  });
});
