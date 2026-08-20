// @vitest-environment node
/**
 * Drift guard for the two failproofai-sdk workflows, and a sibling of
 * fp-cli-workflows.test.ts. Both files are hand-maintained and hold invariants a
 * reviewer reading the diff would not see break:
 *
 *   - publish-failproofai-sdk.yml grants `id-token: write` for Trusted Publishing.
 *     Naming any scope sets every unnamed one to `none`, so `contents: read` is what
 *     lets actions/checkout read the repo at all — it looks redundant and is not.
 *   - publishing is bound to a GitHub environment. Every other guard in that file (the
 *     actor allowlist, the ref check) lives on the ref being dispatched, so a writer
 *     could delete them on a branch and click Run; the environment's rules live in repo
 *     settings and in PyPI's publisher config, where a branch cannot reach them. The
 *     name has to match on both sides, so the header documents the same string.
 *   - the SDK installs with `--no-deps` in both the CI and publish smoke tests. That
 *     flag IS the zero-dependency assertion; dropping it turns the check into an
 *     ordinary install that would pass with a dependency silently added.
 *   - the test steps set FAILPROOFAI_SDK_REQUIRE_CONTRACT. Without it,
 *     test_spool_contract.py SKIPS when it cannot find the daemon sources instead of
 *     failing — which is exactly how its predecessor in the agenteye repo sat green
 *     and unverified.
 *   - sync-failproofai-sdk-skill.yml hands its PAT to git without writing it into
 *     $WORKDIR/.git/config, because the very next step runs a script fetched from the
 *     repo that PAT can write to.
 *   - the two skill syncs must not share a branch, label or concurrency group: each
 *     force-pushes its branch, so a shared one would overwrite the other's open PR.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();

function source(name: string): string {
  return readFileSync(resolve(ROOT, ".github/workflows", name), "utf8");
}

function workflow(name: string): Record<string, any> {
  return parse(source(name));
}

/** Every `run:` script in a job, concatenated — for asserting on shell logic. */
function runScripts(job: Record<string, any>): string {
  return (job.steps ?? []).map((s: Record<string, any>) => s.run ?? "").join("\n");
}

const PYPI_ENVIRONMENT = "pypi-failproofai-sdk";

describe("publish-failproofai-sdk.yml", () => {
  const job = workflow("publish-failproofai-sdk.yml").jobs.publish;

  it("grants contents: read alongside id-token: write", () => {
    // Without it the token cannot read this repository and checkout fails.
    expect(job.permissions).toMatchObject({ "contents": "read", "id-token": "write" });
  });

  it("binds publishing to the environment its PyPI publisher is configured for", () => {
    const env = typeof job.environment === "string" ? job.environment : job.environment?.name;
    expect(env).toBe(PYPI_ENVIRONMENT);
    // The same string has to be in PyPI's publisher config; the header is where a
    // maintainer reads it off, so a rename that misses one side is caught here.
    expect(source("publish-failproofai-sdk.yml")).toContain(`Environment:      ${PYPI_ENVIRONMENT}`);
  });

  it("does not reuse fp-cli's PyPI environment", () => {
    // Two projects sharing one environment means fp-cli's deployment rules would
    // govern SDK releases, and PyPI would reject the mismatched claim anyway.
    const fpCli = workflow("publish-fp-cli.yml").jobs.publish;
    const other = typeof fpCli.environment === "string" ? fpCli.environment : fpCli.environment?.name;
    expect(other).not.toBe(PYPI_ENVIRONMENT);
  });

  it("still refuses a non-main ref and a non-maintainer actor", () => {
    const scripts = runScripts(job);
    expect(scripts).toContain('if [ "$REF" != "main" ]');
    expect(scripts).toContain('if [ "$ACTOR" != "NiveditJain" ]');
  });

  it("runs the tests and the installed-artifact smoke test before uploading", () => {
    const steps: Record<string, any>[] = job.steps ?? [];
    const names = steps.map((s) => s.name ?? "");
    const upload = steps.findIndex((s) => (s.uses ?? "").startsWith("pypa/gh-action-pypi-publish"));
    expect(upload).toBeGreaterThan(-1);
    for (const gate of ["Test", "Smoke-test the artifact exactly as a user would receive it"]) {
      expect(names.indexOf(gate)).toBeGreaterThan(-1);
      expect(names.indexOf(gate)).toBeLessThan(upload);
    }
  });

  it("requires the spool contract rather than letting it skip", () => {
    const test = (job.steps ?? []).find((s: Record<string, any>) => s.name === "Test");
    expect(test?.env?.FAILPROOFAI_SDK_REQUIRE_CONTRACT).toBe("1");
  });

  it("installs the wheel with --no-deps, which is the zero-dependency assertion", () => {
    expect(runScripts(job)).toContain("uv pip install --no-deps dist/*.whl");
  });

  it("publishes from the SDK's own dist directory", () => {
    // `packages-dir` is resolved from the repo root, NOT from the job's
    // `working-directory` — so a bare `dist/` here would upload nothing, or
    // whatever another component happened to leave at the root.
    const upload = (job.steps ?? []).find((s: Record<string, any>) =>
      (s.uses ?? "").startsWith("pypa/gh-action-pypi-publish"),
    );
    expect(upload?.with?.["packages-dir"]).toBe("sdk/python/dist/");
  });
});

