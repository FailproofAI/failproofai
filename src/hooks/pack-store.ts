/**
 * Fetching and installing policy packs.
 *
 * ## The trust this does and does not give you
 *
 * A pack is verified against a `SHA256SUMS` published in the same release, so a
 * truncated, cached or substituted download is caught. That manifest is NOT a
 * signature: whoever controls the release controls both files, so this proves
 * nothing about the publisher's identity. What it does buy is real and worth
 * being precise about — the digest is RECORDED in `installed.json` at add time,
 * and `pack-manifest.ts` re-verifies it immediately before every import. So a
 * pack cannot change under a machine after it was installed, and a repository
 * that retags or force-pushes an asset stops loading rather than silently
 * running something else. Signing was considered and deliberately deferred.
 *
 * ## Never discovery
 *
 * Every URL is CONSTRUCTED from an owner, repo and tag the user typed. No API
 * call, no `releases/latest` redirect to follow, no rate limit, and no way to end
 * up holding an artifact from a source nobody named. Same rule as
 * `daemon-download.ts` and `contract-pack-client.ts`.
 *
 * ## Never on the hook path
 *
 * Everything here touches the network. A hook must never wait on it. This module
 * is reachable only from the `pack` CLI command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { packsRoot, parsePackPolicy, readInstalledPacks } from "./pack-manifest";
import type { InstalledPackRecord } from "./pack-manifest";
import type { PolicyCatalogEntry } from "./policy-types";

const DEFAULT_BASE_URL = "https://github.com";
const FETCH_TIMEOUT_MS = 30_000;
/** Cap on a pack artifact. A policy file is kilobytes; this is a sanity bound. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Asset names a publisher must use. Fixed, so the URL stays constructible. */
export const PACK_MANIFEST_ASSET = "failproofai-pack.json";
export const PACK_ENTRY_ASSET = "failproofai-pack.mjs";
export const PACK_CHECKSUMS_ASSET = "SHA256SUMS";

export interface PackSpec {
  owner: string;
  repo: string;
  /** null when the user did not name one — resolved to a concrete tag at add time. */
  tag: string | null;
}

/** A spec whose tag is known. Everything that builds a URL requires this. */
export interface PinnedPackSpec extends PackSpec {
  tag: string;
}

export interface AddPackResult {
  id: string;
  version: string;
  source: string;
  /** The concrete tag installed, whether typed or resolved. */
  tag: string;
  /**
   * True when the user named no tag and this was the newest release at that
   * moment. Surfaced so the pin is VISIBLE — re-running the same command later
   * can install something different, and that should not be a silent surprise.
   */
  resolvedFromLatest: boolean;
  /** Names actually registered — the whole pack, or the selected subset. */
  enabled: string[];
  /** Every policy the pack contains, whether taken or not. */
  available: string[];
  /** How the selection was arrived at, so the CLI can explain itself. */
  selection: SelectionReason;
  /** Category slugs the pack offers, for `--category`. */
  categories: string[];
  artifact: string;
}

