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
 * other detector: `collector.sources.claud` is valid JSON, parses cleanly,
 * captures nothing, and is mentioned nowhere else a user would look.
 *
 * # No restart, and no sudo
 *
 * This writes one file in the user's own home and nothing else. The daemon's
 * collector manager re-reads `config.json` on an interval and cycles the
 * collector whenever the resolved `CollectorConfig` changes — the same path
 * that already picks up `--connect`, a stream being switched off, and a
 * verbosity change. `extra_paths` rides it for free by living inside
 * `Settings`, which is part of the value being compared. That is load-bearing
 * rather than incidental, and `collector_config_change_cycles_the_collector`
 * in `crates/fpai-collect/src/config.rs` pins it: move `sources` out of
 * `CollectorConfig` and the CLI would keep reporting success for paths the
 * running daemon never picks up.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { isAgentTraced, readConfig, updateConfig } from "./fp-config";
import { configFile } from "./fp-home";
import { getIntegration } from "./integrations";
import { optsFor, screenKit } from "./tui";
import type { IntegrationType } from "./types";

/**
 * Harness keys `collector.sources.<key>` accepts.
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
const kitFor = () => screenKit(optsFor(process.stdout));

function unknownHarness(name: string): HarnessResult {
  const kit = kitFor();
  return fail([kit.fail(`Unknown harness: ${name}.`), `  Known: ${HARNESS_KEYS.join(", ")}`]);
}

/**
 * An agent `failproofai config` does not trace collects nothing, extra paths
 * included: the daemon starts no task for it. Said wherever a path is shown or
 * added, because otherwise a configured path reads as captured.
 */
