/**
 * `failproofai policies add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { INTEGRATION_TYPES } from "./types";
import { PACK_COMMIT_RE, PACK_VERSION_RE } from "./pack-manifest";
import { detectInstalledClis } from "./integrations";
import { parsePackIdentity, parsePackPolicy, readInstalledPacks } from "./pack-manifest";
import {
  AmbiguousPackId,
  PACK_CHECKSUMS_ASSET,
  PACK_ENTRY_ASSET,
  PACK_MANIFEST_ASSET,
  addPack,
  checkPackArtifact,
  fetchPackPreview,
  packTagMatchesVersion,
  parsePackSpec,
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
  /**
   * What a successful `build` produced, for a caller that has to describe it
   * somewhere other than the terminal — today only `publish`, writing the
   * release body. Carried on the RESULT rather than recomputed by the caller,
   * because recomputing means re-deriving `defaultEnabled` from a second copy
   * of the same rule, and the two copies drift.
   */
  meta?: PackBuildMeta;
}

export interface PackBuildMeta {
  policies: number;
  defaultOn: number;
  commit?: string;
}

const ok = (lines: string[], meta?: PackBuildMeta): PackCliResult => ({
  lines,
  exitCode: 0,
  ...(meta ? { meta } : {}),
});
const fail = (lines: string[]): PackCliResult => ({ lines, exitCode: 1 });

function parseList(rest: string[], flag: string): string[] | undefined {
  const idx = rest.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (idx === -1) return undefined;
  const raw = rest[idx].includes("=") ? rest[idx].split("=").slice(1).join("=") : rest[idx + 1];
  if (!raw || raw.startsWith("--")) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Flags that take a separate value, so it is never mistaken for the source.
 *
 * Must list every flag that can REACH this lane, not just the ones this lane
 * acts on. `--scope` and `--custom` are handled by the caller and passed
 * through untouched — and their values were being read as the pack to install,
 * so `policies add --scope project acme/x` tried to fetch a pack called
 * "project". A flag this file ignores still has a value this file must skip.
 */
const VALUE_FLAGS = new Set([
  "--only",
  "--policy",
  "--category",
  "--cli",
  "--scope",
  "--custom",
  "-c",
]);

/**
 * Every index `--cli` claims, so the source is not found among its values.
 *
 * `--cli` is the one flag that takes MORE than one token, because the other
 * lane spells it `--cli claude codex` and somebody typing that here should not
 * be quietly given a different answer. Shared with `packAddSource` so the two
 * agree by construction: a token consumed as a CLI name is never also read as
 * the pack to install.
 */
/**
 * Could this token be an agent name rather than the pack to install?
 *
 * `--cli` consumes several tokens, so it has to know where its own list ends,
 * and "not a flag" is not enough: `--cli claude codex acme/x` would swallow the
 * SOURCE and leave the command with nothing to install. A pack source always
 * carries a slash — `parsePackSource` accepts nothing else — and no agent name
 * has one, which separates them exactly.
 *
 * Deliberately NOT "is it a known agent". An unknown name has to be consumed to
 * be REJECTED: stopping at `claud` would hand it to the source parser instead,
 * and the reply would be about pack syntax rather than about the typo.
 */
function looksLikeCliName(token: string): boolean {
  return !token.startsWith("-") && !token.includes("/");
}

function cliValueIndices(rest: string[]): Set<number> {
  const taken = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== "--cli" && !rest[i].startsWith("--cli=")) continue;
    if (rest[i].startsWith("--cli=")) continue; // its value is in the same token
    for (let j = i + 1; j < rest.length && looksLikeCliName(rest[j]); j += 1) {
      taken.add(j);
    }
  }
  return taken;
}

/** Find the positional source without mistaking a flag's separate value for it. */
export function packAddSource(rest: string[]): string | undefined {
  const consumed = cliValueIndices(rest);
  for (let i = 0; i < rest.length; i += 1) {
    if (VALUE_FLAGS.has(rest[i])) consumed.add(i + 1);
  }
  // ONE dash, not two. `-c` passed a `startsWith("--")` filter and was returned
  // as the pack to install — and no GitHub owner or repo may begin with a
  // hyphen, so nothing legitimate is excluded by widening it.
  return rest.find((arg, index) => !arg.startsWith("-") && !consumed.has(index));
}

/**
 * The agent CLIs named by `--cli`, in either spelling, all of them validated.
 *
 * Two separate silent failures lived here, and both reported success:
 *
 *  - An unknown name was accepted. `--cli claud` installed the pack, printed
 *    "Installed", exited 0, and guarded NOTHING — the misspelling matched no
 *    agent, so the pack applied to none of them.
 *  - A space-separated list was truncated to its first entry.
 *    `--cli claude codex` recorded `["claude"]` and dropped codex on the floor,
 *    because this lane split on commas while the other split on spaces.
 *
 * Both now take either spelling and refuse a name that is not an agent. The set
 * comes from `INTEGRATION_TYPES` rather than a list written out here, because
 * the copy in `bin/failproofai.mjs` is already a second hand-maintained one and
 * a third would be the one that drifts.
 */
function parseCliList(rest: string[]): { clis?: string[] } | { error: string[] } {
  const idx = rest.findIndex((a) => a === "--cli" || a.startsWith("--cli="));
  if (idx === -1) return {};
  const values: string[] = [];
  if (rest[idx].startsWith("--cli=")) {
    values.push(...rest[idx].slice("--cli=".length).split(","));
  } else {
    for (let j = idx + 1; j < rest.length && looksLikeCliName(rest[j]); j += 1) {
      values.push(...rest[j].split(","));
    }
  }
  const names = values.map((v) => v.trim()).filter(Boolean);
  // `--cli` with nothing after it is a typo, not a scope.
  //
  // It used to become `clis: []`, which `installed.json` stores verbatim and
  // `handler.ts` reads as "guard NO agent" (`pack.clis && !includes(cli)`) —
  // so `policies add <pack> --cli` exited 0, printed "enabled (1/3, the pack's
  // defaults)", and installed a pack that enforced nowhere. `--cli` is last on
  // the line, or followed by the source or another flag, more easily than any
  // other flag: `looksLikeCliName` stops at anything with a `-` or a `/`.
  // Refused the same way `--policy` and `--category` refuse an empty list, and
  // before anything is fetched.
  if (names.length === 0) {
    return {
      error: [
        "--cli needs at least one agent name, comma-separated",
        `--cli takes any of: ${INTEGRATION_TYPES.join(", ")}`,
      ],
    };
  }

  const known = new Set<string>(INTEGRATION_TYPES);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    // Thrown, not warned. A pack scoped to an agent that does not exist is
    // enforcing on nothing, and saying so afterwards is no use to the script
    // that already read exit 0 and moved on.
    const near = (bad: string) =>
      INTEGRATION_TYPES.find((k) => k.startsWith(bad.slice(0, 3)) || bad.startsWith(k.slice(0, 3)));
    const hint = unknown.map((u) => (near(u) ? `${u} (did you mean ${near(u)}?)` : u)).join(", ");
    return {
      error: [
        `Not an agent: ${hint}`,
        `--cli takes any of: ${INTEGRATION_TYPES.join(", ")}`,
      ],
    };
  }
  return { clis: names };
}

/** Names taken by our own policies, so a selection can be checked before install. */
/**
 * Exported for tests: the parse is where both `--cli` bugs lived, and asserting
 * it through a real `add` would need a release server for a question that is
 * purely about argument shapes.
 */
export function selectionFromForTest(rest: string[]) {
  return selectionFrom(rest);
}

