/**
 * Tripwires for the LOCAL canary runner (integration-suite/local/) and the
 * daemon-mode (CANARY_DAEMON) probe path.
 *
 * Daily integration-suite runs moved off GH Actions (2026-08-07, for
 * runner-minute cost) onto a box whose entire contract is: Docker + one cron
 * line + one env file. A self-contained runner image drives the HOST's Docker
 * through the mounted socket; its baked entrypoint checks out CANARY_REF and
 * hands off to runner-daily.sh FROM THE CHECKOUT, so harness changes reach the
 * box through git with no image rebuild. The stable leg probes the
 * daemon-configured (failproofaid) path — the way-forward configuration.
 *
 * Everything below is shell scripts, a Dockerfile and an env template with no
 * importable surface, so the tests parse the real files — same approach as
 * channel-refs.test.ts, and for the same reason: the alternative is a second
 * copy of each contract to drift against.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../..");
const SUITE = path.join(ROOT, "integration-suite");
const LOCAL = path.join(SUITE, "local");
const dockerfile = readFileSync(path.join(LOCAL, "Dockerfile.runner"), "utf8");
const entrypointSh = readFileSync(path.join(LOCAL, "runner-entrypoint.sh"), "utf8");
const dailySh = readFileSync(path.join(LOCAL, "runner-daily.sh"), "utf8");
const secretsExample = readFileSync(path.join(LOCAL, "secrets.env.example"), "utf8");
const workflow = readFileSync(
  path.join(ROOT, ".github/workflows/integration-suite.yml"),
  "utf8",
);
const probeSh = readFileSync(path.join(SUITE, "probe-cli.sh"), "utf8");
const runSh = readFileSync(path.join(SUITE, "run.sh"), "utf8");
const entrypoint = readFileSync(path.join(SUITE, "ci-entrypoint.sh"), "utf8");
const handlerTs = readFileSync(path.join(ROOT, "src/hooks/handler.ts"), "utf8");

describe("GHA workflow is dispatch-only", () => {
  it("has no schedule trigger (daily runs live on the canary box)", () => {
    // Dropping the daily cron WAS the cost decision. A schedule reappearing
    // here must be deliberate — this makes it a conversation, not a re-spend.
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).not.toMatch(/\bcron:/);
  });

  it("keeps workflow_dispatch as the cloud fallback", () => {
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
  });
});

describe("runner image (the boss's one container)", () => {
  it("bakes the thin entrypoint and nothing else of the harness", () => {
    // The image must stay rebuild-free across harness changes: it may carry
    // runner-entrypoint.sh (thin, stable) but must NOT bake runner-daily.sh
    // or any other harness file — those are executed from the checkout.
    expect(dockerfile).toMatch(/^COPY runner-entrypoint\.sh /m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/runner-entrypoint\.sh"\]$/m);
    // (comments may mention the daily driver; COPY lines must not)
    expect(dockerfile).not.toMatch(/^COPY .*runner-daily/m);
  });

  it("ships the docker CLIENT for the mounted host socket", () => {
    expect(dockerfile).toMatch(/download\.docker\.com\/linux\/static/);
  });

  it("entrypoint refuses to run without the socket and without CANARY_REF", () => {
    // A baked-in default ref would silently keep probing a stale branch after
    // the daemon branch merges to main — the env file states what it tests.
    expect(entrypointSh).toContain("/var/run/docker.sock");
    expect(entrypointSh).toMatch(/\$\{CANARY_REF:\?/);
  });

  it("entrypoint serializes runs and hands off to the in-repo daily driver", () => {
    // The lock file lives on the host work dir so overlapping cron fires
    // share one lock across separate containers.
    expect(entrypointSh).toMatch(/flock -n/);
    expect(entrypointSh).toMatch(/exec bash "\$CLONE\/integration-suite\/local\/runner-daily\.sh"/);
    expect(existsSync(path.join(LOCAL, "runner-daily.sh"))).toBe(true);
  });

  it("entrypoint explains the identical-path work-dir mount when it is missing", () => {
    // Path parity is the load-bearing trick of the whole design: paths under
    // the work dir serve as sibling-container -v sources, resolved by the
    // HOST daemon. The failure message must teach the fix.
    expect(entrypointSh).toMatch(/-v \\"\\\$HOME\/fp-canary:\\\$HOME\/fp-canary\\"/);
  });
});

describe("daily driver (in-repo, evolves with the harness)", () => {
  it("drives the same front door CI does, one leg per channel", () => {
    expect(dailySh).toContain("integration-suite/ci-entrypoint.sh");
    expect(dailySh).toMatch(/\$\{CANARY_LEGS:-stable beta\}/);
  });

  it("stable leg defaults to the daemon path, beta to in-process", () => {
    expect(dailySh).toContain("${CANARY_DAEMON_STABLE:-1}");
    expect(dailySh).toContain("${CANARY_DAEMON_BETA:-0}");
  });

  it("pins the cargo cache under the work dir (path parity for the sibling build)", () => {
    // ci-entrypoint's default cargo cache is under $HOME — inside the runner
    // container that path does not exist on the host, so the rust sibling
    // container's -v mount would silently create a root-owned host dir and
    // cache nothing. The only harness default rooted outside $WORK.
    expect(dailySh).toMatch(/CANARY_CARGO_CACHE="\$\{CANARY_CARGO_CACHE:-\$WORK\/cargo\}"/);
  });

  it("crash-guard greps the exact success line run.sh prints", () => {
    // "leg died WITHOUT reporting" is detected by the absence of run.sh's own
    // posted-to-Slack line — if that wording changes in run.sh, the crash
    // guard goes blind and every FAIL verdict would double-post a crash note.
    const m = /grep -q "([^"]+)" "\$leg_log"/.exec(dailySh);
    expect(m).not.toBeNull();
    expect(runSh).toContain(m![1]);
  });
});

describe("secrets.env.example (the one file the boss edits)", () => {
  it("offers every secret-fed env var the workflow maps", () => {
    // The box's env file and the GHA Environment must stay interchangeable.
    // A secret added to the workflow but not the example means the box runs
    // without it and that CLI quietly reports ERROR forever.
    const envNames = [...workflow.matchAll(/^\s+([A-Z0-9_]+):\s+\$\{\{\s*secrets\./gm)].map(
      (m) => m[1],
    );
    expect(envNames.length).toBeGreaterThanOrEqual(10);
    for (const name of envNames) {
      expect(secretsExample, `secrets.env.example is missing ${name}`).toContain(name);
    }
  });

  it("states CANARY_REF uncommented (the runner refuses to start without it)", () => {
    expect(secretsExample).toMatch(/^CANARY_REF=\S+$/m);
  });

  it("is valid docker --env-file material: no shell expansion on value lines", () => {
    // docker --env-file is literal KEY=value — a $HOME in a value would reach
    // the container as the four characters "$HOM"+"E". Comments may mention
    // $HOME freely; value lines must not.
    const valueLines = secretsExample
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"));
    for (const line of valueLines) {
      expect(line, `value line must not rely on shell expansion: ${line}`).not.toContain("$");
    }
  });
});

describe("daemon-mode probe path", () => {
  it("ci-entrypoint builds the daemon in a bookworm container and hands it to run.sh", () => {
    // rust:1-bookworm ⇔ node:22-bookworm-slim sandbox: same glibc line. A
    // host build can link a newer glibc and fail to load inside the sandbox.
    expect(entrypoint).toMatch(/rust:1-bookworm cargo build --release --locked -p failproofaid/);
    expect(entrypoint).toMatch(/^CANARY_DAEMON=/m);
    expect(entrypoint).toMatch(/^CANARY_DAEMON_BIN=/m);
  });

  it("run.sh mounts the binary exactly where probe-cli.sh executes it", () => {
    const mount = /-v "\$DBIN:(\S+):ro"/.exec(runSh);
    expect(mount).not.toBeNull();
    expect(probeSh).toContain(mount![1]);
  });

  it("probe-cli.sh restarts the daemon per probe (oracle isolation)", () => {
    // The wire protocol forwards {hookEvent, cli, stdin, cwd} — never env — so
    // the worker's FAILPROOFAI_HOOK_LOG_FILE is fixed at daemon start. One
    // daemon across both probes would mean one shared log dir, and probe A's
    // incidental read-denies (an agent exploring before it touches the marker)
    // would satisfy probe B's grep: a false PASS.
    expect(probeSh).toContain('daemon_cycle "$LOGA"');
    expect(probeSh).toContain('daemon_cycle "$LOGB"');
  });

  it("sets the fail-closed marker in daemon mode and clears it otherwise", () => {
    // The HOME volume persists across daily runs: a marker left behind by a
    // daemon-mode run would make an in-process run fail closed on every hook
    // event with no daemon anywhere.
    expect(probeSh).toMatch(/updateConfig\(\{daemon:\{configured:true\}\}\)/);
    expect(probeSh).toMatch(/updateConfig\(\{daemon:\{configured:false\}\}\)/);
  });

  it("CANARY_DAEMON_DEAD implies daemon mode in every layer", () => {
    // The fail-closed leg (daemon-configured, daemon never started — every CLI
    // must deny; live-verified 2026-08-07 against 10 real CLIs). Each layer
    // normalizes independently because each can be invoked directly.
    for (const [name, src] of [
      ["probe-cli.sh", probeSh],
      ["run.sh", runSh],
      ["ci-entrypoint.sh", entrypoint],
    ] as const) {
      expect(src, `${name} missing the DEAD→DAEMON normalization`).toMatch(
        /CANARY_DAEMON_DEAD[^\n]*&& CANARY_DAEMON=1|CANARY_DAEMON_DEAD[^\n]*\]; then CANARY_DAEMON=1/,
      );
    }
  });

  it("the DEAD leg never starts the daemon, needs no binary, and skips the build", () => {
    expect(probeSh).toMatch(/CANARY_DAEMON_DEAD[^\n]*mkdir -p "\$1"; return 0/);
    // run.sh: the binary requirement sits inside the not-DEAD guard
    expect(runSh).toMatch(/CANARY_DAEMON_DEAD[^\n]*!= 1[\s\S]{0,200}CANARY_DAEMON_BIN/);
    // ci-entrypoint: the cargo build is skipped on the DEAD leg
    expect(entrypoint).toMatch(/CANARY_DAEMON[^\n]*= 1[^\n]*&&[^\n]*CANARY_DAEMON_DEAD[^\n]*!= 1/);
  });

  it("the DEAD leg scores the fail-closed deny as PASS on both probes", () => {
    const scored = probeSh.match(
      /\[ "\$\{CANARY_DAEMON_DEAD:-0\}" = 1 \] && daemon_failed_closed "\$LOG[AB]\/hooks\.log"; then V[AB]=PASS/g,
    );
    expect(scored?.length).toBe(2);
    // and the detector keys on the synthetic fail-closed policy name
    expect(probeSh).toMatch(/daemon_failed_closed\(\) \{ grep -q "daemon-unreachable"/);
  });

  it("DEAD-leg results live in their own state lane", () => {
    // A PASS on the DEAD leg means "denied while dead". Written into the
    // enforcement gate it would skip the next REAL probe of the same
    // (CLI, failproofai) pair as already-green.
    expect(runSh).toMatch(/STATE="\$STATE\.dead"/);
  });

  it("the marker is cleared BEFORE wire and set AFTER it (wire fires vendor hooks)", () => {
    // A marker with no daemon up yet would fail-close the vendor CLI calls
    // wire() itself makes (openclaw onboard fires plugin hooks), breaking the
    // wiring before any probe runs. That marker can come from TODAY (set too
    // early) or YESTERDAY (persistent volume) — so the clear must run in every
    // mode before wire, and daemon mode re-sets only after wire.
    const wireCall = probeSh.indexOf("\nwire\n");
    const markerClear = probeSh.indexOf("m.updateConfig({daemon:{configured:false}})");
    const markerSet = probeSh.indexOf("m.updateConfig({daemon:{configured:true}})");
    expect(wireCall).toBeGreaterThan(0);
    expect(markerClear).toBeGreaterThan(0);
    expect(markerClear).toBeLessThan(wireCall);
    expect(markerSet).toBeGreaterThan(wireCall);
  });

  it("a dead daemon cannot false-PASS either probe", () => {
    // bin/failproofai.mjs shapes an unreachable-daemon deny through a
    // synthetic policy (see handler.ts's forceDecision branch). Its oracle
    // line must NEVER satisfy the probes' deny greps — otherwise a crashed
    // daemon reads as healthy enforcement, the exact inversion this suite
    // exists to catch. Both sides are extracted from the real sources so a
    // rename on either side trips this test.
    const idMatch = /registerPolicy\(\s*"(failproofai\/[a-z-]+)",\s*"Fail-closed/.exec(handlerTs);
    expect(idMatch).not.toBeNull();
    // handler.ts — `result=${decision} policy=${policyName} duration=…`
    const failClosedLine = `result=deny policy=${idMatch![1]} duration=3ms`;

    const deniedPat = /denied\(\) \{ grep -qE "([^"]+)"/.exec(probeSh);
    const readDeniedPat = /read_denied\(\) \{ grep -qE "([^"]+)"/.exec(probeSh);
    expect(deniedPat).not.toBeNull();
    expect(readDeniedPat).not.toBeNull();

    const deniedRe = new RegExp(deniedPat![1].replace("$1", "canary-bash"));
    const readDeniedRe = new RegExp(readDeniedPat![1]);
    // Sanity both ways: the real canary/builtin lines must still match…
    expect(deniedRe.test("result=deny policy=custom/canary-bash duration=2ms")).toBe(true);
    expect(
      readDeniedRe.test("result=deny policy=failproofai/block-read-outside-cwd duration=2ms"),
    ).toBe(true);
    // …and the fail-closed line must match neither.
    expect(deniedRe.test(failClosedLine)).toBe(false);
    expect(readDeniedRe.test(failClosedLine)).toBe(false);
  });
});
