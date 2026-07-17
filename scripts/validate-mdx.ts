/**
 * Validate that every docs page (`.mdx` and `.md` — Mintlify parses both as
 * MDX) parses with the same MDX engine Mintlify runs at deploy time.
 *
 * Why this exists: `mintlify validate` (the existing `docs` CI job) checks
 * `docs.json` structure, nav-link resolution, and frontmatter YAML — but it
 * does NOT report MDX *body* syntax errors. A page whose frontmatter is valid
 * but whose body contains an MDX syntax error (e.g. a `<slug>` that escaped its
 * surrounding backticks because a translation dropped a closing `` ` ``) passes
 * `mintlify validate` but fails the Mintlify deploy with:
 *
 *   Failed to parse page content at path tr/cli/audit.mdx:
 *   Expected a closing tag for `<slug>` (61:127-61:133) before the end of `paragraph`
 *
 * That deploy runs post-merge, so the failure only surfaces on `main`. The
 * auto-translation workflow regenerates these pages with an LLM, so this class
 * of breakage recurs (see the `sanitizeJsxAttributes` / `stripStrayTrailingFence`
 * heuristics in scripts/translate-docs/mdx-translator.ts — best-effort fixers
 * that can't catch every case). This script is the deterministic safety net:
 * run it on every PR so an unparseable page fails CI before it reaches `main`.
 *
 * The error string above is emitted by `@mdx-js/mdx`'s micromark MDX layer,
 * which is the same engine Mintlify uses, so compiling here reproduces the
 * deploy-time parse faithfully. `main()` validates the frontmatter too (via
 * `findPageError`), so this net is a strict superset of `mintlify validate`:
 * it catches both the frontmatter YAML class that fails `mintlify validate`
 * and the body-MDX class that `mintlify validate` lets through to deploy.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@mdx-js/mdx";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");

export interface MdxParseError {
  message: string;
  line?: number;
  column?: number;
}

/**
 * Shared frontmatter matcher. The capture group is the YAML block *body* (the
 * text between the fences); `match[0]` is still the whole block including the
 * fences and trailing newline, which is what `stripFrontmatter` blanks.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * Replace a leading YAML frontmatter block (`--- … ---`) with blank lines.
 *
 * Mintlify parses frontmatter as YAML, not MDX, so it never causes an MDX parse
 * error — but it CAN contain a YAML syntax error, which blanking here hides
 * from `findMdxParseError`. That gap is covered separately by
 * `findFrontmatterError`; `findPageError` runs both. We blank rather than delete
 * so the remaining body keeps its original line numbers — body error positions
 * then match the real file.
 */
export function stripFrontmatter(source: string): string {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return source;
  // Keep newlines, drop every other character, so line numbers stay aligned.
  const blanked = match[0].replace(/[^\n]/g, "");
  return blanked + source.slice(match[0].length);
}

/**
 * Parse the leading YAML frontmatter block and return its parse error, or
 * `null` when the block is absent (legal — some pages and every i18n README
 * have none) or valid.
 *
 * This is the half of page validation that `findMdxParseError` structurally
 * cannot do: it compiles only the *body* (frontmatter blanked), so a YAML
 * syntax error in `title:`/`description:` — the exact class that failed the
 * `consolidate` job's `mintlify validate` step, and that this repo's own
 * `validate:mdx` net could not see — sailed straight through. `mintlify`
 * parses the frontmatter as YAML, so parsing it here reproduces that check.
 *
 * The reported `line` is FILE-relative (the opening `---` is file line 1), so
 * it matches the convention `findMdxParseError` already uses for body errors.
 * That is deliberately one greater than the block-relative number `mintlify`
 * prints — do NOT "fix" it to match mintlify; file-relative is what points a
 * reader (or a model asked to repair the page) at the right line.
 */
export function findFrontmatterError(source: string): MdxParseError | null {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return null;
  try {
    YAML.parse(match[1]);
    return null;
  } catch (err) {
    const e = err as {
      message?: string;
      linePos?: Array<{ line: number; col: number }>;
    };
    const raw = e.message ?? String(err);
    return {
      // Drop yaml's block-relative "at line N, column N:" phrase (it would
      // contradict the file-relative line we report) but keep the caret-
      // underlined excerpt after it — the single most useful signal for a
      // model asked to repair the offending line.
      message: raw.replace(/ at line \d+, column \d+:/, ":"),
      line: e.linePos?.[0] ? e.linePos[0].line + 1 : undefined,
      column: e.linePos?.[0]?.col,
    };
  }
}

/**
 * Validate a full page the way the Mintlify deploy does: frontmatter YAML
 * first, then the MDX body. Returns the first error found, or `null`. This is
 * the single entry point shared by `validate:mdx` (`main()` below) and the
 * translation pipeline's generation-time gate, so the two can never disagree
 * about what is publishable.
 */
export async function findPageError(
  source: string,
): Promise<MdxParseError | null> {
  return findFrontmatterError(source) ?? (await findMdxParseError(source));
}

/**
 * Compile one MDX source string with the deploy-time parser. Returns `null`
 * when it parses cleanly, or the parse error (with position) otherwise.
 */
export async function findMdxParseError(
  source: string,
): Promise<MdxParseError | null> {
  try {
    await compile(stripFrontmatter(source));
    return null;
  } catch (err) {
    const e = err as {
      reason?: string;
      message?: string;
      line?: number;
      column?: number;
      place?: { start?: { line?: number; column?: number } };
    };
    return {
      message: e.reason ?? e.message ?? String(err),
      line: e.line ?? e.place?.start?.line,
      column: e.column ?? e.place?.start?.column,
    };
  }
}

/**
 * Percent-encode a value for a GitHub Actions workflow command. Without this a
 * multi-line MDX error message would be truncated at its first newline (and a
 * literal `%` could mis-parse) when emitted as an `::error::` annotation.
 * https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
export function encodeAnnotation(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Collect every Mintlify content page under `dir`. Mintlify runs BOTH `.mdx`
 * and `.md` files through the same MDX pipeline at deploy time, so a `.md` page
 * with an MDX syntax error (e.g. an HTML `<!-- -->` comment, which MDX rejects)
 * fails the deploy exactly like a broken `.mdx` would. The docs/i18n README
 * translations are `.md`, so restricting this walk to `.mdx` let their breakage
 * sail past this safety net and reach the post-merge deploy — collect both.
 */
export function collectMdxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectMdxFiles(full));
    else if (entry.endsWith(".mdx") || entry.endsWith(".md")) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const files = collectMdxFiles(DOCS_DIR).sort();
  const failures: Array<{ file: string; error: MdxParseError }> = [];

  for (const file of files) {
    const error = await findPageError(readFileSync(file, "utf-8"));
    if (error) failures.push({ file: relative(process.cwd(), file), error });
  }

  if (failures.length === 0) {
    console.log(`✓ ${files.length} MDX page(s) parsed cleanly`);
    return;
  }

  console.error(
    `✗ ${failures.length} of ${files.length} MDX page(s) failed to parse:\n`,
  );
  for (const { file, error } of failures) {
    const pos = error.line
      ? `:${error.line}${error.column ? `:${error.column}` : ""}`
      : "";
    console.error(`  ${file}${pos}\n    ${error.message}\n`);
    // GitHub Actions inline annotation.
    const loc =
      (error.line ? `,line=${error.line}` : "") +
      (error.column ? `,col=${error.column}` : "");
    console.log(
      `::error file=${encodeAnnotation(file)}${loc}::MDX parse error: ${encodeAnnotation(error.message)}`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  void main();
}
