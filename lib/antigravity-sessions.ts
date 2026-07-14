/**
 * Antigravity (agy) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Antigravity writes one plain-JSONL transcript per
 * conversation at
 * `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 * (one step per line). Verified live against agy v1.1.2. Sibling
 * `<conversationId>.trajectory.jsonl` / `.trajectory-path.json` files are
 * IGNORED — we only read `transcript_full.jsonl`.
 *
 * Each transcript line is a step:
 *   {step_index, source, type, status, created_at, content?, tool_calls?}
 * The `type` enum (uppercase) drives parsing:
 *   • USER_INPUT           — content = user text
 *   • PLANNER_RESPONSE      — content = assistant text, OR tool_calls =
 *                             [{name:"run_command", args:{CommandLine, Cwd, …}}]
 *   • <TOOL_STEP> (e.g. RUN_COMMAND) — content = the tool result string; the
 *                             `type` is the uppercased tool name, so we pair it
 *                             with the preceding PLANNER_RESPONSE tool_call of
 *                             the same name.
 *   • CONVERSATION_HISTORY / CHECKPOINT — metadata (skipped).
 *
 * `antigravityLinesToLogEntries` is PURE (a function of the parsed line
 * objects), so it is unit-testable without touching disk.
 *
 * Home override: set `ANTIGRAVITY_HOME` (used by tests / to point at a copied
 * brain dir). Default: `~/.gemini/antigravity-cli`.
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

/** Antigravity conversations are UUID-named directories. */
export const ANTIGRAVITY_CONVERSATION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Step `type` values that are metadata, not turns. */
const ANTIGRAVITY_META_STEP_TYPES = new Set(["CONVERSATION_HISTORY", "CHECKPOINT"]);

/** Absolute path to Antigravity's config home (override with ANTIGRAVITY_HOME). */
export function antigravityHome(): string {
  return process.env.ANTIGRAVITY_HOME || join(homedir(), ".gemini", "antigravity-cli");
}

/** Absolute path to the `brain/` root (one subdir per conversation). */
export function antigravityBrainRoot(): string {
  return join(antigravityHome(), "brain");
}

/** Relative path of a conversation's full transcript inside its brain dir. */
export function antigravityTranscriptRelPath(): string {
  return join(".system_generated", "logs", "transcript_full.jsonl");
}

// ── Parsing helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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
 * Convert Antigravity transcript JSONL lines (parsed objects, in file order)
 * into `LogEntry[]`. USER_INPUT → user turns; PLANNER_RESPONSE → assistant
 * turns (text and/or `tool_use` blocks); a following tool-result step
 * (type === uppercased tool name, e.g. RUN_COMMAND) is paired back onto the
 * matching `tool_use` block. Metadata steps (CONVERSATION_HISTORY, CHECKPOINT)
 * are skipped. Pure — unit-testable with plain line objects.
 */
