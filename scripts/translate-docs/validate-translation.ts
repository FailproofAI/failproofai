/**
 * Generation-time validation for a freshly translated page.
 *
 * `findTranslationError` runs the exact checks the Mintlify deploy performs —
 * frontmatter YAML then MDX body — plus one the deploy cannot: frontmatter
 * KEY-PARITY against the English source. It is called on the exact bytes about
 * to be written to disk (post-sanitize, post-link-rewrite), so a page that
 * passes here is a page `mintlify validate` and the deploy accept.
 *
 * Why a translation-specific wrapper instead of `findPageError` alone:
 *  - Frontmatter YAML (class A): the model re-emits an inner `"` unescaped into
 *    a double-quoted `title:`/`description:` value, breaking the YAML. This is
 *    the class that failed run 29575781632; `findFrontmatterError` catches it.
 *  - Key parity (class B): the model drops the frontmatter block entirely, or
 *    renames a key. A dropped block is still *valid YAML* (mintlify tolerates
 *    it, deriving the title from the slug), so only comparing against the
 *    source's keys catches it. This is deliberately stricter than mintlify —
 *    the keys are prompt-forbidden to change, so it fails ~never but converts
 *    a silent content regression into a retry.
 *  - MDX body (classes C+): stray `<slug>`, `{#anchor}`, unmatched fence,
 *    swallowed `</div>` — `findMdxParseError` catches these.
 *
 * The message returned is written for a MODEL to act on: it names the failing
 * construct and, for a body error, quotes the offending line, so the retry has
 * a concrete defect to fix rather than a bare line number the RTL/README
 * wrappers would have offset anyway.
 */
import { findFrontmatterError, findMdxParseError } from "../validate-mdx";
import YAML from "yaml";

// Same matcher as validate-mdx.ts; duplicated locally so this module owns its
// frontmatter extraction and does not depend on an internal export.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * The sorted top-level keys of a page's frontmatter, or `null` when the page
 * has no frontmatter block or its block is not a key/value mapping (an
 * unparseable or scalar block). Callers distinguish "no block" from a YAML
 * error separately via `findFrontmatterError`.
 */
function frontmatterKeys(page: string): string[] | null {
  const match = FRONTMATTER_RE.exec(page);
  if (!match) return null;
  try {
    const doc = YAML.parse(match[1]);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return Object.keys(doc).sort();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A ±2-line window around `line` (1-based), the failing line prefixed `> ` and
 * its neighbours `  `. Empty string when `line` is undefined.
 */
function excerpt(page: string, line?: number): string {
  if (!line) return "";
  const lines = page.split("\n");
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 2);
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    out.push(`${n === line ? "> " : "  "}${lines[n - 1]}`);
  }
  return out.join("\n");
}

const backticked = (keys: string[]): string =>
  keys.map((k) => `\`${k}\``).join(", ");

/**
 * Validate a rendered translation against its English `source`. Returns a
 * model-actionable error message, or `null` when the page is publishable.
 */
export async function findTranslationError(
  rendered: string,
  source: string,
): Promise<string | null> {
  // Validate the rendered frontmatter block FIRST, for every source shape —
  // even when the source had none. findMdxParseError (below) blanks a leading
  // `---` block before compiling, so a malformed block the model *added* to a
  // frontmatter-less page would otherwise be invisible here yet still break the
  // Mintlify deploy. Closing exactly that blind spot is this module's job, so
  // it must hold regardless of whether the source has frontmatter.
  const fm = findFrontmatterError(rendered);
  if (fm) {
    return (
      "The YAML frontmatter (the `---` block at the top of the file) does " +
      `not parse:\n\n${fm.message}`
    );
  }

  const sourceKeys = frontmatterKeys(source);
  if (sourceKeys) {
    // The source has frontmatter, so the translation must carry the same keys.
    // (Its block, if present, already parsed cleanly above.)
    const keys = frontmatterKeys(rendered);
    if (keys === null) {
      return (
        "The YAML frontmatter is missing. The English source starts with a " +
        `\`---\` block containing ${backticked(sourceKeys)}; the translation ` +
        "must start with the same block — translate the values, keep the keys."
      );
    }
    // Subset check BY DESIGN: a missing or renamed key is a content regression
    // (the page loses its title/description), so reject it. An *extra* key is
    // harmless — Mintlify ignores unknown frontmatter keys — so tolerate it
    // rather than burn a retry (and risk exhausting the whole batch) on a page
    // that would deploy fine. Reject content loss; allow harmless additions.
    const missing = sourceKeys.filter((k) => !keys.includes(k));
    if (missing.length > 0) {
      return (
        `The YAML frontmatter keys changed. Expected ${backticked(sourceKeys)} ` +
        `but got ${backticked(keys)}. Translate the values, never rename or ` +
        "drop a key."
      );
    }
  }

  const body = await findMdxParseError(rendered);
  if (body) {
    const snippet = excerpt(rendered, body.line);
    return `The MDX body does not parse: ${body.message}${
      snippet ? `\n\n${snippet}` : ""
    }`;
  }

  return null;
}
