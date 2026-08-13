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
const docsAuditSh = readFileSync(path.join(LOCAL, "jobs/docs-audit.sh"), "utf8");
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
    expect(existsSync(path.join(LOCAL, "jobs/docs-audit.sh"))).toBe(true);
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

  it("posts nothing to Slack — the pull request is the report", () => {
    expect(translateSh).not.toMatch(/slack_note|CANARY_SLACK_WEBHOOK/);
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
    expect(installSh).toMatch(/eval "required=\\\$REQUIRED_\$\(vn "\$j"\)"/);
  });

  it("requires the webhook for the jobs whose only output IS the report", () => {
    // canary and docs-audit report to Slack and nowhere else, so a missing
    // webhook makes them look like coverage while producing none. translate is
    // the exception: it opens a pull request, which says everything a chat
    // message would.
    for (const j of ["canary", "docs_audit"]) {
      const req = new RegExp(`REQUIRED_${j}="([^"]+)"`).exec(installSh)![1];
      expect(req, `${j} must require the webhook`).toContain("CANARY_SLACK_WEBHOOK");
    }
    const translateReq = /REQUIRED_translate="([^"]+)"/.exec(installSh)![1];
    expect(translateReq).toContain("TRANSLATE_GITHUB_TOKEN");
    expect(translateReq).not.toContain("CANARY_SLACK_WEBHOOK");
  });

  it("names the timezone cron will actually fire in", () => {
    // "02:00" read as UTC on an IST box is 07:30, and the person reading the
    // installer's output is the one who would be surprised.
    expect(installSh).toMatch(/TZ_NAME=/);
    expect(installSh).toMatch(/did "\$j — \$\(describe_cron "\$at"\) \$TZ_NAME"/);
  });

  it("offers every box variable the jobs require", () => {
    const required = ["canary", "translate", "docs_audit"].flatMap(
      (j) => new RegExp(`REQUIRED_${j}="([^"]+)"`).exec(installSh)![1].split(" "),
    );
    for (const v of required) {
      expect(secretsExample, `secrets.env.example is missing ${v}`).toContain(v);
    }
  });
});

describe("translate job failures are never silent", () => {
  it("names the step it died at, in the run log", () => {
    // This job posts nowhere, so the log and the exit code ARE the report —
    // which makes the printing here load-bearing rather than a convenience.
    // An earlier cut posted and did not print, and a run with no webhook set
    // failed to a completely empty console.
    const dieBody = translateSh.slice(
      translateSh.indexOf("die() {"),
      translateSh.indexOf("step() {"),
    );
    expect(dieBody).toMatch(/echo "✗ \$STEP: \$1" >&2/);
    expect(dieBody).toMatch(/exit 1/);
  });
});

describe("docs-audit job", () => {
  it("never grows a gateway key or write access to the repo", () => {
    // This job READS the tree and git history. It may hold an issues-only token
    // for its tracking issue, and nothing heavier: no gateway key (it calls no
    // model) and no Contents/Pull-requests scope (it changes no file). If that
    // ever changes it is a different job with a different risk profile, and
    // this test is where it gets noticed.
    const required = /REQUIRED_docs_audit="([^"]+)"/.exec(installSh)![1].split(" ").sort();
    expect(required).toEqual([
      "CANARY_SLACK_WEBHOOK",
      "DOCS_AUDIT_GITHUB_TOKEN",
      "DOCS_AUDIT_REF",
    ]);
    expect(docsAuditSh).not.toMatch(/TRANSLATE_GITHUB_TOKEN|LLM_API_KEY|ANTHROPIC_/);
    expect(docsAuditSh).not.toMatch(/git (push|commit|checkout -b)/);
  });

  it("defaults to weekly, which needs a five-field cron expression", () => {
    expect(installSh).toMatch(/AT_docs_audit="0 4 \* \* 1"/);
  });

  it("reads the same translation cache the nightly job writes", () => {
    // Without the link every page reads as never-translated every week — a
    // 672-line finding that is an artefact of where the file lives.
    expect(docsAuditSh).toMatch(/CACHE_HOME="\$WORK\/translate"/);
    expect(docsAuditSh).toMatch(/ln -sfn "\$CACHE_HOME\/\.translation-cache\.json"/);
  });

  it("delegates the analysis to the unit-tested script", () => {
    // The shell is box wiring; the judgement lives in TypeScript where it can
    // be tested without a repo, a docs tree or a clock.
    expect(docsAuditSh).toMatch(/bun run docs:audit/);
    expect(existsSync(path.join(ROOT, "scripts/docs-audit.ts"))).toBe(true);
  });

  it("posts what it found, and says so when it cannot post", () => {
    expect(docsAuditSh).toMatch(/slack_note "\$REPORT"/);
    expect(docsAuditSh).toMatch(/no webhook set/);
  });
});