describe("the failproofai-sdk CI job", () => {
  const job = workflow("ci.yml").jobs["failproofai-sdk"];

  it("exists and runs from the SDK directory", () => {
    expect(job).toBeDefined();
    expect(job.defaults.run["working-directory"]).toBe("sdk/python");
  });

  it("tests every Python version pyproject advertises", () => {
    // Claiming >=3.10 and testing one of them is how a 3.10 user finds the break.
    // Kept in step with `requires-python` and the classifiers by hand.
    expect(job.strategy.matrix["python-version"]).toEqual(["3.10", "3.11", "3.12", "3.13", "3.14"]);
  });

  it("requires the spool contract rather than letting it skip", () => {
    const test = (job.steps ?? []).find((s: Record<string, any>) => s.name === "Test");
    expect(test?.env?.FAILPROOFAI_SDK_REQUIRE_CONTRACT).toBe("1");
  });

  it("installs the built wheel with --no-deps and reads real events back", () => {
    const scripts = runScripts(job);
    expect(scripts).toContain("uv pip install --no-deps dist/*.whl");
    // Proving the artifact emits is the point; a bare `import` would pass on a
    // package whose writer is broken.
    expect(scripts).toContain("the installed wheel wrote no event batch");
  });

  it("uses its own uv cache key, not fp-cli's", () => {
    const setup = (job.steps ?? []).find((s: Record<string, any>) =>
      (s.uses ?? "").startsWith("astral-sh/setup-uv"),
    );
    expect(setup?.with?.["cache-dependency-glob"]).toBe("sdk/python/uv.lock");
  });
});

