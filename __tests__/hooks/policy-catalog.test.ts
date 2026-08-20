// @vitest-environment node
/**
 * Invariants for the catalog/implementation split.
 *
 * `builtin-policies.ts` no longer holds the policy metadata — `policy-catalog.ts`
 * does, and the exported `BUILTIN_POLICIES` is a join of the two. Every
 * assertion below guards a failure of that join that is SILENT: the suite that
 * existed before this split passed against a join that dropped rows, reordered
 * them, filled defaults, or wrapped every implementation in a closure.
 *
 * These are also the tripwires the pack migration leans on. When implementations
 * move out of the package entirely, "the catalog says 39 and 39 ran" stops being
 * a tautology and becomes the thing worth checking.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_POLICIES, SECRET_PATTERNS, registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import { clearPolicies, getAllPolicies } from "../../src/hooks/policy-registry";

const SRC = (p: string) => resolve(__dirname, "../../src", p);

/** The exact catalog order. Order is not cosmetic: evaluation short-circuits on
 *  the first deny, so this decides which policy name reaches the agent, the
 *  activity log, PostHog and the audit report. Nothing else pins it —
 *  policy-presets.test.ts compares via a Set. */
const EXPECTED_ORDER = [
  "sanitize-jwt", "sanitize-api-keys", "sanitize-connection-strings",
  "sanitize-private-key-content", "sanitize-bearer-tokens", "protect-env-vars",
  "block-env-files", "block-read-outside-cwd", "block-sudo", "block-curl-pipe-sh",
  "block-rm-rf", "block-failproofai-commands", "block-kubectl", "block-terraform",
  "block-aws-cli", "block-gcloud", "block-az-cli", "block-helm", "block-gh-pipeline",
  "block-secrets-write", "block-push-master", "block-force-push", "block-work-on-main",
  "warn-git-amend", "warn-git-stash-drop", "warn-all-files-staged",
  "warn-destructive-sql", "warn-schema-alteration", "warn-package-publish",
  "warn-global-package-install", "prefer-package-manager", "warn-large-file-write",
  "warn-background-process", "warn-repeated-tool-calls", "require-commit-before-stop",
  "require-push-before-stop", "require-pr-before-stop",
  "require-no-conflicts-before-stop", "require-ci-green-before-stop",
];

