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
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { failproofaiHome } from "./fp-home";
import { readConfig } from "./fp-config";
import { readIngestCredential } from "./collector-config";
import { daemonServiceStatus, isDaemonSupportedPlatform } from "./daemon-service";

/** Default window. `--since` widens it. */
export const DEFAULT_BACKFILL_DAYS = 30;

export interface BackfillOptions {
  /** Epoch ms. Everything modified at or after this is re-read. */
  sinceMs?: number;
  /** Report what would be re-read and write nothing. */
  dryRun?: boolean;
  /** Injected for tests. */
  now?: number;
}

export interface BackfillResult {
  exitCode: number;
  lines: string[];
}

/**
 * `~/.failproofai/state/backfill-request.json` — mirrored from the daemon's
 * `paths::backfill_request_path()`. Two processes, one path; the comment there
 * says why that is written down twice rather than derived.
 */
export function backfillRequestPath(home?: string): string {
  return join(failproofaiHome(home), "state", "backfill-request.json");
}

/**
 * Where each agent CLI keeps its transcripts, so the command can say what it is
 * about to re-read rather than asking for trust.
 *
 * Deliberately a SURVEY, not the source of truth. The daemon decides what is
 * actually collected from its own config; this list only produces the sentence
 * a person reads before agreeing. A directory missing here means a quieter
 * message, never a missed backfill.
 */
const SESSION_DIRS: Array<{ cli: string; dir: string }> = [
  { cli: "Claude Code", dir: ".claude/projects" },
  { cli: "OpenAI Codex", dir: ".codex/sessions" },
  { cli: "Cursor", dir: ".cursor/chats" },
  { cli: "GitHub Copilot", dir: ".copilot/history-session-state" },
  { cli: "OpenCode", dir: ".local/share/opencode/storage" },
  { cli: "Factory Droid", dir: ".factory/sessions" },
  { cli: "Antigravity", dir: ".gemini/antigravity-cli/brain" },
];

interface Survey {
  cli: string;
  files: number;
  newest: number;
}

/** What is on disk and inside the window, per CLI. */
function surveySessions(sinceMs: number, homeDir: string): Survey[] {
  const out: Survey[] = [];
  for (const { cli, dir } of SESSION_DIRS) {
    const root = join(homeDir, dir);
    if (!existsSync(root)) continue;
    let files = 0;
    let newest = 0;
    const walk = (d: string, depth: number) => {
      // Bounded: these trees are date-nested a few levels deep, and an
      // unbounded walk on a symlinked home is a way to hang a CLI command.
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1);
          continue;
        }
        try {
          const st = statSync(p);
          if (st.mtimeMs >= sinceMs) {
            files += 1;
            newest = Math.max(newest, st.mtimeMs);
          }
        } catch {
          /* raced away mid-walk */
        }
      }
    };
    walk(root, 0);
    if (files > 0) out.push({ cli, files, newest });
  }
  return out;
}

export function runBackfillCommand(opts: BackfillOptions = {}): BackfillResult {
  const now = opts.now ?? Date.now();
  const sinceMs = opts.sinceMs ?? now - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const home = failproofaiHome();

  if (!existsSync(home)) {
    return {
      exitCode: 1,
      lines: [`No failproofai home at ${home}. Run \`failproofai config\` first.`],
    };
  }

  // Checked HERE, not left to the daemon. Handing off an impossible request and
  // reporting success is the failure this command is partly a response to.
  const ingest = readIngestCredential();
  if (!ingest) {
    return {
      exitCode: 1,
      lines: [
        "This machine is not connected, so there is nowhere to send history.",
        "Connect first: `failproofai config --token <key>`.",
      ],
    };
  }

  let sessions = false;
  let hooks = false;
  try {
    const cfg = readConfig();
    sessions = cfg.collector?.sessions ?? false;
    hooks = cfg.collector?.hooks ?? false;
  } catch {
    /* an unreadable config is reported as "nothing enabled" below */
  }
  if (!sessions && !hooks) {
    return {
      exitCode: 1,
      lines: [
        "Collection is switched off, so a backfill would re-read history and send",
        'none of it. Enable it in ~/.failproofai/config.json under "collector".',
      ],
    };
  }

  const found = surveySessions(sinceMs, dirname(home));
  const totalFiles = found.reduce((n, f) => n + f.files, 0);
  const sinceLabel = new Date(sinceMs).toISOString().slice(0, 10);

  const lines: string[] = [
    `Re-reading everything modified since ${sinceLabel}, and sending it again.`,
    "",
  ];
  // Named honestly: only what the config actually enables, because that is all
  // the daemon will ship. Promising transcripts on a machine with
  // `sessions = false` would be a lie the user could only catch by waiting.
  lines.push(
    `  streams: ${[sessions && "session transcripts", hooks && "hook decisions"]
      .filter(Boolean)
      .join(" + ")}`,
  );
  if (sessions) {
    if (found.length === 0) {
      lines.push("  sessions: none found on disk in this window");
    } else {
      for (const f of found) {
        lines.push(`  ${f.cli}: ${f.files} file${f.files === 1 ? "" : "s"}`);
      }
    }
  }

  if (opts.dryRun) {
    lines.push("", "--dry-run: nothing was requested.");
    return { exitCode: 0, lines };
  }

  try {
    const path = backfillRequestPath();
    mkdirSync(dirname(path), { recursive: true });
    // Whole-file write of a small JSON object: the daemon deletes it before
    // acting, so a partially-written file can only ever be read once, and an
    // unparseable one is discarded rather than retried.
    writeFileSync(path, `${JSON.stringify({ sinceMs, requestedAtMs: now }, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    return {
      exitCode: 2,
      lines: [
        ...lines,
        "",
        `Could not write the request: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  lines.push("", "Requested. The daemon picks this up within a few seconds.");

  // A daemon that is not running will act on the request whenever it next
  // starts — the request is a file, deliberately, so it survives that. Saying so
  // is the difference between "nothing happened" and "nothing happened yet".
  if (isDaemonSupportedPlatform()) {
    const status = daemonServiceStatus();
    if (status !== "running") {
      lines.push(
        `failproofaid is ${status}, so nothing moves until it starts. The request is`,
        "on disk and will be honoured then.",
      );
    }
  }
  lines.push(
    "",
    `Watch it land:  ${totalFiles > 0 ? `~${totalFiles} files queued · ` : ""}` +
      "`failproofai config --status`",
  );
  return { exitCode: 0, lines };
}
