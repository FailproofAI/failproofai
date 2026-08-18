// @vitest-environment node
/**
 * `doctor`'s exit code is a contract the daemon's repair lane depends on, and
 * the lane can only act on the number. So the assertions here are mostly about
 * the codes: 0 clean or repaired, 1 findings remain, and 2 for "could not
 * check" — which must never collapse into 1, because on a headless box
 * "it is broken" and "I could not look" need different responses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorCommand } from "../../src/hooks/doctor-cli";
import { claudeCode } from "../../src/hooks/integrations";

let cwd: string;
let home: string;
let prevCwd: string;
const BINARY = "/usr/bin/failproofai";

function install(): string {
  const path = claudeCode.getSettingsPath("project", cwd);
  const settings = claudeCode.readSettings(path);
  claudeCode.writeHookEntries(settings, BINARY, "project");
  claudeCode.writeSettings(path, settings);
  return path;
}

/** Break it the way a vendor changing a field's type would. */
function makeStale(path: string): void {
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const groups = (settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)
    .PreToolUse;
  groups[0].hooks[0].timeout = "60s";
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

const text = (r: { lines: string[] }) => r.lines.join("\n");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fpai-doctor-"));
  home = mkdtempSync(join(tmpdir(), "fpai-doctor-home-"));
  prevCwd = process.cwd();
  process.chdir(cwd);
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_BINARY_OVERRIDE = BINARY;
});

afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_BINARY_OVERRIDE;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("doctor: exit codes", () => {
  it("exits 0 on a healthy machine", () => {
    install();
    const result = runDoctorCommand(["--project"]);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("Nothing to fix");
  });

  it("exits 0 when nothing is installed at all", () => {
    // Not installed is not broken. A machine that never set up must not look
    // like one whose enforcement fell over.
    const result = runDoctorCommand(["--project"]);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("no agent CLI has failproofai hooks installed");
  });

  it("exits 1 when a config has drifted", () => {
    makeStale(install());
    const result = runDoctorCommand(["--project"]);
    expect(result.exitCode).toBe(1);
    expect(text(result)).toContain("DRIFTED");
    expect(text(result)).toContain("doctor --fix");
  });

  it("exits 1 for a file it cannot read, and says a human is needed", () => {
    const path = install();
    writeFileSync(path, "{ not json at all");
    const result = runDoctorCommand(["--project"]);
    expect(result.exitCode).toBe(1);
    expect(text(result)).toContain("UNREADABLE");
    expect(text(result)).toContain("needs a human");
  });

  it("exits 2 — not 1 — on an argument it does not understand", () => {
    const result = runDoctorCommand(["--wat"]);
    expect(result.exitCode).toBe(2);
    expect(text(result)).toContain("Unexpected argument");
  });
});

describe("doctor --fix", () => {
  it("repairs, then reports the machine as it is NOW", () => {
    const path = install();
    makeStale(path);
    expect(runDoctorCommand(["--project"]).exitCode).toBe(1);

    const fixed = runDoctorCommand(["--project", "--fix"]);
    expect(fixed.exitCode).toBe(0);
    expect(text(fixed)).toContain("REPAIRED");
    // The verdict must come from a re-read, not from the pre-repair scan.
    expect(text(fixed)).toContain("Nothing to fix");
    expect(runDoctorCommand(["--project"]).exitCode).toBe(0);
  });

  it("does not suggest --fix when it has already run", () => {
    const path = install();
    writeFileSync(path, "{ not json at all");
    const result = runDoctorCommand(["--project", "--fix"]);
    expect(result.exitCode).toBe(1);
    expect(text(result)).not.toContain("doctor --fix");
  });
});

