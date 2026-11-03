// @vitest-environment node
/**
 * Publishing to a repository that does not exist yet also has to leave a
 * repository the author can push to.
 *
 * It used to create it with `auto_init: true`, so GitHub wrote an "Initial
 * commit" the author did not have. Their `git push` was then rejected as
 * unrelated history — every time, for everyone — and the release tag named a
 * README commit containing none of the policies it shipped.
 *
 * These drive real `git` against a real local bare repository standing in for
 * GitHub (`FAILPROOFAI_GITHUB_GIT`), because the failure being fixed is a
 * property of git's history model, and asserting on a mock would only restate
 * the assumption that got it wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let work: string;
let remotes: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-push-"));
  work = join(root, "guards");
  remotes = join(root, "remotes");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(remotes, "acme"), { recursive: true });
  // The repository publish is about to "create": empty, no commits, exactly
  // what a repo made without auto_init is.
  execFileSync("git", ["init", "-q", "--bare", join(remotes, "acme", "guards.git")]);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "guards.mjs"), "// the author's real work\n", "utf8");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "feat: my guards");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** `GITHUB_GIT` is read at module scope, so the module is re-imported after the
 *  variable is set rather than before. */
async function push(): Promise<boolean> {
  vi.stubEnv("FAILPROOFAI_GITHUB_GIT", remotes);
  vi.resetModules();
  const { __pushExistingHistoryForTest } = await import("../../src/hooks/pack-cli");
  return __pushExistingHistoryForTest(work, "acme", "guards", "unused-token");
}

describe("the author's history reaches the new repository", () => {
  it("pushes it, so the commit that holds the policies is what the tag names", async () => {
    expect(await push()).toBe(true);
    const remoteLog = git(join(remotes, "acme", "guards.git"), "log", "--oneline", "main");
    expect(remoteLog).toMatch(/feat: my guards/);
  });

  it("leaves the branch tracking origin, so a later bare `git push` works", async () => {
    expect(await push()).toBe(true);
    expect(git(work, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    // The thing the old behaviour made impossible: pushing again, with no
    // arguments and no reconciliation.
    writeFileSync(join(work, "more.mjs"), "// a second policy\n", "utf8");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "feat: one more");
    expect(() => git(work, "push")).not.toThrow();
  });

  it("does not touch an origin the author already set", async () => {
    const theirs = join(remotes, "acme", "theirs.git");
    execFileSync("git", ["init", "-q", "--bare", theirs]);
    git(work, "remote", "add", "origin", theirs);
    expect(await push()).toBe(true);
    // Their remote still points where they pointed it...
    expect(git(work, "remote", "get-url", "origin")).toBe(theirs);
    // ...and the pack's repository got the history anyway.
    expect(git(join(remotes, "acme", "guards.git"), "log", "--oneline", "main")).toMatch(/feat: my guards/);
  });

  it("reports false, and adds no remote, when there is nothing committed yet", async () => {
    rmSync(join(work, ".git"), { recursive: true, force: true });
    git(work, "init", "-q", "-b", "main"); // unborn HEAD: no commits
    expect(await push()).toBe(false);
    expect(() => git(work, "remote", "get-url", "origin")).toThrow();
  });
});
