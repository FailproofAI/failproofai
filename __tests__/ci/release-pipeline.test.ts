// @vitest-environment node
/**
 * Drift guard for the release pipeline.
 *
 * These two workflows are hand-maintained, nothing generates them, and their
 * failure mode is silent: PR #632 shipped the entire daemon packaging story —
 * platform manifests, pinned optional dependencies, a 4-way cross-compile —
 * without ever touching publish.yml, so the binary users were told they would
 * get was built on every release and then thrown away with the runner. CI was
 * green throughout. This file is the tripwire for the wiring that fixes it.
 *
 * What it pins, and why each one is load-bearing:
 *   - the npm publish happens AFTER the release assets are attached (the
 *     installed CLI downloads its daemon from that release tag, so publishing
 *     the package first ships a version whose binary does not exist yet);
 *   - the four @failproofai/failproofaid-<platform> packages publish BEFORE
 *     the root package that pins them as optionalDependencies — reversed, the
 *     root package spends the gap (or forever, on a failure) resolving 404s,
 *     which is the exact way the first attempt at this shipped broken;
 *   - the CLI tarball is built and attached on every release, daemon or not;
 *   - the main-version bump only runs for a release or a dispatch from main
 *     (it checks main out and pushes to it, regardless of the dispatched ref);
 *   - build-daemon.yml stays callable and is not also triggered standalone on
 *     a release (that would build the matrix twice per release);
 *   - a stable release stays restricted to the maintainer allowlist while
 *     beta/next builds stay open to anyone with write access (deleting that
 *     step is a one-line change that nothing else would notice);
 *   - the platform list in the build matrix matches the platforms the CLI
 *     actually knows how to resolve AND the packages the publish scripts
 *     generate — a missing leg is a platform that silently gets no daemon.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();

function workflow(name: string): Record<string, any> {
  return parse(readFileSync(resolve(ROOT, ".github/workflows", name), "utf8"));
}

/**
 * `on:` is a plain string key under YAML 1.2 (which the `yaml` package
 * implements), but YAML 1.1 parsers fold it to boolean `true`. Read both so a
 * parser upgrade cannot quietly turn every trigger assertion into a no-op.
 */
function triggers(wf: Record<string, any>): Record<string, any> {
  return wf.on ?? wf[true as unknown as string] ?? {};
}

/** Every `run:` script in a job, concatenated — for asserting on shell logic. */
function runScripts(job: Record<string, any>): string {
  return (job.steps ?? [])
    .map((s: Record<string, any>) => s.run ?? "")
    .join("\n");
}

const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

