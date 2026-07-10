/**
 * Hermes (hermes-agent) session enumeration.
 *
 * AUDIT-ONLY. Enumerates every session across every gateway user from Hermes's
 * single DB by shelling out to `hermes sessions list` (all sessions live in one
 * `~/.hermes/state.db`, so this is "audit everyone from one place").
 *
 * ⚠️ Unlike `opencode db --format json`, `hermes sessions list` has NO
 * structured-output flag — it prints human text. We therefore extract session
 * IDs by pattern. Hermes session IDs embed their start datetime
 * (`YYYYMMDD_HHMMSS`, e.g. `20260709_112532_9bfa1bc9`, or
 * `cron_<hash>_YYYYMMDD_HHMMSS`), so we derive `mtimeMs` from the ID itself —
 * no extra CLI call, and `--since` filtering works.
 *
 * On-box verification needed: the exact `sessions list` output format and how
 * to list ALL sessions (not just a recent-N default) — see `hermesListArgs`.
 */
import { runHermes } from "./hermes-sessions";
import { runtimeCache } from "./runtime-cache";

export interface HermesSessionRef {
  sessionId: string;
  /** Derived from the datetime embedded in the session ID; falls back to "now"
   *  (include-by-default) when the ID carries no parseable date, so `--since`
   *  never silently drops a session. */
  mtimeMs: number;
}

/** Args to list every session. ⚠️ Confirm the gateway lists ALL (not a capped
 *  default) — adjust if Hermes needs an `--all`/`--limit` flag. */
function hermesListArgs(): string[] {
  return ["sessions", "list"];
}

// Matches Hermes session IDs:
//   20260709_112532_9bfa1bc9            (chat/gateway/cli sessions)
//   cron_4c5aef2aa8ae_20260706_090030   (cron sessions)
//   ses_ABC123                          (short form, if present)
const SESSION_ID_RE =
  /\b(?:cron_[0-9a-z]+_)?\d{8}_\d{6}(?:_[0-9a-z-]+)?\b|\bses_[A-Za-z0-9]+\b/g;

/** Parse the `YYYYMMDD_HHMMSS` embedded in a session ID into epoch ms. */
function mtimeFromId(id: string): number {
  const m = id.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return Date.now();
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(
    `${y}-${mo}-${d}T${h}:${mi}:${s}`,
  );
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Extract session refs from `hermes sessions list` output text. Pure (no I/O)
 * so it is unit-testable without `hermes` installed. Dedupes and orders
 * newest-first (matching the other adapters).
 */
export function parseHermesSessionList(output: string): HermesSessionRef[] {
  const seen = new Set<string>();
  const refs: HermesSessionRef[] = [];
  for (const match of output.matchAll(SESSION_ID_RE)) {
    const sessionId = match[0];
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    refs.push({ sessionId, mtimeMs: mtimeFromId(sessionId) });
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return refs;
}

/**
 * List every Hermes session. Returns `[]` when the binary is missing or the
 * output has no recognizable IDs (fail-open — the audit just skips Hermes).
 */
export async function getHermesSessions(): Promise<HermesSessionRef[]> {
  const out = runHermes(hermesListArgs());
  if (out == null) return [];
  return parseHermesSessionList(out);
}

export const getCachedHermesSessions = runtimeCache(getHermesSessions, 30);
