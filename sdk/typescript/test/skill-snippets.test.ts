import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as failproofai from "../src/index.js";
import * as evaluator from "../src/evaluator/index.js";

/**
 * The `failproofai-sdk` skill teaches this package too, and its TypeScript blocks
 * are instructions an agent copies into someone's real agent loop — code under
 * test, like the Python blocks `sdk/python/tests/test_skill_snippets.py` guards.
 *
 * Two checks, both cheap and both aimed at drift rather than style: every
 * ```ts block parses, and every SDK name a block calls — `failproofai.x`,
 * `failproofai.event.x`, a named import from `@failproofai/sdk/evaluator` —
 * still exists. A rename in `src/` otherwise leaves the skill teaching a call
 * that throws `is not a function` in the customer's process.
 */

const SKILL = join(__dirname, "..", "..", "python", "skill");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

function tsBlocks(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/```(?:ts|typescript)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

const FILES = markdownFiles(SKILL).filter((path) => tsBlocks(path).length > 0);
const BLOCKS = FILES.flatMap((path) =>
  tsBlocks(path).map((code, index) => ({ id: `${relative(SKILL, path)} #${index}`, code })),
);

describe("the failproofai-sdk skill's TypeScript snippets", () => {
  it("has snippets to check (a path typo would make every test below vacuous)", () => {
    expect(BLOCKS.length).toBeGreaterThanOrEqual(8);
  });

  it.each(BLOCKS)("$id parses", ({ code }) => {
    const out = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const errors = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  });

  it.each(BLOCKS)("$id calls only names the SDK exports", ({ code }) => {
    const missing: string[] = [];
    for (const [, name] of code.matchAll(/\bfailproofai\.(?!event\.)(\w+)/g)) {
      if (!(name! in failproofai)) missing.push(`failproofai.${name}`);
    }
    for (const [, name] of code.matchAll(/\bfailproofai\.event\.(\w+)/g)) {
      if (typeof (failproofai.event as unknown as Record<string, unknown>)[name!] !== "function") {
        missing.push(`failproofai.event.${name}`);
      }
    }
    for (const [, names] of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@failproofai\/sdk\/evaluator"/g)) {
      for (const name of names!.split(",").map((n) => n.trim()).filter(Boolean)) {
        if (!(name in evaluator)) missing.push(`@failproofai/sdk/evaluator: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
