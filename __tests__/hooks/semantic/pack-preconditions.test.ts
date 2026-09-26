// @vitest-environment node
/**
 * Pack preconditions: a NAME in a manifest, a predicate compiled into this
 * build, and the two lists pinned to each other.
 *
 * The pin is the point. A name with no predicate behind it validates at install
 * and then gates nothing — the policy is asked about every call instead of the
 * ones it was written for — and nothing else in the system would notice. The
 * split into two files (`precondition-names.ts` has zero imports so
 * `pack-manifest.ts` can validate a name on the hook path without loading Jev's
 * prompts) is exactly what makes that drift possible, so it is exactly what has
 * to be tested.
 */
import { describe, expect, it } from "vitest";
import { selectPolicies } from "../../../src/hooks/semantic/compile";
import {
  IMPLEMENTED_PRECONDITION_NAMES,
  PACK_PRECONDITIONS,
  preconditionFor,
} from "../../../src/hooks/semantic/preconditions";
import { PACK_PRECONDITION_NAMES, isPackPreconditionName } from "../../../src/hooks/semantic/precondition-names";
import { SEMANTIC_POLICIES } from "../../../src/hooks/semantic/policies";
import type { Facts, PathFact, SemanticPolicy } from "../../../src/hooks/semantic/types";

const PROJECT = "/home/dev/project";
const HOME = "/home/dev";

const path = (resolved: string, relation: PathFact["relation"]): PathFact => ({
  asWritten: resolved,
  resolved,
  relation,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  toolName: "Bash",
  toolClass: "shell",
  toolIsKnown: true,
  cwd: PROJECT,
  projectRoot: PROJECT,
  currentGitBranch: null,
  paths: [],
  permissionMode: null,
  ...over,
});

const holds = (name: string, f: Facts): boolean => {
  const predicate = preconditionFor(name as (typeof PACK_PRECONDITION_NAMES)[number]);
  return predicate ? predicate(f) : true;
};

describe("the two files stay in step", () => {
  it("every declared name has a predicate", () => {
    expect(IMPLEMENTED_PRECONDITION_NAMES).toEqual([...PACK_PRECONDITION_NAMES]);
  });

  it("every predicate has a declared name", () => {
    expect(Object.keys(PACK_PRECONDITIONS).sort()).toEqual([...PACK_PRECONDITION_NAMES].sort());
  });

  it("the name list is what the validator accepts, and nothing else", () => {
    for (const name of PACK_PRECONDITION_NAMES) expect(isPackPreconditionName(name)).toBe(true);
    for (const bad of ["ALWAYS", "protected-branch", "", "facts.paths.length > 0", 7, null, undefined]) {
      expect(isPackPreconditionName(bad), String(bad)).toBe(false);
    }
  });

  it("throws on a name with no predicate, rather than gating nothing", () => {
    expect(() => preconditionFor("on_a_tuesday" as never)).toThrow(/has no predicate in this build/);
  });
});

describe("always", () => {
  it("is null, not a () => true — so it compiles to the same policy as omitting the field", () => {
    // `selectPolicies` treats an absent precondition as "ask about this call", so
    // the two spellings must be indistinguishable downstream.
    expect(preconditionFor("always")).toBeNull();
  });
});

describe("protected_branch", () => {
  it("holds on the protected names and nowhere else", () => {
    for (const branch of ["main", "master", "production", "prod", "release", "trunk"]) {
      expect(holds("protected_branch", facts({ currentGitBranch: branch })), branch).toBe(true);
    }
    for (const branch of ["feat/x", "main-ish", "Main", "release-candidate"]) {
      expect(holds("protected_branch", facts({ currentGitBranch: branch })), branch).toBe(false);
    }
  });

  it("does not hold outside a repository", () => {
    expect(holds("protected_branch", facts({ currentGitBranch: null }))).toBe(false);
  });

  it("uses the same list the builtin semantic policy uses, not a copy of it", () => {
    // The list lives in `policies.ts` and is imported. If it were restated, a
    // branch added there would stop gating a pack's policy silently — so this
    // drives the real builtin and the pack predicate off one branch name.
    const builtin = SEMANTIC_POLICIES.find((p) => p.name === "commit-on-protected-branch") as SemanticPolicy;
    for (const branch of ["trunk", "feat/x"]) {
      const f = facts({ currentGitBranch: branch });
      expect(builtin.precondition?.(f), branch).toBe(holds("protected_branch", f));
    }
  });
});

