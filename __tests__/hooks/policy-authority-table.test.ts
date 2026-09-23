// @vitest-environment node
/**
 * The builtin authority table (decision D1, 2026-09-22), pinned.
 *
 * Which builtin verdicts Jev may clear is a product decision, made per policy
 * and reviewed by a person. Nothing about it should be able to change by
 * accident: not by a catalog edit, not by a renamed semantic policy, not by a
 * new builtin that forgot to decide. So the table is written out here in full,
 * and the published docs page is held to it too — a hand-maintained table with
 * nothing checking it is the #337 drift class.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_POLICIES, registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import { clearPolicies, getAllPolicies } from "../../src/hooks/policy-registry";
import { effectiveAuthority } from "../../src/hooks/policy-types";
import { SEMANTIC_REVIEWER_NAMES, resolvePolicyAuthority } from "../../src/hooks/policy-authority";

/** D1: the only builtins Jev may clear, and the checks that must clear them. */
const REVIEWABLE: Record<string, string[]> = {
  "block-read-outside-cwd": ["read-outside-workspace"],
  "protect-env-vars": ["env-secrets-dump", "secret-exposure"],
  "block-env-files": ["secret-exposure"],
  "block-work-on-main": ["commit-on-protected-branch"],
  "warn-git-amend": ["git-history-rewrite"],
  "warn-destructive-sql": ["database-destruction"],
  "warn-global-package-install": ["system-modification"],
};

/** The research floor. Named individually so none can drift to reviewable unseen. */
const FLOOR = [
  "block-rm-rf", "block-sudo", "block-curl-pipe-sh", "block-push-master",
  "block-kubectl", "block-terraform", "block-aws-cli", "block-gcloud",
  "block-az-cli", "block-helm", "block-gh-pipeline",
  "block-secrets-write", "block-force-push", "block-failproofai-commands",
];

/**
 * The hard-floor additions of T7 (decision D5) have LANDED, so every one of
 * them is a builtin the checks below reach through `POLICY_CATALOG`, and this
 * set is empty on purpose: nothing but a builtin may appear in the docs table
 * any more, so a typo'd or cut-policy row fails. Two drafted floor policies
 * (`block-mass-kill`, `block-no-verify`) were cut from the scope and must not
 * come back here — four ship, not six.
 */
const ARRIVING_HARD = new Set<string>([]);

const DOC = readFileSync(resolve(__dirname, "../../docs/policies/authority.mdx"), "utf8");

/** Rows of every `| \`name\` | authority | reviewedBy | why |` table in the doc. */
function docRows(): Map<string, { authority: string; reviewedBy: string[] }> {
  const rows = new Map<string, { authority: string; reviewedBy: string[] }>();
  for (const line of DOC.split("\n")) {
    const m = /^\| `([a-z0-9-]+)` \| (hard|reviewable) \|([^|]*)\|/.exec(line);
    if (!m) continue;
    const reviewedBy = [...m[3].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]);
    expect(rows.has(m[1]), `${m[1]} is listed twice in the docs table`).toBe(false);
    rows.set(m[1], { authority: m[2], reviewedBy });
  }
  return rows;
}

describe("the builtin authority table (D1)", () => {
  it("makes exactly the D1 policies reviewable, each through exactly the D1 checks", () => {
    const reviewable = Object.fromEntries(
      POLICY_CATALOG.filter((p) => effectiveAuthority(p) === "reviewable").map((p) => [p.name, p.reviewedBy]),
    );
    expect(reviewable).toEqual(REVIEWABLE);
  });

  it("states an authority on every catalog entry, so each builtin is a decision and not a default", () => {
    // A new builtin that says nothing would quietly be hard — the safe answer,
    // but not a considered one. Make whoever adds it decide.
    const silent = POLICY_CATALOG.filter((p) => p.authority !== "hard" && p.authority !== "reviewable");
    expect(silent.map((p) => p.name)).toEqual([]);
  });

  it("keeps the whole research floor hard", () => {
    const byName = new Map(POLICY_CATALOG.map((p) => [p.name, p]));
    for (const name of FLOOR) {
      expect(byName.has(name), `${name} is not a builtin`).toBe(true);
      expect(effectiveAuthority(byName.get(name)!), name).toBe("hard");
    }
  });

  it("keeps sanitize-* and require-*-before-stop hard: they are not PreToolUse gates", () => {
    const ungated = POLICY_CATALOG.filter(
      (p) => p.name.startsWith("sanitize-") || /^require-.*-before-stop$/.test(p.name),
    );
    expect(ungated).toHaveLength(10);
    for (const p of ungated) expect(effectiveAuthority(p), p.name).toBe("hard");
  });

  it("keeps the self-protection guard hard, and declares it hard rather than relying on alwaysOn", () => {
    const guard = POLICY_CATALOG.find((p) => p.name === "block-failproofai-commands")!;
    expect(guard.alwaysOn).toBe(true);
    expect(guard.authority).toBe("hard");
    expect("reviewedBy" in guard).toBe(false);
  });

  it("names only semantic policies this build has, so no declaration is silently downgraded", () => {
    for (const p of POLICY_CATALOG) {
      for (const name of p.reviewedBy ?? []) {
        expect(SEMANTIC_REVIEWER_NAMES.has(name), `${p.name} → ${name}`).toBe(true);
      }
      expect(resolvePolicyAuthority(p).downgraded, p.name).toBeUndefined();
    }
  });

  it("gives reviewedBy only to reviewable entries", () => {
    const stray = POLICY_CATALOG.filter((p) => p.authority !== "reviewable" && "reviewedBy" in p);
    expect(stray.map((p) => p.name)).toEqual([]);
  });
});

