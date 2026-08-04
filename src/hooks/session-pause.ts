/**
 * Per-session enforcement pause — the state behind `failproofai config --pause`.
 *
 * A pause suspends LOCAL policy (builtins, explicit custom, convention) for one
 * agent session, for a bounded time. It is deliberately NOT configuration:
 *
 *  - Config is persistent, merged across project/local/global, and routinely
 *    committed to git. A paused enforcement state written there would outlive
 *    the session that asked for it and travel to everyone who checks out the
 *    branch — enforcement silently off for a whole team.
 *  - So pause state lives here, under `~/.failproofai/state/sessions/`, owner-
 *    only, keyed by session, and carrying an absolute expiry.
 *
 * Disk is the source of truth rather than the daemon: most machines have no
 * daemon at all, and even where one exists the CLI that writes a pause is a
 * different process from the hook that reads it. A daemon may cache this; it
 * must not own it.
 *
 * Expiry is evaluated at READ time against the clock, never by a sweeper. A
 * stale file is therefore inert rather than dangerous — the failure mode worth
 * engineering against is not "the pause didn't work", it is "the pause silently
 * never ended".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { writeJsonAtomically } from "../../lib/atomic-write";
import { getAllHookActivityEntries } from "./hook-activity-store";
import { sessionPauseDir } from "./fp-home";

const SCHEMA_VERSION = 1;

/** Default when `--pause` is given no duration. */
export const PAUSE_DEFAULT_MS = 30 * 60_000;

/**
 * Hard ceiling. Config may lower this, never raise it — a ceiling a project
 * could raise is not a ceiling, and the whole point is that a forgotten pause
 * costs little.
 */
export const PAUSE_CEILING_MS = 8 * 60 * 60_000;

export interface ActivePause {
  sessionId: string;
  /** Epoch ms. */
  pausedAt: number;
  /** Epoch ms. Always finite — there is no unbounded pause. */
  expiresAt: number;
  /** Free-form provenance, e.g. "cli". Recorded so the activity log can say who. */
  setBy: string;
  /** Where it was issued from, for `--status` and for cwd-based resolution. */
  cwd?: string;
}

interface StoredPause extends ActivePause {
  schemaVersion: number;
}

export function pauseStateDir(): string {
  const override = process.env.FAILPROOFAI_STATE_DIR;
  if (override) return resolve(override, "sessions");
  return sessionPauseDir();
}

/**
 * Filename is a digest of the session id, not the id itself.
 *
 * Session ids come from twelve different agent CLIs and are not a format we
 * control — Hermes and OpenClaw mint their own, and nothing stops one
 * containing a path separator or `..`. Hashing sidesteps the entire class
 * rather than trying to enumerate what is safe; the real id is stored inside
 * the file, so `--status` and `--all` still report it.
 */
function pauseFilePath(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(pauseStateDir(), `${digest}.json`);
}

/**
 * Parse `10m` / `2h` / `90s`, or a bare integer read as minutes.
 *
 * Refuses anything over the ceiling rather than silently clamping: someone
 * typing `--pause 12h` has a expectation about how long enforcement is off,
 * and quietly giving them 8h is worse than telling them no.
 */
export function parsePauseDuration(input: string | undefined, ceilingMs = PAUSE_CEILING_MS): number {
  if (input === undefined || input === "") return Math.min(PAUSE_DEFAULT_MS, ceilingMs);

  const match = /^(\d+)\s*(s|m|h)?$/i.exec(input.trim());
  if (!match) {
    throw new Error(
      `Invalid duration ${JSON.stringify(input)}. Use e.g. 30m, 2h, 90s (a bare number means minutes).`,
    );
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const ms = unit === "s" ? value * 1000 : unit === "h" ? value * 3_600_000 : value * 60_000;

  if (ms <= 0) throw new Error("Duration must be greater than zero.");
  if (ms > ceilingMs) {
    throw new Error(`Duration ${input} exceeds the maximum pause of ${formatDuration(ceilingMs)}.`);
  }
  return ms;
}

/** Human-readable, for CLI output and log reasons. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function parseStored(raw: unknown): StoredPause | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<StoredPause>;
  if (p.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof p.sessionId !== "string" || p.sessionId.length === 0) return null;
  if (!Number.isFinite(p.pausedAt) || !Number.isFinite(p.expiresAt)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: p.sessionId,
    pausedAt: p.pausedAt as number,
    expiresAt: p.expiresAt as number,
    setBy: typeof p.setBy === "string" ? p.setBy : "unknown",
    ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
  };
}

/**
 * The active pause for a session, or null.
 *
 * Never throws: this is called on the hook path, and a malformed or unreadable
 * state file must mean "enforcement is ON" rather than crashing the evaluation.
 * Failing toward enforcement is the only safe direction here.
 */
export function readActivePause(sessionId: string | undefined, now = Date.now()): ActivePause | null {
  if (!sessionId) return null;
  try {
    const path = pauseFilePath(sessionId);
    if (!existsSync(path)) return null;
    const stored = parseStored(JSON.parse(readFileSync(path, "utf8")));
    if (!stored) return null;
    if (stored.expiresAt <= now) return null; // expired — inert, not dangerous
    const { schemaVersion: _ignored, ...pause } = stored;
    return pause;
  } catch {
    return null;
  }
}

export function writePause(opts: {
  sessionId: string;
  durationMs: number;
  cwd?: string;
  setBy?: string;
  now?: number;
}): ActivePause {
  const now = opts.now ?? Date.now();
  const pause: ActivePause = {
    sessionId: opts.sessionId,
    pausedAt: now,
    expiresAt: now + opts.durationMs,
    setBy: opts.setBy ?? "cli",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };
  mkdirSync(pauseStateDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomically(pauseFilePath(opts.sessionId), { schemaVersion: SCHEMA_VERSION, ...pause });
  return pause;
}

/** Returns true if a pause file was removed. */
export function clearPause(sessionId: string): boolean {
  const path = pauseFilePath(sessionId);
  if (!existsSync(path)) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every pause that has not yet expired, newest first. Expired files are ignored. */
export function listActivePauses(now = Date.now()): ActivePause[] {
  const dir = pauseStateDir();
  if (!existsSync(dir)) return [];
  const out: ActivePause[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const stored = parseStored(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!stored || stored.expiresAt <= now) continue;
      const { schemaVersion: _ignored, ...pause } = stored;
      out.push(pause);
    } catch {
      // A single unreadable file must not hide every other pause from --status.
    }
  }
  return out.sort((a, b) => b.pausedAt - a.pausedAt);
}

/**
 * The session to act on when the user names none.
 *
 * Whoever types the command has no session id — it exists only inside the hook
 * payload. But every hook event already records `sessionId` alongside `cwd` and
 * a timestamp, so the most recent session seen in this directory is derivable
 * from data we already write. Returns null when nothing recent matches, so the
 * caller can say so instead of guessing at a stranger's session.
 */
export function resolveSessionForCwd(cwd: string, maxAgeMs = 12 * 3_600_000, now = Date.now()): string | null {
  let best: { sessionId: string; timestamp: number } | null = null;
  let entries;
  try {
    entries = getAllHookActivityEntries();
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.sessionId || entry.cwd !== cwd) continue;
    if (now - entry.timestamp > maxAgeMs) continue;
    if (!best || entry.timestamp > best.timestamp) {
      best = { sessionId: entry.sessionId, timestamp: entry.timestamp };
    }
  }
  return best?.sessionId ?? null;
}
