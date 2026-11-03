// @vitest-environment node
/**
 * The hook path may learn a precondition's NAME without loading Jev.
 *
 * `8b9ca9ac` on this branch exists to stop the semantic modules loading on a
 * machine that never configured Jev: the handler stats `jev.json` before it
 * imports anything. Pack-declared semantic policies put pressure on exactly that
 * line, because `pack-manifest.ts` — which every hook event reads — has to
 * validate a `precondition` name against a compiled-in list. The list is
 * therefore a file of its own with zero imports, and this pins that: one reach
 * for `PROTECTED_BRANCHES` from a predicate body would pull `policies.ts` and all
 * sixteen of Jev's prompts onto the import graph of every tool call, and nothing
 * else in the suite would notice.
 *
 * Source-level, like `two-tier-single-engine.test.ts`, and transitive, because
 * the failure would arrive through a chain rather than through a line anybody
 * wrote in `pack-manifest.ts`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const HOOKS = join(__dirname, "..", "..", "src", "hooks");

/** Every static or dynamic import specifier in a source file. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const re of [/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"'\n]+)["']/g, /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g]) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Resolve a relative specifier to a `.ts` file under src/, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every local module reachable from `entry` by a static or dynamic import. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(file)) {
      const target = resolveLocal(file, spec);
      if (target) queue.push(target);
    }
  }
  return seen;
}

const rel = (p: string) => relative(join(__dirname, "..", ".."), p).split("\\").join("/");

/** Modules that carry Jev's prompts, the envelope, or a predicate over the facts. */
const JEV_RUNTIME = [
  "src/hooks/semantic/policies.ts",
  "src/hooks/semantic/preconditions.ts",
  "src/hooks/semantic/pack-policies.ts",
  "src/hooks/semantic/compile.ts",
  "src/hooks/semantic/envelope.ts",
  "src/hooks/semantic/evaluator.ts",
  "src/hooks/semantic/jev-config.ts",
];

describe("precondition-names.ts", () => {
  it("imports nothing at all", () => {
    // Its whole reason for existing apart from `preconditions.ts`.
    expect(specifiers(join(HOOKS, "semantic", "precondition-names.ts"))).toEqual([]);
  });

  it("is the only semantic module pack-manifest.ts names", () => {
    const semantic = specifiers(join(HOOKS, "pack-manifest.ts")).filter((s) => s.includes("semantic/"));
    expect(semantic).toEqual(["./semantic/precondition-names"]);
  });
});

describe("the hook path's reach", () => {
  it.each([
    ["src/hooks/pack-manifest.ts", "pack-manifest.ts"],
    ["src/hooks/policy-registry.ts", "policy-registry.ts"],
    ["src/hooks/effective-reviewers.ts", "effective-reviewers.ts"],
    ["src/hooks/policy-authority.ts", "policy-authority.ts"],
  ])("%s never reaches a Jev runtime module", (_label, file) => {
    const graph = [...importGraph(join(HOOKS, file))].map(rel);
    for (const forbidden of JEV_RUNTIME) {
      expect(graph, `${file} → ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reaches the precondition NAMES, which is the point", () => {
    const graph = [...importGraph(join(HOOKS, "pack-manifest.ts"))].map(rel);
    expect(graph).toContain("src/hooks/semantic/precondition-names.ts");
  });
});

describe("the pack→policy resolver", () => {
  it("is loaded by the semantic evaluator and the publish command, and nothing else", () => {
    // The evaluator is behind the `jev.json` stat; `pack-cli` is a CLI. A third
    // importer would be the thing to look at.
    const importers: string[] = [];
    for (const file of ["evaluator.ts", "jev-review.ts", "combine.ts", "decide.ts"]) {
      const p = join(HOOKS, "semantic", file);
      if (specifiers(p).some((s) => s.includes("pack-policies"))) importers.push(`semantic/${file}`);
    }
    expect(importers).toEqual(["semantic/evaluator.ts"]);
    expect(specifiers(join(HOOKS, "pack-cli.ts")).some((s) => s.includes("semantic/pack-policies"))).toBe(true);
    expect(specifiers(join(HOOKS, "handler.ts")).some((s) => s.includes("pack-policies"))).toBe(false);
  });
});
