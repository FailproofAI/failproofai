// @vitest-environment node
/**
 * The intent store is keyed by agent profile AND session id (review of #933).
 *
 * Session ids are the harness's, so two profiles can submit the same one.
 * Keyed by session id alone, a prompt typed into a profile FailproofAI Cloud's
 * Jev deployment does not target was read back as the stated intent of one it
 * does, and could clear a reviewable `both` policy's regex deny there. Pinned
 * here at the store: a prompt is readable only under the profile it was
 * captured under; a pre-profile (flat) entry is readable under none; the sweep
 * and the directory-permission rule cover the profile directories too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTENT_MAX_AGE_MS,
  captureIntent,
  intentProfileKey,
  looseIntentStoreDir,
  pruneExpiredSessions,
  readIntent,
  type IntentProfile,
} from "../../../src/hooks/semantic/intent";

const SESSION = "shared-session-id";
// The real clock: the sweep compares file mtimes with it.
const T0 = Date.now();
const WORK: IntentProfile = { cli: "claude", agent: { integration: "claude", instanceId: "agt_1234567890abcdef" } };
const PERSONAL: IntentProfile = { cli: "claude", agent: { integration: "claude", instanceId: "agt_abcdef1234567890" } };
const UNROSTERED: IntentProfile = { cli: "claude", agent: null };

let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-intent-profile-"));
  chmodSync(home, 0o700);
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const sessionsDir = () => join(home, "state", "semantic", "sessions");

function capture(prompt: string, profile: IntentProfile | undefined, sessionId = SESSION, now = T0): void {
  captureIntent(
    { eventType: "UserPromptSubmit", sessionId, cli: profile?.cli ?? "claude", payload: { prompt }, ...(profile ? { profile } : {}) },
    now,
  );
}

const said = (profile: IntentProfile | undefined, sessionId = SESSION) => readIntent(sessionId, T0 + 1, profile).userSaid;

describe("one profile's prompt is never another's intent", () => {
  it("a prompt captured under one profile is not readable under another with the same session id", () => {
    capture("force push it", PERSONAL);
    expect(said(PERSONAL)).toEqual(["force push it"]);
    expect(said(WORK)).toEqual([]);
    expect(said(UNROSTERED)).toEqual([]);
    // Nor through the flat, profile-less store.
    expect(said(undefined)).toEqual([]);
  });

  it("each profile keeps its own session file, side by side", () => {
    capture("deploy the work branch", WORK);
    capture("force push it", PERSONAL);
    capture("tidy the notes", UNROSTERED);
    expect(said(WORK)).toEqual(["deploy the work branch"]);
    expect(said(PERSONAL)).toEqual(["force push it"]);
    expect(said(UNROSTERED)).toEqual(["tidy the notes"]);
    expect(readdirSync(sessionsDir()).sort()).toEqual(["claude", "claude.agt_1234567890abcdef", "claude.agt_abcdef1234567890"]);
  });

  it("an unrostered profile of one harness is not another harness's", () => {
    capture("rebase it", { cli: "codex", agent: null });
    expect(said({ cli: "codex", agent: null })).toEqual(["rebase it"]);
    expect(said(UNROSTERED)).toEqual([]);
  });

  it("a pre-profile (flat) entry for the same session id is read under no profile", () => {
    // What a machine upgraded mid-session holds: `sessions/<id>.json`, which
    // cannot say which profile wrote it, so it is ignored, never guessed at.
    capture("force push it", undefined);
    expect(existsSync(join(sessionsDir(), `${SESSION}.json`))).toBe(true);
    for (const profile of [WORK, PERSONAL, UNROSTERED]) expect(said(profile)).toEqual([]);
    expect(said(undefined)).toEqual(["force push it"]);
  });

  it("an unknown harness has no slot: nothing is recorded or read", () => {
    capture("push it", { cli: "not-a-harness", agent: null });
    expect(said({ cli: "not-a-harness", agent: null })).toEqual([]);
    expect(intentProfileKey({ cli: "not-a-harness", agent: null })).toBeNull();
  });

  it("a malformed agent identity is the harness's unrostered profile, never a rostered one", () => {
    const forged = { cli: "claude", agent: { integration: "claude", instanceId: "../../x" } } as unknown as IntentProfile;
    expect(intentProfileKey(forged)).toBe("claude");
    capture("push it", forged);
    expect(said(WORK)).toEqual([]);
  });
});

describe("the store's rules hold in the profile directories", () => {
  it("the sweep removes expired files inside profile directories, and the flat ones", () => {
    capture("old work", WORK, "old-session", T0);
    capture("old flat", undefined, "old-flat", T0);
    const stale = (T0 - INTENT_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(join(sessionsDir(), "claude.agt_1234567890abcdef", "old-session.json"), stale, stale);
    utimesSync(join(sessionsDir(), "old-flat.json"), stale, stale);
    capture("fresh", WORK, "fresh-session", T0);
    expect(pruneExpiredSessions(T0)).toBe(0); // the capture above already swept
    expect(existsSync(join(sessionsDir(), "claude.agt_1234567890abcdef", "old-session.json"))).toBe(false);
    expect(existsSync(join(sessionsDir(), "old-flat.json"))).toBe(false);
    expect(said(WORK, "fresh-session")).toEqual(["fresh"]);
  });

  it("the sweep leaves directories it did not make alone", () => {
    mkdirSync(join(sessionsDir(), "Not-A-Profile"), { recursive: true });
    const keep = join(sessionsDir(), "Not-A-Profile", "x.json");
    writeFileSync(keep, "{}");
    const stale = (T0 - INTENT_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(keep, stale, stale);
    pruneExpiredSessions(T0);
    expect(existsSync(keep)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a profile directory writable by others is tightened before it is read", () => {
    capture("force push it", WORK);
    const dir = join(sessionsDir(), "claude.agt_1234567890abcdef");
    chmodSync(dir, 0o777);
    expect(said(WORK)).toEqual(["force push it"]);
    expect(looseIntentStoreDir(dir)).toBeNull();
  });
});
