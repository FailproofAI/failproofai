/**
 * Self Reports events for the daemon's log, from processes outside it: the
 * stdio MCP server (`failproofai mcp`, a child of each agent) and the CLI's
 * `self-report sync`.
 *
 * The daemon's log is what machine logs ship (crates/failproofaid/src/logship.rs),
 * so an event belongs there and nowhere else. It goes over the daemon's own
 * socket as one `selfReportLog` frame (crates/PROTOCOL.md): one-way, no reply
 * read. An older daemon cannot parse the type and closes the connection, so
 * it is dropped. No daemon, a slow one, or any error: dropped too, inside
 * `SELF_REPORT_LOG_BUDGET_MS`. Nothing here ever throws or holds up an agent.
 *
 * Only a short start of a report's detail is sent; the daemon scrubs secrets
 * from it and cuts it again before logging.
 *
 * Top-level names are prefixed for the same bundle reason as self-report.ts.
 */
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { daemonSocket } from "./fp-home";

/** The whole budget for one event, connect to close. */
export const SELF_REPORT_LOG_BUDGET_MS = 250;
/** How much detail is sent; the daemon logs at most its first 40 characters. */
export const SELF_REPORT_LOG_PREVIEW_CHARS = 200;
const SELF_REPORT_LOG_PROTOCOL_VERSION = 2;

export interface SelfReportLogEvent {
  event: "initialize" | "tools/list" | "tools/call" | "sync" | "error";
  agent?: string;
  transport?: "stdio" | "cli";
  outcome?: string;
  reason?: string;
  category?: string;
  knownCategory?: boolean;
  session?: string;
  /** The report's detail; cut to `SELF_REPORT_LOG_PREVIEW_CHARS` here. */
  preview?: string;
  summary?: string;
}

const selfReportLogPending = new Set<Promise<void>>();

function selfReportLogSocket(): string {
  return process.env.FAILPROOFAI_DAEMON_SOCKET || daemonSocket();
}

/**
 * Send one event, without waiting for it. Returns the send, which always
 * resolves (in at most the budget); callers that are about to exit may await
 * `flushSelfReportLogs` instead.
 */
export function sendSelfReportLog(event: SelfReportLogEvent): Promise<void> {
  const sent = selfReportLogSend(event);
  selfReportLogPending.add(sent);
  void sent.then(() => selfReportLogPending.delete(sent));
  return sent;
}

/** Wait for every event still in flight, at most `maxMs`. */
export async function flushSelfReportLogs(maxMs: number = SELF_REPORT_LOG_BUDGET_MS): Promise<void> {
  if (selfReportLogPending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...selfReportLogPending]),
    new Promise<void>((done) => {
      timer = setTimeout(done, maxMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function selfReportLogSend(event: SelfReportLogEvent): Promise<void> {
  return new Promise<void>((resolve) => {
    let path: string;
    let frame: Buffer;
    try {
      if (process.platform === "win32") return resolve();
      path = selfReportLogSocket();
      if (!existsSync(path)) return resolve();
      const body = Buffer.from(
        JSON.stringify({
          type: "selfReportLog",
          protocolVersion: SELF_REPORT_LOG_PROTOCOL_VERSION,
          event: {
            ...event,
            ...(event.preview !== undefined ? { preview: [...event.preview].slice(0, SELF_REPORT_LOG_PREVIEW_CHARS).join("") } : {}),
          },
        }),
        "utf8",
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      frame = Buffer.concat([header, body]);
    } catch {
      return resolve();
    }
    let settled = false;
    const socket = createConnection({ path });
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, SELF_REPORT_LOG_BUDGET_MS);
    timer.unref?.();
    socket.unref();
    socket.on("error", done);
    socket.on("close", done);
    socket.on("connect", () => {
      socket.end(frame, done);
    });
  });
}
