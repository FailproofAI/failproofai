/**
 * `failproofai pack add | remove | list`.
 *
 * Presentation only — every rule about what a pack may be lives in
 * `pack-manifest.ts` (what may load) and `pack-store.ts` (what may install).
 * This layer decides nothing; it formats.
 */
import { readInstalledPacks } from "./pack-manifest";
import { addPack, removePack } from "./pack-store";

export interface PackCliResult {
  lines: string[];
  exitCode: number;
}

const ok = (lines: string[]): PackCliResult => ({ lines, exitCode: 0 });
const fail = (lines: string[]): PackCliResult => ({ lines, exitCode: 1 });

function parseOnly(rest: string[]): string[] | undefined {
  const idx = rest.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (idx === -1) return undefined;
  const raw = rest[idx].includes("=") ? rest[idx].split("=").slice(1).join("=") : rest[idx + 1];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function add(rest: string[]): Promise<PackCliResult> {
  const source = rest.find((a) => !a.startsWith("--"));
  if (!source) return fail(["Usage: failproofai pack add <github:owner/repo@tag> [--only a,b]"]);
  const only = parseOnly(rest);
  if (only && only.length === 0) {
    return fail(["--only needs at least one policy name, comma-separated"]);
  }
  try {
    const result = await addPack(source, only ? { only } : undefined);
    const lines = [
      result.resolvedFromLatest
        ? `Installed ${result.id}@${result.version} from ${result.source} (newest release; pinned to ${result.tag})`
        : `Installed ${result.id}@${result.version} from ${result.source}`,
    ];
    const skipped = result.available.filter((n) => !result.enabled.includes(n));
    lines.push(`  enabled: ${result.enabled.join(", ")}`);
    if (skipped.length > 0) {
      // Named rather than counted: "3 not enabled" is the kind of summary that
      // reads as fine until someone discovers which three.
      lines.push(`  not enabled: ${skipped.join(", ")}`);
      lines.push(`  add them with: failproofai pack add ${source} --only ${result.available.join(",")}`);
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
  const lines: string[] = [];
  if (packs.length === 0 && errors.length === 0) {
    return ok([
      "No packs installed.",
      "",
      "  failproofai pack add github:owner/repo@tag",
    ]);
  }
  for (const pack of packs) {
    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    lines.push(`${pack.id}@${pack.version}  (${pack.effect})`);
    lines.push(`  source:  ${pack.source}`);
    lines.push(`  sha256:  ${pack.sha256.slice(0, 16)}…`);
    for (const policy of pack.policies) {
      const mark = taken.includes(policy.name) ? "on " : "off";
      lines.push(`  ${mark}  ${policy.name} — ${policy.description}`);
    }
  }
  // Never silent: a pack that was installed and now refuses to load is exactly
  // the state someone needs told about, since the machine is enforcing less
  // than its manifest says.
  for (const err of errors) {
    lines.push(`NOT LOADED  ${err.id ?? "(unnamed)"}: ${err.reason}`);
  }
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
