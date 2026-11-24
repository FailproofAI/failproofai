// @vitest-environment node
/**
 * Post-release version bumps reach `main` through review, never by a push.
 *
 * Every release workflow used to end by pushing the next version straight to
 * `main` as the version-bot GitHub App, a bypass actor on the `failproofai-rules`
 * ruleset. Its secret was readable by any job that asked for it, so it was a way
 * past code review for anyone who could run a workflow. When it was removed,
 * every release broke: `publish.yml` minted its token as the FIRST step of the
 * publish job, so a missing bot stopped the npm publish itself, not just the bump.
 *
 * Now each bump commit goes to a `version-bump/...` branch through
 * scripts/push-version-bump.sh, pushed with the job's own token (which the
 * ruleset rejects on `main`). The script opens the pull request itself (or links
 * it when GitHub refuses), and a person approves it.
 * This file runs that script against a real git remote and pins the workflows to
 * it, so neither a bypass credential nor a direct push to `main` can come back
 * unnoticed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/push-version-bump.sh");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

describe("scripts/push-version-bump.sh, against a real remote", () => {
  let dir: string;
  let remote: string;
  let work: string;
  let summary: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY } }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-version-bump-"));
    remote = join(dir, "remote.git");
    work = join(dir, "work");
    summary = join(dir, "summary.md");
    git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
    git(dir, "init", "--quiet", "-b", "main", work);
    writeFileSync(join(work, "package.json"), '{ "version": "1.0.0" }\n');
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "release 1.0.0");
    git(work, "push", "--quiet", remote, "HEAD:refs/heads/main");
    writeFileSync(join(work, "package.json"), '{ "version": "1.0.1-beta.0" }\n');
    git(work, "commit", "--quiet", "-am", "chore: bump version to 1.0.1-beta.0");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync("bash", [SCRIPT, ...args], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        // Next's global augmentation makes NODE_ENV a required member of
        // ProcessEnv, so a minimal env literal has to carry it.
        NODE_ENV: process.env.NODE_ENV,
        HOME: dir,
        GITHUB_REPOSITORY: "FailproofAI/failproofai",
        GITHUB_STEP_SUMMARY: summary,
        PUSH_REMOTE: remote,
        ...env,
      },
    });
  }

  const remoteRef = (ref: string) =>
    spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).stdout.trim();

  it("pushes the bump to its own branch and leaves main alone", () => {
    const mainBefore = remoteRef("refs/heads/main");
    const result = run(["version-bump/failproofai-1.0.1-beta.0", "chore: bump version to 1.0.1-beta.0"]);

    expect(result.status, result.stderr).toBe(0);
    expect(remoteRef("refs/heads/version-bump/failproofai-1.0.1-beta.0")).toBe(git(work, "rev-parse", "HEAD"));
    expect(remoteRef("refs/heads/main")).toBe(mainBefore);
  });

  it("links a pre-filled pull request against main, in the log and the job summary", () => {
    const result = run([
      "version-bump/failproofai-1.0.1-beta.0",
      "chore: bump version to 1.0.1-beta.0",
      "Opens 1.0.1-beta.0 & nothing else",
    ]);
    expect(result.status, result.stderr).toBe(0);

    const link =
      "https://github.com/FailproofAI/failproofai/compare/main...version-bump/failproofai-1.0.1-beta.0" +
      "?quick_pull=1&title=chore%3A%20bump%20version%20to%201.0.1-beta.0" +
      "&body=Opens%201.0.1-beta.0%20%26%20nothing%20else";
    expect(result.stdout).toContain(link);
    expect(readFileSync(summary, "utf8")).toContain(`(${link})`);
  });

  it.each(["main", "refs/heads/main", "release/1.0.1", "version-bump/"])("refuses to push to %s", (branch) => {
    const mainBefore = remoteRef("refs/heads/main");
    const result = run([branch, "chore: bump version to 1.0.1-beta.0"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("refusing to push a version bump");
    expect(remoteRef("refs/heads/main")).toBe(mainBefore);
  });

  it("leaves a bump that is already waiting for review alone", () => {
    // Force-pushing is blocked on every branch here, and a re-run should not
    // fail a release whose bump is already up for review.
    expect(run(["version-bump/x", "chore: bump"]).status).toBe(0);
    const waiting = remoteRef("refs/heads/version-bump/x");

    writeFileSync(join(work, "package.json"), '{ "version": "9.9.9" }\n');
    git(work, "commit", "--quiet", "-am", "something else");
    const again = run(["version-bump/x", "chore: bump"]);

    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("already exists");
    expect(again.stdout).toContain("compare/main...version-bump/x");
    expect(remoteRef("refs/heads/version-bump/x")).toBe(waiting);
  });

  it("will not push to GitHub without the job's token", () => {
    const result = run(["version-bump/x", "chore: bump"], { PUSH_REMOTE: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_TOKEN is required");
  });

  describe("opening the pull request", () => {
    // A stand-in `gh` that records every call and answers `pr list` / `pr create`
    // the way the real one does, steered by FAKE_GH_EXISTING and FAKE_GH_CREATE.
    let fakeGh: string;
    let ghLog: string;

    beforeEach(() => {
      fakeGh = join(dir, "gh");
      ghLog = join(dir, "gh.log");
      writeFileSync(
        fakeGh,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
          'case "$1 $2" in',
          '  "pr list") printf "%s\\n" "${FAKE_GH_EXISTING:-}" ;;',
          '  "pr create")',
          '    if [ "${FAKE_GH_CREATE:-ok}" = ok ]; then',
          '      echo "https://github.com/FailproofAI/failproofai/pull/4242"',
          "    else",
          '      echo "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)" >&2',
          "      exit 1",
          "    fi ;;",
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(fakeGh, 0o755);
    });

    const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : []);

    it("opens it against main with the bump's title and body", () => {
      const result = run(["version-bump/x", "chore: bump version to 1.0.1-beta.0", "Opens 1.0.1-beta.0"], {
        GH_BIN: fakeGh,
        FAKE_GH_LOG: ghLog,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Opened https://github.com/FailproofAI/failproofai/pull/4242");
      expect(ghCalls()).toContain(
        "pr create --repo FailproofAI/failproofai --base main --head version-bump/x " +
          "--title chore: bump version to 1.0.1-beta.0 --body Opens 1.0.1-beta.0",
      );
      expect(readFileSync(summary, "utf8")).toContain("https://github.com/FailproofAI/failproofai/pull/4242");
    });

    it("does not open a second pull request on a re-run", () => {
      const existing = "https://github.com/FailproofAI/failproofai/pull/4000";
      const result = run(["version-bump/x", "chore: bump"], {
        GH_BIN: fakeGh,
        FAKE_GH_LOG: ghLog,
        FAKE_GH_EXISTING: existing,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Already open: ${existing}`);
      expect(ghCalls().some((call) => call.startsWith("pr create"))).toBe(false);
    });

    it("falls back to the link when Actions may not open pull requests, without failing the release", () => {
      const result = run(["version-bump/x", "chore: bump"], {
        GH_BIN: fakeGh,
        FAKE_GH_LOG: ghLog,
        FAKE_GH_CREATE: "denied",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("::warning title=Pull request not opened::");
      expect(result.stdout).toContain('Turn on "Allow GitHub Actions to create and approve pull requests"');
      expect(result.stdout).toContain("compare/main...version-bump/x?quick_pull=1");
      // The branch is pushed either way.
      expect(remoteRef("refs/heads/version-bump/x")).toBe(git(work, "rev-parse", "HEAD"));
    });

    it("never calls gh while pushing to a test remote unless told to", () => {
      // The real `gh` on a developer machine is signed in to the real repository.
      const result = run(["version-bump/x", "chore: bump"], {
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_GH_LOG: ghLog,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(ghCalls()).toEqual([]);
    });
  });
});

/** Every workflow that bumps a version after publishing, and where its bump lives. */
const BUMPS = [
  { file: "publish.yml", job: "publish", step: "Bump version for next development cycle" },
  { file: "publish-failproofai-ts-sdk.yml", job: "bump" },
  { file: "publish-failproofai-sdk.yml", job: "bump" },
  { file: "publish-fp-cloud-cli.yml", job: "bump" },
];

