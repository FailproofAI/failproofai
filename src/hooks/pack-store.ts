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
 * is fetched or written. There is no index to poison, and the installed record
 * always names the pinned result — which has to AGREE with the version that
 * pack's manifest declares, or nothing is installed at all
 * (`packTagMatchesVersion`).
 *
 * `resolveTagForCommit` is the ONE exception, and it is opt-in: typing
 * `owner/repo@a1b2c3d` asks a question no URL can answer, so that path — and no
 * other — reads the releases API. It chooses WHICH release; every verification
 * below runs on the result exactly as it would on a typed tag.
 *
 * ## Never on the hook path
 *
 * Everything here touches the network. A hook must never wait on it. This module
 * is reachable only from the `pack` CLI command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PACK_COMMIT_RE, packsRoot, parsePackIdentity, parsePackPolicy, readInstalledPacks } from "./pack-manifest";
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

export const CORE_SOURCE = "FailproofAI/policies";

/**
 * Spellings that USED to resolve to our own pack, kept only so typing one gets
 * an answer rather than a parse error. They are not resolved any more — see the
 * throw in `parsePackSource`.
 */
export const RETIRED_CORE_ALIASES = new Set(["core", "failproofai", "official"]);

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
    // `core` / `failproofai` / `official` used to be spellings of our own pack.
    // They are gone on purpose: a short name only WE get to use makes our
    // policies look like part of the tool rather than a pack like any other,
    // which is exactly the distinction this whole surface exists to remove.
    // Named explicitly here so the spelling that used to work says what to type
    // instead of failing as an unparseable source.
    if (RETIRED_CORE_ALIASES.has(repoPart.trim().toLowerCase())) {
      throw new Error(
        `${JSON.stringify(source)} is no longer a pack name — ours is a pack like anyone else's now. Use ${CORE_SOURCE} instead.`,
      );
    }
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
 *
 * The price of that, and it is a real one: the redirect is issued only for a
 * PUBLISHED, non-prerelease release. A repository whose newest release is a
 * prerelease or a draft therefore either redirects to an OLDER stable tag —
 * pinning something the publisher has already superseded — or issues no
 * redirect at all. Only the second is detectable from here, so the error names
 * the prerelease case explicitly; the first is why naming a tag is the answer
 * whenever a publisher's newest release is not their newest stable one.
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
        `(GET ${url} returned ${response.status} with no redirect). That redirect is issued only ` +
        `for a published, non-prerelease release, so either the repository has no releases at all ` +
        `or every release it has is a prerelease or a draft. Name a tag explicitly.`,
    );
  }
  const match = location.match(/\/releases\/tag\/(.+)$/);
  if (!match) throw new Error(`unexpected redirect from ${url}: ${location}`);
  const tag = decodeURIComponent(match[1]).replace(/\/+$/, "");
  if (!TAG_RE.test(tag)) throw new Error(`unsafe tag ${JSON.stringify(tag)} from ${url}`);
  return tag;
}

/**
 * The GitHub API, for the ONE lookup on this whole path that needs one.
 *
 * Read per call rather than captured at import, the way `baseUrl()` above is:
 * the value has to be settable by a test that points it at a local server, and
 * a module-level const would freeze whatever the environment happened to hold
 * when this file was first imported.
 */
