/**
 * GitHub Copilot CLI session transcript discovery + JSONL parser.
 *
 * Copilot stores per-session state at:
 *   ~/.copilot/session-state/<sessionId>/
 *     workspace.yaml           — session metadata (id, cwd, git_root, branch, …)
 *     events.jsonl             — event log (only created after first interaction)
 *     session.db               — per-session SQLite (cross-session index lives at ~/.copilot/session-store.db)
 *     checkpoints/index.md     — checkpoint history
 *     files/, research/        — workspace artifacts
 *
 * (configurable via COPILOT_HOME). Each `events.jsonl` line is a record with
 * shape `{ type, data, id, timestamp, parentId }` where `type` is a dotted
 * path. Verified record types as of Copilot CLI 1.0.39:
 *   • session.start         — data.sessionId, data.context.{cwd, gitRoot, branch, repository, headCommit}
 *   • session.model_change  — data.newModel
 *   • session.shutdown      — data.shutdownType, data.codeChanges, …
 *   • system.message        — data.role, data.content
 *   • user.message          — data.content, data.transformedContent
 *   • assistant.turn_start  — data.turnId, data.interactionId
 *   • assistant.message     — data.messageId, data.content, data.toolRequests
 *   • assistant.turn_end    — data.turnId
 *   • tool.execution_start  — data.toolCallId, data.toolName, data.arguments
 *   • tool.execution_complete — data.toolCallId, data.success, data.result.{content, detailedContent}
 *
 * Unknown record types are preserved as generic system entries so nothing is
 * silently dropped.
 *
 * Refs:
 *   https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
 *   https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
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

/** Root directory for Copilot CLI session state, honoring COPILOT_HOME. */
export function getCopilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

export function getCopilotSessionStateRoot(): string {
  return join(getCopilotHome(), "session-state");
}

/** Session-state dir for a given sessionId. Returns null if `sessionId` is
 *  empty or contains path-traversal segments that would escape the
 *  session-state root. */