describe("build-daemon.yml", () => {
  const wf = workflow("build-daemon.yml");

  it("is callable by publish.yml and is not separately triggered on a release", () => {
    const on = triggers(wf);
    expect(on).toHaveProperty("workflow_call");
    // publish.yml calls this workflow; a standalone release trigger would
    // build the whole 4-way matrix a second time for every release.
    expect(on).not.toHaveProperty("release");
  });

  it("skips the matrix on a ref with no Rust workspace", () => {
    // main carries no Cargo.toml until the daemon lands, and the pull_request
    // path filter matches this workflow's own file — so an edit to it would
    // otherwise run `cargo build` against a checkout with no crates.
    expect(wf.jobs.build.needs).toBe("detect");
    expect(wf.jobs.build.if).toContain("needs.detect.outputs.has_crates == 'true'");
    expect(runScripts(wf.jobs.detect)).toContain("Cargo.toml");
  });

  it("builds and uploads exactly the four supported platforms", () => {
    const matrix = wf.jobs.build.strategy.matrix.include;
    expect(matrix.map((m: Record<string, string>) => m.platform).sort()).toEqual([...PLATFORMS].sort());

    const upload = wf.jobs.build.steps.find((s: Record<string, any>) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(upload.with.name).toBe("failproofaid-${{ matrix.platform }}");
    expect(upload.with.path).toBe("failproofaid-${{ matrix.platform }}.gz");
    // A missing binary must fail the leg, not upload an empty artifact that
    // only fails later as a short SHA256SUMS.
    expect(upload.with["if-no-files-found"]).toBe("error");
  });

  it("builds from the committed lockfile and gzips the binary", () => {
    const scripts = runScripts(wf.jobs.build);
    expect(scripts).toContain("cargo build --locked --release");
    expect(scripts).toContain("gzip");
  });
});

describe("publish.yml", () => {
  const wf = workflow("publish.yml");

  it("offers dist-tag and dry-run inputs on a manual dispatch", () => {
    const inputs = triggers(wf).workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(["dist_tag", "dry_run"]);
    expect(inputs.dist_tag.options).toContain("next");
    expect(inputs.dry_run.default).toBe(false);
  });

  it("publishes to npm only after the release assets are attached", () => {
    // Reversing these two ships a package whose daemon download 404s for as
    // long as the asset upload takes — or forever, if it fails.
    expect(wf.jobs.publish.needs).toContain("release-assets");
    expect(wf.jobs["release-assets"].needs).toContain("daemon");
    expect(wf.jobs.daemon.uses).toBe("./.github/workflows/build-daemon.yml");
  });

  it("still publishes on a ref that carries no daemon", () => {
    // main has no Rust workspace today; a skipped daemon build must not block
    // the npm publish, while a genuine failure still must.
    expect(wf.jobs.daemon.if).toContain("has_daemon == 'true'");
    expect(wf.jobs.publish.if).toContain("needs.release-assets.result == 'skipped'");
  });

  it("never publishes when the daemon build failed", () => {
    // A failed dependency leaves its dependents `skipped`, so checking only
    // release-assets would read a failed cross-compile as "nothing to do" and
    // publish a version whose binaries do not exist.
    expect(wf.jobs.publish.needs).toContain("daemon");
    expect(wf.jobs.publish.if).toContain("needs.daemon.result == 'success'");
  });

  it("refuses to move the latest dist-tag from a branch dispatch", () => {
    const scripts = runScripts(wf.jobs.preflight);
    expect(scripts).toContain("Refusing to publish dist-tag 'latest'");
    // A branch dispatch defaults to `next` rather than `beta`, so it cannot
    // move `beta` to code that is not on main.
    expect(scripts).toContain('DIST_TAG="next"');
  });

  it("refuses to start when the version is already on the registry", () => {
    // A workflow_dispatch has no version input — PUBLISH_VERSION is whatever
    // package.json carries — so dispatching from a feature branch routinely
    // targets a version that shipped long ago. The root package publishes
    // LAST, so without this guard the run gets all the way through the
    // cross-compile matrix, the asset upload, and the four platform-package
    // publishes before npm rejects the root package with E403, stranding four
    // orphan @failproofai/failproofaid-<os>-<arch> versions on the registry
    // that nothing pins and nobody can unpublish after 72 hours. That is
    // exactly what run 30906933501 did at 1.0.0-beta.0.
    const guard = wf.jobs.preflight.steps.find(
      (s: Record<string, any>) => s.name === "Verify the version is unpublished",
    );
    expect(guard).toBeDefined();
    expect(guard.run).toContain('npm view "failproofai@$PUBLISH_VERSION"');
    expect(guard.run).toContain("exit 1");
    // Every other job needs preflight, so failing here costs seconds and
    // publishes nothing.
    expect(wf.jobs.daemon.needs).toContain("preflight");
    expect(wf.jobs.publish.needs).toContain("preflight");
    // Deliberately ungated: a dry run whose version is burned is a dry run
    // that validated a release which cannot happen.
    expect(guard.if).toBeUndefined();
  });

  it("verifies every package landed on the registry at one version", () => {
    // Construction already guarantees lockstep — root, platform packages and
    // aliases all take the same PUBLISH_VERSION — so this asserts the check on
    // the thing construction cannot cover: a PARTIAL run. Both halves of the
    // split have shipped once each. beta.1-3 published the CLI with no
    // platform packages behind it (the publish step did not exist yet), and
    // beta.0 published four platform packages whose CLI was already on the
    // registry without pins to them. Each run reported success.
    const steps = wf.jobs.publish.steps.map((s: Record<string, any>) => s.name ?? s.uses);
    const verify = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Verify every package published at the same version",
    );
    expect(verify).toBeDefined();
    // Must run after every publish step, or it verifies a state that is still
    // being written.
    for (const publishStep of ["Publish", "Publish the failproofaid platform packages"]) {
      expect(steps.indexOf(publishStep)).toBeLessThan(steps.indexOf(verify.name));
    }
    for (const platform of PLATFORMS) {
      expect(verify.run).toContain(platform);
    }
    // The pins are written at publish time, so a root package that resolved
    // while pointing at another version is a silent downgrade of the daemon.
    expect(verify.run).toContain("optionalDependencies");
    expect(verify.run).toContain("exit 1");
    // Nothing was published in a dry run, so there is nothing to verify.
    expect(verify.if).toContain("dry_run != 'true'");
    // The registry is a read-through cache — propagation must not read as a
    // failed publish, and a failed publish must not wait forever.
    expect(verify.run).toContain("for DELAY in 0 10 30 60 120");
  });

  it("installs the published packages from the registry, once per platform", () => {
    // The last word on whether a release reached users. `npm view` proves a
    // manifest is queryable; it does not prove the tarball is fetchable, that
    // the os/cpu filters resolve the right platform package on the machine it
    // is for, that the executable bit survived publish -> install, or that the
    // binary matches the CLI beside it. Each of those fails while every
    // manifest query still reads as healthy.
    const job = wf.jobs["verify-install"];
    expect(job).toBeDefined();
    // After the publish, and skipped when nothing was published.
    expect(job.needs).toContain("publish");
    expect(job.if).toContain("dry_run != 'true'");

    // npm installs the ONE platform package matching the runner's os/cpu and
    // skips the other three, so a single-runner check verifies a quarter of
    // what shipped. Each leg must also be native to its own target.
    const legs = job.strategy.matrix.include;
    expect(legs.map((l: Record<string, any>) => l.platform).sort()).toEqual([...PLATFORMS].sort());
    expect(legs.every((l: Record<string, any>) => l.os)).toBe(true);
    expect(job.strategy["fail-fast"]).toBe(false);

    const scripts = runScripts(job);
    expect(scripts).toContain("npm install -g");
    expect(scripts).toContain("for DELAY in 0 10 30 60 120");
    // A real invocation of both binaries, not just a file-exists check.
    expect(scripts).toContain("failproofai --version");
    expect(scripts).toContain('"$BIN" --version');
    expect(scripts).toContain('[ -x "$BIN" ]');
    // Resolved the way the CLI resolves it at runtime, so a package that
    // exists but does not resolve for this machine still fails.
    expect(scripts).toContain("createRequire");
  });

  const stableGuard = () =>
    wf.jobs.preflight.steps.find((s: Record<string, any>) => s.name === "Authorize stable release");

  it("restricts a stable release to the maintainer allowlist", () => {
    const guard = stableGuard();
    expect(guard).toBeDefined();
    expect(guard.env.STABLE_RELEASE_ACTORS.split(/\s+/)).toContain("NiveditJain");

    // Both halves of "stable" are gated: the `latest` dist-tag a bare
    // `npm install` follows, and any non-prerelease version, which claims that
    // number on npm permanently whatever tag it was published under.
    expect(guard.if).toContain("dist_tag == 'latest'");
    expect(guard.if).toContain("is_prerelease == 'false'");

    // A re-run leaves `actor` as whoever started the original run and moves
    // `triggering_actor` to whoever pressed re-run, so both are checked —
    // otherwise a maintainer's stable run is a re-run button for everyone.
    expect(guard.env.ACTOR).toContain("github.actor");
    expect(guard.env.TRIGGERING_ACTOR).toContain("github.triggering_actor");
    expect(guard.run).toContain("exit 1");
  });

  /**
   * Runs the guard step's REAL shell under a controlled environment. Every
   * other assertion here reads YAML text, which a broken comparison or a
   * dropped `TRIGGERING_ACTOR` check would sail straight through — the whole
   * guard is shell, so the shell is what has to be exercised. `bash -e`
   * mirrors the default shell Actions runs `run:` steps under.
   */
  function runGuard(actor: string, triggeringActor: string) {
    const guard = stableGuard();
    return spawnSync("bash", ["-e", "-c", guard.run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        // Next's global augmentation makes NODE_ENV a required member of
        // ProcessEnv, so a minimal env literal has to carry it.
        NODE_ENV: process.env.NODE_ENV,
        STABLE_RELEASE_ACTORS: guard.env.STABLE_RELEASE_ACTORS,
        ACTOR: actor,
        TRIGGERING_ACTOR: triggeringActor,
        DIST_TAG: "latest",
        PUBLISH_VERSION: "1.0.0",
      },
    });
  }

  it("passes an allowlisted maintainer in any casing and fails everyone else", () => {
    // GitHub logins are not case-sensitive, so a case-sensitive comparison
    // would lock the maintainer out of their own stable release.
    expect(runGuard("nIvEdItJaIn", "NIVEDITJAIN").status).toBe(0);

    const wrongActor = runGuard("someone-else", "NiveditJain");
    expect(wrongActor.status).toBe(1);
    expect(wrongActor.stdout).toContain("::error::Stable release refused");

    // The re-run case: `actor` stays the maintainer who started the original
    // run while `triggering_actor` becomes whoever pressed re-run. Checking
    // only the first would authorize this.
    expect(runGuard("NiveditJain", "someone-else").status).toBe(1);
  });

  it("tells a refused caller what would actually clear the gate", () => {
    // A non-prerelease version trips the gate at ANY dist-tag, so advice to
    // "use beta or next" on its own sends them into a second failure.
    const refused = runGuard("someone-else", "someone-else").stdout;
    expect(refused).toContain("PRERELEASE version");
    expect(refused).toContain("allowlisted maintainer");
  });

  it("refuses an unauthorized stable release before anything is built", () => {
    // The gate lives in preflight, which every other job hangs off, so the
    // refusal costs seconds instead of a 4-way cross-compile — and nothing
    // downstream can publish once preflight has failed.
    expect(stableGuard()).toBeDefined();
    expect(wf.jobs.daemon.needs).toContain("preflight");
    expect(wf.jobs.publish.if).toContain("needs.preflight.result == 'success'");
  });

  it("leaves beta and next builds open to anyone with write access", () => {
    // The branch-dispatch path exists so a collaborator can ship a prerelease
    // for testing. An unconditional guard — or one that named those tags —
    // would close it.
    const guard = stableGuard();
    expect(guard.if).toBeTruthy();
    expect(guard.if).not.toContain("beta");
    expect(guard.if).not.toContain("next");
  });

  it("bumps main's version only for a release or a dispatch from main", () => {
    const bump = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Bump version for next development cycle",
    );
    // Pushes to main — but with the app token supplied to this one command
    // rather than persisted into `.git/config` by the checkout, where it would
    // sit readable through `bun install`'s `prepare` build and every dependency
    // lifecycle script. It is a ruleset-bypass credential; its exposure window
    // should be one `git push`, not the whole job.
    expect(bump.run).toContain("HEAD:main");
    expect(bump.run).toContain("APP_TOKEN");
    expect(bump.env?.APP_TOKEN).toContain("app-token");
    expect(bump.if).toContain("github.event_name == 'release'");
    expect(bump.if).toContain("github.ref_name == 'main'");
    expect(bump.if).toContain("dry_run != 'true'");
  });

  it("bumps the Cargo workspace version alongside package.json", () => {
    // `ci.yml`'s version-consistency job compares Cargo.toml's
    // [workspace.package] version against root package.json, and this commit
    // carries `[skip ci]` — so a bump that moved only package.json left main
    // red, and the failure surfaced on the NEXT, unrelated PR as
    // "Version mismatch: Cargo.toml has <old>, expected <new>". Every release
    // did it.
    const bump = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Bump version for next development cycle",
    );
    expect(bump.run).toContain("Cargo.toml");
    // The lockfile pins both crates by the workspace version, so leaving it
    // behind breaks any `--locked` build.
    expect(bump.run).toContain("cargo update --workspace");
    expect(bump.run).toContain("git add package.json Cargo.toml Cargo.lock");
  });

  it("serializes overlapping runs", () => {
    // Two entry points can fire for one version. Without this, both pass the
    // preflight's "already published" check before either publishes, and the
    // bump step's unguarded `git push origin main` loses outright for one of
    // them. Never cancel-in-progress: the assets attach before the npm publish,
    // so a run killed between them leaves a tag with binaries and no package.
    //
    // The group must NOT be keyed on the ref. The two triggers never share
    // one — `release: published` runs as `refs/tags/vX.Y.Z` and
    // `workflow_dispatch` as `refs/heads/main` — so `publish-${{ github.ref }}`
    // placed the exact pair this exists to serialize into different groups and
    // queued neither. Nothing here is per-ref: the bump races on `main`
    // whichever ref produced the run.
    expect(wf.concurrency?.group).toBe("publish");
    expect(wf.concurrency?.group).not.toContain("github.ref");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("never leaves the ruleset-bypass token on disk while build scripts run", () => {
    // The publish job checks out with the version-bot App token, which bypasses
    // the org ruleset's PR-and-review requirement on `main`. Persisting it
    // writes it into `.git/config` for the whole job — and the very next step
    // is `bun install`, which runs `prepare` (a full Next build) plus every
    // dependency lifecycle script, all long before the one step at the end that
    // needs the token. `ci.yml` and `build-daemon.yml` were hardened for the
    // identical risk with the WEAKER default token; this job was missed.
    const checkout = wf.jobs.publish.steps.find((s: Record<string, any>) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(checkout.with?.token).toBeUndefined();
  });

  it("keeps the npm token out of the build toolchain", () => {
    // `npm publish` runs `prepare` — a full `next build` — and that inherits
    // the publishing step's environment, so NODE_AUTH_TOKEN was exported into
    // the bundler and every dependency it loads. The build is done as its own
    // step (it must still happen AFTER `npm version`, because `bun build`
    // inlines package.json's version into dist/cli.mjs and daemon-download.ts
    // derives the release URL from it), and the publish then skips scripts.
    const steps = wf.jobs.publish.steps as Record<string, any>[];
    const buildIdx = steps.findIndex((s) => s.name === "Build the tarball contents");
    const publishIdx = steps.findIndex((s) => s.name === "Publish");
    const versionIdx = steps.findIndex((s) => s.name === "Set publish version in package.json");

    expect(buildIdx).toBeGreaterThan(versionIdx);
    expect(publishIdx).toBeGreaterThan(buildIdx);
    // The build step must not carry a registry credential.
    expect(JSON.stringify(steps[buildIdx].env ?? {})).not.toContain("NPM_TOKEN");
    // And every `npm publish` invocation must skip the lifecycle scripts.
    for (const line of String(steps[publishIdx].run).split("\n")) {
      if (line.includes("npm publish")) expect(line).toContain("--ignore-scripts");
    }
  });

  it("verifies the release carries every platform binary", () => {
    const scripts = runScripts(wf.jobs["release-assets"]);
    expect(scripts).toContain("SHA256SUMS");
    // The CLI will not install a binary it cannot match to a checksum line, so
    // a short list is a broken release rather than a partial one.
    expect(scripts).toContain('"$COUNT" -ne 4');
  });

  it("publishes the platform packages before the root package that pins them", () => {
    const steps = wf.jobs.publish.steps.map((s: Record<string, any>) => s.name ?? s.uses);
    const platforms = steps.indexOf("Publish the failproofaid platform packages");
    const root = steps.indexOf("Publish");
    expect(platforms).toBeGreaterThan(-1);
    // An optionalDependency npm cannot resolve is a 404 in every install.
    expect(platforms).toBeLessThan(root);

    const step = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Publish the failproofaid platform packages",
    );
    expect(step.run).toContain("scripts/build-daemon-packages.mjs");
    // The same invocation writes the pins, so the two can never disagree.
    expect(step.run).toContain("--pin-root");
    expect(step.run).toContain("--version");
    // Skipped wholesale on a ref that builds no daemon, or the root package
    // would pin four packages this run never published.
    expect(step.if).toContain("needs.daemon.result == 'success'");

    const download = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Download the daemon binaries",
    );
    expect(download.with.pattern).toBe("failproofaid-*");
    expect(download.if).toContain("needs.daemon.result == 'success'");
    // NOT into the checkout: `npm publish` re-runs `prepare`, and Next's file
    // tracing sweeps the whole project root into `.next/standalone`. A dry run
    // with these in the workspace shipped 16 MB of daemon .gz assets inside
    // the published CLI tarball.
    expect(download.with.path).toContain("runner.temp");
  });

  it("builds and attaches the CLI tarball on every release, daemon or not", () => {
    const tarball = wf.jobs["cli-tarball"];
    expect(tarball.needs).toBe("preflight");
    // Deliberately NOT gated on has_daemon: the CLI artifact is how anyone
    // installs failproofai without the npm registry.
    expect(JSON.stringify(tarball.if ?? "")).not.toContain("has_daemon");

    const scripts = runScripts(tarball);
    // Packed at the version being published — an asset named for a version it
    // does not contain is worse than no asset.
    expect(scripts).toContain("npm version");
    expect(scripts).toContain("npm pack --ignore-scripts");
    const upload = tarball.steps.find((s: Record<string, any>) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(upload.with.name).toBe("failproofai-tarball");
    expect(upload.with["if-no-files-found"]).toBe("error");

    expect(wf.jobs["release-assets"].needs).toContain("cli-tarball");
    const assetScripts = runScripts(wf.jobs["release-assets"]);
    expect(assetScripts).toContain("sha256sum failproofai-*.tgz");
    // A tarball-less release must fail rather than quietly ship four binaries
    // and no CLI.
    expect(assetScripts).toContain("No CLI tarball to attach");
  });

  it("never publishes when the CLI tarball build failed", () => {
    // cli-tarball runs the same build the publish job publishes, so a failure
    // there is never "nothing to do" — and a failed dependency leaves its
    // dependents `skipped`, which the daemon clause already tolerates.
    expect(wf.jobs.publish.needs).toContain("cli-tarball");
    expect(wf.jobs.publish.if).toContain("needs.cli-tarball.result == 'success'");
    expect(wf.jobs["release-assets"].if).toContain("needs.cli-tarball.result == 'success'");
  });

  it("writes nothing to npm or the repo on a dry run", () => {
    const publishStep = wf.jobs.publish.steps.find((s: Record<string, any>) => s.name === "Publish");
    expect(publishStep.run).toContain("npm publish --dry-run");
    const platformStep = wf.jobs.publish.steps.find(
      (s: Record<string, any>) => s.name === "Publish the failproofaid platform packages",
    );
    expect(platformStep.run).toContain("--dry-run");
    const assets = wf.jobs["release-assets"].steps.find(
      (s: Record<string, any>) => s.name === "Attach assets to the release",
    );
    expect(assets.if).toContain("!inputs.dry_run");
  });
});

