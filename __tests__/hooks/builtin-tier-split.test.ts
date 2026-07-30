/**
 * Tripwire for Stage 0 / P1 — "split the builtins by capability".
 *
 * Two independent assertions, and the second one is the whole point.
 *
 * 1. The **registry snapshot**. `BUILTIN_POLICIES` must present the same 39
 *    entries, in the same order, with the same category / defaultEnabled /
 *    beta, as it did before the split. The split moves implementations between
 *    modules; it must not move a policy, rename a category, or flip a default.
 *
 * 2. The **import-graph partition**. Execution-tier derivation reads a policy's
 *    *resolved import graph*: a policy whose graph reaches `node:child_process`
 *    cannot run in the sealed tier. Before the split all 39 builtins lived in
 *    one module that imports `node:child_process`, so derivation would have
 *    routed every one of them to `user-context` and the sealed tier would have
 *    been empty — an architecture that looks implemented and delivers no
 *    verdict integrity. This test walks the real transitive import graph of
 *    `src/hooks/builtin/payload-only.ts` and fails if any host module appears
 *    in it. Without this assertion the regression is invisible: nothing else
 *    in the suite notices when a stray `import { readFile }` re-fuses the two
 *    halves.
 *
 * See desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/01-stages.md
 * (Stage 0 → P1) and 03-risks-and-amendments.md ("Skipping P1 yields an empty
 * sealed tier").
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { PAYLOAD_ONLY_POLICIES } from "../../src/hooks/builtin/payload-only";
import { HOST_ACCESS_POLICIES } from "../../src/hooks/builtin/host-access";

const REPO_ROOT = resolvePath(__dirname, "..", "..");

/**
 * The registry exactly as it stood before the split, captured from `main`.
 *
 * Regenerate ONLY when a policy is deliberately added, removed, or
 * recategorised — never to make a refactor pass:
 *   bun -e 'import {BUILTIN_POLICIES} from "./src/hooks/builtin-policies";
 *           console.log(JSON.stringify(BUILTIN_POLICIES.map(p =>
 *             [p.name, p.category, p.defaultEnabled, p.beta ?? null])))'
 */
const REGISTRY_SNAPSHOT: Array<[string, string, boolean, boolean | null]> = [
  ["sanitize-jwt", "Sanitize", true, null],
  ["sanitize-api-keys", "Sanitize", true, null],
  ["sanitize-connection-strings", "Sanitize", true, null],
  ["sanitize-private-key-content", "Sanitize", true, null],
  ["sanitize-bearer-tokens", "Sanitize", true, null],
  ["protect-env-vars", "Environment", true, null],
  ["block-env-files", "Environment", true, null],
  ["block-read-outside-cwd", "Environment", false, null],
  ["block-sudo", "Dangerous Commands", true, null],
  ["block-curl-pipe-sh", "Dangerous Commands", true, null],
  ["block-rm-rf", "Dangerous Commands", false, null],
  ["block-failproofai-commands", "Dangerous Commands", true, null],
  ["block-kubectl", "Infra Commands", false, null],
  ["block-terraform", "Infra Commands", false, null],
  ["block-aws-cli", "Infra Commands", false, null],
  ["block-gcloud", "Infra Commands", false, null],
  ["block-az-cli", "Infra Commands", false, null],
  ["block-helm", "Infra Commands", false, null],
  ["block-gh-pipeline", "Infra Commands", false, null],
  ["block-secrets-write", "Dangerous Commands", false, null],
  ["block-push-master", "Git", true, null],
  ["block-force-push", "Git", false, null],
  ["block-work-on-main", "Git", false, null],
  ["warn-git-amend", "Git", false, null],
  ["warn-git-stash-drop", "Git", false, null],
  ["warn-all-files-staged", "Git", false, null],
  ["warn-destructive-sql", "Database", false, null],
  ["warn-schema-alteration", "Database", false, null],
  ["warn-package-publish", "Packages & System", false, null],
  ["warn-global-package-install", "Packages & System", false, null],
  ["prefer-package-manager", "Packages & System", false, null],
  ["warn-large-file-write", "Packages & System", false, null],
  ["warn-background-process", "Packages & System", false, null],
  ["warn-repeated-tool-calls", "AI Behavior", false, null],
  ["require-commit-before-stop", "Workflow", false, null],
  ["require-push-before-stop", "Workflow", false, null],
  ["require-pr-before-stop", "Workflow", false, null],
  ["require-no-conflicts-before-stop", "Workflow", false, null],
  ["require-ci-green-before-stop", "Workflow", false, null],
];

