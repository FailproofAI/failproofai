/**
 * Tripwires for the LOCAL box runner (integration-suite/local/) and the
 * daemon-mode (CANARY_DAEMON) probe path.
 *
 * TWO scheduled jobs moved off GH Actions for runner-minute cost — the daily
 * integration suite (2026-08-07) and the nightly doc translation — onto a box
 * whose entire contract is: Docker + cron + one env file. A self-contained
 * runner image drives the HOST's Docker through the mounted socket; its baked
 * entrypoint checks out <JOB>_REF and hands off to jobs/$CANARY_JOB.sh FROM
 * THE CHECKOUT, so harness changes AND WHOLE NEW JOBS reach the box through
 * git with no image rebuild. The stable canary leg probes the
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
const dailySh = readFileSync(path.join(LOCAL, "jobs/canary.sh"), "utf8");
const translateSh = readFileSync(path.join(LOCAL, "jobs/translate.sh"), "utf8");
const installSh = readFileSync(path.join(LOCAL, "install.sh"), "utf8");
const secretsExample = readFileSync(path.join(LOCAL, "secrets.env.example"), "utf8");
const workflow = readFileSync(
  path.join(ROOT, ".github/workflows/integration-suite.yml"),
  "utf8",
);
const translateWorkflow = readFileSync(
  path.join(ROOT, ".github/workflows/translate-docs.yml"),
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
    // runner-entrypoint.sh (thin, stable) but must NOT bake any job script —
    // those are executed from the checkout, which is what lets a NEW job ship
    // without anyone rebuilding the boss's image.
    expect(dockerfile).toMatch(/^COPY runner-entrypoint\.sh /m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/runner-entrypoint\.sh"\]$/m);
    // (comments may mention the job scripts; COPY lines must not)
    expect(dockerfile).not.toMatch(/^COPY .*jobs\//m);
    expect(dockerfile).not.toMatch(/^COPY .*runner-daily/m);
  });

  it("ships the docker CLIENT for the mounted host socket", () => {
    expect(dockerfile).toMatch(/download\.docker\.com\/linux\/static/);
  });

  it("entrypoint refuses to run without the socket and without the job's ref", () => {
    // A baked-in default ref would silently keep running against a stale
    // branch forever — the env file states what each job runs against. The
    // var is derived from the job name (CANARY_REF, TRANSLATE_REF) so the
    // baked layer never learns which jobs exist.
    expect(entrypointSh).toContain("/var/run/docker.sock");
    expect(entrypointSh).toMatch(/REF_VAR=.*tr 'a-z-' 'A-Z_'.*_REF/);
    expect(entrypointSh).toMatch(/\[ -n "\$REF" \] \|\|/);
  });

  it("entrypoint serializes runs and hands off to the in-repo job script", () => {
    // The lock file lives on the host work dir so overlapping cron fires
    // share one lock across separate containers.
    expect(entrypointSh).toMatch(/flock -n/);
    expect(entrypointSh).toMatch(/JOB_SCRIPT="\$CLONE\/integration-suite\/local\/jobs\/\$JOB\.sh"/);
    expect(entrypointSh).toMatch(/exec bash "\$JOB_SCRIPT"/);
    expect(existsSync(path.join(LOCAL, "jobs/canary.sh"))).toBe(true);
    expect(existsSync(path.join(LOCAL, "jobs/translate.sh"))).toBe(true);
  });

  it("entrypoint explains the identical-path work-dir mount when it is missing", () => {
    // Path parity is the load-bearing trick of the whole design: paths under
    // the work dir serve as sibling-container -v sources, resolved by the
    // HOST daemon. The failure message must teach the fix.
    expect(entrypointSh).toMatch(/-v \\"\\\$HOME\/fp-canary:\\\$HOME\/fp-canary\\"/);
  });
});

describe("canary job (in-repo, evolves with the harness)", () => {
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

  it("states both jobs' refs uncommented (the runner refuses to start without one)", () => {
    expect(secretsExample).toMatch(/^CANARY_REF=\S+$/m);
    expect(secretsExample).toMatch(/^TRANSLATE_REF=\S+$/m);
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

describe("one image, several jobs", () => {
  it("validates the job name before it becomes a path component", () => {
    // $CANARY_JOB is interpolated into jobs/<job>.sh. Rejected, never
    // sanitised: a rewritten name silently runs a different job than the cron
    // line asked for.
    expect(entrypointSh).toMatch(/case "\$JOB" in\s*\n\s*\*\[!a-z0-9-\]\*/);
  });

  it("keys the lock, the clone and the log by job", () => {
    // A SHARED lock is the failure this design exists to avoid: a canary
    // wedged on a vendor CLI would swallow the night's translation, and the
    // swallow is a clean `exit 0` that reports nowhere. A shared CLONE is
    // worse — translate commits and switches branches in its checkout.
    expect(entrypointSh).toMatch(/exec 9>"\$CANARY_WORK\/\.lock-\$JOB"/);
    expect(entrypointSh).toMatch(/CLONE="\$CANARY_WORK\/clone-\$JOB"/);
    expect(entrypointSh).toMatch(/CANARY_LOG="\$CANARY_WORK\/logs\/\$JOB-\$TS\.log"/);
  });

  it("lists the jobs that exist when asked for one that does not", () => {
    expect(entrypointSh).toMatch(/no such job/);
    expect(entrypointSh).toMatch(/ls -1 "\$CLONE\/integration-suite\/local\/jobs\//);
  });

  it("cleans untracked files after checkout, but never ignored ones", () => {
    // `reset --hard` leaves last run's untracked output behind — for translate
    // that is pages whose English source has since been deleted, re-committed
    // forever. `-x` would take node_modules AND the symlinked translation
    // cache with it, which are exactly what must survive.
    expect(entrypointSh).toMatch(/git -C "\$CLONE" clean -fd\b/);
    expect(entrypointSh).not.toMatch(/git -C "\$CLONE" clean -fdx/);
  });

  it("prunes logs once, centrally, rather than per job", () => {
    expect(entrypointSh).toMatch(/find "\$CANARY_WORK\/logs" -name '\*\.log' -mtime \+14 -delete/);
    expect(dailySh).not.toMatch(/-mtime \+14 -delete/);
    expect(translateSh).not.toMatch(/-mtime \+14 -delete/);
  });
});