export function antigravityLinesToLogEntries(
  lines: Record<string, unknown>[],
  source: LogSource = "session",
): LogEntry[] {
  const entries: LogEntry[] = [];
  // FIFO of pending tool_use blocks keyed by uppercased tool name, so a later
  // RUN_COMMAND-type result step attaches to the right run_command call.
  const pendingByType = new Map<string, Array<{ block: ToolUseBlock; startMs: number }>>();
  const baseMs = Date.now();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPlainObject(line)) continue;
    const type = typeof line.type === "string" ? line.type : "";
    if (!type || ANTIGRAVITY_META_STEP_TYPES.has(type)) continue;

    const date = toDate(line.created_at, baseMs + i);
    const timestamp = date.toISOString();
    const stepIndex = typeof line.step_index === "number" ? line.step_index : i;
    const raw: Record<string, unknown> = {
      uuid: `antigravity-${stepIndex}`,
      parentUuid: null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    if (type === "USER_INPUT") {
      const text = typeof line.content === "string" ? line.content : "";
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: text },
      } satisfies UserEntry);
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      const blocks: ContentBlock[] = [];
      if (typeof line.content === "string" && line.content.length > 0) {
        blocks.push({ type: "text", text: line.content });
      }
      if (Array.isArray(line.tool_calls)) {
        for (let j = 0; j < line.tool_calls.length; j++) {
          const call = line.tool_calls[j];
          if (!isPlainObject(call)) continue;
          const name = typeof call.name === "string" ? call.name : "tool";
          const input = isPlainObject(call.args) ? call.args : {};
          const id = `${name}-${stepIndex}-${j}`;
          const block: ToolUseBlock = { type: "tool_use", id, name, input };
          blocks.push(block);
          const key = name.toUpperCase();
          const queue = pendingByType.get(key) ?? [];
          queue.push({ block, startMs: date.getTime() });
          pendingByType.set(key, queue);
        }
      }
      if (blocks.length === 0) continue;
      entries.push({
        type: "assistant",
        ...base,
        message: { role: "assistant", content: blocks },
      } satisfies AssistantEntry);
      continue;
    }

    // Any other step type is a tool-result step whose `type` is the uppercased
    // tool name (e.g. RUN_COMMAND for a run_command call). Pair it back onto the
    // oldest matching pending tool_use block.
    const queue = pendingByType.get(type);
    if (queue && queue.length > 0) {
      const { block, startMs } = queue.shift()!;
      const durationMs = Math.max(0, date.getTime() - startMs);
      block.result = {
        timestamp,
        timestampFormatted: formatTimestamp(date),
        content: typeof line.content === "string" ? line.content : "",
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };
      continue;
    }
    // Unpaired non-meta step — record as generic so nothing is silently lost.
    entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

/** Best-effort cwd recovery: the first `run_command` tool_call's `Cwd` arg. */
function recoverCwd(lines: Record<string, unknown>[]): string | undefined {
  for (const line of lines) {
    if (!isPlainObject(line) || !Array.isArray(line.tool_calls)) continue;
    for (const call of line.tool_calls) {
      if (!isPlainObject(call) || !isPlainObject(call.args)) continue;
      const cwd = call.args.Cwd ?? call.args.cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    }
  }
  return undefined;
}

// ── Discovery + file loader ──

export interface AntigravityTranscriptFile {
  conversationId: string;
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Enumerate `brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 *  transcripts. Skips conversation dirs without a full transcript. */
export function listAntigravityTranscripts(): AntigravityTranscriptFile[] {
  const root = antigravityBrainRoot();
  const rel = antigravityTranscriptRelPath();
  const out: AntigravityTranscriptFile[] = [];
  let convoDirs: import("node:fs").Dirent[];
  try {
    convoDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of convoDirs) {
    const conversationId = dir.name;
    if (!ANTIGRAVITY_CONVERSATION_ID_RE.test(conversationId)) continue;
    const transcriptPath = join(root, conversationId, rel);
    try {
      const st = statSync(transcriptPath);
      if (!st.isFile()) continue;
      out.push({ conversationId, transcriptPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {
      // no full transcript for this conversation yet — skip
    }
  }
  return out;
}

/** Resolve a conversation UUID to its on-disk transcript path (host-side).
 *  Guards against traversal by requiring a UUID. Shared by the audit adapter,
 *  the hook transcript resolver, and download-session. Synchronous. */
export function findAntigravityTranscript(conversationId: string): string | null {
  if (!ANTIGRAVITY_CONVERSATION_ID_RE.test(conversationId)) return null;
  const transcriptPath = join(
    antigravityBrainRoot(),
    conversationId,
    antigravityTranscriptRelPath(),
  );
  try {
    if (statSync(transcriptPath).isFile()) return transcriptPath;
  } catch {
    // fall through
  }
  return null;
}

export interface AntigravitySessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

/** Load and parse one conversation transcript by UUID. Returns `null` when the
 *  file is missing/unreadable or the id fails validation. */
export async function getAntigravitySessionLog(
  conversationId: string,
): Promise<AntigravitySessionLogData | null> {
  const filePath = findAntigravityTranscript(conversationId);
  if (!filePath) return null;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const rawLines = parseRawLines(content, "session");
  const entries = antigravityLinesToLogEntries(rawLines, "session");
  const cwd = recoverCwd(rawLines);
  return { entries, rawLines, cwd, filePath };
}

export const getCachedAntigravitySessionLog = runtimeCache(
  (conversationId: string) => getAntigravitySessionLog(conversationId),
  60,
  { maxSize: 50 },
);