describe("builtin registration carries the table into the registry", () => {
  it("registers every builtin with its resolved authority", () => {
    clearPolicies();
    try {
      registerBuiltinPolicies(BUILTIN_POLICIES.map((p) => p.name));
      const registered = new Map(getAllPolicies().map((r) => [r.name, r]));
      expect(registered.size).toBe(POLICY_CATALOG.length);
      for (const p of POLICY_CATALOG) {
        const r = registered.get(`failproofai/${p.name}`)!;
        const expected = REVIEWABLE[p.name];
        if (expected) {
          expect(r.authority, p.name).toBe("reviewable");
          expect(r.reviewedBy, p.name).toEqual(expected);
        } else {
          expect(r.authority, p.name).toBe("hard");
          expect("reviewedBy" in r, p.name).toBe(false);
        }
      }
    } finally {
      clearPolicies();
    }
  });

  it("registers the alwaysOn guard as hard even if its catalog entry claimed reviewable", () => {
    // The registry holds no alwaysOn flag, so the evaluator cannot apply that
    // rule later — registration has to. Proven by corrupting the entry for the
    // duration of one registration, then putting it back.
    const guard = BUILTIN_POLICIES.find((p) => p.name === "block-failproofai-commands")!;
    const saved = { authority: guard.authority, reviewedBy: guard.reviewedBy };
    clearPolicies();
    try {
      guard.authority = "reviewable";
      guard.reviewedBy = ["agent-config-tampering"];
      registerBuiltinPolicies([]);
      const [only] = getAllPolicies();
      expect(only.name).toBe("failproofai/block-failproofai-commands");
      expect(only.authority).toBe("hard");
      expect(only.reviewedBy).toBeUndefined();
      expect(effectiveAuthority(only)).toBe("hard");
    } finally {
      guard.authority = saved.authority;
      if (saved.reviewedBy === undefined) delete guard.reviewedBy;
      else guard.reviewedBy = saved.reviewedBy;
      clearPolicies();
    }
  });
});

describe("the docs page (docs/policies/authority.mdx) matches the table", () => {
  it("lists every builtin with the authority and checks it actually has", () => {
    const rows = docRows();
    for (const p of POLICY_CATALOG) {
      const row = rows.get(p.name);
      expect(row, `${p.name} is missing from the docs table`).toBeDefined();
      expect(row!.authority, p.name).toBe(effectiveAuthority(p));
      expect(row!.reviewedBy, p.name).toEqual(p.reviewedBy ?? []);
    }
  });

  it("lists nothing that is not a builtin, except the announced hard-floor additions, as hard", () => {
    const names = new Set(POLICY_CATALOG.map((p) => p.name));
    for (const [name, row] of docRows()) {
      if (names.has(name)) continue;
      expect(ARRIVING_HARD.has(name), `${name} is in the docs table but is not a builtin`).toBe(true);
      expect(row.authority, name).toBe("hard");
    }
  });

  it("lists exactly the semantic policy names reviewedBy accepts", () => {
    const section = DOC.slice(DOC.indexOf("## Semantic policy names"));
    const listed = [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...SEMANTIC_REVIEWER_NAMES].sort());
  });
});