describe("per-job variable lookup survives a dashed job name", () => {
  it("converts the name once, in one place", () => {
    // `docs-audit` is a valid path component and an invalid shell variable
    // name. Every per-job lookup goes through vn() rather than each site
    // remembering — AT_docs-audit would expand to nothing and schedule the
    // job at whatever `normalize_cron ""` did next.
    expect(installSh).toMatch(/vn\(\) \{ printf '%s' "\$\{1\/\/-\/_\}"; \}/);
    expect(installSh).toMatch(/eval "required=\\\$REQUIRED_\$\(vn "\$j"\)"/);
    expect(installSh).toMatch(/eval "at=\\\$AT_\$\(vn "\$j"\)"/);
  });

  it("derives the ref var the same way the entrypoint does", () => {
    // entrypoint: tr 'a-z-' 'A-Z_' turns docs-audit into DOCS_AUDIT_REF, which
    // is the name the env template must carry.
    expect(entrypointSh).toMatch(/tr 'a-z-' 'A-Z_'/);
    expect(secretsExample).toMatch(/^DOCS_AUDIT_REF=\S+$/m);
  });
});

describe("the GitHub API host is overridable", () => {
  it("defaults to api.github.com and can be pointed elsewhere", () => {
    // GHES needs this, and it is what let the publish path be proven
    // end-to-end against a stand-in API without opening real pull requests.
    // A hardcoded host would make that verification impossible, which is how
    // a publish path ends up shipped never having been run.
    expect(translateSh).toMatch(
      /\$\{TRANSLATE_API_BASE:-https:\/\/api\.github\.com\}\/repos\/\$REPO\$path/,
    );
  });
});

describe("an open PR whose branch is gone", () => {
  it("tells a missing branch apart from an unreachable remote", () => {
    // Found by running the job, not by reading it. Dying on a missing branch
    // dies again every night, because the branch never comes back. But falling
    // through to a NEW branch on an unreachable remote would open a second PR
    // on a transient network error — and two open auto-translation PRs is what
    // reusing one exists to prevent, since the next run picks one and the pages
    // only the other carries read as cached-but-absent forever.
    const block = translateSh.slice(
      translateSh.indexOf('if [ -n "$EXISTING" ]'),
      translateSh.indexOf('if [ -n "$PR_NUMBER" ]'),
    );
    expect(block).toMatch(/git ls-remote --heads origin "\$BRANCH"/);
    // unreachable -> die; genuinely absent -> fresh branch
    expect(block).toMatch(/\[ "\$ls_rc" -ne 0 \][\s\S]*?die /);
    expect(block).toMatch(/elif \[ -z "\$remote_refs" \][\s\S]*?PR_NUMBER=""/);
  });

  it("creates the fresh branch in exactly one place", () => {
    // The recovery path and the no-PR path must not BOTH run `checkout -b`, or
    // the second fails on a branch that already exists.
    expect(translateSh.match(/git checkout -b "\$BRANCH"/g)).toHaveLength(1);
  });

  it("says so on stderr rather than silently opening a second PR", () => {
    expect(translateSh).toMatch(/no longer exists —/);
    expect(translateSh).toMatch(/close the stale one at \$REPO\/pull\/\$PR_NUMBER/);
  });
});

