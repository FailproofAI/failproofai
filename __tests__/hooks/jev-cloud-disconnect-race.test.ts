// @vitest-environment node
/**
 * `config --disconnect` deletes jev.json only when it names FailproofAI Cloud
 * (decision 8) — and must never delete a bring-your-own-key one, however a
 * concurrent writer's timing falls.
 *
 * A writer (`jev setup`, the dashboard's save) replaces jev.json by atomic
 * rename, so it can land at ANY instant during a disconnect. These tests make
 * it land at each file-system step disconnect takes — after every open, read,
 * close and rename — and check the one property that matters: a BYOK file,
 * whenever it appears, is still on disk afterwards. Checking the provider and
 * then deleting the PATH broke exactly that: a BYOK file renamed into place
 * between the check and the unlink was the file that got unlinked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set by a test: runs once, right after the named fs call returns. */
const hook: { after: string | null; nth: number; run: (() => void) | null; seen: Record<string, number> } = {
  after: null,
  nth: 1,
  run: null,
  seen: {},
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrap = <K extends "openSync" | "readSync" | "closeSync" | "renameSync" | "fstatSync" | "lstatSync" | "statSync">(name: K) =>
    ((...args: unknown[]) => {
      const result = (actual[name] as (...a: unknown[]) => unknown)(...args);
      hook.seen[name] = (hook.seen[name] ?? 0) + 1;
      if (hook.run && hook.after === name && hook.seen[name] === hook.nth) {
        const run = hook.run;
        hook.run = null;
        run();
      }
      return result;
    }) as (typeof actual)[K];
  const wrapped = {
    ...actual,
    openSync: wrap("openSync"),
    readSync: wrap("readSync"),
    closeSync: wrap("closeSync"),
    renameSync: wrap("renameSync"),
    fstatSync: wrap("fstatSync"),
    lstatSync: wrap("lstatSync"),
    statSync: wrap("statSync"),
  };
  return { ...wrapped, default: wrapped };
});

const { removeCloudJevConfig } = await import("../../src/hooks/jev-cloud-connection");
const { jevConfigPath } = await import("../../src/hooks/semantic/jev-config");

const CLOUD = { provider: "failproofai", baseUrl: "https://app.befailproof.ai/enforcement/v1/jev", mode: "shadow" };
// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const BYOK_KEY = ["ts", "byok", "0123456789abcdef"].join("-");
const BYOK = { provider: "typesafe", apiKey: BYOK_KEY, mode: "enforce" };

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-jev-disconnect-race-"));
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true, mode: 0o700 });
  chmodSync(process.env.FAILPROOFAI_HOME, 0o700);
  hook.after = null;
  hook.run = null;
  hook.nth = 1;
  hook.seen = {};
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** What `jev setup` does: write a temp file, rename it over jev.json. */
function writeAtomically(obj: unknown): void {
  const tmp = `${jevConfigPath()}.writer.tmp`;
  realFs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  realFs.renameSync(tmp, jevConfigPath());
}

/** Disconnect's own file-system calls are what the hook counts, so the setup's are forgotten first. */
function disconnect() {
  hook.seen = {};
  return removeCloudJevConfig();
}

/** Every file in the config directory that holds the BYOK key. */
function byokCopies(): string[] {
  const dir = process.env.FAILPROOFAI_HOME as string;
  return readdirSync(dir).filter((n) => {
    try {
      return readFileSync(join(dir, n), "utf8").includes(BYOK_KEY);
    } catch {
      return false;
    }
  });
}

const STEPS = ["openSync", "readSync", "fstatSync", "lstatSync", "statSync", "closeSync", "renameSync"] as const;

describe("disconnect never deletes a BYOK jev.json", () => {
  it("a BYOK file on its own is kept exactly: same bytes, same mode, same inode, no leftovers", () => {
    writeAtomically(BYOK);
    const before = statSync(jevConfigPath());
    const bytes = readFileSync(jevConfigPath(), "utf8");
    const r = removeCloudJevConfig();
    expect(r).toMatchObject({ status: "kept", provider: "typesafe" });
    expect(readFileSync(jevConfigPath(), "utf8")).toBe(bytes);
    const after = statSync(jevConfigPath());
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(readdirSync(process.env.FAILPROOFAI_HOME as string)).toEqual(["jev.json"]);
  });

  it("the Cloud's own file is removed, with no leftovers", () => {
    writeAtomically(CLOUD);
    expect(removeCloudJevConfig()).toMatchObject({ status: "removed" });
    expect(existsSync(jevConfigPath())).toBe(false);
    expect(readdirSync(process.env.FAILPROOFAI_HOME as string)).toEqual([]);
  });

  // A Cloud file is on disk when disconnect starts, and a BYOK one replaces it
  // at the step under test: the BYOK file must survive.
  let raced = 0;
  for (const step of STEPS) {
    for (const nth of [1, 2]) {
      it(`a BYOK file that replaces the Cloud one right after ${step} #${nth} survives`, () => {
        writeAtomically(CLOUD);
        hook.after = step;
        hook.nth = nth;
        hook.run = () => writeAtomically(BYOK);
        disconnect();
        if (hook.run !== null) return; // this step was not taken that many times: nothing to race
        raced++;
        expect(byokCopies().length).toBeGreaterThan(0);
      });
    }
  }

  it("…and those races really ran: a writer landed at several steps, not none", () => {
    expect(raced).toBeGreaterThanOrEqual(4);
  });

  it("a write landing while a BYOK file is out of place: both kept, and the disconnect output says where", async () => {
    writeAtomically(BYOK);
    const original = readFileSync(jevConfigPath(), "utf8");
    hook.after = "renameSync";
    hook.run = () => writeAtomically(CLOUD);
    const r = disconnect();
    expect(r.status).toBe("set-aside");
    if (r.status !== "set-aside") return;
    expect(r.provider).toBe("typesafe");
    expect(readFileSync(r.setAside, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(jevConfigPath(), "utf8"))).toEqual(CLOUD);
  });

  // A BYOK file is on disk when disconnect starts, and another writer lands at
  // the step under test: neither the original nor the new one is deleted.
  for (const step of STEPS) {
    it(`a BYOK file is not deleted when another write lands right after ${step}`, () => {
      writeAtomically(BYOK);
      hook.after = step;
      hook.run = () => {
        const tmp = `${jevConfigPath()}.other.tmp`;
        realFs.writeFileSync(tmp, JSON.stringify({ ...BYOK, mode: "shadow" }), { mode: 0o600 });
        realFs.renameSync(tmp, jevConfigPath());
      };
      disconnect();
      expect(existsSync(jevConfigPath())).toBe(true);
      expect(byokCopies().length).toBeGreaterThan(0);
    });
  }
});
