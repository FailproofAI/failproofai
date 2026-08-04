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
 *   - the main-version bump only runs for a release or a dispatch from main
 *     (it checks main out and pushes to it, regardless of the dispatched ref);
 *   - build-daemon.yml stays callable and is not also triggered standalone on
 *     a release (that would build the matrix twice per release);
 *   - a stable release stays restricted to the maintainer allowlist while
 *     beta/next builds stay open to anyone with write access (deleting that
 *     step is a one-line change that nothing else would notice);
 *   - the platform list in the build matrix matches the platforms the CLI
 *     actually knows how to resolve — a missing leg is a platform that
 *     silently gets no daemon.
 */
import { describe, it, expect } from "vitest";
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
    expect(bump.run).toContain("git push origin main");
    expect(bump.if).toContain("github.event_name == 'release'");
    expect(bump.if).toContain("github.ref_name == 'main'");
    expect(bump.if).toContain("dry_run != 'true'");
  });

  it("verifies the release carries every platform binary", () => {
    const scripts = runScripts(wf.jobs["release-assets"]);
    expect(scripts).toContain("SHA256SUMS");
    // The CLI will not install a binary it cannot match to a checksum line, so
    // a short list is a broken release rather than a partial one.
    expect(scripts).toContain('"$COUNT" -ne 4');
  });

  it("writes nothing to npm or the repo on a dry run", () => {
    const publishStep = wf.jobs.publish.steps.find((s: Record<string, any>) => s.name === "Publish");
    expect(publishStep.run).toContain("npm publish --dry-run");
    const assets = wf.jobs["release-assets"].steps.find(
      (s: Record<string, any>) => s.name === "Attach assets to the release",
    );
    expect(assets.if).toContain("!inputs.dry_run");
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
});
