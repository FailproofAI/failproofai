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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomically } from "../../lib/atomic-write";
import { fetchWithTimeout, isAbortError } from "../../lib/fetch-with-timeout";

const SCHEMA_VERSION = 1;
const VERIFY_TIMEOUT_MS = 10_000;

export interface CloudCredentials {
  url: string;
  machineId: string;
  token: string;
}

interface StoredCredentials extends CloudCredentials {
  schemaVersion: number;
}

/** `~/.failproofai/cloud.json`. The override is honoured by the daemon too. */
export function cloudCredentialPath(): string {
  const override = process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  if (override) return override;
  return join(homedir(), ".failproofai", "cloud.json");
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
  const path = cloudCredentialPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredentials>;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof raw.url !== "string" || typeof raw.machineId !== "string" || typeof raw.token !== "string") {
      return null;
    }
    if (!raw.url || !raw.machineId || !raw.token) return null;
    return { url: raw.url, machineId: raw.machineId, token: raw.token };
  } catch {
    // Unreadable or malformed reads as "not connected" rather than throwing:
    // this is consulted by `--status`, and a corrupt file should be reported
    // as disconnected, not crash the command.
    return null;
  }
}

export function writeCloudCredentials(creds: CloudCredentials): void {
  // 0600 inside a 0700 dir — the default for writeJsonAtomically, and the
  // whole reason this is a file of ours rather than a line in the unit.
  writeJsonAtomically(cloudCredentialPath(), { schemaVersion: SCHEMA_VERSION, ...creds });
}

/** True if there was something to remove. */
export function clearCloudCredentials(): boolean {
  const path = cloudCredentialPath();
  if (!existsSync(path)) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

export type VerifyResult =
  | { ok: true; policyCount: number; generation: number }
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
  const url = `${creds.url}/enforcement/v1/desired-state?machineId=${encodeURIComponent(creds.machineId)}`;
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
    const body = (await response.json()) as { policies?: unknown[]; generation?: number };
    return {
      ok: true,
      policyCount: Array.isArray(body.policies) ? body.policies.length : 0,
      generation: typeof body.generation === "number" ? body.generation : 0,
    };
  } catch {
    return {
      ok: false,
      reason: `${creds.url} answered, but not with a desired-state document. Is this a Failproof Cloud URL?`,
    };
  }
}
