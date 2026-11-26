/**
 * `failproofai mcp [--agent <integration>]`: the Self Reports MCP server over
 * stdio (newline-delimited JSON-RPC 2.0).
 *
 * The same server the daemon serves over HTTP, for agents that only speak stdio
 * MCP and for environments with no reachable daemon (containers, CI). It needs
 * no daemon: it reads `self-report.json` on every request and writes its
 * fallback records straight into the custom-agents spool.
 *
 * Methods: `initialize` (with `instructions` while the feature is on), `ping`, `tools/list` (the report tool, or nothing
 * while the feature is off), `tools/call` (always answers `Recorded.`).
 *
 * Recording (contract §8): an agent whose hooks see MCP calls (Claude Code,
 * Codex, Cursor) is recorded by its PreToolUse hook, so this server writes
 * nothing for it. For an agent in `SELF_REPORT_SERVER_RECORDS` the server
 * appends one `self_report` event itself, attributed to the newest session of
 * that agent seen by the hooks in the last 6 hours: in this working directory,
 * else in one above or below it, else anywhere (`selfReportFindSessionMatch`).
 *
 * Nothing but JSON-RPC goes to stdout: a stray byte there corrupts the agent's
 * MCP stream. Diagnostics go to stderr.
 *
 * Top-level names are prefixed for the same bundle reason as self-report.ts.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { version as selfReportCliVersion } from "../../package.json";
import { customAgentsEventsDir, hookActivityDir } from "./fp-home";
import {
  SELF_REPORT_RESULT_TEXT,
  SELF_REPORT_SERVER_NAME,
  SELF_REPORT_SERVER_RECORDS,
  SELF_REPORT_TOOL_NAME,
  describeSelfReportTool,
  readEnabledSelfReport,
  selfReportArgs,
  selfReportInputSchema,
  selfReportInstructions,
} from "./self-report";

/** How far back a hook-activity session may be and still own a report. */
export const SELF_REPORT_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;
const SELF_REPORT_DEFAULT_PROTOCOL = "2025-06-18";

let selfReportBatchSeq = 0;

export interface SelfReportMcpOptions {
  /** The integration this server was registered for (`--agent`). */
  agent?: string;
  /** Working directory used for session attribution; defaults to process.cwd(). */
  cwd?: string;
  input?: Readable;
  output?: Writable;
  /** Clock override for tests. */
  now?: () => number;
}

/** The tool list the server advertises right now. */
export function selfReportToolList(): Array<Record<string, unknown>> {
  const settings = readEnabledSelfReport();
  if (!settings) return [];
  return [
    {
      name: SELF_REPORT_TOOL_NAME,
      description: describeSelfReportTool(settings.categories, settings.guidance),
      inputSchema: selfReportInputSchema(settings.categories),
    },
  ];
}

/**
 * The initialize result's `instructions`, or undefined while the feature is
 * off (the field is then left out). Read at initialize time: a client reads it
 * once per connection.
 */
export function selfReportServerInstructions(): string | undefined {
  const settings = readEnabledSelfReport();
  if (!settings) return undefined;
  return selfReportInstructions(settings.categories, settings.guidance);
}

// ── Session attribution ─────────────────────────────────────────────────────

/**
 * How closely a hook row's cwd matches the server's: 2 the same directory, 1 an
 * ancestor or descendant of it, 0 unrelated (or unknown). Trailing slashes are
 * ignored; `/` is an ancestor of every absolute path.
 */
