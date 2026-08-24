/**
 * `failproofai policies add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePackIdentity, parsePackPolicy, readInstalledPacks } from "./pack-manifest";
import {
  PACK_CHECKSUMS_ASSET,
  PACK_ENTRY_ASSET,
  PACK_MANIFEST_ASSET,
  addPack,
  checkPackArtifact,
  CORE_ALIASES,
  fetchPackPreview,
  CORE_SOURCE,
  packTagMatchesVersion,
  removePack,
  setPackPolicyEnabled,
  slugifyCategory,
} from "./pack-store";
import type { PolicyEffect } from "./cloud-managed-policies";
import { loadCustomHooks } from "./custom-hooks-loader";
import type { MultiChoice, TTYIn, TTYOut } from "./tui";
import {
  chip,
  emptyState,
  multiSelect,
  note,
  nextStep,
  optsFor,
  rows as kitRows,
  rule,
  stack,
  table,
  title,
  warning,
} from "./tui";

export interface PackCliResult {
  lines: string[];
  exitCode: number;
}

const ok = (lines: string[]): PackCliResult => ({ lines, exitCode: 0 });
const fail = (lines: string[]): PackCliResult => ({ lines, exitCode: 1 });

function parseList(rest: string[], flag: string): string[] | undefined {
  const idx = rest.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (idx === -1) return undefined;
  const raw = rest[idx].includes("=") ? rest[idx].split("=").slice(1).join("=") : rest[idx + 1];
  if (!raw || raw.startsWith("--")) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Flags that take a separate value, so it is never mistaken for the source. */
const VALUE_FLAGS = new Set(["--only", "--policy", "--category"]);

/** Find the positional source without mistaking a flag's separate value for it. */
export function packAddSource(rest: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (VALUE_FLAGS.has(rest[i])) consumed.add(i + 1);
  }
  return rest.find((arg, index) => !arg.startsWith("--") && !consumed.has(index));
}

/** Names taken by our own policies, so a selection can be checked before install. */
function selectionFrom(rest: string[]): { only?: string[]; categories?: string[]; all?: boolean } {
  // `--policy` reads right for one ("give me this policy"), `--only` for a set.
  // They are the same switch; taking both means neither is the wrong guess.
  const only = parseList(rest, "--policy") ?? parseList(rest, "--only");
  const categories = parseList(rest, "--category");
  return {
    ...(only ? { only } : {}),
    ...(categories ? { categories } : {}),
    ...(rest.includes("--all") ? { all: true } : {}),
  };
}

/** Name a handful, then say how many more and where to see them. A 37-name wall
 *  is not information, and a count alone is not either. */
function summarise(names: string[], limit = 6): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
}


/**
 * Turn a policy file into the three assets a GitHub release needs.
 *
 * The publishing side of the lane. Everything about what a pack IS was only
 * discoverable by reading `pack-manifest.ts` and this repo's own build script —
 * so a stranger who wanted to publish policies had to reverse-engineer a
 * manifest, a checksum file and an asset naming convention, and would find out
 * they got it wrong when somebody else's `pack add` refused it.
 *
 * It does NOT bundle. Only the ENTRY is content-addressed, so a pack whose entry
 * imports local files could not honestly claim to be digest-pinned — the digest
 * would cover one file out of several. A multi-file source must be bundled by
 * its author first (esbuild, bun, rollup); this refuses it rather than shipping
 * a promise it cannot keep. Not bundling here also keeps the command runnable on
 * plain node, which is what the published CLI is.
 *
 * Every policy is validated with `parsePackPolicy` — the LOADER's own rules — so
 * a pack that could never install fails here, where the author can fix it,
 * rather than on a stranger's machine.
 */
