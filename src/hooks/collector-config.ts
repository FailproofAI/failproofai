/**
 * Writing the collector's configuration from the setup wizard.
 *
 * Two files, deliberately:
 *
 *   ~/.failproofai/ingest.json           mode 0600, the credential ONLY
 *   ~/.failproofai/policies-config.json  the non-secret settings
 *
 * The split is not tidiness. `policies-config.json` is written with a bare
 * `writeFileSync`, so it inherits the umask and lands at 0664 on a normal
 * machine — inside a `~/.failproofai/` that is itself 0775. An API key there
 * would be readable by every local user on the box. `~/.agenteye/cli.json`
 * already stores its session token at 0600, so the correct precedent existed.
 *
 * The Rust daemon reads both (see `crates/fpai-collect/src/config.rs`); this is
 * the only thing that writes them.
 */
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  statSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { readHooksConfig, writeHooksConfig } from "./hooks-config";

/** The hosted ingest endpoint — a COMPLETE endpoint, not a base to join onto. */
export const DEFAULT_INGEST_URL = "https://server.befailproof.ai/events";

export interface IngestCredential {
  url: string;
  key: string;
}

export interface CollectorSettings {
  /** Ship agent session transcripts. Separate opt-in from having a key. */
  sessions: boolean;
  /** Ship hook activity. */
  hooks: boolean;
  hooksVerbosity?: "all" | "decisions" | "off";
  redact?: "minimal" | "off";
  environment?: string;
  /**
   * The machine's id, so the daemon can stamp it on every collected event and
   * the dashboard groups by machine rather than by `agent_id` (a per-project
   * identity). Written by `--connect --machine-id`; the Rust collector reads it
   * as `collector.machineId`.
   */
  machineId?: string;
}

export function failproofaiHome(): string {
  return process.env.FAILPROOFAI_HOME || join(homedir(), ".failproofai");
}

export function ingestPath(): string {
  return join(failproofaiHome(), "ingest.json");
}

/** Whether an ingest credential is already configured on this machine. */
export function hasIngestCredential(): boolean {
  return existsSync(ingestPath());
}

/**
 * The stored ingest credential, or null.
 *
 * Malformed JSON reads as absent rather than throwing: this is called from
 * `--status`, and a status command that crashes on a corrupt file is worse
 * than one reporting the capability as unconfigured — which, given the daemon
 * cannot read it either, is the truth.
 */
export function readIngestCredential(): IngestCredential | null {
  try {
    const raw = JSON.parse(readFileSync(ingestPath(), "utf8")) as Partial<IngestCredential>;
    if (typeof raw.url !== "string" || typeof raw.key !== "string") return null;
    if (!raw.url || !raw.key) return null;
    return { url: raw.url, key: raw.key };
  } catch {
    return null;
  }
}

/** Remove the ingest credential. Returns whether a file was actually removed. */
export function clearIngestCredential(): boolean {
  try {
    rmSync(ingestPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the credential at owner-only permissions, and tighten the home that
 * holds it.
 *
 * A 0600 file inside a 0775 directory is still reachable by every local user,
 * so the directory is tightened too. Both are best-effort on a filesystem
 * without POSIX modes; the write itself is not.
 */
export function writeIngestCredential(cred: IngestCredential): string {
  const home = failproofaiHome();
  mkdirSync(home, { recursive: true });
  try {
    const mode = statSync(home).mode & 0o777;
    if (mode & 0o077) chmodSync(home, 0o700);
  } catch {
    // Not fatal: the file's own 0600 is the primary protection.
  }

  const path = ingestPath();
  // `mode` on writeFileSync applies only when the file is CREATED, so an
  // existing over-permissive file would keep its mode without the chmod.
  writeFileSync(path, JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return path;
}

/** Merge the collector block into the shared (non-secret) config. */
export function writeCollectorSettings(settings: CollectorSettings): void {
  const config = readHooksConfig();
  writeHooksConfig({
    ...config,
    collector: {
      sessions: settings.sessions,
      hooks: settings.hooks,
      hooksVerbosity: settings.hooksVerbosity ?? "decisions",
      redact: settings.redact ?? "minimal",
      environment: settings.environment ?? "local",
      // Omit when unknown rather than writing null: the Rust side treats an
      // absent field as "no machine", which is the correct fallback.
      ...(settings.machineId ? { machineId: settings.machineId } : {}),
    },
  });
}

export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a key against the endpoint before writing it anywhere.
 *
 * Sends an EMPTY body: ingest answers `{"accepted":0,"skipped":0}` for it, so
 * the round-trip proves the URL resolves and the key authenticates without
 * creating a spurious event in the user's dashboard.
 *
 * Failing here at setup is the whole point — otherwise a typo'd key is only
 * discovered later as a silent pile of 401s in `failed/`, which reads like a
 * server problem rather than a typo.
 */
export async function validateIngestKey(
  cred: IngestCredential,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<KeyCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(cred.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.key}`,
        "Content-Type": "application/x-ndjson",
      },
      body: "",
      // Never follow a redirect. `fetch` follows by default, and the dashboard
      // (which sits on a different port of the same host, and is printed during
      // setup right beside the API) answers POST /events with a 307 to its
      // login page — which then returns 200. So `res.ok` was true for an
      // endpoint that authenticates nothing and stores nothing: the credential
      // was written, setup reported success, and every batch afterwards was
      // POSTed into a login form and lost. Confusing the two URLs is the most
      // likely mistake available here.
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        reason:
          "that URL redirects rather than accepting events — it looks like the dashboard, not the ingest API",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `the server rejected that key (${res.status})` };
    }
    if (res.status === 404) {
      return { ok: false, reason: `no ingest endpoint at that URL (404)` };
    }
    if (!res.ok) {
      return { ok: false, reason: `the server answered ${res.status}` };
    }
    // A 2xx is not enough either. Ingest answers `{"accepted":N,"skipped":M}`;
    // anything else returning 200 (a proxy, a static host, a catch-all router)
    // would otherwise pass. Requiring the shape is what actually proves this is
    // the endpoint the uploader will be talking to.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        reason: "that URL answered without an ingest response — it is not the events endpoint",
      };
    }
    const shaped =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { accepted?: unknown }).accepted === "number";
    if (!shaped) {
      return {
        ok: false,
        reason: "that URL answered, but not with an ingest response — it is not the events endpoint",
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Deliberately does not echo the URL back: it may contain a hostname the
    // user would rather not see in a shared terminal recording.
    return { ok: false, reason: `could not reach the server (${msg})` };
  } finally {
    clearTimeout(timer);
  }
}