function selectionFrom(rest: string[]): {
  only?: string[];
  categories?: string[];
  all?: boolean;
  clis?: string[];
  merge?: boolean;
  /** Present when the selection itself is unusable — see `parseCliList`. */
  error?: string[];
} {
  // `--policy` reads right for one ("give me this policy"), `--only` for a set.
  // They are the same switch; taking both means neither is the wrong guess.
  const only = parseList(rest, "--policy") ?? parseList(rest, "--only");
  const categories = parseList(rest, "--category");
  const parsedClis = parseCliList(rest);
  if ("error" in parsedClis) return { error: parsedClis.error };
  return {
    ...(only ? { only } : {}),
    ...(categories ? { categories } : {}),
    ...(parsedClis.clis ? { clis: parsedClis.clis } : {}),
    ...(rest.includes("--all") ? { all: true } : {}),
    // A FLAG adds. The command's first word is `add`, and on an
    // already-installed pack `--category Git` means "also turn Git on" rather
    // than "make Git the only thing on". The interactive picker overrides this
    // back to false, because its list is the complete answer.
    merge: true,
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
  const commit = flag("commit");
  const effect = flag("effect") ?? "enforce";
  const outDir = resolve(flag("out") ?? "dist-pack");

  if (!entry || !id || !version) {
    return fail([
      "Usage: failproofai publish <entry.mjs> --repo <owner>/<repo> --version <version>",
      "       [--out <dir>] [--effect enforce|observe]",
    ]);
  }
  let identity: { id: string; version: string; effect: PolicyEffect; commit?: string };
  try {
    identity = parsePackIdentity({ id, version, effect, commit });
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

  // Two policies cannot share a name, and this is where that has to be caught.
  //
  // Nothing downstream can resolve the ambiguity: a name is what `--policy`
  // selects, what the picker toggles, and what the enabled list stores — so a
  // duplicate makes one of the two unreachable and the other's on/off state
  // decide for both. Bundling several files makes it easy to reach by accident:
  // a starter written by `publish --init` into a folder that already had a
  // policy of the same name published as exactly this, twice over, with no
  // complaint at build time.
  const byName = new Map<string, number>();
  for (const hook of hooks) byName.set(hook.name, (byName.get(hook.name) ?? 0) + 1);
  const duplicates = [...byName.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicates.length > 0) {
    return fail([
      duplicates.length === 1
        ? `Two policies are called ${JSON.stringify(duplicates[0])}.`
        : `${duplicates.length} names are used by more than one policy: ${duplicates.join(", ")}.`,
      "A name is what --policy selects and what the picker toggles, so a pack",
      "cannot carry the same one twice — one of them would be unreachable.",
      "Rename or delete one of each pair.",
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

  // `commit` is omitted entirely rather than written as null when there is none.
  // The manifest is hashed and the hash is the pin, so every byte in here is
  // part of what a machine verifies — a field carrying "there was nothing to
  // say" earns none of that cost. Readers already treat absence as ordinary.
  const manifest =
    JSON.stringify(
      {
        id: identity.id,
        version: identity.version,
        effect: identity.effect,
        ...(identity.commit ? { commit: identity.commit } : {}),
        policies,
      },
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
  ], { policies: policies.length, defaultOn: on, ...(identity.commit ? { commit: identity.commit } : {}) });
}

/**
 * The release body, and the format `--releases` reads back out of it.
 *
 * Two audiences, one string. A person opening the releases page sees what the
 * release contains; `policies show --releases` parses the same lines rather
 * than downloading a manifest per release. Keep them parseable — the reader is
 * `parseReleaseBody` directly below, and the two have to move together.
 *
 * Nothing here is TRUSTED. It is publisher-controlled text on somebody else's
 * repository, so it decides what a listing displays and never what a machine
 * installs: the manifest inside the digest-pinned assets remains the only
 * source for that.
 */
export function releaseBody(id: string, version: string, meta?: PackBuildMeta): string {
  const lines = [`${id}@${version}`];
  if (meta) {
    lines.push("", `${meta.policies} policies, ${meta.defaultOn} on by default`);
    if (meta.commit) lines.push(`commit ${meta.commit}`);
  }
  return lines.join("\n") + "\n";
}

export interface ReleaseBodyFacts {
  policies?: number;
  defaultOn?: number;
  commit?: string;
}

/** Read back what {@link releaseBody} wrote. Absent facts stay absent — a
 *  release published before this format, or by hand, simply says less. */
export function parseReleaseBody(body: string | null | undefined): ReleaseBodyFacts {
  const text = typeof body === "string" ? body : "";
  const facts: ReleaseBodyFacts = {};
  const counts = /(\d+)\s+policies,\s*(\d+)\s+on by default/.exec(text);
  if (counts) {
    facts.policies = Number(counts[1]);
    facts.defaultOn = Number(counts[2]);
  }
  const commit = /(?:^|\n)\s*commit\s+([0-9a-f]{7,40})\b/i.exec(text);
  if (commit) facts.commit = commit[1].toLowerCase();
  return facts;
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
            cmd: "failproofai policies add FailproofAI/policies",
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
/**
 * A policy filename, whatever spelling it arrived in. Discovery takes
 * `.mjs`/`.js`/`.ts` and nothing else, so a name with no extension has to gain
 * one or the file it names can never be found.
 */
function withPolicyExtension(name: string): string {
  return /\.(mjs|js|ts)$/.test(name) ? name : `${name}.mjs`;
}

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
      hint: "used for the filename",
      defaultValue: "my-policies",
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim())
          ? null
          : "letters, numbers, dots, dashes and underscores",
      stdin: process.stdin,
      stdout: process.stdout,
    });
    if (answer === null) return ok(["Nothing written."]);
    chosen = answer.trim();
  }
  // Both paths land here, because only one of them used to. A name typed at
  // the prompt got `.mjs`; the same name passed as `--init myguards` was taken
  // literally and wrote a file called `myguards` — which discovery skips (it
  // takes .mjs/.js/.ts) and which no ESM loader will import. The starter file
  // was unreachable by every command meant to pick it up.
  const path = resolve(withPolicyExtension(chosen ?? "my-policies"));
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
    "  failproofai publish --repo <you>/<repo>",
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
 * The commit the policies being published are sitting at.
 *
 * This DECIDES the version and gates the publish — `versionForPublish` reads
 * both fields. It used to be a label that did neither, which is why the reads
 * below are stricter than they look. A pack published from a directory that is
 * not a git checkout has no commit; absence is ordinary and returns null the
 * same way `inferRepo` does, and the refusal is spelled out one caller up.
 *
 * Read from the ENTRY FILE's directory rather than the process cwd, for the
 * reason `inferRepo` gives: a policy that lives in another checkout is normal,
 * and the answer has to describe the file rather than wherever the shell is.
 *
 * `dirty` still travels beyond the version: with `--version` given, a dirty
 * tree publishes anyway and the recorded `commit` is then an approximation.
 *
 * `outDir` is the directory the build is about to write into, and everything
 * under it is left OUT of the dirty read — see {@link skipOutDir} for the
 * self-inflicted refusal that costs.
 */
function inferCommit(
  entryPath: string,
  outDir?: string,
  sources?: string[],
): Provenance | null {
  const cwd = resolve(entryPath, "..");
  // Two readers over one runner: `raw` for output whose LEADING bytes carry
  // meaning (a porcelain status column is a space), `git` for the rest.
  const raw = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      });
    } catch {
      return null;
    }
  };
  const git = (args: string[]): string | null => {
    const out = raw(args);
    return out === null ? null : out.trim();
  };
  const sha = git(["rev-parse", "HEAD"]);
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  // `git()` answers "" for a clean tree and null when it could not run the
  // command at all, and the `Boolean()` this used to be read BOTH as clean.
  // Harmless while `dirty` was a label; now that it decides the version, an
  // unreadable status minted a commit-named version for bytes nobody had
  // checked against that commit — the one claim this scheme exists to refuse.
  // Reachable, not theoretical: `rev-parse` never touches the index, so a repo
  // whose index is unreadable answers the first question and fails the second,
  // and `status` walks the whole worktree so it is also the one that hits the
  // 5s timeout. Unknown therefore falls on the dirty side: refusing a tree we
  // cannot vouch for costs one `--version`, and the alternative is publishing
  // one we could not read.
  const status = git(["status", "--porcelain", ...skipOutDir(git, entryPath, outDir)]);
  // The sources are checked BY NAME as well as the tree as a whole. A clean
  // tree does not mean the bytes being bundled are in HEAD: `.gitignore` hides
  // a source from the tree read entirely, and the artifact would then carry a
  // commit that does not contain it.
  const sourceState = sources ? sourcesInHead(git, raw, sources) : ({ ok: true } as const);
  return {
    sha,
    dirty: status !== "" || !sourceState.ok,
    ...(sourceState.ok ? {} : { unpublishable: sourceState }),
  };
}

/**
 * `git status --porcelain -z`, parsed.
 *
 * The format is NOT one record per NUL field. Each entry is `XY <path>`, and a
 * rename or copy is followed by its ORIGINAL path as a separate NUL field
 * carrying NO status prefix:
 *
 *     R  b.mjs\0a.mjs\0
 *
 * Splitting on NUL and slicing three characters off every field therefore turns
 * `a.mjs` into `js` — a path that resolves to nothing, is in nobody's file set,
 * and made `publish` refuse a policy file its author had simply renamed. The
 * original has to be CONSUMED by the entry that produced it.
 */
function porcelainEntries(status: string): Array<{ code: string; path: string; from?: string }> {
  const fields = status.split("\0");
  const out: Array<{ code: string; path: string; from?: string }> = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = fields[i + 1];
      i += 1;
      out.push({ code, path, ...(from ? { from } : {}) });
      continue;
    }
    out.push({ code, path });
  }
  return out;
}

/** What a checkout says about the bytes being published. `unpublishable` names
 *  the sources that are not in HEAD, so the refusal can list them. */
export interface Provenance {
  sha: string;
  dirty: boolean;
  unpublishable?: { offending: string[]; why: "missing" | "modified" };
}

/**
 * Whether every file about to be BUNDLED is in HEAD and unmodified.
 *
 * The whole-tree read above answers "is this checkout clean", which is a
 * different question and misses three ways a source reaches the artifact
 * without reaching the commit:
 *
 * - **Ignored files.** `git status --porcelain` omits anything `.gitignore`
 *   matches, even with `--untracked-files=all`. A policy file the author
 *   ignored therefore read as clean, got bundled, and the manifest recorded
 *   HEAD as the commit it came from — bytes that commit does not contain.
 * - **Untracked files in an otherwise clean tree**, for the same reason once
 *   the ignore rules are wide.
 * - **A tag.** `inferTaggedVersion` checked only the ENTRY, while `publish`
 *   bundles every discovered policy file. A tagged commit, a clean entry and a
 *   modified sibling published that sibling under a tag naming a commit
 *   without it.
 *
 * One check for all of them, run against the actual source LIST, because that
 * is the set whose bytes end up in the artifact — and provenance is a claim
 * about those bytes and nothing else.
 *
 * `-z` rather than line splitting: git C-quotes a path containing a newline or
 * a quote, so the parsed path is escape sequences that resolve to no file, and
 * a legal filename containing ` -> ` is truncated by the rename split. NUL
 * separation has neither problem — and a rename arrives as two NUL-separated
 * fields rather than one arrow-joined line — which is what
 * {@link porcelainEntries} reads.
 */
