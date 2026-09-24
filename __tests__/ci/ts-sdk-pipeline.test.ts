// @vitest-environment node
/**
 * The release scheme for `@failproofai/sdk`, and the two pipelines that run it.
 *
 * npm never releases a version for reuse, so the arithmetic in
 * `sdk/typescript/scripts/release.mjs` is the whole mechanism: get it wrong and
 * the wrong thing ships under a number nobody can take back. So this file tests
 * the script by RUNNING it, and then asserts that the workflows actually wire it
 * to the jobs that make it a pipeline rather than a convention a maintainer has
 * to remember.
 *
 * `node` is not guarded behind a skip. The package under test is a Node package
 * and every runner has one; a skip here would mean the release scheme's only
 * test silently stops running — the failure mode this repo keeps closing
 * elsewhere (FAILPROOFAI_SDK_REQUIRE_CONTRACT, AGENTEYE_TESTS_REQUIRE_FRAMEWORKS).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const SDK = resolve(ROOT, "sdk/typescript");
const SCRIPT = resolve(SDK, "scripts/release.mjs");
const PUBLISH_WORKFLOW = resolve(ROOT, ".github/workflows/publish-failproofai-ts-sdk.yml");
const CI_WORKFLOW = resolve(ROOT, ".github/workflows/ci.yml");

function run(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: SDK,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  });
}

function workflow(path: string): Record<string, any> {
  return parse(readFileSync(path, "utf8")) as Record<string, any>;
}

describe("the version scheme", () => {
  it("advances a beta and opens one after a stable", () => {
    expect(run("next", "0.0.1-beta.4").trim()).toBe("0.0.1-beta.5");
    expect(run("next", "1.2.3").trim()).toBe("1.2.4-beta.0");
    expect(run("next", "0.0.1-beta.9").trim()).toBe("0.0.1-beta.10");
  });

  it("refuses a spelling npm would store as something else", () => {
    // Every consumer in the pipeline compares version STRINGS — the source
    // file, the tarball name, the dist-tag and the "is this published" query —
    // so a spelling that round-trips differently is a release that half
    // succeeds.
    for (const bad of ["v1.0.0", "1.2.3-beta", "1.2.3-beta.01", "01.2.3", "1.2.3-rc.1"]) {
      expect(() => run("next", bad)).toThrow();
    }
  });

  it("resolves the checked-in version and keeps both files in step", () => {
    const output = run("resolve");
    const version = /^version=(.+)$/m.exec(output)?.[1];
    expect(version).toBeTruthy();

    const manifest = JSON.parse(readFileSync(resolve(SDK, "package.json"), "utf8")) as {
      version: string;
    };
    const source = readFileSync(resolve(SDK, "src/version.ts"), "utf8");
    // They are read by different consumers — npm reads one, the SDK reports the
    // other — and a release where they disagree publishes a package that
    // misreports its own version to the dashboard.
    expect(manifest.version).toBe(version);
    expect(source).toContain(`export const VERSION = "${version!}";`);
  });

  it("picks the dist-tag from the channel, so a beta never becomes `latest`", () => {
    const output = run("resolve");
    const isPrerelease = /^is_prerelease=(.+)$/m.exec(output)?.[1];
    const distTag = /^dist_tag=(.+)$/m.exec(output)?.[1];
    expect(distTag).toBe(isPrerelease === "true" ? "beta" : "latest");
  });

  it("refuses a release whose CHANGELOG section is missing", () => {
    // A published version nobody can read the changes for is a version that may
    // as well not have shipped.
    expect(() => run("changelog", "9.9.9")).toThrow();
    expect(run("changelog").length).toBeGreaterThan(50);
  });
});

describe("the publish pipeline", () => {
  const jobs = workflow(PUBLISH_WORKFLOW).jobs as Record<string, any>;

  it("resolves the version and refuses a burned one BEFORE anything is built", () => {
    const steps = jobs.preflight.steps as Array<Record<string, any>>;
    const names = steps.map((step) => String(step.name ?? step.uses ?? ""));
    expect(names.some((name) => /already taken/i.test(name))).toBe(true);
    // npm never releases a version for reuse, so discovering a burned one after
    // a full build costs the whole run and fixes nothing.
    expect(jobs.preflight.needs).toBeUndefined();
    expect(jobs.build.needs).toBe("preflight");
  });

  it("gives the preflight job no identity at all", () => {
    // Nothing in the job that decides whether a release may proceed should be
    // able to perform one.
    expect(jobs.preflight.permissions).toEqual({ contents: "read" });
    expect(jobs.preflight.environment).toBeUndefined();
  });

  it("separates the job that builds from the job that publishes", () => {
    // The job holding the token runs no build script.
    expect(jobs.build.permissions).toEqual({ contents: "read" });
    expect(jobs.publish.needs).toEqual(["preflight", "build"]);
    expect(jobs.publish.environment).toBe("npm-failproofai-ts-sdk");
    expect(jobs.publish.permissions["id-token"]).toBe("write");
  });

  it("checks BOTH actors, so a re-run cannot launder a publish", () => {
    // On a re-run `github.actor` stays the user who started the ORIGINAL run
    // while `triggering_actor` is whoever pressed re-run.
    for (const job of [jobs.preflight, jobs.publish]) {
      const guard = (job.steps as Array<Record<string, any>>).find((step) =>
        /Authorize actor/i.test(String(step.name ?? "")),
      );
      expect(guard).toBeDefined();
      expect(JSON.stringify(guard!.env)).toContain("github.actor");
      expect(JSON.stringify(guard!.env)).toContain("github.triggering_actor");
    }
  });

  it("publishes with provenance and without running the tarball's scripts", () => {
    const publish = (jobs.publish.steps as Array<Record<string, any>>).find(
      (step) => String(step.name ?? "") === "Publish",
    );
    expect(publish).toBeDefined();
    const script = String(publish!.run);
    expect(script).toContain("--provenance");
    // A tarball's lifecycle scripts must not run on a machine holding a publish
    // token.
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain("--tag \"$DIST_TAG\"");
    // The dry run drops provenance on purpose: attestation needs a real publish
    // to attach to.
    expect(script).toContain("--dry-run");
  });

  it("verifies the install from the real registry, after the publish", () => {
    expect(jobs["verify-install"].needs).toEqual(["preflight", "publish"]);
    const script = JSON.stringify(jobs["verify-install"].steps);
    // The zero-dependency promise is asserted against what npm actually
    // resolved, not against the source tree.
    expect(script).toContain("--omit=peer");
    expect(script).toContain("node_modules/@failproofai/sdk/node_modules");
  });

  it("opens the next version AND its CHANGELOG section in one commit", () => {
    // A version with no section is what `preflight` refuses at release time,
    // and a bump commit carries a skip-ci marker — so that state would go red
    // on the next unrelated PR rather than on itself.
    const script = JSON.stringify(jobs.bump.steps);
    expect(script).toContain("release.mjs write");
    expect(script).toContain("CHANGELOG.md");
    expect(script).toContain("[skip ci]");
    expect(script).toContain("VERSION_BOT_APP_ID");
  });

  it("does not publish, release, verify or bump on a dry run", () => {
    expect(jobs["verify-install"].if).toContain("dry_run");
    expect(jobs.bump.if).toContain("dry_run");
    const publishSteps = jobs.publish.steps as Array<Record<string, any>>;
    const release = publishSteps.find((step) =>
      /Create the GitHub Release/i.test(String(step.name ?? "")),
    );
    expect(String(release!.if)).toContain("dry_run");
  });
});

describe("the CI job", () => {
  const jobs = workflow(CI_WORKFLOW).jobs as Record<string, any>;
  const job = jobs["failproofai-ts-sdk"] as Record<string, any>;

  it("exists and runs from the package directory", () => {
    expect(job).toBeDefined();
    expect(job.defaults.run["working-directory"]).toBe("sdk/typescript");
  });

  it("covers the Node range the package advertises, floor included", () => {
    const manifest = JSON.parse(readFileSync(resolve(SDK, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const floor = /(\d+)\.(\d+)/.exec(manifest.engines.node)!;
    const legs = job.strategy.matrix.include as Array<{ "node-version": string; suite: boolean }>;
    const versions = legs.map((leg) => leg["node-version"]);
    // The floor itself has to be in the matrix, or "we support 20.9" is a claim
    // nothing checks.
    expect(versions).toContain(`${floor[1]!}.${floor[2]!}`);
    expect(versions.length).toBeGreaterThanOrEqual(3);
    // And at least one leg has to run the suite, or the matrix proves only that
    // the package installs.
    expect(legs.some((leg) => leg.suite)).toBe(true);
  });

  it("proves the floor with the ARTIFACT, since the test runner cannot start there", () => {
    // vitest 5 pulls vite 8 pulls rolldown, which needs `styleText` from
    // `node:util` — Node 20.12. The test runner's floor is not the package's
    // floor, so the floor leg skips the suite and must still do the thing that
    // actually demonstrates 20.9 support: build, pack, install, run.
    const legs = job.strategy.matrix.include as Array<{ "node-version": string; suite: boolean }>;
    const floorLeg = legs.find((leg) => !leg.suite);
    expect(floorLeg).toBeDefined();

    const steps = job.steps as Array<Record<string, any>>;
    const unconditional = steps
      .filter((step) => step.if === undefined)
      .map((step) => String(step.name ?? step.uses ?? ""));
    for (const required of ["Build", "Pack", "Smoke-test the packed tarball with no dependencies"]) {
      expect(unconditional).toContain(required);
    }
    // Conversely, the steps that cannot run there must be gated rather than
    // failing the leg.
    for (const gated of ["Typecheck", "Lint", "Test"]) {
      const step = steps.find((item) => String(item.name ?? "") === gated)!;
      expect(step.if).toBe("matrix.suite");
    }
  });

  it("typechecks, lints, tests and proves the artifact installs", () => {
    const script = JSON.stringify(job.steps);
    for (const step of ["npm run typecheck", "npm run lint", "npm run build", "vitest run"]) {
      expect(script).toContain(step);
    }
    // Everything above runs against the source tree; these run against the
    // artifact, where a missing export condition is total and invisible.
    expect(script).toContain("npm pack");
    expect(script).toContain("--omit=peer");
    // Both module systems, because half the ecosystem is still CommonJS.
    expect(script).toContain("esm.mjs");
    expect(script).toContain("cjs.cjs");
    // The sandbox's self-resolution cannot be exercised from inside this repo.
    expect(script).toContain("sandbox resolved and evaluated from the installed package");
  });
});

describe("the package itself", () => {
  it("ships no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(resolve(SDK, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    // The reason this package is safe to drop into someone else's agent.
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
    }
  });

  it("keeps its own lockfile, so CI installs what a release installs", () => {
    expect(existsSync(resolve(SDK, "package-lock.json"))).toBe(true);
  });
});
