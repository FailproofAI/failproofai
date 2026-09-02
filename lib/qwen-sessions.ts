/**
 * Qwen Code session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). qwen writes one JSONL transcript per session at
 * `~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl` — Claude-style
 * encoded-cwd folders (e.g. `-home-chetan-project`), but note the extra
 * `chats/` level, which Claude/Factory do not have. Verified live against
 * @qwen-code/qwen-code 0.21.12.
 *
 * Every line carries `{uuid, parentUuid, sessionId, cwd, timestamp, version,
 * type}`. `type` is one of:
 *   "user"        — message.parts, role "user"
 *   "assistant"   — message.parts, role "model"  (Gemini's name for assistant)
 *   "tool_result" — message.parts + a `toolCallResult` sidecar
 *   "system"      — bookkeeping (subtype/systemPayload); skipped
 *
 * The message body is **Gemini-shaped, not Claude-shaped**: `message.parts[]`
 * holds `{text}`, `{functionCall:{id,name,args}}`, and
 * `{functionResponse:{id,name,response}}` — so this is NOT a clone of
 * lib/factory-sessions.ts despite the similar on-disk layout. `functionCall` is
 * paired with its later `functionResponse` by id (mirroring the tool_use /
 * tool_result pairing elsewhere). `qwenLinesToLogEntries` is PURE, so it is
 * unit-testable with plain line objects.
 *
 * Home override: set `QWEN_HOME` (used by tests / to point at a copied
 * projects dir).
 */
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeFolderName } from "./paths";
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

/** Qwen sessions are stored under UUID filenames. */
export const QWEN_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Absolute path to Qwen's config home (override with QWEN_HOME). */
export function qwenHome(): string {
  return process.env.QWEN_HOME || join(homedir(), ".qwen");
}

/** Absolute path to the Qwen projects root. */
export function qwenProjectsRoot(): string {
  return join(qwenHome(), "projects");
}

// ── Parsing helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Flatten a Gemini `response` payload (or any tool output) to display text. */
function extractResponseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!isPlainObject(response)) return "";
  for (const key of ["output", "result", "content", "error"]) {
    const v = response[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return JSON.stringify(response);
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
 * Convert Qwen transcript JSONL lines (parsed objects, in file order) into
 * `LogEntry[]`. `system` lines are skipped. Assistant `functionCall` parts are
 * paired with their later `functionResponse` by call id. Pure — unit-testable
 * with plain line objects.
 */
export function qwenLinesToLogEntries(
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
    const type = typeof line.type === "string" ? line.type : "";
    if (type === "system") continue; // subtype/systemPayload bookkeeping

    const m = isPlainObject(line.message) ? line.message : undefined;
    if (!m) continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];

    const date = toDate(line.timestamp, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: line.uuid != null ? String(line.uuid) : `qwen-${i}`,
      parentUuid: line.parentUuid != null ? String(line.parentUuid) : null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    // Assistant turn: text parts and/or functionCall parts. Qwen names the
    // assistant role "model" (Gemini lineage); accept both spellings.
    if (type === "assistant" || m.role === "model" || m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      for (const p of parts) {
        if (!isPlainObject(p)) continue;
        if (typeof p.text === "string" && p.text.length > 0) {
          blocks.push({ type: "text", text: p.text });
          continue;
        }
        const fc = isPlainObject(p.functionCall) ? p.functionCall : undefined;
        if (fc) {
          const id = typeof fc.id === "string" ? fc.id : `${String(fc.name ?? "tool")}-${blocks.length}`;
          const name = typeof fc.name === "string" ? fc.name : "tool";
          const input = isPlainObject(fc.args) ? fc.args : {};
          const block: ToolUseBlock = { type: "tool_use", id, name, input };
          blocks.push(block);
          toolUseById.set(id, block);
          toolUseStartMs.set(id, date.getTime());
        }
      }
      if (blocks.length === 0) continue; // empty / failed assistant turn
      entries.push({
        type: "assistant",
        ...base,
        message: {
          role: "assistant",
          content: blocks,
          model: typeof line.model === "string" ? line.model : undefined,
        },
      } satisfies AssistantEntry);
      continue;
    }

    // tool_result / user: functionResponse parts attach to their call; plain
    // text parts become a user turn.
    let attachedAny = false;
    const textParts: string[] = [];
    for (const p of parts) {
      if (!isPlainObject(p)) continue;
      const fr = isPlainObject(p.functionResponse) ? p.functionResponse : undefined;
      if (fr) {
        const callId = typeof fr.id === "string" ? fr.id : undefined;
        const block = callId ? toolUseById.get(callId) : undefined;
        if (block) {
          const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
          const durationMs = Math.max(0, date.getTime() - startMs);
          // Prefer the sidecar's rendered text — it is what the TUI showed —
          // and fall back to flattening the raw functionResponse payload.
          const sidecar = isPlainObject(line.toolCallResult) ? line.toolCallResult : undefined;
          const display =
            sidecar && typeof sidecar.resultDisplay === "string" && sidecar.resultDisplay.length > 0
              ? sidecar.resultDisplay
              : extractResponseText(fr.response);
          block.result = {
            timestamp,
            timestampFormatted: formatTimestamp(date),
            content: display,
            durationMs,
            durationFormatted: formatDuration(durationMs),
          };
          attachedAny = true;
          continue;
        }
      }
      if (typeof p.text === "string" && p.text.length > 0) textParts.push(p.text);
    }
    if (textParts.length > 0) {
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: textParts.join("\n") },
      } satisfies UserEntry);
    } else if (!attachedAny) {
      entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
    }
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── Discovery + file loader ──

