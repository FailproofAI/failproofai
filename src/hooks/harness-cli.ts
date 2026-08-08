/**
 * `failproofai harness` — manage extra capture paths per harness.
 *
 * Each supported agent CLI has one location its own installer put it in, and
 * the collector watches that. This command adds others: a second profile, a
 * bind-mounted team share, a container's home mapped in beside the host's, an
 * agent an operator relocated. Those hold real sessions and nothing collected
 * them.
 *
 * # This file edits config; the daemon decides what the config means
 *
 * Entries are stored as written. The grammar (`label=path`, folder-name
 * fallback), `~` expansion, overlap rejection and the `<label>-<agentId>`
 * namespacing all live in `crates/fpai-collect/src/extra_paths.rs`, and the
 * daemon reports what it rejected at startup. Re-implementing any of that here
 * would give one product two parsers, and the way that fails is the CLI
 * accepting a path the daemon then silently drops — which is indistinguishable
 * from the feature working.
 *
 * The one thing validated here is the HARNESS NAME, because that failure has no
 * other detector: `[collector.sources.claud]` is valid TOML, parses cleanly,
 * captures nothing, and is mentioned nowhere else a user would look.
 *
 * # No restart, and no sudo
 *
 * This writes one file in the user's own home and nothing else. The daemon's
 * collector manager re-reads `config.toml` on an interval and cycles the
 * collector whenever the resolved `CollectorConfig` changes — the same path
 * that already picks up `--connect`, a stream being switched off, and a
 * verbosity change. `extra_paths` rides it for free by living inside
 * `Settings`, which is part of the value being compared. That is load-bearing
 * rather than incidental, and `collector_config_change_cycles_the_collector`
 * in `crates/fpai-collect/src/config.rs` pins it: move `sources` out of
 * `CollectorConfig` and the CLI would keep reporting success for paths the
 * running daemon never picks up.
 */

import { readConfig, updateConfig } from "./fp-config";
import { configFile } from "./fp-home";

/**
 * Harness keys `[collector.sources.<key>]` accepts.
 *
 * MUST stay in step with `HARNESS_KEYS` in `crates/failproofaid/src/main.rs`,
 * which is the side that actually registers the tasks. A name here that the
 * daemon does not know configures a table nothing reads; a name the daemon
 * knows and this list omits is a path the user cannot add. `__tests__` asserts
 * the two lists are identical by reading the Rust source, because nothing else
 * connects them.
 *
 * Twelve keys, thirteen sources: `claude` covers both the main and the subagent
 * transcript formats, which share a root — an extra path holding Claude
 * transcripts holds their subagents too.
 */
export const HARNESS_KEYS = [
  "claude",
  "codex",
  "copilot",
  "openclaw",
  "pi",
  "factory",
  "antigravity",
  "cursor",
  "goose",
  "opencode",
  "devin",
  "hermes",
] as const;

export type HarnessKey = (typeof HARNESS_KEYS)[number];

export interface HarnessResult {
  lines: string[];
  exitCode: number;
}

const ok = (lines: string[]): HarnessResult => ({ lines, exitCode: 0 });
const fail = (lines: string[]): HarnessResult => ({ lines, exitCode: 1 });

function unknownHarness(name: string): HarnessResult {
  return fail([
    `Unknown harness: ${name}`,
    "",
    `Known harnesses: ${HARNESS_KEYS.join(", ")}`,
  ]);
}

/** The path half of an entry, for comparing against what a user typed. */
function pathOf(entry: string): string {
  const eq = entry.indexOf("=");
  if (eq <= 0) return entry.trim();
  const label = entry.slice(0, eq).trim();
  return label === "" ? entry.trim() : entry.slice(eq + 1).trim();
}

/** The label half, or `null` when the entry did not name one. */
function labelOf(entry: string): string | null {
  const eq = entry.indexOf("=");
  if (eq <= 0) return null;
  const label = entry.slice(0, eq).trim();
  return label === "" ? null : label;
}

