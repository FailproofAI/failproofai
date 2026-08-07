/**
 * Tripwires for the LOCAL canary runner (integration-suite/local/) and the
 * daemon-mode (CANARY_DAEMON) probe path.
 *
 * Daily integration-suite runs moved off GH Actions onto a local box
 * (2026-08-07, for runner-minute cost); the stable leg there probes the
 * daemon-configured (failproofaid) hook path — the way-forward configuration.
 * Everything below is shell scripts and systemd units with no importable
 * surface, so the tests parse the real files — same approach as
 * channel-refs.test.ts, and for the same reason: the alternative is a second
 * copy of each contract to drift against.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../..");
const SUITE = path.join(ROOT, "integration-suite");
const LOCAL = path.join(SUITE, "local");
const runLocal = readFileSync(path.join(LOCAL, "run-local.sh"), "utf8");
const installSh = readFileSync(path.join(LOCAL, "install.sh"), "utf8");
const service = readFileSync(path.join(LOCAL, "failproofai-canary.service"), "utf8");
const timer = readFileSync(path.join(LOCAL, "failproofai-canary.timer"), "utf8");
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

describe("local runner wiring", () => {
  it("service ExecStart points at the exact path install.sh installs to", () => {
    // run-local.sh hard-resets the runner clone, so the unit must exec the
    // INSTALLED copy — a unit pointing into the clone would run whatever the
    // checked-out ref happens to carry, mid-reset.
    const m = /^ExecStart=%h\/(\S+)$/m.exec(service);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(".config/failproofai-canary/bin/run-local.sh");
    expect(installSh).toContain("CANARY_CONF_DIR:-$HOME/.config/failproofai-canary");
    expect(installSh).toMatch(
      /install -m 755 "\$HERE\/run-local\.sh" "\$CONF_DIR\/bin\/run-local\.sh"/,
    );
  });

  it("install.sh installs both systemd units", () => {
    expect(installSh).toContain("failproofai-canary.service");
    expect(installSh).toContain("failproofai-canary.timer");
  });

  it("timer keeps the retired GHA cron slot and catches up after downtime", () => {
    expect(timer).toMatch(/OnCalendar=.*06:17.*UTC/);
    expect(timer).toMatch(/^Persistent=true$/m);
  });

  it("run-local.sh drives the same front door CI does", () => {
    expect(runLocal).toContain("integration-suite/ci-entrypoint.sh");
  });

  it("refuses to run without an explicit CANARY_REF", () => {
    // A baked-in default ref would silently keep probing a stale branch after
    // the daemon branch merges to main — every box states what it tests.
    expect(runLocal).toMatch(/\$\{CANARY_REF:\?/);
  });

  it("stable leg defaults to the daemon path, beta to in-process", () => {
    expect(runLocal).toContain("${CANARY_DAEMON_STABLE:-1}");
    expect(runLocal).toContain("${CANARY_DAEMON_BETA:-0}");
  });

  it("secrets template offers every secret-fed env var the workflow maps", () => {
    // The box's secrets.env and the GHA Environment must stay interchangeable.
    // A secret added to the workflow but not the template means the box runs
    // without it and that CLI quietly reports ERROR forever.
    const envNames = [...workflow.matchAll(/^\s+([A-Z0-9_]+):\s+\$\{\{\s*secrets\./gm)].map(
      (m) => m[1],
    );
    expect(envNames.length).toBeGreaterThanOrEqual(10);
    for (const name of envNames) {
      expect(installSh, `secrets.env template is missing ${name}`).toContain(name);
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

  it("a dead daemon cannot false-PASS either probe", () => {
    // bin/failproofai.mjs shapes an unreachable-daemon deny through a
    // synthetic policy (see handler.ts's forceDecision branch). Its oracle
    // line must NEVER satisfy the probes' deny greps — otherwise a crashed
    // daemon reads as healthy enforcement, the exact inversion this suite
    // exists to catch. Both sides are extracted from the real sources so a
    // rename on either side trips this test.
    const idMatch = /registerPolicy\(\s*"(failproofai\/[a-z-]+)",\s*"Fail-closed/.exec(handlerTs);
    expect(idMatch).not.toBeNull();
    // handler.ts:463 — `result=${decision} policy=${policyName} duration=…`
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
