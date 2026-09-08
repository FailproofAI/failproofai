"use server";

import { activeFindings, dismissFinding, readLeakRecord } from "@/src/audit/leak-store";
import { readConfig, updateConfig } from "@/src/hooks/fp-config";

/**
 * One credential, flattened for the report table.
 *
 * A separate shape from `LeakFinding` on purpose: this crosses into a client
 * component, so it carries only what is drawn. The finding's raw sightings, its
 * rule and its salt stay on the server side of the boundary — not because any
 * of them is a secret (the record holds no secret by construction), but because
 * a display type that mirrors the storage type drifts into rendering whatever
 * gets added to storage next.
 */
export interface LeakRow {
  id: string;
  /** WHAT — `ghp_••••••••4f2a`. Never the value; there is no value to send. */
  display: string;
  label: string;
  length: number;
  /** False means no console to revoke at — the advice changes completely. */
  attributed: boolean;
  /** The identifier it was assigned to, when there was one. */
  name: string | null;
  /** WHO — the harness whose transcript carried it. */
  cli: string;
  /** WHERE — home-shortened project path. */
  project: string;
  /** WHEN — ISO, formatted client-side so it lands in the reader's timezone. */
  lastSeen: string;
  firstSeen: string;
  /** HOW — "read from ~/…/.env". */
  mechanism: string;
  /** WHY IT MATTERS — an input the agent sent can be denied next time; a
   *  result it received cannot be un-received. */
  direction: "input" | "result";
  occurrences: number;
  sessions: number;
}

export interface LeaksPayload {
  rows: LeakRow[];
  /** Whether this machine may raise a desktop notification. Drawn as a toggle
   *  beside the table, because the table is where somebody decides the banner
   *  was worth it or not. */
  notify: boolean;
}

export async function getLeaksAction(): Promise<LeaksPayload> {
  const findings = activeFindings(readLeakRecord());
  const rows: LeakRow[] = findings.map((f) => {
    // The most recent sighting: where the key is now, not where it debuted.
    const seen = f.sightings?.[f.sightings.length - 1];
    return {
      id: f.id,
      display: f.fingerprint?.display ?? "[credential]",
      label: f.fingerprint?.label ?? "secret",
      length: f.fingerprint?.length ?? 0,
      attributed: f.fingerprint?.attributed === true,
      name: f.name,
      cli: seen?.cli ?? "unknown",
      project: seen?.cwd ?? "unknown",
      lastSeen: f.lastSeen,
      firstSeen: f.firstSeen,
      mechanism: seen?.mechanism?.summary ?? "seen in a transcript",
      direction: seen?.mechanism?.direction ?? "result",
      occurrences: f.occurrences,
      sessions: new Set((f.sightings ?? []).map((s) => s.sessionId)).size,
    };
  });
  rows.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  return { rows, notify: readConfig().audit.notify };
}

/**
 * Mark one finding as not-a-secret.
 *
 * The finding is RETAINED, not deleted — deleting it would let the next scan
 * rediscover the same value and alert again, which is the one outcome that
 * teaches a user the dismiss button does not work.
 */
export async function dismissLeakAction(id: string): Promise<boolean> {
  return dismissFinding(id);
}

/**
 * Turn the desktop banner on or off.
 *
 * Writes the same `audit.notify` key `failproofai config` writes and the daemon's
 * audit child reads, so the dashboard and the CLI cannot disagree about it.
 */
export async function setLeakNotifyAction(notify: boolean): Promise<boolean> {
  try {
    updateConfig({ audit: { notify } });
    return true;
  } catch {
    return false;
  }
}