describe("a job's ref must still exist on the remote", () => {
  it("asks the remote rather than matching one known-stale branch name", () => {
    // Checking the NAME against `origin/failproofaid` only ever caught that one
    // branch. A merged-and-deleted feature branch sailed through — which is
    // exactly what was sitting in a real secrets.env: CANARY_REF pointed at
    // origin/feat/canary-local-runner, so the box would have tested a frozen
    // tree forever and never said so.
    expect(installSh).toMatch(/git ls-remote --heads "\$GIT_URL" "\$branch"/);
    expect(installSh).toMatch(/does not exist on the remote/);
    expect(installSh).not.toMatch(/origin\/failproofaid\)/);
  });

  it("warns, without refusing, when a ref is not main", () => {
    // Legitimate for a one-off; rarely right for a cron line.
    expect(installSh).toMatch(/not origin\/main — deliberate for a one-off/);
  });
});

describe("the missing-credentials message", () => {
  it("explains the webhook only when the webhook is what is missing", () => {
    // translate deliberately needs no webhook — it reports by opening a pull
    // request. Printing the webhook rationale under a list that does not
    // contain it reads as though the job wants one it does not.
    expect(installSh).toMatch(/case " \$missing " in \*" CANARY_SLACK_WEBHOOK "\*\)/);
    expect(installSh).toMatch(/die "the \$j job needs these[^"]*\$missing\$why/);
  });
});