/**
 * The seven policies that genuinely need the host: two spawn `git` / `gh`
 * (`block-work-on-main` and, via the branch cache, every Stop gate) and one
 * reads and writes a sidecar file next to the transcript.
 */
const HOST_ACCESS_NAMES = [
  "block-work-on-main",
  "warn-repeated-tool-calls",
  "require-commit-before-stop",
  "require-push-before-stop",
  "require-pr-before-stop",
  "require-no-conflicts-before-stop",
  "require-ci-green-before-stop",
];

/**
 * Modules that take a policy out of the sealed tier. `node:path` is
 * deliberately absent: it is pure string arithmetic with no syscall surface,
 * and the sealed worker supplies it. Everything here can touch the filesystem,
 * spawn a process, open a socket, or read ambient host identity.
 */
const HOST_MODULES = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:os",
  "node:net",
  "node:http",
  "node:https",
  "node:dgram",
  "node:worker_threads",
  "node:vm",
  "node:process",
  "node:cluster",
  "node:tls",
  "node:dns",
  "node:v8",
  "node:inspector",
  "node:module",
  // Bare specifiers, in case an import ever drops the `node:` prefix.
  "fs",
  "fs/promises",
  "child_process",
  "os",
  "net",
  "http",
  "https",
  "process",
];

/**
 * Strip comments so prose like "a stray `import { readFile }`" in a doc block
 * is not mistaken for a real import — and, more importantly, so a real import
 * hidden in a comment is not counted either way.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Every import specifier in a TS source, from static imports, re-exports,
 * dynamic `import()`, and `require()`.
 *
 * The clause body is matched with `[^;]*?` rather than `[^;\n]*?` on purpose:
 * this codebase's imports are routinely multi-line, and a newline-excluding
 * character class silently matched none of them — which made an earlier version
 * of this whole file pass vacuously while `payload-only.ts` transitively
 * imported `node:fs`. A mutation check (inject `node:fs` into `shared.ts`, watch
 * the suite fail) is the only thing that catches that; re-run it after touching
 * these regexes.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `import ... from "x"` / `export ... from "x"`, single- or multi-line.
  const staticRe = /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  // Side-effect import: `import "x"`.
  const bareImportRe = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, bareImportRe, dynamicRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Resolve a relative specifier to a real file on disk, or null if it is bare. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolvePath(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate, "utf8");
        return candidate;
      } catch {
        /* a directory — keep looking */
      }
    }
  }
  return null;
}

/**
 * Walk the transitive import graph from `entry`, returning every
 * `(importer, hostModule)` pair found. Relative imports are followed; bare
 * specifiers are recorded but not followed (a bare non-`node:` specifier is a
 * third-party package, which is itself disqualifying for the sealed tier and
 * is reported by the caller).
 */
function walkGraph(entry: string): {
  visited: string[];
  hostHits: Array<{ file: string; spec: string }>;
  bareHits: Array<{ file: string; spec: string }>;
} {
  const visited = new Set<string>();
  const hostHits: Array<{ file: string; spec: string }> = [];
  const bareHits: Array<{ file: string; spec: string }> = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = stripComments(readFileSync(file, "utf8"));
    // Type-only imports vanish at runtime and cannot pull a host module in, so
    // they are exempt — but only when the whole clause is `import type`.
    const runtimeSource = source.replace(/(?:^|[\n;])\s*import\s+type\b[^;]*;/g, "\n");

    for (const spec of importSpecifiers(runtimeSource)) {
      if (HOST_MODULES.includes(spec)) {
        hostHits.push({ file: file.slice(REPO_ROOT.length + 1), spec });
        continue;
      }
      const resolved = resolveRelative(file, spec);
      if (resolved) {
        queue.push(resolved);
      } else if (!spec.startsWith("node:")) {
        bareHits.push({ file: file.slice(REPO_ROOT.length + 1), spec });
      }
    }
  }

  return { visited: [...visited].map((f) => f.slice(REPO_ROOT.length + 1)).sort(), hostHits, bareHits };
}

