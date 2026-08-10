/**
 * Connecting a machine to Failproof Cloud.
 *
 * The credential lives in a file the daemon reads, NOT in the service unit.
 * `daemon-service.ts` installs that unit at mode 0644 into
 * /etc/systemd/system (and the launchd plist likewise), both root-owned and
 * world-readable — so an `Environment="FAILPROOFAI_CLOUD_TOKEN=…"` line would
 * hand an organization-scoped bearer key to every local user, and
 * `systemctl show` would print it back without any privilege at all.
 *
 * Keeping it out of the unit also means enrolment, re-enrolment, token
 * rotation and disconnect need no root — none of them touch a privileged
 * path — and enrolment stops being welded to service installation, so an
 * already-running daemon can be connected without reinstalling anything.
 *
 * Environment variables still win over this file, so CI, containers and the
 * existing tests are unaffected.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { writeJsonAtomically } from "../../lib/atomic-write";
import { fetchWithTimeout, isAbortError } from "../../lib/fetch-with-timeout";
import { credentialsFile } from "./fp-home";
import { readCredentials, writeCredentials } from "./fp-config";

const SCHEMA_VERSION = 1;
const VERIFY_TIMEOUT_MS = 10_000;

export interface CloudCredentials {
  url: string;
  machineId: string;
  token: string;
  /**
   * A human-facing name for this machine (e.g. the hostname, or "Chetan's
   * laptop"). Display only — the identity is `machineId`. Optional: absent on
   * credentials written before labels existed, and never required to connect.
   */
  machineLabel?: string;
}

interface StoredCredentials extends CloudCredentials {
  schemaVersion: number;
}

/**
 * Where the cloud credential lives.
 *
 * Layout 2 moved it out of `cloud.json` and into the `[cloud]` table of
 * `credentials.toml`, alongside every other token, so there is exactly one
 * owner-only file to protect rather than three. The env override still names a
 * standalone JSON file, because the daemon and CI both use it that way and it
 * predates the consolidation.
 */
export function cloudCredentialPath(): string {
  return process.env.FAILPROOFAI_CLOUD_CREDENTIALS ?? credentialsFile();
}

/** True when the credential is coming from the JSON override, not the TOML. */
function usingJsonOverride(): boolean {
  return Boolean(process.env.FAILPROOFAI_CLOUD_CREDENTIALS);
}

/**
 * Rejects a URL that would put a bearer token on the wire in clear.
 *
 * Loopback stays allowed over http, because that is exactly what the
 * enterprise doc's local walkthrough does (`http://localhost:8080`) and there
 * is no network to intercept.
 */
export function validateCloudUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL. Expected something like https://be.failproof.ai` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `Unsupported scheme "${parsed.protocol}" — use https (or http for localhost).` };
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (!loopback) {
      return {
        ok: false,
        reason:
          `Refusing to send the machine token to ${parsed.origin} over plain http. ` +
          `Use https, or http only for localhost during development.`,
      };
    }
  }
  return { ok: true, url: parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")) };
}

/** Last four characters only — enough to tell two keys apart, useless if leaked. */
export function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return `****${token.slice(-4)}`;
}

export function readCloudCredentials(): CloudCredentials | null {
  if (!usingJsonOverride()) return readCredentials().cloud ?? null;
  const path = cloudCredentialPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredentials>;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof raw.url !== "string" || typeof raw.machineId !== "string" || typeof raw.token !== "string") {
      return null;
    }
    if (!raw.url || !raw.machineId || !raw.token) return null;
    const label = typeof raw.machineLabel === "string" && raw.machineLabel ? raw.machineLabel : undefined;
    return { url: raw.url, machineId: raw.machineId, token: raw.token, machineLabel: label };
  } catch {
    // Unreadable or malformed reads as "not connected" rather than throwing:
    // this is consulted by `--status`, and a corrupt file should be reported
    // as disconnected, not crash the command.
    return null;
  }
}