export function selfReportCwdAffinity(want: string, have: unknown): 0 | 1 | 2 {
  if (typeof have !== "string" || have === "") return 0;
  const a = want.replace(/\/+$/, "");
  const b = have.replace(/\/+$/, "");
  if (a === b) return 2;
  if (a === "" || b === "") return 1;
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`) ? 1 : 0;
}

/** A hook session that owns a report, and the cwd its row had. */
export interface SelfReportSessionMatch {
  sessionId: string;
  cwd: string | undefined;
}

/**
 * The hook-activity session a report from `integration` belongs to, seen by
 * the hooks within the window (6 h), or null. Most specific first: the newest
 * session whose row has exactly this `cwd`; else the newest whose cwd is an
 * ancestor or descendant of it; else the newest session of that integration
 * anywhere. The stdio server's cwd is wherever the agent started it, which is
 * often not the project (Hermes runs it from its own directory), so an exact
 * match alone left those reports unattributed. The daemon's HTTP fallback
 * (crates/fpai-collect/src/self_report.rs `find_session`) does the same.
 *
 * Reads `current.jsonl` and, because it holds at most one page (25 rows) and
 * may have just rotated, the newest archived page too.
 */
export function selfReportFindSessionMatch(
  integration: string,
  cwd: string | undefined,
  now: number = Date.now(),
): SelfReportSessionMatch | null {
  const dir = hookActivityDir();
  const files: string[] = [join(dir, "current.jsonl")];
  try {
    const pages = readdirSync(dir)
      .filter((f) => f.startsWith("page-") && f.endsWith(".jsonl"))
      .map((f) => ({ f, m: selfReportMtime(join(dir, f)) }))
      .sort((a, b) => b.m - a.m);
    if (pages[0]) files.push(join(dir, pages[0].f));
  } catch {
    // No activity directory: nothing to attribute to.
  }
  let best: { rank: number; ts: number; id: string; cwd: string | undefined } | null = null;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = typeof row.timestamp === "number" ? row.timestamp : NaN;
      if (
        row.integration !== integration ||
        typeof row.sessionId !== "string" ||
        !row.sessionId ||
        !Number.isFinite(ts) ||
        now - ts > SELF_REPORT_SESSION_WINDOW_MS ||
        ts - now > 60_000
      ) {
        continue;
      }
      const rank = cwd ? selfReportCwdAffinity(cwd, row.cwd) : 0;
      if (!best || rank > best.rank || (rank === best.rank && ts > best.ts)) {
        best = { rank, ts, id: row.sessionId, cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : undefined };
      }
    }
  }
  return best ? { sessionId: best.id, cwd: best.cwd } : null;
}

/** The session id of `selfReportFindSessionMatch`, or null. */
export function selfReportFindSession(integration: string, cwd: string, now: number = Date.now()): string | null {
  return selfReportFindSessionMatch(integration, cwd, now)?.sessionId ?? null;
}

function selfReportMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The agent id the collector files a hook event under (`agent_id` in
 * crates/fpai-collect/src/sources/hooks/transform.rs): `<integration>-<last cwd
 * component>`, each part reduced to `[A-Za-z0-9._-]`, dashes collapsed, 48
 * characters. A report must land under the same agent as the session's hooks.
 */
export function selfReportAgentId(integration: string, cwd: string | undefined): string {
  const clean = (s: string): string =>
    [...s]
      .map((c) => (/[A-Za-z0-9._]/.test(c) ? c : "-"))
      .join("")
      .split("-")
      .filter((p) => p !== "")
      .join("-")
      .slice(0, 48);
  const base = clean(integration || "failproofai");
  const last = cwd?.replace(/\/+$/, "").split("/").filter((p) => p !== "").pop();
  const project = last ? clean(last) : "";
  return project ? `${base}-${project}` : base;
}

/** `environment` as the collector stamps it: config.json's collector.environment, else "local". */
async function selfReportEnvironment(): Promise<string> {
  try {
    const { readConfig } = await import("./fp-config");
    return readConfig().collector.environment || "local";
  } catch {
    return "local";
  }
}

// ── The event file (SDK writer format) ──────────────────────────────────────

export interface SelfReportEventInput {
  integration: string;
  category: string;
  detail: string;
  cwd: string;
  now?: number;
  /** Overrides session attribution (the `self-report test` command). */
  sessionId?: string;
}

/**
 * Write one `self_report` event as its own batch in the custom-agents spool,
 * exactly as the SDK writers publish (`event-<iso>-<pid>-<seq>.jsonl`, written
 * as `.tmp` with O_EXCL and 0600, fsynced, renamed; directory 0700). Returns
 * the published path and the event.
 */
export async function writeSelfReportEvent(input: SelfReportEventInput): Promise<{ path: string; event: Record<string, unknown> }> {
  const now = input.now ?? Date.now();
  const match = input.sessionId === undefined ? selfReportFindSessionMatch(input.integration, input.cwd, now) : null;
  const sessionId = input.sessionId ?? match?.sessionId ?? "unattributed";
  const event: Record<string, unknown> = {
    timestamp: new Date(now).toISOString(),
    session_id: sessionId,
    // The agent the session's hook rows are filed under: from the matched
    // row's cwd, not the server's own (they differ when the agent starts the
    // server elsewhere).
    agent_id: selfReportAgentId(input.integration, match?.cwd ?? input.cwd),
    type: "self_report",
    category: input.category,
    detail: input.detail,
    source: "mcp",
    // Wire order as the SDK writers build it: environment after the event's own fields.
    environment: await selfReportEnvironment(),
    integration: input.integration,
  };
  const dir = customAgentsEventsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const stem = `event-${stamp}-${process.pid}-${selfReportBatchSeq++}`;
  const tmp = join(dir, `${stem}.tmp`);
  const finalPath = join(dir, `${stem}.jsonl`);
  try {
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, finalPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { path: finalPath, event };
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

type SelfReportRpcResponse = Record<string, unknown> | null;

/**
 * Answer one JSON-RPC message. Returns null for a notification (no reply).
 * Exported so tests (and the daemon parity check) can drive it without a pipe.
 */
export async function handleSelfReportRpc(
  message: unknown,
  opts: { agent?: string; cwd?: string; now?: () => number } = {},
): Promise<SelfReportRpcResponse> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const req = message as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = req.id !== undefined && req.id !== null;
  const id = hasId ? req.id : null;
  const method = typeof req.method === "string" ? req.method : "";
  const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });

  if (!hasId) return null; // notifications/initialized and friends

  switch (method) {
    case "initialize": {
      const instructions = selfReportServerInstructions();
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : SELF_REPORT_DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SELF_REPORT_SERVER_NAME, version: selfReportCliVersion },
        ...(instructions ? { instructions } : {}),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: selfReportToolList() });
    case "tools/call": {
      if (params.name !== SELF_REPORT_TOOL_NAME) {
        return ok({ content: [{ type: "text", text: `Unknown tool: ${String(params.name)}` }], isError: true });
      }
      const agent = opts.agent;
      if (agent && SELF_REPORT_SERVER_RECORDS.includes(agent) && readEnabledSelfReport()) {
        const { category, detail } = selfReportArgs(params.arguments ?? {});
        try {
          await writeSelfReportEvent({
            integration: agent,
            category,
            detail,
            cwd: opts.cwd ?? process.cwd(),
            now: opts.now?.(),
          });
        } catch (err) {
          // The agent still hears "Recorded.": a report changes no decision,
          // and an error here would only make it retry.
          process.stderr.write(
            `[failproofai mcp] could not record a self report: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return ok({ content: [{ type: "text", text: SELF_REPORT_RESULT_TEXT }] });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/**
 * Run the server until stdin closes. Requests are answered in arrival order.
 * Resolves when the input ends and every reply has been written.
 */
export function runSelfReportMcpServer(opts: SelfReportMcpOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const handlerOpts = { agent: opts.agent, cwd: opts.cwd, now: opts.now };
  let chain: Promise<void> = Promise.resolve();
  const send = (msg: unknown) => {
    output.write(`${JSON.stringify(msg)}\n`);
  };
  return new Promise((resolveRun) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      chain = chain.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        try {
          if (Array.isArray(parsed)) {
            const replies = (await Promise.all(parsed.map((m) => handleSelfReportRpc(m, handlerOpts)))).filter(
              (r) => r !== null,
            );
            if (replies.length > 0) send(replies);
          } else {
            const reply = await handleSelfReportRpc(parsed, handlerOpts);
            if (reply) send(reply);
          }
        } catch (err) {
          process.stderr.write(`[failproofai mcp] ${err instanceof Error ? err.message : String(err)}\n`);
        }
      });
    });
    rl.on("close", () => {
      void chain.then(() => resolveRun());
    });
  });
}