function currentPaths(harness: string): string[] {
  return readConfig().collector.sources?.[harness]?.extraPaths ?? [];
}

function writePaths(harness: string, paths: string[]): void {
  const cfg = readConfig();
  const sources = { ...(cfg.collector.sources ?? {}) };
  if (paths.length > 0) sources[harness] = { extraPaths: paths };
  else delete sources[harness];
  updateConfig({
    collector: {
      ...cfg.collector,
      // `undefined` rather than `{}` when the last entry goes, so removing what
      // you added leaves the file as it was rather than carrying an empty table
      // forever.
      sources: Object.keys(sources).length > 0 ? sources : undefined,
    },
  });
}

/**
 * No restart, and deliberately no instruction to perform one.
 *
 * The daemon's collector manager re-reads `config.toml` on an interval and
 * cycles the collector whenever the resolved `CollectorConfig` changes — the
 * same path that already picks up `--connect`, a stream being switched off and
 * a verbosity change. `extra_paths` rides that for free because it lives inside
 * `Settings`, which lives inside the value being compared.
 *
 * Verified live: adding a path to a running daemon logged "collector
 * configuration changed; cycling the collector", took the task count from 21 to
 * 23, and the first transcript written under the new path reached the server.
 *
 * This said "run `sudo systemctl restart failproofaid@$USER`" first. That was
 * wrong twice over: the restart is unnecessary, and it asks for root from a
 * command that writes one file in the user's own home and needs none.
 */
const TAKES_EFFECT_HINT = [
  "",
  "The daemon picks this up on its own within a few seconds — no restart, no sudo.",
];

export function addPath(harness: string, entry: string): HarnessResult {
  if (!(HARNESS_KEYS as readonly string[]).includes(harness)) return unknownHarness(harness);
  const trimmed = entry.trim();
  if (trimmed === "") return fail(["A path is required."]);
  if (pathOf(trimmed) === "") {
    return fail([`Could not read a path out of ${JSON.stringify(entry)}.`, "", "Use `<path>` or `<label>=<path>`."]);
  }

  const existing = currentPaths(harness);

  // Exact duplicate: succeed rather than error. `add-path` run twice from a
  // provisioning script must not fail the second time.
  if (existing.includes(trimmed)) {
    return ok([`${harness}: ${trimmed} is already configured.`]);
  }

  // Same path under a different label, or the same label on a different path.
  // Both are rejected HERE rather than left to the daemon, because the daemon
  // resolves them at startup and drops one — so the CLI would report success
  // for a path that is never captured.
  const samePath = existing.find((e) => pathOf(e) === pathOf(trimmed));
  if (samePath) {
    return fail([
      `${harness} already captures ${pathOf(trimmed)} as ${JSON.stringify(samePath)}.`,
      "",
      "Remove it first if you meant to relabel it:",
      `  failproofai harness remove-path ${harness} ${pathOf(trimmed)}`,
    ]);
  }
  const wanted = labelOf(trimmed);
  if (wanted) {
    const sameLabel = existing.find((e) => labelOf(e) === wanted);
    if (sameLabel) {
      return fail([
        `${harness} already uses the label ${JSON.stringify(wanted)} for ${pathOf(sameLabel)}.`,
        "",
        "Labels namespace agent ids, so two paths cannot share one.",
      ]);
    }
  }

  writePaths(harness, [...existing, trimmed]);
  return ok([
    `${harness}: now also capturing ${pathOf(trimmed)}`,
    wanted
      ? `  agent ids will be namespaced ${wanted}-*`
      : "  a label will be derived from the folder name; `failproofai harness list` shows it",
    `  written to ${configFile()}`,
    ...TAKES_EFFECT_HINT,
  ]);
}

