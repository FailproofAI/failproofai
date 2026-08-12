// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  collectMdxFiles,
  encodeAnnotation,
  findBrokenAssetRefs,
  findFrontmatterError,
  findMdxParseError,
  findPageError,
  stripFrontmatter,
} from "@/scripts/validate-mdx";

describe("stripFrontmatter", () => {
  it("blanks a leading frontmatter block while preserving line numbers", () => {
    const src = `---\ntitle: "Hello"\ndescription: "x"\n---\n\n# Body\n`;
    const out = stripFrontmatter(src);
    // Same number of lines, so error positions stay aligned with the file.
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain("# Body");
    expect(out).not.toContain("title:");
  });

  it("leaves content without frontmatter untouched", () => {
    const src = `# Title\n\nSome prose.\n`;
    expect(stripFrontmatter(src)).toBe(src);
  });
});

describe("encodeAnnotation", () => {
  it("percent-encodes newlines, carriage returns, and percent signs", () => {
    expect(encodeAnnotation("line one\nline two")).toBe("line one%0Aline two");
    expect(encodeAnnotation("a\r\nb")).toBe("a%0D%0Ab");
    // `%` must be encoded first so the escapes above aren't double-encoded.
    expect(encodeAnnotation("100% sure")).toBe("100%25 sure");
  });

  it("leaves a plain single-line message untouched", () => {
    expect(encodeAnnotation("Expected a closing tag for `<slug>`")).toBe(
      "Expected a closing tag for `<slug>`",
    );
  });
});

describe("findMdxParseError", () => {
  it("returns null for a clean page (frontmatter + component + fenced <slug>)", async () => {
    const src = [
      "---",
      'title: "Audit"',
      "---",
      "",
      "<Card title=\"Audit\" href=\"/cli/audit\">Run an audit</Card>",
      "",
      "Install with `failproofai policy add <slug>`.",
      "",
      "```bash",
      "failproofai policy add <slug>",
      "```",
      "",
    ].join("\n");
    expect(await findMdxParseError(src)).toBeNull();
  });

  it("flags a <slug> placeholder that escaped its inline-code backticks", async () => {
    // The tr/cli/audit.mdx regression: a dropped closing backtick pushed the
    // `<slug>` out of code, where MDX reads it as an unclosed JSX tag.
    const src = "Install with failproofai policy add <slug> now.\n";
    const error = await findMdxParseError(src);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/slug|closing tag/i);
  });

  it("flags a {#id} heading anchor (invalid MDX expression)", async () => {
    // The ja/zh built-in-policies.mdx regression: the translator injected an
    // explicit `{#anchor}` heading id, which MDX parses as a JS expression.
    const src = "## Dangerous commands {#dangerous-commands}\n";
    const error = await findMdxParseError(src);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/acorn|expression/i);
  });

  it("accepts the same heading once the {#id} anchor is removed", async () => {
    expect(await findMdxParseError("## Dangerous commands\n")).toBeNull();
  });

  it("reports a line number for the failure", async () => {
    const src = "# Intro\n\nsome text\n\nbad <slug> here\n";
    const error = await findMdxParseError(src);
    expect(error).not.toBeNull();
    expect(error?.line).toBe(5);
  });

  it("flags a top-level HTML comment (the docs/i18n README deploy failure)", async () => {
    // Mintlify parses .md/.mdx as MDX, where `<!-- -->` is a hard syntax error
    // ("Unexpected character `!` … use the MDX comment form"). This is exactly
    // what broke every docs/i18n/README.*.md translation at deploy time.
    const error = await findMdxParseError("# Title\n\n<!-- a note -->\n");
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/character/i);
  });

  it("accepts the MDX comment form the translator now emits", async () => {
    expect(await findMdxParseError("# Title\n\n{/* a note */}\n")).toBeNull();
  });

  it("leaves an HTML comment inside a code fence alone", async () => {
    // Fenced content is literal in MDX, so the AgentEye collector plist sample
    // keeps its `<!-- -->` — which is why convertHtmlComments skips fences.
    const src = "```xml\n<!-- ~/Library/LaunchAgents/foo.plist -->\n```\n";
    expect(await findMdxParseError(src)).toBeNull();
  });
});

