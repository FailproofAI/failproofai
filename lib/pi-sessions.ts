/**
 * Pi (pi-coding-agent) session transcript discovery + JSONL parser.
 *
 * Empirically verified against pi-coding-agent v0.72.1 (Phase 0.7 of plan):
 *
 * Session files live at
 *   `~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<UUID>.jsonl`
 * where `<encoded-cwd>` wraps `--`-prefixed-and-suffixed `/`-separated paths
 * (e.g. `/home/user/repo` → `--home-user-repo--`). The encoding is lossy
 * (literal `-` is preserved); we use the `cwd` field of the first JSONL
 * record (`{type: "session", cwd, …}`) as the canonical cwd.
 *
 * Record schema (observed):
 *   {type: "session",                version, id, timestamp, cwd}
 *   {type: "model_change",           id, parentId, timestamp, provider, modelId}
 *   {type: "thinking_level_change",  id, parentId, timestamp, thinkingLevel}
 *   {type: "message",                id, parentId, timestamp,
 *                                    message: {role, content[], timestamp}}
 *
 * `message.content[]` items can be `{type: "text", text}`,
 * `{type: "thinking", thinking, thinkingSignature}` or `{type: "toolCall",
 * id, name, arguments}`.
 *
 * Tool calls WERE previously believed not to exist here — the header used to
 * say no tool-using run had been captured, so `toolCall` blocks fell through
 * to the generic "system" branch and every tool event Pi emits was silently
 * dropped from the audit path. A live capture (pi 0.73.1 and 0.83.0, driven
 * against a real provider) shows Pi emits them in full:
 *
 *   assistant turn  content[] contains {type:"toolCall", id, name, arguments}
 *                   and the message carries stopReason:"toolUse"
 *   tool result     its own record with a THIRD role —
 *                   message.role === "toolResult", carrying toolCallId,
 *                   toolName, content[], isError, timestamp (epoch ms)
 *
 * `toolResult.toolCallId` pairs exactly with `toolCall.id`, one result record
 * per call, emitted in call order — so results attach by id, never by
 * position. Pi supplies no duration, so it is derived from the gap between
 * the call and its result, the same way the OpenClaw parser does it.
 *
 * The format is identical across the 0.73.1 (`@mariozechner/pi-coding-agent`)
 * and 0.83.0 (`@earendil-works/pi-coding-agent`) packages — same `version: 3`
 * header, same record types — so one parser covers both. One difference worth
 * guarding: 0.83.0 emits leading prose alongside the calls
 * (`["text","toolCall","toolCall"]`) where 0.73.1 emitted only the calls, so
 * assistant content must not be assumed homogeneous.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type GenericEntry,
  type QueueOperationEntry,
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

// ── Paths ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_RE = /^[\d-]+T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Root directory for Pi session state, honoring PI_SESSIONS_DIR. */
export function getPiSessionStateRoot(): string {
  return process.env.PI_SESSIONS_DIR
    || join(homedir(), ".pi", "agent", "sessions");
}

/** Reject a sessionId that isn't a UUID — defends against path traversal. */
function isSafeSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

/** Find the JSONL transcript for `sessionId` by walking each per-cwd subdir
 *  of the session-state root. Rejects path-traversal sessionIds and verifies
 *  the resolved path stays under the root. Returns null on miss. */
