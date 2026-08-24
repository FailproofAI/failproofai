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
 * Asset URLs are CONSTRUCTED from an owner, repo and concrete tag. When the
 * user omits a tag, one `releases/latest` redirect resolves it before any asset
 * is fetched or written. There is no API lookup or rate-limit dependency, and
 * the installed record always names the pinned result.
 *
 * ## Never on the hook path
 *
 * Everything here touches the network. A hook must never wait on it. This module
 * is reachable only from the `pack` CLI command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { packsRoot, parsePackIdentity, parsePackPolicy, readInstalledPacks } from "./pack-manifest";
import type { ResolvedPack } from "./pack-manifest";
import type { InstalledPackRecord } from "./pack-manifest";
import type { PolicyCatalogEntry } from "./policy-types";
import type { PolicyEffect } from "./cloud-managed-policies";

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
  /** Ids this install absorbed — the same artifact, previously under another
   *  name. Reported so a rename is never a silent deletion of someone's pack. */
  replaced?: string[];
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
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
      await response.body?.cancel();
      throw new Error(`${url} declares ${declared} bytes, over the ${MAX_ARTIFACT_BYTES} limit`);
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error(`${url} is over the ${MAX_ARTIFACT_BYTES} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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
  effect?: PolicyEffect;
  artifact: Buffer;
  artifactDigest: string;
}

/** Fetch and fully validate a pack, without writing anything. */
/**
 * The short names for the pack Failproof AI publishes.
 *
 * Lives here, not in the CLI, because the dashboard takes the same typed source
 * and has to resolve it the same way — `core` worked in the terminal and failed
 * in the browser for exactly as long as this list sat in `pack-cli.ts`.
 */
export const CORE_ALIASES = new Set(["core", "failproofai", "official"]);

export interface PackAddOptions {
  only?: string[];
  categories?: string[];
  all?: boolean;
}

export interface AddedPack {
  id: string;
  version: string;
  enabled: string[];
  available: string[];
  /** True when it came from the copy inside this package rather than a release. */
  bundled: boolean;
  source?: string;
  tag?: string;
  resolvedFromLatest?: boolean;
  selection?: string;
  categories?: string[];
}

/**
 * Install a pack from whatever a person typed — the one entry point for both the
 * CLI and the dashboard, so a source that works in one cannot fail in the other.
 */
export async function addPackFromSource(
  source: string,
  opts: PackAddOptions = {},
): Promise<AddedPack> {
  if (CORE_ALIASES.has(source.trim().toLowerCase())) {
    const result = installBundledPack(opts);
    if (!result.installed) throw new Error(result.reason ?? "could not install");
    return {
      id: result.id!,
      version: result.version!,
      enabled: result.enabled ?? result.available ?? [],
      available: result.available ?? [],
      bundled: true,
    };
  }
  const result = await addPack(source, opts);
  return {
    id: result.id,
    version: result.version,
    enabled: result.enabled,
    available: result.available,
    bundled: false,
    source: result.source,
    tag: result.tag,
    resolvedFromLatest: result.resolvedFromLatest,
    selection: result.selection,
    categories: result.categories,
  };
}

export interface PackPreview {
  id: string;
  version: string;
  effect: PolicyEffect;
  policies: PolicyCatalogEntry[];
  /** The exact source the preview was read from, tag resolved and pinned. */
  source: string;
  /** True when the tag was resolved rather than typed. */
  resolvedFromLatest: boolean;
}

/**
 * Read what a pack CONTAINS, without installing it and without running it.
 *
 * The only way to see a stranger's policies was to install them, which is the
 * wrong order: deciding whether to trust a pack should not require already
 * having trusted it. This fetches the MANIFEST and nothing else — the entry
 * artifact is never downloaded and never imported, so a preview cannot execute
 * a line of somebody else's code.
 *
 * The manifest is still verified against the release's own SHA256SUMS and parsed
 * with the loader's rules, so what is shown is what would install — and a pack
 * that could never load says so here rather than after the download.
 */
export async function fetchPackPreview(source: string): Promise<PackPreview> {
  if (process.env.FAILPROOFAI_NO_DOWNLOAD === "1") {
    throw new Error("FAILPROOFAI_NO_DOWNLOAD is set, so nothing can be fetched to preview");
  }
  const parsed = parsePackSpec(source);
  const resolvedFromLatest = parsed.tag === null;
  const spec: PinnedPackSpec =
    parsed.tag !== null
      ? { ...parsed, tag: parsed.tag }
      : { ...parsed, tag: await resolveLatestTag(parsed) };

  const checksums = (await fetchBytes(packAssetUrl(spec, PACK_CHECKSUMS_ASSET))).toString("utf8");
  const manifestBytes = await fetchBytes(packAssetUrl(spec, PACK_MANIFEST_ASSET));
  const manifestDigest = digestFor(checksums, PACK_MANIFEST_ASSET);
  if (!manifestDigest) {
    throw new Error(`${PACK_CHECKSUMS_ASSET} has no entry for ${PACK_MANIFEST_ASSET}`);
  }
  if (sha256(manifestBytes) !== manifestDigest) {
    throw new Error(`${PACK_MANIFEST_ASSET} failed integrity verification`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    throw new Error(`${PACK_MANIFEST_ASSET} is not valid JSON: ${errText(err)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`${PACK_MANIFEST_ASSET} is not an object`);
  const value = raw as { id?: unknown; version?: unknown; policies?: unknown; effect?: unknown };
  const identity = parsePackIdentity(value);
  if (!Array.isArray(value.policies) || value.policies.length === 0) {
    throw new Error("pack manifest declares no policies");
  }
  return {
    id: identity.id,
    version: identity.version,
    effect: identity.effect,
    policies: value.policies.map((policy, i) => parsePackPolicy(identity.id, policy, i)),
    source: formatPackSpec(spec),
    resolvedFromLatest,
  };
}