describe("findFrontmatterError", () => {
  it("catches an unescaped inner quote in a double-quoted description scalar", () => {
    // The exact class that failed run 29575781632: the model re-emits an inner
    // quote unescaped into the YAML value.
    const src = [
      "---",
      'title: "Failproof AI Observability CLI Agent Skill"',
      'description: "Fragen Sie "ist etwas kaputt?" und lassen"',
      "---",
      "",
      "# Body",
      "",
    ].join("\n");
    const error = findFrontmatterError(src);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/scalar|unexpected/i);
  });

  it("accepts a description with a properly escaped inner quote (the English source form)", () => {
    // The English source escapes its inner quotes (`\"`), which is valid YAML;
    // only the translation dropping the escape breaks it.
    const src = [
      "---",
      'title: "Failproof AI Observability CLI Agent Skill"',
      'description: "Ask your coding agent \\"is anything broken today?\\" and let it answer."',
      "---",
      "",
      "# Body",
      "",
    ].join("\n");
    expect(findFrontmatterError(src)).toBeNull();
  });

  it("returns null for a page with no frontmatter block", () => {
    expect(findFrontmatterError("# Title\n\nJust prose.\n")).toBeNull();
  });

  it("returns null for well-formed frontmatter", () => {
    const src = `---\ntitle: "Hello"\ndescription: "A page"\n---\n\n# Body\n`;
    expect(findFrontmatterError(src)).toBeNull();
  });

  it("reports a file-relative line that counts the opening ---", () => {
    // Error is on the `title` line — block line 1, file line 2 (the opening
    // `---` is file line 1). This is deliberately one greater than the
    // block-relative number mintlify prints; do not "fix" it to match.
    const src = [
      "---",
      'title: "Foo "bar" baz"',
      'description: "ok"',
      "---",
      "",
      "# Body",
      "",
    ].join("\n");
    const error = findFrontmatterError(src);
    expect(error).not.toBeNull();
    expect(error?.line).toBe(2);
  });

  it("strips the block-relative position from the message but keeps the caret excerpt", () => {
    const src = `---\ntitle: "Foo "bar" baz"\n---\n\n# Body\n`;
    const error = findFrontmatterError(src);
    expect(error).not.toBeNull();
    // The redundant "at line N, column N:" phrase is removed (it would
    // contradict our file-relative line)...
    expect(error?.message).not.toMatch(/at line \d+, column \d+/);
    // ...but the caret-underlined excerpt that points a model at the defect
    // is preserved.
    expect(error?.message).toContain("^");
  });

  it("does not treat a mid-document --- thematic break as frontmatter", () => {
    // The block must be at the very top; a `---` rule later in the body (and a
    // broken-looking line after it) is not frontmatter.
    const src = `# Title\n\nSome prose.\n\n---\n\ntitle: "not frontmatter "at all"\n`;
    expect(findFrontmatterError(src)).toBeNull();
  });
});

describe("findPageError", () => {
  it("flags a frontmatter YAML error that the body compile misses", async () => {
    // findMdxParseError blanks the frontmatter, so it alone returns null here;
    // findPageError must still catch the frontmatter error.
    const src = [
      "---",
      'title: "Foo "bar" baz"',
      "---",
      "",
      "# A perfectly valid body",
      "",
    ].join("\n");
    expect(await findMdxParseError(src)).toBeNull();
    const error = await findPageError(src);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/scalar|unexpected/i);
  });

  it("flags a body MDX error that the frontmatter check misses", async () => {
    const src = [
      "---",
      'title: "All good here"',
      "---",
      "",
      "Install with failproofai policy add <slug> now.",
      "",
    ].join("\n");
    expect(findFrontmatterError(src)).toBeNull();
    const error = await findPageError(src);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/slug|closing tag/i);
  });
});

