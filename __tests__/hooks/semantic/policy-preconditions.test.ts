// @vitest-environment node
/**
 * The preconditions in `policies.ts`, against the one property they exist to
 * have: a semantic policy named in a reviewable builtin's `reviewedBy` must be
 * ASKED wherever that builtin can fire. A question that is never asked cannot
 * come back clear, so `combine.ts` keeps the regex verdict standing — which is
 * how `block-read-outside-cwd` came to account for 154 of the denials on real
 * work, 106 of them with no paired question at all.
 *
 * Asking is not firing. Every case below asserts what is SELECTED, never what
 * the probe answers: the probe wording is a calibrated classifier and is not
 * this file's business.
 */
import { describe, expect, it } from "vitest";
import { selectPolicies } from "../../../src/hooks/semantic/compile";
import { SEMANTIC_POLICIES } from "../../../src/hooks/semantic/policies";
import type { Facts, PathFact } from "../../../src/hooks/semantic/types";

const PROJECT = "/home/dev/project";
const HOME = "/home/dev";

const path = (resolved: string, relation: PathFact["relation"]): PathFact => ({
  asWritten: resolved,
  resolved,
  relation,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  toolName: "Read",
  toolClass: "read",
  toolIsKnown: true,
  cwd: PROJECT,
  projectRoot: PROJECT,
  currentGitBranch: null,
  paths: [],
  permissionMode: null,
  ...over,
});

const selected = (f: Facts): string[] => selectPolicies(SEMANTIC_POLICIES, f).map((p) => p.name);
const asks = (f: Facts, name: string): boolean => selected(f).includes(name);

describe("read-outside-workspace is asked wherever block-read-outside-cwd can deny", () => {
  // `block-read-outside-cwd` denies on `resolved !== cwd && !resolved
  // .startsWith(cwd + "/")`. It does not care which of these it is.
  it.each([
    ["the agent's own temp dir (/tmp/claude-*)", path("/tmp/claude-501/x.json", "system")],
    ["a system file", path("/etc/hosts", "system")],
    ["another user's home", path("/home/other/notes.txt", "system")],
    ["a neighbouring repo in the user's home", path(`${HOME}/other/notes.txt`, "outside_project_in_home")],
    ["the home directory itself", path(HOME, "home_root")],
    ["the filesystem root", path("/", "root")],
  ])("%s", (_label, p) => {
    expect(asks(facts({ paths: [p] }), "read-outside-workspace")).toBe(true);
  });

  it("is not asked when nothing leaves the project — the tier has no concern to raise", () => {
    const inside = facts({ paths: [path(`${PROJECT}/src/index.ts`, "inside_project"), path(PROJECT, "project_root")] });
    expect(asks(inside, "read-outside-workspace")).toBe(false);
  });

  it("is not asked when the call names no path at all", () => {
    expect(asks(facts({ toolClass: "shell", toolName: "Bash", paths: [] }), "read-outside-workspace")).toBe(false);
  });

  it("one outside path among many inside is enough", () => {
    const mixed = facts({
      paths: [path(`${PROJECT}/a.ts`, "inside_project"), path(`${PROJECT}/b.ts`, "inside_project"), path("/tmp/t", "system")],
    });
    expect(asks(mixed, "read-outside-workspace")).toBe(true);
  });

  it("covers the partner's OTHER root: a path inside the repo but outside the session cwd", () => {
    // `block-read-outside-cwd` measures from $CLAUDE_PROJECT_DIR or, unset,
    // the live cwd, which drifts below the git root as the agent `cd`s. A
    // sibling package is then `inside_project` here and denied there.
    const drifted = facts({
      cwd: `${PROJECT}/packages/web`,
      projectRoot: PROJECT,
      paths: [path(`${PROJECT}/packages/api/src/index.ts`, "inside_project")],
    });
    expect(asks(drifted, "read-outside-workspace")).toBe(true);
  });

  it("a path under the drifted cwd is still inside it", () => {
    const drifted = facts({
      cwd: `${PROJECT}/packages/web`,
      projectRoot: PROJECT,
      paths: [path(`${PROJECT}/packages/web/src/app.ts`, "inside_project")],
    });
    expect(asks(drifted, "read-outside-workspace")).toBe(false);
  });

  it("is asked on Bash as well as the read tools — the partner matches both", () => {
    const bash = facts({ toolName: "Bash", toolClass: "shell", paths: [path("/tmp/claude-501/x", "system")] });
    expect(asks(bash, "read-outside-workspace")).toBe(true);
  });
});

describe("commit-on-protected-branch is asked wherever block-work-on-main can deny", () => {
  const onBranch = (branch: string | null): Facts =>
    facts({ toolName: "Bash", toolClass: "shell", currentGitBranch: branch });

  // `block-work-on-main`'s `protectedBranches` defaults to main + master.
  it.each(["main", "master", "production", "prod", "release", "trunk"])("asks on %s", (branch) => {
    expect(asks(onBranch(branch), "commit-on-protected-branch")).toBe(true);
  });

  it("is not asked on a feature branch, or with no branch at all", () => {
    expect(asks(onBranch("feat/jev-two-tier"), "commit-on-protected-branch")).toBe(false);
    expect(asks(onBranch(null), "commit-on-protected-branch")).toBe(false);
  });
});

describe("the pairings with no precondition are asked on their partner's tool class", () => {
  const bash = facts({ toolName: "Bash", toolClass: "shell" });
  // Each row: the reviewable builtin, and the semantic names its `reviewedBy`
  // lists (policy-catalog.ts). Only Bash-matched partners here; the path-based
  // ones are covered above.
  it.each([
    ["protect-env-vars", ["env-secrets-dump", "secret-exposure"]],
    ["warn-git-amend", ["git-history-rewrite"]],
    ["warn-destructive-sql", ["database-destruction"]],
    ["warn-global-package-install", ["system-modification"]],
    ["block-env-files", ["secret-exposure"]],
  ])("%s", (_builtin, reviewers) => {
    for (const name of reviewers as string[]) expect(asks(bash, name)).toBe(true);
  });

  it("block-env-files also fires on the file tools, where secret-exposure applies too", () => {
    for (const toolClass of ["read", "write"] as const) {
      expect(asks(facts({ toolClass, toolName: toolClass === "read" ? "Read" : "Write" }), "secret-exposure")).toBe(true);
    }
  });
});