function baseUrl(): string {
  return (process.env.FAILPROOFAI_PACK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Parse a pack source into owner, repo and an optional tag.
 *
 * Accepts what a person actually has to hand: the shorthand, and the URL they
 * copied out of the browser.
 *
 *   github:acme/finance@v1.2.0
 *   acme/finance@v1.2.0
 *   acme/finance                                   (tag resolved at add time)
 *   https://github.com/acme/finance/releases/tag/v1.2.0
 *   https://github.com/acme/finance/releases/download/v1.2.0/failproofai-pack.mjs
 *   https://github.com/acme/finance
 *
 * A missing tag is resolved to a CONCRETE one before anything is written, and
 * that concrete tag is what `installed.json` records. So "no moving sources"
 * still holds where it matters: what a machine reinstalls is pinned, even when
 * the person who typed it did not know the version.
 */
export function parsePackSpec(source: string): PackSpec {
  const raw = source.trim();
  if (raw.length === 0) throw new Error("pack source is empty");

  const url = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (url) {
    const parts = url[1].replace(/\/+$/, "").split("/");
    const [owner, repo, ...rest] = parts;
    // `/releases/tag/<tag>` and `/releases/download/<tag>/<asset>` both carry the
    // tag in the slot after their keyword; a tag may itself contain slashes
    // (`release/2.1`), so take everything up to the asset rather than one segment.
    let tag: string | null = null;
    if (rest[0] === "releases" && (rest[1] === "tag" || rest[1] === "download")) {
      const tail = rest.slice(2);
      tag = (rest[1] === "download" ? tail.slice(0, -1) : tail).join("/") || null;
    } else if (rest[0] === "releases" && rest[1] === "latest") {
      tag = null;
    }
    return validated(owner, repo, tag);
  }

  const withoutScheme = raw.replace(/^github:/i, "");
  const at = withoutScheme.lastIndexOf("@");
  const repoPart = at > 0 ? withoutScheme.slice(0, at) : withoutScheme;
  const tag = at > 0 ? withoutScheme.slice(at + 1) : null;
  const slash = repoPart.indexOf("/");
  if (slash <= 0 || slash === repoPart.length - 1) {
    throw new Error(
      `pack source must be owner/repo, owner/repo@tag, or a github.com URL — got ${JSON.stringify(source)}`,
    );
  }
  return validated(repoPart.slice(0, slash), repoPart.slice(slash + 1), tag);
}

function validated(owner: string, repo: string, tag: string | null): PackSpec {
  if (!owner || !OWNER_RE.test(owner)) throw new Error(`unsafe owner ${JSON.stringify(owner)}`);
  if (!repo || !OWNER_RE.test(repo)) throw new Error(`unsafe repo ${JSON.stringify(repo)}`);
  if (tag !== null && !TAG_RE.test(tag)) throw new Error(`unsafe tag ${JSON.stringify(tag)}`);
  return { owner, repo, tag };
}

/**
 * The concrete tag of a repository's newest release, read from the redirect
 * `releases/latest` issues rather than from the API.
 *
 * Deliberately not `api.github.com`: the redirect is on the host we already
 * fetch the assets from, so it needs no second origin, carries no 60-per-hour
 * unauthenticated rate limit, and stays pointed at whatever
 * `FAILPROOFAI_PACK_BASE_URL` names — which is how a mirror, and the tests,
 * work at all.
 */
export async function resolveLatestTag(spec: PackSpec): Promise<string> {
  const url = `${baseUrl()}/${spec.owner}/${spec.repo}/releases/latest`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(
      `could not resolve the newest release of ${spec.owner}/${spec.repo} ` +
        `(GET ${url} returned ${response.status} with no redirect). Name a tag explicitly.`,
    );
  }
  const match = location.match(/\/releases\/tag\/(.+)$/);
  if (!match) throw new Error(`unexpected redirect from ${url}: ${location}`);
  const tag = decodeURIComponent(match[1]).replace(/\/+$/, "");
  if (!TAG_RE.test(tag)) throw new Error(`unsafe tag ${JSON.stringify(tag)} from ${url}`);
  return tag;
}

/**
 * The canonical spelling recorded in `installed.json`.
 *
 * Always carries the CONCRETE tag, never the tagless form the user may have
 * typed — otherwise re-adding a pack later would resolve to a different release
 * and the recorded source would not describe what is installed.
 */
export function formatPackSpec(spec: PinnedPackSpec): string {
  return `github:${spec.owner}/${spec.repo}@${spec.tag}`;
}

export function packAssetUrl(spec: PinnedPackSpec, asset: string): string {
  return `${baseUrl()}/${spec.owner}/${spec.repo}/releases/download/${spec.tag}/${asset}`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`${url} is ${bytes.length} bytes, over the ${MAX_ARTIFACT_BYTES} limit`);
  }
  return bytes;
}

/**
 * The digest a `sha256sum`-format manifest records for one asset.
 *
 * A missing line is a refusal, never a skipped check — the manifest is the only
 * thing between a substituted download and a file this process is about to
 * install as policy.
 */
