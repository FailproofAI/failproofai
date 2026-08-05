import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { version as cliVersion } from "../../package.json";
import { binDir, versionFile } from "../../src/hooks/fp-home";
import { writeVersionFile, readVersionFile, readConfig } from "../../src/hooks/fp-config";
import { daemonVersionSkew } from "../../src/hooks/daemon-service";
import { pruneOldDaemonBinaries } from "../../src/hooks/daemon-download";

let home: string;
let prevHome: string | undefined;
let prevBinary: string | undefined;
let prevRoot: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  prevBinary = process.env.FAILPROOFAI_DAEMON_BINARY;
  prevRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  delete process.env.FAILPROOFAI_DAEMON_BINARY;
  delete process.env.FAILPROOFAI_PACKAGE_ROOT;
  home = mkdtempSync(resolve(tmpdir(), "fpai-skew-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  for (const [k, v] of [
    ["FAILPROOFAI_HOME", prevHome],
    ["FAILPROOFAI_DAEMON_BINARY", prevBinary],
    ["FAILPROOFAI_PACKAGE_ROOT", prevRoot],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A managed install of `ver`: the binary on disk plus the VERSION record. */
function installed(ver: string) {
  mkdirSync(binDir(), { recursive: true });
  writeFileSync(resolve(binDir(), `failproofaid-${ver}`), "ELF");
  writeVersionFile({ daemon: ver });
}

describe("daemonVersionSkew", () => {
  it("is null when the installed daemon matches this CLI", () => {
    installed(cliVersion);
    expect(daemonVersionSkew()).toBeNull();
  });

  it("reports the pair when the daemon is older", () => {
    // The upgrade case: npm moved the CLI, the daemon did not.
    installed("0.0.1-old");
    expect(daemonVersionSkew()).toEqual({ installed: "0.0.1-old", expected: cliVersion });
  });

  it("is null when nothing has been installed yet", () => {
    // A fresh machine is not "stale" — there is nothing to be stale.
    expect(daemonVersionSkew()).toBeNull();
  });

  it("is null when FAILPROOFAI_DAEMON_BINARY names one explicitly", () => {
    // Someone pointed at a binary on purpose. Its version is their business,
    // and second-guessing it would nag on every command.
    installed("0.0.1-old");
    process.env.FAILPROOFAI_DAEMON_BINARY = "/usr/local/bin/failproofaid";
    expect(daemonVersionSkew()).toBeNull();
  });

  it("is null for a locally-built binary with no managed install", () => {
    // The contributor setup this repo documents: `bun link` + a cargo build.
    // Reporting "stale" on every command there would be noise about the exact
    // configuration we tell people to use.
    writeVersionFile({ daemon: "0.0.1-old" });
    // No file under bin/ — the recorded version is not a managed install.
    expect(daemonVersionSkew()).toBeNull();
  });
});

describe("recording the version", () => {
  it("keeps the daemon version across a CLI-only rewrite", () => {
    // A rewrite that never touched the daemon must not erase what it knows.
    writeVersionFile({ daemon: "1.2.3" });
    writeVersionFile({ cli: "9.9.9" });
    expect(readVersionFile()).toMatchObject({ cli: "9.9.9", daemon: "1.2.3" });
  });

  it("erases it only when asked explicitly", () => {
    // Uninstall: a recorded version for a service that is gone is a claim
    // about this machine that is no longer true.
    writeVersionFile({ daemon: "1.2.3" });
    writeVersionFile({ clearDaemon: true });
    expect(readVersionFile()?.daemon).toBeUndefined();
  });

  it("does not duplicate the version into config.toml", () => {
    // One copy cannot disagree with itself. Two can.
    installed(cliVersion);
    expect(Object.keys(readConfig().daemon)).toEqual(["configured"]);
    expect(existsSync(versionFile())).toBe(true);
  });
});

describe("pruneOldDaemonBinaries", () => {
  function seed(name: string, ageMinutes: number) {
    mkdirSync(binDir(), { recursive: true });
    const p = resolve(binDir(), name);
    writeFileSync(p, "ELF");
    const t = Date.now() / 1000 - ageMinutes * 60;
    utimesSync(p, t, t);
    return p;
  }

  it("keeps the current and previous, drops older", () => {
    // One previous version is kept on purpose: rollback then costs a local
    // file rather than a download, which matters offline or behind a proxy.
    const newest = seed("failproofaid-1.0.0-beta.7", 0);
    const prev = seed("failproofaid-1.0.0-beta.6", 10);
    const old1 = seed("failproofaid-1.0.0-beta.5", 20);
    const old2 = seed("failproofaid-1.0.0-beta.4", 30);

    const removed = pruneOldDaemonBinaries();

    expect(existsSync(newest)).toBe(true);
    expect(existsSync(prev)).toBe(true);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(removed).toHaveLength(2);
  });

  it("orders by mtime, not by parsing version strings", () => {
    // beta.10 vs beta.9 is exactly where naive version sorting goes wrong.
    // "Which did we install most recently" is the question that matters.
    const ten = seed("failproofaid-1.0.0-beta.10", 0);
    const nine = seed("failproofaid-1.0.0-beta.9", 5);
    const eight = seed("failproofaid-1.0.0-beta.8", 10);

    pruneOldDaemonBinaries();

    expect(existsSync(ten)).toBe(true);
    expect(existsSync(nine)).toBe(true);
    expect(existsSync(eight)).toBe(false);
  });

  it("is a no-op with nothing to prune, and never throws on a missing dir", () => {
    expect(pruneOldDaemonBinaries()).toEqual([]);
    seed("failproofaid-1.0.0", 0);
    expect(pruneOldDaemonBinaries()).toEqual([]);
  });

  it("ignores half-written temp files", () => {
    // installBinaryBytes stages as <target>.<pid>.tmp before the atomic rename.
    // Pruning one mid-install would break the install that is writing it.
    seed("failproofaid-1.0.0-beta.7", 0);
    seed("failproofaid-1.0.0-beta.6", 5);
    const tmp = seed("failproofaid-1.0.0-beta.8.123.tmp", 10);
    pruneOldDaemonBinaries();
    expect(existsSync(tmp)).toBe(true);
  });
});