/**
 * The record this install is really an update OF — matched by id, or failing
 * that by artifact digest.
 *
 * The digest half matters because an id can be renamed under a user: the
 * published release calls this set `failproofai/builtins` and the vendored copy
 * calls it `failproofai/core`. Looking up by id alone found nothing, so the
 * install fell back to the pack's DEFAULTS and quietly discarded whatever the
 * user had chosen — while reporting that their selection was kept.
 */
function priorRecordFor(id: string, sha256: string): ResolvedPack | undefined {
  const installed = readInstalledPacks().packs;
  return installed.find((p) => p.id === id) ?? installed.find((p) => p.sha256 === sha256);
}

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
  const identity = parsePackIdentity(raw);
  if (!Array.isArray(raw.policies) || raw.policies.length === 0) {
    throw new Error("pack manifest declares no policies");
  }
  // Validated with the SAME rules the loader applies, so a pack that could never
  // load is refused here — while nothing has been written — rather than
  // installing cleanly and failing silently on the next tool call.
  const policies = raw.policies.map((p, i) => parsePackPolicy(identity.id, p, i));

  return {
    id: identity.id,
    version: identity.version,
    policies,
    ...(raw.effect !== undefined ? { effect: identity.effect } : {}),
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

/**
 * Import the artifact and check it registers what the manifest promised.
 *
 * `pack add` used to verify digests and manifest SHAPE and then install without
 * ever executing the file. Two failures got through, both reproduced: an
 * artifact that does not parse installed at exit 0 and bricked every later tool
 * call, and a one-name typo between manifest and artifact — the exact slip a
 * publisher hand-maintaining two files makes — installed reporting "2/2
 * enabled" and then converted into a MACHINE-WIDE DENY, because a declared
 * policy that never registers is precisely what the fail-closed guard denies
 * for.
 *
 * The right place to catch that is here, where nothing has been activated yet
 * and the publisher's own mistake can be named. This runs only on the CLI path;
 * the hook path never imports anything it has not already recorded.
 */
async function verifyArtifactRegisters(
  artifactPath: string,
  declared: readonly string[],
): Promise<void> {
  const { loadCustomHooks } = await import("./custom-hooks-loader");
  let registered: string[];
  try {
    registered = (await loadCustomHooks(artifactPath, { strict: true })).map((h) => h.name);
  } catch (err) {
    throw new Error(
      `its artifact could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const missing = declared.filter((name) => !registered.includes(name));
  const extra = registered.filter((name) => !declared.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `its manifest declares ${missing.join(", ")} but the artifact does not register ` +
        `${missing.length === 1 ? "it" : "them"} — that would install as protection that never runs`,
    );
  }
  if (extra.length > 0) {
    throw new Error(
      `its artifact registers undeclared ${extra.join(", ")} — a policy that enforces but ` +
        `appears in no listing cannot be reviewed or switched off`,
    );
  }
}

/**
 * The same check, as a question rather than a refusal — for `pack list`, which
 * reported a pack whose artifact does not load as fully healthy, on the very
 * command the fail-closed deny message tells the human to run.
 */
export async function checkPackArtifact(
  artifactPath: string,
  declared: readonly string[],
): Promise<string | null> {
  try {
    await verifyArtifactRegisters(artifactPath, declared);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

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

  const prior = priorRecordFor(fetched.id, fetched.artifactDigest);
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

  // Before `installed.json` — the file that activates it — is written. The
  // artifact on disk is inert until something points at it, so a refusal here
  // leaves the machine exactly as it was.
  try {
    await verifyArtifactRegisters(artifactAbs, available);
  } catch (err) {
    throw new Error(
      `${fetched.id}@${fetched.version} was not installed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // An id is self-declared and nothing owns it, while `upsertInstalled` replaces
  // by id — so a pack served from any repository could declare
  // `failproofai/builtins` and silently take the place of the one already
  // installed. Binding the id to the source it first came from is the cheap half
  // of the fix: a second source for the same id has to be an explicit removal.
  // Compared on the REPOSITORY, not the whole source: `github:acme/pack@v1.2.0`
  // and `@v1.3.0` are the same publisher shipping an upgrade, which is the
  // ordinary case this must not break.
  const repoOf = (source: string): string => {
    const at = source.lastIndexOf("@");
    return at > source.indexOf(":") ? source.slice(0, at) : source;
  };
  if (
    prior &&
    !prior.source.startsWith("bundled:") &&
    repoOf(prior.source) !== repoOf(formatPackSpec(spec))
  ) {
    throw new Error(
      `pack id ${fetched.id} is already installed from ${prior.source}. ` +
        `Refusing to replace it with ${formatPackSpec(spec)} — remove it first if that is what you mean.`,
    );
  }

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

  const absorbed = upsertInstalled(record);
  return {
    replaced: absorbed,
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

/**
 * Install the pack that ships inside the npm package, from disk.
 *
 * This is what makes removing the builtins from the bundle survivable. The
 * tarball carries `policy-pack/` — the builtins as a real, digest-verified pack —
 * so a machine that has just installed failproofai already HAS them and setup
 * can enable them with no network at all. Without this, a fresh install with no
 * connectivity would be a machine enforcing nothing.
 *
 * Anchored at `FAILPROOFAI_PACKAGE_ROOT` for the reason `npmPlatformBinaryPath`
 * documents: `import.meta.url` does not survive the CJS bundle.
 *
 * The bytes are COPIED into `packsDir()` rather than loaded where they lie. A
 * `sudo npm i -g` package directory is root-owned, and the loader writes its
 * rewritten module tree BESIDE the source it loads — so loading in place gives a
 * non-root hook EACCES, the pack never loads, and the hook exits 0. Copying is
 * what avoids that, and it is the same trap CHANGELOG #694 fixed for the shim.
 *
 * Idempotent, and never throws: a package without the directory returns null,
 * which is a normal state for a dev checkout that has not run `build:pack`.
 */
export function bundledPackDir(): string | null {
  const root = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (!root) return null;
  const dir = resolve(root, "policy-pack");
  return existsSync(resolve(dir, PACK_MANIFEST_ASSET)) ? dir : null;
}

export interface BundledPackResult {
  installed: boolean;
  id?: string;
  version?: string;
  enabled?: string[];
  available?: string[];
  /** Ids this install absorbed — the same pack, previously under another name. */
  replaced?: string[];
  reason?: string;
}

export function installBundledPack(opts?: { only?: string[]; categories?: string[]; all?: boolean }): BundledPackResult {
  const dir = bundledPackDir();
  if (!dir) return { installed: false, reason: "this build ships no bundled pack" };

  try {
    const checksums = readFileSync(resolve(dir, PACK_CHECKSUMS_ASSET), "utf8");
    const manifestBytes = readFileSync(resolve(dir, PACK_MANIFEST_ASSET));
    const artifact = readFileSync(resolve(dir, PACK_ENTRY_ASSET));

    // Verified even though it never crossed a network. The digest is what the
    // hook path re-checks before every import, so it has to describe the bytes
    // actually installed — and a tarball can be corrupted on disk like anything
    // else.
    const manifestDigest = digestFor(checksums, PACK_MANIFEST_ASSET);
    const entryDigest = digestFor(checksums, PACK_ENTRY_ASSET);
    const artifactDigest = sha256(artifact);
    if (!manifestDigest || sha256(manifestBytes) !== manifestDigest) {
      return { installed: false, reason: `${PACK_MANIFEST_ASSET} failed integrity verification` };
    }
    if (!entryDigest || artifactDigest !== entryDigest) {
      return { installed: false, reason: `${PACK_ENTRY_ASSET} failed integrity verification` };
    }

    const parsed = JSON.parse(manifestBytes.toString("utf8")) as {
      id?: unknown; version?: unknown; policies?: unknown; effect?: unknown;
    };
    if (!Array.isArray(parsed.policies)) {
      return { installed: false, reason: "bundled pack manifest is malformed" };
    }
    const identity = parsePackIdentity(parsed);
    // Same rules the loader applies, so a bundled pack that could never load
    // fails the install rather than looking fine until the next tool call.
    const policies = parsed.policies.map((pol, i) => parsePackPolicy(identity.id, pol, i));

    const root = packsRoot();
    const artifactRel = `artifacts/${artifactDigest}.mjs`;
    const artifactAbs = resolve(root, artifactRel);
    if (!existsSync(artifactAbs)) writeAtomic(artifactAbs, artifact);

    const prior = priorRecordFor(identity.id, artifactDigest);
    const available = policies.map((pol) => pol.name);
    const { enabled } = resolveSelection(
      policies,
      opts,
      prior?.enabled ? prior.enabled.filter((n) => available.includes(n)) : prior?.enabled,
      Boolean(prior),
    );

    const absorbed = upsertInstalled({
      id: identity.id,
      version: identity.version,
      // Recorded as `bundled:` rather than a github: source, because it did not
      // come from one — and `pack add` on this id would otherwise look like a
      // re-fetch of something that was never fetched.
      source: `bundled:${identity.id}@${identity.version}`,
      entry: artifactRel,
      sha256: artifactDigest,
      policies,
      ...(parsed.effect !== undefined ? { effect: identity.effect } : {}),
      ...(enabled ? { enabled } : {}),
    });

    return {
      installed: true,
      id: identity.id,
      version: identity.version,
      enabled: enabled ?? available,
      available,
      ...(absorbed.length > 0 ? { replaced: absorbed } : {}),
    };
  } catch (err) {
    return { installed: false, reason: errText(err) };
  }
}

/** Remove a pack from the activation pointer. Returns false if it was not installed. */
/**
 * Turn ONE policy of an installed pack on or off.
 *
 * The selection in `installed.json` is the lever, not a `disabledCustomPolicies`
 * entry: those are keyed by `pack:<id>@<version>:<name>`, so an upgrade stops
 * matching them and silently switches back on everything the user had turned
 * off. The selection is version-stable and is carried forward by `pack add`.
 *
 * Enabling also clears any matching disabled key, or a policy switched off from
 * the dashboard could not be switched back on from the CLI — the two mechanisms
 * would disagree and the more obscure one would win.
 */
export function setPackPolicyEnabled(
  packId: string,
  name: string,
  on: boolean,
): { ok: boolean; reason?: string } {
  const manifestPath = resolve(packsRoot(), "installed.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "no packs are installed" };
  let raw: { schemaVersion?: number; packs?: InstalledPackRecord[] };
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, reason: `pack manifest at ${manifestPath} is unreadable` };
  }
  const packs = Array.isArray(raw.packs) ? raw.packs : [];
  const pack = packs.find((p) => p?.id === packId);
  if (!pack) return { ok: false, reason: `no installed pack with id ${packId}` };
  // `policies` is `unknown` on the record — it is validated by the loader, not
  // here — so read the names defensively rather than trusting the shape.
  const declared = Array.isArray(pack.policies) ? (pack.policies as Array<{ name?: unknown }>) : [];
  const available = declared
    .map((p) => (typeof p?.name === "string" ? p.name : null))
    .filter((n): n is string => n !== null);
  if (!available.includes(name)) {
    return { ok: false, reason: `pack ${packId} declares no policy named ${name}` };
  }
  // `enabled` absent means "the whole pack", which is what `--all` records so a
  // later version's new policies are included. Turning one off has to make that
  // implicit set explicit, or there is nothing to subtract from.
  const current = pack.enabled ?? available;
  const next: string[] = on
    ? [...new Set([...current, name])]
    : current.filter((n: string) => n !== name);
  // Kept in the pack's declared order rather than the order things were toggled.
  pack.enabled = available.filter((n) => next.includes(n));
  writeAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, packs }, null, 2) + "\n");
  return { ok: true };
}

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
/**
 * Install or update one pack record, collapsing anything that is the SAME PACK
 * under a different id.
 *
 * Two ids for one artifact is not hypothetical: the published release calls this
 * set `failproofai/builtins` and the copy vendored in the package calls it
 * `failproofai/core`, so following the help's own two examples installed both.
 * The result claimed "2 packs · 76 policies" over ONE artifact, warned on stderr
 * on every hook event, and left policies showing ON that did not block.
 *
 * Matched on the artifact DIGEST, which is what actually decides whether two
 * records describe the same code. Returns the ids it absorbed so the caller can
 * say so — an earlier version deleted the old row silently, taking the user's
 * selection and the enforcement it gave them with it.
 */
function upsertInstalled(record: InstalledPackRecord): string[] {
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
  // Anything with these bytes under another name is this pack, renamed.
  const absorbed = packs
    .filter((p) => p?.sha256 === record.sha256 && p?.id !== record.id)
    .map((p) => p.id);
  // The selection the user had under the old id is theirs — carry it, rather
  // than resetting them to defaults because a publisher renamed something.
  if (!record.enabled) {
    const prior = packs.find((p) => absorbed.includes(p?.id));
    const carried = prior?.enabled?.filter((n) =>
      (record.policies as Array<{ name?: unknown }> | undefined)?.some((rp) => rp?.name === n),
    );
    if (carried && carried.length > 0) record.enabled = carried;
  }
  const remaining = packs.filter((p) => !absorbed.includes(p?.id));
  const idx = remaining.findIndex((p) => p?.id === record.id);
  if (idx >= 0) remaining[idx] = record;
  else remaining.push(record);
  writeAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, packs: remaining }, null, 2) + "\n");
  return absorbed;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