describe("sync-failproofai-sdk-skill.yml", () => {
  const name = "sync-failproofai-sdk-skill.yml";
  const text = source(name);
  const job = workflow(name).jobs.sync;

  it("never puts the PAT in a remote URL", () => {
    // A credentialed clone URL is persisted verbatim into $WORKDIR/.git/config, which the
    // mirror repo's own validate-skills.py — run in that same workspace — could then read.
    expect(text).not.toMatch(/https:\/\/[^\s"']*SKILLS_SYNC_PAT/);
  });

  it("authenticates git through an in-process header, from env, for both clone and push", () => {
    const scripts = runScripts(job);
    // `git -c` BEFORE the subcommand: `git clone -c ...` would write it into the new
    // repo's config, which is the leak this avoids. (`\s` spans the line continuation.)
    const authed = (verb: string) =>
      new RegExp(String.raw`git -c "http\.extraheader=AUTHORIZATION: basic \$\{AUTH\}"\s*\\?\s*` + verb);
    expect(scripts).toMatch(authed("clone"));
    expect(scripts).toMatch(authed("push"));
    expect(scripts).toContain(`AUTH="$(printf 'x:%s' "$SKILLS_SYNC_PAT" | base64 -w0)"`);
    expect(scripts).not.toContain("${{ secrets.SKILLS_SYNC_PAT }}"); // env:, not interpolated
  });

  it("keeps GITHUB_TOKEN read-only — every write goes through the PAT", () => {
    expect(workflow(name).permissions).toEqual({ contents: "read" });
  });

  it("detects a first sync with git status, not git diff", () => {
    // The destination folder does not exist yet, so every mirrored file is UNTRACKED
    // and `git diff` reports clean — a green run that shipped nothing.
    expect(runScripts(job)).toContain('git status --porcelain -- "$DEST_SUBDIR"');
  });

  it("shares no force-pushed branch, label or concurrency group with the fp-cli sync", () => {
    const mine = workflow(name);
    const theirs = workflow("sync-fp-cli-skill.yml");
    // Each run force-pushes BRANCH. Sharing it would overwrite the sibling's open PR
    // with this skill's contents, and the sibling would never notice.
    expect(mine.env.BRANCH).not.toBe(theirs.env.BRANCH);
    expect(mine.env.DEST_SUBDIR).not.toBe(theirs.env.DEST_SUBDIR);
    expect(mine.env.SRC).not.toBe(theirs.env.SRC);
    expect(mine.env.LABEL).not.toBe(theirs.env.LABEL);
    expect(mine.concurrency.group).not.toBe(theirs.concurrency.group);
  });

  it("mirrors from the SDK's skill directory", () => {
    expect(workflow(name).env.SRC).toBe("sdk/python/skill");
    expect(workflow(name).env.DEST_SUBDIR).toBe("skills/failproofai-sdk");
  });
});

describe("the failproofai-sdk-integrations CI job", () => {
  // This job is the adapters' only automated evidence, and every invariant below
  // is one a tidy-up would plausibly remove. Before it existed, all four
  // integration modules skipped at import in every CI run — 168 test functions,
  // green, never executed — because the frameworks live in extras that
  // `--extra dev` does not install.
  const job = () => workflow("ci.yml").jobs["failproofai-sdk-integrations"];

  it("exists at all", () => {
    expect(job()).toBeDefined();
  });

  it("installs every framework extra", () => {
    // Each adapter has exactly one extra. A missing one does not fail the install;
    // it makes that adapter's module skip, which the env var below then catches —
    // but only if the extra was meant to be there in the first place.
    const install = job().steps.map((s: any) => s.run ?? "").join("\n");
    for (const extra of ["langchain", "langgraph", "crewai", "llamaindex", "pydantic-ai"]) {
      expect(install).toContain(`--extra ${extra}`);
    }
  });

  it("installs with --locked", () => {
    // Without it, uv silently re-resolves and the job stops testing the versions
    // the lockfile pins — the same drift `uv sync --locked` was adopted for.
    const install = job().steps.map((s: any) => s.run ?? "").join("\n");
    expect(install).toContain("uv sync --locked");
  });

  it("sets AGENTEYE_TESTS_REQUIRE_FRAMEWORKS so a skip is a failure", () => {
    // THE load-bearing line. Drop it and a botched install reads as "4 skipped",
    // the job passes having tested nothing, and the gap this job closed reopens
    // in exactly the form that hid it the first time.
    const step = job().steps.find((s: any) => s.env?.AGENTEYE_TESTS_REQUIRE_FRAMEWORKS);
    expect(step, "no step sets AGENTEYE_TESTS_REQUIRE_FRAMEWORKS").toBeDefined();
    expect(String(step.env.AGENTEYE_TESTS_REQUIRE_FRAMEWORKS)).toBe("1");
    expect(step.run).toContain("tests/integrations");
  });
});

describe("supply-chain registration", () => {
  it("scans the SDK lockfile for vulnerabilities", () => {
    // A lockfile absent from the scan args is silently unscanned — osv-scanner does
    // not discover lockfiles on its own here.
    expect(source("osv-scanner.yml")).toContain("--lockfile=sdk/python/uv.lock");
  });

  it("gives the SDK its own dependabot entry", () => {
    // dependabot resolves per directory; fp-cli's `uv` entry does not see this tree.
    const config = parse(readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8"));
    const directories = config.updates
      .filter((u: Record<string, any>) => u["package-ecosystem"] === "uv")
      .map((u: Record<string, any>) => u.directory);
    expect(directories).toContain("/sdk/python");
  });
});