async function build(rest: string[]): Promise<PackCliResult> {
  const flag = (name: string): string | undefined => {
    const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i === -1) return undefined;
    return rest[i].includes("=") ? rest[i].split("=").slice(1).join("=") : rest[i + 1];
  };
  const entry = packAddSource(rest) ?? flag("entry");
  const id = flag("id");
  const version = flag("version");
  const effect = flag("effect") ?? "enforce";
  const outDir = resolve(flag("out") ?? "dist-pack");

  if (!entry || !id || !version) {
    return fail([
      "Usage: failproofai publish <entry.mjs> --repo <owner>/<repo> --version <version>",
      "       [--out <dir>] [--effect enforce|observe]",
    ]);
  }
  let identity: { id: string; version: string; effect: PolicyEffect };
  try {
    identity = parsePackIdentity({ id, version, effect });
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }

  const entryPath = resolve(entry);
  if (!existsSync(entryPath)) return fail([`No such file: ${entryPath}`]);

  // Refused rather than bundled: see the note above. A relative specifier is the
  // only kind that would be rewritten by the loader and left outside the digest.
  const source = readFileSync(entryPath, "utf8");
  const localImport = /(?:^|\n)\s*(?:import|export)[^;\n]*from\s+["'](\.[^"']*)["']/.exec(source);
  if (localImport) {
    return fail([
      `${entryPath} imports ${localImport[1]}, and only the entry file is digest-pinned.`,
      "Bundle it to a single file first (esbuild, bun build, rollup), then build the pack from that.",
    ]);
  }

  let hooks;
  try {
    hooks = await loadCustomHooks(entryPath, { strict: true });
  } catch (err) {
    return fail([`Could not load ${entryPath}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  if (hooks.length === 0) {
    return fail([
      `${entryPath} registered no policies.`,
      "A pack entry calls customPolicies.add({ name, description, match, fn }) for each one.",
    ]);
  }

  const policies: unknown[] = [];
  for (const [index, hook] of hooks.entries()) {
    // `category` and `defaultEnabled` are pack-manifest fields a plain custom
    // policy has no reason to carry, so they are read off the registration when
    // the author set them and defaulted when not. `defaultEnabled` defaults to
    // FALSE: a pack's declared defaults are what `pack add` switches on with no
    // flags, and switching on a stranger's every policy unattended is the
    // installer opinion this lane already refused once.
    const extra = hook as unknown as { category?: unknown; defaultEnabled?: unknown };
    const candidate = {
      name: hook.name,
      description: hook.description ?? "",
      category: typeof extra.category === "string" && extra.category ? extra.category : "General",
      defaultEnabled: extra.defaultEnabled === true,
      match: hook.match ?? {},
    };
    try {
      policies.push(parsePackPolicy(identity.id, candidate, index));
    } catch (err) {
      return fail([err instanceof Error ? err.message : String(err)]);
    }
  }

  const manifest =
    JSON.stringify(
      { id: identity.id, version: identity.version, effect: identity.effect, policies },
      null,
      2,
    ) + "\n";
  mkdirSync(outDir, { recursive: true });
  const manifestPath = resolve(outDir, PACK_MANIFEST_ASSET);
  const entryOut = resolve(outDir, PACK_ENTRY_ASSET);
  writeFileSync(manifestPath, manifest, "utf8");
  copyFileSync(entryPath, entryOut);
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    resolve(outDir, PACK_CHECKSUMS_ASSET),
    `${sha(manifest)}  ${PACK_MANIFEST_ASSET}\n${sha(readFileSync(entryOut))}  ${PACK_ENTRY_ASSET}\n`,
    "utf8",
  );

  const on = policies.filter((p) => (p as { defaultEnabled?: boolean }).defaultEnabled).length;
  return ok([
    `Built ${identity.id}@${identity.version} — ${policies.length} policies, ${on} on by default.`,
    `  ${outDir}/${PACK_MANIFEST_ASSET}`,
    `  ${outDir}/${PACK_ENTRY_ASSET}`,
    `  ${outDir}/${PACK_CHECKSUMS_ASSET}`,
    "",
    `Publish: attach all three to a GitHub release tagged ${identity.version}, then anyone runs:`,
    `  failproofai policies add <owner>/<repo>`,
  ]);
}

/**
 * The list, with what is already on ticked, for `failproofai policies add` with
 * nothing after it.
 *
 * Naming nothing used to be an error — "Missing policy name", followed by an
 * instruction to go and read a list somewhere else and come back. That is the
 * command telling the user to do the work it is for. The same objection applies
 * to `pack add` taking a publisher's defaults and only afterwards printing what
 * it decided: a default is a suggestion, and a suggestion the user never saw is
 * just a decision taken on their behalf.
 *
 * So this is one screen showing every policy on the machine, grouped by pack and
 * category, with the current state pre-ticked. It edits the enabled SET — there
 * is no separate "remove" screen, because choosing what is on and choosing what
 * is off are the same act.
 *
 * Refuses rather than guesses when there is no terminal to draw on. `multiSelect`
 * degrades by returning its pre-checked set, which here would mean "confirm
 * exactly what is already true" — a silent no-op reported as a success. A script
 * that lands in this branch asked the wrong question and should be told so.
 */
export async function runPolicyPicker(
  action: "add" | "remove",
  io: { stdin?: TTYIn; stdout?: TTYOut } = {},
): Promise<PackCliResult> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const opts = optsFor(stdout as NodeJS.WriteStream);
  const { packs } = readInstalledPacks();

  if (!stdin.isTTY || !stdout.isTTY) {
    return fail([
      `\`policies ${action}\` with no name needs a terminal to show you the list.`,
      "From a script, name what you mean:",
      `  failproofai policies ${action} <policy-name>`,
      `  failproofai policies ${action} <owner>/<repo> [--policy a,b] [--category x,y] [--all]`,
    ]);
  }

  if (packs.length === 0) {
    return ok(
      stack(
        emptyState(
          {
            what: "No policies are installed yet.",
            hint: "Take ours, or anyone's:",
            cmd: "failproofai policies add core",
          },
          opts,
        ),
        note("Someone else's:  failproofai policies add <owner>/<repo>", opts),
        note("Look first:      failproofai policies show <owner>/<repo>", opts),
      ),
    );
  }

  // One row per policy across every pack. The pack id leads the section heading
  // because two packs may legitimately ship a category of the same name, and a
  // row that says only "Data" would not tell you whose Data it is.
  const rows: MultiChoice<string>[] = [];
  const owner = new Map<string, string>();
  for (const pack of packs) {
    const taken = new Set(pack.enabled ?? pack.policies.map((pol) => pol.name));
    const categories = [...new Set(pack.policies.map((pol) => pol.category))];
    for (const category of categories) {
      for (const pol of pack.policies.filter((x) => x.category === category)) {
        // Keyed by name, not by pack+name: a name collision across two packs is
        // already impossible to enforce unambiguously, and silently editing the
        // wrong pack's copy would be worse than the collision.
        owner.set(pol.name, pack.id);
        rows.push({
          label: pol.name,
          value: pol.name,
          hint: pol.description,
          checked: taken.has(pol.name),
          section: `${pack.id} · ${category}`,
        });
      }
    }
  }

  const before = new Set(rows.filter((r) => r.checked).map((r) => r.value));
  const picked = await multiSelect<string>({
    message: "Which policies should be on?",
    choices: rows,
    summaryNoun: "policies",
    hint: "space toggles · ctrl+a all · ↵ confirm · what is on now is ticked",
    stdin,
    stdout,
  });
  if (picked === null) return ok(["Nothing changed."]);

  const after = new Set(picked);
  const turnedOn = [...after].filter((n) => !before.has(n));
  const turnedOff = [...before].filter((n) => !after.has(n));
  if (turnedOn.length === 0 && turnedOff.length === 0) {
    return ok([`Nothing changed — ${after.size} of ${rows.length} still on.`]);
  }

  const failures: string[] = [];
  for (const name of [...turnedOn, ...turnedOff]) {
    const packId = owner.get(name);
    if (!packId) continue;
    const result = setPackPolicyEnabled(packId, name, after.has(name));
    if (!result.ok) failures.push(`${name}: ${result.reason ?? "could not be written"}`);
  }
  if (failures.length > 0) {
    return fail(["Some policies could not be changed:", ...failures.map((f) => `  ${f}`)]);
  }

  const lines = [`${after.size} of ${rows.length} policies on.`];
  if (turnedOn.length > 0) lines.push(`  turned on (${turnedOn.length}): ${summarise(turnedOn)}`);
  if (turnedOff.length > 0) lines.push(`  turned off (${turnedOff.length}): ${summarise(turnedOff)}`);
  return ok(lines);
}


