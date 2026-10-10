/**
 * `failproofai backfill` — re-ship history the collector has already read past.
 *
 * The collector never re-reads a file it has a cursor for, which is right for
 * steady state and wrong exactly twice:
 *
 *   • the dashboard's data was cleared, or a machine was re-enrolled into a
 *     different org, and the history on disk is now the only copy;
 *   • cursors advanced before there was anywhere to send to, so everything
 *     before the connection was never shipped at all.
 *
 * Both leave a machine whose transcripts exist locally and nowhere else, with no
 * way to ask for them again short of deleting files by hand and hoping.
 *
 * SAFE BY CONSTRUCTION, not by luck. Re-reading is already the documented
 * recovery path for a damaged cursor store — "starting over re-ships records the
 * server already dedups" — and redaction is deterministic, so a re-shipped event
 * hashes identically to its first send and collapses into the row that is
 * already there rather than duplicating it.
 *
 * HANDS OFF rather than doing the work. The cursors it needs to rewind are held
 * in memory by the RUNNING collector, which would write them straight back over;
 * only the daemon can stop the collector first. So this writes a request the
 * daemon drains on its next tick.
 *
 * What it does NOT hand off is the checking. Every precondition a person can get
 * wrong — no daemon, no credential, collection switched off — is verified here,
 * synchronously, before returning. The alternative is what already happened once
 * on a real machine: the CLI reported success, and the actual failure sat in the
 * journal for twenty minutes while batches parked.
 */
import { existsSync } from "node:fs";

import { failproofaiHome } from "./fp-home";
import { readConfig } from "./fp-config";
import { readIngestCredential } from "./collector-config";
import { daemonServiceStatus, daemonVersionSkew, isDaemonSupportedPlatform } from "./daemon-service";
import { backfillRequestPath, writeBackfillRequest } from "./backfill-request";
import { getIntegration } from "./integrations";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";
import { screenKit, type RenderOpts } from "./tui";
import { getAdapter } from "../audit/cli-adapters";

/** Default window. `--since` widens it. */
export const DEFAULT_BACKFILL_DAYS = 30;

export interface BackfillOptions {
  /** Epoch ms. Everything modified at or after this is re-read. */
  sinceMs?: number;
  /** Report what would be re-read and write nothing. */
  dryRun?: boolean;
  /** `--agents`: a subset of the traced agents. Unvalidated ids, as typed. */
  agents?: string[];
  /** How the screen is drawn. */
  render?: RenderOpts;
  /** Injected for tests. */
  now?: number;
  /** Injected for tests: sessions an agent has at or after `sinceMs`. */
  countSessions?: (cli: IntegrationType, sinceMs: number) => Promise<number>;
}

export interface BackfillResult {
  exitCode: number;
  lines: string[];
}

export { backfillRequestPath };

/**
 * Agents whose history lives in a database the collector reads by row, with
 * no time window: a backfill re-sends all of it, whatever `--since` says.
 * Hermes keeps one database per profile, and the daemon does not rewind those
 * at all until it can bound them (D7).
 */
const WHOLE_HISTORY: ReadonlySet<IntegrationType> = new Set(["goose", "opencode", "devin"]);
const NOT_RESENT: ReadonlySet<IntegrationType> = new Set(["hermes"]);