describe("doctor: output shapes", () => {
  it("emits parseable JSON carrying reports, repairs and findings", () => {
    makeStale(install());
    const result = runDoctorCommand(["--project", "--json"]);
    const parsed = JSON.parse(text(result)) as {
      reports: unknown[];
      repairs: unknown[];
      findings: unknown[];
    };
    expect(Array.isArray(parsed.reports)).toBe(true);
    expect(parsed.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it("keeps the scheduled form to one line when there is nothing to say", () => {
    // This lands in a daemon log every tick. A ten-line table each time is how
    // a log stops being read.
    install();
    const result = runDoctorCommand(["--project", "--scheduled"]);
    expect(result.exitCode).toBe(0);
    expect(result.lines.filter((l) => l.trim().length > 0)).toHaveLength(1);
    expect(text(result)).toContain("nothing to repair");
  });

  it("still reports the detail when scheduled and something is wrong", () => {
    makeStale(install());
    const result = runDoctorCommand(["--project", "--scheduled", "--fix"]);
    expect(result.exitCode).toBe(0);
    expect(text(result)).toContain("REPAIRED");
  });

  it("hides the CLIs that are simply not installed", () => {
    install();
    const result = runDoctorCommand(["--project"]);
    // A machine has twelve integrations and most people install one or two.
    expect(text(result)).not.toContain("not installed here");
    expect(text(result)).toContain("claude");
  });
});

describe("doctor: project scope from recent activity", () => {
  /** Write a hook-activity row so the sweep has a cwd to find. */
  function recordActivity(dir: string): void {
    const activityDir = join(home, "hook-activity");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(
      join(activityDir, "current.jsonl"),
      JSON.stringify({
        timestamp: Date.now(),
        eventType: "PreToolUse",
        integration: "claude",
        decision: "allow",
        cwd: dir,
      }) + "\n",
    );
  }

  it("finds a drifted project config in a directory it was never given", () => {
    // The daemon has no session cwd, so this is the only way project scope is
    // reachable from a scheduled run: every recorded hook event carries the
    // directory it fired in.
    const path = install();
    makeStale(path);
    recordActivity(cwd);

    // Deliberately run from somewhere else — the sweep must not depend on the
    // process happening to sit in the right directory.
    process.chdir(home);
    const result = runDoctorCommand([]);
    expect(result.exitCode).toBe(1);
    expect(text(result)).toContain("DRIFTED");
    expect(text(result)).toContain(path);
  });

  it("repairs it, still without being told where it is", () => {
    const path = install();
    makeStale(path);
    recordActivity(cwd);
    process.chdir(home);

    const fixed = runDoctorCommand(["--fix"]);
    expect(fixed.exitCode).toBe(0);
    expect(text(fixed)).toContain("REPAIRED");
  });

  it("ignores a recorded directory that no longer exists", () => {
    // Deleted checkouts and dead containers are normal. Repairing a path that
    // is gone would create directories nobody asked for.
    recordActivity(join(home, "long-since-deleted"));
    const result = runDoctorCommand([]);
    expect(result.exitCode).toBe(0);
  });

  it("does not sweep when a scope was named explicitly", () => {
    const path = install();
    makeStale(path);
    recordActivity(cwd);
    process.chdir(home);

    // --user means user scope and nothing else, so the drifted project config
    // must not appear.
    const result = runDoctorCommand(["--user"]);
    expect(text(result)).not.toContain(path);
    expect(result.exitCode).toBe(0);
  });
});

describe("doctor: the two collisions the sweep can create", () => {
  function recordCwds(...dirs: string[]): void {
    const activityDir = join(home, "hook-activity");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(
      join(activityDir, "current.jsonl"),
      dirs
        .map((cwd) =>
          JSON.stringify({
            timestamp: Date.now(),
            eventType: "PreToolUse",
            integration: "claude",
            decision: "allow",
            cwd,
          }),
        )
        .join("\n") + "\n",
    );
  }

  it("never treats HOME as a project", () => {
    // Project scope inside HOME resolves to the very files USER scope owns, and
    // the two disagree by design — project installs the portable `npx` form,
    // user an absolute path. Repairing the project view of
    // `~/.claude/settings.json` would rewrite a working user install.
    const fakeHome = mkdtempSync(join(tmpdir(), "fpai-fakehome-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      recordCwds(fakeHome);
      const result = runDoctorCommand(["--json"]);
      const parsed = JSON.parse(text(result)) as { reports: { scope: string }[] };
      expect(parsed.reports.some((r) => r.scope === "project")).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("reports one verdict per file, even when two targets resolve to it", () => {
    // Nested checkouts reach the same settings file twice, and a file inspected
    // under two scopes can legitimately disagree. Reporting both is confusing;
    // acting on both is worse.
    install();
    recordCwds(cwd, cwd);
    const result = runDoctorCommand(["--json"]);
    const parsed = JSON.parse(text(result)) as { reports: { settingsPath: string }[] };
    const paths = parsed.reports.map((r) => r.settingsPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
