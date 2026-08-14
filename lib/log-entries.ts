import { readFile } from "fs/promises";
import { join } from "path";
import { getClaudeProjectsPath } from "./paths";
import { resolveProjectPath } from "./projects";
import { resolveSubagentPath } from "./resolve-subagent-path";
import { runtimeCache } from "./runtime-cache";
import { batchAll } from "./concurrency";
import { formatDate } from "./format-date";
import { formatDuration } from "./format-duration";

// ── Source Tagging ──

export type LogSource = "session" | `agent-${string}`;

// ── Content Block Types (for assistant messages) ──

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolResultImage {
  base64: string;
  mediaType: string;
}

export interface ToolResultInfo {
  timestamp: string;
  timestampFormatted: string;
  content?: string;
  images?: ToolResultImage[];
  durationMs: number;
  durationFormatted: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultInfo;
  subagentType?: string;
  subagentDescription?: string;
  subagentId?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

// ── Log Entry Types ──

export interface UserEntry {
  type: "user";
  _source: LogSource;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  timestampMs: number;
  timestampFormatted: string;
  message: {
    role: "user";
    content: string;
  };
}

export interface AssistantEntry {
  type: "assistant";
  _source: LogSource;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  timestampMs: number;
  timestampFormatted: string;
  message: {
    role: "assistant";
    content: ContentBlock[];
    model?: string;
  };
}

export interface GenericEntry {
  type: "file-history-snapshot" | "progress" | "system";
  _source: LogSource;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  timestampMs: number;
  timestampFormatted: string;
  raw: Record<string, unknown>;
}

export interface QueueOperationEntry {
  type: "queue-operation";
  _source: LogSource;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  timestampMs: number;
  timestampFormatted: string;
  label: "Session Started" | "Session Resumed";
}

export type LogEntry =
  | UserEntry
  | AssistantEntry
  | GenericEntry
  | QueueOperationEntry;

export type LogEntryType = LogEntry["type"];

// ── Helpers ──

export function formatTimestamp(date: Date): string {
  const base = formatDate(date);
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${base}.${ms}`;
}

/** Shared base fields present on every log entry. */
export function baseEntry(raw: Record<string, unknown>, timestamp: string, date: Date, source: LogSource) {
  return {
    _source: source,
    uuid: (raw.uuid as string) || "",
    parentUuid: (raw.parentUuid as string | null) ?? null,
    timestamp,
    timestampMs: date.getTime(),
    timestampFormatted: formatTimestamp(date),
  };
}

function extractToolResultContent(
  block: Record<string, unknown>
): { text?: string; images?: ToolResultImage[] } {
  const resultContent = block.content;
  if (typeof resultContent === "string") return { text: resultContent };
  if (Array.isArray(resultContent)) {
    const arr = resultContent as Array<Record<string, unknown>>;
    const textParts = arr
      .filter((r) => r.type === "text")
      .map((r) => r.text as string);
    const images = arr
      .filter((r) => r.type === "image")
      .map((r) => {
        const source = r.source as Record<string, unknown>;
        return {
          base64: source.data as string,
          mediaType: source.media_type as string,
        };
      })
      .filter((img) => img.base64 && img.mediaType);
    return {
      text: textParts.length > 0 ? textParts.join("\n") : undefined,
      images: images.length > 0 ? images : undefined,
    };
  }
  return {};
}

/**
 * Synchronous parseRawLines for callers that don't pass a source tag.
 * Keeps its own minimal loop (no subagent detection needed).
 */
export function parseRawLines(fileContent: string, source?: LogSource): Record<string, unknown>[] {
  return fileContent
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (source !== undefined) parsed._source = source;
        return [parsed];
      }
      catch { return []; }
    });
}

export interface SessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  subagentIds: string[];
}

interface ParseFileResult {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  subagentIds: string[];
}

// ── Unified Single-Pass Parser ──

/**
 * Single-pass async parser that produces entries, rawLines, and subagentIds
 * from one iteration over the JSONL content. Yields to the event loop every
 * 200 lines to prevent blocking during large file processing.
 */
async function parseFileContent(fileContent: string, source: LogSource): Promise<ParseFileResult> {
  const lines = fileContent.split("\n").filter((line) => line.trim() !== "");

  const toolResultMap = new Map<
    string,
    { timestamp: string; timestampMs: number; content?: string; images?: ToolResultImage[]; agentId?: string }
  >();
  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  const subagentIdSet = new Set<string>();
  let seenQueue = false;

  for (let i = 0; i < lines.length; i++) {
    // Yield to the event loop every 200 lines to prevent starvation
    if (i > 0 && i % 200 === 0) await new Promise<void>(r => setImmediate(r));

    const line = lines[i];
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Collect raw line with source tag (mirrors parseRawLines with source)
    const rawCopy = { ...raw, _source: source };
    rawLines.push(rawCopy);

    const type = raw.type as string | undefined;
    const timestamp = raw.timestamp as string;
    if (!timestamp) continue;

    const date = new Date(timestamp);
    const timestampMs = date.getTime();

    if (type === "user") {
      const message = raw.message as Record<string, unknown> | undefined;
      if (Array.isArray(message?.content)) {
        const blocks = message.content as Array<Record<string, unknown>>;
        const hasToolResult = blocks.some((b) => b.type === "tool_result");
        if (hasToolResult) {
          const toolUseResult = raw.toolUseResult as Record<string, unknown> | undefined;
          const agentId = (typeof toolUseResult?.agentId === "string") ? toolUseResult.agentId : undefined;

          // Detect subagent IDs — hex-only, matching the id format Claude Code
          // writes into toolUseResult.agentId.
          if (agentId && /^[a-f0-9]+$/.test(agentId)) {
            subagentIdSet.add(agentId);
          }

          for (const block of blocks) {
            if (block.type !== "tool_result") continue;
            const toolUseId = block.tool_use_id as string | undefined;
            if (!toolUseId) continue;
            const { text, images } = extractToolResultContent(block);
            toolResultMap.set(toolUseId, {
              timestamp,
              timestampMs,
              content: text,
              images,
              agentId,
            });
          }
          continue;
        }
      }

      // Regular user message
      const content =
        typeof message?.content === "string" ? message.content : "";
      entries.push({ type: "user", ...baseEntry(raw, timestamp, date, source), message: { role: "user", content } });
      continue;
    }

    if (type === "assistant") {
      const message = raw.message as Record<string, unknown> | undefined;
      let content: ContentBlock[] = [];

      if (Array.isArray(message?.content)) {
        content = (message.content as Array<Record<string, unknown>>)
          .filter((block) =>
            ["text", "tool_use", "thinking"].includes(block.type as string)
          )
          .map((block) => {
            if (block.type === "text") {
              return { type: "text" as const, text: block.text as string };
            }
            if (block.type === "tool_use") {
              const input = block.input as Record<string, unknown> | undefined;
              return {
                type: "tool_use" as const,
                id: block.id as string,
                name: block.name as string,
                input: (block.input as Record<string, unknown>) ?? {},
                ...(block.name === "Task" && input ? {
                  subagentType: input.subagent_type as string | undefined,
                  subagentDescription: input.description as string | undefined,
                } : {}),
              };
            }
            return {
              type: "thinking" as const,
              thinking: block.thinking as string,
              signature: block.signature as string | undefined,
            };
          });
      }

      if (content.length === 0) continue;

      entries.push({
        type: "assistant",
        ...baseEntry(raw, timestamp, date, source),
        message: { role: "assistant", content, model: message?.model as string | undefined },
      });
      continue;
    }

    if (type === "file-history-snapshot" || type === "progress" || type === "system") {
      entries.push({ type, ...baseEntry(raw, timestamp, date, source), raw: { ...raw } });
      continue;
    }

    if (type === "queue-operation") {
      const label = seenQueue ? "Session Resumed" : "Session Started";
      seenQueue = true;
      entries.push({ type: "queue-operation", ...baseEntry(raw, timestamp, date, source), label });
      continue;
    }
  }

  // Enrichment pass: attach tool results to their corresponding tool_use blocks
  // Yield every 200 assistant entries to prevent event-loop starvation
  let enrichCount = 0;
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    enrichCount++;
    if (enrichCount % 200 === 0) await new Promise<void>(r => setImmediate(r));
    for (const block of entry.message.content) {
      if (block.type !== "tool_use") continue;
      const resultInfo = toolResultMap.get(block.id);
      if (!resultInfo) continue;

      const returnDate = new Date(resultInfo.timestamp);
      const durationMs = Math.max(0, resultInfo.timestampMs - entry.timestampMs);
      block.result = {
        timestamp: resultInfo.timestamp,
        timestampFormatted: formatTimestamp(returnDate),
        content: resultInfo.content,
        images: resultInfo.images,
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };
      if (resultInfo.agentId) {
        block.subagentId = resultInfo.agentId;
      }
    }
  }

  // Yield before sort for large arrays
  if (entries.length > 500) await new Promise<void>(r => setImmediate(r));

  // Sort by timestamp ascending
  entries.sort((a, b) => a.timestampMs - b.timestampMs);

  return { entries, rawLines, subagentIds: Array.from(subagentIdSet) };
}

// ── Public wrappers ──

/**
 * Parses JSONL log content into structured log entries.
 * Returns entries sorted by timestamp ascending (earliest first).
 * Tool use blocks are enriched with their corresponding results.
 */
export async function parseLogContent(fileContent: string, source: LogSource = "session"): Promise<LogEntry[]> {
  const result = await parseFileContent(fileContent, source);
  return result.entries;
}

/**
 * Extracts subagent type and description from parsed entries for a given agentId.
 * Scans assistant entries for Task tool_use blocks matching the agentId.
 */
export function extractSubagentMeta(
  entries: LogEntry[],
  agentId: string,
): { type?: string; description?: string } | undefined {
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_use" && block.name === "Task" && block.subagentId === agentId) {
        return { type: block.subagentType, description: block.subagentDescription };
      }
    }
  }
  return undefined;
}

/**
 * Reads and parses a session JSONL log file.
 * Eagerly loads all subagent JSONL files and merges them into a single
 * entries/rawLines array with `_source` markers.
 */
const SUBAGENT_CONCURRENCY = 4;

export async function parseSessionLog(
  projectName: string,
  sessionId: string,
): Promise<SessionLogData> {
  // Defense-in-depth: validate path even though callers should have already done so.
  const projectDir = resolveProjectPath(projectName);
  const projectsPath = getClaudeProjectsPath();
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const fileContent = await readFile(filePath, "utf-8");

  const { entries: sessionEntries, rawLines: sessionRawLines, subagentIds } =
    await parseFileContent(fileContent, "session");

  if (subagentIds.length === 0) {
    return { entries: sessionEntries, rawLines: sessionRawLines, subagentIds: [] };
  }

  // Load subagent files with bounded concurrency to avoid file-descriptor pressure.
  const results = await batchAll(
    subagentIds.map((agentId) => async () => {
      const agentSource: LogSource = `agent-${agentId}`;
      const agentPath = await resolveSubagentPath(projectsPath, projectName, sessionId, agentId);
      if (!agentPath) return null;
      const agentContent = await readFile(agentPath, "utf-8");
      const { entries, rawLines } = await parseFileContent(agentContent, agentSource);
      return { entries, rawLines };
    }),
    SUBAGENT_CONCURRENCY,
  );

  // Combine all entries and rawLines
  const allEntries = [...sessionEntries];
  const allRawLines = [...sessionRawLines];

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      allEntries.push(...result.value.entries);
      allRawLines.push(...result.value.rawLines);
    }
  }

  // Yield before sort for large combined arrays
  if (allEntries.length > 500) await new Promise<void>(r => setImmediate(r));

  // Sort combined entries by timestamp
  allEntries.sort((a, b) => a.timestampMs - b.timestampMs);

  return { entries: allEntries, rawLines: allRawLines, subagentIds };
}

export const getCachedSessionLog = runtimeCache(
  (projectName: string, sessionId: string) => parseSessionLog(projectName, sessionId),
  60,
  { maxSize: 50 },
);
