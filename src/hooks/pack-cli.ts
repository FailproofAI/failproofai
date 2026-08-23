/**
 * `failproofai pack add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
import { readInstalledPacks } from "./pack-manifest";
import { addPack, removePack, slugifyCategory } from "./pack-store";
import {
  chip,
  emptyState,
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

/** Find the positional source without mistaking a flag's separate value for it. */
export function packAddSource(rest: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--only" || rest[i] === "--category") consumed.add(i + 1);
  }
  return rest.find((arg, index) => !arg.startsWith("--") && !consumed.has(index));
}

/** Name a handful, then say how many more and where to see them. A 37-name wall
 *  is not information, and a count alone is not either. */
function summarise(names: string[], limit = 6): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
}

async function add(rest: string[]): Promise<PackCliResult> {
  const source = packAddSource(rest);
  if (!source) {
    return fail(["Usage: failproofai pack add <source> [--only a,b] [--category x,y] [--all]"]);
  }
  const only = parseList(rest, "--only");
  const categories = parseList(rest, "--category");
  const all = rest.includes("--all");
  if (only && only.length === 0) return fail(["--only needs at least one policy name, comma-separated"]);
  if (categories && categories.length === 0) return fail(["--category needs at least one category, comma-separated"]);

  try {
    const result = await addPack(source, {
      ...(only ? { only } : {}),
      ...(categories ? { categories } : {}),
      ...(all ? { all } : {}),
    });
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

function list(): PackCliResult {
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
  for (const pack of packs) {
    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    groups.push(rule(`${pack.id}@${pack.version}`, opts));
    groups.push(
      kitRows(
        [
          ["source", pack.source],
          ["digest", `${pack.sha256.slice(0, 16)}…`],
          ["effect", pack.effect],
          ["enabled", `${taken.length}/${pack.policies.length}`],
        ],
        opts,
      ),
    );
    // The category is a COLUMN rather than a set of sub-headings because it is
    // what `--category` selects on: seeing the slug next to every policy is what
    // tells someone the flag exists, and the suggestion below spells it out.
    groups.push(
      table(
        {
          head: ["", "Policy", "Category", "Description"],
          rows: pack.policies.map((policy) => [
            chip(taken.includes(policy.name) ? "on" : "off", opts),
            policy.name,
            slugifyCategory(policy.category),
            policy.description,
          ]),
        },
        opts,
      ),
    );
    const slugs = [...new Set(pack.policies.map((p) => slugifyCategory(p.category)))];
    if (taken.length < pack.policies.length && slugs.length > 0) {
      groups.push(
        nextStep(
          `failproofai pack add ${pack.id} --category ${slugs.slice(0, 3).join(",")}`,
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

  const lines = stack(...groups);
  return errors.length > 0 ? fail(lines) : ok(lines);
}

export async function runPackCommand(argv: string[]): Promise<PackCliResult> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return add(rest);
    case "remove":
      return remove(rest);
    case "list":
    case undefined:
      return list();
    default:
      return fail([`Unknown pack subcommand ${JSON.stringify(sub)}`, "Try: add, remove, list"]);
  }
}
