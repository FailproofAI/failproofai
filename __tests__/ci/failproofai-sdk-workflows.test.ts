// @vitest-environment node
/**
 * Drift guard for the two failproofai-sdk workflows, and a sibling of
 * fp-cloud-cli-workflows.test.ts. Both files are hand-maintained and hold invariants a
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
  const FILE = "publish-failproofai-sdk.yml";
  // The gates all live in the unprivileged build job now; `publish` only uploads.
  const job = workflow(FILE).jobs.build;
  const publishJob = workflow(FILE).jobs.publish;

  it("grants contents: read alongside id-token: write", () => {
    // On the PUBLISH job, which is the only one that holds the identity now.
    expect(publishJob.permissions).toMatchObject({ "contents": "read", "id-token": "write" });
    // ...and the build job must NOT hold it, which is the whole split.
    expect(job.permissions?.["id-token"]).toBeUndefined();
  });

  it("binds publishing to the environment its PyPI publisher is configured for", () => {
    const env =
      typeof publishJob.environment === "string"
        ? publishJob.environment
        : publishJob.environment?.name;
    expect(env).toBe(PYPI_ENVIRONMENT);
    // The same string has to be in PyPI's publisher config; the header is where a
    // maintainer reads it off, so a rename that misses one side is caught here.
    expect(source("publish-failproofai-sdk.yml")).toContain(`Environment:      ${PYPI_ENVIRONMENT}`);
  });

  it("does not reuse fp-cloud-cli's PyPI environment", () => {
    // Two projects sharing one environment means fp-cloud-cli's deployment rules would
    // govern SDK releases, and PyPI would reject the mismatched claim anyway.
    const fpCli = workflow("publish-fp-cloud-cli.yml").jobs.publish;
    const other = typeof fpCli.environment === "string" ? fpCli.environment : fpCli.environment?.name;
    expect(other).not.toBe(PYPI_ENVIRONMENT);
  });

  it("still refuses a non-main ref and a non-maintainer actor", () => {
    const scripts = runScripts(job);
    expect(scripts).toContain('if [ "$REF" != "main" ]');
    expect(scripts).toContain('"$RELEASE_ACTORS"');
  });

  // `github.actor` ALONE is bypassable, and that is what this guard used to read.
  // On a RE-RUN it stays the user who started the ORIGINAL run, while
  // `github.triggering_actor` is whoever pressed re-run — so anyone with write
  // access could re-run a maintainer's FAILED publish (one that died before the
  // upload, so preflight's "already published" check does not stop it) and ship
  // from it under the maintainer's attribution. publish.yml has always checked
  // both; these two checked one.
  //
  // Asserted on EVERY job carrying the guard, because one unhardened copy is the
  // one that gets reached, and on the loop itself rather than only the env — the
  // variable being present while nothing reads it is exactly how this looks fixed.
  it("checks the triggering actor as well as the actor, on every guarded job", () => {
    const wf = workflow("publish-failproofai-sdk.yml");
    const guarded = Object.entries<any>(wf.jobs).filter(([, j]) =>
      (j.steps ?? []).some((s: Record<string, any>) => s.name === "Authorize actor and branch"),
    );
    expect(guarded.map(([n]) => n).sort()).toEqual(["build", "preflight", "publish"]);

    for (const [name, j] of guarded) {
      const step = (j.steps ?? []).find((s: Record<string, any>) => s.name === "Authorize actor and branch");
      expect(step.env?.ACTOR, name).toBe("${{ github.actor }}");
      expect(step.env?.TRIGGERING_ACTOR, name).toBe("${{ github.triggering_actor }}");
      expect(step.env?.RELEASE_ACTORS, name).toBe("NiveditJain");
      expect(step.run, name).toContain('for WHO in "$ACTOR" "$TRIGGERING_ACTOR"');
      // Case-insensitive, like publish.yml's — a login differing only in case is
      // the same account, and an exact-match guard that says otherwise is a guard
      // whose behaviour nobody can predict from the allowlist.
      expect(step.run, name).toContain("tr '[:upper:]' '[:lower:]'");
    }
  });

  // Betas are locked down too, and that is a DEVIATION from publish.yml, which
  // leaves npm prereleases open to anyone with write access. If someone loosens
  // this to match, the header has to stop claiming otherwise.
  it("restricts every publish, not only a stable one", () => {
    const text = source("publish-failproofai-sdk.yml");
    expect(text).toContain("Every publish — beta or stable — is restricted");
    // No version- or scheme-conditional escape hatch on the guard.
    for (const j of Object.values<any>(workflow("publish-failproofai-sdk.yml").jobs)) {
      const step = (j.steps ?? []).find((s: Record<string, any>) => s.name === "Authorize actor and branch");
      if (step) expect(step.if).toBeUndefined();
    }
  });

  it("runs every gate before uploading", () => {
    const steps: Record<string, any>[] = job.steps ?? [];
    const names = steps.map((s) => s.name ?? "");
    const upload = steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
    expect(upload).toBeGreaterThan(-1);
    // "Verify the artifacts before uploading" is on this list because deleting
    // that step outright — the LICENSE / py.typed / non-empty-wheel gate — used
    // to leave every test in this file green.
    for (const gate of [
      "Test",
      "Test the framework adapters",
      "Verify the artifacts before uploading",
      "Smoke-test the artifact exactly as a user would receive it",
    ]) {
      expect(names.indexOf(gate)).toBeGreaterThan(-1);
      expect(names.indexOf(gate)).toBeLessThan(upload);
    }
  });

  // The entire security narrative in this workflow's header — "workflow_dispatch
  // can target ANY ref", the actor check, the ref check — rests on
  // workflow_dispatch being the ONLY entry point, and nothing asserted it.
  // Adding `on: push: branches: [main]` turns every merge into a public PyPI
  // release: the environment's main-only rule passes, REF is main, ACTOR is the
  // merger, and on a non-dispatch event the `inputs` context is empty so
  // `if: ${{ !inputs.dry_run }}` evaluates true and the upload runs.
  it("can only be started by hand", () => {
    const wf = workflow("publish-failproofai-sdk.yml");
    // `on` parses as the YAML boolean `true` under some loaders; accept either key.
    const triggers = wf.on ?? wf[true as unknown as string];
    expect(Object.keys(triggers)).toEqual(["workflow_dispatch"]);
  });

// The whole point of the two-job split: the job that CAN publish must run no
  // code this repo does not review. Trusted Publishing mints its OIDC token from
  // `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` in the job environment, so anything
  // executing alongside `id-token: write` — a dependency, a pytest plugin, the
  // built package itself — can request it and publish an attacker-controlled
  // release.
  it("keeps the publishing identity out of every job that runs third-party code", () => {
    const wf = workflow(FILE);
    for (const [name, j] of Object.entries<any>(wf.jobs)) {
      const idToken = j.permissions?.["id-token"];
      if (idToken !== "write") continue;
      const steps: Record<string, any>[] = j.steps ?? [];
      const uses = steps.map((s) => String(s.uses ?? ""));
      const scripts = steps.map((s) => String(s.run ?? "")).join("\n");

      expect(uses.some((u) => u.startsWith("actions/checkout"))).toBe(false);
      for (const forbidden of ["uv sync", "uv run", "uv build", "pip install", "pytest"]) {
        expect(scripts).not.toContain(forbidden);
      }
      // Only the artifact download and the upload action itself.
      expect(uses.filter(Boolean).sort()).toEqual([
        "actions/download-artifact@v8",
        "pypa/gh-action-pypi-publish@release/v1",
      ]);
      expect(name).toBe("publish");
    }
  });

  it("still gates the publishing job on dry_run", () => {
    const wf = workflow(FILE);
    expect(String(wf.jobs.publish.if ?? "")).toContain("dry_run");
  });

  it("hands the publish job an artifact the build job already verified", () => {
    const wf = workflow(FILE);
    const build: Record<string, any>[] = wf.jobs.build.steps ?? [];
    const upload = build.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
    expect(upload).toBeDefined();
    // `error`, not the default warn-and-continue: an empty upload would make the
    // publish job download nothing and succeed at publishing it.
    expect(upload!.with?.["if-no-files-found"]).toBe("error");
    expect(wf.jobs.publish.needs).toBe("build");
  });

  it("requires the framework adapters to fail rather than skip", () => {
    const step = (job.steps ?? []).find(
      (s: Record<string, any>) => s.name === "Test the framework adapters",
    );
    // Without this the adapters — which ship in the base wheel — skip at import
    // and the job passes having tested none of them, on the one path that
    // produces an artifact that cannot be recalled.
    expect(step?.env?.AGENTEYE_TESTS_REQUIRE_FRAMEWORKS).toBe("1");
  });

  it("requires the spool contract rather than letting it skip", () => {
    const test = (job.steps ?? []).find((s: Record<string, any>) => s.name === "Test");
    expect(test?.env?.FAILPROOFAI_SDK_REQUIRE_CONTRACT).toBe("1");
  });

  it("installs the wheel with --no-deps, which is the zero-dependency assertion", () => {
    expect(runScripts(job)).toContain("uv pip install --no-deps dist/*.whl");
  });

  it("publishes from the SDK's own dist directory", () => {
    // `packages-dir` is resolved from the repo root. The publish job does not
    // check the repo out at all, so the only thing at that path is what
    // `download-artifact` just placed there — and the two must agree, or the
    // upload silently publishes nothing (or whatever else is lying around).
    const steps: Record<string, any>[] = publishJob.steps ?? [];
    const download = steps.find((s) => String(s.uses ?? "").startsWith("actions/download-artifact"));
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("pypa/gh-action-pypi-publish"));
    expect(download?.with?.path).toBe("dist/");
    expect(upload?.with?.["packages-dir"]).toBe("dist/");
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

  it("uses its own uv cache key, not fp-cloud-cli's", () => {
    const setup = (job.steps ?? []).find((s: Record<string, any>) =>
      (s.uses ?? "").startsWith("astral-sh/setup-uv"),
    );
    expect(setup?.with?.["cache-dependency-glob"]).toBe("sdk/python/uv.lock");
  });
});

describe("sync-failproofai-sdk-skill.yml", () => {
  const name = "sync-failproofai-sdk-skill.yml";
  const text = source(name);
  const job = (() => {
    // The old single `sync` job is now `prepare` + `validate` + `publish`;
    // these assertions are about the git plumbing, wherever it now lives.
    const wf = workflow(name);
    return { steps: Object.values<any>(wf.jobs).flatMap((j) => j.steps ?? []) };
  })();

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

  it("shares no force-pushed branch, label or concurrency group with the fp-cloud-cli sync", () => {
    const mine = workflow(name);
    const theirs = workflow("sync-fp-cloud-cli-skill.yml");
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
    // dependabot resolves per directory; fp-cloud-cli's `uv` entry does not see this tree.
    const config = parse(readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8"));
    const directories = config.updates
      .filter((u: Record<string, any>) => u["package-ecosystem"] === "uv")
      .map((u: Record<string, any>) => u.directory);
    expect(directories).toContain("/sdk/python");
  });
});
