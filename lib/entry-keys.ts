/**
 * Stable per-entry identity for the log viewer.
 *
 * Deliberately standalone and dependency-free: `lib/log-entries.ts` reaches
 * fs/promises through its project-resolution imports, so a *value* import of
 * it from a client component drags node:fs into the browser bundle and the
 * session page 500s. Client code may only import types from there.
 */
import type { LogEntry } from "./log-entries";

/**
 * Assigns every entry a unique, render-stable identity.
 *
 * Not every CLI writes a per-record `uuid` — Codex, Copilot, Cursor and Pi
 * transcripts have none, so `baseEntry` leaves it "". Keying rows off
 * `uuid || timestamp` therefore collapses to the timestamp, which those CLIs
 * reuse freely (one 771-record Codex session: 93 timestamps shared by 2-5
 * records each). Duplicate React keys break reconciliation, and in the
 * virtualized log list that strands orphaned DOM nodes stacked on top of live
 * rows — they keep their old transform and never recover (#292 follow-up).
 *
 * Collisions are disambiguated by occurrence order, so keys stay stable for as
 * long as the parsed entry list is — which is what React and the virtualizer's
 * measurement cache both require.
 */
export function buildEntryKeys(entries: LogEntry[]): Map<LogEntry, string> {
  const keys = new Map<LogEntry, string>();
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const base = entry.uuid || `${entry._source}:${entry.timestamp}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys.set(entry, n === 0 ? base : `${base}#${n}`);
  }
  return keys;
}