function githubApiBase(): string {
  return (process.env.FAILPROOFAI_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
}

/**
 * The release tag published from a given git commit, or null when no release
 * claims it.
 *
 * ## Why this is the only API call in the install path
 *
 * Everything else here CONSTRUCTS its URLs from owner, repo and tag and
 * discovers nothing — that is what leaves no index to poison, and it must stay
 * true for everybody who did not opt in. A commit is the one spelling that
 * cannot be turned into a URL, because the mapping from commit to tag exists
 * only on the server. So this runs when, and only when, the user typed a hex
 * string after the `@` themselves.
 *
 * ## What the answer is allowed to decide
 *
 * WHICH release, and nothing else. The release body is publisher-controlled
 * text on somebody else's repository and can say anything, so it selects a tag
 * and then every downstream check — SHA256SUMS, the digest pin recorded in
 * `installed.json`, `packTagMatchesVersion` — runs exactly as it would for a
 * typed tag. A body that lies picks the wrong release; it cannot make an
 * unverified artifact install.
 *
 * ## Ambiguity is a refusal, not a guess
 *
 * A 7-character prefix colliding across two releases is precisely why git
 * itself refuses to resolve one, and picking either would install code the user
 * did not ask for while reporting success. The matching tags and their full
 * commits go in the message so the next command can be typed from it.
 */
export async function resolveTagForCommit(spec: PackSpec, commit: string): Promise<string | null> {
  const prefix = commit.toLowerCase();
  const url = `${githubApiBase()}/repos/${spec.owner}/${spec.repo}/releases?per_page=100`;
  let payload: unknown;
  try {
    // No credential is required — a pack has to be public to install at all,
    // since installs are anonymous HTTPS. A token is taken when one happens to
    // be in the environment purely for the rate limit (60/hour → 5000).
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    const response = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "failproofai",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
    payload = await response.json();
  } catch (err) {
    // Deliberately NOT a fall-through to "treat it as a literal tag". A lookup
    // that could not run has established nothing — the fall-through would then
    // 404 on an asset URL built from a commit, and report a missing SHA256SUMS
    // for a release nobody ever claimed existed. Name the thing that failed.
    throw new Error(
      `could not resolve commit ${commit} in ${spec.owner}/${spec.repo}: ${errText(err)}. ` +
        `Name the release tag instead if you know it.`,
    );
  }

  // Imported here rather than at the top of the file: `pack-cli` imports this
  // module, so a static import would close a cycle for the sake of one format
  // reader. The reader has to be the SAME one `publish` writes with, or the two
  // drift silently and a listing and an install disagree about the same body.
  const { parseReleaseBody } = await import("./pack-cli");
  const releases = Array.isArray(payload)
    ? (payload as Array<{ tag_name?: unknown; body?: unknown }>)
    : [];
  const matches: Array<{ tag: string; commit: string }> = [];
  for (const release of releases) {
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    // A tag from the API becomes part of an asset URL, so it passes the same
    // check a typed one does rather than being trusted for having come back
    // over HTTPS.
    if (!tag || !TAG_RE.test(tag)) continue;
    const facts = parseReleaseBody(typeof release.body === "string" ? release.body : "");
    // The typed string is a PREFIX of the recorded commit, which is the
    // direction git works in and therefore the one a person copying out of
    // `git log` will have.
    if (facts.commit && facts.commit.startsWith(prefix)) matches.push({ tag, commit: facts.commit });
  }

  if (matches.length > 1) {
    throw new Error(
      `commit ${commit} matches ${matches.length} releases of ${spec.owner}/${spec.repo}: ` +
        matches.map((m) => `${m.tag} (${m.commit})`).join(", ") +
        `. Name one of those tags, or type more of the commit.`,
    );
  }
  return matches.length === 1 ? matches[0].tag : null;
}

/**
 * The concrete tag to install, from whatever the user typed after the `@`.
 *
 * Three shapes, in the order they are tried:
 *
 *  - nothing — resolved from `releases/latest`, as it always was;
 *  - a hex string — looked up as a COMMIT first, because typing one is how a
 *    person asks for that; and
 *  - anything else — taken literally.
 *
 * A hex string that matches no release falls back to being a literal tag. A
 * repository may genuinely have a tag named `abc1234`, and refusing to install
 * a tag that exists because it also looks like a commit would be a regression
 * for somebody who never asked for commit resolution at all.
 */
export async function resolveSpecTag(parsed: PackSpec): Promise<string> {
  if (parsed.tag === null) return resolveLatestTag(parsed);
  if (!PACK_COMMIT_RE.test(parsed.tag)) return parsed.tag;
  return (await resolveTagForCommit(parsed, parsed.tag)) ?? parsed.tag;
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

/**
 * Does a release tag describe the version the pack's own manifest declares?
 *
 * These are two independently-typed strings that everything downstream treats as
 * one fact: the TAG builds every asset URL and is what `installed.json` records
 * as the source, while the VERSION is read out of the manifest and is what
 * `pack list` prints and `pack:<id>@<version>:<name>` keys are built from. Left
 * uncompared, a pack tagged `v2` whose manifest still said `1.0.0` installed
 * cleanly and recorded a version no release of that repository answers to.
 *
 * A leading `v` is accepted because both spellings are in live use for the same
 * release — `pack build` tells publishers to tag `<version>` while this repo's
 * own releases are tagged `v<version>` — and refusing that would break packs
 * that are perfectly coherent.
 *
 * Compared on the tag's LAST `/`-delimited segment, so the monorepo shape
 * `parsePackSpec` deliberately supports (`release/2.1`) still installs:
 * `PACK_VERSION_RE` forbids `/`, so such a tag could never equal a version and a
 * whole-string comparison would make the shape uninstallable rather than merely
 * unusual. Everything else is a genuine disagreement — the release was tagged
 * without rebuilding the manifest, or the wrong tag was typed.
 */
export function packTagMatchesVersion(tag: string, version: string): boolean {
  const tail = tag.slice(tag.lastIndexOf("/") + 1);
  return tail === version || tail === `v${version}`;
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
  /** The git commit the publisher built this from, when they had one. */
  commit?: string;
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
/**
 * Where our own policies actually live.
 *
 * They are a GitHub release like anybody else's, and the package carries no
 * copy of them. That is the point: a pack that ships inside the binary is a
 * policy set we chose for you and put on your disk before you asked, and it
 * gives our own policies a delivery path nobody else's pack can use. One lane,
 * the same for everyone — ours are just the pack whose short name we spell.
 */

export interface PackAddOptions {
  only?: string[];
  categories?: string[];
  all?: boolean;
  /**
   * Add to what is already on, rather than replacing it.
   *
   * Set by the CLI FLAGS (`--policy`, `--category`) and deliberately NOT by the
   * interactive picker: the picker's list is the complete answer — unticking
   * everything means enable none — while a flag on an already-installed pack
   * means "also turn these on". Without the distinction, following the pack
   * README's own path (take the defaults, then add a category) silently
   * switched the defaults off. No effect on a first install, where there is
   * nothing to merge with.
   */
  merge?: boolean;
  /** Agent CLIs this pack should guard. Omitted means all of them. */
  clis?: string[];
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
  /** The git commit the publisher built this from, when they had one. */
  commit?: string;
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
  const spec: PinnedPackSpec = { ...parsed, tag: await resolveSpecTag(parsed) };

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
  const value = raw as {
    id?: unknown; version?: unknown; policies?: unknown; effect?: unknown; commit?: unknown;
  };
  const identity = parsePackIdentity(value);
  if (!Array.isArray(value.policies) || value.policies.length === 0) {
    throw new Error("pack manifest declares no policies");
  }
  return {
    id: identity.id,
    version: identity.version,
    effect: identity.effect,
    ...(identity.commit ? { commit: identity.commit } : {}),
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
  const raw = parsed as {
    id?: unknown; version?: unknown; policies?: unknown; effect?: unknown; commit?: unknown;
  };
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
    ...(identity.commit ? { commit: identity.commit } : {}),
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
  opts:
    | { only?: string[]; categories?: string[]; all?: boolean; merge?: boolean }
    | undefined,
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
  // An EXPRESSED selection wins, even when it is empty.
  //
  // `opts.only = []` means "install the pack, enable none of it" — which is what
  // the picker sends when somebody unticks everything and confirms. Testing
  // `picked.size > 0` made that indistinguishable from passing no flags at all,
  // so it fell through and installed the publisher's defaults: the exact
  // opposite of what was chosen, reported as "the pack's defaults". Presence of
  // the key is the signal, not its length.
  if (opts?.only !== undefined || opts?.categories?.length) {
    // `merge` separates the two callers that both arrive here with a list.
    //
    // The PICKER's list is the complete answer: what is ticked is what should
    // be on, and unticking everything means enable none — which is why an
    // expressed selection replaces at all, and must keep replacing.
    //
    // A FLAG is an addition. `policies add <pack> --category Git` on a pack
    // that is already installed means "also turn Git on", and replacing there
    // switched off everything the user had. Following the pack README's own
    // path — take the defaults, then add a category — left them with SIX
    // policies on where they had started with ten, silently, from a command
    // whose first word is `add`.
    //
    // Kept in the pack's declared order, which is the order everything else
    // presents them in.
    if (opts.merge && previouslyInstalled) {
      // Already the whole catalog. Adding to everything is everything, and
      // `null` is how "the whole pack" is recorded — materialising it into a
      // list here would freeze out any policy a later version adds.
      if (previous === null) return { enabled: null, reason: "carried" };
      for (const name of previous ?? []) picked.add(name);
      return { enabled: available.filter((n) => picked.has(n)), reason: "added" };
    }
    return { enabled: available.filter((n) => picked.has(n)), reason: "selected" };
  }

  // No selection expressed. An upgrade keeps whatever the machine already had —
  // switching a policy back on because the user did not repeat themselves is not
  // an upgrade.
  if (previouslyInstalled) {
    return { enabled: previous === null ? null : (previous ?? null), reason: "carried" };
  }
  return { enabled: policies.filter((p) => p.defaultEnabled).map((p) => p.name), reason: "defaults" };
}

export type SelectionReason = "all" | "selected" | "carried" | "defaults" | "added";

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
  opts?: PackAddOptions,
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
  const spec: PinnedPackSpec = { ...parsed, tag: await resolveSpecTag(parsed) };
  const resolvedFromLatest = parsed.tag === null;
  const fetched = await fetchPack(spec);
  // Checked here, before a byte is written and before the artifact is imported,
  // so a refusal leaves the machine exactly as it was — and on the RESOLVED tag
  // as well as a typed one, because a tagless add pins whatever
  // `releases/latest` pointed at and lands the same incoherent pair in
  // `installed.json` with nobody having typed it. Deliberately NOT in
  // `fetchPackPreview`: looking at a pack has to stay possible precisely so a
  // publisher can SEE the two values disagree.
  if (!packTagMatchesVersion(spec.tag, fetched.version)) {
    const fromTag = spec.tag.slice(spec.tag.lastIndexOf("/") + 1).replace(/^v/, "");
    const fix =
      `re-tag the release ${fetched.version} (a leading v is fine), or rebuild the pack with ` +
      `--version ${fromTag}`;
    throw new Error(
      `${fetched.id} was not installed: release tag ${spec.tag} does not match the version its ` +
        `manifest declares (${fetched.version}). ` +
        (resolvedFromLatest
          ? `That is the newest release of ${spec.owner}/${spec.repo}, so the release and the pack ` +
            `disagree at the source — ask the publisher to ${fix}.`
          : `Name the tag whose manifest says ${fetched.version}, or fix the pack: ${fix}.`),
    );
  }
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
    // Provenance, carried through from the manifest so `policies` and the
    // dashboard can say which source produced what is installed. NOT part of
    // verification — `sha256` above is the pin, and this is a label beside it.
    ...(fetched.commit ? { commit: fetched.commit } : {}),
    ...(fetched.effect ? { effect: fetched.effect } : {}),
    ...(enabled ? { enabled } : {}),
    // Omitted, not written as the full list, when the user did not narrow it.
    // An absent `clis` means "every agent", and it keeps meaning that when a
    // thirteenth CLI is supported — whereas a materialised list of twelve would
    // silently exclude the new one from every pack installed before it existed.
    //
    // A prior narrowing is CARRIED when this caller named none, for the same
    // reason `enabled` is: `upsertInstalled` replaces the row wholesale, so
    // writing nothing here threw the user's scope away. A pack scoped to Claude
    // silently started guarding all eleven agents on the next `policies add` —
    // the same shape as the bug `merge` fixes, in the widening direction, which
    // is the worse one: it over-enforces, on agents nobody chose.
    //
    // `merge === false` is the ONE caller this must not do it for. The picker
    // says "every agent" by leaving `clis` absent (pack-cli.ts, where a full
    // tick deliberately writes nothing) — so for it, absent is an ANSWER, and
    // carrying a prior narrowing would make widening back to all impossible.
    // Everywhere else absent means no opinion was expressed.
    ...(opts?.clis
      ? { clis: opts.clis }
      : opts?.merge !== false && prior?.clis
        ? { clis: prior.clis }
        : {}),
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

/**
 * The spellings of a pack id that `remove` accepts.
 *
 * Exactly one used to work — the stored id, byte for byte — and it was a form
 * shown nowhere on its own, so every spelling a user could SEE or had TYPED
 * failed:
 *
 *   add    failproofai/policies                stores `FailproofAI/policies`
 *   remove failproofai/policies                no installed pack with id …
 *   remove FailproofAI/policies@06b802b63f4f   no installed pack with id …
 *
 * The first is what they installed it with — GitHub is case-insensitive, so
 * `add` accepts any case and then records the CANONICAL id off the manifest.
 * The second is the listing's own heading, copied. Both are refused, and the
 * one that works appears only as half of that heading. A pack whose owner
 * happens to be lowercase (`chhhee10/deploy-guard`) removes on the first try,
 * which is what makes this look like the core pack being unremovable rather
 * than a name-matching bug.
 *
 * So: case-insensitive, and an `@<version>` suffix is dropped. A pack id cannot
 * contain `@` — `PACK_ID_RE` forbids it — so splitting at the last one is
 * unambiguous. The version is not checked against what is installed: there is
 * only ever one row per id, and refusing `pack@1.0.0` because 1.0.1 is
 * installed would be the same unhelpfulness in a new hat.
 */
function packIdMatches(stored: string, typed: string): boolean {
  const bare = (value: string): string => {
    const at = value.lastIndexOf("@");
    return (at > 0 ? value.slice(0, at) : value).trim().toLowerCase();
  };
  return bare(stored) === bare(typed);
}

/** The id actually removed — the CANONICAL one, not the spelling that was
 *  typed — or null when nothing matched. Callers report it back so a user who
 *  typed a different case learns the name the machine holds. */
export function removePack(id: string): string | null {
  const manifestPath = resolve(packsRoot(), "installed.json");
  if (!existsSync(manifestPath)) return null;
  let raw: { schemaVersion?: number; packs?: InstalledPackRecord[] };
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const packs = Array.isArray(raw.packs) ? raw.packs : [];
  const removed = packs.find((p) => p?.id && packIdMatches(p.id, id));
  const remaining = packs.filter((p) => p !== removed);
  if (!removed || remaining.length === packs.length) return null;
  // The artifact is left on disk deliberately: it is content-addressed and inert
  // once nothing points at it, so keeping it makes a re-add offline-safe. Same
  // choice the cloud reconciler makes.
  writeAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, packs: remaining }, null, 2) + "\n");
  return removed.id;
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