describe("collectMdxFiles", () => {
  it("collects .md and .mdx pages recursively but ignores other files", () => {
    // Regression guard: Mintlify parses .md pages (e.g. the docs/i18n READMEs)
    // as MDX too, so the walk must not be restricted to .mdx.
    const dir = mkdtempSync(join(tmpdir(), "validate-mdx-collect-"));
    try {
      writeFileSync(join(dir, "page.mdx"), "# mdx\n");
      writeFileSync(join(dir, "readme.md"), "# md\n");
      writeFileSync(join(dir, "notes.txt"), "ignore me\n");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "nested.md"), "# nested\n");

      const found = collectMdxFiles(dir)
        .map((f) => relative(dir, f))
        .sort();
      expect(found).toEqual(["page.mdx", "readme.md", "sub/nested.md"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findBrokenAssetRefs", () => {
  // Fixtures resolve against the real repo so the check is exercised with the
  // same two path conventions the docs actually use.
  const REPO = join(__dirname, "..", "..");
  const DOCS_PAGE = join(REPO, "docs", "cloud", "alerts.mdx");
  const I18N_PAGE = join(REPO, "docs", "i18n", "README.ja.md");

  it("flags the exact regression that broke every translated README", () => {
    // The root README writes `assets/logos/claude.svg` because it sits AT the
    // repo root. Copied verbatim into docs/i18n/ it resolves two levels too
    // deep and 404s — this is the bug the check exists to prevent recurring.
    const broken = findBrokenAssetRefs(
      I18N_PAGE,
      '<img src="assets/logos/claude.svg" alt="Claude Code" />\n',
    );
    expect(broken).toHaveLength(1);
    expect(broken[0].ref).toBe("assets/logos/claude.svg");
    expect(broken[0].resolved).toBe("docs/i18n/assets/logos/claude.svg");
    expect(broken[0].line).toBe(1);
  });

  it("accepts the rebased forms the translated READMEs now use", () => {
    expect(
      findBrokenAssetRefs(
        I18N_PAGE,
        '<img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/claude.svg" />\n' +
          "[link](../../CONTRIBUTING.md)\n",
      ),
    ).toEqual([]);
  });

  it("resolves a leading slash against docs/, not the page directory", () => {
    // Mintlify site-absolute form, used by every cloud page.
    expect(
      findBrokenAssetRefs(
        DOCS_PAGE,
        "![Alerts](/cloud/images/alerts.png)\n",
      ),
    ).toEqual([]);
    const broken = findBrokenAssetRefs(
      DOCS_PAGE,
      "![Nope](/cloud/images/does-not-exist.png)\n",
    );
    expect(broken).toHaveLength(1);
    expect(broken[0].resolved).toBe("docs/cloud/images/does-not-exist.png");
  });

  it("checks srcset candidates, not just src", () => {
    // The README's logo table pairs every <img src> with a dark-mode
    // <source srcset>. Extracting only `src` passed a half-broken table.
    const broken = findBrokenAssetRefs(
      I18N_PAGE,
      '<source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />\n',
    );
    expect(broken).toHaveLength(1);
    expect(broken[0].resolved).toBe("docs/i18n/assets/logos/openai-dark.svg");
  });

  it("splits a multi-candidate srcset and strips each descriptor", () => {
    const broken = findBrokenAssetRefs(
      DOCS_PAGE,
      '<source srcset="images/alerts.png 1x, images/missing@2x.png 2x" />\n',
    );
    expect(broken.map((b) => b.ref)).toEqual(["images/missing@2x.png"]);
  });

  it("accepts a page-relative path that exists", () => {
    expect(
      findBrokenAssetRefs(DOCS_PAGE, "![Alerts](images/alerts.png)\n"),
    ).toEqual([]);
  });

  it("ignores external URLs, other schemes, and bare anchors", () => {
    expect(
      findBrokenAssetRefs(
        DOCS_PAGE,
        "![npm](https://img.shields.io/npm/dw/failproofai.svg)\n" +
          "![inline](data:image/png;base64,iVBORw0KGgo=)\n" +
          "![proto](//cdn.example.com/x.png)\n" +
          "[jump](#section)\n",
      ),
    ).toEqual([]);
  });

  it("ignores non-asset links, which mintlify validate already covers", () => {
    // Extensionless Mintlify routes and .md links must not false-positive.
    expect(
      findBrokenAssetRefs(
        DOCS_PAGE,
        "[Getting started](/getting-started)\n[Contributing](../../CONTRIBUTING.md)\n",
      ),
    ).toEqual([]);
  });

  it("strips a query or fragment before resolving", () => {
    expect(
      findBrokenAssetRefs(DOCS_PAGE, "![Alerts](images/alerts.png?v=2)\n"),
    ).toEqual([]);
  });

  it("reports the line number of each broken reference", () => {
    const broken = findBrokenAssetRefs(
      DOCS_PAGE,
      "# Title\n\n![One](images/nope-a.png)\n\n![Two](images/nope-b.png)\n",
    );
    expect(broken.map((b) => b.line)).toEqual([3, 5]);
  });
});
