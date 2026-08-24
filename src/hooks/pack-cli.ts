/**
 * `failproofai pack add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
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
  installBundledPack,
  removePack,
  slugifyCategory,
} from "./pack-store";
import type { PolicyEffect } from "./cloud-managed-policies";
import { loadCustomHooks } from "./custom-hooks-loader";
import {
  chip,
  emptyState,
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

/**
 * The short name for the pack Failproof AI publishes.
 *
 * `failproofai pack add FailproofAI/policies` is the honest form and nobody is
 * going to type it. This resolves to the copy that ships inside the package, so
 * it also needs no network and cannot fail on a corporate proxy — the fastest
 * path to a guarded machine is a word.
 *
 * Deliberately not "builtin": these stop being builtins, that is the whole point
 * of publishing them as a pack, and a command that teaches the old word on the
 * way out is a command we would have to un-teach.
 */
const CORE_ALIASES = new Set(["core", "failproofai", "official"]);

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
      "Usage: failproofai pack build <entry.mjs> --id <publisher/name> --version <version>",
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
    `  failproofai pack add <owner>/<repo>`,
  ]);
}

async function add(rest: string[]): Promise<PackCliResult> {
  const source = packAddSource(rest);
  const selection = selectionFrom(rest);

  // Our own pack, by the short name — and from the copy inside this package, so
  // it is instant and works with no network at all.
  if ((source && CORE_ALIASES.has(source.toLowerCase())) || rest.includes("--bundled")) {
    const result = installBundledPack(selection);
    if (!result.installed) {
      return fail([`Could not install the Failproof AI policies: ${result.reason}`]);
    }
    const enabled = result.enabled ?? [];
    const available = result.available ?? [];
    const skipped = available.filter((n) => !enabled.includes(n));
    const lines = [
      `Installed ${result.id}@${result.version} from this package — no network needed.`,
      `  enabled (${enabled.length}/${available.length}): ${summarise(enabled)}`,
    ];
    if (skipped.length > 0) {
      lines.push(`  not enabled (${skipped.length}): ${summarise(skipped)}`);
      lines.push("");
      lines.push("  one policy:    failproofai pack add core --policy block-rm-rf");
      lines.push("  a category:    failproofai pack add core --category dangerous-commands");
      lines.push("  everything:    failproofai pack add core --all");
      lines.push("  see them all:  failproofai pack list");
    }
    return ok(lines);
  }

  if (!source) {
    return fail(["Usage: failproofai pack add <source> [--only a,b] [--category x,y] [--all]"]);
  }
  if (selection.only && selection.only.length === 0) {
    return fail(["--policy needs at least one policy name, comma-separated"]);
  }
  if (selection.categories && selection.categories.length === 0) {
    return fail(["--category needs at least one category, comma-separated"]);
  }

  try {
    const result = await addPack(source, selection);
    const lines = [
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
      lines.push(`  see all:      failproofai pack list`);
      if (result.categories.length > 0) {
        lines.push(`  by category:  failproofai pack add ${source} --category ${result.categories.slice(0, 3).join(",")}`);
      }
      lines.push(`  everything:   failproofai pack add ${source} --all`);
    }
    return ok(lines);
  } catch (err) {
    return fail([`Could not install pack: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

function remove(rest: string[]): PackCliResult {
  const id = rest[0];
  if (!id) return fail(["Usage: failproofai pack remove <publisher/name>"]);
  if (!removePack(id)) return fail([`No installed pack with id ${id}`]);
  return ok([
    `Removed ${id}. Its artifact is kept on disk, so re-adding it works offline.`,
  ]);
}

async function list(): Promise<PackCliResult> {
  const { packs, errors } = readInstalledPacks();
  const opts = optsFor(process.stdout);
  const policyCount = packs.reduce((n, pack) => n + pack.policies.length, 0);
  const head = title(
    "failproofai pack list",
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
            cmd: "failproofai pack add github:owner/repo@tag",
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
          `failproofai pack add ${source} --category ${slugs.slice(0, 3).join(",")}`,
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
    case undefined:
      return list();
    default:
      return fail([`Unknown pack subcommand ${JSON.stringify(sub)}`, "Try: add, remove, list, build"]);
  }
}
