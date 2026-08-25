/**
 * `failproofai policies add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { INTEGRATION_TYPES } from "./types";
import { PACK_VERSION_RE } from "./pack-manifest";
import { detectInstalledClis } from "./integrations";
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
  promptText,
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
const VALUE_FLAGS = new Set(["--only", "--policy", "--category", "--cli"]);

/** Find the positional source without mistaking a flag's separate value for it. */
export function packAddSource(rest: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (VALUE_FLAGS.has(rest[i])) consumed.add(i + 1);
  }
  return rest.find((arg, index) => !arg.startsWith("--") && !consumed.has(index));
}

/** Names taken by our own policies, so a selection can be checked before install. */
function selectionFrom(rest: string[]): {
  only?: string[];
  categories?: string[];
  all?: boolean;
  clis?: string[];
} {
  // `--policy` reads right for one ("give me this policy"), `--only` for a set.
  // They are the same switch; taking both means neither is the wrong guess.
  const only = parseList(rest, "--policy") ?? parseList(rest, "--only");
  const categories = parseList(rest, "--category");
  const clis = parseList(rest, "--cli");
  return {
    ...(only ? { only } : {}),
    ...(categories ? { categories } : {}),
    ...(clis ? { clis } : {}),
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


/**
 * Write a working starter policy, because the blank file is the hardest step.
 *
 * `publish --help` described the shape in prose, which leaves a newcomer to
 * hand-write their first `customPolicies.add({...})` from a description and
 * find out whether they got it right at publish time. What lands here is a
 * policy that already RUNS and already blocks something real, so the first
 * action is editing a working thing rather than authoring an empty one.
 */
async function scaffold(target: string | null): Promise<PackCliResult> {
  // Ask what the pack is called when nothing was named and there is somebody to
  // ask. The answer becomes the FILENAME and the header, so what lands on disk
  // is already theirs rather than a file called `my-policies.mjs` that everybody
  // then has to remember to rename. Skipped entirely for an explicit path or a
  // non-TTY, where there is no question to ask and no one to answer it.
  let chosen = target;
  if (!chosen && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await promptText({
      message: "What is this pack called?",
      hint: "used for the filename — letters, numbers, dashes",
      defaultValue: "my-policies",
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim())
          ? null
          : "letters, numbers, dots, dashes and underscores",
      stdin: process.stdin,
      stdout: process.stdout,
    });
    if (answer === null) return ok(["Nothing written."]);
    chosen = `./${answer.trim().replace(/\.(mjs|js|ts)$/, "")}.mjs`;
  }
  const path = resolve(chosen ?? "./my-policies.mjs");
  if (existsSync(path)) {
    return fail([`${path} already exists — name a different file, or edit that one.`]);
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { customPolicies, allow, deny } from "failproofai";

// One file, no relative imports: only this entry is digest-pinned, so a pack
// that imported siblings could not honestly claim to be verified.

customPolicies.add({
  name: "block-force-push",
  description: "Block git push --force on any branch",
  // Groups it in the picker, and is what --category selects on.
  category: "Git",
  // Whether it is ON for somebody who installs with no flags. Defaults to false.
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (/\\bgit\\s+push\\b[^|;&]*\\s(-f|--force)\\b/.test(cmd)) {
      return deny("Force-push rewrites history someone else may have pulled.");
    }
    return allow();
  },
});
`,
    "utf8",
  );
  return ok([
    `Wrote ${path} — one policy, already working.`,
    "",
    "Try it on this machine before anyone else sees it:",
    `  failproofai policies -i -c ${path}`,
    "  then ask your agent to force-push — it gets refused",
    "",
    "Then publish it:",
    `  failproofai publish ${path} --repo <you>/<repo> --version 1.0.0`,
  ]);
}

/**
 * The GitHub repository this file lives in, from its own git remote.
 *
 * Typing `--repo you/guards` from inside the checkout of `you/guards` is asking
 * somebody to restate what the directory already knows. Read from the ENTRY
 * FILE's directory rather than the process cwd: publishing a policy that lives
 * in another checkout is normal, and the answer must describe the file, not
 * wherever the shell happens to be.
 */
function inferRepo(entryPath: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: resolve(entryPath, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    // Both spellings git hands out: scp-style and https.
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * A tag on HEAD, when there is one and the file is clean.
 *
 * Somebody who tagged `v1.2.0` has SAID what this release is, which a counted
 * number cannot. Absent a tag there is nothing here to infer — the version is
 * counted from what the repository has already published instead.
 */
function inferTaggedVersion(entryPath: string): string | null {
  const cwd = resolve(entryPath, "..");
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
    } catch {
      return null;
    }
  };
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"]);
  if (!tag || !PACK_VERSION_RE.test(tag)) return null;
  // A tag NAMES a commit, so shipping edited bytes under it publishes something
  // that commit does not contain — and two artifacts would claim one version,
  // which `id|version|sha256` compares in both the audit key and the pack
  // upsert. A counted version names no commit and has no such problem, so this
  // refusal belongs to the tagged path alone.
  if (git(["status", "--porcelain", "--", entryPath])) return null;
  return tag;
}

/**
 * The policy file in this directory, when there is exactly one.
 *
 * Naming the path is restating something the directory already answers: a
 * checkout with one policy file in it has no ambiguity to resolve. So the
 * common case is `failproofai publish`, and the argument stays for the cases
 * that genuinely need it.
 *
 * Identified by CONTENT, not by filename. A name convention would either miss
 * `guards.mjs` or match an unrelated `policies.mjs` that configures something
 * else entirely; a file that imports `failproofai` and calls
 * `customPolicies.add` is a policy file whatever it is called.
 *
 * Returns ALL of them. Splitting policies across files is the normal thing to
 * do past about three, and they are one pack — so several files is an answer,
 * not an ambiguity, and they get bundled into the single artifact a pack must
 * be. Naming a path explicitly still publishes exactly that file.
 *
 * Non-recursive on purpose. Walking the tree finds fixtures, examples and
 * anything vendored, and publishing those is the failure this avoids.
 */
function findEntry(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (!/\.(mjs|js|ts)$/.test(name)) continue;
    const full = resolve(dir, name);
    try {
      // Policy entries are small; anything large is not one, and reading it
      // would be the expensive half of this scan.
      if (statSync(full).size > 512 * 1024) continue;
      const text = readFileSync(full, "utf8");
      if (/from\s+["']failproofai["']/.test(text) && /customPolicies\s*\.\s*add\s*\(/.test(text)) {
        found.push(full);
      }
    } catch {
      continue;
    }
  }
  return found.sort();
}

/**
 * The version after whatever this repository has already published.
 *
 * A commit SHA names exactly where bytes came from and tells a reader nothing
 * else: it does not order, so `a1b2c3d` and `f9e8d7c` give no clue which came
 * first, and nobody can say "I am on the older one". Counting instead — 1.0.0,
 * then 1.0.1 — costs one API call and answers both.
 *
 * Reads the repository's own releases rather than anything local, because the
 * releases ARE the published record: a machine that has never published from
 * this checkout still computes the right next number, and two people publishing
 * from different clones cannot both mint 1.0.1 without one of them seeing the
 * other's release first.
 *
 * Non-semver tags are ignored rather than parsed heroically — a repo whose
 * releases are named `nightly` has no sequence to continue, and starting a
 * fresh count is more honest than inventing one.
 */
async function nextVersion(owner: string, name: string, token: string): Promise<string> {
  const res = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases?per_page=100`, token);
  const tags = Array.isArray(res.json)
    ? (res.json as unknown as Array<{ tag_name?: unknown }>)
        .map((r) => (typeof r.tag_name === "string" ? r.tag_name : ""))
        .filter(Boolean)
    : [];
  let best: [number, number, number] | null = null;
  for (const tag of tags) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
    if (!m) continue;
    const parsed: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (
      !best ||
      parsed[0] > best[0] ||
      (parsed[0] === best[0] && parsed[1] > best[1]) ||
      (parsed[0] === best[0] && parsed[1] === best[1] && parsed[2] > best[2])
    ) {
      best = parsed;
    }
  }
  return best ? `${best[0]}.${best[1]}.${best[2] + 1}` : "1.0.0";
}