// ── publish ───────────────────────────────────────────────────────────────

const GITHUB_API = process.env.FAILPROOFAI_GITHUB_API ?? "https://api.github.com";
const GITHUB_UPLOADS = process.env.FAILPROOFAI_GITHUB_UPLOADS ?? "https://uploads.github.com";

/**
 * The credential, from the places a developer already keeps one.
 *
 * `gh auth token` is READ-ONLY and is deliberately not one of the subcommands
 * `block-gh-pipeline` matches — which is exactly why the release itself goes
 * over REST rather than through `gh release create`: that one IS matched, so a
 * user with our own policy switched on could not publish with a gh-shaped
 * implementation. Shipping a publish path our own guardrail blocks is not a
 * thing to do.
 *
 * Never returned in any message. A token that reaches stdout reaches CI logs.
 */
function githubToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function gh(
  url: string,
  token: string,
  init: { method?: string; body?: BodyInit; contentType?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "failproofai",
      ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    },
    ...(init.body ? { body: init.body } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** GitHub's error bodies are shaped `{message, errors:[{code,field}]}`; the bare
 *  `message` alone is frequently just "Validation Failed". */
function ghError(res: { status: number; json: Record<string, unknown> | null; text: string }): string {
  const message = typeof res.json?.message === "string" ? res.json.message : res.text.slice(0, 200);
  const errors = Array.isArray(res.json?.errors)
    ? (res.json.errors as Array<Record<string, unknown>>)
        .map((e) => [e.field, e.code].filter(Boolean).join(" "))
        .filter(Boolean)
    : [];
  return errors.length > 0 ? `${message} (${errors.join("; ")})` : message;
}

/**
 * Build the assets AND put them on a GitHub release, in one command.
 *
 * Publishing used to be four commands, and two of them did nothing: `git init`,
 * `git add`, `git commit`, `gh repo create`, `gh release create`. Only the last
 * one publishes — installs read `releases/download/<tag>/<asset>` and never
 * touch the git tree, so pushing source is for humans reading it, not for the
 * install to work. A publisher had to discover that by reading `pack-store.ts`.
 *
 * With no `--repo` this is exactly the old `pack build`: write the three assets
 * and stop. That is what `pack build` now resolves to, so the old command keeps
 * working and means the same thing.
 *
 * Two failures the manual flow let through silently, both refused here:
 *   - a tag that does not describe the manifest version, which installs and then
 *     reports a version matching no URL;
 *   - a private repository, which publishes to nobody, because installs are
 *     anonymous HTTPS with no credential to offer.
 */
async function publish(rest: string[]): Promise<PackCliResult> {
  const flag = (name: string): string | undefined => {
    const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i === -1) return undefined;
    return rest[i].includes("=") ? rest[i].split("=").slice(1).join("=") : rest[i + 1];
  };

  const repo = flag("repo");
  const version = flag("version");
  const entry = packAddSource(rest.filter((a) => a !== "--dry-run")) ?? flag("entry");
  // The id and the repo are usually the same words, and requiring both is asking
  // the same question twice. Either one alone answers for the other.
  const id = flag("id") ?? repo;
  const tag = flag("tag") ?? version;
  const dryRun = rest.includes("--dry-run") || !repo;

  if (!entry || !version || !id) {
    return fail([
      "Usage: failproofai publish <entry.mjs> --repo <owner>/<repo> --version <version>",
      "       [--id <publisher/name>] [--tag <tag>] [--notes <text>]",
      "       [--out <dir>] [--effect enforce|observe] [--dry-run]",
      "",
      "With no --repo it writes the three release assets and stops.",
    ]);
  }

  // Build first, always. There is no point authenticating against GitHub to
  // discover the pack does not load.
  const built = await build([entry, "--id", id, "--version", version, ...outFlagFrom(rest), ...effectFlagFrom(rest)]);
  if (built.exitCode !== 0) return built;

  const outDir = resolve(flag("out") ?? "dist-pack");
  if (dryRun) {
    return ok([
      ...built.lines.slice(0, 4),
      "",
      ...(repo
        ? ["Dry run — nothing was published.", `Drop --dry-run to release it on ${repo}.`]
        : [
            "Nothing was published: name a repository to release it on.",
            `  failproofai publish ${entry} --repo <owner>/<repo> --version ${version}`,
          ]),
    ]);
  }

  if (!packTagMatchesVersion(tag!, version)) {
    return fail([
      `Tag ${tag} does not describe version ${version}, so nobody could install it.`,
      `A pack is fetched from releases/download/${tag}/… and then reports ${version} —`,
      `which names no release. Use --tag ${version} (a leading v is fine), or build`,
      "the pack at the version the tag says.",
    ]);
  }

  const [owner, name] = repo!.split("/");
  if (!owner || !name || repo!.split("/").length !== 2) {
    return fail([`--repo must be <owner>/<repo>, got ${JSON.stringify(repo)}`]);
  }

  const token = githubToken();
  if (!token) {
    return fail([
      "No GitHub credential found.",
      "Set GITHUB_TOKEN (or GH_TOKEN), or sign in once with `gh auth login`.",
      "It needs write access to releases on that repository, and nothing else.",
    ]);
  }

  const repoInfo = await gh(`${GITHUB_API}/repos/${owner}/${name}`, token);
  if (repoInfo.status === 404) {
    return fail([
      `${repo} does not exist, or that credential cannot see it.`,
      `Create it first:  gh repo create ${repo} --public`,
    ]);
  }
  if (repoInfo.status >= 400) return fail([`Could not read ${repo}: ${ghError(repoInfo)}`]);
  // A private repo is not a smaller audience, it is no audience: `pack add`
  // sends no Authorization header at all, by design, so every install 404s.
  const isPrivate = repoInfo.json?.private === true;

  // Reuse a release on this tag rather than failing on it. Re-publishing a
  // corrected artifact under an existing tag is a normal thing to need, and the
  // digest change is visible to anyone who reinstalls.
  let releaseId: number | null = null;
  const existing = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag!)}`, token);
  if (existing.status === 200 && typeof existing.json?.id === "number") {
    releaseId = existing.json.id;
  } else {
    const created = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases`, token, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        tag_name: tag,
        name: `${id} ${version}`,
        body: flag("notes") ?? `${id}@${version}`,
        // A prerelease is invisible to `releases/latest`, which is how a tagless
        // `policies add owner/repo` resolves a version — so publishing one would
        // make the pack installable only by people who already knew its tag.
        prerelease: false,
        draft: false,
      }),
    });
    if (created.status >= 400 || typeof created.json?.id !== "number") {
      return fail([`Could not create the release on ${repo}: ${ghError(created)}`]);
    }
    releaseId = created.json.id;
  }

  const assets = [PACK_MANIFEST_ASSET, PACK_ENTRY_ASSET, PACK_CHECKSUMS_ASSET];
  const uploaded: string[] = [];
  const listed = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/${releaseId}/assets?per_page=100`, token);
  const already = Array.isArray(listed.json)
    ? (listed.json as unknown as Array<{ id: number; name: string }>)
    : [];
  for (const asset of assets) {
    // Asset names are fixed and the URL is constructed from them, so a stale
    // copy under the same name is what an installer would fetch. Replace, never
    // append.
    const prior = already.find((a) => a.name === asset);
    if (prior) {
      await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/assets/${prior.id}`, token, { method: "DELETE" });
    }
    const bytes = readFileSync(resolve(outDir, asset));
    const upload = await gh(
      `${GITHUB_UPLOADS}/repos/${owner}/${name}/releases/${releaseId}/assets?name=${encodeURIComponent(asset)}`,
      token,
      {
        method: "POST",
        contentType: asset.endsWith(".json") ? "application/json" : "application/octet-stream",
        body: new Uint8Array(bytes),
      },
    );
    if (upload.status >= 400) {
      return fail([
        `Uploaded ${uploaded.length} of ${assets.length} assets, then ${asset} failed: ${ghError(upload)}`,
        `The release exists but is INCOMPLETE — an install would fail on the missing asset.`,
        `Re-run the same command; existing assets are replaced, not duplicated.`,
      ]);
    }
    uploaded.push(asset);
  }

  const lines = [
    `Published ${id}@${version} to ${repo} at tag ${tag}.`,
    `  ${assets.length} assets attached`,
    "",
    "Anyone can now install it:",
    `  failproofai policies add ${repo}`,
    `  failproofai policies show ${repo}      (look first, without running it)`,
  ];
  if (isPrivate) {
    lines.push(
      "",
      `WARNING: ${repo} is PRIVATE, so nobody can install this.`,
      "Installs are anonymous HTTPS with no credential to offer — every one will 404.",
      `Make it public:  gh repo edit ${repo} --visibility public`,
    );
  }
  return ok(lines);
}

