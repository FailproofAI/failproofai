/**
 * grok CLI session transcript loader + parser.
 *
 * AUDIT-ONLY (Pillar 2). grok stores one DIRECTORY per session at
 * `~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/`, holding
 * `chat_history.jsonl` (the turns), `events.jsonl` (a telemetry stream),
 * `summary.json` (title + cwd + counts), and assorted lock/state files we
 * ignore. Verified live against grok 1.0.3 (1a29d5bc12).
 *
 * TWO things differ from every other JSONL adapter, and both are load-bearing:
 *
 *   1. **The cwd folder is PERCENT-encoded** (`%2Fhome%2Fyou%2Frepo`), not
 *      dash-encoded like Claude/Factory/Qwen — so this module decodes with
 *      `decodeURIComponent`, NOT `decodeFolderName`. Using the shared helper
 *      here would silently yield a cwd of literal "%2Fhome%2F…" and every
 *      project grouping would be wrong.
 *
 *   2. **`chat_history.jsonl` carries NO timestamps.** Per-event times live in
 *      `events.jsonl`, which is not 1:1 with the turns. Rather than mis-pair
 *      them, `grokLinesToLogEntries` takes an explicit `startMs` (the session's
 *      `created_at` from summary.json) and lays the turns out one millisecond
 *      apart from there. That keeps ordering exact and the session's absolute
 *      position on the timeline right, while being honest that per-turn
 *      wall-clock times are synthesized, not recorded.
 *
 * Line shapes (OpenAI-ish, discriminated by `type`):
 *   {type:"system",    content:string}                              — prompt, skipped
 *   {type:"user",      content:[{type:"text",text}], prompt_index?} — see below
 *   {type:"reasoning", summary:[{type:"summary_text",text}], …}     — skipped
 *   {type:"assistant", content:string, tool_calls:[{id,name,arguments:string}]}
 *   {type:"tool_result", tool_call_id, content:string}
 *
 * `tool_calls[].arguments` is a JSON **string**, not an object — it is parsed
 * here so tool inputs are inspectable like every other CLI's.
 *
 * Only user lines carrying `prompt_index` are treated as real user turns. grok
 * also writes the environment preamble and `synthetic_reason` reminder
 * injections as `user` lines; surfacing those as if the operator typed them
 * would make an audit read like the user pasted grok's own boilerplate.
 * `prompt_history.jsonl` (a per-cwd sibling) records exactly the same set,
 * which is the cross-check that this filter is the right one.
 *
 * Home override: set `GROK_HOME` (used by tests / to point at a copied
 * sessions dir).
 */
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** grok session directories are UUID-named (UUIDv7 in practice). */
export const GROK_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Absolute path to grok's config home (override with GROK_HOME). */
export function grokHome(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

/** Absolute path to the grok sessions root. */
export function grokSessionsRoot(): string {
  return join(grokHome(), "sessions");
}

/**
 * Decode grok's percent-encoded cwd folder name. Deliberately NOT
 * `decodeFolderName` — see the module header. Falls back to the raw name when
 * the folder is not valid percent-encoding, so a malformed dir degrades to a
 * visible label instead of throwing mid-listing.
 */
export function decodeGrokProjectDir(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

// ── Parsing helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Text from a `content` field that is either a string or an array of
 *  `{type:"text",text}` blocks. */
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

/** grok serializes tool args as a JSON string; parse it, tolerating garbage. */
function parseArguments(args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // fall through — keep the raw string so the audit still shows something
    }
    return { arguments: args };
  }
  return {};
}

// ── Pure parser: transcript lines → LogEntry[] ──

/**
 * Convert grok `chat_history.jsonl` lines (parsed objects, in file order) into
 * `LogEntry[]`.
 *
 * `startMs` anchors the synthesized timeline — pass the session's `created_at`
 * (from summary.json). Turns are laid out 1ms apart in file order. Pure —
 * unit-testable with plain line objects.
 */
export function grokLinesToLogEntries(
  lines: Record<string, unknown>[],
  startMs: number = Date.now(),
  source: LogSource = "session",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const toolUseById = new Map<string, ToolUseBlock>();
  const toolUseStartMs = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPlainObject(line)) continue;
    const type = typeof line.type === "string" ? line.type : "";
    // The system prompt and the model's private reasoning are not turns.
    if (type === "system" || type === "reasoning") continue;

    const date = new Date(startMs + i);
    const timestamp = date.toISOString();
    const raw: Record<string, unknown> = {
      uuid: line.id != null ? String(line.id) : `grok-${i}`,
      parentUuid: null,
    };
    const base = baseEntry(raw, timestamp, date, source);

    if (type === "assistant") {
      const blocks: ContentBlock[] = [];
      const text = extractText(line.content);
      if (text) blocks.push({ type: "text", text });
      const calls = Array.isArray(line.tool_calls) ? line.tool_calls : [];
      for (const c of calls) {
        if (!isPlainObject(c)) continue;
        const id = typeof c.id === "string" ? c.id : `${String(c.name ?? "tool")}-${blocks.length}`;
        const name = typeof c.name === "string" ? c.name : "tool";
        const block: ToolUseBlock = {
          type: "tool_use",
          id,
          name,
          input: parseArguments(c.arguments),
        };
        blocks.push(block);
        toolUseById.set(id, block);
        toolUseStartMs.set(id, date.getTime());
      }
      if (blocks.length === 0) continue;
      entries.push({
        type: "assistant",
        ...base,
        message: {
          role: "assistant",
          content: blocks,
          model: typeof line.model_id === "string" ? line.model_id : undefined,
        },
      } satisfies AssistantEntry);
      continue;
    }

    if (type === "tool_result") {
      const callId = typeof line.tool_call_id === "string" ? line.tool_call_id : undefined;
      const block = callId ? toolUseById.get(callId) : undefined;
      if (block) {
        const started = (callId && toolUseStartMs.get(callId)) || date.getTime();
        const durationMs = Math.max(0, date.getTime() - started);
        block.result = {
          timestamp,
          timestampFormatted: formatTimestamp(date),
          content: extractText(line.content),
          durationMs,
          durationFormatted: formatDuration(durationMs),
        };
        continue;
      }
      entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
      continue;
    }

    if (type === "user") {
      // Real operator prompts only — see the module header on prompt_index.
      if (line.prompt_index === undefined || line.synthetic_reason !== undefined) continue;
      entries.push({
        type: "user",
        ...base,
        message: { role: "user", content: extractText(line.content) },
      } satisfies UserEntry);
      continue;
    }

    entries.push({ type: "system", ...base, raw } satisfies GenericEntry);
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return entries;
}

