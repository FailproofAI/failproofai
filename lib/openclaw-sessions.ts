/**
 * OpenClaw (openclaw gateway) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). OpenClaw writes one JSONL transcript per session at
 * `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` (sessionId is a
 * UUID), alongside a much larger `<sessionId>.trajectory.jsonl` OTel trace we
 * IGNORE, and a `sessions.json` index keyed by sessionKey. Verified live
 * against openclaw v2026.7.1.
 *
 * The transcript is type-discriminated JSONL:
 *   {type:"session", cwd, …}              — header (carries cwd)
 *   {type:"model_change" | "thinking_level_change" | "custom", …} — metadata
 *   {type:"message", timestamp, message:{role, content, …}} — the turns, where
 *     role ∈ "user" (content string) | "assistant" (content = list of
 *     {type:"text",text} / {type:"toolCall", id, name, arguments}) |
 *     "toolResult" ({toolCallId, toolName, content, details, isError}).
 * `openclawLinesToLogEntries` pairs each assistant `toolCall` with its later
 * `toolResult` by `toolCallId` (mirrors lib/hermes-sessions.ts) and is PURE, so
 * it is unit-testable with plain line objects.
 *
 * Home override: set `OPENCLAW_HOME` (used by tests / to point at a copied
 * gateway config dir).
 */
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  parseRawLines,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type GenericEntry,
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

/** OpenClaw sessions are stored under UUID filenames. */
export const OPENCLAW_SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

/** Absolute path to OpenClaw's config home (override with OPENCLAW_HOME). */
export function openclawHome(): string {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

// ── Parsing helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Text from a `content` field that may be a string or an array of
 *  `{ type:"text", text }` blocks. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isPlainObject(c) && typeof c.text === "string" ? (c.text as string) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toDate(value: unknown, fallbackMs: number): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return new Date(value);
    if (value > 1e9) return new Date(value * 1000);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date(fallbackMs);
}

// ── Pure parser: transcript lines → LogEntry[] ──

/**
 * Convert OpenClaw transcript JSONL lines (parsed objects, in file order) into
 * `LogEntry[]`. Only `type:"message"` lines carry turns; `session` /
 * `model_change` / `thinking_level_change` / `custom` lines are metadata and
 * are skipped (they'd otherwise clutter the audit with empty system entries).
 * Assistant `toolCall` blocks are paired with their later `toolResult` message
 * by `toolCallId`. Pure — unit-testable with plain line objects.
 */
export function openclawLinesToLogEntries(
  lines: Record<string, unknown>[],
  source: LogSource = "session",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();
  const baseMs = Date.now();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPlainObject(line)) continue;
    if (line.type !== "message") continue; // skip session/model_change/custom/…

    const m = isPlainObject(line.message) ? line.message : undefined;
    if (!m) continue;
    const role = typeof m.role === "string" ? m.role : "system";

    // Outer line `timestamp` is an ISO string; message.timestamp is epoch ms.
    const date = toDate(line.timestamp ?? m.timestamp, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: line.id != null ? String(line.id) : `openclaw-${i}`,
      parentUuid: line.parentId != null ? String(line.parentId) : null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    if (role === "user") {
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: extractText(m.content) },
      } satisfies UserEntry);
      continue;
    }

    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      const content = m.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isPlainObject(b)) continue;
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "toolCall") {
            const id = typeof b.id === "string" ? b.id : `${String(b.name ?? "tool")}-${blocks.length}`;
            const name = typeof b.name === "string" ? b.name : "tool";
            const input = isPlainObject(b.arguments) ? b.arguments : {};
            const block: ToolUseBlock = { type: "tool_use", id, name, input };
            blocks.push(block);
            toolUseById.set(id, block);
            toolUseStartMs.set(id, date.getTime());
          }
        }
      } else {
        const text = extractText(content);
        if (text) blocks.push({ type: "text", text });
      }
      if (blocks.length === 0) continue; // empty / failed assistant turn
      entries.push({
        type: "assistant",
        ...base,
        message: { role: "assistant", content: blocks, model: typeof m.model === "string" ? m.model : undefined },
      } satisfies AssistantEntry);
      continue;
    }

    if (role === "toolResult") {
      const callId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (block) {
        const details = isPlainObject(m.details) ? m.details : undefined;
        const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
        const durationMs =
          details && typeof details.durationMs === "number"
            ? details.durationMs
            : Math.max(0, date.getTime() - startMs);
        block.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: extractText(m.content),
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
        continue;
      }
      // Orphan tool result — fall through to a system entry.
    }

    entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── Discovery + file loader ──

export interface OpenClawTranscriptFile {
  agentId: string;
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Enumerate `agents/<agentId>/sessions/<uuid>.jsonl` transcripts, skipping the
 *  heavy `.trajectory.jsonl` OTel traces and pointer files. */
export function listOpenClawTranscripts(): OpenClawTranscriptFile[] {
  const agentsDir = join(openclawHome(), "agents");
  const out: OpenClawTranscriptFile[] = [];
  let agentIds: string[];
  try {
    agentIds = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const agentId of agentIds) {
    const sessionsDir = join(agentsDir, agentId, "sessions");
    let files: string[];
    try {
      files = readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      // Only `<uuid>.jsonl` — not `<uuid>.trajectory.jsonl` / `.trajectory-path.json`.
      if (!file.endsWith(".jsonl") || file.endsWith(".trajectory.jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!OPENCLAW_SESSION_ID_RE.test(sessionId)) continue;
      const transcriptPath = join(sessionsDir, file);
      try {
        const st = statSync(transcriptPath);
        out.push({ agentId, sessionId, transcriptPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

/** Resolve a session UUID to its on-disk transcript path (host-side). Guards
 *  against traversal by requiring a UUID filename. Shared by the audit adapter
 *  and download-session. */
export function findOpenClawTranscript(sessionId: string): string | null {
  if (!OPENCLAW_SESSION_ID_RE.test(sessionId)) return null;
  for (const t of listOpenClawTranscripts()) {
    if (t.sessionId === sessionId) return t.transcriptPath;
  }
  return null;
}

export interface OpenClawSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

/** Load and parse one session transcript by UUID. Returns `null` when the file
 *  is missing/unreadable or the id fails validation. */
export async function getOpenClawSessionLog(
  sessionId: string,
): Promise<OpenClawSessionLogData | null> {
  const filePath = findOpenClawTranscript(sessionId);
  if (!filePath) return null;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const rawLines = parseRawLines(content, "session");
  const entries = openclawLinesToLogEntries(rawLines, "session");
  // cwd lives on the `type:"session"` header line.
  let cwd: string | undefined;
  for (const line of rawLines) {
    if (isPlainObject(line) && line.type === "session" && typeof line.cwd === "string" && line.cwd.length > 0) {
      cwd = line.cwd;
      break;
    }
  }
  return { entries, rawLines, cwd, filePath };
}

export const getCachedOpenClawSessionLog = runtimeCache(
  (sessionId: string) => getOpenClawSessionLog(sessionId),
  2,
  { maxSize: 50 },
);