describe("translate-docs.yml is dispatch-only", () => {
  it("has no schedule trigger (the nightly run lives on the box)", () => {
    // Same cost decision as the integration suite. A schedule reappearing
    // here is a re-spend, so it must be a conversation.
    expect(translateWorkflow).not.toMatch(/^\s*schedule:/m);
    expect(translateWorkflow).not.toMatch(/\bcron:/);
  });

  it("keeps workflow_dispatch as the cloud fallback", () => {
    expect(translateWorkflow).toMatch(/^\s*workflow_dispatch:/m);
  });
});

describe("translate job", () => {
  it("checks every credential up front, together", () => {
    // Discovering a missing PAT at the push costs the whole translation pass
    // that preceded it.
    for (const v of [
      "TRANSLATE_LLM_API_KEY",
      "TRANSLATE_LLM_BASE_URL",
      "TRANSLATE_GITHUB_TOKEN",
    ]) {
      expect(translateSh, `translate.sh must require ${v}`).toContain(v);
    }
    expect(translateSh).toMatch(
      /for v in TRANSLATE_LLM_API_KEY TRANSLATE_LLM_BASE_URL TRANSLATE_GITHUB_TOKEN/,
    );
  });

  it("maps the box vars onto the names the translator actually reads", () => {
    expect(translateSh).toMatch(/export ANTHROPIC_API_KEY="\$TRANSLATE_LLM_API_KEY"/);
    expect(translateSh).toMatch(/export ANTHROPIC_BASE_URL="\$TRANSLATE_LLM_BASE_URL"/);
  });

  it("keeps the cache in the work dir, not the checkout", () => {
    // The checkout is reset --hard and clean -fd'd every run. A cache living
    // there would be a full 14-language re-translation every night.
    expect(translateSh).toMatch(
      /ln -sfn "\$CACHE_HOME\/\.translation-cache\.json"/,
    );
    expect(translateSh).toMatch(/CACHE_HOME="\$WORK\/translate"/);
  });

  it("reproduces CI's peak gateway concurrency, not cli.ts's per-process default", () => {
    // CI ran max-parallel 4 jobs x MAX_CONCURRENT 4 = 16 in flight. One
    // process at cli.ts's default of 4 would quietly be 4x slower.
    expect(translateSh).toMatch(/TRANSLATE_MAX_CONCURRENT:-16/);
  });

  it("runs both validators, and again after overlaying an open PR branch", () => {
    // The overlaid tree is neither what was validated before the switch nor
    // what the PR branch had — and it is what gets committed.
    expect(translateSh.match(/mintlify validate/g)?.length).toBeGreaterThanOrEqual(2);
    expect(translateSh.match(/bun run validate:mdx/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("pushes onto an already-open auto-translation PR instead of a second branch", () => {
    // Two open branches means the second run's cache says "done" for pages
    // only the first branch carries — the non-convergent deadlock, self-inflicted.
    expect(translateSh).toContain('PR_TITLE="[auto] update translations"');
    expect(translateSh).toMatch(/x\.title\s*===\s*process\.argv\[1\]/);
    expect(translateSh).toMatch(/git checkout -f -B "\$BRANCH" "origin\/\$BRANCH"/);
  });

  it("keeps the PAT out of the remote URL", () => {
    // git echoes the remote back on a push error, and the Slack crash-note
    // carries the log tail — a URL-embedded token would land in both.
    expect(translateSh).toMatch(/credential\.helper/);
    expect(translateSh).not.toMatch(/https:\/\/[^\s"]*\$TRANSLATE_GITHUB_TOKEN@/);
  });

  it("reports to Slack even when it changes nothing", () => {
    // Silence must mean "the box did not run", never "all was well" — there
    // is no red-job email out here.
    const noop = translateSh.slice(translateSh.indexOf("no changes — every language is current"));
    expect(noop.slice(0, 300)).toMatch(/slack_note/);
  });

  it("never claims success for a step it did not reach", () => {
    // Every failure path goes through die(), which names the step and posts.
    expect(translateSh).toMatch(/STEP="\$1"/);
    expect(translateSh.match(/\|\| die /g)?.length).toBeGreaterThanOrEqual(10);
  });
});

describe("installer schedules every job it validated", () => {
  it("gives each job its own cron marker", () => {
    // One shared marker means installing one job strips the other's line.
    expect(installSh).toMatch(/CRON_MARKER_BASE="# failproofai-canary"/);
    expect(installSh).toMatch(/marker="\$CRON_MARKER_BASE-\$j"/);
    expect(installSh).toMatch(/grep -vF "\$marker"/);
  });

  it("passes the job through to the container", () => {
    expect(installSh).toMatch(/-e CANARY_JOB=%s/);
  });

  it("checks credentials per job, for the jobs it is about to schedule", () => {
    // Installing only the canary must not demand a translation PAT.
    expect(installSh).toMatch(/REQUIRED_canary="/);
    expect(installSh).toMatch(/REQUIRED_translate="/);
    expect(installSh).toMatch(/eval "required=\\\$REQUIRED_\$j"/);
  });

  it("requires the webhook for both jobs", () => {
    const canaryReq = /REQUIRED_canary="([^"]+)"/.exec(installSh)![1];
    const translateReq = /REQUIRED_translate="([^"]+)"/.exec(installSh)![1];
    expect(canaryReq).toContain("CANARY_SLACK_WEBHOOK");
    expect(translateReq).toContain("CANARY_SLACK_WEBHOOK");
    expect(translateReq).toContain("TRANSLATE_GITHUB_TOKEN");
  });

  it("names the timezone cron will actually fire in", () => {
    // "02:00" read as UTC on an IST box is 07:30, and the person reading the
    // installer's output is the one who would be surprised.
    expect(installSh).toMatch(/TZ_NAME=/);
    expect(installSh).toMatch(/did "\$j — daily at .*\$TZ_NAME"/);
  });

  it("offers every box variable the two jobs require", () => {
    const required = [
      ...(/REQUIRED_canary="([^"]+)"/.exec(installSh)![1].split(" ")),
      ...(/REQUIRED_translate="([^"]+)"/.exec(installSh)![1].split(" ")),
    ];
    for (const v of required) {
      expect(secretsExample, `secrets.env.example is missing ${v}`).toContain(v);
    }
  });
});

describe("translate job failures are never silent", () => {
  it("prints the reason as well as posting it", () => {
    // Slack is for the person not watching; the console/log is for the one who
    // is. A run that fails with an empty console because no webhook happened
    // to be set is the silent-failure class this box exists to catch.
    const dieBody = translateSh.slice(
      translateSh.indexOf("die() {"),
      translateSh.indexOf("step() {"),
    );
    expect(dieBody).toMatch(/echo "✗ \$STEP: \$1" >&2/);
    expect(dieBody).toMatch(/slack_note/);
  });
});
