import type { LanguageConfig } from "./types";

export const LANGUAGES: LanguageConfig[] = [
  // Tier 1 — largest developer populations
  { code: "zh", name: "Chinese (Simplified)", nativeName: "\u7b80\u4f53\u4e2d\u6587", tier: 1 },
  { code: "ja", name: "Japanese", nativeName: "\u65e5\u672c\u8a9e", tier: 1 },
  { code: "ko", name: "Korean", nativeName: "\ud55c\uad6d\uc5b4", tier: 1 },
  { code: "es", name: "Spanish", nativeName: "Espa\u00f1ol", tier: 1 },
  { code: "pt-br", name: "Portuguese (Brazil)", nativeName: "Portugu\u00eas", tier: 1 },
  { code: "de", name: "German", nativeName: "Deutsch", tier: 1 },
  { code: "fr", name: "French", nativeName: "Fran\u00e7ais", tier: 1 },
  // Tier 2 — strong tech communities
  { code: "ru", name: "Russian", nativeName: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", tier: 2 },
  { code: "hi", name: "Hindi", nativeName: "\u0939\u093f\u0928\u094d\u0926\u0940", tier: 2 },
  { code: "tr", name: "Turkish", nativeName: "T\u00fcrk\u00e7e", tier: 2 },
  { code: "vi", name: "Vietnamese", nativeName: "Ti\u1ebfng Vi\u1ec7t", tier: 2 },
  { code: "it", name: "Italian", nativeName: "Italiano", tier: 2 },
  // Tier 3 — RTL languages
  { code: "ar", name: "Arabic", nativeName: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629", tier: 3, rtl: true },
  { code: "he", name: "Hebrew", nativeName: "\u05e2\u05d1\u05e8\u05d9\u05ea", tier: 3, rtl: true },
];

export function getLanguagesByTier(maxTier: number): LanguageConfig[] {
  return LANGUAGES.filter((l) => l.tier <= maxTier);
}

export function getLanguageByCode(code: string): LanguageConfig | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

export function getLanguageCodes(maxTier?: number): string[] {
  const langs = maxTier ? getLanguagesByTier(maxTier) : LANGUAGES;
  return langs.map((l) => l.code);
}

/** Return the default model for a given tier. Tier 1 gets Sonnet, Tier 2/3 gets Haiku. */
export function getModelForTier(tier: number): string {
  return tier <= 1 ? "claude-sonnet-4-6" : "claude-haiku-4-5";
}

/** Terms that should never be translated — kept as-is in all languages. */
export const DO_NOT_TRANSLATE = [
  "failproofai",
  "Failproof AI",
  "FailproofAI",
  "Claude Code",
  "Agents SDK",
  "Claude",
  "Anthropic",
  "Node.js",
  "Bun",
  "npm",
  "npx",
  "MDX",
  "JSON",
  "JSONL",
  "ESM",
  "CJS",
  "settings.json",
  "policies-config.json",
  "policies-config.local.json",
  "hook-activity.jsonl",
  "hook.log",
  "dist/index.js",
  ".failproofai",
  "~/.failproofai",
  "~/.claude",
  // CLI commands and flags
  "failproofai policies --install",
  "failproofai policies --uninstall",
  "--install",
  "--uninstall",
  "--scope",
  "--port",
  "--strict",
  "--allowed-origins",
  // Policy names
  "block-sudo",
  "block-rm-rf",
  "sanitize-api-keys",
  "prevent-secret-leakage",
  "block-force-push",
  "restrict-to-project",
  "detect-loops",
  // Technical terms
  "PreToolUse",
  "PostToolUse",
  "PreNotification",
  "PostNotification",
  "allow",
  "deny",
  "instruct",
  "customPolicies",
  "localhost",
  "stdin",
  "stdout",
];

/** Navigation group translations for each language. */
export const NAV_TRANSLATIONS: Record<
  string,
  {
    docs: string;
    examples: string;
    gettingStarted: string;
    coreConcepts: string;
    cli: string;
    tools: string;
    advanced: string;
  }
> = {
  en: {
    docs: "Docs",
    examples: "Examples",
    gettingStarted: "Getting Started",
    coreConcepts: "Core Concepts",
    cli: "CLI",
    tools: "Tools",
    advanced: "Advanced",
  },
  zh: {
    docs: "\u6587\u6863",
    examples: "\u793a\u4f8b",
    gettingStarted: "\u5feb\u901f\u5f00\u59cb",
    coreConcepts: "\u6838\u5fc3\u6982\u5ff5",
    cli: "CLI",
    tools: "\u5de5\u5177",
    advanced: "\u8fdb\u9636",
  },
  ja: {
    docs: "\u30c9\u30ad\u30e5\u30e1\u30f3\u30c8",
    examples: "\u4f8b",
    gettingStarted: "\u306f\u3058\u3081\u306b",
    coreConcepts: "\u57fa\u672c\u6982\u5ff5",
    cli: "CLI",
    tools: "\u30c4\u30fc\u30eb",
    advanced: "\u4e0a\u7d1a",
  },
  ko: {
    docs: "\ubb38\uc11c",
    examples: "\uc608\uc81c",
    gettingStarted: "\uc2dc\uc791\ud558\uae30",
    coreConcepts: "\ud575\uc2ec \uac1c\ub150",
    cli: "CLI",
    tools: "\ub3c4\uad6c",
    advanced: "\uace0\uae09",
  },
  es: {
    docs: "Documentaci\u00f3n",
    examples: "Ejemplos",
    gettingStarted: "Primeros pasos",
    coreConcepts: "Conceptos principales",
    cli: "CLI",
    tools: "Herramientas",
    advanced: "Avanzado",
  },
  "pt-br": {
    docs: "Documenta\u00e7\u00e3o",
    examples: "Exemplos",
    gettingStarted: "Come\u00e7ando",
    coreConcepts: "Conceitos principais",
    cli: "CLI",
    tools: "Ferramentas",
    advanced: "Avan\u00e7ado",
  },
  de: {
    docs: "Dokumentation",
    examples: "Beispiele",
    gettingStarted: "Erste Schritte",
    coreConcepts: "Kernkonzepte",
    cli: "CLI",
    tools: "Werkzeuge",
    advanced: "Fortgeschritten",
  },
  fr: {
    docs: "Documentation",
    examples: "Exemples",
    gettingStarted: "D\u00e9marrage",
    coreConcepts: "Concepts cl\u00e9s",
    cli: "CLI",
    tools: "Outils",
    advanced: "Avanc\u00e9",
  },
  ru: {
    docs: "\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430\u0446\u0438\u044f",
    examples: "\u041f\u0440\u0438\u043c\u0435\u0440\u044b",
    gettingStarted: "\u041d\u0430\u0447\u0430\u043b\u043e \u0440\u0430\u0431\u043e\u0442\u044b",
    coreConcepts: "\u041e\u0441\u043d\u043e\u0432\u043d\u044b\u0435 \u043a\u043e\u043d\u0446\u0435\u043f\u0446\u0438\u0438",
    cli: "CLI",
    tools: "\u0418\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u044b",
    advanced: "\u041f\u0440\u043e\u0434\u0432\u0438\u043d\u0443\u0442\u044b\u0439",
  },
  hi: {
    docs: "\u0926\u0938\u094d\u0924\u093e\u0935\u0947\u091c\u093c",
    examples: "\u0909\u0926\u093e\u0939\u0930\u0923",
    gettingStarted: "\u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902",
    coreConcepts: "\u092e\u0942\u0932 \u0905\u0935\u0927\u093e\u0930\u0923\u093e\u090f\u0901",
    cli: "CLI",
    tools: "\u0909\u092a\u0915\u0930\u0923",
    advanced: "\u0909\u0928\u094d\u0928\u0924",
  },
  tr: {
    docs: "Belgeler",
    examples: "\u00d6rnekler",
    gettingStarted: "Ba\u015flang\u0131\u00e7",
    coreConcepts: "Temel Kavramlar",
    cli: "CLI",
    tools: "Ara\u00e7lar",
    advanced: "Geli\u015fmi\u015f",
  },
  vi: {
    docs: "T\u00e0i li\u1ec7u",
    examples: "V\u00ed d\u1ee5",
    gettingStarted: "B\u1eaft \u0111\u1ea7u",
    coreConcepts: "Kh\u00e1i ni\u1ec7m c\u1ed1t l\u00f5i",
    cli: "CLI",
    tools: "C\u00f4ng c\u1ee5",
    advanced: "N\u00e2ng cao",
  },
  it: {
    docs: "Documentazione",
    examples: "Esempi",
    gettingStarted: "Per iniziare",
    coreConcepts: "Concetti chiave",
    cli: "CLI",
    tools: "Strumenti",
    advanced: "Avanzato",
  },
  ar: {
    docs: "\u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a",
    examples: "\u0623\u0645\u062b\u0644\u0629",
    gettingStarted: "\u0627\u0644\u0628\u062f\u0627\u064a\u0629",
    coreConcepts: "\u0627\u0644\u0645\u0641\u0627\u0647\u064a\u0645 \u0627\u0644\u0623\u0633\u0627\u0633\u064a\u0629",
    cli: "CLI",
    tools: "\u0627\u0644\u0623\u062f\u0648\u0627\u062a",
    advanced: "\u0645\u062a\u0642\u062f\u0645",
  },
  he: {
    docs: "\u05ea\u05d9\u05e2\u05d5\u05d3",
    examples: "\u05d3\u05d5\u05d2\u05de\u05d0\u05d5\u05ea",
    gettingStarted: "\u05ea\u05d7\u05d9\u05dc\u05ea \u05e2\u05d1\u05d5\u05d3\u05d4",
    coreConcepts: "\u05de\u05d5\u05e9\u05d2\u05d9 \u05d9\u05e1\u05d5\u05d3",
    cli: "CLI",
    tools: "\u05db\u05dc\u05d9\u05dd",
    advanced: "\u05de\u05ea\u05e7\u05d3\u05dd",
  },
};