type Step = Record<string, any>;

function bumpSteps(file: string, job: string, step?: string): Step[] {
  const steps: Step[] = parse(readFileSync(resolve(WORKFLOWS, file), "utf8")).jobs[job].steps;
  return step ? steps.filter((s) => s.name === step) : steps;
}

describe("no workflow holds a credential that gets past review on main", () => {
  it.each(readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)))("%s", (file) => {
    const text = readFileSync(resolve(WORKFLOWS, file), "utf8");
    expect(text).not.toContain("create-github-app-token");
    expect(text).not.toMatch(/VERSION_BOT_(APP_ID|PRIVATE_KEY)/);
  });
});

describe.each(BUMPS)("$file", ({ file, job, step }) => {
  it("bumps through a reviewed pull request, never a push to main", () => {
    const steps = bumpSteps(file, job, step);
    expect(steps.length).toBeGreaterThan(0);
    const runs = steps.map((s) => String(s.run ?? "")).join("\n");

    expect(runs).toMatch(/bash scripts\/push-version-bump\.sh "version-bump\/[^"]+"/);
    expect(runs).not.toMatch(/HEAD:main|push origin main|HEAD:refs\/heads\/main/);
    // The job's own token, handed to the one step that pushes.
    const pusher = steps.find((s) => String(s.run ?? "").includes("push-version-bump.sh"));
    expect(pusher?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  it("can push the bump branch and open its pull request, and leaves no token on disk", () => {
    const workflow = parse(readFileSync(resolve(WORKFLOWS, file), "utf8"));
    expect(workflow.jobs[job].permissions?.contents).toBe("write");
    expect(workflow.jobs[job].permissions?.["pull-requests"]).toBe("write");
    const checkout = (workflow.jobs[job].steps as Step[]).find((s) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});

describe("submodules stay current without a workflow pushing to another repository", () => {
  it("has Dependabot open pull requests for every submodule", () => {
    // `bump-platform-submodule.yml` pushed gitlink bumps into other repositories
    // with the version bot. Dependabot opens reviewed pull requests instead, and
    // `skills` is public, so it needs no credential to read it.
    expect(existsSync(resolve(WORKFLOWS, "bump-platform-submodule.yml"))).toBe(false);
    if (!existsSync(resolve(ROOT, ".gitmodules"))) return;
    const dependabot = parse(readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8"));
    const entry = dependabot.updates.find((u: Record<string, any>) => u["package-ecosystem"] === "gitsubmodule");
    expect(entry?.directory).toBe("/");
  });
});