describe("probe B tells a route-around apart from a silent-allow", () => {
  const policies = readFileSync(path.join(SUITE, "canary-policies.mjs"), "utf8");

  it("only fires the shell detector inside the READ probe", () => {
    // probe-cli.sh points FAILPROOFAI_HOOK_LOG_FILE at log-bash / log-read per
    // probe. Firing during probe A would deny `touch CANARY_PROBE_ran` under
    // the wrong policy name, keeping canary-bash out of the hook log and
    // turning probe A inconclusive while looking like a fix.
    expect(policies).toMatch(/endsWith\("log-read"\)/);
    expect(policies).toMatch(/if \(!inReadProbe\(\)\) return allow\(\);/);
  });

  it("leaves navigation alone so CLIs that locate before reading still pass", () => {
    // Denying `ls`/`pwd` would push currently-green CLIs into INCONCLUSIVE.
    expect(policies).toMatch(/READ_UTIL\.test\(cmd\)/);
    const readUtil = /const READ_UTIL = (\/.*\/);/.exec(policies)![1];
    const re = new RegExp(readUtil.slice(1, readUtil.lastIndexOf("/")));
    expect(re.test("ls -la")).toBe(false);
    expect(re.test("pwd && ls -la")).toBe(false);
    expect(re.test("find . -type f -exec cat {} +")).toBe(true);
    expect(re.test("grep -r . .")).toBe(true);
  });

  it("keeps the shell deny out of read_denied, so it can never score a PASS", () => {
    // The trailing space is the whole mechanism: without it `canary-read` also
    // matches the `canary-read-shell` line, and probe B goes green on a run
    // where the READ tool was never exercised.
    expect(probeSh).toMatch(
      /read_denied\(\) \{ grep -qE "result=deny policy=\(failproofai\/\|custom\/\)\?\(canary-read\|block-read-outside-cwd\) "/,
    );
    expect(probeSh).toMatch(/shell_route_attempted\(\) \{ grep -q "result=deny policy=custom\/canary-read-shell "/);
  });

  it("downgrades a leak to INCONCLUSIVE only when the shell was being denied", () => {
    // A leak with NO shell attempt stays FAIL — that is what a CLI ignoring our
    // deny looks like (copilot 1.0.70), and blurring the two would blind this
    // suite to the silent-allow it exists to catch.
    expect(probeSh).toMatch(
      /if shell_route_attempted "\$LOGB\/hooks\.log"; then VB=INCONCLUSIVE; else VB=FAIL; fi/,
    );
  });
});

describe("docs-audit tracking issue", () => {
  it("keeps an ISSUE, not a PR — and says why", () => {
    // A report is not a change: a weekly PR would sit open forever or auto-merge
    // a file nobody reads. And a FIXING PR has almost nothing safe to put in it,
    // since every finding needs a judgement this job cannot make.
    expect(docsAuditSh).toMatch(/ISSUE_TITLE="\[auto\] docs audit"/);
    expect(docsAuditSh).toMatch(/api POST \/issues/);
    expect(docsAuditSh).not.toMatch(/\/pulls/);
    expect(docsAuditSh).not.toMatch(/git (push|commit|checkout)/);
  });

  it("filters pull requests out of the /issues listing", () => {
    // Every PR is an issue to that endpoint. Without the filter, an open PR
    // sharing the title would be updated instead of the tracking issue.
    expect(docsAuditSh).toMatch(/!x\.pull_request/);
  });

  it("closes the issue on a clean week and opens one only when there is work", () => {
    // An open issue must always mean "there is something to do", never "this
    // ran once, months ago".
    expect(docsAuditSh).toMatch(/api PATCH "\/issues\/\$EXISTING" '\{"state":"closed"\}'/);
    expect(docsAuditSh).toMatch(/if \[ "\$COUNT" -gt 0 \]/);
  });

  it("still runs, and still reports to Slack, with no token", () => {
    // The issue is a SECOND channel, not a replacement. A box that never got a
    // token must degrade to what it did before, not fail.
    expect(docsAuditSh).toMatch(/if \[ -z "\$\{DOCS_AUDIT_GITHUB_TOKEN:-\}" \]/);
    const gate = docsAuditSh.slice(docsAuditSh.indexOf('if [ -z "${DOCS_AUDIT_GITHUB_TOKEN'));
    expect(gate.slice(0, 260)).toMatch(/exit 0/);
    expect(docsAuditSh.indexOf("slack_note \"$REPORT\"")).toBeLessThan(
      docsAuditSh.indexOf("DOCS_AUDIT_GITHUB_TOKEN:-"),
    );
  });

  it("asks for an issues-only token, never Contents or Pull requests", () => {
    // The audit never changes a file, so a stronger token would be scope it
    // cannot justify holding on someone's machine.
    expect(secretsExample).toMatch(/DOCS_AUDIT_GITHUB_TOKEN=/);
    expect(secretsExample).toMatch(/Issues: read\+write\. That is\s*\n# ALL it needs/);
    const required = /REQUIRED_docs_audit="([^"]+)"/.exec(installSh)![1].split(" ");
    expect(required).toContain("DOCS_AUDIT_GITHUB_TOKEN");
    expect(required).not.toContain("TRANSLATE_GITHUB_TOKEN");
  });
});

describe("installer works from a clone as well as from curl", () => {
  it("builds from the checkout when run inside one", () => {
    // `git clone` then `bash integration-suite/local/install.sh` needs no
    // network for the build, and guarantees the image matches the tree the
    // operator is looking at — building from the git URL there could hand them
    // an image from a DIFFERENT commit while both printed the same branch name.
    expect(installSh).toMatch(/HERE="\$\(cd "\$\(dirname "\$0"\)"/);
    expect(installSh).toMatch(/\[ -f "\$HERE\/Dockerfile\.runner" \]/);
    expect(installSh).toMatch(/docker build -t "\$IMAGE" -f "\$HERE\/Dockerfile\.runner" "\$HERE"/);
  });

  it("still falls back to the git URL for the curl one-liner", () => {
    // There is no checkout on that path, so the context has to be remote.
    expect(installSh).toMatch(/"\$GIT_URL#\$BUILD_REF:integration-suite\/local"/);
  });

  it("schedules every job by default", () => {
    // One command, three cron lines. --jobs narrows it; nothing widens it.
    expect(installSh).toMatch(/ALL_JOBS="canary translate docs-audit"/);
    expect(installSh).toMatch(/JOBS="\$ALL_JOBS"/);
  });
});
