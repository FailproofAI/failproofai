// @vitest-environment node
/**
 * Whose file the recorded-prompt store is.
 *
 * The store is the one input that can clear a reviewable policy — and four of
 * the seven reviewable builtins are blocking denies, not nudges. Its file is
 * written 0600 in a 0700 directory, and that proves nothing on its own:
 * `~/.failproofai/state` is created by the daemon at the umask (0775 on a
 * umask-002 box), and anyone who can write to a directory ABOVE the file can
 * rename it away and leave their own `sessions/<id>.json`, which every check on
 * the file then passes.
 *
 * `jev-config.ts` already refuses a `jev.json` whose DIRECTORY is group- or
 * world-writable, for exactly that reason. These tests pin the same rule on the
 * prompt store's read path, and the one difference: loose bits are TIGHTENED
 * before they are refused, because refusing an ordinary umask-002 machine
 * outright would switch the clearing half of the evaluator off for most Linux
 * users with nothing said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ chmodRefused: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // A directory owned by another user: the bits cannot be taken off. Nothing
    // else about the file system is faked.
    chmodSync: (path: string, mode: number) => {
      if (hoisted.chmodRefused) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return actual.chmodSync(path, mode);
    },
  };
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureIntent, looseIntentStoreDir, readIntent, type CaptureEvent } from "../../../src/hooks/semantic/intent";

const SESSION = "perm-session";
let home: string;
let savedHome: string | undefined;

const stateDir = (): string => resolve(home, "state");
const semanticDir = (): string => resolve(stateDir(), "semantic");
const sessionsDir = (): string => resolve(semanticDir(), "sessions");

function capture(text: string): void {
  const ev: CaptureEvent = { eventType: "UserPromptSubmit", cli: "claude", sessionId: SESSION, payload: { prompt: text } };
  captureIntent(ev);
}

beforeEach(() => {
  savedHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-intent-perm-"));
  process.env.FAILPROOFAI_HOME = home;
  hoisted.chmodRefused = false;
});

afterEach(() => {
  hoisted.chmodRefused = false;
  if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("the prompt store's read path checks the directories above the file", () => {
  it("reads normally when the whole path is ours alone", () => {
    capture("delete the build directory");
    expect(looseIntentStoreDir()).toBeNull();
    expect(readIntent(SESSION).userSaid).toEqual(["delete the build directory"]);
  });

  it("tightens a group-writable ancestor instead of going quiet", () => {
    capture("delete the build directory");
    // What an ordinary umask-002 machine looks like: the daemon's `state/`.
    chmodSync(stateDir(), 0o775);
    expect(looseIntentStoreDir()).toBeNull();
    expect(statSync(stateDir()).mode & 0o022).toBe(0);
    // Only the WRITE bits go. Read and traverse survive, which is the same
    // trade `failproofai jev setup` makes on the home.
    expect(statSync(stateDir()).mode & 0o755).toBe(0o755);
    expect(readIntent(SESSION).userSaid).toEqual(["delete the build directory"]);
  });

  it("tightens a world-writable ancestor too, at every level of the chain", () => {
    capture("push it");
    const chain = [sessionsDir(), semanticDir(), stateDir(), home];
    for (const dir of chain) chmodSync(dir, 0o777);
    expect(looseIntentStoreDir()).toBeNull();
    for (const dir of chain) expect(statSync(dir).mode & 0o022, dir).toBe(0);
    expect(readIntent(SESSION).userSaid).toEqual(["push it"]);
  });

  it("reads nothing when an ancestor stays writable by someone else", () => {
    capture("force push it");
    expect(readIntent(SESSION).userSaid).toEqual(["force push it"]);
    chmodSync(stateDir(), 0o775);
    hoisted.chmodRefused = true;
    expect(looseIntentStoreDir()).toBe(stateDir());
    // Fail closed: no recorded prompt, so nothing a forged one could clear.
    expect(readIntent(SESSION)).toEqual({ userSaid: [], agentLastMessage: null });
  });

  it("says nothing is loose when the store does not exist yet", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    expect(looseIntentStoreDir()).toBeNull();
    expect(readIntent(SESSION).userSaid).toEqual([]);
  });
});