// ── Discovery + file loader ──

export interface GrokTranscriptFile {
  /** Percent-encoded folder name on disk (e.g. "%2Fhome%2Fuser%2Frepo"). */
  projectName: string;
  /** Decoded cwd of the project. */
  cwd: string;
  sessionId: string;
  /** Path to chat_history.jsonl inside the session directory. */
  transcriptPath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Session title from summary.json, when present. */
  title?: string;
  /** created_at from summary.json (ms), used to anchor synthesized timestamps. */
  createdAtMs?: number;
}

/** Read the optional per-session summary.json sidecar. Never throws. */
function readSummary(sessionDir: string): {
  cwd?: string;
  title?: string;
  createdAtMs?: number;
} {
  try {
    const raw = JSON.parse(readFileSync(join(sessionDir, "summary.json"), "utf-8")) as unknown;
    if (!isPlainObject(raw)) return {};
    const info = isPlainObject(raw.info) ? raw.info : undefined;
    const createdAt = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
    return {
      cwd: info && typeof info.cwd === "string" ? info.cwd : undefined,
      title: typeof raw.session_summary === "string" ? raw.session_summary : undefined,
      createdAtMs: Number.isNaN(createdAt) ? undefined : createdAt,
    };
  } catch {
    return {};
  }
}

/** Enumerate `sessions/<encoded-cwd>/<uuid>/chat_history.jsonl` transcripts. */
export function listGrokTranscripts(): GrokTranscriptFile[] {
  const root = grokSessionsRoot();
  const out: GrokTranscriptFile[] = [];
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const projectName = dir.name;
    const projectPath = join(root, projectName);
    let sessionDirs: import("node:fs").Dirent[];
    try {
      sessionDirs = readdirSync(projectPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      const sessionId = sd.name;
      if (!GROK_SESSION_ID_RE.test(sessionId)) continue;
      const sessionDir = join(projectPath, sessionId);
      const transcriptPath = join(sessionDir, "chat_history.jsonl");
      let st: import("node:fs").Stats;
      try {
        st = statSync(transcriptPath);
      } catch {
        continue; // a session dir with no chat history yet
      }
      const summary = readSummary(sessionDir);
      out.push({
        projectName,
        // summary.json's info.cwd is canonical; the folder name is the fallback.
        cwd: summary.cwd ?? decodeGrokProjectDir(projectName),
        sessionId,
        transcriptPath,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        title: summary.title,
        createdAtMs: summary.createdAtMs,
      });
    }
  }
  return out;
}

/** Resolve a session UUID to its chat_history.jsonl path (host-side). Guards
 *  against traversal by requiring a UUID directory name. Synchronous so the
 *  hook hot path can call it without awaits. */
export function findGrokTranscript(sessionId: string): string | null {
  if (!GROK_SESSION_ID_RE.test(sessionId)) return null;
  for (const t of listGrokTranscripts()) {
    if (t.sessionId === sessionId) return t.transcriptPath;
  }
  return null;
}

export interface GrokSessionLogData {
  entries: LogEntry[];
  rawLines: Record<string, unknown>[];
  cwd?: string;
  filePath: string;
}

/** Load and parse one session transcript by UUID. Returns `null` when the file
 *  is missing/unreadable or the id fails validation. */
export async function getGrokSessionLog(sessionId: string): Promise<GrokSessionLogData | null> {
  if (!GROK_SESSION_ID_RE.test(sessionId)) return null;
  const meta = listGrokTranscripts().find((t) => t.sessionId === sessionId);
  if (!meta) return null;
  let content: string;
  try {
    content = await readFile(meta.transcriptPath, "utf-8");
  } catch {
    return null;
  }
  const rawLines = parseRawLines(content, "session");
  const entries = grokLinesToLogEntries(rawLines, meta.createdAtMs ?? meta.mtimeMs, "session");
  return { entries, rawLines, cwd: meta.cwd, filePath: meta.transcriptPath };
}

export const getCachedGrokSessionLog = runtimeCache(
  (sessionId: string) => getGrokSessionLog(sessionId),
  60,
  { maxSize: 50 },
);
