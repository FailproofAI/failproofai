// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  rewriteInternalLinks,
  sanitizeJsxAttributes,
  stripStrayTrailingFence,
  convertHtmlComments,
  getEnglishMdxPages,
} from "@/scripts/translate-docs/mdx-translator";

describe("getEnglishMdxPages", () => {
  it("includes AgentEye pages in automatic translation", () => {
    const pages = getEnglishMdxPages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((page) => page.includes("/agenteye/"))).toBe(true);
  });
});

describe("rewriteInternalLinks", () => {
  it("rewrites MDX component href attributes with language prefix", () => {
    const input = `<Card title="Policies" href="/built-in-policies">`;
    const result = rewriteInternalLinks(input, "es");
    expect(result).toBe(`<Card title="Policies" href="/es/built-in-policies">`);
  });

  it("rewrites Markdown links with language prefix", () => {
    const input = `See the [Getting started](/getting-started) guide.`;
    const result = rewriteInternalLinks(input, "ja");
    expect(result).toBe(
      `See the [Getting started](/ja/getting-started) guide.`,
    );
  });

  it("rewrites nested paths", () => {
    const input = `<Card href="/cli/dashboard">Dashboard</Card>`;
    const result = rewriteInternalLinks(input, "zh");
    expect(result).toBe(`<Card href="/zh/cli/dashboard">Dashboard</Card>`);
  });

  it("does not rewrite root-only href", () => {
    const input = `<a href="/">Home</a>`;
    const result = rewriteInternalLinks(input, "es");
    expect(result).toBe(`<a href="/">Home</a>`);
  });

  it("does not rewrite external URLs starting with /http", () => {
    // This edge case shouldn't normally occur in well-formed content,
    // but the function guards against it
    const input = `[link](/http-something)`;
    const result = rewriteInternalLinks(input, "es");
    expect(result).toBe(`[link](/http-something)`);
  });

  it("rewrites multiple links in the same content", () => {
    const input = `
<Card href="/built-in-policies">Policies</Card>
<Card href="/custom-policies">Custom</Card>
See [config](/configuration) and [testing](/testing).
`;
    const result = rewriteInternalLinks(input, "fr");
    expect(result).toContain(`href="/fr/built-in-policies"`);
    expect(result).toContain(`href="/fr/custom-policies"`);
    expect(result).toContain(`(/fr/configuration)`);
    expect(result).toContain(`(/fr/testing)`);
  });

  it("preserves external Markdown links", () => {
    // External links don't start with /
    const input = `[GitHub](https://github.com/example)`;
    const result = rewriteInternalLinks(input, "de");
    expect(result).toBe(`[GitHub](https://github.com/example)`);
  });

  it("preserves anchor-only links", () => {
    const input = `[section](#requirements)`;
    const result = rewriteInternalLinks(input, "ko");
    expect(result).toBe(`[section](#requirements)`);
  });

  it("handles paths with anchors", () => {
    const input = `[link](/getting-started#install)`;
    const result = rewriteInternalLinks(input, "es");
    expect(result).toBe(`[link](/es/getting-started#install)`);
  });

  it("preserves shared AgentEye image paths", () => {
    const input = `![Dashboard](/agenteye/images/dashboard-fleet.png)`;
    expect(rewriteInternalLinks(input, "es")).toBe(input);
  });
});

describe("sanitizeJsxAttributes", () => {
  it("strips stray trailing ASCII quotes after a JSX attribute close", () => {
    // The exact failure mode that broke `mintlify validate` on de/dashboard.mdx
    const input = `  <Tab title="Tab „Richtlinien"">`;
    const result = sanitizeJsxAttributes(input);
    expect(result).toBe(`  <Tab title="Tab Richtlinien">`);
  });

  it("strips trailing extras when attribute is followed by a self-close", () => {
    const input = `<Tab title="Foo bar"" />`;
    const result = sanitizeJsxAttributes(input);
    expect(result).toBe(`<Tab title="Foo bar" />`);
  });

  it("strips trailing extras when attribute is followed by another attribute", () => {
    const input = `<Card title="Hello"" icon="rocket">`;
    const result = sanitizeJsxAttributes(input);
    expect(result).toBe(`<Card title="Hello" icon="rocket">`);
  });

  it("leaves well-formed attributes untouched", () => {
    const input = `<Tab title="Activity tab">\n<Card title="Hello" href="/foo">`;
    expect(sanitizeJsxAttributes(input)).toBe(input);
  });

  it("preserves matched typographic quote pairs", () => {
    // Japanese 「…」 has matched open/close so should NOT be stripped even if
    // there were stray ASCII trailing quotes — though here there are none.
    const input = `<Tab title="「ポリシー」タブ">`;
    expect(sanitizeJsxAttributes(input)).toBe(input);
  });

  it("strips unmatched typographic opening quotes when extras are present", () => {
    // German „ without a matching " (U+201D) — drop the dangling open
    const input = `<Tab title="Tab „Aktivität"">`;
    expect(sanitizeJsxAttributes(input)).toBe(`<Tab title="Tab Aktivität">`);
  });

  it("drops only the surplus opener when a matched pair is also present", () => {
    // One properly matched „…“ German pair plus one dangling „ — keep the
    // pair, strip only the unmatched trailing opener.
    const input = `<Tab title="„Foo“ und „Bar"">`;
    expect(sanitizeJsxAttributes(input)).toBe(`<Tab title="„Foo“ und Bar">`);
  });

  it("does not mangle empty attributes", () => {
    const input = `<Tag attr="">`;
    expect(sanitizeJsxAttributes(input)).toBe(input);
  });

  it("handles multiple malformed attributes on the same line", () => {
    const input = `<Tabs><Tab title="A"" /><Tab title="B"" /></Tabs>`;
    const result = sanitizeJsxAttributes(input);
    expect(result).toBe(`<Tabs><Tab title="A" /><Tab title="B" /></Tabs>`);
  });
});