describe("in_git_repo", () => {
  it("is exactly currentGitBranch !== null, detached HEAD included", () => {
    expect(holds("in_git_repo", facts({ currentGitBranch: "feat/x" }))).toBe(true);
    // `facts.ts` returns null for a detached HEAD, so a bisect reads as "not in a
    // repository" — the safe direction: an unasked question leaves the regex
    // verdict standing.
    expect(holds("in_git_repo", facts({ currentGitBranch: null }))).toBe(false);
  });
});

describe("has_paths", () => {
  it("holds only when the call names one", () => {
    expect(holds("has_paths", facts())).toBe(false);
    expect(holds("has_paths", facts({ paths: [path(`${PROJECT}/src/a.ts`, "inside_project")] }))).toBe(true);
  });
});

describe("paths_outside_project", () => {
  it("holds for every relation that means 'not in the project'", () => {
    for (const p of [
      path("/tmp/claude-501/x.json", "system"),
      path("/etc/hosts", "system"),
      path(`${HOME}/other/notes.txt`, "outside_project_in_home"),
      path(HOME, "home_root"),
      path("/", "root"),
    ]) {
      expect(holds("paths_outside_project", facts({ paths: [p] })), p.resolved).toBe(true);
    }
  });

  it("does not hold for paths inside the project", () => {
    const inside = facts({ paths: [path(`${PROJECT}/src/index.ts`, "inside_project"), path(PROJECT, "project_root")] });
    expect(holds("paths_outside_project", inside)).toBe(false);
  });

  it("also catches a sibling of the live cwd, like its builtin twin does", () => {
    // The second test in `outsideProject`: the regex partner measures from the
    // session cwd, which drifts below the git root as the agent `cd`s, so a
    // sibling directory is `inside_project` here and outside there.
    const sibling = facts({
      cwd: `${PROJECT}/packages/a`,
      paths: [path(`${PROJECT}/packages/b/x.ts`, "inside_project")],
    });
    expect(holds("paths_outside_project", sibling)).toBe(true);
  });

  it("agrees with read-outside-workspace on the same facts", () => {
    const builtin = SEMANTIC_POLICIES.find((p) => p.name === "read-outside-workspace") as SemanticPolicy;
    for (const p of [path("/etc/hosts", "system"), path(`${PROJECT}/src/a.ts`, "inside_project")]) {
      const f = facts({ paths: [p] });
      expect(builtin.precondition?.(f), p.resolved).toBe(holds("paths_outside_project", f));
    }
  });
});

describe("system_or_root_paths", () => {
  it("holds for system and root, and for nothing in or under home", () => {
    expect(holds("system_or_root_paths", facts({ paths: [path("/etc/hosts", "system")] }))).toBe(true);
    expect(holds("system_or_root_paths", facts({ paths: [path("/", "root")] }))).toBe(true);
    expect(holds("system_or_root_paths", facts({ paths: [path(HOME, "home_root")] }))).toBe(false);
    expect(
      holds("system_or_root_paths", facts({ paths: [path(`${HOME}/other/x`, "outside_project_in_home")] })),
    ).toBe(false);
    expect(holds("system_or_root_paths", facts({ paths: [] }))).toBe(false);
  });
});

describe("a bound precondition selects the way a builtin's does", () => {
  const policy = (precondition: SemanticPolicy["precondition"]): SemanticPolicy => ({
    name: "pack-check",
    title: "Did the thing",
    appliesTo: ["shell"],
    mode: "deny",
    userCanOverride: true,
    probes: [{ id: "did_it", instructions: "i" }],
    guidance: "g",
    ...(precondition ? { precondition } : {}),
  });

  it("is not asked when the precondition is false", () => {
    const gated = policy(preconditionFor("paths_outside_project") ?? undefined);
    expect(selectPolicies([gated], facts({ paths: [path(`${PROJECT}/a.ts`, "inside_project")] }))).toEqual([]);
    expect(selectPolicies([gated], facts({ paths: [path("/etc/hosts", "system")] }))).toHaveLength(1);
  });

  it("is asked on every applicable call when the name is `always`", () => {
    const ungated = policy(preconditionFor("always") ?? undefined);
    expect(selectPolicies([ungated], facts())).toHaveLength(1);
  });
});