export function getCopilotSessionDir(sessionId: string): string | null {
  if (!sessionId) return null;
  const root = resolve(getCopilotSessionStateRoot());
  const candidate = resolve(root, sessionId);
  // Containment check: the resolved path must be a child of `root`.
  // (Equality means `sessionId` resolved to root itself — also rejected.)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

/** Resolve a single file under a session directory, applying the same
 *  containment check. Returns null if the sessionId is invalid. */
function resolveSessionFile(sessionId: string, filename: string): string | null {
  const dir = getCopilotSessionDir(sessionId);
  if (!dir) return null;
  return join(dir, filename);
}

// ── Transcript discovery ──

/**
 * Locate a Copilot CLI events.jsonl by sessionId. Copilot lays sessions out
 * directly under `session-state/<sessionId>/events.jsonl` (only created after
 * the first user interaction), so the lookup is a single existence check.
 * Path-traversal sessionIds (`../foo`) are rejected.
 *
 * Synchronous so the hook hot path can call it without awaits.
 */
export function findCopilotTranscript(sessionId: string): string | null {
  const candidate = resolveSessionFile(sessionId, "events.jsonl");
  if (!candidate) return null;
  return existsSync(candidate) ? candidate : null;
}

/** Locate the workspace.yaml for a session (always present, even pre-interaction). */
export function findCopilotWorkspace(sessionId: string): string | null {
  const candidate = resolveSessionFile(sessionId, "workspace.yaml");
  if (!candidate) return null;
  return existsSync(candidate) ? candidate : null;
}

/**
 * Extract a single key from the YAML at `path` using a permissive regex
 * (avoids adding a YAML parser dep for the handful of flat scalar fields
 * Copilot writes). Returns the trimmed string value or undefined.
 */
function readYamlScalar(path: string, key: string): string | undefined {
  try {
    const text = readFileSync(path, "utf-8");
    const re = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m");
    const m = text.match(re);
    if (!m) return undefined;
    // Strip surrounding quotes if any.
    return m[1].replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

/** Read the cwd recorded in workspace.yaml for a session. */
export function readCopilotWorkspaceCwd(sessionId: string): string | undefined {
  const path = findCopilotWorkspace(sessionId);
  if (!path) return undefined;
  return readYamlScalar(path, "cwd");
}

// ── Parser ──

interface CopilotRecord {
  type?: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
}

interface CopilotParseResult {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  /** Working directory pulled from the first session.start record. */
  cwd?: string;
}

interface CopilotToolResult {
  content?: string;
  detailedContent?: string;
}

interface CopilotHookToolResult {
  textResultForLlm?: string;
  sessionLog?: string;
}

interface CopilotToolTelemetry {
  metrics?: { commandTimeMs?: number; durationMs?: number };
  properties?: Record<string, unknown>;
}

/**
 * Parse a Copilot CLI events.jsonl transcript into `LogEntry[]` plus the raw
 * lines. Yields to the event loop every 200 lines so big transcripts don't
 * block the request.
 */
export async function parseCopilotLog(
  fileContent: string,
  source: LogSource = "session",
): Promise<CopilotParseResult> {
  const lines = fileContent.split("\n").filter((line) => line.trim() !== "");
  const entries: LogEntry[] = [];
  const rawLines: Record<string, unknown>[] = [];
  // toolCallId → tool_use block, so we can attach tool.execution_complete back.
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();
  let mostRecentToolUse: ToolUseBlock | undefined;
  let mostRecentToolUseStartMs = 0;
  let cwd: string | undefined;
  let seenSessionStart = false;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 200 === 0) await new Promise<void>((r) => setImmediate(r));

    const line = lines[i];
    let raw: CopilotRecord;
    try {
      raw = JSON.parse(line) as CopilotRecord;
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
    const data = raw.data ?? {};

    if (recType === "session.start") {
      const ctx = data.context as { cwd?: unknown } | undefined;
      const c = ctx?.cwd;
      if (typeof c === "string" && !cwd) cwd = c;
      const label: QueueOperationEntry["label"] = seenSessionStart ? "Session Resumed" : "Session Started";
      seenSessionStart = true;
      entries.push({
        type: "queue-operation",
        ...baseEntry(rawCopy, timestamp, date, source),
        label,
      } satisfies QueueOperationEntry);
      continue;
    }

    if (recType === "user.message") {
      const text = (data.content as string) ?? "";
      if (!text) continue;
      entries.push({
        type: "user",
        ...baseEntry(rawCopy, timestamp, date, source),
        message: { role: "user", content: text },
      } satisfies UserEntry);
      continue;
    }

    if (recType === "system.message") {
      // System prompts are noisy; render as a generic system entry so they're
      // visible in the raw view but don't dominate the structured timeline.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    if (recType === "assistant.message") {
      const text = (data.content as string) ?? "";
      if (!text) {
        entries.push({
          type: "system",
          ...baseEntry(rawCopy, timestamp, date, source),
          raw: rawCopy,
        } satisfies GenericEntry);
        continue;
      }
      const blocks: ContentBlock[] = [{ type: "text", text }];
      entries.push({
        type: "assistant",
        ...baseEntry(rawCopy, timestamp, date, source),
        message: { role: "assistant", content: blocks },
      } satisfies AssistantEntry);
      continue;
    }

    if (recType === "tool.execution_start") {
      const callId = data.toolCallId as string | undefined;
      const name = (data.toolName as string) ?? "tool";
      const args = (data.arguments as Record<string, unknown>) ?? {};
      const id = callId ?? `${date.getTime()}-${name}`;
      const toolUse: ToolUseBlock = {
        type: "tool_use",
        id,
        name,
        input: args,
      };
      const entry: AssistantEntry = {
        type: "assistant",
        ...baseEntry(rawCopy, timestamp, date, source),
        message: { role: "assistant", content: [toolUse] },
      };
      entries.push(entry);
      if (callId) {
        toolUseById.set(callId, toolUse);
        toolUseStartMs.set(callId, date.getTime());
      }
      mostRecentToolUse = toolUse;
      mostRecentToolUseStartMs = date.getTime();
      continue;
    }

    // Copilot CLI 1.0.39 can omit the command's real stdout from
    // `tool.execution_complete` and expose it only to the PostToolUse hook as
    // `input.toolResult.textResultForLlm`. That is the value the model saw and
    // the value failproofai must audit. Keep it on the active tool block; the
    // later completion record may still contribute timing, but must not replace
    // this output with its shorter status-only summary.
    if (recType === "hook.start" && data.hookType === "postToolUse" && mostRecentToolUse) {
      const input = (data.input as Record<string, unknown> | undefined) ?? {};
      const hookResult = (input.toolResult as CopilotHookToolResult | undefined) ?? {};
      const hookContent = hookResult.textResultForLlm ?? hookResult.sessionLog;
      if (typeof hookContent === "string" && hookContent.length > 0) {
        mostRecentToolUse.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: hookContent,
          durationMs: Math.max(0, date.getTime() - mostRecentToolUseStartMs),
          durationFormatted: formatDuration(Math.max(0, date.getTime() - mostRecentToolUseStartMs)),
        };
      }
    }

    if (recType === "tool.execution_complete") {
      const callId = data.toolCallId as string | undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (block) {
        const startMs = toolUseStartMs.get(callId!) ?? date.getTime();
        const result = (data.result as CopilotToolResult | undefined) ?? {};
        const telemetry = (data.toolTelemetry as CopilotToolTelemetry | undefined) ?? {};
        const reportedMs =
          telemetry.metrics?.commandTimeMs ?? telemetry.metrics?.durationMs ?? null;
        const durationMs =
          typeof reportedMs === "number" && reportedMs >= 0
            ? reportedMs
            : Math.max(0, date.getTime() - startMs);
        const completionContent = result.detailedContent ?? result.content ?? "";
        const content = block.result?.content || completionContent;
        block.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: typeof content === "string" ? content : JSON.stringify(content),
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
        continue;
      }
      // Orphan tool result — preserve as system.
      entries.push({
        type: "system",
        ...baseEntry(rawCopy, timestamp, date, source),
        raw: rawCopy,
      } satisfies GenericEntry);
      continue;
    }

    // assistant.turn_start, assistant.turn_end, session.model_change,
    // session.shutdown, and any unrecognized type — preserve raw so nothing is
    // silently dropped, but keep them out of the structured user/assistant
    // timeline (they're scaffolding events).
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

export interface CopilotSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

export async function getCopilotSessionLog(sessionId: string): Promise<CopilotSessionLogData | null> {
  const filePath = findCopilotTranscript(sessionId);
  if (!filePath) return null;
  // findCopilotTranscript only proves existence at lookup time; the file can be
  // removed/rotated before this readFile lands. Preserve the nullable contract
  // instead of throwing into the session page.
  let fileContent: string;
  try {
    fileContent = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const { entries, rawLines, cwd } = await parseCopilotLog(fileContent, "session");
  // Fall back to workspace.yaml if events.jsonl didn't expose a session.start.
  const resolvedCwd = cwd ?? readCopilotWorkspaceCwd(sessionId);
  return { entries, rawLines, cwd: resolvedCwd, filePath };
}

export const getCachedCopilotSessionLog = runtimeCache(
  (sessionId: string) => getCopilotSessionLog(sessionId),
  60,
  { maxSize: 50 },
);

// ── Test helpers ──

/** For tests: read raw stat of the events.jsonl path, returning null on miss. */
export function _statTranscript(sessionId: string): { mtimeMs: number } | null {
  const path = findCopilotTranscript(sessionId);
  if (!path) return null;
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** For tests: list session IDs found in session-state/. */
export function _listSessionIds(): string[] {
  try {
    return readdirSync(getCopilotSessionStateRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Surface a sync read variant used by lower-level code paths. */
export function readCopilotTranscriptSync(sessionId: string): string | null {
  const path = findCopilotTranscript(sessionId);
  if (!path) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