/**
 * The announcement runs once per stable release and nothing else exercises it,
 * so every guard here is for a change that would look harmless in review and
 * only show up in a public channel — or not show up at all.
 */
describe("publish.yml / the Discord release announcement", () => {
  const wf = workflow("publish.yml");
  const job = wf.jobs.announce;

  it("announces only a STABLE release, at the dist-tag a bare install resolves", () => {
    // Both halves are required. A prerelease version is a beta nobody asked to
    // be pinged about; a stable version published at `next` is not what
    // `npm install failproofai` returns, so the announcement's install line
    // would be wrong on the one line people copy.
    expect(job.if).toContain("needs.preflight.outputs.is_prerelease == 'false'");
    expect(job.if).toContain("needs.preflight.outputs.dist_tag == 'latest'");
    expect(job.if).toContain("needs.preflight.outputs.dry_run != 'true'");
  });

  it("announces only after the release is published AND verified installable", () => {
    expect(job.needs).toEqual(expect.arrayContaining(["publish", "verify-install"]));
    // No `always()`: a job in `needs` that failed must stop the announcement,
    // or a channel gets told to install something that 404s.
    expect(job.if).not.toContain("always()");
  });

  it("cannot hold back the release it announces", () => {
    // Nothing may depend on `announce`. A red mark there means the message did
    // not go out; it must never mean a published package is blocked.
    for (const [name, other] of Object.entries<Record<string, any>>(wf.jobs)) {
      if (name === "announce") continue;
      expect([other.needs ?? []].flat()).not.toContain("announce");
    }
  });

  it("prefers the GitHub Release body over the changelog", () => {
    const build = job.steps.find((s: Record<string, any>) => s.name === "Build the announcement");
    expect(build.env.RELEASE_BODY).toContain("github.event.release.body");
    expect(build.run).toContain("--notes-file");
  });

  it("never puts the release body on a command line", () => {
    // It is arbitrary markdown typed into a web form. Interpolating it into a
    // `run:` block lets a backtick in somebody's release notes execute inside
    // the release pipeline.
    const build = job.steps.find((s: Record<string, any>) => s.name === "Build the announcement");
    expect(build.run).not.toContain("github.event.release.body");
    expect(build.run).toContain("printf '%s' \"$RELEASE_BODY\"");
  });

  it("skips silently without a webhook and fails loudly when a post does not land", () => {
    const post = job.steps.find((s: Record<string, any>) => s.name === "Post to the releases channel");
    expect(post.env.DISCORD_RELEASE_WEBHOOK).toContain("secrets.DISCORD_RELEASE_WEBHOOK");
    // A fork with no webhook must not turn a release red...
    expect(post.run).toContain('if [ -z "$DISCORD_RELEASE_WEBHOOK" ]');
    expect(post.run).toContain("::notice::");
    // ...but a deleted or revoked webhook is a real failure, and this job is
    // the only place anyone would ever learn it happened.
    expect(post.run).toContain("::error::");
    expect(post.run.trimEnd().endsWith("exit 1")).toBe(true);
  });

  it("holds the webhook credential under least privilege", () => {
    // Declared, not inherited: without a block the job takes the repository or
    // organization default, which may carry write scopes it has no use for.
    expect(job.permissions).toEqual({ contents: "read" });
  });

  it("reads the release role from a repository variable or a secret", () => {
    const build = job.steps.find((s: Record<string, any>) => s.name === "Build the announcement");
    expect(build.env.ROLE_ID).toContain("vars.DISCORD_RELEASE_ROLE_ID");
    expect(build.env.ROLE_ID).toContain("secrets.DISCORD_RELEASE_ROLE_ID");
  });

  it("refuses a stable release with nothing to announce, before anything is built", () => {
    // In PREFLIGHT, the one point in this pipeline where failing costs nothing:
    // no cross-compile, no release assets, no npm publish.
    const step = wf.jobs.preflight.steps.find(
      (s: Record<string, any>) => s.name === "Verify this stable release has notes to announce",
    );
    expect(step).toBeDefined();
    expect(step.if).toContain("is_prerelease == 'false'");
    expect(step.run).toContain("--check");
  });
});

