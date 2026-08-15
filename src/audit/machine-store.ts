/**
 * `~/.failproofai/audit/machine.json` — this machine's report identity.
 *
 * Two fields, and they are together because they share one property: both must
 * outlive a sign-out.
 *
 *  - `machine_id` is what the api-server keys reports on. Regenerate it and the
 *    server sees a brand-new machine, which burns a slot off the account's cap
 *    on every logout and splits one box's history into two.
 *  - `last_reported_at` is how far the last digest reached. Reset it and the
 *    next report re-covers months of history, and the user gets a digest of
 *    everything that ever happened as though it just did.
 *
 * That is why this is a separate file from `session.json` rather than two more
 * keys in it: signing out deletes the session, and neither of these may go with
 * it. `HOME_CLASSES` classifies this `identity` — never deleted, alongside
 * `cursors/` and the telemetry id — while the tokens beside it are `user-typed`
 * and come and go.
 *
 * ## The id is minted here, not borrowed
 *
 * `state/telemetry-id` is already a stable per-machine random id and would have
 * been free to reuse. It is deliberately not reused: that id is the anonymous
 * PostHog person, and sending it alongside a verified email address would link
 * the two the moment somebody turns emailed reports on. Opting into a digest
 * should not de-anonymise telemetry, so this feature gets its own id and the
 * two never meet.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { writeJsonAtomically } from "../../lib/atomic-write";
import { auditMachineFile } from "../hooks/fp-home";

export interface MachineIdentity {
  /** Random, minted on first use. Opaque to the server. */
  machine_id: string;
  /** ISO-8601. Absent until the first digest is delivered. */
  last_reported_at?: string;
  /** When this id was minted. Diagnostics only. */
  created_at: string;
}

export function readMachineIdentity(home?: string): MachineIdentity | null {
  const path = auditMachineFile(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MachineIdentity>;
    if (typeof parsed.machine_id !== "string" || !parsed.machine_id) return null;
    return {
      machine_id: parsed.machine_id,
      last_reported_at:
        typeof parsed.last_reported_at === "string" ? parsed.last_reported_at : undefined,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : new Date(0).toISOString(),
    };
  } catch {
    // Absent, unreadable and malformed all read as "no identity yet". The caller
    // mints a new one, which costs a slot off the cap and a re-covered window —
    // bad, but recoverable, and strictly better than refusing to report at all
    // because one file got truncated.
    return null;
  }
}

/**
 * Read the identity, creating it on first call.
 *
 * Only ever called from the reporting path, so a machine that never opts into
 * emailed reports never gets an id at all — there is nothing to mint one for.
 */
export function ensureMachineIdentity(home?: string): MachineIdentity {
  const existing = readMachineIdentity(home);
  if (existing) return existing;
  const fresh: MachineIdentity = {
    machine_id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  writeJsonAtomically(auditMachineFile(home), fresh);
  return fresh;
}

/**
 * Record how far the last DELIVERED digest reached.
 *
 * The value is the server's `next_window_from`, not the window this run
 * scanned. The server is authoritative because it knows which reports actually
 * produced an email — a report held by the cooldown, or one whose send failed,
 * must not advance the watermark or its findings are silently dropped from every
 * future digest.
 */
export function recordReportWatermark(nextWindowFrom: string, home?: string): void {
  const current = ensureMachineIdentity(home);
  writeJsonAtomically(auditMachineFile(home), {
    ...current,
    last_reported_at: nextWindowFrom,
  } satisfies MachineIdentity);
}

export function deleteMachineIdentity(home?: string): void {
  const path = auditMachineFile(home);
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * A display name for this machine — its hostname.
 *
 * Shown in the digest so somebody with three boxes can tell which one is
 * misbehaving, which is the whole reason it is sent. Falls back to `undefined`
 * rather than a placeholder: the server keeps whatever label it already has when
 * one is omitted, so guessing here would overwrite a good name with a bad one.
 */
export function machineLabel(): string | undefined {
  try {
    const h = hostname().trim();
    return h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}