/** Pass --out through to build without re-parsing it. */
function outFlagFrom(rest: string[]): string[] {
  const i = rest.findIndex((a) => a === "--out" || a.startsWith("--out="));
  if (i === -1) return [];
  return rest[i].includes("=") ? [rest[i]] : [rest[i], rest[i + 1]];
}
function effectFlagFrom(rest: string[]): string[] {
  const i = rest.findIndex((a) => a === "--effect" || a.startsWith("--effect="));
  if (i === -1) return [];
  return rest[i].includes("=") ? [rest[i]] : [rest[i], rest[i + 1]];
}

/** `failproofai publish` — exported for bin/failproofai.mjs and the tests. */
export async function runPublishCommand(rest: string[]): Promise<PackCliResult> {
  return publish(rest);
}

async function add(rest: string[]): Promise<PackCliResult> {
  const source = packAddSource(rest);
  const selection = selectionFrom(rest);

  // Our own pack, by the short name. `core` is a SPELLING of a GitHub source,
  // not a second delivery path: it resolves to CORE_SOURCE and is fetched,
  // verified and pinned exactly like anybody else's.
  //
  // The package used to carry a copy so this worked with no network. It no
  // longer does, on purpose. A pack that ships inside the binary is a policy set
  // we picked for you and wrote to your disk before you asked for it, and it
  // gave our own policies a route no third-party pack could use — which is the
  // opposite of the thing this whole lane exists to make possible.
  const resolvedSource =
    source && CORE_ALIASES.has(source.toLowerCase()) ? CORE_SOURCE : source;

  if (!resolvedSource) {
    return fail(["Usage: failproofai policies add <source> [--policy a,b] [--category x,y] [--all]"]);
  }
  if (selection.only && selection.only.length === 0) {
    return fail(["--policy needs at least one policy name, comma-separated"]);
  }
  if (selection.categories && selection.categories.length === 0) {
    return fail(["--category needs at least one category, comma-separated"]);
  }

  try {
    const result = await addPack(resolvedSource!, selection);
    const lines = [
      ...(result.replaced?.length
        ? [`Replaced ${result.replaced.join(", ")} — same policies under a new name; your selection was kept.`]
        : []),
      result.resolvedFromLatest
        ? `Installed ${result.id}@${result.version} from ${result.source} (newest release; pinned to ${result.tag})`
        : `Installed ${result.id}@${result.version} from ${result.source}`,
    ];
    const skipped = result.available.filter((n) => !result.enabled.includes(n));

    // Say WHY this set is on. Without it, "10 of 38 enabled" reads like
    // something went wrong rather than like the pack's own recommendation.
    const why = {
      defaults: "the pack's defaults",
      selected: "your selection",
      carried: "your existing selection",
      all: "everything in the pack",
    }[result.selection];
    lines.push(`  enabled (${result.enabled.length}/${result.available.length}, ${why}): ${summarise(result.enabled)}`);

    if (skipped.length > 0) {
      lines.push(`  not enabled (${skipped.length}): ${summarise(skipped)}`);
      lines.push("");
      lines.push(`  see all:      failproofai policies`);
      // Naming --policy here as well as the coarser two: it is the flag people
      // reach for first ("just give me that one"), and it was only ever
      // suggested on the branch that installed our own pack from disk — so
      // every third-party pack told you about categories and everything, and
      // never about taking a single policy.
      lines.push(`  one policy:   failproofai policies add ${source} --policy ${skipped[0]}`);
      if (result.categories.length > 0) {
        lines.push(`  by category:  failproofai policies add ${source} --category ${result.categories.slice(0, 3).join(",")}`);
      }
      lines.push(`  everything:   failproofai policies add ${source} --all`);
    }
    return ok(lines);
  } catch (err) {
    return fail([`Could not install pack: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

function remove(rest: string[]): PackCliResult {
  const id = rest[0];
  if (!id) return fail(["Usage: failproofai policies remove <publisher/name>"]);
  if (!removePack(id)) return fail([`No installed pack with id ${id}`]);
  return ok([
    `Removed ${id}. Its policies stop enforcing now; re-add it any time with the same command.`,
  ]);
}

/**
 * What a pack CONTAINS, for a pack this machine has not installed.
 *
 * `failproofai policies` already lists everything installed, packs included, so
 * the only thing missing was the pack you are still deciding about. Reading the
 * manifest answers that without installing it — and deliberately without
 * downloading or importing the entry artifact, so looking at a stranger's pack
 * cannot run a stranger's code.
 */
async function listRemote(source: string): Promise<PackCliResult> {
  const opts = optsFor(process.stdout);
  let preview;
  try {
    preview = await fetchPackPreview(source);
  } catch (err) {
    return fail([`Could not read ${source}: ${err instanceof Error ? err.message : String(err)}`]);
  }

  const defaults = preview.policies.filter((p) => p.defaultEnabled);
  const categories = [...new Set(preview.policies.map((p) => p.category))];
  const rows: Array<string[] | { section: string }> = [];
  for (const category of categories) {
    const inCategory = preview.policies.filter((p) => p.category === category);
    const on = inCategory.filter((p) => p.defaultEnabled).length;
    rows.push({
      section: `${category} — ${on}/${inCategory.length} on by default · ${slugifyCategory(category)}`,
    });
    for (const policy of inCategory) {
      // The publisher's DEFAULTS, not a machine's state — this pack is not
      // installed, so a row claiming ON would be describing nothing.
      rows.push([
        policy.defaultEnabled ? "default" : "opt-in",
        policy.name,
        policy.description,
      ]);
    }
  }

  return ok(
    stack(
      title(
        `${preview.id}@${preview.version}`,
        `${preview.policies.length} policies · ${categories.length} categories`,
        opts,
      ),
      note(
        `Not installed. ${defaults.length} of ${preview.policies.length} are on by default; the rest are opt-in.` +
          (preview.effect === "observe" ? " This pack OBSERVES — it records and blocks nothing." : ""),
        opts,
      ),
      preview.resolvedFromLatest ? note(`Newest release: ${preview.source}`, opts) : null,
      table({ head: ["", "", ""], rows }, opts),
      nextStep(`failproofai policies add ${source}`, "Install the defaults with:", opts),
      note("Or take part of it: --policy <a,b>, --category <x,y>, --all", opts),
    ),
  );
}

async function list(): Promise<PackCliResult> {
  const { packs, errors } = readInstalledPacks();
  const opts = optsFor(process.stdout);
  const policyCount = packs.reduce((n, pack) => n + pack.policies.length, 0);
  const head = title(
    "failproofai policies",
    packs.length === 0
      ? undefined
      : `${packs.length} pack${packs.length === 1 ? "" : "s"} · ${policyCount} policies`,
    opts,
  );

  if (packs.length === 0 && errors.length === 0) {
    return ok(
      stack(
        head,
        emptyState(
          {
            what: "No packs installed.",
            hint: "Install one with:",
            cmd: "failproofai policies add github:owner/repo@tag",
          },
          opts,
        ),
      ),
    );
  }

  const groups: Array<string[] | null> = [head];
  const broken: string[] = [];
  for (const pack of packs) {
    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    // Importing it is the only way to know it still loads. A listing that reads
    // healthy while the machine is denying every tool call because of this pack
    // is worse than no listing.
    const failure = await checkPackArtifact(pack.path, pack.policies.map((p) => p.name));
    if (failure) broken.push(`${pack.id}@${pack.version} ${failure}`);
    groups.push(rule(`${pack.id}@${pack.version}`, opts));
    groups.push(
      kitRows(
        [
          ["source", pack.source],
          ["digest", `${pack.sha256.slice(0, 16)}…`],
          ["effect", pack.effect],
          ["enabled", `${taken.length}/${pack.policies.length}`],
          ...(failure ? ([["health", "WILL NOT LOAD"]] as Array<[string, string]>) : []),
        ],
        opts,
      ),
    );
    // The category is a COLUMN rather than a set of sub-headings because it is
    // what `--category` selects on: seeing the slug next to every policy is what
    // tells someone the flag exists, and the suggestion below spells it out.
    // Four columns leave a description about 24 characters wide on an
    // 80-column terminal, which is not a description. Below 100 the category
    // column goes and its slugs are named once underneath instead.
    const wide = opts.cols >= 100;
    groups.push(
      table(
        {
          head: wide ? ["", "Policy", "Category", "Description"] : ["", "Policy", "Description"],
          rows: pack.policies.map((policy) =>
            wide
              ? [
                  chip(taken.includes(policy.name) ? "on" : "off", opts),
                  policy.name,
                  policy.category,
                  policy.description,
                ]
              : [
                  chip(taken.includes(policy.name) ? "on" : "off", opts),
                  policy.name,
                  policy.description,
                ],
          ),
        },
        opts,
      ),
    );
    const slugs = [...new Set(pack.policies.map((p) => slugifyCategory(p.category)))];
    if (!wide && slugs.length > 0) {
      groups.push(note(`Categories: ${slugs.join(", ")}`, opts));
    }
    // The RECORDED SOURCE, never the manifest id. `failproofai/builtins` is an
    // id, not a repository, so suggesting `pack add failproofai/builtins` hands
    // the user a command that resolves nothing. A `bundled:` pack came off the
    // package rather than a release and has no `pack add` form at all.
    const source = pack.source.startsWith("bundled:") ? null : pack.source;
    if (source && taken.length < pack.policies.length && slugs.length > 0) {
      groups.push(
        nextStep(
          `failproofai policies add ${source} --category ${slugs.slice(0, 3).join(",")}`,
          "Take a whole category with:",
          opts,
        ),
      );
    }
  }

  // Never silent: a pack that was installed and now refuses to load is exactly
  // the state someone needs told about, since the machine is enforcing less
  // than its manifest says.
  if (errors.length > 0) {
    groups.push(
      warning(
        errors.map((err) => `NOT LOADED  ${err.id ?? "(unnamed)"}: ${err.reason}`),
        opts,
      ),
    );
  }

  if (broken.length > 0) {
    groups.push(
      warning(
        [
          ...broken,
          "This machine denies the events those policies covered until it is fixed.",
        ],
        opts,
      ),
    );
  }
  const lines = stack(...groups);
  return errors.length > 0 || broken.length > 0 ? fail(lines) : ok(lines);
}

export async function runPackCommand(argv: string[]): Promise<PackCliResult> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return add(rest);
    case "remove":
      return remove(rest);
    case "build":
      return build(rest);
    case "list":
    case undefined: {
      // `pack list` is what is installed here; `pack list <source>` is what a
      // pack out there contains.
      const source = packAddSource(rest);
      return source ? listRemote(source) : list();
    }
    default:
      return fail([`Unknown pack subcommand ${JSON.stringify(sub)}`, "Try: add, remove, list, build"]);
  }
}
