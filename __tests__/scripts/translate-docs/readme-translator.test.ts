// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// Stub the model call so `translateReadme` runs its real render pipeline over a
// fixed "translation", and stub the writes so the test never touches the repo's
// own docs/i18n/ files. Everything between — the sanitizers, the rebase, the
// wrapper assembly, and the real validator — runs unmocked.
vi.mock("@/scripts/translate-docs/translator", () => ({
  translateValidated: vi.fn(
    async (opts: {
      render: (raw: string) => string;
      validate: (rendered: string) => Promise<string | null>;
    }) => {
      const rendered = opts.render(RAW_TRANSLATION);
      const error = await opts.validate(rendered);
      if (error) throw new Error(`fixture failed validation: ${error}`);
      return { rendered, inputTokens: 0, outputTokens: 0, attempts: 1 };
    },
  ),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

/** Stands in for the model's output: the shapes the real README emits. */
const RAW_TRANSLATION = [
  "# 失败保护 AI",
  "",
  "<picture>",
  '  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />',
  '  <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" />',
  "</picture>",
  "",
  "详情见 [LICENSE](./LICENSE)。",
].join("\n");

import { writeFileSync } from "node:fs";
import { translateReadme } from "@/scripts/translate-docs/readme-translator";
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

  it("rewrites srcset, where the dark-mode logo of every <picture> lives", () => {
    // Each logo cell pairs an <img src> with a dark-mode <source srcset>.
    // Rewriting only `src` leaves the table half-broken for dark-theme readers
    // — the half least likely to be caught by eye in review.
    expect(
      rebaseReadmePaths(
        '<source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />',
      ),
    ).toBe(
      `<source media="(prefers-color-scheme: dark)" srcset="${RAW}/assets/logos/openai-dark.svg" />`,
    );
  });

  it("rebases every srcset candidate, keeping its descriptor and spacing", () => {
    expect(
      rebaseReadmePaths(
        '<source srcset="assets/logos/pi-dark.svg 1x, assets/logos/pi-dark@2x.png 2x" />',
      ),
    ).toBe(
      `<source srcset="${RAW}/assets/logos/pi-dark.svg 1x, ${RAW}/assets/logos/pi-dark@2x.png 2x" />`,
    );
  });

  it("leaves an already-absolute srcset candidate alone", () => {
    const abs = '<source srcset="https://cdn.example.com/logo.svg 2x" />';
    expect(rebaseReadmePaths(abs)).toBe(abs);
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

  it("does not close a fence on a line carrying an info string", () => {
    // CommonMark allows an info string on an OPENING fence only. Treating
    // ```` ```ts ```` as a close would end the block early and expose the
    // sample paths after it to rewriting.
    const fenced =
      "````md\n" +
      "```ts\n" +
      '<img src="assets/logos/claude.svg" />\n' +
      "```\n" +
      "````\n" +
      '<img src="assets/logos/devin.svg" />';
    expect(rebaseReadmePaths(fenced)).toBe(
      "````md\n" +
        "```ts\n" +
        '<img src="assets/logos/claude.svg" />\n' +
        "```\n" +
        "````\n" +
        `<img src="${RAW}/assets/logos/devin.svg" />`,
    );
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

describe("translateReadme — rebase call site", () => {
  // rebaseReadmePaths is only correct if it runs on the model output BEFORE the
  // wrapper is attached. The unit tests above pin the function; these pin the
  // ordering, which is what a future refactor would silently get wrong.
  const write = vi.mocked(writeFileSync);

  const renderOnce = async (): Promise<string> => {
    write.mockClear();
    // A caller-supplied cache keeps translateReadme off the on-disk one.
    await translateReadme("zh", {
      force: true,
      cache: { sourceHash: "", lastUpdated: "", translations: {} },
    });
    expect(write).toHaveBeenCalledTimes(1);
    return write.mock.calls[0][1] as string;
  };

  it("rebases the body's src, srcset, and document links", async () => {
    const out = await renderOnce();
    expect(out).toContain(`src="${RAW}/assets/logos/openai-light.svg"`);
    expect(out).toContain(`srcset="${RAW}/assets/logos/openai-dark.svg"`);
    expect(out).toContain("[LICENSE](../../LICENSE)");
    expect(out).not.toContain('src="assets/logos/');
    expect(out).not.toContain('srcset="assets/logos/');
  });

  it("leaves the language selector's sibling links untouched", async () => {
    const out = await renderOnce();
    // Written by buildLanguageSelector AFTER the rebase, already relative to
    // docs/i18n/. A `../../README.ja.md` here would point one level too high.
    expect(out).toContain("](README.ja.md)");
    expect(out).toContain("](../../README.md)");
    expect(out).not.toContain("](../../README.ja.md)");
  });

  it("writes to docs/i18n/README.<lang>.md", async () => {
    await renderOnce();
    expect(String(write.mock.calls[0][0])).toMatch(
      /docs[/\\]i18n[/\\]README\.zh\.md$/,
    );
  });
});