describe("pipeline / CLI agreement", () => {
  const DAEMON_SERVICE = resolve(ROOT, "src/hooks/daemon-service.ts");

  // Only meaningful on a ref that carries the daemon. On main (before #632
  // lands) there is no CLI-side platform list to agree with.
  it.skipIf(!existsSync(DAEMON_SERVICE))(
    "builds a binary for every platform the CLI knows how to resolve",
    () => {
      const source = readFileSync(DAEMON_SERVICE, "utf8");
      const union = source.match(/type PlatformKey =([^;]+);/)?.[1] ?? "";
      const declared = [...union.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

      expect(declared.length).toBeGreaterThan(0);
      const built = workflow("build-daemon.yml").jobs.build.strategy.matrix.include.map(
        (m: Record<string, string>) => m.platform,
      );
      // A platform the CLI resolves but CI never builds is a platform whose
      // users silently get no daemon.
      expect([...declared].sort()).toEqual([...built].sort());
    },
  );

  it.skipIf(!existsSync(DAEMON_SERVICE))(
    "publishes an npm package for every platform the CLI knows how to resolve",
    async () => {
      const source = readFileSync(DAEMON_SERVICE, "utf8");
      const union = source.match(/type PlatformKey =([^;]+);/)?.[1] ?? "";
      const declared = [...union.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

      const { DAEMON_PLATFORMS } = await import("../../scripts/daemon-platforms.mjs");
      // A platform missing from the publish list is one whose users get no
      // binary from npm and silently fall back to the download — or, if the
      // download is blocked, no daemon at all.
      expect(DAEMON_PLATFORMS.map((p: { key: string }) => p.key).sort()).toEqual([...declared].sort());
    },
  );
});