/**
 * The repository, created if it is not there.
 *
 * Creating it was the only step `publish` did not do, and the one that made
 * "one command" untrue — it sent the publisher to a different tool and back.
 *
 * PUBLIC, always. A private repository publishes to nobody, because installs
 * are anonymous HTTPS with no credential to offer, so creating one here would
 * manufacture the exact dead end the caller then warns about. Somebody who
 * wants a private pack makes it themselves and knows why.
 */
async function ensureRepo(
  owner: string,
  name: string,
  id: string,
  token: string,
): Promise<{ info: Awaited<ReturnType<typeof gh>>; created: boolean } | { error: string[] }> {
  let info = await gh(`${GITHUB_API}/repos/${owner}/${name}`, token);
  let created = false;
  if (info.status === 404) {
    // Personal and organisation repositories are different endpoints, and the
    // only way to tell which applies is to ask who the token belongs to.
    const me = await gh(`${GITHUB_API}/user`, token);
    const login = typeof me.json?.login === "string" ? me.json.login : null;
    const endpoint =
      login && login.toLowerCase() === owner.toLowerCase()
        ? `${GITHUB_API}/user/repos`
        : `${GITHUB_API}/orgs/${owner}/repos`;
    const made = await gh(endpoint, token, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        name,
        private: false,
        description: `failproofai policy pack — ${id}`,
        auto_init: true,
      }),
    });
    if (made.status >= 400) {
      return {
        error: [
          `${owner}/${name} does not exist and could not be created: ${ghError(made)}`,
          login
            ? `The credential belongs to ${login}. Creating under a different owner needs`
            : "The credential could not be identified. Creating a repository needs",
          "  rights to that account or organisation — or make it by hand:",
          `  gh repo create ${owner}/${name} --public`,
        ],
      };
    }
    created = true;
    info = await gh(`${GITHUB_API}/repos/${owner}/${name}`, token);
  }
  if (info.status >= 400) {
    return { error: [`Could not read ${owner}/${name}: ${ghError(info)}`] };
  }
  return { info, created };
}

