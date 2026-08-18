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
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorCommand, runDoctorCommandAsync } from "../../src/hooks/doctor-cli";
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

describe("doctor: what the CLIs are sending", () => {
  /** Write an observation table the way the warm worker would have. */
  function observe(clis: Record<string, unknown>): void {
    mkdirSync(join(home, "contracts"), { recursive: true });
    writeFileSync(
      join(home, "contracts", "observed.json"),
      JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), clis }),
    );
  }

  const HEALTHY = {
    goose: {
      version: "1.43.0",
      hooks: { PreToolUse: { envelope: ["event"], tools: { write: ["content", "path"] } } },
    },
  };

  it("says nothing when there is no table, which is every fresh install", () => {
    // The table only exists once a daemon-configured machine has handled a
    // hook. Absent must not read as broken, and must never be why doctor fails.
    const r = runDoctorCommand(["--user"]);
    expect(text(r)).not.toContain("Payload translation");
    expect(r.exitCode).toBe(0);
  });

  it("stays quiet and clean for a CLI whose payloads we can still read", () => {
    observe(HEALTHY);
    const r = runDoctorCommand(["--user"]);
    expect(text(r)).toContain("every key we read is still where we expect it");
    expect(r.exitCode).toBe(0);
  });

  it("fails the run when a key our policies read is no longer derivable", () => {
    observe({
      copilot: {
        version: "1.0.94",
        hooks: { PreToolUse: { envelope: [], tools: { read: ["uri"] } } },
      },
    });
    const r = runDoctorCommand(["--user"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("block-env-files");
    // The remedy is different from every other line doctor prints, and saying
    // so is what stops this reading as "--fix is broken".
    expect(text(r)).toContain("they need a failproofai update");
  });

  it("reports a suspected tool rename but does not fail the run on it", () => {
    // Provable findings fail the run. This one is a heuristic — right in a lab
    // that chose the prompt, wrong on a machine carrying a custom tool that
    // happens to take a `path`. Shown, because a human can tell; not fatal,
    // because we cannot.
    observe({
      factory: {
        version: "0.180.0",
        hooks: { PreToolUse: { envelope: [], tools: { Run: ["command"] } } },
      },
    });
    const r = runDoctorCommand(["--user"]);
    expect(text(r)).toContain("likely renamed");
    expect(r.exitCode).toBe(0);
  });

  it("does not let an unreadable table stop the config check", () => {
    mkdirSync(join(home, "contracts"), { recursive: true });
    writeFileSync(join(home, "contracts", "observed.json"), "{ not json");
    const r = runDoctorCommand(["--user"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).not.toContain("Payload translation");
  });

  it("carries the comparison in --json for anything consuming it", () => {
    observe(HEALTHY);
    const parsed = JSON.parse(text(runDoctorCommand(["--user", "--json"]))) as {
      contracts: { cli: string; version?: string }[];
    };
    expect(parsed.contracts.map((c) => c.cli)).toEqual(["goose"]);
    expect(parsed.contracts[0].version).toBe("1.43.0");
  });

  it("gives the scheduled lane one line, and only when there is something to say", () => {
    observe(HEALTHY);
    expect(text(runDoctorCommand(["--user", "--scheduled"]))).not.toContain("payload-translation");
    observe({
      copilot: { hooks: { PreToolUse: { envelope: [], tools: { read: ["uri"] } } } },
    });
    expect(text(runDoctorCommand(["--user", "--scheduled"]))).toContain(
      "payload-translation finding(s)",
    );
  });
});

describe("doctor: what the lab saw that this machine has not", () => {
  function write(name: string, body: unknown): void {
    mkdirSync(join(home, "contracts"), { recursive: true });
    writeFileSync(join(home, "contracts", name), JSON.stringify(body));
  }

  /** This machine only ever wrote files, so it has no Read shape recorded. */
  const LOCAL = {
    schemaVersion: 1,
    clis: {
      goose: {
        version: "1.43.0",
        hooks: { PreToolUse: { envelope: ["event"], tools: { write: ["content", "path"] } } },
      },
    },
  };

  it("warns about a key this machine has not exercised yet", () => {
    // The whole reason the pack exists. The local table is bounded by what the
    // machine happened to do; a renamed Read key is invisible here until the
    // day an agent reads a file, which is the day it stops being caught.
    write("observed.json", LOCAL);
    write("pack.json", {
      generatedAt: "2026-08-18T06:00:00Z",
      clis: {
        goose: {
          version: "1.44.0",
          hooks: { PreToolUse: { envelope: [], tools: { view: ["uri"] } } },
        },
      },
    });
    const r = runDoctorCommand(["--user"]);
    expect(text(r)).toContain("Seen by the contracts lab");
    expect(text(r)).toContain("view arrives as [uri]");
    // Not exit-worthy: the lab may have driven a newer vendor version than this
    // machine runs, so it is a warning about an upgrade, not a claim about now.
    expect(r.exitCode).toBe(0);
  });

  it("says nothing about CLIs this machine does not use", () => {
    // Twelve integrations, most people run two. Reporting the other ten is how
    // the lines that matter get skipped.
    write("observed.json", LOCAL);
    write("pack.json", {
      clis: {
        devin: { version: "3000.4.0", hooks: { PreToolUse: { envelope: [], tools: { exec: ["cmdline"] } } } },
      },
    });
    expect(text(runDoctorCommand(["--user"]))).not.toContain("Seen by the contracts lab");
  });

  it("says nothing when there is no pack, which is every machine today", () => {
    write("observed.json", LOCAL);
    expect(text(runDoctorCommand(["--user"]))).not.toContain("Seen by the contracts lab");
  });

  it("is not derailed by a pack that is not a pack", () => {
    write("observed.json", LOCAL);
    writeFileSync(join(home, "contracts", "pack.json"), "{ truncated");
    const r = runDoctorCommand(["--user"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).not.toContain("Seen by the contracts lab");
  });

  it("accepts --refresh without treating it as an unknown argument", () => {
    // The async front door consumes it; the parser must still know it, or the
    // scheduled lane's own flag would make doctor exit 2.
    write("observed.json", LOCAL);
    expect(runDoctorCommand(["--user", "--refresh"]).exitCode).toBe(0);
  });
});

describe("doctor --corroborate: the promotion gate", () => {
  // The pack is SERVED, not seeded on disk. --corroborate now refuses to judge
  // a pack it could not fetch, because the cache survives both a failed refresh
  // and a change of channel — so a machine that once looked at the internal
  // pack would otherwise keep corroborating against it forever. Writing the
  // fixture straight into the cache would test a path the gate no longer takes.
  let server: Server;
  let respond: (send: (status: number, body: string) => void) => void;

  beforeEach(async () => {
    respond = (send) => send(404, "not found");
    server = createServer((_req, res) => {
      respond((status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.FAILPROOFAI_CONTRACTS_URL = `http://127.0.0.1:${port}/pack.json`;
  });

  afterEach(async () => {
    delete process.env.FAILPROOFAI_CONTRACTS_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const goose = (version: string, keys: string[]) => ({
    clis: {
      goose: { version, hooks: { PreToolUse: { envelope: [], tools: { write: keys } } } },
    },
  });

  /** The lab's pack comes over the wire; this machine's observations from disk. */
  function seed(pack: unknown, local: unknown): void {
    respond = (send) => send(200, JSON.stringify(pack));
    mkdirSync(join(home, "contracts"), { recursive: true });
    writeFileSync(join(home, "contracts", "observed.json"), JSON.stringify(local));
  }

  it("exits 0 when this machine saw what the lab saw", async () => {
    seed(goose("1.43.0", ["content", "path"]), goose("1.43.0", ["content", "path"]));
    const r = await runDoctorCommandAsync(["--corroborate"]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toContain("corroborated");
  });

  it("exits 1 and names the disagreement", async () => {
    seed(goose("1.43.0", ["content", "uri"]), goose("1.43.0", ["content", "path"]));
    const r = await runDoctorCommandAsync(["--corroborate"]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain("do not lead to the same finding");
  });

  it("exits 2 rather than 0 when nothing was comparable", async () => {
    // The load-bearing choice. Promotion must require evidence, and a machine
    // that could not check has supplied none — returning 0 here would make the
    // gate decorative while looking like it passed.
    seed(goose("1.44.0", ["content", "path"]), goose("1.43.0", ["content", "path"]));
    const r = await runDoctorCommandAsync(["--corroborate"]);
    expect(r.exitCode).toBe(2);
    expect(text(r)).toContain("no overlap");
    // And it must say WHY, or "no overlap" is unactionable.
    expect(text(r)).toContain("lab drove 1.44.0");
  });

  it("refuses to judge a pack it could not fetch, even with one cached", async () => {
    // The failure this exists for: the cache outlives a failed refresh AND a
    // change of channel, so without this a GitHub blip lets the gate pass on
    // yesterday's copy — while the pull request it opens is built from the
    // branch as it is now.
    seed(goose("1.43.0", ["content", "path"]), goose("1.43.0", ["content", "path"]));
    expect((await runDoctorCommandAsync(["--corroborate"])).exitCode).toBe(0);

    respond = (send) => send(503, "down");
    const r = await runDoctorCommandAsync(["--corroborate"]);
    expect(r.exitCode).toBe(2);
    expect(text(r)).toContain("refusing to judge a stale one");
  });

  it("exits 2 when this machine has no observations of its own", async () => {
    respond = (send) => send(200, JSON.stringify(goose("1.43.0", ["content", "path"])));
    const r = await runDoctorCommandAsync(["--corroborate"]);
    expect(r.exitCode).toBe(2);
    expect(text(r)).toContain("cannot corroborate");
  });

  it("answers only that question, with none of the config report", async () => {
    // It drives a different decision for a different reader; burying a one-line
    // verdict under a config report would make it unusable in a script.
    seed(goose("1.43.0", ["content", "path"]), goose("1.43.0", ["content", "path"]));
    const out = text(await runDoctorCommandAsync(["--corroborate"]));
    expect(out).not.toContain("hook configs on this machine");
    expect(out).not.toContain("Payload translation");
  });
});