/** Sessions an agent has in the window, from the same adapters the audit reads. */
async function adapterSessionCount(cli: IntegrationType, sinceMs: number): Promise<number> {
  try {
    return (await getAdapter(cli).listTranscripts({ sinceMs })).length;
  } catch {
    // An agent whose store cannot be read has nothing to count; the daemon
    // decides what is actually sent either way.
    return 0;
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export async function runBackfillCommand(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const kit = screenKit(opts.render ?? {});
  const now = opts.now ?? Date.now();
  const sinceMs = opts.sinceMs ?? now - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const sinceLabel = new Date(sinceMs).toISOString().slice(0, 10);
  const home = failproofaiHome();
  const fail = (text: string, ...fix: string[]): BackfillResult => ({ exitCode: 1, lines: [kit.fail(text), ...fix] });

  if (!existsSync(home)) {
    return fail(`There is no failproofai home at ${home}.`, `  Set this machine up first:  ${kit.cmd("failproofai config")}`);
  }

  // Checked HERE, not left to the daemon. Handing off an impossible request and
  // reporting success is the failure this command is partly a response to.
  if (!readIngestCredential()) {
    return fail(
      "This machine isn't connected, so there is nowhere to send history.",
      `  Connect it:  ${kit.cmd("failproofai config")}`,
    );
  }

  let sessions = false;
  let hooks = false;
  let selected: IntegrationType[] | null = null;
  try {
    const cfg = readConfig();
    sessions = cfg.collector?.sessions ?? false;
    hooks = cfg.collector?.hooks ?? false;
    if (cfg.agents) selected = INTEGRATION_TYPES.filter((id) => cfg.agents?.selected.includes(id));
  } catch {
    /* an unreadable config is reported as "nothing enabled" below */
  }
  if (!sessions && !hooks) {
    return fail(
      "Collection is switched off, so a backfill would send nothing.",
      `  Turn it on under "collector" in  ${kit.cmd("~/.failproofai/config.json")}`,
    );
  }

  // Traced agents only. With no saved selection every agent is traced, which
  // is how the daemon reads the same file.
  const traced = selected ?? [...INTEGRATION_TYPES];
  let target = traced;
  if (opts.agents && opts.agents.length > 0) {
    const unknown = opts.agents.filter((id) => !(INTEGRATION_TYPES as readonly string[]).includes(id));
    if (unknown.length > 0) {
      return fail(`Not an agent: ${unknown.join(", ")}.`, `  Agents:  ${INTEGRATION_TYPES.join(", ")}`);
    }
    const asked = INTEGRATION_TYPES.filter((id) => opts.agents?.includes(id));
    const untraced = asked.filter((id) => !traced.includes(id));
    if (untraced.length > 0) {
      const names = joinNames(untraced.map((id) => getIntegration(id).displayName));
      return fail(
        `${names} ${untraced.length === 1 ? "isn't" : "aren't"} traced, so ${untraced.length === 1 ? "it" : "they"} can't be backfilled.`,
        `  Trace ${untraced.length === 1 ? "it" : "them"} first with  ${kit.cmd("failproofai config")}  or  ${kit.cmd(
          `failproofai config --agents ${[...new Set([...traced, ...untraced])].filter((id) => INTEGRATION_TYPES.includes(id)).join(",")}`,
        )}`,
      );
    }
    // A daemon older than the scoped request reads every request as "rewind
    // everything", so naming agents to it would re-send all of them. Refused on
    // any mismatch: which side is newer cannot be told from here reliably, and
    // `update` brings both to one version either way.
    const skew = daemonVersionSkew();
    if (skew) {
      return fail(
        `failproofaid ${skew.installed} is running, but this CLI ships ${skew.expected}; naming agents needs them to match.`,
        `  Bring them in line:  ${kit.cmd("failproofai update")}`,
      );
    }
    target = asked;
  }

  const count = opts.countSessions ?? adapterSessionCount;
  const rows: Array<[string, string]> = [];
  let total = 0;
  let agentsWithSessions = 0;
  if (sessions) {
    for (const id of target) {
      const name = getIntegration(id).displayName;
      if (NOT_RESENT.has(id)) {
        rows.push([name, "not re-sent: its sessions have no time window yet"]);
        continue;
      }
      const n = await count(id, WHOLE_HISTORY.has(id) ? 0 : sinceMs);
      if (n === 0) continue;
      total += n;
      agentsWithSessions += 1;
      rows.push([name, WHOLE_HISTORY.has(id) ? `all ${plural(n, "session")}, whatever the window` : plural(n, "session")]);
    }
  }
  const skipped = INTEGRATION_TYPES.filter((id) => !traced.includes(id)).map((id) => getIntegration(id).displayName);

  if (opts.dryRun) {
    const lines = [kit.header("Backfill"), "", kit.head("Would re-send", `since ${sinceLabel}, traced agents only`)];
    if (!sessions) lines.push(`${"  "}Hook decisions only: session collection is off.`);
    else if (rows.length === 0) lines.push("  No sessions on disk in this window.");
    else lines.push(...kit.rows(rows, 14));
    if (skipped.length > 0) lines.push(`  Not traced, skipped: ${skipped.join(", ")}`);
    lines.push("", `Run it for real with ${kit.cmd(opts.agents ? `failproofai backfill --agents ${target.join(",")}` : "failproofai backfill")}`);
    return { exitCode: 0, lines };
  }

  try {
    // Merged with anything still pending rather than written over it, and
    // atomically: see backfill-request.ts. Without --agents the request names
    // nobody, which the daemon reads as "every traced agent" at the moment it
    // acts — a selection changed in between is honoured, not a stale copy.
    writeBackfillRequest({
      kind: "user",
      sinceMs,
      requestedAtMs: now,
      ...(opts.agents && opts.agents.length > 0 ? { agents: target } : {}),
    });
  } catch (err) {
    return {
      exitCode: 2,
      lines: [kit.fail(`Could not write the request: ${err instanceof Error ? err.message : String(err)}`)],
    };
  }

  const what = !sessions
    ? `hook decisions since ${sinceLabel}`
    : total === 0
      ? `everything since ${sinceLabel}`
      : `${plural(total, "session")} from ${plural(agentsWithSessions, "traced agent")} since ${sinceLabel}`;
  const lines = [kit.header("Backfill"), "", kit.ok(`Asked the daemon to re-send ${what}.`)];
  // Named honestly: only what the config enables, because that is all the
  // daemon ships.
  if (sessions && !hooks) lines.push("  Session transcripts only: hook activity collection is off.");
  if (!sessions) lines.push("  Session transcripts are not sent: session collection is off.");
  // A daemon that is not running acts on the request when it next starts — the
  // request is a file, deliberately, so it survives that.
  let waiting = false;
  if (isDaemonSupportedPlatform()) {
    const status = daemonServiceStatus();
    if (status !== "running") {
      waiting = true;
      lines.push(
        kit.caution(`failproofaid is ${status}, so nothing moves until it starts. The request waits for it.`),
        `  Check it:  ${kit.cmd("failproofai config --status")}`,
      );
    }
  }
  if (!waiting) {
    // When, not "now": the daemon re-reads first, so `flush --wait` would only
    // empty a queue that is still being refilled.
    lines.push(`  They reach the dashboard over the next few minutes. Watch them land:  ${kit.cmd("failproofai config --status")}`);
  }
  return { exitCode: 0, lines };
}
