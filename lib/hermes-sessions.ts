/**
 * Hermes (hermes-agent) session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). Hermes stores every gateway user's sessions in one
 * SQLite DB (`~/.hermes/state.db`). Like the OpenCode adapter, we do NOT bundle
 * a SQLite driver — we shell out to Hermes's own CLI (`hermes sessions export`)
 * and parse its output. Reading via the CLI is consistent (no WAL torn-reads)
 * and insulated from the DB's internal schema.
 *
 * Message shape is OpenAI Chat-Completions style (verified live against
 * state.db): assistant tool calls are `tool_calls[].function.{name, arguments}`
 * and results are separate `role:"tool"` messages keyed by `tool_call_id` — so
 * `parseHermesExport` mirrors `lib/codex-sessions.ts`'s call_id→ToolUseBlock
 * pairing. The parser is a PURE function of the export text so it is unit-
 * testable without `hermes` installed.
 *
 * ⚠️ On-box verification needed (cannot be checked without a live gateway):
 *   • the exact `hermes sessions export` invocation + whether it writes to
 *     stdout — see `HERMES_EXPORT_ARGS` below.
 *   • whether the export is a single `{ …meta, messages: [...] }` JSON doc or
 *     JSONL — `parseHermesExport` tolerates both.
 */
import { execFileSync } from "node:child_process";
import { runtimeCache } from "./runtime-cache";
import {
  baseEntry,
  formatTimestamp,
  type LogEntry,
  type UserEntry,
  type AssistantEntry,
  type GenericEntry,
  type ContentBlock,
  type ToolUseBlock,
  type LogSource,
} from "./log-entries";
import { formatDuration } from "./format-duration";

// ── CLI shell-out ──

/**
 * Args passed to the `hermes` binary to export ONE session to stdout.
 * `-` = write to stdout (the convention documented for `sessions export`).
 * ⚠️ Confirm on the gateway box; adjust here if the flag/format differs.
 */
function hermesExportArgs(sessionId: string): string[] {
  return ["sessions", "export", "--session-id", sessionId, "-"];
}

/** Run `hermes <args>` and return stdout, or `null` on any failure (binary
 *  missing, timeout, non-zero exit) — same fail-open contract as the other
 *  per-CLI providers. */
export function runHermes(args: string[]): string | null {
  try {
    const stdout = execFileSync("hermes", args, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024, // sessions can be large (100s of KB of tool output)
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout;
  } catch {
    return null;
  }
}

// ── Parsing helpers ──

function safeJsonParse(s: unknown): unknown {
  if (typeof s !== "string" || s.length === 0) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Extract text from a message `content` field that may be a string or an
 *  array of `{ type:"text", text }` blocks (OpenAI vision-style content). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        isPlainObject(c) && typeof c.text === "string" ? (c.text as string) : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Coerce a Hermes timestamp (epoch seconds, epoch ms, or ISO string) to a
 *  Date, falling back to `fallbackMs` when absent/unparseable so ordering and
 *  `entry.timestamp` are always valid. */
function toDate(value: unknown, fallbackMs: number): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    // > 1e12 → already ms; > 1e9 → seconds; otherwise treat as fallback.
    if (value > 1e12) return new Date(value);
    if (value > 1e9) return new Date(value * 1000);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return new Date(fallbackMs);
}

interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalize a message's `tool_calls` (array, or JSON-string of an array) into
 *  `{ id, name, input }[]`. Handles the OpenAI shape
 *  `{ id|call_id, function: { name, arguments } }` where `arguments` is itself a
 *  JSON string. */
function normalizeToolCalls(raw: unknown): NormalizedToolCall[] {
  const arr = Array.isArray(raw) ? raw : safeJsonParse(raw);
  if (!Array.isArray(arr)) return [];
  const out: NormalizedToolCall[] = [];
  for (const tc of arr) {
    if (!isPlainObject(tc)) continue;
    const fn = isPlainObject(tc.function) ? tc.function : {};
    const name =
      typeof fn.name === "string"
        ? fn.name
        : typeof tc.name === "string"
          ? (tc.name as string)
          : "tool";
    const id =
      (typeof tc.id === "string" && tc.id) ||
      (typeof tc.call_id === "string" && tc.call_id) ||
      `${name}-${out.length}`;
    const parsedArgs = isPlainObject(fn.arguments)
      ? fn.arguments
      : safeJsonParse(fn.arguments);
    const input = isPlainObject(parsedArgs) ? parsedArgs : {};
    out.push({ id, name, input: input as Record<string, unknown> });
  }
  return out;
}

// ── Public shape ──

export interface HermesSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string; // synthetic — hermes keeps sessions in a DB; we use hermes://<id>
}