/**
 * A path spelled the way git spells it: symlinks resolved.
 *
 * `rev-parse --show-toplevel` answers with the RESOLVED root, so a source named
 * through a symlinked directory — `publish ~/policies/guards.mjs`, where
 * `~/policies` links into a checkout — measures as outside the repository
 * against it, and a committed, untouched file was reported as never committed
 * with `git add -f` as the advice, which does nothing for it.
 *
 * It cuts the other way too, which is why this resolves the SOURCES rather than
 * only un-resolving the root: a policy file that is itself a symlink out of the
 * repository has a blob in HEAD holding the link's TARGET NAME, while the bytes
 * bundled are the target's. Asking about the link's own path called that
 * publishable and recorded a commit containing none of those bytes.
 *
 * Falls back to the path as given when it cannot be resolved, so a source that
 * has since been deleted is still reported rather than throwing here.
 */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sourcesInHead(
  git: (args: string[]) => string | null,
  raw: (args: string[]) => string | null,
  sources: string[],
): { ok: true } | { ok: false; offending: string[]; why: "missing" | "modified" } {
  const paths = sources.map((f) => realOrSelf(resolve(f)));
  // Present in the commit at all. `cat-file -e HEAD:<path>` is the cheapest
  // question that distinguishes "tracked and committed" from "tracked but
  // added only to the index", which `ls-files` would answer yes to.
  const shown = git(["rev-parse", "--show-toplevel"]);
  const top = shown === null ? null : realOrSelf(resolve(shown));
  const missing: string[] = [];
  for (const path of paths) {
    const rel = top ? relative(top, path) : null;
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      missing.push(path);
      continue;
    }
    if (git(["cat-file", "-e", `HEAD:${rel}`]) === null) missing.push(path);
  }
  if (missing.length > 0) return { ok: false, offending: missing, why: "missing" };

  // `--ignored=matching` so an ignored source is REPORTED rather than omitted,
  // which is the whole point of asking about the sources by name.
  const status = raw([
    "status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching",
    "--", ...paths,
  ]);
  if (status === null) return { ok: false, offending: paths, why: "modified" };
  // Both halves of a rename count: either one being listed means the set on
  // disk is not the set HEAD holds.
  const dirty = porcelainEntries(status).flatMap((entry) =>
    [entry.path, entry.from].filter(Boolean).map((path) => resolve(top ?? ".", path as string)),
  );
  if (dirty.length > 0) return { ok: false, offending: dirty, why: "modified" };
  return { ok: true };
}

/**
 * The build output directory, spelled as a pathspec `git status` skips.
 *
 * `publish` writes its three assets to `dist-pack` under the cwd unless told
 * otherwise, so the documented `cd my-policies && failproofai publish` leaves
 * untracked build output INSIDE the checkout it just read. Without this, the
 * next publish of an unchanged, fully committed tree reads that output as
 * uncommitted changes and refuses — the command breaking its own second run,
 * over a directory it wrote itself, with a remedy (`git add -A`) that commits
 * build output into the pack repository.
 *
 * Narrow on purpose, because hiding a change from this read is hiding the one
 * thing the commit version claims. Nothing is skipped when the output lands
 * outside the repository, which cannot dirty it anyway, and nothing is skipped
 * when the output directory CONTAINS the entry file — `--out .` in a folder of
 * policies is a directory full of source, where skipping it would conceal
 * exactly what the check exists to catch.
 */
function skipOutDir(
  git: (args: string[]) => string | null,
  entryPath: string,
  outDir: string | undefined,
): string[] {
  if (!outDir) return [];
  const out = resolve(outDir);
  if (resolve(entryPath).startsWith(out + sep)) return [];
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top) return [];
  const rel = relative(resolve(top), out);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  // `top` on the exclusion is what makes it mean the directory it names: `rel`
  // is measured from the repository root, while a pathspec is read relative to
  // the directory git runs in — the ENTRY's folder. Without it, publishing
  // `guards/policies.mjs` would exclude `guards/dist-pack` and leave the real
  // `dist-pack/` in the read, so the self-inflicted refusal comes straight
  // back for anyone whose policies sit in a subdirectory.
  //
  // The leading `:(top)` states the whole-repository scope rather than leaning
  // on git's rule that a list of exclusions alone applies to all paths, and
  // `literal` stops a directory named with a glob character from taking its
  // neighbours out of the read with it.
  return ["--", ":(top)", `:(exclude,literal,top)${rel.split(sep).join("/")}`];
}

/**
 * A tag on HEAD, when there is one and the file is clean.
 *
 * Somebody who tagged `v1.2.0` has SAID what this release is, which a derived
 * name cannot — so this wins over the commit version. Absent a tag there is
 * nothing here to infer, and the commit the tree sits at is used instead.
 */
function inferTaggedVersion(entryPath: string, sources?: string[]): string | null {
  const cwd = resolve(entryPath, "..");
  const raw = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      });
    } catch {
      return null;
    }
  };
  const git = (args: string[]): string | null => {
    const out = raw(args);
    return out === null ? null : out.trim();
  };
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"]);
  if (!tag || !PACK_VERSION_RE.test(tag)) return null;
  // A tag NAMES a commit, so shipping edited bytes under it publishes something
  // that commit does not contain — and two artifacts would claim one version,
  // which `id|version|sha256` compares in both the audit key and the pack
  // upsert. Compared against "" rather than tested for truthiness for the reason
  // `inferCommit` gives: null is "could not read the tree", and reading that as
  // clean is how a dirty tree slips out under a tag that does not describe it.
  // Every source that will be BUNDLED, not just the entry. `publish` discovers
  // and bundles each policy file in the directory, so a tagged commit with a
  // clean entry and a modified sibling published that sibling under a tag
  // naming a commit without it. Same check the sha path uses, so the two
  // cannot disagree about what "this commit contains these bytes" means.
  const covered = sourcesInHead(git, raw, sources ?? [entryPath]);
  if (!covered.ok) return null;
  if (git(["status", "--porcelain", "--", entryPath]) !== "") return null;
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
 * Every relative specifier a source file names, in the four spellings a bundler
 * follows. Anchored to a line start for the two import FORMS, because that is
 * where a real one is: a `"./x.mjs"` inside a policy's own deny message is a
 * string, not an edge of the module graph, and the file it happens to spell
 * should not be dragged into a provenance check it has nothing to do with.
 */
const LOCAL_IMPORT_RES: readonly RegExp[] = [
  /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["'](\.[^"'\n]*)["']/g,
  /(?:^|\n)\s*import\s*["'](\.[^"'\n]*)["']/g,
  /\bimport\s*\(\s*["'](\.[^"'\n]*)["']\s*\)/g,
  /\brequire\s*\(\s*["'](\.[^"'\n]*)["']\s*\)/g,
];

/** What a specifier without an extension can name on disk, in resolution order. */
const LOCAL_IMPORT_EXTENSIONS: readonly string[] = [
  "", ".mjs", ".js", ".ts", ".mts", ".cts", ".cjs", ".jsx", ".tsx", ".json",
  "/index.mjs", "/index.js", "/index.ts",
];

/**
 * The policy files plus everything they IMPORT.
 *
 * A file reaches the artifact by being imported, not only by being discovered.
 * `findEntry` recognises policy files — ones that import failproofai and call
 * `customPolicies.add` — while `bundleEntry` inlines whatever those files pull
 * in, so a plain `./patterns.mjs` of shared matchers is in nobody's source list
 * and in every byte of the bundle. Ignored, it is the exact bug
 * {@link sourcesInHead} exists to close with a different file on the end of it:
 * `git status` reports a clean tree, the policy file itself is committed, and
 * the pack ships bytes HEAD does not contain under a version naming HEAD.
 *
 * Only files that EXIST are added, so a specifier this resolves differently
 * from the bundler adds nothing rather than inventing a path to refuse over.
 * Static and CommonJS spellings only — a computed `import(name)` is not
 * followed here, and is not bundled either.
 */