describe("stripStrayTrailingFence", () => {
  it("leaves balanced fences untouched", () => {
    const input = "intro\n\n```ts\nconst x = 1;\n```\n\noutro\n";
    expect(stripStrayTrailingFence(input)).toBe(input);
  });

  it("returns input unchanged when no fences", () => {
    const input = "Just some prose with `inline code` and no fences.\n";
    expect(stripStrayTrailingFence(input)).toBe(input);
  });

  it("strips a stray trailing fence after a balanced pair", () => {
    const input = "intro\n\n```ts\nconst x = 1;\n```\n\noutro\n```\n";
    const expected = "intro\n\n```ts\nconst x = 1;\n```\n\noutro\n";
    expect(stripStrayTrailingFence(input)).toBe(expected);
  });

  it("strips the lone fence when there's only one (odd count of one)", () => {
    const input = "preamble\n\n```\nuncertain\nepilogue\n";
    expect(stripStrayTrailingFence(input)).toBe(
      "preamble\n\nuncertain\nepilogue\n",
    );
  });

  it("only matches fence markers at start of line", () => {
    // An inline ``` mid-line is not a fence marker; should not be counted.
    const input = "text with embedded ```not-a-fence``` mid-line\n";
    expect(stripStrayTrailingFence(input)).toBe(input);
  });

  it("preserves balanced pairs with language tags", () => {
    const input = "```ts\nfoo\n```\n\n```bash\nbar\n```\n";
    expect(stripStrayTrailingFence(input)).toBe(input);
  });

  it("does not count quad-tick fence markers as triple-tick fences", () => {
    // 4-tick block ```` ... ```` legally contains ``` as content; only the
    // 4-tick lines are real markers and should not be counted by the helper.
    const input = "````\ninner ``` content\n````\n";
    expect(stripStrayTrailingFence(input)).toBe(input);
  });
});

describe("convertHtmlComments", () => {
  it("converts a single-line HTML comment to an MDX comment", () => {
    expect(convertHtmlComments("<!-- hello -->")).toBe("{/* hello */}");
  });

  it("converts a multi-line HTML comment, preserving inner content", () => {
    const input =
      "## Heading\n\n<!-- A note about the\n     table layout below. -->\n<table></table>\n";
    const expected =
      "## Heading\n\n{/* A note about the\n     table layout below. */}\n<table></table>\n";
    expect(convertHtmlComments(input)).toBe(expected);
  });

  it("keeps HTML that only looks like a comment inside inline text intact", () => {
    // Regression guard for the real README note that mentions `<img>`.
    const input = "<!-- prefer a table over inline <img> runs -->";
    expect(convertHtmlComments(input)).toBe(
      "{/* prefer a table over inline <img> runs */}",
    );
  });

  it("leaves HTML comments inside fenced code blocks untouched", () => {
    // A plist sample in a ```xml fence must stay literal — MDX does not parse
    // fenced content, so the collector-installation docs are already valid.
    const input =
      "```xml\n<!-- ~/Library/LaunchAgents/foo.plist -->\n<plist></plist>\n```\n";
    expect(convertHtmlComments(input)).toBe(input);
  });

  it("converts a top-level comment but not one nested in a later fence", () => {
    const input =
      "<!-- top note -->\n\n```html\n<!-- literal sample -->\n```\n";
    const expected =
      "{/* top note */}\n\n```html\n<!-- literal sample -->\n```\n";
    expect(convertHtmlComments(input)).toBe(expected);
  });

  it("neutralizes a `*/` inside the body so the MDX comment can't close early", () => {
    expect(convertHtmlComments("<!-- a */ b -->")).toBe("{/* a * / b */}");
  });

  it("returns content with no comments unchanged", () => {
    const input = "# Title\n\nJust prose, no comments here.\n";
    expect(convertHtmlComments(input)).toBe(input);
  });

  it("converts a top-level comment after a ```` block that embeds ```", () => {
    // A generic fence toggle would count the inner ``` as a boundary and leave
    // this comment mis-flagged as inside a fence, breaking the deploy.
    const input = "````\ninner ``` fence\n````\n\n<!-- note -->\n";
    const expected = "````\ninner ``` fence\n````\n\n{/* note */}\n";
    expect(convertHtmlComments(input)).toBe(expected);
  });

  it("does not treat a ~~~ line inside a ``` block as a fence boundary", () => {
    // The tilde line is inner content of the backtick fence, so the comment on
    // the next line stays literal; only the comment after the fence converts.
    const input =
      "```\n~~~ still inside\n<!-- inside -->\n```\n\n<!-- outside -->\n";
    const expected =
      "```\n~~~ still inside\n<!-- inside -->\n```\n\n{/* outside */}\n";
    expect(convertHtmlComments(input)).toBe(expected);
  });

  it("treats an unterminated fence as running to end of document", () => {
    const input = "```\n<!-- inside an unclosed fence -->\n";
    expect(convertHtmlComments(input)).toBe(input);
  });
});