export function removePath(harness: string, target: string): HarnessResult {
  if (!(HARNESS_KEYS as readonly string[]).includes(harness)) return unknownHarness(harness);
  const existing = currentPaths(harness);
  const t = target.trim();
  // Match on the whole entry, on its path, or on its label — a user removing
  // something is working from what `list` printed, which shows all three.
  const kept = existing.filter((e) => e !== t && pathOf(e) !== t && labelOf(e) !== t);
  if (kept.length === existing.length) {
    return fail([
      `${harness} has no extra path matching ${JSON.stringify(t)}.`,
      "",
      existing.length > 0
        ? `Configured: ${existing.join(", ")}`
        : `${harness} has no extra paths configured.`,
    ]);
  }
  writePaths(harness, kept);
  return ok([
    `${harness}: no longer capturing ${t}`,
    "",
    "Already-collected sessions from that path are NOT removed — they are on the",
    "server. This only stops new ones.",
    ...TAKES_EFFECT_HINT,
  ]);
}

export function listPaths(harness?: string): HarnessResult {
  if (harness && !(HARNESS_KEYS as readonly string[]).includes(harness)) return unknownHarness(harness);
  const sources = readConfig().collector.sources ?? {};
  const names: string[] = harness
    ? [harness]
    : HARNESS_KEYS.filter((k) => sources[k]?.extraPaths?.length);

  // Computed BEFORE the empty-state return, not after. A config whose only
  // tables are typos has no known harness configured, so the early return fired
  // and the warning below was unreachable in precisely the case it exists for —
  // the user sees "No extra capture paths configured" while their file plainly
  // contains one, which is the most confusing possible answer.
  const unknown = Object.keys(sources).filter(
    (k) => !(HARNESS_KEYS as readonly string[]).includes(k),
  );

  if (names.length === 0 && unknown.length === 0) {
    return ok([
      "No extra capture paths configured.",
      "",
      "Every harness is watching only its default location. Add one with:",
      "  failproofai harness add-path <harness> [<label>=]<path>",
      "",
      `Harnesses: ${HARNESS_KEYS.join(", ")}`,
    ]);
  }

  const lines: string[] = [];
  for (const name of names) {
    const entries = sources[name]?.extraPaths ?? [];
    if (entries.length === 0) {
      if (harness) lines.push(`${name}: no extra paths configured (default location only)`);
      continue;
    }
    lines.push(`${name}:`);
    for (const e of entries) {
      const label = labelOf(e);
      lines.push(
        label
          ? `  ${pathOf(e)}   → agent ids ${label}-*`
          : `  ${pathOf(e)}   → label derived from the folder name`,
      );
    }
  }
  // Unknown tables are surfaced here as well as by the daemon: a user who
  // hand-edited config.toml runs `list` to check it, and that is the moment the
  // typo is cheapest to find.
  if (unknown.length > 0) {
    if (lines.length === 0) lines.push("No extra capture paths configured for any known harness.");
    lines.push(
      "",
      `⚠ config.json configures ${unknown.length} unknown harness(es): ${unknown.join(", ")}`,
      "  Nothing is captured from them.",
      `  Known: ${HARNESS_KEYS.join(", ")}`,
    );
  }
  return ok(lines);
}

/** Dispatch for `failproofai harness <sub> ...`. */
export function runHarnessCommand(argv: string[]): HarnessResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add-path":
      if (rest.length < 2) {
        return fail(["Usage: failproofai harness add-path <harness> [<label>=]<path>"]);
      }
      return addPath(rest[0], rest.slice(1).join(" "));
    case "remove-path":
      if (rest.length < 2) {
        return fail(["Usage: failproofai harness remove-path <harness> <path|label>"]);
      }
      return removePath(rest[0], rest.slice(1).join(" "));
    case "list":
      return listPaths(rest[0]);
    default:
      return fail([
        sub ? `Unknown subcommand: ${sub}` : "A subcommand is required.",
        "",
        "Usage:",
        "  failproofai harness list [<harness>]",
        "  failproofai harness add-path <harness> [<label>=]<path>",
        "  failproofai harness remove-path <harness> <path|label>",
      ]);
  }
}
