// @vitest-environment node
/**
 * The contracts lab's wiring, pinned.
 *
 * Every assertion here is about a failure that produces NO error message. The
 * lab's output is a file describing twelve vendors; when it is wrong it is
 * wrong quietly, and each of these is a way it could publish something
 * confident and empty:
 *
 *  - run without the daemon, and the observer records nothing at all, because
 *    `recordHookShape` has exactly one call site and it is in the warm worker.
 *    Twelve probes, an empty pack, and no error anywhere.
 *  - write artifacts under /repo, which the sandbox mounts READ-ONLY, and the
 *    copy fails into a `|| true` — same empty pack.
 *  - publish a pack from a run that exercised nothing, and a good file is
 *    overwritten with silence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SUITE = path.join(__dirname, "..", "..", "integration-suite");
const LOCAL = path.join(SUITE, "local");
const read = (p: string) => readFileSync(p, "utf8");

const probeSh = read(path.join(SUITE, "contracts-probe.sh"));
const runnerSh = read(path.join(SUITE, "contracts-runner.sh"));
const publishSh = read(path.join(SUITE, "contracts-publish.sh"));
const entrypointSh = read(path.join(SUITE, "ci-entrypoint.sh"));
const jobSh = read(path.join(LOCAL, "jobs", "contracts.sh"));
const runJobSh = read(path.join(LOCAL, "run-job.sh"));
const installSh = read(path.join(LOCAL, "install.sh"));

describe("the lab cannot run in a configuration that records nothing", () => {
  it("refuses to start without the daemon binary", () => {
    // The one invariant that decides whether the whole run means anything:
    // in-process evaluation calls recordHookShape from nowhere, so a run
    // without failproofaid produces an empty pack and no complaint.
    expect(runnerSh).toMatch(/CANARY_DAEMON_BIN:\?/);
    expect(runnerSh).toContain("only the warm worker records payload shapes");
  });

  it("mounts the daemon exactly where the probe executes it", () => {
    // Same class of bug the canary already guards: a mount path and an exec
    // path that drift apart fail as "daemon did not come up".
    const mount = /-v "\$DBIN:(\S+):ro"/.exec(runnerSh);
    expect(mount).not.toBeNull();
    expect(probeSh).toContain(mount![1]);
  });

  it("forces every observation to disk instead of trusting a flush", () => {
    // Writes are throttled to once a minute and the daemon SIGKILLs the worker,
    // so a whole run's observations can die unwritten.
    expect(probeSh).toMatch(/FAILPROOFAI_OBSERVE_INTERVAL_MS=0/);
  });

  it("clears the previous table so a run describes only itself", () => {
    // observed.json unions keys and never forgets. Without this a CLI whose
    // hooks stopped firing keeps showing yesterday's events and reads healthy.
    expect(probeSh).toMatch(/rm -f "\$OBSERVED"/);
  });

  it("reads each table back from exactly where the probe wrote it", () => {
    // The probe writes to $HOME/contracts-out inside the container and the
    // runner lifts the file out by absolute path. The two only agree because
    // the sandbox image's user is `canary` with that home — an implicit
    // coupling across three files, and one that fails as an empty pack rather
    // than an error.
    const dockerfile = read(path.join(SUITE, "Dockerfile"));
    expect(dockerfile).toMatch(/useradd .*--create-home .*canary/);
    expect(dockerfile).toMatch(/^USER canary/m);
    expect(probeSh).toMatch(/OUT_DIR="\$\{CONTRACTS_OUT_DIR:-\$HOME\/contracts-out\}"/);
    expect(runnerSh).toContain("/home/canary/contracts-out/$cli.json");
  });

  it("keeps its artifacts off the read-only repo mount", () => {
    // The sandbox mounts /repo with :ro. A default output path under it fails
    // into a `|| true` and produces an empty pack.
    expect(probeSh).not.toMatch(/OUT_DIR="\$\{CONTRACTS_OUT_DIR:-\$REPO_DIR/);
    expect(runnerSh).toMatch(/-v "\$REPO:\/repo:ro"/);
  });
});

describe("one entrypoint, two runners", () => {
  it("lets the entrypoint pick a runner, and only a runner it knows", () => {
    // Everything above that line — build, daemon, image, CLI installs, tokens,
    // env file — is identical for both. Copying it to change the last line is
    // how two harnesses drift into testing different things.
    expect(entrypointSh).toMatch(/RUNNER="\$\{CANARY_RUNNER:-run\.sh\}"/);
    expect(entrypointSh).toMatch(/run\.sh\|contracts-runner\.sh/);
    expect(entrypointSh).toMatch(/bash "\$HERE\/\$RUNNER"/);
  });

  it("asks the entrypoint for the contracts runner, with the daemon on", () => {
    expect(jobSh).toMatch(/CANARY_RUNNER="contracts-runner\.sh"/);
    expect(jobSh).toMatch(/CANARY_DAEMON=1/);
    expect(jobSh).toContain("integration-suite/ci-entrypoint.sh");
  });

  it("does not version-gate, unlike the canary", () => {
    // The canary skips a CLI whose version has not moved because the answer
    // cannot have changed. Here the artifact IS the current contract, so a
    // gated run would publish entries dating from different weeks.
    expect(runnerSh).not.toMatch(/CANARY_VERSION_GATED/);
    expect(runnerSh).toContain("There is deliberately NO version gating");
  });
});

describe("the box knows about the job", () => {
  it("gives it the docker socket, because it fans out sibling containers", () => {
    expect(runJobSh).toMatch(/contracts\)\s+SOCK=\(-v \/var\/run\/docker\.sock/);
  });

  it("is scheduled by default and demands the credentials it needs to reach a vendor", () => {
    expect(installSh).toMatch(/ALL_JOBS="canary contracts translate docs-audit"/);
    expect(installSh).toMatch(/REQUIRED_contracts="[^"]*CANARY_SLACK_WEBHOOK/);
    expect(installSh).toMatch(/REQUIRED_contracts="CONTRACTS_REF/);
    expect(installSh).toMatch(/AT_contracts="0 6"/);
  });

  it("does not require the publish credentials, so it installs before the repo exists", () => {
    // A lab that reports to Slack but publishes nothing is a useful lab. One
    // that refuses to install until a repo is created is not.
    expect(installSh).not.toMatch(/REQUIRED_contracts="[^"]*CONTRACTS_TOKEN/);
    expect(installSh).not.toMatch(/REQUIRED_contracts="[^"]*CONTRACTS_REPO/);
    expect(jobSh).toMatch(/-n "\$\{CONTRACTS_REPO:-\}" \] && \[ -n "\$\{CONTRACTS_TOKEN:-\}"/);
  });

  it("exists as a job file, since the entrypoint resolves jobs by name", () => {
    expect(existsSync(path.join(LOCAL, "jobs", "contracts.sh"))).toBe(true);
  });
});

describe("publishing", () => {
  it("never publishes from a run that could not be trusted", () => {
    // rc=2 is "nothing was exercised" or "a probe errored". Overwriting a good
    // pack with that is worse than publishing nothing at all.
    expect(jobSh).toMatch(/\[ "\$rc" -lt 2 \]/);
  });

  it("publishes only when the contract moved, not when the clock did", () => {
    // Every pack carries a fresh generatedAt. Commit on that and the repo
    // releases daily, and a release stops meaning "something moved".
    expect(publishSh).toMatch(/delete o\.generatedAt/);
    expect(publishSh).toContain("nothing moved");
  });

  it("keeps the token out of everything it prints", () => {
    // The token is embedded in the remote URL, so no message may echo it.
    expect(publishSh).toMatch(/x-access-token:\$\{TOKEN\}/);
    for (const line of publishSh.split("\n")) {
      if (/^\s*(echo|printf)\b/.test(line)) expect(line).not.toContain("$TOKEN");
    }
  });
});
