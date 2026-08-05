// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildMainReadmeLanguageLinks,
  rebaseReadmePaths,
} from "@/scripts/translate-docs/readme-translator";
import { LANGUAGES } from "@/scripts/translate-docs/config";

const RAW = "https://raw.githubusercontent.com/FailproofAI/failproofai/main";

describe("rebaseReadmePaths", () => {
  // The root README sits AT the repo root, so it writes repo-root-relative
  // paths. Its translations land in docs/i18n/, two levels down, where those
  // paths resolve to nothing — GitHub 404s and Mintlify (which also serves
  // these pages at /i18n/README.<lang>) 403s from S3. Every logo and the
  // architecture GIF were broken in all 14 languages until this rewrite.
  it("rewrites image paths to absolute raw URLs so both surfaces resolve", () => {
    expect(
      rebaseReadmePaths('<img src="assets/logos/claude.svg" width="56" />'),
    ).toBe(`<img src="${RAW}/assets/logos/claude.svg" width="56" />`);
    expect(rebaseReadmePaths("![demo](readme-arch-hq.gif)")).toBe(
      `![demo](${RAW}/readme-arch-hq.gif)`,
    );
  });

  it("rewrites document links to ../../ instead, where GitHub resolves them", () => {
    // A raw URL for a .md would serve unrendered plaintext, so links get the
    // relative form; GitHub is the only surface they work on either way.
    expect(rebaseReadmePaths("[LICENSE](./LICENSE)")).toBe(
      "[LICENSE](../../LICENSE)",
    );
    expect(rebaseReadmePaths("[中文](./docs/i18n/README.zh.md)")).toBe(
      "[中文](../../docs/i18n/README.zh.md)",
    );
  });

  it("preserves a fragment on a rewritten link", () => {
    expect(rebaseReadmePaths("[build](./CONTRIBUTING.md#build-first)")).toBe(
      "[build](../../CONTRIBUTING.md#build-first)",
    );
  });

  it("leaves absolute URLs, anchors, and other schemes alone", () => {
    const untouched =
      "[npm](https://www.npmjs.com/package/failproofai)\n" +
      '<img src="https://d2wq11aau0arks.cloudfront.net/failproof/logo.svg" />\n' +
      "[jump](#usage)\n" +
      "[mail](mailto:hi@befailproof.ai)\n" +
      "![inline](data:image/png;base64,iVBORw0KGgo=)\n" +
      "![site](/agenteye/images/alerts.png)";
    expect(rebaseReadmePaths(untouched)).toBe(untouched);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = rebaseReadmePaths(
      '<img src="assets/logos/pi-light.svg" />\n[LICENSE](./LICENSE)',
    );
    expect(rebaseReadmePaths(once)).toBe(once);
  });

  it("leaves paths inside fenced code blocks literal", () => {
    // There a path is sample text a reader copies, not a reference to resolve.
    const fenced =
      "```html\n" +
      '<img src="assets/logos/claude.svg" />\n' +
      "```\n" +
      '<img src="assets/logos/devin.svg" />';
    expect(rebaseReadmePaths(fenced)).toBe(
      "```html\n" +
        '<img src="assets/logos/claude.svg" />\n' +
        "```\n" +
        `<img src="${RAW}/assets/logos/devin.svg" />`,
    );
  });

  it("must run on the model output only, never on the assembled wrapper", () => {
    // Documents the call-site contract. The language selector already points at
    // docs/i18n/ siblings, so a bare `README.zh.md` there is CORRECT — running
    // this over it would rewrite it to a path one directory above the file and
    // break every selector link. `translateReadme` therefore rebases `raw`
    // before wrapping, not the assembled page.
    const selector = "[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md)";
    expect(rebaseReadmePaths(selector)).toBe(
      "[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](../../README.zh.md)",
    );
  });
});

describe("buildMainReadmeLanguageLinks", () => {
  it("returns a string starting with **Translations**:", () => {
    const result = buildMainReadmeLanguageLinks();
    expect(result).toMatch(/^\*\*Translations\*\*:/);
  });

  it("includes a link for every language in LANGUAGES", () => {
    const result = buildMainReadmeLanguageLinks();
    for (const lang of LANGUAGES) {
      expect(result).toContain(lang.nativeName);
      expect(result).toContain(`README.${lang.code}.md`);
    }
  });

  it("links point to docs/i18n/ directory", () => {
    const result = buildMainReadmeLanguageLinks();
    for (const lang of LANGUAGES) {
      expect(result).toContain(`docs/i18n/README.${lang.code}.md`);
    }
  });

  it("includes all 14 language links", () => {
    const result = buildMainReadmeLanguageLinks();
    // Count number of markdown links
    const linkCount = (result.match(/\[.*?\]\(.*?\)/g) || []).length;
    expect(linkCount).toBe(14);
  });

  it("uses pipe separators between links", () => {
    const result = buildMainReadmeLanguageLinks();
    expect(result).toContain(" | ");
  });
});