function withLocalImports(sources: string[]): string[] {
  const seen = new Set(sources.map((f) => resolve(f)));
  const queue = [...seen];
  // A pack is a handful of files; the cap is there so a cycle or a vendored
  // tree cannot turn a publish into a filesystem walk.
  while (queue.length > 0 && seen.size < 500) {
    const file = queue.shift() as string;
    let text: string;
    try {
      if (statSync(file).size > 512 * 1024) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const re of LOCAL_IMPORT_RES) {
      for (const match of text.matchAll(re)) {
        const base = resolve(dirname(file), match[1]);
        for (const ext of LOCAL_IMPORT_EXTENSIONS) {
          const candidate = base + ext;
          if (seen.has(candidate)) break;
          try {
            if (!statSync(candidate).isFile()) continue;
          } catch {
            continue;
          }
          seen.add(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return [...seen];
}

/**
 * Make the git claim TRUE instead of refusing it, where doing that is safe.
 *
 * The version names a commit, so publishing needs one — and the first version
 * of this simply refused when there was not one, handing the user two commands
 * to run and asking them to start again. That is a burden the tool can carry:
 * it already knows the directory, and it already knows which files it is about
 * to bundle.
 *
 * Two situations, and they are NOT the same risk, which is why only one of them
 * is fully automatic:
 *
 * - **No checkout at all.** `git init` + commit everything. There is no history
 *   to disturb, no branch to confuse and no unrelated work to sweep up: the
 *   directory is inert until this runs. Safe. An initialised checkout that has
 *   never been committed to reaches this case too — `rev-parse HEAD` answers
 *   nothing for an unborn HEAD — and it is safe on the SAME terms only at that
 *   checkout's root. Below the root the directory is not inert at all, so that
 *   is refused rather than settled; see the branch itself for what it cost.
 *
 *
 * - **A checkout with uncommitted changes.** `git add -A` here is NOT safe. It
 *   sweeps up whatever else is in the tree — a half-finished edit in a sibling
 *   file, a scratch `.env`, a debugging change nobody had decided on — and
 *   "publish committed my unrelated work" is a far worse surprise than being
 *   asked to commit. So only the POLICY FILES are committed, the ones publish
 *   found and is about to bundle, and anything else dirty stops the run with
 *   those files named. Committing the artifact's own inputs is defensible;
 *   committing the rest of somebody's desk is not.
 *
 * TTY only. In CI a commit made here exists on the runner and nowhere else, so
 * the version would name provenance nobody can resolve — `--version` is the
 * answer there, and the refusal says so.
 *
 * Returns null when there is nothing to do or nothing safe to do, leaving
 * {@link versionForPublish} to refuse with its own message.
 */
function settleGitState(
  entryPath: string,
  provenance: { sha: string; dirty: boolean } | null,
  packFiles: string[],
  id: string,
  outDir: string | undefined,
): { provenance: { sha: string; dirty: boolean }; lines: string[] } | { error: string[] } | null {
  const cwd = resolve(entryPath, "..");
  const raw = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch {
      return null;
    }
  };
  const git = (args: string[]): string | null => {
    const out = raw(args);
    return out === null ? null : out.trim();
  };
  // A commit needs an identity, and a machine that has never configured one
  // fails INSIDE `git commit` with a wall of advice about --global. Checked
  // first so the refusal names the two commands rather than quoting git at
  // somebody who did not run git.
  const identity = (): string[] | null => {
    if (git(["config", "user.email"]) && git(["config", "user.name"])) return null;
    return [
      "git has no name and email configured on this machine, so nothing can be committed.",
      '  git config --global user.name "You"',
      '  git config --global user.email "you@example.com"',
      "Then publish again, or name the version yourself: --version <version>.",
    ];
  };

  if (provenance === null) {
    const problem = identity();
    if (problem) return { error: problem };
    // No commit is not the same fact as no repository. `inferCommit` reads
    // `rev-parse HEAD`, and a checkout that has been initialised but never
    // committed to answers nothing — so this branch is also where an UNBORN
    // HEAD lands, and `git init` there is being run inside somebody's existing
    // work tree.
    //
    // `--show-prefix` is git's own answer to "where am I in this work tree":
    // null outside one, "" at its root, `policies/` below it. Asked of git
    // rather than compared as paths because `cwd` is built from the entry
    // argument and can carry symlinks that `--show-toplevel` resolves away,
    // and a spelling difference would refuse a publish that is perfectly fine.
    const prefix = git(["rev-parse", "--show-prefix"]);
    if (prefix !== null && prefix !== "") {
      // `git init` here created a NESTED repository inside the parent's work
      // tree and committed into that. The pack was then versioned by a commit
      // living in a repository the author will never push — the parent shows
      // only an untracked `policies/` — so the version named provenance nobody
      // could resolve, which is the one thing this whole path exists to avoid.
      // Not settled automatically either: everything in an unborn checkout is
      // untracked, so the only add that would work is one sweeping the parent's
      // whole work tree, which is exactly the surprise the dirty branch below
      // refuses to hand anyone.
      return { error: [
        "The version names a commit, and this folder is inside a git checkout that has no commits yet.",
        `  ${prefix.replace(/\/$/, "")} — inside a repository whose first commit has not been made`,
        "Make that first commit yourself, then publish again —",
        "or name the version yourself: --version <version>.",
      ] };
    }
    // Only when there is genuinely no repository. Re-initialising one that
    // exists is a no-op git tolerates, but the line reported below would then
    // claim to have started something that was already there.
    if (prefix === null && git(["init", "-q"]) === null) return null;
    // `-A` minus the build output. A first commit that swept in `dist-pack/`
    // would put the artifact inside the very commit it is supposed to name.
    //
    // No `--` of its own: `skipOutDir` returns one ALREADY, along with the
    // `:(top)` scope it needs. Adding a second separator made git read it as a
    // literal filename, the add failed, and the commit then failed on an empty
    // index — reported as "could not make the first commit", which is true and
    // says nothing about why.
    git(["add", "-A", ...skipOutDir(git, entryPath, outDir)]);
    // Counted from the INDEX, not from the policy files. The first commit takes
    // everything here — a README, a .gitignore, whatever else the author has
    // beside their policies — and reporting the number of policy files instead
    // understated what had just been committed on their behalf.
    const staged = (git(["diff", "--cached", "--name-only"]) ?? "").split("\n").filter(Boolean).length;
    if (git(["commit", "-q", "-m", `publish ${id}`]) === null) {
      return { error: [
        `Could not make the first commit in ${cwd}.`,
        "Commit by hand, or name the version yourself: --version <version>.",
      ] };
    }
    const made = inferCommit(entryPath, outDir, packFiles);
    if (!made) return null;
    const files = `${staged} file${staged === 1 ? "" : "s"}`;
    return {
      provenance: made,
      lines: [
        prefix === null
          ? `Started a git repository here and committed ${files}.`
          : `Made this repository's first commit — ${files}.`,
      ],
    };
  }

  if (!provenance.dirty) return null;

  // Which paths are actually dirty, as git sees them — relative to the REPO
  // ROOT, not to the entry's directory, which are different whenever the
  // policies live in a subdirectory.
  const root = git(["rev-parse", "--show-toplevel"]);
  // The SAME exclusion `inferCommit` applied when it decided the tree was
  // dirty. Without it this would try to commit the assets the last run wrote —
  // which are gitignored in every pack this tool scaffolds, and are the build
  // output either way.
  // UNTRIMMED. A porcelain line is `XY <path>`, and for an unstaged edit the X
  // column is a SPACE — so trimming the output eats the first line's leading
  // space, and `slice(3)` then eats the first character of its path too. It
  // reported `ests.mjs`, decided that was not one of the policy files, and
  // refused the publish over a file that did not exist. Only the first line is
  // affected, which is exactly the kind of wrongness that survives a casual
  // test with two dirty files in it.
  //
  // `--untracked-files=all` because the default COLLAPSES a wholly untracked
  // directory into one line naming the directory: a new `policies/` folder
  // inside an existing checkout reads as `?? policies/` and never mentions the
  // files in it. That path matches no policy file, so it landed in `foreign`
  // and publish refused a brand new folder of policies by naming the folder
  // itself as somebody else's work — the bootstrap case this whole function
  // exists for. Only reproducible below the repository root; an untracked file
  // AT the root is reported individually, which is why every fixture that
  // publishes from the root missed it. The exclusion still applies, so the
  // expansion does not drag the build output back into the read.
  // `-z`, not line splitting.
  //
  // The line parser this replaces was wrong twice over on paths git is entitled
  // to hand back. Git C-QUOTES a path containing a newline or a quote, so the
  // value parsed out was escape sequences resolving to no file on disk — and a
  // legal policy file named `guards -> final.mjs` was truncated to `final.mjs`
  // by the rename split. Either way the path matched none of the pack's files,
  // landed in `foreign`, and publish refused to commit its OWN source over a
  // filename it had mangled itself.
  //
  // NUL separation has neither problem: no quoting is applied, and a rename
  // arrives as two separate entries rather than one arrow-joined line — so the
  // old path is listed in its own right, which is correct here, since a rename
  // leaves the tree differing from HEAD at both ends.
  const status = raw([
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    ...skipOutDir(git, entryPath, outDir),
  ]);
  if (root === null || status === null) return null;
  const entries = porcelainEntries(status);
  // The path that EXISTS is the one to stage and the one to judge. A rename's
  // original is staged too — otherwise the deletion half is left uncommitted
  // and the tree is still dirty afterwards — but it is NOT judged foreign on
  // its own: renaming one of the pack's own files is the pack's business, and
  // treating the vacated name as somebody else's file made publish refuse a
  // policy file its author had merely renamed.
  const dirty = entries.map((entry) => resolve(root, entry.path));
  const renamedFrom = entries
    .filter((entry) => entry.from)
    .map((entry) => resolve(root, entry.from as string));
  if (dirty.length === 0) return null;

  const mine = new Set(packFiles.map((f) => resolve(f)));
  const foreign = dirty.filter((path) => !mine.has(path));
  // Staged alongside, so a rename lands whole.
  const toStage = [...dirty, ...renamedFrom];
  if (foreign.length > 0) {
    return { error: [
      `The version names a commit, and this tree has uncommitted changes outside the policy files.`,
      ...foreign.slice(0, 8).map((path) => `  ${relative(root, path)}`),
      ...(foreign.length > 8 ? [`  …and ${foreign.length - 8} more`] : []),
      "Those are not this command's to commit. Commit or stash them, then publish again —",
      "or name the version yourself: --version <version>.",
    ] };
  }

  const problem = identity();
  if (problem) return { error: problem };
  git(["add", "--", ...toStage]);
  if (git(["commit", "-q", "-m", `publish ${id}`]) === null) {
    return { error: [
      "Could not commit the policy files.",
      "Commit by hand, or name the version yourself: --version <version>.",
    ] };
  }
  const made = inferCommit(entryPath, outDir, packFiles);
  if (!made || made.dirty) return null;
  return {
    provenance: made,
    lines: [`Committed ${dirty.length} changed policy file${dirty.length === 1 ? "" : "s"}.`],
  };
}

/**
 * How many characters of a commit a version names.
 *
 * Twelve, not git's default seven. Seven collides in a repository with enough
 * objects — git itself lengthens the abbreviation as a repo grows — and a
 * version that stops being unique is worse than a long one, because two
 * artifacts would claim the same name. Twelve is short enough to read in a
 * listing and long enough that no real pack repository will reach it.
 *
 * The FULL sha is still recorded as `commit` in the manifest, so nothing is
 * lost by abbreviating the version.
 */
export const VERSION_SHA_LENGTH = 12;

/** The version a commit names. */
export function versionFromCommit(sha: string): string {
  return sha.trim().toLowerCase().slice(0, VERSION_SHA_LENGTH);
}

/**
 * The version this publish should carry: the commit it was built from.
 *
 * A version answers ONE question here — which source produced these bytes —
 * and the commit answers it exactly, with nothing to decide and nothing to
 * count. Nothing is read from the repository's releases: the version is a
 * property of the tree in front of you, so a fresh clone, an air-gapped
 * machine and a second publisher all compute the same answer for the same
 * source, and none of them has to ask GitHub what happened before.
 *
 * The costs are real and are the reason this is an explicit choice rather than
 * a default. A sha does not ORDER — `a1b2c3d` and `f9e8d7c` give no clue which
 * came first — so "am I on the newest?" is a question only the release list can
 * answer. `policies show <source> --releases` is where it is answered, newest
 * first, which is why that surface exists.
 *
 * What it REFUSES rather than approximates, all for the same reason: the
 * version claims to name a commit, so it must not be minted where that claim
 * would be false.
 *
 * - **No git.** There is no commit to name. Publishing from a directory that
 *   is not a checkout used to work; under this scheme it cannot, and saying so
 *   beats inventing a number that names nothing.
 * - **A dirty tree.** The bytes being published are not the bytes in that
 *   commit, so the version — and `commit` in the manifest beside it — would
 *   both point at source that does not contain them.
 * - **A sha that is not one.** No caller in the publish path produces one, so
 *   this is a guard rather than a case; see the comment on it below.
 *
 * `--version` overrides all of it, and every refusal names it for that reason.
 */
export function versionForPublish(
  provenance: Provenance | null,
): { version: string } | { error: string[] } {
  if (!provenance) {
    return {
      error: [
        "This pack is versioned by the commit it is built from, and this directory is not a git checkout.",
        "  git init && git add -A && git commit -m \"first policies\"",
        "Then publish again. To publish without git, name the version yourself: --version <version>.",
      ],
    };
  }
  // A source that is not in HEAD at all — ignored by `.gitignore`, or never
  // committed — gets its own refusal. The generic "this tree has uncommitted
  // changes" is wrong for it and its remedy (`git add -A && git commit`) does
  // not work: an ignored file stays ignored, so the advice would loop.
  if (provenance.unpublishable) {
    const { offending, why } = provenance.unpublishable;
    return {
      error: [
        why === "missing"
          ? "The version names a commit, and these policy files are not in it — ignored, or never committed:"
          : "The version names a commit, and these policy files differ from it:",
        ...offending.slice(0, 8).map((path) => `  ${path}`),
        ...(offending.length > 8 ? [`  …and ${offending.length - 8} more`] : []),
        why === "missing"
          ? "They would be bundled into the artifact while the commit it names does not contain them."
          : "They would be bundled as they are now, not as that commit holds them.",
        why === "missing"
          ? "Commit them — `git add -f` if they are ignored — or name the version yourself: --version <version>."
          : "Commit them, or name the version yourself: --version <version>.",
      ],
    };
  }
  if (provenance.dirty) {
    return {
      error: [
        `The version names commit ${versionFromCommit(provenance.sha)}, and this tree has uncommitted changes —`,
        "so the bytes about to be published are not the bytes in that commit.",
        "  git add -A && git commit -m \"...\"",
        "Then publish again, or name the version yourself: --version <version>.",
      ],
    };
  }
  // Same refusal as the other two, from the other direction: a version that is
  // not an abbreviated sha names no commit either. `inferCommit` only ever hands
  // over forty lower-case hex, so nothing in the publish path reaches this —
  // which is exactly why it is worth stating. Truncating a non-sha silently
  // yields a `version` the manifest validator rejects much later, or an EMPTY
  // one, and the publish then fails somewhere that says nothing about the sha.
  const sha = provenance.sha.trim().toLowerCase();
  if (!PACK_COMMIT_RE.test(sha)) {
    return {
      error: [
        `The version names the commit it was built from, and ${JSON.stringify(provenance.sha.slice(0, 64))} is not one.`,
        "Name the version yourself instead: --version <version>.",
      ],
    };
  }
  return { version: versionFromCommit(sha) };
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
  sourceDir?: string,
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
        // NOT auto_init. The author already has the commit that holds these
        // policies; a repository seeded with its own "Initial commit" shares
        // no history with it, so the `git push` that every publish is followed
        // by is rejected as unrelated — and the way out (`pull --allow-
        // unrelated-histories`, or a force-push over the seed) is a worse
        // first five minutes than an empty repository, which accepts the push
        // as-is. Releases do not need a commit to hang from: the tag is
        // created against whatever the release API is given.
        auto_init: false,
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
    // A repository created with no commits has no default branch, and the
    // release API tags the default branch — so something has to land on it
    // before the release is cut. Pushing the author's own history is the
    // version that leaves a usable repository behind; seeding is the fallback
    // for a pack that is not in a git checkout at all.
    if (!(sourceDir && pushExistingHistory(sourceDir, owner, name, token))) {
      await seedDefaultBranch(owner, name, id, token);
    }
    info = await gh(`${GITHUB_API}/repos/${owner}/${name}`, token);
  }
  if (info.status >= 400) {
    return { error: [`Could not read ${owner}/${name}: ${ghError(info)}`] };
  }
  return { info, created };
}

/**
 * Push the checkout the policies live in to the repository just created for
 * them, and report whether it landed.
 *
 * Why publish pushes at all: it created the repository, so it owns the one
 * moment when pushing cannot conflict with anything. The repository used to be
 * created with `auto_init`, which meant GitHub wrote an "Initial commit" the
 * author did not have — so the `git push` that every publish is followed by was
 * rejected as unrelated history, every time, for everybody. Seeding it and
 * pushing it are the same job; doing only the first left the author to
 * reconcile two histories by hand.
 *
 * It also makes the tag mean something. The release tags the default branch, so
 * against a seeded repository `1.0.0` named a README commit that did not
 * contain a single one of the policies it shipped.
 *
 * The token goes in through GIT_ASKPASS, never in the URL or the argv: a remote
 * with a credential in it is written into `.git/config` in plaintext, and one on
 * a command line is readable from `ps` by every user on the box.
 */
export const __pushExistingHistoryForTest = (
  dir: string,
  owner: string,
  name: string,
  token: string,
): boolean => pushExistingHistory(dir, owner, name, token);

function pushExistingHistory(dir: string, owner: string, name: string, token: string): boolean {
  const git = (args: string[], env?: Record<string, string>): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
        env: env ? { ...process.env, ...env } : process.env,
      }).trim();
    } catch {
      return null;
    }
  };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  // No commits yet (`HEAD` unborn) means there is nothing to push and nothing
  // to conflict with later either.
  if (!branch || branch === "HEAD" || !git(["rev-parse", "--verify", "HEAD"])) return false;

  const askpass = join(mkdtempSync(join(tmpdir(), "fpai-askpass-")), "askpass.sh");
  try {
    writeFileSync(askpass, `#!/bin/sh\ncase "$1" in\n*Username*) echo x-access-token ;;\n*) echo "$FPAI_GH_TOKEN" ;;\nesac\n`, { mode: 0o700 });
    const env = { GIT_ASKPASS: askpass, FPAI_GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" };
    const url = `${GITHUB_GIT}/${owner}/${name}.git`;
    // Name the remote FIRST when there is not one, so the push can be `-u` and
    // leave the branch tracking it. Pushing to a bare URL and setting the
    // upstream afterwards cannot work: `--set-upstream-to` needs a
    // remote-tracking ref, and a URL push writes none.
    const adopt = !git(["remote", "get-url", "origin"]);
    if (adopt) git(["remote", "add", "origin", url]);
    // An author who already has an `origin` keeps it, and the push goes to the
    // URL directly rather than quietly redirecting their remote.
    const pushed = adopt
      ? git(["push", "-u", "origin", `${branch}:${branch}`], env)
      : git(["push", url, `${branch}:${branch}`], env);
    if (pushed === null) {
      // Leave nothing behind that was not there before.
      if (adopt) git(["remote", "remove", "origin"]);
      return false;
    }
    return true;
  } finally {
    try {
      rmSync(dirname(askpass), { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a publish over */
    }
  }
}

/**
 * The minimum that gives a repository a default branch: one commit, made
 * through the API. Only for a pack published from somewhere that is not a git
 * checkout — otherwise the author's own history does this job better.
 */
async function seedDefaultBranch(owner: string, name: string, id: string, token: string): Promise<void> {
  await gh(`${GITHUB_API}/repos/${owner}/${name}/contents/README.md`, token, {
    method: "PUT",
    contentType: "application/json",
    body: JSON.stringify({
      message: `${id}: create pack repository`,
      content: Buffer.from(
        `# ${name}\n\nA [failproofai](https://github.com/failproofai/failproofai) policy pack.\n\n\`\`\`bash\nfailproofai policies add ${owner}/${name}\n\`\`\`\n`,
        "utf8",
      ).toString("base64"),
    }),
  });
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
  "--commit",
]);
function publishEntryArg(rest: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (PUBLISH_VALUE_FLAGS.has(rest[i])) consumed.add(i + 1);
  }
  return rest.find((a, i) => !a.startsWith("--") && !consumed.has(i));
}