/**
 * Parse a Hermes session export (as emitted by `hermes sessions export`) into
 * `LogEntry[]`. Pure — no I/O — so it can be unit-tested with fixture strings.
 *
 * Accepts either a single JSON document `{ …meta, messages: [...] }`, a bare
 * `[...]` array of messages, or JSONL (one message object per line).
 */
export function parseHermesExport(
  content: string,
  source: LogSource = "session",
): { entries: LogEntry[]; cwd?: string } {
  const messages = extractMessages(content);
  const cwd = extractCwd(content);

  const entries: LogEntry[] = [];
  // tool_call_id → tool_use block, so a later role:"tool" message can attach
  // its result back onto the originating call (mirrors parseCodexLog).
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();

  const baseMs = Date.now();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isPlainObject(m)) continue;

    const role = typeof m.role === "string" ? m.role : "system";
    const date = toDate(m.timestamp ?? m.time_created, baseMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: m.id != null ? String(m.id) : `hermes-${i}`,
      parentUuid: null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    if (role === "user") {
      const text = extractText(m.content);
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: text },
      } satisfies UserEntry);
      continue;
    }

    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      const text = extractText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of normalizeToolCalls(m.tool_calls)) {
        const block: ToolUseBlock = {
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        };
        blocks.push(block);
        toolUseById.set(tc.id, block);
        toolUseStartMs.set(tc.id, date.getTime());
      }
      // Skip entirely empty assistant turns (no text, no tool calls).
      if (blocks.length === 0) continue;
      entries.push({
        type: "assistant",
        ...base,
        message: { role: "assistant", content: blocks },
      } satisfies AssistantEntry);
      continue;
    }

    if (role === "tool") {
      const callId = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (block) {
        const startMs = (callId && toolUseStartMs.get(callId)) || date.getTime();
        const durationMs = Math.max(0, date.getTime() - startMs);
        block.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: extractText(m.content),
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
        continue;
      }
      // Orphan tool result — preserve as system so nothing is silently dropped.
    }

    // session_meta / system / unknown roles → generic entry (never lost).
    entries.push({
      type: "system",
      ...base,
      raw,
    } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return { entries, cwd };
}

/** Pull the `messages` array out of an export doc (object, array, or JSONL). */
function extractMessages(content: string): Record<string, unknown>[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const doc = safeJsonParse(trimmed);
  if (Array.isArray(doc)) return doc as Record<string, unknown>[];
  if (isPlainObject(doc) && Array.isArray(doc.messages)) {
    return doc.messages as Record<string, unknown>[];
  }
  // JSONL fallback: one message object per line.
  return trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => safeJsonParse(l))
    .filter((v): v is Record<string, unknown> => isPlainObject(v));
}

/** Best-effort cwd from the export doc's metadata (usually null for gateway
 *  sessions — Slack/Telegram runs have no working directory). */
function extractCwd(content: string): string | undefined {
  const doc = safeJsonParse(content.trim());
  if (isPlainObject(doc) && typeof doc.cwd === "string" && doc.cwd.length > 0) {
    return doc.cwd;
  }
  return undefined;
}

/**
 * Load a single session by ID. Returns `null` when the session doesn't exist or
 * the `hermes` binary is unavailable.
 */
export async function getHermesSessionLog(
  sessionId: string,
): Promise<HermesSessionLogData | null> {
  // Guard the interpolated id even though execFile doesn't use a shell — keeps
  // us from passing junk to the CLI.
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const content = runHermes(hermesExportArgs(sessionId));
  if (content == null) return null;
  const { entries, cwd } = parseHermesExport(content, "session");
  return { entries, rawLines: [], cwd, filePath: `hermes://${sessionId}` };
}

export const getCachedHermesSessionLog = runtimeCache(
  (sessionId: string) => getHermesSessionLog(sessionId),
  30,
  { maxSize: 50 },
);