describe("policy catalog / implementation split", () => {
  describe("the join", () => {
    it("keeps catalog and joined view the same length and order", () => {
      expect(POLICY_CATALOG).toHaveLength(39);
      expect(BUILTIN_POLICIES).toHaveLength(39);
      expect(BUILTIN_POLICIES.map((p) => p.name)).toEqual(POLICY_CATALOG.map((e) => e.name));
    });

    it("pins the exact positional order", () => {
      // A join that iterated the implementation map, sorted for determinism, or
      // grouped by category would reorder this and change first-deny attribution.
      expect(BUILTIN_POLICIES.map((p) => p.name)).toEqual(EXPECTED_ORDER);
    });

    it("gives every catalog entry a real implementation", () => {
      const holes = BUILTIN_POLICIES.filter((p) => typeof p.fn !== "function").map((p) => p.name);
      expect(holes).toEqual([]);
    });

    it("assigns 39 DISTINCT implementations, never a shared wrapper", () => {
      // The wrapper-collapse guard. `fn: (ctx) => IMPLS[name](ctx)` yields 39
      // distinct function OBJECTS with near-identical source text, which freezes
      // audit/cache.ts's engineVersion — it then stops changing when policy logic
      // changes and stale audit results are served for the full 30-day TTL with
      // no symptom anywhere.
      expect(new Set(BUILTIN_POLICIES.map((p) => p.fn.toString())).size).toBe(39);
    });

    it("has unique names", () => {
      // resolveEverything() does not dedupe, findBuiltin takes the FIRST match and
      // registerPolicy takes the LAST — a duplicate silently registers one policy
      // fewer while the audit title comes from the other copy.
      expect(new Set(BUILTIN_POLICIES.map((p) => p.name)).size).toBe(39);
    });

    it("adds no fields the catalog did not have", () => {
      for (const entry of POLICY_CATALOG) {
        const joined = BUILTIN_POLICIES.find((p) => p.name === entry.name)!;
        expect(Object.keys(joined).sort()).toEqual([...Object.keys(entry), "fn"].sort());
      }
    });
  });

  describe("absent optionals stay absent", () => {
    // Asserted with `in`, not truthiness: a join spreading defaults
    // (`{beta: false, ...entry}`) would pass a truthiness check and still break
    // builtin-policies.test.ts's `expect(p.beta).toBeUndefined()`.
    it("sets beta on zero entries", () => {
      expect(BUILTIN_POLICIES.filter((p) => "beta" in p).map((p) => p.name)).toEqual([]);
    });

    it("sets alwaysOn on exactly the self-protection policy", () => {
      expect(BUILTIN_POLICIES.filter((p) => "alwaysOn" in p).map((p) => p.name)).toEqual([
        "block-failproofai-commands",
      ]);
    });

    it("sets params on exactly the entries that take them", () => {
      expect(BUILTIN_POLICIES.filter((p) => "params" in p).map((p) => p.name)).toEqual([
        "sanitize-api-keys", "block-read-outside-cwd", "block-sudo", "block-rm-rf",
        "block-kubectl", "block-terraform", "block-aws-cli", "block-gcloud",
        "block-az-cli", "block-helm", "block-gh-pipeline", "block-secrets-write",
        "block-push-master", "block-work-on-main", "prefer-package-manager",
        "warn-large-file-write", "require-push-before-stop", "require-pr-before-stop",
        "require-no-conflicts-before-stop",
      ]);
    });
  });

  describe("counts and ordering the UI depends on", () => {
    it("has 11 default-enabled policies", () => {
      expect(BUILTIN_POLICIES.filter((p) => p.defaultEnabled)).toHaveLength(11);
    });

    it("pins the category first-appearance order", () => {
      // This is the section order in the TUI picker (install-prompt.ts) and in the
      // dashboard (hooks-client.tsx). Neither has a test of its own, so a reshuffle
      // ships green.
      const seen: string[] = [];
      for (const p of BUILTIN_POLICIES) if (!seen.includes(p.category)) seen.push(p.category);
      expect(seen).toEqual([
        "Sanitize", "Environment", "Dangerous Commands", "Infra Commands", "Git",
        "Database", "Packages & System", "AI Behavior", "Workflow",
      ]);
    });

    it("registers in catalog order", () => {
      clearPolicies();
      registerBuiltinPolicies(EXPECTED_ORDER);
      expect(getAllPolicies().map((r) => r.name)).toEqual(
        EXPECTED_ORDER.map((n) => `failproofai/${n}`),
      );
      clearPolicies();
    });

    it("registers ONLY the alwaysOn guard for an empty enabled set", () => {
      clearPolicies();
      registerBuiltinPolicies([]);
      expect(getAllPolicies().map((r) => r.name)).toEqual([
        "failproofai/block-failproofai-commands",
      ]);
      clearPolicies();
    });
  });

  describe("the catalog is pure data", () => {
    it("survives a JSON round-trip unchanged", () => {
      // The property that lets the catalog become a shipped manifest rather than
      // code. A RegExp or function smuggled into an entry survives every other
      // test here and fails only once the catalog is serialized.
      expect(JSON.parse(JSON.stringify(POLICY_CATALOG))).toEqual(POLICY_CATALOG);
    });

    it("carries no functions on any entry", () => {
      const offenders: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (typeof v === "function") offenders.push(path);
        else if (v && typeof v === "object") {
          for (const [k, sub] of Object.entries(v)) walk(sub, `${path}.${k}`);
        }
      };
      POLICY_CATALOG.forEach((e, i) => walk(e, `[${i}:${e.name}]`));
      expect(offenders).toEqual([]);
    });

    it("never value-imports from builtin-policies (cycle guard)", () => {
      // policy-evaluator.ts builds POLICY_PARAMS_MAP from BUILTIN_POLICIES at
      // MODULE SCOPE. A cycle here is a ReferenceError under ESM and
      // `.filter of undefined` under the CJS bundle — thrown at import time, on
      // the hook critical path.
      const src = readFileSync(SRC("hooks/policy-catalog.ts"), "utf8");
      const valueImports = src
        .split("\n")
        .filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
      expect(valueImports.filter((l) => l.includes("builtin-policies"))).toEqual([]);
    });
  });

  describe("shared pattern list", () => {
    it("still exports SECRET_PATTERNS from builtin-policies, intact", () => {
      // Neither catalog metadata nor an implementation: the five sanitize-* fns
      // test against it AND audit/redact-example.ts imports it from this path.
      // Its hand-written most-specific-first ORDER is load-bearing — a
      // Bearer-wrapped JWT reports as "JWT" today and as "bearer token" if two
      // entries swap.
      expect(SECRET_PATTERNS).toHaveLength(13);
      for (const [re] of SECRET_PATTERNS) expect(re).toBeInstanceOf(RegExp);
    });
  });

  describe("hand-copied name tables still resolve", () => {
    // The #337 drift class: tables authored against the catalog by hand, with
    // nothing asserting they still match it. A rename makes the audit card fall
    // back to generic copy AND flips `alreadyEnabled` to false — telling users to
    // enable a policy they already have.
    const findings = readFileSync(SRC("audit/findings.ts"), "utf8");
    const names = new Set(BUILTIN_POLICIES.map((p) => p.name));

    const section = (start: string): string => {
      const i = findings.indexOf(start);
      expect(i, `${start} not found in findings.ts`).toBeGreaterThan(-1);
      const j = findings.indexOf("\n};", i);
      return findings.slice(i, j);
    };

    it("DETECTOR_TO_POLICY names a live policy in every primary/also", () => {
      const block = section("const DETECTOR_TO_POLICY");
      const refs = [...block.matchAll(/(?:primary|also):\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.filter((r) => !names.has(r))).toEqual([]);
    });

    it("POLICY_META is keyed entirely by live policy names", () => {
      const block = section("const POLICY_META");
      const keys = [...block.matchAll(/(?:^|\n)\s{2}"([^"]+)":\s*\{/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => !names.has(k))).toEqual([]);
    });
  });
});