function untracedLine(harness: string): string[] {
  if (isAgentTraced(harness)) return [];
  const kit = kitFor();
  const name = getIntegration(harness as IntegrationType).displayName;
  return [kit.caution(`${name} isn't traced, so nothing is captured from its paths until it is.`, "failproofai config")];
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
 * The daemon's collector manager re-reads `config.json` on an interval and
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
const TAKES_EFFECT_HINT = ["  The daemon picks this up within a few seconds: no restart, no sudo."];

/**
 * The daemon's label rule, FOR COMPARISON ONLY.
 *
 * Mirrors `sanitize_label()` in `crates/fpai-collect/src/extra_paths.rs`:
 * lowercase, every non-alphanumeric run collapsed to one `-`, leading and
 * trailing dashes trimmed.
 *
 * Deliberately NOT used to rewrite what is stored. The daemon is the authority on
 * the grammar, and this file's header is explicit that it must not re-implement
 * the parser — "two parsers is how the CLI comes to accept a path the daemon then
 * silently drops". Normalising for a duplicate CHECK is the narrow opposite of
 * that: it makes the CLI's own pre-flight agree with the rule it exists to
 * pre-empt, while the stored string stays exactly what the user typed and the
 * daemon still derives the real label.
 */
function comparableLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The daemon's path rule, for comparison only. Mirrors `clean()`: `~/` expanded,
 * trailing slashes trimmed.
 */
function comparablePath(raw: string): string {
  const home = homedir();
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? resolve(home, raw.slice(2)) : raw;
  return expanded.replace(/\/+$/, "");
}

/**
 * What the daemon will call this entry, label given or derived.
 *
 * Mirrors `derive_label()` for the unlabelled case: the folder name with a leading
 * dot stripped, then sanitised. Without this an unlabelled
 * `/mnt/team-a/.claude/projects` and `/mnt/team-b/.claude/projects` both derive
 * "projects" — the CLI's label check was skipped entirely for unlabelled entries,
 * so both were written and the daemon silently dropped the second.
 */
function effectiveLabel(entry: string): string {
  const given = labelOf(entry);
  if (given) return comparableLabel(given);
  const path = comparablePath(pathOf(entry));
  const base = path.split("/").filter(Boolean).pop() ?? "";
  return comparableLabel(base.replace(/^\.+/, ""));
}

export function addPath(harness: string, entry: string): HarnessResult {
  if (!(HARNESS_KEYS as readonly string[]).includes(harness)) return unknownHarness(harness);
  const kit = kitFor();
  const trimmed = entry.trim();
  if (trimmed === "") return fail([kit.fail("A path is required.")]);
  if (pathOf(trimmed) === "") {
    return fail([kit.fail(`Could not read a path out of ${JSON.stringify(entry)}.`), `  Use  ${kit.cmd("<path>")}  or  ${kit.cmd("<label>=<path>")}`]);
  }

  const existing = currentPaths(harness);

  // Exact duplicate: succeed rather than error. `add-path` run twice from a
  // provisioning script must not fail the second time.
  if (existing.includes(trimmed)) {
    return ok([kit.ok(`${harness}: ${trimmed} is already configured.`), ...untracedLine(harness)]);
  }

  // Same path under a different label, or the same label on a different path.
  // Both are rejected HERE rather than left to the daemon, because the daemon
  // resolves them at startup and drops one — so the CLI would report success
  // for a path that is never captured.
  // Compared NORMALISED, not raw. `add-path claude a=/srv/x/` then
  // `add-path claude b=/srv/x` differ as strings and are the same path to the
  // daemon, which resolves them at startup and drops one — so the CLI reported
  // success for a path that is never captured.
  const samePath = existing.find((e) => comparablePath(pathOf(e)) === comparablePath(pathOf(trimmed)));
  if (samePath) {
    return fail([
      kit.fail(`${harness} already captures ${pathOf(trimmed)} as ${JSON.stringify(samePath)}.`),
      `  To relabel it, remove it first:  ${kit.cmd(`failproofai harness remove-path ${harness} ${pathOf(trimmed)}`)}`,
    ]);
  }
  const wanted = labelOf(trimmed);
  // The EFFECTIVE label, normalised, and computed for unlabelled entries too.
  // Three inputs slipped past the old exact-string check on the given label:
  // `"Team Share"` vs `team-share` (the daemon lowercases and substitutes), and two
  // unlabelled paths whose folder name derives the same label — for which the check
  // did not run at all. In every case both entries were written, `harness list`
  // showed both, and only one was captured.
  const effective = effectiveLabel(trimmed);
  const sameLabel = effective
    ? existing.find((e) => effectiveLabel(e) === effective)
    : undefined;
  if (sameLabel) {
    // Labels namespace agent ids, and the daemon lowercases them and collapses
    // punctuation, so labels differing only in case or spacing collide; an
    // unlabelled path takes its folder name.
    return fail([
      kit.fail(`${harness} already uses the label ${JSON.stringify(effective)} for ${pathOf(sameLabel)}.`),
      `  Give this one its own label:  ${kit.cmd(`failproofai harness add-path ${harness} <label>=${pathOf(trimmed)}`)}`,
    ]);
  }

  writePaths(harness, [...existing, trimmed]);
  return ok([
    // "configured", NOT "now capturing". The checks above cover what this side can
    // know — the entries already in the file — and there is one rejection it
    // cannot: a path overlapping the harness's own DEFAULT capture root, which the
    // daemon owns and refuses. Claiming capture there was a promise this command
    // is not in a position to make, so it says what it did and where the answer
    // is. Teaching the CLI all thirteen sources' default roots would be the second
    // parser this file exists to avoid.
    //
    // And `harness list` is not where the answer is: it reads this same file, so
    // it shows what is configured, not what is captured. The daemon's log is.
    kit.ok(`${harness}: configured to also capture ${pathOf(trimmed)}`),
    wanted ? `  Agent ids are namespaced ${wanted}-*` : "  A label is derived from the folder name.",
    `  Written to ${configFile()}`,
    "  The daemon validates it on the next read and logs any path it rejects.",
    ...TAKES_EFFECT_HINT,
    ...untracedLine(harness),
  ]);
}

export function removePath(harness: string, target: string): HarnessResult {
  if (!(HARNESS_KEYS as readonly string[]).includes(harness)) return unknownHarness(harness);
  const existing = currentPaths(harness);
  const t = target.trim();
  // Match on the whole entry, on its path, or on its label — a user removing
  // something is working from what `list` printed, which shows all three.
  const kept = existing.filter((e) => e !== t && pathOf(e) !== t && labelOf(e) !== t);
  const kit = kitFor();
  if (kept.length === existing.length) {
    return fail([
      kit.fail(`${harness} has no extra path matching ${JSON.stringify(t)}.`),
      existing.length > 0 ? `  Configured: ${existing.join(", ")}` : `  ${harness} has no extra paths configured.`,
    ]);
  }
  writePaths(harness, kept);
  return ok([
    kit.ok(`${harness}: no longer capturing ${t}`),
    "  Sessions already collected from it stay on the server; this only stops new ones.",
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

  const kit = kitFor();
  const header = [kit.header("Harness"), ""];
  const unknownLines =
    unknown.length > 0
      ? [
          "",
          kit.caution(
            `config.json configures ${unknown.length === 1 ? "an unknown harness" : `${unknown.length} unknown harnesses`}: ${unknown.join(", ")}. Nothing is captured from ${unknown.length === 1 ? "it" : "them"}.`,
          ),
          `  Known: ${HARNESS_KEYS.join(", ")}`,
        ]
      : [];

  const configured = names.reduce((n, name) => n + (sources[name]?.extraPaths?.length ?? 0), 0);
  if (configured === 0 && !harness) {
    return ok([
      ...header,
      "No extra capture paths configured. Every agent reads only its default location.",
      `  Add one:  ${kit.cmd("failproofai harness add-path <agent> [label=]<path>")}`,
      ...unknownLines,
    ]);
  }

  const lines: string[] = [...header];
  for (const name of names) {
    const entries = sources[name]?.extraPaths ?? [];
    const count = `${entries.length} extra path${entries.length === 1 ? "" : "s"}`;
    lines.push(kit.head(name, entries.length > 0 ? count : "default location only"));
    // Rows of path then agent ids. The PATH is the value this listing exists
    // to hand back, so it is never cut.
    lines.push(
      ...kit.rows(
        entries.map((e): [string, string] => {
          const label = labelOf(e);
          return [pathOf(e), label ? `${label}-*` : "derived from the folder name"];
        }),
      ),
    );
    lines.push(...untracedLine(name), "");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return ok([...lines, ...unknownLines]);
}

/** Dispatch for `failproofai harness <sub> ...`. */
export function runHarnessCommand(argv: string[]): HarnessResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add-path":
      if (rest.length < 2) {
        return fail([kitFor().fail("add-path needs an agent and a path."), `  Usage:  ${kitFor().cmd("failproofai harness add-path <agent> [label=]<path>")}`]);
      }
      return addPath(rest[0], rest.slice(1).join(" "));
    case "remove-path":
      if (rest.length < 2) {
        return fail([kitFor().fail("remove-path needs an agent and a path or label."), `  Usage:  ${kitFor().cmd("failproofai harness remove-path <agent> <path | label>")}`]);
      }
      return removePath(rest[0], rest.slice(1).join(" "));
    case "list":
      return listPaths(rest[0]);
    default: {
      const kit = kitFor();
      return fail([
        kit.fail(sub ? `Unknown subcommand: ${sub}.` : "A subcommand is required."),
        `  ${kit.cmd("failproofai harness list [agent]")}`,
        `  ${kit.cmd("failproofai harness add-path <agent> [label=]<path>")}`,
        `  ${kit.cmd("failproofai harness remove-path <agent> <path | label>")}`,
      ]);
    }
  }
}