// ── publish ───────────────────────────────────────────────────────────────

/**
 * The three attachments a release needs before anybody can install it. One list,
 * because `publish` uploads exactly these and `--releases` marks a release
 * `incomplete` for missing any of them — two hand-written copies of the same
 * three names would let the listing call a release installable that the
 * installer then 404s on.
 */
const INSTALLABLE_PACK_ASSETS: readonly string[] = [
  PACK_MANIFEST_ASSET,
  PACK_ENTRY_ASSET,
  PACK_CHECKSUMS_ASSET,
];

const GITHUB_API = process.env.FAILPROOFAI_GITHUB_API ?? "https://api.github.com";
const GITHUB_UPLOADS = process.env.FAILPROOFAI_GITHUB_UPLOADS ?? "https://uploads.github.com";
/** Where the git remote lives, so the push path can be tested against a real
 *  local bare repository rather than only reasoned about. */
const GITHUB_GIT = process.env.FAILPROOFAI_GITHUB_GIT ?? "https://github.com";

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

/**
 * `token` is nullable because ONE caller has no credential to offer: listing a
 * public repository's releases is a read anybody can do, and requiring
 * `gh auth login` to look at what a pack has published would be a worse answer
 * than the 60-per-hour anonymous rate limit. Every WRITE still passes a token —
 * they are unreachable without one, since `publish` fails before it gets here.
 */