describe("BUILTIN_POLICIES registry snapshot", () => {
  it("presents the same policies, in the same order, with the same metadata", () => {
    const actual = BUILTIN_POLICIES.map((p) => [
      p.name,
      p.category,
      p.defaultEnabled,
      p.beta ?? null,
    ]);
    expect(actual).toEqual(REGISTRY_SNAPSHOT);
  });

  it("has 39 policies and no duplicate names", () => {
    expect(BUILTIN_POLICIES).toHaveLength(39);
    const names = BUILTIN_POLICIES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("capability partition", () => {
  it("splits every policy into exactly one tier", () => {
    const payload = PAYLOAD_ONLY_POLICIES.map((p) => p.name).sort();
    const host = HOST_ACCESS_POLICIES.map((p) => p.name).sort();
    const all = BUILTIN_POLICIES.map((p) => p.name).sort();

    expect(payload.length + host.length).toBe(all.length);
    expect([...payload, ...host].sort()).toEqual(all);
    // Disjoint.
    expect(payload.filter((n) => host.includes(n))).toEqual([]);
  });

  it("routes exactly the seven host-touching policies to host-access", () => {
    expect(HOST_ACCESS_POLICIES.map((p) => p.name).sort()).toEqual([...HOST_ACCESS_NAMES].sort());
  });

  it("leaves 32 policies sealed-eligible", () => {
    // Derived, not hardcoded: if a policy moves tiers this fails alongside the
    // explicit list above, which makes the intent of the move obvious.
    expect(PAYLOAD_ONLY_POLICIES).toHaveLength(BUILTIN_POLICIES.length - HOST_ACCESS_NAMES.length);
    expect(PAYLOAD_ONLY_POLICIES).toHaveLength(32);
  });

  it("keeps every policy function referentially identical to its registry entry", () => {
    // The registry must point at the SAME function objects the tier modules
    // export — not at wrappers. A wrapper would mean the sealed worker and the
    // legacy evaluator run different code for the same policy name.
    const byName = new Map(BUILTIN_POLICIES.map((p) => [p.name, p.fn]));
    for (const p of [...PAYLOAD_ONLY_POLICIES, ...HOST_ACCESS_POLICIES]) {
      expect(byName.get(p.name)).toBe(p.fn);
    }
  });
});

describe("payload-only import graph", () => {
  const entry = resolvePath(REPO_ROOT, "src/hooks/builtin/payload-only.ts");
  const graph = walkGraph(entry);

  it("reaches no host module, transitively", () => {
    // If this fails, the sealed tier is silently empty: tier derivation reads
    // the resolved import graph, so ONE host import anywhere in this graph
    // demotes all 32 policies to user-context. Fix the import — do not relax
    // HOST_MODULES.
    expect(graph.hostHits).toEqual([]);
  });

  it("reaches no third-party package", () => {
    expect(graph.bareHits).toEqual([]);
  });

  it("actually walked the whole graph, not just the entry file", () => {
    // The anti-vacuity guard, and it earns its keep: an earlier version of the
    // specifier regex used `[^;\n]*?`, which matches single-line imports only.
    // Every import in `payload-only.ts` is multi-line, so the walk stopped at
    // the entry file and the suite went green while the module transitively
    // imported `node:fs`. Naming the expected modules turns "the walk found
    // nothing" into a failure instead of a pass.
    expect(graph.visited).toEqual([
      "src/hooks/builtin/host-context.ts",
      "src/hooks/builtin/payload-only.ts",
      "src/hooks/builtin/shared.ts",
      "src/hooks/builtin/warn.ts",
      "src/hooks/policy-helpers.ts",
    ]);
  });
});

describe("host-access import graph", () => {
  const entry = resolvePath(REPO_ROOT, "src/hooks/builtin/host-access.ts");
  const graph = walkGraph(entry);

  it("does reach a host module — otherwise the split is mislabelled", () => {
    // The inverse assertion. If host-access stops needing the host, the seven
    // policies belong in the sealed tier and this test should be updated
    // deliberately rather than the partition quietly becoming meaningless.
    expect(graph.hostHits.length).toBeGreaterThan(0);
    expect(graph.hostHits.map((h) => h.spec)).toContain("node:child_process");
  });
});