export function findPiTranscript(sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const root = resolve(getPiSessionStateRoot());

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(root);
  } catch {
    return null;
  }

  for (const cwdDir of cwdDirs) {
    const cwdPath = resolve(root, cwdDir);
    if (!cwdPath.startsWith(`${root}${sep}`)) continue;
    let files: string[];
    try {
      files = readdirSync(cwdPath);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = SESSION_FILE_RE.exec(f);
      if (!m || m[1].toLowerCase() !== sessionId.toLowerCase()) continue;
      const candidate = resolve(cwdPath, f);
      if (!candidate.startsWith(`${cwdPath}${sep}`)) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── Parser ──

interface PiSessionRecord {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  version?: number;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    timestamp?: number;
    /** Present on `role: "toolResult"` records — pairs with a `toolCall.id`. */
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

interface PiParseResult {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  /** Working directory pulled from the first session record, when available. */
  cwd?: string;
}

/** Extract a plain-text summary of a Pi message content block. Concatenates
 *  every `"text"` block (joined by blank lines) so multi-part user messages
 *  aren't truncated to just the first text segment. */
function extractMessageText(content: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

/** Build a list of ContentBlocks for the assistant entry, preserving text,
 *  thinking and tool-call blocks. Skips blocks with non-string payloads
 *  (typeof guards).
 *
 *  Every `tool_use` block built here is also handed to `onToolUse` so the
 *  caller can index it by id and attach the matching `toolResult` record when
 *  it arrives on a later line. The block is passed by reference and mutated
 *  in place, exactly as the OpenClaw parser does — the entry has already been
 *  pushed by then, so there is nothing else to attach it to. */
function buildAssistantContent(
  content: Array<Record<string, unknown>> | undefined,
  onToolUse?: (block: ToolUseBlock) => void,
): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      blocks.push({ type: "text", text: block.text });
    }
    // Pi's "thinking" blocks aren't a first-class entry type in our LogEntry
    // hierarchy; embed as a text block prefixed for clarity.
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      blocks.push({ type: "text", text: `[thinking] ${block.thinking}` });
    }
    if (block?.type === "toolCall") {
      // Fall back to a positional id only when Pi omits one. A synthetic id
      // still renders, but it can never pair with a result — so it must not
      // collide with a real one, hence the index suffix.
      const id = typeof block.id === "string" && block.id.length > 0
        ? block.id
        : `${typeof block.name === "string" ? block.name : "tool"}-${blocks.length}`;
      const name = typeof block.name === "string" ? block.name : "tool";
      const input =
        block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
          ? (block.arguments as Record<string, unknown>)
          : {};
      const toolUse: ToolUseBlock = { type: "tool_use", id, name, input };
      blocks.push(toolUse);
      onToolUse?.(toolUse);
    }
  }
  return blocks;
}

/**
 * Parse a Pi JSONL transcript into `LogEntry[]` plus the raw lines.
 * Yields to the event loop every 200 lines so big transcripts don't block
 * the request.
 */
