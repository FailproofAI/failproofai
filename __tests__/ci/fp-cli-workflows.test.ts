// @vitest-environment node
/**
 * Drift guard for the two fp-cli workflows. Both are hand-maintained, and both hold
 * invariants that a reviewer reading the diff would not see break:
 *
 *   - publish-fp-cli.yml grants `id-token: write` for Trusted Publishing. Naming any
 *     scope sets every unnamed one to `none`, so `contents: read` is what lets
 *     actions/checkout read the repo at all — it looks redundant and is not.
 *   - publishing is bound to a GitHub environment. Every other guard in that file (the
 *     actor allowlist, the ref check) lives on the ref being dispatched, so a writer
 *     could delete them on a branch and click Run; the environment's rules live in repo
 *     settings and in PyPI's publisher config, where a branch cannot reach them. The
 *     name has to match on both sides, so the header documents the same string.
 *   - sync-fp-cli-skill.yml hands its PAT to git without writing it into
 *     $WORKDIR/.git/config, because the very next step runs a script fetched from the
 *     repo that PAT can write to.
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

const PYPI_ENVIRONMENT = "pypi-fp-cli";

describe("publish-fp-cli.yml", () => {
  const job = workflow("publish-fp-cli.yml").jobs.publish;

  it("grants contents: read alongside id-token: write", () => {
    // Without it the token cannot read this repository and checkout fails.
    expect(job.permissions).toMatchObject({ "contents": "read", "id-token": "write" });
  });

  it("binds publishing to the environment its PyPI publisher is configured for", () => {
    const env = typeof job.environment === "string" ? job.environment : job.environment?.name;
    expect(env).toBe(PYPI_ENVIRONMENT);
    // The same string has to be in PyPI's publisher config; the header is where a
    // maintainer reads it off, so a rename that misses one side is caught here.
    expect(source("publish-fp-cli.yml")).toContain(`Environment:      ${PYPI_ENVIRONMENT}`);
  });

  it("still refuses a non-main ref and a non-maintainer actor", () => {
    const scripts = runScripts(job);
    expect(scripts).toContain('if [ "$REF" != "main" ]');
    expect(scripts).toContain('if [ "$ACTOR" != "NiveditJain" ]');
  });

  it("runs every gate before uploading", () => {
    const steps: Record<string, any>[] = job.steps ?? [];
    const names = steps.map((s) => s.name ?? "");
    const upload = steps.findIndex((s) => (s.uses ?? "").startsWith("pypa/gh-action-pypi-publish"));
    expect(upload).toBeGreaterThan(-1);
    // "Verify the artifacts before uploading" is on this list because deleting
    // it outright used to leave every test in this file green.
    for (const gate of [
      "Test",
      "Verify the artifacts before uploading",
      "Smoke-test the artifact exactly as a user would receive it",
    ]) {
      expect(names.indexOf(gate)).toBeGreaterThan(-1);
      expect(names.indexOf(gate)).toBeLessThan(upload);
    }
  });

  // Same three holes as the SDK's publish guard had: nothing asserted the
  // trigger set, and nothing asserted the upload was conditional at all.
  // `on: push: branches: [main]` would turn every merge into a public PyPI
  // release while these tests stayed green.
  it("can only be started by hand", () => {
    const wf = workflow("publish-fp-cli.yml");
    const triggers = wf.on ?? wf[true as unknown as string];
    expect(Object.keys(triggers)).toEqual(["workflow_dispatch"]);
  });

  it("gates the upload on dry_run, so a dry run cannot publish", () => {
    const upload = (job.steps ?? []).find((s: Record<string, any>) =>
      (s.uses ?? "").startsWith("pypa/gh-action-pypi-publish"),
    );
    expect(upload).toBeDefined();
    expect(String(upload.if ?? "")).toContain("dry_run");
  });
});

describe("ci.yml — the fp-cli matrix", () => {
  it("tests every Python version the package's classifiers advertise", () => {
    const ci = workflow("ci.yml");
    const matrix: string[] = ci.jobs["fp-cli"].strategy.matrix["python-version"].map(String);

    const pyproject = readFileSync(resolve(ROOT, "fp-cli", "pyproject.toml"), "utf8");
    const advertised = [...pyproject.matchAll(/Programming Language :: Python :: (\d+\.\d+)/g)]
      .map((m) => m[1])
      .sort();

    // Claiming support for four interpreters and testing two is how a 3.11 user
    // finds the break — with fully green CI and a wheel whose own metadata told
    // them they were supported. The comment above that job already said this was
    // the rule; it was only true of the SDK's matrix.
    expect(matrix.sort()).toEqual(advertised);
  });
});

describe("sync-fp-cli-skill.yml", () => {
  const text = source("sync-fp-cli-skill.yml");
  const job = workflow("sync-fp-cli-skill.yml").jobs.sync;

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
    expect(scripts).not.toContain("${{ secrets.SKILLS_SYNC_PAT }}"); // env:, not interpolated
  });

  it("keeps GITHUB_TOKEN read-only — every write goes through the PAT", () => {
    expect(workflow("sync-fp-cli-skill.yml").permissions).toEqual({ contents: "read" });
  });

  // The clone step keeps the PAT out of $WORKDIR/.git/config because "the NEXT
  // step runs a script fetched FROM that repo". These two assert the rest of
  // that reasoning, which the step ORDER used to defeat: the validator had write
  // access to the same repo the following step runs `git commit` in with the PAT
  // exported, and `git commit` runs .git/hooks/pre-commit.
  it.each(["sync-fp-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
    "%s runs the mirror's validator outside the credentialed clone",
    (name) => {
      const job: Record<string, any> = Object.values(workflow(name).jobs)[0] as any;
      const validate = (job.steps ?? []).find((s: Record<string, any>) =>
        String(s.name ?? "").startsWith("Validate"),
      );
      expect(validate).toBeDefined();
      const script = String(validate.run ?? "");
      expect(script).toContain("RUNNER_TEMP");
      expect(script).not.toMatch(/python3 "\$WORKDIR\/scripts/);
    },
  );

  it.each(["sync-fp-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
    "%s does not let a planted git hook run under the PAT",
    (name) => {
      const job: Record<string, any> = Object.values(workflow(name).jobs)[0] as any;
      const scripts = (job.steps ?? []).map((s: Record<string, any>) => s.run ?? "").join("\n");
      expect(scripts).toContain("core.hooksPath=/dev/null");
      expect(scripts).toContain("--no-verify");
    },
  );

  it.each(["sync-fp-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
    "%s does not leave this repo's own token on disk for that script to read",
    (name) => {
      const job: Record<string, any> = Object.values(workflow(name).jobs)[0] as any;
      const checkout = (job.steps ?? []).find((s: Record<string, any>) =>
        String(s.uses ?? "").startsWith("actions/checkout"),
      );
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    },
  );
});
