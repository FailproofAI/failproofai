import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageByCode, NAV_TRANSLATIONS, LANGUAGES } from "./config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_JSON_PATH = join(__dirname, "..", "..", "docs", "docs.json");

interface NavGroup {
  group: string;
  pages: string[];
}

interface NavTab {
  tab: string;
  groups: NavGroup[];
}

interface LanguageNav {
  language: string;
  tabs: NavTab[];
}

export interface NavigationPageReference {
  page: string;
  language?: string;
}

/** Collect page references from flat, localized, or multi-product navigation. */
export function getNavigationPageReferences(
  navigation: unknown,
): NavigationPageReference[] {
  const references: NavigationPageReference[] = [];
  const childKeys = [
    "products",
    "languages",
    "tabs",
    "groups",
    "anchors",
    "dropdowns",
    "versions",
    "menu",
  ];

  function walk(value: unknown, inheritedLanguage?: string): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inheritedLanguage);
      return;
    }
    if (!value || typeof value !== "object") return;

    const entry = value as Record<string, unknown>;
    const language =
      typeof entry.language === "string" ? entry.language : inheritedLanguage;

    if (Array.isArray(entry.pages)) {
      for (const page of entry.pages) {
        if (typeof page === "string") {
          references.push({ page, language });
        } else {
          walk(page, language);
        }
      }
    }

    for (const key of childKeys) {
      if (key !== "pages" && entry[key]) walk(entry[key], language);
    }
  }

  walk(navigation);
  return references;
}

/**
 * Build a navigation entry for a specific language by transforming the
 * English navigation structure.
 */
export function buildLanguageNav(
  englishTabs: NavTab[],
  lang: string,
): LanguageNav {
  const t = NAV_TRANSLATIONS[lang];
  if (!t) throw new Error(`No nav translations for language: ${lang}`);

  const groupNameMap: Record<string, string> = {
    "Getting Started": t.gettingStarted,
    "Core Concepts": t.coreConcepts,
    CLI: t.cli,
    Tools: t.tools,
    Advanced: t.advanced,
    Examples: t.examples,
  };

  const tabNameMap: Record<string, string> = {
    Docs: t.docs,
    Examples: t.examples,
  };

  const tabs: NavTab[] = englishTabs.map((tab) => ({
    tab: tabNameMap[tab.tab] || tab.tab,
    groups: tab.groups.map((group) => ({
      group: groupNameMap[group.group] || group.group,
      pages: group.pages.map((page) => `${lang}/${page}`),
    })),
  }));

  return {
    language: getLanguageByCode(lang)?.mintlifyCode ?? lang,
    tabs,
  };
}

/**
 * Read the current docs.json config.
 */
export function readDocsConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(DOCS_JSON_PATH, "utf-8"));
}

/**
 * Generate the full languages array for docs.json from the English nav
 * and a list of language codes.
 */
export function generateLanguagesArray(
  englishTabs: NavTab[],
  langCodes: string[],
): LanguageNav[] {
  // English first (default)
  const english: LanguageNav = { language: "en", tabs: englishTabs };
  const others = langCodes.map((code) => buildLanguageNav(englishTabs, code));
  return [english, ...others];
}

/** Localize every product that has English tabs or an English language entry. */
export function localizeProductsNavigation(
  products: unknown[],
  langCodes: string[],
): Record<string, unknown>[] {
  return products.map((value) => {
    const product = value as Record<string, unknown>;
    const existingLanguages = product.languages as LanguageNav[] | undefined;
    const englishTabs = existingLanguages
      ? existingLanguages.find((entry) => entry.language === "en")?.tabs
      : (product.tabs as NavTab[] | undefined);

    if (!englishTabs) return product;

    const { tabs: _tabs, ...rest } = product;
    return {
      ...rest,
      languages: generateLanguagesArray(englishTabs, langCodes),
    };
  });
}

/**
 * Update docs.json to use the languages array structure.
 */
export function updateDocsJson(langCodes: string[]): void {
  const config = readDocsConfig();
  const nav = config.navigation as Record<string, unknown>;

  if (Array.isArray(nav.products)) {
    nav.products = localizeProductsNavigation(nav.products, langCodes);
    config.navigation = nav;
    writeFileSync(DOCS_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
    return;
  }

  const existingLanguages = nav.languages as LanguageNav[] | undefined;
  const englishTabs = existingLanguages
    ? existingLanguages.find((entry) => entry.language === "en")?.tabs
    : (nav.tabs as NavTab[] | undefined);
  if (!englishTabs) {
    throw new Error("No English navigation tabs found in docs.json");
  }

  const newNav: Record<string, unknown> = {
    languages: generateLanguagesArray(englishTabs, langCodes),
  };
  if (nav.global) {
    newNav.global = nav.global;
  }

  config.navigation = newNav;
  writeFileSync(DOCS_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
}