export function writeCloudCredentials(creds: CloudCredentials): void {
  if (usingJsonOverride()) {
    // 0600 inside a 0700 dir — the default for writeJsonAtomically.
    writeJsonAtomically(cloudCredentialPath(), { schemaVersion: SCHEMA_VERSION, ...creds });
    return;
  }
  // Merge, never replace: credentials.toml also carries the ingest key and the
  // auth session, and rewriting the file from one caller must not drop the
  // others.
  writeCredentials({ ...readCredentials(), cloud: creds });
}

/**
 * The stable key that identifies this machine to the cloud.
 *
 * An explicit `--machine-id` always wins. Otherwise the id already enrolled on
 * this machine is reused, so re-running `--connect` is idempotent and never
 * "moves" the machine. Only a machine that has none mints a fresh one — and it
 * mints a random id, NOT the hostname, because two hosts sharing a hostname
 * (fresh cloud VMs, cloned images) would otherwise silently merge into one
 * machine on the server. The hostname becomes the human label instead.
 */
export function resolveMachineId(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const existing = readCloudCredentials();
  if (existing?.machineId) return existing.machineId;
  return randomUUID();
}

/**
 * The human-facing name for this machine. Defaults to the hostname as a
 * *suggestion* — mutable, not the identity, and free to collide with another
 * machine's label because `machineId` keeps them apart.
 */
export function resolveMachineLabel(explicit?: string): string {
  return explicit?.trim() || hostname();
}

/** True if there was something to remove. */
export function clearCloudCredentials(): boolean {
  if (usingJsonOverride()) {
    const path = cloudCredentialPath();
    if (!existsSync(path)) return false;
    try {
      rmSync(path);
      return true;
    } catch {
      return false;
    }
  }
  const current = readCredentials();
  if (!current.cloud) return false;
  // Drop only the cloud table — disconnecting policy must not also revoke the
  // ingest key or the dashboard session.
  const { cloud: _dropped, ...rest } = current;
  writeCredentials(rest);
  return true;
}

export type VerifyResult =
  | { ok: true; policyCount: number; deployment: number }
  | { ok: false; reason: string };

/**
 * Prove the credentials work before reporting success.
 *
 * Writing a credential file and saying nothing means a typo, a revoked key or
 * a key missing `policies:pull` surfaces much later — as a policy that
 * mysteriously never arrives, which is the worst moment to discover it. So
 * enrolment makes exactly the request the daemon will make and reports what
 * came back.
 */
export async function verifyCloudCredentials(creds: CloudCredentials): Promise<VerifyResult> {
  // The label rides the enrolment request so the server can record a
  // human-facing name alongside the id. An older server simply ignores the
  // extra query param, so sending it is always safe.
  const labelParam = creds.machineLabel
    ? `&label=${encodeURIComponent(creds.machineLabel)}`
    : "";
  const url = `${creds.url}/enforcement/v1/desired-state?machineId=${encodeURIComponent(creds.machineId)}${labelParam}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${creds.token}` } },
      VERIFY_TIMEOUT_MS,
    );
  } catch (err) {
    if (isAbortError(err)) return { ok: false, reason: `No response from ${creds.url} within ${VERIFY_TIMEOUT_MS / 1000}s.` };
    return { ok: false, reason: `Could not reach ${creds.url}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status === 401) {
    return { ok: false, reason: "The server rejected this token (401). Check the key was copied whole." };
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: "This key is valid but lacks the `policies:pull` permission (403). Create a machine key with that permission.",
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `The server answered ${response.status} ${response.statusText}.` };
  }

  try {
    const body = (await response.json()) as { policies?: unknown[]; deployment?: number };
    return {
      ok: true,
      policyCount: Array.isArray(body.policies) ? body.policies.length : 0,
      deployment: typeof body.deployment === "number" ? body.deployment : 0,
    };
  } catch {
    return {
      ok: false,
      reason: `${creds.url} answered, but not with a desired-state document. Is this a Failproof Cloud URL?`,
    };
  }
}
