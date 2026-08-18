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
 * Where the pack comes from, per channel.
 *
 * Both are CONSTRUCTED, never discovered — no API call to rate-limit, and no
 * way to end up holding an artifact from a source we did not name.
 *
 * `stable` is what every client machine uses. It resolves to the newest
 * PROMOTED pack: the lab's unattended pushes cut prereleases, and GitHub's
 * `latest` skips those, so a pack built from a bad lab run cannot become the
 * one customers fetch. It answers 404 until the first promotion, and that is
 * the correct answer — no reviewed contract exists yet, and treating "nothing
 * published" as "nothing to say" is right.
 *
 * `internal` is our own machines, which take the risk first. It reads the
 * branch directly rather than the newest prerelease, because "the latest
 * prerelease" has no constructible URL — only an API query, which is exactly
 * the discovery step the stable path is designed to avoid. The branch is
 * always the newest internal pack by definition.
 */
const CHANNEL_URLS: Readonly<Record<string, string>> = {
  stable: "https://github.com/FailproofAI/hook-contracts/releases/latest/download/pack.json",
  internal: "https://raw.githubusercontent.com/FailproofAI/hook-contracts/packs/pack.json",
};

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

/**
 * Which pack this machine follows.
 *
 * An unknown channel name falls back to `stable` rather than failing: getting
 * this wrong must never be a way to end up on the unreviewed channel by
 * accident.
 */
export function packChannel(): string {
  const named = (process.env.FAILPROOFAI_CONTRACTS_CHANNEL || "").trim();
  return named in CHANNEL_URLS ? named : "stable";
}

export function packUrl(): string {
  const override = (process.env.FAILPROOFAI_CONTRACTS_URL || "").trim();
  return override || CHANNEL_URLS[packChannel()];
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
