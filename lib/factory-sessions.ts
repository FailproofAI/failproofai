/**
 * Factory (droid) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). droid writes one JSONL transcript per session at
 * `~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl` (Claude-style
 * encoded-cwd folders — e.g. `-home-chetan-project`), alongside a
 * `<sessionId>.settings.json` sibling we IGNORE. Verified live against droid
 * v0.171.0.
 *
 * The transcript is type-discriminated JSONL:
 *   {type:"session_start", id, cwd, …}     — header (carries cwd)
 *   {type:"message", timestamp, message:{role, content, visibility}} — the turns
 *   {type:"compaction_state", …}           — metadata (skipped)
 *
 * Message content is Claude-style: a string (user text) or an array of
 * {type:"text",text} / {type:"tool_use",id,name,input} / {type:"tool_result",
 * tool_use_id,content} blocks. `factoryLinesToLogEntries` pairs each assistant
 * `tool_use` with its later `tool_result` by id (mirrors lib/openclaw-sessions.ts)
 * and is PURE, so it is unit-testable with plain line objects.
 *
 * Home override: set `FACTORY_HOME` (used by tests / to point at a copied
 * sessions dir).
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

/** Factory sessions are stored under UUID filenames. */
export const FACTORY_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Absolute path to Factory's config home (override with FACTORY_HOME). */
export function factoryHome(): string {
  return process.env.FACTORY_HOME || join(homedir(), ".factory");
}

/** Absolute path to the Factory sessions root. */
export function factorySessionsRoot(): string {
  return join(factoryHome(), "sessions");
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
 * Convert Factory transcript JSONL lines (parsed objects, in file order) into
 * `LogEntry[]`. Only `type:"message"` lines carry turns; `session_start` /
 * `compaction_state` / other metadata lines are skipped. Assistant `tool_use`
 * blocks are paired with their later `tool_result` (delivered on a user/tool
 * message) by tool_use id. Pure — unit-testable with plain line objects.
 */
export function factoryLinesToLogEntries(
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
    if (line.type !== "message") continue; // skip session_start / compaction_state / …

    const m = isPlainObject(line.message) ? line.message : undefined;
    if (!m) continue;
    const role = typeof m.role === "string" ? m.role : "system";

    const date = toDate(line.timestamp ?? m.timestamp, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: line.id != null ? String(line.id) : `factory-${i}`,
      parentUuid: line.parentId != null ? String(line.parentId) : null,
    };
    const base = baseEntry(raw, timestamp, date, source);
    const content = m.content;

    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isPlainObject(b)) continue;
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "tool_use") {
            const id = typeof b.id === "string" ? b.id : `${String(b.name ?? "tool")}-${blocks.length}`;
            const name = typeof b.name === "string" ? b.name : "tool";
            const input = isPlainObject(b.input) ? b.input : {};
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

    // user / tool role: may carry tool_result blocks and/or text.
    if (Array.isArray(content)) {
      let attachedAny = false;
      const textParts: string[] = [];
      for (const b of content) {
        if (!isPlainObject(b)) continue;
        if (b.type === "tool_result") {
          const callId =
            typeof b.tool_use_id === "string"
              ? (b.tool_use_id as string)
              : typeof b.toolUseId === "string"
                ? (b.toolUseId as string)
                : undefined;
          const block = callId ? toolUseById.get(callId) : undefined;
          if (block) {
            const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
            const durationMs = Math.max(0, date.getTime() - startMs);
            block.result = {
              timestamp,
              timestampFormatted: formatTimestamp(date),
              content: extractText(b.content),
              durationMs,
              durationFormatted: formatDuration(durationMs),
            };
            attachedAny = true;
            continue;
          }
        }
        if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
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
      continue;
    }

    if (role === "user") {
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: extractText(content) },
      } satisfies UserEntry);
      continue;
    }

    entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── Discovery + file loader ──

export interface FactoryTranscriptFile {
  /** Encoded folder name on disk (e.g. "-home-user-project"). */
  projectName: string;
  /** Decoded cwd of the project (lossy; canonical cwd lives in session_start). */
  cwd: string;
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Enumerate `sessions/<encoded-cwd>/<uuid>.jsonl` transcripts, skipping the
 *  `<uuid>.settings.json` sibling files. */
export function listFactoryTranscripts(): FactoryTranscriptFile[] {
  const root = factorySessionsRoot();
  const out: FactoryTranscriptFile[] = [];
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const projectName = dir.name;
    const cwd = decodeFolderName(projectName);
    const projectPath = join(root, projectName);
    let files: string[];
    try {
      files = readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      // Only `<uuid>.jsonl` — not `<uuid>.settings.json`.
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!FACTORY_SESSION_ID_RE.test(sessionId)) continue;
      const transcriptPath = join(projectPath, file);
      try {
        const st = statSync(transcriptPath);
        out.push({ projectName, cwd, sessionId, transcriptPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
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
export function findFactoryTranscript(sessionId: string): string | null {
  if (!FACTORY_SESSION_ID_RE.test(sessionId)) return null;
  for (const t of listFactoryTranscripts()) {
    if (t.sessionId === sessionId) return t.transcriptPath;
  }
  return null;
}

export interface FactorySessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

/** Load and parse one session transcript by UUID. Returns `null` when the file
 *  is missing/unreadable or the id fails validation. */
export async function getFactorySessionLog(
  sessionId: string,
): Promise<FactorySessionLogData | null> {
  const filePath = findFactoryTranscript(sessionId);
  if (!filePath) return null;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const rawLines = parseRawLines(content, "session");
  const entries = factoryLinesToLogEntries(rawLines, "session");
  // cwd lives on the `type:"session_start"` header line.
  let cwd: string | undefined;
  for (const line of rawLines) {
    if (isPlainObject(line) && line.type === "session_start" && typeof line.cwd === "string" && line.cwd.length > 0) {
      cwd = line.cwd;
      break;
    }
  }
  return { entries, rawLines, cwd, filePath };
}

export const getCachedFactorySessionLog = runtimeCache(
  (sessionId: string) => getFactorySessionLog(sessionId),
  60,
  { maxSize: 50 },
);