/**
 * Where `bun` is, if it is anywhere.
 *
 * Bundling needs it, and a CLI installed from npm runs under node — so bun is
 * likely present (it is in `engines`) but never guaranteed. Checked in the
 * places it actually installs to, because `npm i -g bun` puts it in ONE nvm
 * version's bin dir and `nvm use` then drops it off PATH.
 */
function findBun(): string | null {
  const candidates = [
    "bun",
    process.env.BUN_INSTALL ? resolve(process.env.BUN_INSTALL, "bin", "bun") : null,
    resolve(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter((c): c is string => c !== null);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Collapse several policy files, or one that imports its neighbours, into the
 * single artifact a pack has to be.
 *
 * One entry file is a real constraint — only the entry is content-addressed, so
 * a multi-file pack could not honestly claim to be digest-pinned — but that is a
 * constraint on what gets PUBLISHED, not on how anybody writes. Splitting
 * policies across files is the normal thing to do past about three of them, and
 * telling someone to go and configure a bundler first is the tool refusing to do
 * the one mechanical step it already does for its own pack.
 *
 * `--external failproofai` because the loader supplies it: bundling our own
 * module into the artifact would ship a second copy of the registry, and
 * policies would register into an object nothing reads.
 */
function bundleEntry(
  sources: string[],
  outDir: string,
): { path: string } | { error: string[] } {
  const bun = findBun();
  if (!bun) {
    return {
      error: [
        sources.length > 1
          ? `${sources.length} policy files here, and bundling them needs bun, which is not installed.`
          : `${sources[0]} imports other files, and bundling needs bun, which is not installed.`,
        "Either install bun (https://bun.sh), bundle it yourself first —",
        "  esbuild <entry> --bundle --format=esm --external:failproofai --outfile=pack.mjs",
        "then publish the bundle — or name a single self-contained file.",
      ],
    };
  }
  mkdirSync(outDir, { recursive: true });
  // A generated entry that imports each file for its SIDE EFFECT: every policy
  // file registers by calling `customPolicies.add` at module scope, so importing
  // it is what puts the policies in the registry. Same shape as the generated
  // entry this repo builds its own pack from.
  const entry = resolve(outDir, ".entry.generated.mjs");
  writeFileSync(
    entry,
    sources.map((f) => `import ${JSON.stringify(f.startsWith("/") ? f : resolve(f))};`).join("\n") + "\n",
    "utf8",
  );
  const bundled = resolve(outDir, ".bundled.mjs");
  try {
    execFileSync(
      bun,
      ["build", "--target=node", "--format=esm", "--external", "failproofai",
       "--outfile", bundled, entry],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
  } catch (err) {
    const detail = err instanceof Error && "stderr" in err
      ? String((err as { stderr?: Buffer }).stderr ?? "").trim().split("\n").slice(0, 6)
      : [];
    return { error: [`Could not bundle those files:`, ...detail.map((l) => `  ${l}`)] };
  }
  return { path: bundled };
}

/**
 * The entry path among publish's arguments, and nothing that merely follows a
 * flag.
 *
 * `packAddSource` knows the flags `policies add` takes, not the ones `publish`
 * takes — so `publish --id me/x --version 1.0.0` read `me/x` as the file to
 * publish and failed on ENOENT. It only ever worked because every example wrote
 * the path first.
 */
const PUBLISH_VALUE_FLAGS = new Set([
  "--repo", "--version", "--id", "--tag", "--notes", "--out", "--effect", "--entry", "--init",
]);
function publishEntryArg(rest: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (PUBLISH_VALUE_FLAGS.has(rest[i])) consumed.add(i + 1);
  }
  return rest.find((a, i) => !a.startsWith("--") && !consumed.has(i));
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

  if (rest.includes("--init")) {
    return scaffold(flag("init") ?? publishEntryArg(rest) ?? null);
  }

  let entry = publishEntryArg(rest.filter((a) => a !== "--dry-run")) ?? flag("entry");
  // Every policy file here, bundled into one artifact below. Named explicitly,
  // it is that file and only that file.
  const discovered = entry ? [] : findEntry(process.cwd());
  if (!entry && discovered.length > 0) entry = discovered[0];
  const repo = flag("repo") ?? (entry ? inferRepo(entry) : null) ?? undefined;
  // A tag on HEAD is somebody SAYING what this release is, so it wins over a
  // counted one. Everything else is decided after the repository is known,
  // because the count comes from what that repository has already published.
  let version = flag("version") ?? (entry ? inferTaggedVersion(entry) : null) ?? undefined;
  let versionCounted = false;
  // The id and the repo are usually the same words, and requiring both is asking
  // the same question twice. Either one alone answers for the other.
  const id = flag("id") ?? repo;
  const dryRun = rest.includes("--dry-run") || !repo;
  const [owner, name] = (repo ?? "/").split("/");
  if (repo && (!owner || !name || repo.split("/").length !== 2)) {
    return fail([`--repo must be <owner>/<repo>, got ${JSON.stringify(repo)}`]);
  }

  if (!entry || !id) {
    return fail([
      "Usage: failproofai publish <entry.mjs> [--repo <owner>/<repo>] [--version <v>]",
      "",
      "Inside a git checkout with a github remote, both are inferred — the repo",
      "from the remote, the version from a tag on HEAD or the short commit SHA.",
      "Outside one, name them:",
      "       [--id <publisher/name>] [--tag <tag>] [--notes <text>]",
      "       [--out <dir>] [--effect enforce|observe] [--dry-run]",
      "",
      "With no --repo it writes the three release assets and stops.",
    ]);
  }

  // Check an EXPLICIT tag against an explicit version before anything reaches
  // the network. When the version is counted the tag simply follows it and can
  // never disagree — but a tag the user typed can, and refusing it here is what
  // stops a doomed publish from first creating a repository for itself.
  const explicitTag = flag("tag");
  if (explicitTag && version && !packTagMatchesVersion(explicitTag, version)) {
    return fail([
      `Tag ${explicitTag} does not describe version ${version}, so nobody could install it.`,
      `A pack is fetched from releases/download/${explicitTag}/… and then reports`,
      `${version} — which names no release. Use --tag ${version} (a leading v is`,
      "fine), or build the pack at the version the tag says.",
    ]);
  }

  // The version may still be unknown here: with nothing explicit and no tag, it
  // is one past whatever the repository has already published, which cannot be
  // known without asking it. So the credential and the repository come first —
  // the reverse of the old order, where building first avoided authenticating
  // for a pack that does not load. That trade is still paid: the build runs
  // immediately after, before anything is created or uploaded.
  let token: string | null = null;
  let created = false;
  let repoInfo: Awaited<ReturnType<typeof gh>> | null = null;
  if (!dryRun) {
    token = githubToken();
    if (!token) {
      return fail([
        "No GitHub credential found.",
        "Set GITHUB_TOKEN (or GH_TOKEN), or sign in once with `gh auth login`.",
        "It needs write access to releases on that repository, and nothing else.",
      ]);
    }
      const ensured = await ensureRepo(owner, name, id, token);
    if ("error" in ensured) return fail(ensured.error);
    created = ensured.created;
    repoInfo = ensured.info;
    if (!version) {
      version = await nextVersion(owner, name, token);
      versionCounted = true;
    }
  }
  // A dry run has nothing to count against, so it reports the first version. It
  // says so rather than implying the number is settled.
  if (!version) {
    version = "1.0.0";
    versionCounted = true;
  }

  const tag = flag("tag") ?? version;

  // One artifact, however many files it was written across. `build` refuses an
  // entry with relative imports because only the entry is digest-pinned — so
  // the fix is to make it ONE file here, not to send the author away to set up
  // a bundler for a step this tool already performs for its own pack.
  const outDirEarly = resolve(flag("out") ?? "dist-pack");
  let entryToBuild = entry;
  const needsBundle =
    discovered.length > 1 ||
    /(?:^|\n)\s*(?:import|export)[^;\n]*from\s+["']\.[^"']*["']/.test(
      readFileSync(entry, "utf8"),
    );
  if (needsBundle) {
    const sources = discovered.length > 1 ? discovered : [entry];
    const bundled = bundleEntry(sources, outDirEarly);
    if ("error" in bundled) return fail(bundled.error);
    entryToBuild = bundled.path;
  }

  const built = await build([entryToBuild, "--id", id, "--version", version, ...outFlagFrom(rest), ...effectFlagFrom(rest)]);
  if (built.exitCode !== 0) return built;

  const outDir = outDirEarly;
  const bundleNote =
    discovered.length > 1
      ? [`Bundled ${discovered.length} files into one artifact:`,
         ...discovered.map((f) => `  ${f.replace(process.cwd() + "/", "")}`), ""]
      : [];
  if (dryRun) {
    return ok([
      ...bundleNote,
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

  // Narrowed once: every path reaching here passed through the `!dryRun` branch
  // above, which returns when there is no credential.
  const auth = token as string;

  if (!packTagMatchesVersion(tag, version)) {
    return fail([
      `Tag ${tag} does not describe version ${version}, so nobody could install it.`,
      `A pack is fetched from releases/download/${tag}/… and then reports ${version} —`,
      `which names no release. Use --tag ${version} (a leading v is fine), or build`,
      "the pack at the version the tag says.",
    ]);
  }


  // A private repo is not a smaller audience, it is no audience: `pack add`
  // sends no Authorization header at all, by design, so every install 404s.
  const isPrivate = repoInfo?.json?.private === true;

  // Reuse a release on this tag rather than failing on it. Re-publishing a
  // corrected artifact under an existing tag is a normal thing to need, and the
  // digest change is visible to anyone who reinstalls.
  let releaseId: number | null = null;
  const existing = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag)}`, auth);
  if (existing.status === 200 && typeof existing.json?.id === "number") {
    releaseId = existing.json.id;
  } else {
    const created = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases`, auth, {
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
  const listed = await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/${releaseId}/assets?per_page=100`, auth);
  const already = Array.isArray(listed.json)
    ? (listed.json as unknown as Array<{ id: number; name: string }>)
    : [];
  for (const asset of assets) {
    // Asset names are fixed and the URL is constructed from them, so a stale
    // copy under the same name is what an installer would fetch. Replace, never
    // append.
    const prior = already.find((a) => a.name === asset);
    if (prior) {
      await gh(`${GITHUB_API}/repos/${owner}/${name}/releases/assets/${prior.id}`, auth, { method: "DELETE" });
    }
    const bytes = readFileSync(resolve(outDir, asset));
    const upload = await gh(
      `${GITHUB_UPLOADS}/repos/${owner}/${name}/releases/${releaseId}/assets?name=${encodeURIComponent(asset)}`,
      auth,
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
    ...bundleNote,
    ...(created ? [`Created ${repo} (public).`] : []),
    `Published ${id}@${version} to ${repo} at tag ${tag}.` +
      (versionCounted ? " Next publish will be one past it." : ""),
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

/**
 * Which agents should this pack guard?
 *
 * Asked BEFORE the policy list, because it is the coarser question and the
 * answer changes what the second screen is for. Setup no longer asks it: hooks
 * go into every supported agent, since hooks alone enforce nothing, so the
 * decision moved here — where the user is looking at a concrete pack instead of
 * answering in the abstract before anything is installed.
 *
 * Every supported agent is offered and all are pre-ticked. Detected ones are
 * marked, but an undetected agent is NOT excluded: installing one next week is
 * exactly the case setup's install-everywhere behaviour exists to cover, and a
 * pack that silently skipped it would undo that.
 *
 * Returns null when cancelled — distinct from picking every agent.
 */
async function pickClis(
  io: { stdin: TTYIn; stdout: TTYOut },
): Promise<string[] | null> {
  const detected = new Set(detectInstalledClis());
  const choices: MultiChoice<string>[] = INTEGRATION_TYPES.map((id) => ({
    label: id,
    value: id,
    checked: true,
    hint: detected.has(id) ? "installed here" : "",
  }));
  return multiSelect<string>({
    message: "Which agents should this pack guard?",
    choices,
    minSelected: 1,
    summaryNoun: "agents",
    hint: `space toggles · ctrl+a all · ↵ confirm · ${detected.size} detected on this machine`,
    stdin: io.stdin,
    stdout: io.stdout,
  });
}

/**
 * The pack's own list, defaults pre-ticked, before anything is installed.
 *
 * Reads the MANIFEST only — `fetchPackPreview` never downloads the entry
 * artifact — so the code of a pack you are still deciding about is never
 * fetched, let alone imported.
 *
 * Returns null when the user cancelled, which must not be confused with an
 * empty selection: one means "install nothing", the other means "do nothing".
 */
async function pickFromSource(
  source: string,
  io: { stdin: TTYIn; stdout: TTYOut },
): Promise<string[] | null> {
  const preview = await fetchPackPreview(source);
  const categories = [...new Set(preview.policies.map((p) => p.category))];
  const rows: MultiChoice<string>[] = [];
  for (const category of categories) {
    for (const policy of preview.policies.filter((p) => p.category === category)) {
      rows.push({
        label: policy.name,
        value: policy.name,
        hint: policy.description,
        checked: policy.defaultEnabled,
        section: `${category} · ${slugifyCategory(category)}`,
      });
    }
  }
  const on = preview.policies.filter((p) => p.defaultEnabled).length;
  const picked = await multiSelect<string>({
    message: `${preview.id}@${preview.version} — which of these should be on?`,
    choices: rows,
    summaryNoun: "policies",
    hint: `space toggles · ctrl+a all · ↵ confirm · ${on} of ${rows.length} are the publisher's defaults`,
    stdin: io.stdin,
    stdout: io.stdout,
  });
  return picked;
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

  // CHOOSE, then install. A pack's `defaultEnabled` flags are the publisher's
  // recommendation, and taking them silently turns a recommendation into a
  // decision made on the user's behalf — announced only afterwards, by which
  // point the policies are already on their machine.
  //
  // So a human at a terminal who named no flags gets the list first, with the
  // publisher's defaults pre-ticked. The manifest is read WITHOUT downloading
  // the entry artifact, so deciding about a stranger's pack still never runs a
  // stranger's code.
  //
  // Skipped entirely when a selection was passed (`--policy`, `--category`,
  // `--all`) or when there is no terminal: a script asked a precise question and
  // must get a precise answer, not a prompt it cannot see.
  const io = { stdin: process.stdin as TTYIn, stdout: process.stdout as TTYOut };
  const chose = !selection.only && !selection.categories && !selection.all;
  if (chose && io.stdin.isTTY && io.stdout.isTTY) {
    // Agents first, then policies. Coarse before fine, and the coarse answer is
    // the one somebody can give without reading thirty-eight descriptions.
    if (!selection.clis) {
      const agents = await pickClis(io);
      if (agents === null) return ok(["Nothing installed."]);
      // Every agent ticked is the same as not narrowing at all, and writing the
      // full list would freeze this pack out of any CLI supported later.
      if (agents.length < INTEGRATION_TYPES.length) selection.clis = agents;
    }
    const picked = await pickFromSource(resolvedSource!, io);
    if (picked === null) return ok(["Nothing installed."]);
    selection.only = picked;
    // An empty pick is a real answer — install the pack, enable none of it —
    // but `{only: []}` is indistinguishable from "no selection" downstream, so
    // it is carried as an explicit empty list the resolver can see.
    if (picked.length === 0) selection.only = [];
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
    // `summarise([])` is the empty string, which would print a line ending in a
    // colon and nothing else — the one outcome that most needs saying out loud,
    // rendered as if something had gone missing.
    lines.push(
      result.enabled.length === 0
        ? `  enabled (0/${result.available.length}, ${why}): none — the pack is installed and enforcing nothing`
        : `  enabled (${result.enabled.length}/${result.available.length}, ${why}): ${summarise(result.enabled)}`,
    );

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