export function digestFor(manifest: string, assetName: string): string | null {
  for (const line of manifest.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeAtomic(target: string, bytes: Buffer | string): void {
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, target);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

interface FetchedPack {
  id: string;
  version: string;
  policies: PolicyCatalogEntry[];
  effect?: string;
  artifact: Buffer;
  artifactDigest: string;
}

/** Fetch and fully validate a pack, without writing anything. */
async function fetchPack(spec: PinnedPackSpec): Promise<FetchedPack> {
  const checksums = (await fetchBytes(packAssetUrl(spec, PACK_CHECKSUMS_ASSET))).toString("utf8");

  const manifestBytes = await fetchBytes(packAssetUrl(spec, PACK_MANIFEST_ASSET));
  const manifestDigest = digestFor(checksums, PACK_MANIFEST_ASSET);
  if (!manifestDigest) throw new Error(`${PACK_CHECKSUMS_ASSET} has no entry for ${PACK_MANIFEST_ASSET}`);
  if (sha256(manifestBytes) !== manifestDigest) {
    throw new Error(`${PACK_MANIFEST_ASSET} failed integrity verification`);
  }

  const artifact = await fetchBytes(packAssetUrl(spec, PACK_ENTRY_ASSET));
  const entryDigest = digestFor(checksums, PACK_ENTRY_ASSET);
  if (!entryDigest) throw new Error(`${PACK_CHECKSUMS_ASSET} has no entry for ${PACK_ENTRY_ASSET}`);
  const artifactDigest = sha256(artifact);
  if (artifactDigest !== entryDigest) {
    throw new Error(`${PACK_ENTRY_ASSET} failed integrity verification`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    throw new Error(`${PACK_MANIFEST_ASSET} is not valid JSON: ${errText(err)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${PACK_MANIFEST_ASSET} is not an object`);
  const raw = parsed as { id?: unknown; version?: unknown; policies?: unknown; effect?: unknown };
  if (typeof raw.id !== "string" || !raw.id.includes("/")) {
    throw new Error(`pack manifest id must be publisher/name, got ${JSON.stringify(raw.id)}`);
  }
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error("pack manifest has no version");
  }
  if (!Array.isArray(raw.policies) || raw.policies.length === 0) {
    throw new Error("pack manifest declares no policies");
  }
  // Validated with the SAME rules the loader applies, so a pack that could never
  // load is refused here — while nothing has been written — rather than
  // installing cleanly and failing silently on the next tool call.
  const policies = raw.policies.map((p, i) => parsePackPolicy(raw.id as string, p, i));

  return {
    id: raw.id,
    version: raw.version,
    policies,
    ...(typeof raw.effect === "string" ? { effect: raw.effect } : {}),
    artifact,
    artifactDigest,
  };
}

/**
 * Fetch, verify and install a pack, then activate it.
 *
 * `only` takes a subset of the pack's policies. Omitted, the whole pack is
 * taken — and re-adding a pack that already had a selection CARRIES IT FORWARD,
 * because upgrading a pack should not quietly switch on the policies someone
 * chose to leave off.
 */
export function slugifyCategory(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Which of a pack's policies to take.
 *
 * The default is the pack's OWN `defaultEnabled` set, not everything. A pack
 * carries an opinion about which of its policies are safe to switch on
 * unattended — for the builtins that is 10 of 38 — and installing the whole
 * thing overrode that opinion with one nobody held. `block-kubectl`,
 * `block-terraform` and `require-ci-green-before-stop` are off by default in the
 * npm package precisely because they interrupt legitimate work.
 */
function resolveSelection(
  policies: PolicyCatalogEntry[],
  opts: { only?: string[]; categories?: string[]; all?: boolean } | undefined,
  previous: string[] | null | undefined,
  previouslyInstalled: boolean,
): { enabled: string[] | null; reason: SelectionReason } {
  const available = policies.map((p) => p.name);
  if (opts?.all) return { enabled: null, reason: "all" };

  const picked = new Set<string>();
  if (opts?.categories?.length) {
    const wanted = new Set(opts.categories.map(slugifyCategory));
    const known = new Map(policies.map((p) => [slugifyCategory(p.category), p.category]));
    const unknown = [...wanted].filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new Error(
        `no such categor${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")} ` +
          `(has: ${[...new Set(policies.map((p) => slugifyCategory(p.category)))].join(", ")})`,
      );
    }
    for (const p of policies) if (wanted.has(slugifyCategory(p.category))) picked.add(p.name);
  }
  if (opts?.only?.length) {
    const unknown = opts.only.filter((n) => !available.includes(n));
    if (unknown.length > 0) {
      throw new Error(`pack does not contain ${unknown.join(", ")}`);
    }
    for (const n of opts.only) picked.add(n);
  }
  if (picked.size > 0) {
    // Kept in the pack's declared order, which is the order everything else
    // presents them in.
    return { enabled: available.filter((n) => picked.has(n)), reason: "selected" };
  }

  // No flags. An upgrade keeps whatever the machine already had — switching a
  // policy back on because the user did not repeat themselves is not an upgrade.
  if (previouslyInstalled) {
    return { enabled: previous === null ? null : (previous ?? null), reason: "carried" };
  }
  return { enabled: policies.filter((p) => p.defaultEnabled).map((p) => p.name), reason: "defaults" };
}

export type SelectionReason = "all" | "selected" | "carried" | "defaults";

export async function addPack(
  source: string,
  opts?: { only?: string[]; categories?: string[]; all?: boolean },
): Promise<AddPackResult> {
  if (process.env.FAILPROOFAI_NO_DOWNLOAD) {
    throw new Error(
      "pack downloads are disabled (FAILPROOFAI_NO_DOWNLOAD). Already-installed packs keep enforcing.",
    );
  }
  const parsed = parsePackSpec(source);
  // Resolve BEFORE anything is written, and pin the concrete result. A tagless
  // source is a convenience for the person typing; what the machine records must
  // always name one release.
  const spec: PinnedPackSpec = parsed.tag
    ? { ...parsed, tag: parsed.tag }
    : { ...parsed, tag: await resolveLatestTag(parsed) };
  const resolvedFromLatest = parsed.tag === null;
  const fetched = await fetchPack(spec);
  const available = fetched.policies.map((p) => p.name);

  const prior = readInstalledPacks().packs.find((p) => p.id === fetched.id);
  const { enabled, reason } = resolveSelection(
    fetched.policies,
    opts,
    prior?.enabled ? prior.enabled.filter((n) => available.includes(n)) : prior?.enabled,
    Boolean(prior),
  );

  const root = packsRoot();
  const artifactRel = `artifacts/${fetched.artifactDigest}.mjs`;
  const artifactAbs = resolve(root, artifactRel);
  // Content-addressed, so a file that already exists has these exact bytes and
  // rewriting it could only ever disturb a pack currently importing it.
  if (!existsSync(artifactAbs)) writeAtomic(artifactAbs, fetched.artifact);

  const record: InstalledPackRecord = {
    id: fetched.id,
    version: fetched.version,
    source: formatPackSpec(spec),
    entry: artifactRel,
    sha256: fetched.artifactDigest,
    policies: fetched.policies,
    ...(fetched.effect ? { effect: fetched.effect } : {}),
    ...(enabled ? { enabled } : {}),
  };

  upsertInstalled(record);
  return {
    id: fetched.id,
    version: fetched.version,
    source: record.source,
    tag: spec.tag,
    resolvedFromLatest,
    enabled: enabled ?? available,
    available,
    selection: reason,
    categories: [...new Set(fetched.policies.map((p) => slugifyCategory(p.category)))],
    artifact: artifactAbs,
  };
}

/** Remove a pack from the activation pointer. Returns false if it was not installed. */
export function removePack(id: string): boolean {
  const manifestPath = resolve(packsRoot(), "installed.json");
  if (!existsSync(manifestPath)) return false;
  let raw: { schemaVersion?: number; packs?: InstalledPackRecord[] };
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return false;
  }
  const packs = Array.isArray(raw.packs) ? raw.packs : [];
  const remaining = packs.filter((p) => p?.id !== id);
  if (remaining.length === packs.length) return false;
  // The artifact is left on disk deliberately: it is content-addressed and inert
  // once nothing points at it, so keeping it makes a re-add offline-safe. Same
  // choice the cloud reconciler makes.
  writeAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, packs: remaining }, null, 2) + "\n");
  return true;
}

/**
 * Replace or append one pack in `installed.json`, written LAST and atomically so
 * activation is a single flip: until this rename lands, the artifact on disk is
 * a file nothing points at.
 */
function upsertInstalled(record: InstalledPackRecord): void {
  const manifestPath = resolve(packsRoot(), "installed.json");
  let packs: InstalledPackRecord[] = [];
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { packs?: InstalledPackRecord[] };
      if (Array.isArray(raw.packs)) packs = raw.packs;
    } catch {
      // A manifest we cannot parse is one we must not append to: merging into
      // it would either drop the packs it held or write them back malformed.
      throw new Error(
        `existing pack manifest at ${manifestPath} is unreadable; move it aside and re-add`,
      );
    }
  }
  const idx = packs.findIndex((p) => p?.id === record.id);
  if (idx >= 0) packs[idx] = record;
  else packs.push(record);
  writeAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, packs }, null, 2) + "\n");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