export interface QwenTranscriptFile {
  /** Encoded folder name on disk (e.g. "-home-user-project"). */
  projectName: string;
  /** Decoded cwd of the project (lossy; canonical cwd lives on every line). */
  cwd: string;
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Enumerate `projects/<encoded-cwd>/chats/<uuid>.jsonl` transcripts. */
export function listQwenTranscripts(): QwenTranscriptFile[] {
  const root = qwenProjectsRoot();
  const out: QwenTranscriptFile[] = [];
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const projectName = dir.name;
    const cwd = decodeFolderName(projectName);
    // Transcripts live one level deeper than Claude/Factory, under `chats/`.
    const chatsPath = join(root, projectName, "chats");
    let files: string[];
    try {
      files = readdirSync(chatsPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!QWEN_SESSION_ID_RE.test(sessionId)) continue;
      const transcriptPath = join(chatsPath, file);
      try {
        const st = statSync(transcriptPath);
        out.push({
          projectName,
          cwd,
          sessionId,
          transcriptPath,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

/** Resolve a session UUID to its on-disk transcript path (host-side). Guards
 *  against traversal by requiring a UUID filename. Shared by the audit adapter,
 *  the hook transcript resolver, and download-session. Synchronous so the hook
 *  hot path can call it without awaits. */
export function findQwenTranscript(sessionId: string): string | null {
  if (!QWEN_SESSION_ID_RE.test(sessionId)) return null;
  for (const t of listQwenTranscripts()) {
    if (t.sessionId === sessionId) return t.transcriptPath;
  }
  return null;
}

export interface QwenSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

/** Load and parse one session transcript by UUID. Returns `null` when the file
 *  is missing/unreadable or the id fails validation. */
export async function getQwenSessionLog(sessionId: string): Promise<QwenSessionLogData | null> {
  const filePath = findQwenTranscript(sessionId);
  if (!filePath) return null;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const rawLines = parseRawLines(content, "session");
  const entries = qwenLinesToLogEntries(rawLines, "session");
  // Every line carries the real cwd; take the first one rather than trusting
  // the lossy decoded folder name.
  let cwd: string | undefined;
  for (const line of rawLines) {
    if (isPlainObject(line) && typeof line.cwd === "string" && line.cwd.length > 0) {
      cwd = line.cwd;
      break;
    }
  }
  return { entries, rawLines, cwd, filePath };
}

export const getCachedQwenSessionLog = runtimeCache(
  (sessionId: string) => getQwenSessionLog(sessionId),
  60,
  { maxSize: 50 },
);
