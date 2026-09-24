// @vitest-environment node
//
// The 0600 on jev.json is only worth what the directory around it is worth: a
// ~/.failproofai another local user can WRITE lets them unlink the owner's file
// and leave their own 0600 one, which every check on the file then passes —
// and in enforce mode the endpoint they chose can clear a reviewable deny.
//
// So the loader refuses a config whose directory is group- or world-writable,
// and `jev setup` — the one command that puts a key there — re-asserts 0700 on
// it, because older code paths create ~/.failproofai at the umask (0775 on a
// umask-002 machine) and mkdir leaves an existing directory alone.
//
// Read bits on the directory are deliberately not refused: a 0755 home gives
// nobody that power, and the file inside it is checked for read bits anyway.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, inspectJevConfig, jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["dir", "perms", "0123456789abcdef"].join("-");
const posix = process.platform !== "win32";

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");

describe.skipIf(!posix)("the directory holding jev.json", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-dir-perms-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    // Loose modes are the point of this file; make sure the tree can be removed.
    try {
      chmodSync(join(home, ".failproofai"), 0o700);
    } catch {
      // Already gone.
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** An owner-only jev.json in a directory with the given mode. */
  function writeIn(dirMode: number): void {
    const dir = join(home, ".failproofai");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(jevConfigPath(), JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o600 });
    chmodSync(jevConfigPath(), 0o600);
    chmodSync(dir, dirMode);
  }

  it.each([0o777, 0o775, 0o770, 0o707, 0o702, 0o720, 0o730])("mode %s is refused however tight the file is", (dirMode) => {
    writeIn(dirMode);
    expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
    expect(loadJevConfig()).toBeNull();
    const r = inspectJevConfig();
    expect(r.status).toBe("refused");
    if (r.status === "refused") {
      expect(r.reason).toBe("too-open");
      expect(r.problem).toContain("chmod 700");
      expect(r.problem).not.toContain(KEY);
    }
  });

  it.each([0o700, 0o750, 0o755, 0o705])("mode %s still loads: read bits are not the attack", (dirMode) => {
    writeIn(dirMode);
    expect(loadJevConfig()?.apiKey).toBe(KEY);
    expect(inspectJevConfig().status).toBe("ok");
  });

  it("status points at the directory, not at the file that is already 0600", async () => {
    writeIn(0o777);
    const r = await runJevCommand(["status"], RENDER);
    expect(r.exitCode).toBe(1);
    const out = text(r);
    expect(out).toContain(`chmod 700 ${dirname(jevConfigPath())}`);
    expect(out).not.toContain(`chmod 600 ${jevConfigPath()}`);
    expect(out).not.toContain(KEY);
  });

  it("setup takes the write bits off a directory it did not create, so the config it writes is usable", async () => {
    // What an older code path leaves behind on a umask-002 machine.
    const dir = join(home, ".failproofai");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o775);

    const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    expect(r.exitCode, text(r)).toBe(0);
    expect(text(r)).not.toContain(KEY);
    // Exactly the bits the loader refuses, and no more: config.json in the
    // same directory is world-readable by design.
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
    expect(loadJevConfig()?.apiKey).toBe(KEY);
    expect(text(r)).toContain("was writable by other users");
  });

  it("setup leaves a directory the loader accepts exactly as it is", async () => {
    const dir = join(home, ".failproofai");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o750);

    const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    expect(r.exitCode, text(r)).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o750);
    expect(text(r)).not.toContain("writable by other users");
    expect(loadJevConfig()?.apiKey).toBe(KEY);
  });
});