async function gh(
  url: string,
  token: string | null,
  init: { method?: string; body?: BodyInit; contentType?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
 * Two failures the manual flow let through silently, both refused BEFORE
 * anything is created or uploaded:
 *   - a tag that does not describe the manifest version, which installs and then
 *     reports a version matching no URL;
 *   - an existing private repository, which publishes to nobody, because
 *     installs are anonymous HTTPS with no credential to offer. `--allow-private`
 *     is for an author who genuinely wants that and will distribute the artifact
 *     some other way; a repository publish CREATES is public by construction, so
 *     the refusal only ever fires on reuse.
 */
/**
 * The two things `publish` cannot work out on its own, asked instead of
 * demanded as flags.
 *
 * Everything else it already derives: the policy files by content, the version
 * from the commit the tree sits at, the id from the repository, the credential
 * from the environment. What is left is genuinely a question — WHERE this
 * should live, when the folder has no git remote naming somewhere — and a
 * confirmation, because publishing is public and cannot be taken back.
 *
 * Only ever on a TTY. A pipe, a CI job or a test gets the old behaviour: flags
 * decide, and a missing `--repo` still means "build the assets and stop"
 * rather than a prompt nobody can answer.
 */
async function askWhereToPublish(
  suggestion: string,
  io: { stdin: TTYIn; stdout: TTYOut },
): Promise<string | null> {
  const answer = await promptText({
    // The suggestion is NOT repeated in the hint. `promptText` renders a
    // `defaultValue` as `↵ <value>` ahead of whatever hint it is given, so
    // spelling it here too printed it twice — and the half that says which key
    // takes it belongs to every prompt with a default, not to this one.
    message: "Where should this publish?",
    // Kept short deliberately: `promptText` truncates to ONE physical row, and
    // the whole line is the message plus `↵ <owner>/<repo>` plus this. At 80
    // columns the longer spelling — "created if it does not exist" — pushed
    // itself off the end, so the fact was written and never read.
    hint: "created if missing",
    defaultValue: suggestion,
    validate: (v) => {
      const t = v.trim();
      if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(t)) return "owner/repo";
      return null;
    },
    stdin: io.stdin,
    stdout: io.stdout,
  });
  return answer === null ? null : answer.trim();
}

/**
 * The account the credential belongs to, for the default answer above.
 *
 * Best-effort: a failure here costs a nicer default and nothing else, so it
 * never blocks or reports. The prompt still has the folder name to fall back
 * on, which is what the repository would most likely be called anyway.
 */
async function credentialLogin(token: string): Promise<string | null> {
  try {
    const me = await gh(`${GITHUB_API}/user`, token);
    return typeof me.json?.login === "string" ? me.json.login : null;
  } catch {
    return null;
  }
}

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
  let repo = flag("repo") ?? (entry ? inferRepo(entry) : null) ?? undefined;
  // Nothing names a destination and there is somebody to ask. This is the
  // whole of "just run `failproofai publish`": the folder is a git repo full
  // of policies, and the one thing it cannot know is where they should go.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const askingWhere = interactive && !repo && entry && !rest.includes("--dry-run");
  if (askingWhere) {
    // What is about to be published, before being asked where to put it. The
    // question is answerable without it — but "publish" with no arguments
    // otherwise gives no sign of WHICH files it found, and finding the wrong
    // ones is the mistake that matters here.
    const found = discovered.length > 0 ? discovered : [entry!];
    process.stdout.write(
      `\n  ${found.length} policy ${found.length === 1 ? "file" : "files"}: ` +
        `${found.map((f) => basename(f)).join(", ")}\n\n`,
    );
    const token = githubToken();
    const login = token ? await credentialLogin(token) : null;
    const folder = basename(resolve(entry!, ".."));
    const answered = await askWhereToPublish(
      `${login ?? "your-account"}/${folder}`,
      { stdin: process.stdin as unknown as TTYIn, stdout: process.stdout as unknown as TTYOut },
    );
    if (answered === null) return ok(["Nothing was published."]);
    repo = answered;
  }
  // A tag on HEAD is somebody SAYING what this release is, so it wins over the
  // sha, which only reports one. Both are properties of the tree, so neither
  // waits on the repository being known — see the block below the usage text.
  // The set that will actually be BUNDLED — every discovered policy file, not
  // just the entry, and everything those files IMPORT, which the bundler inlines
  // and discovery never names. Both the tag path and the sha path are handed it,
  // so neither can accept a version for bytes the commit does not hold.
  const bundledSources = withLocalImports(
    discovered.length > 0 ? discovered : entry ? [entry] : [],
  );
  let version =
    flag("version") ?? (entry ? inferTaggedVersion(entry, bundledSources) : null) ?? undefined;
  let versionFromSha = false;
  // The id and the repo are usually the same words, and requiring both is asking
  // the same question twice. Either one alone answers for the other.
  const dryRun = rest.includes("--dry-run") || !repo;
  // The way past the private-repository refusal below, for somebody who really
  // does want a pack nobody can `policies add` and will distribute the assets
  // another way. It buys a publish, never a working install, so the success
  // message still says so.
  const allowPrivate = rest.includes("--allow-private");
  // A dry run publishes nothing, so the id only has to name the artifact it
  // writes — and refusing to build one because the folder has no git remote
  // yet blocked the exact thing a dry run is for: looking at the pack BEFORE
  // committing to a repository for it. The folder name is what the repository
  // would be called anyway, and `--id` or `--repo` overrides it the moment
  // either is known.
  //
  // `local/` rather than a guessed account: the owner is genuinely not known
  // yet, and a plausible-looking one would be baked into a manifest somebody
  // could upload by hand.
  const id =
    flag("id") ?? repo ?? (dryRun && entry ? `local/${basename(resolve(entry, ".."))}` : undefined);
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
      "       [--allow-private]  (a private repo installs for nobody; this says so)",
      "",
      "With no --repo it writes the three release assets and stops.",
    ]);
  }

  // The version is a property of the TREE, not of the repository's history, so
  // it is settled here — before the credential, before the repo, and identically
  // for a dry run. Nothing is counted and nothing is asked of GitHub.
  //
  // Provenance is read ONCE, because it decides the version AND is recorded in
  // the manifest beside it. Reading it twice is how the two come to disagree.
  //
  // The output directory is settled first only so the dirty read can skip it:
  // it is where the LAST run's assets are sitting, and inside the checkout by
  // default. See `skipOutDir`.
  const outDirEarly = resolve(flag("out") ?? "dist-pack");
  let provenance = entry ? inferCommit(entry, outDirEarly, bundledSources) : null;
  const gitLines: string[] = [];
  if (!version && entry && interactive) {
    // Carry the git work rather than handing it back. TTY only: a commit made
    // in CI exists on the runner and nowhere else, so the version would name
    // provenance nobody can resolve, and `--version` is the answer there.
    const settled = settleGitState(
      entry,
      provenance,
      discovered.length > 0 ? discovered : [entry],
      id,
      outDirEarly,
    );
    if (settled && "error" in settled) return fail(settled.error);
    if (settled) {
      provenance = settled.provenance;
      gitLines.push(...settled.lines);
    }
  }
  if (!version) {
    const resolved = versionForPublish(provenance);
    if ("error" in resolved) return fail(resolved.error);
    version = resolved.version;
    versionFromSha = true;
  }

  // Check an EXPLICIT tag against the version before anything reaches the
  // network. A tag the user typed can disagree with the version, and refusing
  // it here is what stops a doomed publish from first creating a repository
  // for itself.
  const explicitTag = flag("tag");
  if (explicitTag && version && !packTagMatchesVersion(explicitTag, version)) {
    return fail([
      `Tag ${explicitTag} does not describe version ${version}, so nobody could install it.`,
      `A pack is fetched from releases/download/${explicitTag}/… and then reports`,
      `${version} — which names no release. Use --tag ${version} (a leading v is`,
      "fine), or build the pack at the version the tag says.",
    ]);
  }

  // The version is already known, so the credential and the repository are
  // needed only to publish. The build still runs immediately after, before
  // anything is created or uploaded.
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
      const ensured = await ensureRepo(owner, name, id, token, resolve(entry, ".."));
    if ("error" in ensured) return fail(ensured.error);
    created = ensured.created;
    repoInfo = ensured.info;
    // A private repository is not a smaller audience, it is no audience:
    // `fetchBytes` in pack-store.ts sends no Authorization header at all, by
    // design, so every install 404s. This used to upload all three assets, exit
    // 0, print `policies add <repo>` and merely append a warning underneath —
    // reporting success for a release nobody could install and leaving assets
    // behind that advertise that dead route. Refuse HERE, before the release
    // exists and before anything is built, so there is nothing to clean up.
    // A repository this command creates is made public, so this only ever
    // fires on reuse of one that was already private.
    if (repoInfo.json?.private === true && !allowPrivate) {
      return fail([
        `${repo} is PRIVATE, so nothing was published.`,
        "Installing a pack fetches its release assets over anonymous HTTPS with no",
        "credential to offer, so every install would 404 — including your own from",
        "another machine. Publishing would only have attached three assets",
        "advertising a route nobody can take.",
        `Make it public and re-run:  gh repo edit ${repo} --visibility public`,
        "Or, to keep it private and hand the pack over some other way, publish it",
        "with --allow-private.",
      ]);
    }
  }
  const tag = flag("tag") ?? version;

  // One artifact, however many files it was written across. `build` refuses an
  // entry with relative imports because only the entry is digest-pinned — so
  // the fix is to make it ONE file here, not to send the author away to set up
  // a bundler for a step this tool already performs for its own pack.
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

  const built = await build([
    entryToBuild,
    "--id", id,
    "--version", version,
    // NOT when the tree is dirty, even though `--version` let the publish
    // through. `commit` claims these bytes came from that commit, and on a
    // dirty tree they did not — recording it anyway put the exact false claim
    // the dirty refusal exists to prevent through the door right next to it,
    // reachable by taking the escape hatch that refusal recommends.
    ...(provenance && !provenance.dirty ? ["--commit", provenance.sha] : []),
    ...outFlagFrom(rest),
    ...effectFlagFrom(rest),
  ]);
  if (built.exitCode !== 0) return built;

  const outDir = outDirEarly;
  const bundleNote =
    discovered.length > 1
      ? [`Bundled ${discovered.length} files into one artifact:`,
         ...discovered.map((f) => `  ${f.replace(process.cwd() + "/", "")}`), ""]
      : [];
  if (dryRun) {
    return ok([
      ...gitLines,
      ...(gitLines.length ? [""] : []),
      ...bundleNote,
      ...built.lines.slice(0, 4),
      "",
      ...(repo
        ? ["Dry run — nothing was published.", `Drop --dry-run to release it on ${repo}.`]
        : [
            "Nothing was published: name a repository to release it on.",
            // Just the repository. It used to spell out the entry file and the
            // version too — naming ONE of the files it had that moment finished
            // bundling, and pinning a version it works out for itself. Both
            // were wrong the moment they were printed, and both taught the
            // reader that publishing needs flags it does not need.
            "  failproofai publish --repo <owner>/<repo>",
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


  // Only ever true when --allow-private was passed — the refusal above returns
  // otherwise — so this is the warning that goes with a publish the author
  // asked for anyway, not a discovery made too late to act on.
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
        // The body is what `policies show --releases` reads. Putting the counts
        // and the commit HERE rather than in the manifest is what makes that
        // command ONE request: the release list returns bodies inline, while
        // the counts otherwise cost a manifest download per release and scale
        // with history. It doubles as what a human sees on the releases page,
        // which is the second reason to write it rather than a marker nobody
        // reads. `--notes` still wins outright — an author who wrote release
        // notes gets their release notes.
        body: flag("notes") ?? releaseBody(id, version, built.meta),
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

  const assets = INSTALLABLE_PACK_ASSETS;
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
    // What was done to the user's own directory, before what was done to
    // GitHub. A side effect on somebody's working tree is never silent, even
    // when it is the side effect they wanted.
    ...gitLines,
    ...(gitLines.length ? [""] : []),
    ...bundleNote,
    ...(created ? [`Created ${repo} (public).`] : []),
    `Published ${id}@${version} to ${repo} at tag ${tag}.` +
      (versionFromSha ? " That names the commit it was built from." : ""),
    `  ${assets.length} assets attached`,
    "",
    // The install lines are the whole point of the success message, and on a
    // private repository they are a lie — `policies add` 404s there. Print the
    // warning INSTEAD of them, never underneath them: a reader who copies the
    // first command they see must not be copying one that cannot work.
    ...(isPrivate
      ? [
          `WARNING: ${repo} is PRIVATE, so nobody can install this — you asked for`,
          "that with --allow-private. Installs are anonymous HTTPS with no credential",
          "to offer, so every `failproofai policies add` will 404. Distribute the",
          "three assets yourself, or make it public:",
          `  gh repo edit ${repo} --visibility public`,
        ]
      : [
          "Anyone can now install it:",
          `  failproofai policies add ${repo}`,
          `  failproofai policies show ${repo}      (look first, without running it)`,
        ]),
  ];
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
  // Refused before anything is fetched or written: a pack scoped to an agent
  // that does not exist enforces on nothing, and saying so afterwards is no use
  // to the script that already read exit 0 and moved on.
  if (selection.error) return fail(selection.error);

  // No short name for our own pack any more. `core` resolved to CORE_SOURCE and
  // was fetched, verified and pinned like anybody else's — but a spelling only
  // WE get to use still made our policies read as part of the tool rather than
  // as one pack among others, which is the distinction this lane exists to
  // erase. Ours is typed the same way yours is: `FailproofAI/policies`.
  // `parsePackSource` still recognises the retired spellings, so typing one
  // gets told what to type instead.
  const resolvedSource = source;

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
    // The picker REPLACES. What is ticked is what should be on, so a flag's
    // additive reading must not leak into it — otherwise unticking something
    // here could never turn it off.
    selection.merge = false;
    // An empty pick is a real answer — install the pack, enable none of it —
    // but `{only: []}` is indistinguishable from "no selection" downstream, so
    // it is carried as an explicit empty list the resolver can see.
    if (picked.length === 0) selection.only = [];
  }

  try {
    const result = await addPack(resolvedSource!, selection);
    const lines = [
      ...(result.replaced?.length
        ? [
            // What was OBSERVED, and then the inference — not the inference
            // stated as fact. Identical artifact bytes are the only evidence
            // there is, and they cannot tell a renamed pack from a second pack
            // one repository builds from the same source. Absorbing is the
            // right default (a publisher renaming a set must not reset everyone
            // who narrowed it), but the record that goes away is one the user
            // installed on purpose, so the line has to say what to do when the
            // guess was wrong instead of asserting it was right.
            `Replaced ${result.replaced.join(", ")} — same artifact, so it was taken as this pack renamed, and your selection was carried over.`,
            `If ${result.replaced.length > 1 ? "those are separate packs" : "that is a separate pack"}, re-add ${result.replaced.join(", ")} to restore ${result.replaced.length > 1 ? "them" : "it"}.`,
          ]
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
      // Named differently from `selected` on purpose: it is the one outcome
      // where the set is LARGER than what was asked for, and a reader who does
      // not see that said out loud will read the number as their whole answer.
      added: "what you added, plus what was already on",
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
  // Reported with the id the MACHINE holds, not the spelling that was typed:
  // `remove FAILPROOFAI/POLICIES` succeeding and echoing that back teaches a
  // name nothing else in the product uses.
  let removedId: string | null;
  try {
    removedId = removePack(id);
  } catch (err) {
    // Two installed packs answer to one loosely-typed name. Refused rather
    // than guessed at — the loose match exists so a remembered name works, and
    // uninstalling something the user did not name is a worse outcome than
    // asking them to be exact.
    if (err instanceof AmbiguousPackId) {
      return fail([
        `${id} matches ${err.candidates.length} installed packs:`,
        ...err.candidates.map((candidate) => `  ${candidate}`),
        "Name one of them exactly.",
      ]);
    }
    throw err;
  }
  if (!removedId) return fail([`No installed pack with id ${id}`]);
  return ok([
    `Removed ${removedId}. Its policies stop enforcing now; re-add it any time with the same command.`,
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
/**
 * `failproofai policies show <owner>/<repo> --releases` — every release a pack
 * has published, and which one is on this machine.
 *
 * ONE request. The obvious implementation downloads each release's manifest to
 * count its policies, which costs a request per release and gets slower the
 * longer a pack has existed; instead `publish` writes those counts into the
 * release BODY, and `GET /releases` returns bodies inline. See `releaseBody`.
 *
 * A LISTING, and never an install path. Installs construct their URLs from
 * owner/repo/tag and discover nothing, which is what leaves no index to poison
 * — this reads the API because "what else is there?" is a question that has no
 * answer without one, and the worst a wrong answer here can do is print a row.
 * Nothing on this screen is trusted: the counts and the commit are
 * publisher-controlled text, shown as claims, while what a machine actually
 * installs still comes from the digest-pinned manifest.
 */
async function listReleases(source: string): Promise<PackCliResult> {
  const opts = optsFor(process.stdout);
  let spec;
  try {
    spec = parsePackSpec(source);
  } catch (err) {
    return fail([err instanceof Error ? err.message : String(err)]);
  }

  // Best-effort: a token raises the rate limit from 60/hour to 5000 and lets a
  // private repo answer at all. Its absence is not an error.
  const res = await gh(
    `${GITHUB_API}/repos/${spec.owner}/${spec.repo}/releases?per_page=100`,
    githubToken(),
  );
  if (res.status === 404) {
    return fail([
      `No repository at ${spec.owner}/${spec.repo}, or it is private and this machine has no credential for it.`,
      "A pack has to be public to install anyway — installs are anonymous HTTPS with no credential to offer.",
    ]);
  }
  if (res.status === 403 && /rate limit/i.test(res.text)) {
    return fail([
      "GitHub rate-limited this listing.",
      "Sign in once with `gh auth login` (or set GITHUB_TOKEN) to raise the limit from 60 requests an hour to 5000.",
    ]);
  }
  if (res.status >= 400 || !Array.isArray(res.json)) {
    return fail([`Could not list releases for ${spec.owner}/${spec.repo}: ${ghError(res)}`]);
  }

  const raw = res.json as unknown as Array<{
    tag_name?: unknown; body?: unknown; published_at?: unknown; created_at?: unknown;
    prerelease?: unknown; draft?: unknown; assets?: unknown;
  }>;
  // Sorted HERE, by when each was PUBLISHED, rather than trusting the order the
  // API returned.
  //
  // GitHub orders this endpoint by `created_at`, and `created_at` on a release
  // is the date of the COMMIT its tag points at — not the moment the release
  // was made. Two releases cut from one commit therefore tie, and the tie broke
  // backwards: the pack repository's own listing put a release from 14:38 above
  // the one from 15:27, and the install hint below offered the older of the
  // two as the thing to install.
  //
  // That was survivable while versions sorted by themselves and is not now. A
  // sha carries no order, so this list is the ONLY place the question "which of
  // these is newest?" gets answered, and `publish --help` sends people here to
  // ask it.
  const when = (r: { published_at?: unknown; created_at?: unknown }): number => {
    for (const value of [r.published_at, r.created_at]) {
      if (typeof value !== "string") continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    // A release carrying no usable date sinks rather than floats: it cannot be
    // shown as the newest thing on a claim it has not made.
    return Number.NEGATIVE_INFINITY;
  };
  const releases = [...raw].sort((a, b) => when(b) - when(a));
  if (releases.length === 0) {
    return ok(
      stack(
        title(`${spec.owner}/${spec.repo}`, "no releases", opts),
        emptyState(
          {
            what: "This repository has published no releases, so there is nothing to install.",
            hint: "Its author publishes one with:",
            cmd: "failproofai publish",
          },
          opts,
        ),
      ),
    );
  }

  // Which of them is on THIS machine — the question somebody runs this to
  // answer. Read by pack id rather than by source string: a pack installed as
  // `github:o/r@v1` and one installed from the URL are the same pack, and
  // comparing the spellings would say they are not.
  const installedVersions = new Map<string, string>();
  try {
    for (const pack of readInstalledPacks().packs) installedVersions.set(pack.id.toLowerCase(), pack.version);
  } catch {
    /* an unreadable manifest costs the marker, not the listing */
  }
  const here = installedVersions.get(`${spec.owner}/${spec.repo}`.toLowerCase());

  const rows: Array<string[] | { section: string }> = [];
  // The newest INSTALLABLE tag for the hint below, picked in this same pass —
  // GitHub returns releases newest-first. It used to be a second `find` over the
  // raw list, which disagreed with the loop twice: a release whose `tag_name`
  // was an empty string is skipped below but passed that `typeof === "string"`
  // test, so the hint read `policies add owner/repo@`, and a release carrying
  // none of the three assets was offered as the thing to install.
  let newest: string | undefined;
  for (const release of releases) {
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    if (!tag) continue;
    const facts = parseReleaseBody(typeof release.body === "string" ? release.body : "");
    const when = typeof release.published_at === "string" ? release.published_at
      : typeof release.created_at === "string" ? release.created_at
        : "";
    // By NAME, not by count. Counting said "three attachments" where the claim
    // is "these three attachments", so any repository that ships three binaries
    // per release — most of them — read as installable, and one that attaches
    // nothing at all read as fine. Both then sent somebody to an install that
    // 404s on an asset that was never there.
    const attached = Array.isArray(release.assets)
      ? new Set(
        (release.assets as Array<{ name?: unknown }>)
          .map((a) => (a && typeof a.name === "string" ? a.name : ""))
          .filter(Boolean),
      )
      : new Set<string>();
    const installable = INSTALLABLE_PACK_ASSETS.every((name) => attached.has(name));
    const flags = [
      release.draft === true ? "draft" : "",
      release.prerelease === true ? "prerelease" : "",
      installable ? "" : "incomplete",
      here && packTagMatchesVersion(tag, here) ? "installed" : "",
    ].filter(Boolean).join(" · ");
    if (newest === undefined && installable && release.draft !== true) newest = tag;
    rows.push([
      tag,
      when ? relativeAge(when) : "—",
      facts.commit ? facts.commit.slice(0, 7) : "—",
      facts.policies === undefined ? "—" : String(facts.policies),
      facts.defaultOn === undefined ? "—" : String(facts.defaultOn),
      flags,
    ]);
  }
  return ok(
    stack(
      title(`${spec.owner}/${spec.repo}`, `${rows.length} release${rows.length === 1 ? "" : "s"}`, opts),
      table(
        { head: ["version", "published", "commit", "policies", "default", ""], rows },
        opts,
      ),
      // `—` is load-bearing: it means "this release did not say", which is what
      // a release published before this format did, and what anybody else's
      // hand-made release does. Filling those in would cost a manifest download
      // each, and a listing that silently costs a hundred downloads is worse
      // than one with gaps in it.
      note("— means the release did not record it.", opts),
      nextStep(
        `failproofai policies add ${spec.owner}/${spec.repo}@${newest ?? "<tag>"}`,
        "Install a particular one with:",
        opts,
      ),
    ),
  );
}

/** `2 hours ago`, `6 days ago`. Coarse on purpose — the question is "how stale",
 *  and a timestamp to the second answers a question nobody asked. */
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  // Each pair is "divide by this, and the result is measured in THAT" — so the
  // label belongs to the unit arrived at, never the one left behind. Written
  // the other way round it was off by a whole unit across the entire range: a
  // release from yesterday read `1 hour ago`, one from six months ago read
  // `5 weeks ago`, and 90 seconds read `just now`. The column exists to answer
  // "how stale is this pack", so an answer two units too fresh is worse than no
  // column at all.
  const units: Array<[number, string]> = [
    [60, "minute"], [60, "hour"], [24, "day"], [7, "week"], [4.35, "month"], [12, "year"],
  ];
  let value = seconds;
  let label = "second";
  for (const [size, next] of units) {
    if (value < size) break;
    value = Math.floor(value / size);
    label = next;
  }
  if (label === "second" && value < 60) return value < 10 ? "just now" : `${value} seconds ago`;
  return `${value} ${label}${value === 1 ? "" : "s"} ago`;
}

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
      // pack out there contains; `--releases` is what it has published over
      // time. All three are "show me", which is why they are one word with a
      // flag rather than a third subcommand nobody would find.
      const source = packAddSource(rest);
      if (rest.includes("--releases")) {
        if (!source) {
          return fail([
            "Usage: failproofai policies show <owner>/<repo> --releases",
            "`--releases` reports what a pack out there has published; run `failproofai policies` for what is installed here.",
          ]);
        }
        return listReleases(source);
      }
      return source ? listRemote(source) : list();
    }
    default:
      return fail([`Unknown pack subcommand ${JSON.stringify(sub)}`, "Try: add, remove, list, build"]);
  }
}
