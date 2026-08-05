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
 *
 * It also covers a third class neither tool sees: image references whose target
 * does not exist (`findBrokenAssetRefs`). Those are valid MDX and valid YAML —
 * nothing errors, the reader just gets a broken image — which is how all 14
 * translated READMEs shipped with every logo and the architecture GIF broken.
 * See that function for the mechanism.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@mdx-js/mdx";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const DOCS_DIR = join(ROOT_DIR, "docs");

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

/** File extensions treated as bundled media rather than a link to a page. */
const ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|mp4|webm)$/i;

export interface BrokenAssetRef {
  /** The reference exactly as written in the page. */
  ref: string;
  /** Repo-relative path the reference resolves to, which does not exist. */
  resolved: string;
  /** 1-based line the reference appears on. */
  line: number;
}

/**
 * Report every local image reference on a page whose target does not exist on
 * disk.
 *
 * Why this is a separate net from the MDX parse above: a broken image path is
 * perfectly valid MDX and perfectly valid YAML, so `mintlify validate` and
 * `findPageError` both pass it — it only surfaces as a missing image in a
 * reader's browser, which nothing in CI was watching. That is exactly how all
 * 14 translated READMEs shipped with every logo and the architecture GIF
 * broken: the translator faithfully copies the root README's repo-root-relative
 * `assets/logos/*.svg` into `docs/i18n/`, two directories deeper, where they
 * resolve to nothing (GitHub 404, Mintlify S3 403). The auto-translation
 * workflow regenerates these pages unattended, so only a deterministic check
 * keeps that class from coming back.
 *
 * Resolution follows the two conventions in this repo:
 *  - A leading `/` is Mintlify site-absolute → resolve against `docs/`
 *    (`/agenteye/images/x.png` → `docs/agenteye/images/x.png`).
 *  - Anything else is relative to the page's own directory, the way GitHub and
 *    Mintlify both resolve it.
 *
 * Skipped: absolute URLs and any other scheme (`https:`, `mailto:`, `data:`),
 * protocol-relative `//`, bare anchors, and non-asset references — a link to a
 * `.md`/`.mdx` page or a bare doc slug is nav, already covered by
 * `mintlify validate`, and would false-positive on extensionless Mintlify
 * routes.
 */
export function findBrokenAssetRefs(
  file: string,
  source: string,
): BrokenAssetRef[] {
  const pageDir = dirname(file);
  const out: BrokenAssetRef[] = [];
  const seen = new Set<string>();

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const refs = [
      ...lines[i].matchAll(/\]\(([^)\s]+)/g),
      ...lines[i].matchAll(/(?:src|href)=["']([^"']+)["']/g),
    ].map((m) => m[1]);

    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // https:, mailto:, data:
      if (ref.startsWith("//") || ref.startsWith("#")) continue;
      // Strip the query/fragment before testing the extension so a versioned
      // `x.png?v=2` is still recognised as an asset.
      const path = ref.split(/[?#]/)[0];
      if (!ASSET_RE.test(path)) continue;

      const target = path.startsWith("/")
        ? join(DOCS_DIR, path.slice(1))
        : resolve(pageDir, path);
      if (existsSync(target)) continue;

      const key = `${i}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ref,
        resolved: relative(ROOT_DIR, target).split(/[\\/]/).join(posix.sep),
        line: i + 1,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const files = collectMdxFiles(DOCS_DIR).sort();
  const failures: Array<{
    file: string;
    error: MdxParseError;
    kind: "MDX parse error" | "Broken image";
  }> = [];

  const collectAssetFailures = (file: string, source: string): void => {
    for (const broken of findBrokenAssetRefs(file, source)) {
      failures.push({
        file: relative(process.cwd(), file),
        kind: "Broken image",
        error: {
          message:
            `Image \`${broken.ref}\` does not exist — it resolves to ` +
            `\`${broken.resolved}\`. Paths are relative to the page's own ` +
            "directory (a leading `/` is relative to `docs/`), so a path " +
            "copied from a file at a different depth has to be re-pointed.",
          line: broken.line,
        },
      });
    }
  };

  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const error = await findPageError(source);
    if (error)
      failures.push({
        file: relative(process.cwd(), file),
        error,
        kind: "MDX parse error",
      });

    // A page can carry a broken image and still parse, so collect these
    // independently rather than only when the parse succeeded.
    collectAssetFailures(file, source);
  }

  // The root README is not a docs page (it is GitHub-only, and its HTML
  // comments are illegal MDX, so findPageError would reject it) — but it IS
  // the source every docs/i18n/README.<lang>.md is translated from. A bad
  // image path here propagates into 14 files as an absolute raw URL, which
  // findBrokenAssetRefs deliberately does not follow. Check it at the source.
  const rootReadme = join(ROOT_DIR, "README.md");
  if (existsSync(rootReadme)) {
    collectAssetFailures(rootReadme, readFileSync(rootReadme, "utf-8"));
  }

  if (failures.length === 0) {
    console.log(
      `✓ ${files.length} MDX page(s) parsed cleanly with no broken images`,
    );
    return;
  }

  console.error(`✗ ${failures.length} problem(s) in ${files.length} page(s):\n`);
  for (const { file, error, kind } of failures) {
    const pos = error.line
      ? `:${error.line}${error.column ? `:${error.column}` : ""}`
      : "";
    console.error(`  ${file}${pos}\n    ${kind}: ${error.message}\n`);
    // GitHub Actions inline annotation.
    const loc =
      (error.line ? `,line=${error.line}` : "") +
      (error.column ? `,col=${error.column}` : "");
    console.log(
      `::error file=${encodeAnnotation(file)}${loc}::${kind}: ${encodeAnnotation(error.message)}`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  void main();
}