export async function parsePiLog(
  fileContent: string,
  source: LogSource = "session",
): Promise<PiParseResult> {
  const lines = fileContent.split("\n").filter((line) => line.trim() !== "");
  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  let cwd: string | undefined;
  let seenSessionStart = false;
  // In-flight tool calls, so a later `toolResult` record can attach its output
  // to the block it belongs to. Keyed by the provider's own call id, never by
  // position — Pi emits results in call order today, but pairing by order
  // would break silently the first time it does not.
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 200 === 0) await new Promise<void>((r) => setImmediate(r));

    const line = lines[i];
    let raw: PiSessionRecord;
    try {
      raw = JSON.parse(line) as PiSessionRecord;
    } catch {
      continue;
    }

    const rawCopy = { ...(raw as Record<string, unknown>), _source: source };
    rawLines.push(rawCopy);

    const timestampStr = raw.timestamp;
    if (!timestampStr) continue;
    const date = new Date(timestampStr);
    if (Number.isNaN(date.getTime())) continue;
    const timestamp = date.toISOString();

    const recType = raw.type;

    // Pi's first record per session is `{type: "session", cwd, ...}`.
    if (recType === "session") {
      if (typeof raw.cwd === "string" && !cwd) cwd = raw.cwd;
      const label: QueueOperationEntry["label"] = seenSessionStart ? "Session Resumed" : "Session Started";
      seenSessionStart = true;
      entries.push({
        type: "queue-operation",
        ...baseEntry(rawCopy, timestamp, date, source),
        label,
      } satisfies QueueOperationEntry);
      continue;
    }

    // Pi messages are `{type: "message", message: {role, content[]}}`. Branch
    // on role; render text/thinking content. Validate types defensively.
    if (recType === "message" && raw.message && typeof raw.message === "object") {
      const role = raw.message.role;
      const content = raw.message.content;

      if (role === "user") {
        const text = extractMessageText(content);
        if (!text) continue;
        entries.push({
          type: "user",
          ...baseEntry(rawCopy, timestamp, date, source),
          message: { role: "user", content: text },
        } satisfies UserEntry);
        continue;
      }

      if (role === "assistant") {
        const blocks = buildAssistantContent(content, (block) => {
          toolUseById.set(block.id, block);
          toolUseStartMs.set(block.id, date.getTime());
        });
        if (blocks.length === 0) {
          entries.push({
            type: "system",
            ...baseEntry(rawCopy, timestamp, date, source),
            raw: rawCopy,
          } satisfies GenericEntry);
          continue;
        }
        entries.push({
          type: "assistant",
          ...baseEntry(rawCopy, timestamp, date, source),
          message: { role: "assistant", content: blocks },
        } satisfies AssistantEntry);
        continue;
      }

      // Pi's third role: a tool result, on its own record, pairing back to an
      // assistant turn's toolCall by id. Attaching it to that block is what
      // makes the tool's OUTPUT visible — without this the call renders with
      // no result and the audit path sees no `toolResultText` at all.
      if (role === "toolResult") {
        const callId = raw.message.toolCallId;
        const block = typeof callId === "string" ? toolUseById.get(callId) : undefined;
        if (block) {
          // Pi records no duration on the result, so derive it from the gap
          // between the call and its result. `startMs` is always present for
          // a block we indexed; the fallback keeps the arithmetic total.
          const startMs = (typeof callId === "string" && toolUseStartMs.get(callId)) || date.getTime();
          const durationMs = Math.max(0, date.getTime() - startMs);
          block.result = {
            timestamp,
            timestampFormatted: formatTimestamp(date),
            content: extractMessageText(content),
            durationMs,
            durationFormatted: formatDuration(durationMs),
          };
          continue;
        }
        // Orphan result — the call was never seen (truncated file, or a
        // resumed session whose earlier half is in another file). Fall
        // through so the record is preserved rather than dropped.
      }

      // Unknown role — preserve raw so nothing is dropped.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    // model_change / thinking_level_change / unknown — preserve raw as system
    // so the dashboard can surface them without ad-hoc renderers.
    entries.push({
      type: "system",
      ...baseEntry(rawCopy, timestamp, date, source),
      raw: rawCopy,
    } satisfies GenericEntry);
  }

  if (entries.length > 500) await new Promise<void>((r) => setImmediate(r));
  entries.sort((a, b) => a.timestampMs - b.timestampMs);

  return { entries, rawLines, cwd };
}

// ── Public loader ──

export interface PiSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

export async function getPiSessionLog(sessionId: string): Promise<PiSessionLogData | null> {
  const filePath = findPiTranscript(sessionId);
  if (!filePath) return null;
  let fileContent: string;
  try {
    fileContent = await readFile(filePath, "utf-8");
  } catch {
    // The file vanished between findPiTranscript and read — fall open.
    return null;
  }
  let parsed: PiParseResult;
  try {
    parsed = await parsePiLog(fileContent, "session");
  } catch {
    return null;
  }
  return {
    entries: parsed.entries,
    rawLines: parsed.rawLines,
    cwd: parsed.cwd,
    filePath,
  };
}

export const getCachedPiSessionLog = runtimeCache(
  (sessionId: string) => getPiSessionLog(sessionId),
  60,
  { maxSize: 50 },
);

// ── Test helpers ──

/** For tests: read raw stat of the transcript path, returning null on miss. */
export function _statPiTranscript(sessionId: string): { mtimeMs: number } | null {
  const path = findPiTranscript(sessionId);
  if (!path) return null;
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** For tests: read transcript synchronously. Returns null on missing/error. */
export function readPiTranscriptSync(sessionId: string): string | null {
  const path = findPiTranscript(sessionId);
  if (!path) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
