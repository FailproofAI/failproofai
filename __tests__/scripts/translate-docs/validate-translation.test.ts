// @vitest-environment node
import { describe, it, expect } from "vitest";
import { findTranslationError } from "@/scripts/translate-docs/validate-translation";

// English source with frontmatter: keys are `title` and `description`.
const SOURCE = `---\ntitle: "Skill"\ndescription: "A page"\n---\n\n# Body\n`;

// A source with NO frontmatter, like the root README.md.
const README_SOURCE = `# Title\n\nSome prose.\n`;

describe("findTranslationError", () => {
  it("returns null for a valid translated page", async () => {
    const rendered = `---\ntitle: "Fähigkeit"\ndescription: "Eine Seite"\n---\n\n# Körper\n`;
    expect(await findTranslationError(rendered, SOURCE)).toBeNull();
  });

  it("flags a frontmatter YAML error and quotes the offending line", async () => {
    // The reported class: an unescaped inner quote in the description value.
    const rendered = `---\ntitle: "Fähigkeit"\ndescription: "Fragen Sie "ist etwas kaputt?""\n---\n\n# Körper\n`;
    const error = await findTranslationError(rendered, SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("frontmatter");
    expect(error).toMatch(/does not parse/);
  });

  it("flags a frontmatter block the model dropped entirely", async () => {
    // A missing block is still valid YAML (mintlify tolerates it), so only the
    // key-parity check against the source catches it.
    const rendered = `# Körper\n\nKein Frontmatter hier.\n`;
    const error = await findTranslationError(rendered, SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("missing");
    // Names the keys the translation must restore.
    expect(error).toContain("title");
    expect(error).toContain("description");
  });

  it("flags frontmatter keys the model renamed or dropped", async () => {
    // `title` renamed to `titel`.
    const rendered = `---\ntitel: "Fähigkeit"\ndescription: "Eine Seite"\n---\n\n# Körper\n`;
    const error = await findTranslationError(rendered, SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("keys changed");
  });

  it("allows an extra frontmatter key the source does not have", async () => {
    // Extra keys cannot break the deploy, so they are tolerated (subset check).
    const rendered = `---\ntitle: "Fähigkeit"\ndescription: "Eine Seite"\nicon: "book"\n---\n\n# Körper\n`;
    expect(await findTranslationError(rendered, SOURCE)).toBeNull();
  });

  it("flags an MDX body error with an excerpt", async () => {
    const rendered = `---\ntitle: "Fähigkeit"\ndescription: "Eine Seite"\n---\n\nInstall failproofai policy add <slug> now.\n`;
    const error = await findTranslationError(rendered, SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("MDX body");
    expect(error).toMatch(/slug|closing tag/i);
    // The excerpt marks the failing line with a leading "> ".
    expect(error).toMatch(/^> .*policy add <slug>/m);
  });

  it("runs body-only when the English source has no frontmatter", async () => {
    // README shape: no frontmatter, so the key check is skipped entirely.
    const broken = `# Titel\n\nInstall failproofai policy add <slug>.\n`;
    const error = await findTranslationError(broken, README_SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("MDX body");

    const valid = `# Titel\n\nEinfache Prosa.\n`;
    expect(await findTranslationError(valid, README_SOURCE)).toBeNull();
  });

  it("flags malformed frontmatter the model added to a frontmatter-less source", async () => {
    // The source has no frontmatter, but the translation invents a leading
    // `---` block and botches its YAML. findMdxParseError would blank the block
    // and miss it, so this only fails if the frontmatter is validated for every
    // source shape — not just when the source itself had frontmatter.
    const rendered = `---\ntitle: "Titel "kaputt""\n---\n\n# Körper\n`;
    const error = await findTranslationError(rendered, README_SOURCE);
    expect(error).not.toBeNull();
    expect(error).toContain("frontmatter");
    expect(error).toMatch(/does not parse/);
  });

  it("allows well-formed frontmatter the model added to a frontmatter-less source", async () => {
    // A well-formed added block is harmless — Mintlify ignores unknown keys —
    // so it must not be rejected.
    const rendered = `---\ntitle: "Titel"\n---\n\n# Körper\n`;
    expect(await findTranslationError(rendered, README_SOURCE)).toBeNull();
  });
});
