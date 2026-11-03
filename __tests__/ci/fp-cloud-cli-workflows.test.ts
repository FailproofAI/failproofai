// @vitest-environment node
/**
 * Drift guard for the two fp-cloud-cli workflows. Both are hand-maintained, and both hold
 * invariants that a reviewer reading the diff would not see break:
 *
 *   - publish-fp-cloud-cli.yml grants `id-token: write` for Trusted Publishing. Naming any
 *     scope sets every unnamed one to `none`, so `contents: read` is what lets
 *     actions/checkout read the repo at all — it looks redundant and is not.
 *   - publishing is bound to a GitHub environment. Every other guard in that file (the
 *     actor allowlist, the ref check) lives on the ref being dispatched, so a writer
 *     could delete them on a branch and click Run; the environment's rules live in repo
 *     settings and in PyPI's publisher config, where a branch cannot reach them. The
 *     name has to match on both sides, so the header documents the same string.
 *   - sync-fp-cloud-cli-skill.yml hands its PAT to git without writing it into
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

const PYPI_ENVIRONMENT = "pypi-fp-cloud-cli";

describe("publish-fp-cloud-cli.yml", () => {
  const FILE = "publish-fp-cloud-cli.yml";
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
    expect(source("publish-fp-cloud-cli.yml")).toContain(`Environment:      ${PYPI_ENVIRONMENT}`);
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
    const wf = workflow(FILE);
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
    const text = source(FILE);
    expect(text).toContain("Every publish — beta or stable — is restricted");
    // No version- or scheme-conditional escape hatch on the guard.
    for (const j of Object.values<any>(workflow(FILE).jobs)) {
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
    const wf = workflow("publish-fp-cloud-cli.yml");
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
});

describe("ci.yml — the fp-cloud-cli matrix", () => {
  it("tests every Python version the package's classifiers advertise", () => {
    const ci = workflow("ci.yml");
    const matrix: string[] = ci.jobs["fp-cloud-cli"].strategy.matrix["python-version"].map(String);

    const pyproject = readFileSync(resolve(ROOT, "fp-cloud-cli", "pyproject.toml"), "utf8");
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

describe("sync-fp-cloud-cli-skill.yml", () => {
  const text = source("sync-fp-cloud-cli-skill.yml");
  const job = (() => {
    // The old single `sync` job is now `prepare` + `validate` + `publish`;
    // these assertions are about the git plumbing, wherever it now lives.
    const wf = workflow("sync-fp-cloud-cli-skill.yml");
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
    expect(scripts).not.toContain("${{ secrets.SKILLS_SYNC_PAT }}"); // env:, not interpolated
  });

  it("keeps GITHUB_TOKEN read-only — every write goes through the PAT", () => {
    expect(workflow("sync-fp-cloud-cli-skill.yml").permissions).toEqual({ contents: "read" });
  });

  // The clone step keeps the PAT out of $WORKDIR/.git/config because "the NEXT
  // step runs a script fetched FROM that repo". These two assert the rest of
  // that reasoning, which the step ORDER used to defeat: the validator had write
  // access to the same repo the following step runs `git commit` in with the PAT
  // exported, and `git commit` runs .git/hooks/pre-commit.
  it.each(["sync-fp-cloud-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
    "%s never runs mirror code in a job that holds a secret",
    (name) => {
      // The real invariant, and a directory copy was not it. Excluding `.git`
      // stops git-hook and git-config attacks, but a runner is not a sandbox:
      // `$GITHUB_ENV` and `$GITHUB_PATH` persist into every later step of the
      // SAME job, and a wrapper executable dropped on `PATH` is executed by the
      // credentialed step that follows. Only a job boundary separates them.
      const wf = workflow(name);
      for (const [jobName, j] of Object.entries<any>(wf.jobs)) {
        const steps: Record<string, any>[] = j.steps ?? [];
        const blob = JSON.stringify(steps);
        const holdsSecret = blob.includes("SKILLS_SYNC_PAT") || blob.includes("GH_TOKEN");
        // An INVOCATION, not a mention: the PR body this workflow writes names
        // `validate-skills.py` in prose, and that is not executing it.
        const runsMirrorCode = steps.some((st) =>
          /(^|\n)\s*(python3?|sh|bash)\s+\S*validate-skills\.py/.test(String(st.run ?? "")),
        );
        expect(
          holdsSecret && runsMirrorCode,
          `job '${jobName}' both holds a credential and executes the mirror's validator`,
        ).toBe(false);
      }
    },
  );

  it.each(["sync-fp-cloud-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
    "%s runs the validator on a runner with no permissions at all",
    (name) => {
      const wf = workflow(name);
      const validate = wf.jobs.validate;
      expect(validate).toBeDefined();
      // `permissions: {}` empties the GITHUB_TOKEN's scopes. Anything the
      // validator does happens on a runner with nothing to steal.
      expect(validate.permissions).toEqual({});
      expect(JSON.stringify(validate.steps)).not.toContain("SKILLS_SYNC_PAT");
      // ...and the credentialed job only starts once it has passed.
      expect(wf.jobs.publish.needs).toBe("validate");
    },
  );

  it.each(["sync-fp-cloud-cli-skill.yml", "sync-failproofai-sdk-skill.yml"])(
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
