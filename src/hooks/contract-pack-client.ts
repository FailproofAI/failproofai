/**
 * Fetch and cache the contracts lab's pack.
 *
 * `observed.json` describes what THIS machine's agents have sent. That is the
 * more relevant signal and it costs nothing — but it is bounded by what the
 * machine happened to do. An agent that has never written a file has no Write
 * shape recorded, so a renamed Write key is invisible here right up until the
 * moment it matters. The lab drives every CLI through the same tool call every
 * day, so its pack covers the vendor rather than the usage.
 *
 * ## Rules
 *
 * - **Never on the hook path.** Every function here touches the network or the
 *   disk on a schedule; a hook must never wait on either. `readCachedPack()` is
 *   the only one anything interactive calls, and it is a plain file read.
 * - **Never throws, never fatal.** A pack is extra information. Failing to get
 *   one must leave every other check exactly as it was.
 * - **No discovery.** The URL is constructed, never looked up — no API call, no
 *   `releases/latest` redirect chain to rate-limit, and no way to end up
 *   pointed at an artifact from a source we did not name. Same reasoning as
 *   `daemon-download.ts`.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contractPackFile } from "./fp-home";

/**
 * Where the pack is published.
 *
 * Empty on purpose. The lab publishes to its own repo under the failproofai
 * org, and that repo does not exist yet — so there is nothing to point at, and
 * a plausible-looking guess would be worse than nothing: it would ship a URL
 * that 404s on every machine, indefinitely, while looking configured. Set this
 * one constant when the repo is created, or point `FAILPROOFAI_CONTRACTS_URL`
 * at a mirror.
 */
const DEFAULT_PACK_URL = "";

/** One bound for the whole fetch. A pack is tens of kilobytes. */
const FETCH_TIMEOUT_MS = 20_000;

/** Refuse anything larger than a pack could plausibly be. */
const MAX_PACK_BYTES = 4 * 1024 * 1024;

/** Do not refetch a pack younger than this. The lab publishes at most daily. */
const MIN_REFRESH_MS = 12 * 60 * 60 * 1000;

export type PackFetchOutcome =
  | { status: "fetched"; bytes: number }
  | { status: "fresh" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function packUrl(): string {
  return (process.env.FAILPROOFAI_CONTRACTS_URL || DEFAULT_PACK_URL).trim();
}

/**
 * The pack this machine last downloaded, or null.
 *
 * Deliberately tolerant: an unreadable or half-written cache is the same as no
 * cache. The comparator ignores fields it does not know, so an older client
 * reading a newer pack is a supported case, not a failure.
 */
export function readCachedPack(): unknown | null {
  try {
    const raw = readFileSync(contractPackFile(), "utf8");
    if (raw.length > MAX_PACK_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    // A pack must at least be an object with `clis`; anything else is not one,
    // and handing it to the comparator would only produce empty comparisons.
    if (!parsed || typeof parsed !== "object") return null;
    return "clis" in (parsed as Record<string, unknown>) ? parsed : null;
  } catch {
    return null;
  }
}

/** Milliseconds since the cache was written, or Infinity when there is none. */
function cacheAgeMs(): number {
  try {
    return Date.now() - statSync(contractPackFile()).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Refresh the cached pack. Best-effort by construction.
 *
 * Called from the scheduled path only — never from a hook, and never from an
 * interactive command unless the user asked for it.
 */
export async function refreshContractPack(opts: { force?: boolean } = {}): Promise<PackFetchOutcome> {
  const url = packUrl();
  if (!url) {
    return { status: "skipped", reason: "no pack URL is configured" };
  }
  // The same escape hatch the daemon download honours: an air-gapped site turns
  // off fetching without turning off anything it already has.
  if (process.env.FAILPROOFAI_NO_DOWNLOAD) {
    return { status: "skipped", reason: "downloads are disabled (FAILPROOFAI_NO_DOWNLOAD)" };
  }
  if (!opts.force && cacheAgeMs() < MIN_REFRESH_MS) {
    return { status: "fresh" };
  }

  let text: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { status: "failed", reason: `GET returned ${response.status}` };
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_PACK_BYTES) {
      return { status: "failed", reason: `pack is larger than ${MAX_PACK_BYTES} bytes` };
    }
    text = buf.toString("utf8");
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "fetch failed" };
  }

  // Parse before writing. A cache holding something that is not a pack is worse
  // than an empty one: every later read pays to discover it.
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("clis" in (parsed as Record<string, unknown>))) {
      return { status: "failed", reason: "what was served is not a pack" };
    }
  } catch {
    return { status: "failed", reason: "what was served is not JSON" };
  }

  try {
    const dest = contractPackFile();
    mkdirSync(dirname(dest), { recursive: true });
    // Written through a temp file: a reader that catches a half-written cache
    // would treat a good pack as a corrupt one.
    const tmp = join(dirname(dest), `.pack.${process.pid}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, dest);
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "could not write" };
  }
  return { status: "fetched", bytes: text.length };
}
