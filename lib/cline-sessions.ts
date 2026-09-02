/**
 * Cline session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Cline is the easiest transcript of any integration we
 * support, because it already speaks CLAUDE'S OWN content-block schema. Each
 * session is a directory under `~/.cline/data/sessions/<epochMs>_<suffix>/`
 * holding exactly two files:
 *
 *   <id>.json           session metadata: {session_id, source, pid, started_at,
 *                       ended_at, exit_code, status, interactive, provider,
 *                       model, cwd, workspace_root, prompt}
 *   <id>.messages.json  {version, updated_at, agent, sessionId, origin,
 *                       system_prompt, messages}
 *
 * and `messages[].content` is an array of the very blocks lib/log-entries.ts
 * already models: `{type:"thinking"}`, `{type:"text"}`,
 * `{type:"tool_use", id, name, input}`, `{type:"tool_result", tool_use_id,
 * name, content}`. So there is no dialect to translate — only tool_result
 * pairing, which `clineMessagesToLogEntries` does by `tool_use_id`.
 *
 * Two things that are NOT free, recorded so nobody assumes otherwise:
 *   • Cline stores NO per-message timestamp. Every entry in a session therefore
 *     carries the session's own time, so ordering within a session is array
 *     order and per-message timing is unrecoverable. (Same limitation as ori.)
 *   • Tool RESULTS arrive in `role:"user"` messages, Claude-style. A user
 *     message whose content is entirely tool_result blocks is NOT user prose
 *     and must not be emitted as one, or every tool call produces a phantom
 *     user turn in the audit.
 *
 * Home override: `CLINE_HOME` (the dir containing `data/sessions`, used by
 * tests); otherwise `$CLINE_DIR` — which cline itself honours — then `~/.cline`.
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

/** Absolute path to cline's home (override with CLINE_HOME, then CLINE_DIR). */
export function clineHome(): string {
  return process.env.CLINE_HOME || process.env.CLINE_DIR || join(homedir(), ".cline");
}

/** Absolute path to the directory holding one folder per session. */
export function clineSessionsDir(): string {
  return join(clineHome(), "data", "sessions");
}

/** Session directories are `<epochMs>_<suffix>`, e.g. `1788253271772_bn188`. */
export const CLINE_SESSION_DIR_RE = /^(\d{10,})_([A-Za-z0-9]+)$/;

export function clineTimestampToMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export interface ClineSessionMeta {
  session_id?: string;
  status?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  workspace_root?: string;
  prompt?: string;
  started_at?: string;
  ended_at?: string;
  source?: string;
  interactive?: boolean;
  exit_code?: number;
}

interface ClineBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface ClineMessage {
  role?: string;
  content?: string | ClineBlock[];
}

/** Flatten a tool_result's `content` into display text. Cline uses an array of
 *  `{query, result}`-ish objects or plain text blocks depending on the tool, so
 *  fall back to JSON rather than dropping the result entirely. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
        if (typeof o.result === "string") return o.result;
        return JSON.stringify(o);
      }
      return "";
    });
    return parts.filter((p) => p.length > 0).join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

/**
 * Parse cline's message array into the shared LogEntry[] shape.
 *
 * PURE — takes already-parsed JSON, so tests need no fixture directory.
 */
export function clineMessagesToLogEntries(
  messages: ClineMessage[],
  sessionId: string,
  timestampMs: number,
  source: LogSource = "session",
): LogEntry[] {
  const date = new Date(timestampMs);
  const timestamp = date.toISOString();
  const entries: LogEntry[] = [];
  // tool_use id → the block awaiting its result, so a later user-role
  // tool_result attaches onto the assistant turn that made the call.
  const pending = new Map<string, ToolUseBlock>();

  messages.forEach((msg, i) => {
    const role = msg.role;
    const raw = { uuid: `${sessionId}:${i}`, parentUuid: null } as Record<string, unknown>;
    const base = baseEntry(raw, timestamp, date, source);
    const blocks: ClineBlock[] = Array.isArray(msg.content) ? msg.content : [];

    if (role === "user") {
      // Attach any tool results this message carries…
      let attached = 0;
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        attached++;
        const target = pending.get(b.tool_use_id);
        if (!target) continue;
        // No per-message timestamp exists, so duration is unknowable — 0 rather
        // than a fabricated span.
        target.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: toolResultText(b.content),
          durationMs: 0,
          durationFormatted: formatDuration(0),
        };
        pending.delete(b.tool_use_id);
      }
      // …and only emit a user turn if there was real prose. A message that is
      // nothing but tool results is the tool-result carrier, not a user turn.
      const text =
        typeof msg.content === "string"
          ? msg.content
          : blocks
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join("");
      if (text.trim().length > 0) {
        entries.push({ ...base, type: "user", message: { role: "user", content: text } } as UserEntry);
      } else if (attached === 0 && typeof msg.content === "string") {
        entries.push({ ...base, type: "user", message: { role: "user", content: msg.content } } as UserEntry);
      }
      return;
    }

    if (role === "assistant") {
      const out: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type === "thinking" && typeof b.thinking === "string") {
          out.push({ type: "thinking", thinking: b.thinking });
        } else if (b.type === "text" && typeof b.text === "string") {
          out.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use" && typeof b.id === "string") {
          const block: ToolUseBlock = {
            type: "tool_use",
            id: b.id,
            name: b.name ?? "",
            input: b.input ?? {},
          };
          pending.set(b.id, block);
          out.push(block);
        }
      }
      if (out.length > 0) {
        entries.push({
          ...base,
          type: "assistant",
          message: { role: "assistant", content: out },
        } as AssistantEntry);
      }
    }
  });

  return entries;
}

export interface ClineSessionLog {
  entries: LogEntry[];
  cwd?: string;
  meta?: ClineSessionMeta;
}

/** Read a session's metadata sidecar. Returns undefined when absent/unreadable. */
export async function readClineSessionMeta(
  dir: string,
  sessionId: string,
): Promise<ClineSessionMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `${sessionId}.json`), "utf8")) as ClineSessionMeta;
  } catch {
    return undefined;
  }
}

/** Load and parse one cline session. Returns null when absent or unreadable. */
export async function getClineSessionLog(sessionId: string): Promise<ClineSessionLog | null> {
  const root = clineSessionsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  // The directory is `<epochMs>_<suffix>` and the files inside are named for
  // the FULL directory name, which is also the session id.
  const dirName = dirs.find((d) => d === sessionId);
  if (!dirName) return null;
  const dir = join(root, dirName);

  let parsed: { messages?: ClineMessage[]; updated_at?: string };
  try {
    parsed = JSON.parse(await readFile(join(dir, `${sessionId}.messages.json`), "utf8")) as {
      messages?: ClineMessage[];
      updated_at?: string;
    };
  } catch {
    return null;
  }
  const meta = await readClineSessionMeta(dir, sessionId);
  const ms =
    clineTimestampToMs(meta?.started_at) ||
    clineTimestampToMs(parsed.updated_at) ||
    Number(sessionId.split("_")[0]) ||
    0;

  return {
    entries: clineMessagesToLogEntries(parsed.messages ?? [], sessionId, ms),
    cwd: meta?.cwd ?? meta?.workspace_root,
    meta,
  };
}

export const getCachedClineSessionLog = runtimeCache(getClineSessionLog, 2);
