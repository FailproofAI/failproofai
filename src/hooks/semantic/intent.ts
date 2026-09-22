/**
 * What the human actually asked for.
 *
 * The semantic evaluator may clear a policy when the user explicitly asked for
 * the action — `git push --force` is right when you just said "force push it".
 * That makes "the user asked" the most valuable thing a prompt injection could
 * forge, so it is only ever read from a channel the agent cannot write to:
 *
 * - Live: a harness's prompt-submit event (canonical `UserPromptSubmit`) fires
 *   when a human submits a message, before the model sees it. `captureIntent`
 *   records the part of it the human typed — harness wrappers stripped,
 *   redacted, capped — into a 0600 file under failproofai's state directory,
 *   which the always-on self-protection guard already stops the agent from
 *   modifying. Each harness is audited separately (`PROMPT_CHANNELS` below and
 *   docs/reference/jev-intent.mdx): some have no such event, and some fire it
 *   for text no human typed, and those are never recorded.
 * - Replay: the eval harness reads historical transcripts, where human
 *   messages are the non-meta `user` entries whose content is text rather than
 *   a tool result.
 *
 * Alongside each prompt, `captureIntent` snapshots the agent's last visible
 * message from the transcript at that moment, so a reply like "yes, do it" can
 * be understood. The agent wrote that message: it is sent to Jev labelled as
 * agent-written and never counts as consent.
 *
 * Text inside a tool call claiming "the user approved this" is never consulted.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { semanticDir } from "../fp-home";
import type { IntegrationType } from "../types";
import { MAX_USER_MESSAGE_CHARS, capHeadTail, redactSecrets } from "./envelope";

export const MAX_RECORDED_PROMPTS = 5;
/** Older than this and a prompt no longer describes what the agent is doing. */
export const INTENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A prompt stamped further in the future than this was not written by us. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const sessionsDir = (): string => resolve(semanticDir(), "sessions");
const intentFile = (sessionId: string): string => resolve(sessionsDir(), `${sessionId}.json`);

interface RecordedPrompt {
  at: number;
  text: string;
  /** The agent's last visible message when this prompt was submitted. */
  agent?: string | null;
}

interface IntentFile {
  prompts: RecordedPrompt[];
}

function readIntentFile(sessionId: string): IntentFile {
  try {
    const parsed = JSON.parse(readFileSync(intentFile(sessionId), "utf8")) as IntentFile;
    return Array.isArray(parsed?.prompts) ? parsed : { prompts: [] };
  } catch {
    return { prompts: [] };
  }
}

/**
 * Append one prompt, keeping the newest `MAX_RECORDED_PROMPTS`. Atomic, 0600
 * file in a 0700 directory. Returns false instead of throwing.
 */
function appendPrompt(sessionId: string, entry: RecordedPrompt): boolean {
  try {
    const file = readIntentFile(sessionId);
    file.prompts = [...file.prompts, entry].slice(-MAX_RECORDED_PROMPTS);
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = intentFile(sessionId);
    const isNew = !fileExists(target);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, target);
    // Once per session, not per prompt: sweep the files no read can use.
    if (isNew) pruneExpiredSessions(entry.at);
    return true;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const SESSION_FILE_RE = /^[A-Za-z0-9._-]{1,128}\.json(?:\.\d+\.tmp)?$/;

/**
 * Delete session files last written longer ago than the intent window. A
 * file's mtime is its newest prompt's, so every prompt in such a file has
 * expired and no read would return any of it: removing it loses nothing and
 * keeps one-file-per-session from growing without bound.
 */
export function pruneExpiredSessions(now: number = Date.now()): number {
  let removed = 0;
  try {
    const dir = sessionsDir();
    for (const name of readdirSync(dir)) {
      if (!SESSION_FILE_RE.test(name)) continue;
      const path = resolve(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs > INTENT_MAX_AGE_MS) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // Raced with another writer or already gone: nothing to do.
      }
    }
  } catch {
    // No directory yet.
  }
  return removed;
}

/** Record a human prompt. Never throws: losing intent only means no override. */
export function recordUserPrompt(sessionId: string | undefined, prompt: unknown, now: number = Date.now()): boolean {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return false;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false;
  try {
    const text = redactSecrets(capHeadTail(prompt.trim(), MAX_USER_MESSAGE_CHARS).text).text;
    return appendPrompt(sessionId, { at: now, text });
  } catch {
    return false;
  }
}

/** The session's unexpired prompts, oldest first. Tolerates a hand-edited file. */
function livePrompts(sessionId: string | undefined, now: number): RecordedPrompt[] {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return [];
  return readIntentFile(sessionId).prompts.filter(
    (p) =>
      typeof p?.text === "string" &&
      typeof p.at === "number" &&
      now - p.at <= INTENT_MAX_AGE_MS &&
      p.at - now <= MAX_CLOCK_SKEW_MS,
  );
}

/** Recent human prompts for a session, oldest first. */
export function readUserIntent(sessionId: string | undefined, now: number = Date.now()): string[] {
  return livePrompts(sessionId, now).map((p) => p.text);
}

// ── Transcript replay ────────────────────────────────────────────────────────

/** Harness-generated user entries: slash-command echoes, caveats, notifications. */
const NON_HUMAN_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification>",
  "<system-reminder>",
  "[Request interrupted",
];

function stripHarnessMarkup(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted content]")
    .trim();
}

/**
 * The human-typed text of a transcript entry, or null if the entry is not a
 * human message. Slash commands count only through their typed arguments.
 */
export function humanMessageText(entry: unknown): string | null {
  const e = entry as {
    type?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    message?: { role?: string; content?: unknown };
  };
  if (e?.type !== "user" || e.isMeta || e.isSidechain) return null;
  const content = e.message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((b) => (b as { type?: string })?.type === "tool_result")) return null;
    text = content
      .filter((b) => (b as { type?: string })?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  } else {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("<command-name>")) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim();
    return args ? args : null;
  }
  if (NON_HUMAN_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  const cleaned = stripHarnessMarkup(trimmed);
  return cleaned.length > 0 ? cleaned : null;
}

// ── Harness-written text (intent mode v1) ────────────────────────────────────

const CONTINUATION_PREFIX = "This session is being continued from a previous conversation";
const IDE_CONTEXT_PREFIX = "# Context from my IDE setup:";
const IDE_REQUEST_HEADING = "## My request for Codex:";

/**
 * The part of one "user" turn the human actually typed, or null when none of
 * it is theirs.
 *
 * Harnesses deliver more than the human's words in a user turn, and every
 * extra is written by something other than the human: Codex's IDE extension
 * prepends the active file and open tabs, Claude Code files its
 * session-continuation summary as a user turn, reminders arrive in
 * `<system-reminder>` blocks, and a slash command carries the command's own
 * instructions. The task is what the human typed, so only that is kept: a
 * slash command counts as the command and arguments they typed, never the
 * body the harness expanded it into.
 */
export function cleanHumanTurn(raw: string): string | null {
  // Reminders first: one can precede the human's words in the same turn, and
  // a turn that merely starts with a reminder is not therefore machine-written.
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return null;
  if (text.startsWith(CONTINUATION_PREFIX)) return null;
  if (NON_HUMAN_PREFIXES.some((p) => text.startsWith(p))) return null;
  if (text.startsWith(IDE_CONTEXT_PREFIX)) {
    const at = text.lastIndexOf(IDE_REQUEST_HEADING);
    if (at < 0) return null;
    text = text.slice(at + IDE_REQUEST_HEADING.length).trim();
  }
  if (/^<command-(?:name|message)>/.test(text)) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? "";
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    const typed = `${name} ${args}`.trim();
    return typed.length > 0 ? typed : null;
  }
  text = text
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, "[pasted by the human]\n$1\n[end of pasted text]")
    .trim();
  return text.length > 0 ? text : null;
}

/** Every human turn cleaned, harness-only turns dropped, order kept. */
export function cleanUserSaid(userSaid: ReadonlyArray<string>): string[] {
  return userSaid.map(cleanHumanTurn).filter((t): t is string => t !== null);
}

/** Text blocks of a content array, in every spelling the harnesses use. */
function textOfContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => {
      const type = (b as { type?: string })?.type;
      return (type === "text" || type === "Text" || type === "output_text") && typeof (b as { text?: unknown }).text === "string";
    })
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * The visible text of an assistant transcript entry, or null. Recognises the
 * transcript formats of the harnesses whose prompts are recorded:
 *
 * - Claude Code: `{type:"assistant", message:{content:[{type:"text"}…]}}`,
 *   skipping sidechains and the harness's own `<synthetic>` / API-error
 *   entries, which the model never wrote.
 * - Codex rollouts: `event_msg` `agent_message` (≤ 0.153), `event_msg`
 *   `item_completed` with an `AgentMessage` item (0.154+), and the
 *   `response_item` assistant message that accompanies either.
 * - Pi, Factory and OpenClaw: `{type:"message", message:{role:"assistant"}}`.
 * - Cursor agent transcripts: `{role:"assistant", message:{content}}`.
 * - Copilot `events.jsonl`: `{type:"assistant.message", data:{content}}`.
 */
export function agentMessageText(entry: unknown): string | null {
  const e = entry as {
    type?: string;
    role?: string;
    isSidechain?: boolean;
    isApiErrorMessage?: boolean;
    message?: { role?: string; model?: string; content?: unknown };
    payload?: { type?: string; role?: string; message?: unknown; content?: unknown; item?: { type?: string; content?: unknown } };
    data?: { content?: unknown };
  };
  if (!e || typeof e !== "object") return null;
  // Codex: the clean agent message is an event, like the human's.
  if (e.type === "event_msg" && e.payload?.type === "agent_message" && typeof e.payload.message === "string") {
    return e.payload.message.trim() || null;
  }
  if (e.type === "event_msg" && e.payload?.type === "item_completed" && e.payload.item?.type === "AgentMessage") {
    return textOfContent(e.payload.item.content);
  }
  if (e.type === "response_item" && e.payload?.type === "message" && e.payload.role === "assistant") {
    return textOfContent(e.payload.content);
  }
  if (e.type === "assistant.message") return textOfContent(e.data?.content);
  if (e.type === "message" && e.message?.role === "assistant") return textOfContent(e.message.content);
  if (e.type === undefined && e.role === "assistant") return textOfContent(e.message?.content);
  if (e.type !== "assistant" || e.isSidechain) return null;
  if (e.isApiErrorMessage === true || e.message?.model === "<synthetic>") return null;
  return textOfContent(e.message?.content);
}

// ── Live capture (T4) ────────────────────────────────────────────────────────

/**
 * Where each harness delivers what the human typed. The source of truth for
 * docs/reference/jev-intent.mdx (a test holds the two together).
 *
 * - `nativeEvent`: the harness's own name for its prompt-submit event, which
 *   the handler canonicalizes to `UserPromptSubmit`; null when there is none.
 * - `field`: the payload field carrying the text after `normalizeCliPayload`.
 * - `capture`: `"yes"` records every prompt the harness does not itself mark
 *   as non-human; `"gated"` records only a prompt the payload positively marks
 *   as typed by the owning human; `"no"` never records.
 */
export interface PromptChannel {
  nativeEvent: string | null;
  field: string | null;
  capture: "yes" | "gated" | "no";
}

export const PROMPT_CHANNELS: Readonly<Record<IntegrationType, PromptChannel>> = {
  claude: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  codex: { nativeEvent: "user_prompt_submit", field: "prompt", capture: "yes" },
  copilot: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  cursor: { nativeEvent: "beforeSubmitPrompt", field: "prompt", capture: "yes" },
  // message.updated carries no text in current OpenCode (the Message has no
  // parts), fires again on every update of the same message, and fires for
  // task-tool child sessions and for failproofai's own instruct re-prompts.
  opencode: { nativeEvent: "message.updated", field: "prompt", capture: "no" },
  pi: { nativeEvent: "input", field: "prompt", capture: "yes" },
  // pre_llm_call is handled inside the native plugin; nothing reaches the handler.
  hermes: { nativeEvent: null, field: null, capture: "no" },
  // Heartbeat, cron, memory and inter-session runs fire before_agent_run too.
  openclaw: { nativeEvent: "before_agent_run", field: "prompt", capture: "gated" },
  factory: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  devin: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  // PreInvocation fires before every model call, carries no text, and hooks
  // can inject userMessage steps into the same conversation.
  antigravity: { nativeEvent: "PreInvocation", field: null, capture: "no" },
  goose: { nativeEvent: "UserPromptSubmit", field: "message", capture: "yes" },
};

/** What T3 passes from the handler for every canonical `UserPromptSubmit`. */
export interface CaptureEvent {
  /** Canonical event type; anything but `UserPromptSubmit` is ignored. */
  eventType: string;
  sessionId?: string;
  /** The payload's `prompt` field. Used only when `payload` is absent. */
  prompt?: unknown;
  transcriptPath?: string;
  cli: string;
  /**
   * The stdin payload after `normalizeCliPayload`. Optional, but without it a
   * harness whose text is not in `prompt` (Goose) records nothing, and the
   * human-origin markers some harnesses carry cannot be checked, so a gated
   * harness (OpenClaw) records nothing either.
   */
  payload?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function isKnownCli(cli: string): cli is IntegrationType {
  return Object.prototype.hasOwnProperty.call(PROMPT_CHANNELS, cli);
}

/**
 * The raw prompt text of a prompt-submit event if a human typed it, else null.
 * Each rejection below is a way a harness delivers text through this event
 * that no human typed.
 */
function humanPromptText(ev: CaptureEvent): string | null {
  if (!isKnownCli(ev.cli)) return null;
  const channel = PROMPT_CHANNELS[ev.cli];
  if (channel.capture === "no" || channel.field === null) return null;
  const payload = ev.payload;
  const raw = payload ? payload[channel.field] : ev.prompt;
  if (typeof raw !== "string") return null;

  switch (ev.cli) {
    case "claude":
      // agent_id is set only when the hook fires inside a subagent, whose
      // "prompt" the parent agent wrote.
      if (str(payload?.agent_id)) return null;
      break;
    case "codex":
      if (codexRolloutIsSubagent(ev.transcriptPath)) return null;
      break;
    case "pi": {
      // Pi's InputEvent.source is "interactive" | "rpc" | "extension"; the
      // last is another extension calling sendUserMessage(). The shim does
      // not forward it today, so this applies once it does.
      const source = str(payload?.input_source) ?? str(payload?.source);
      if (source === "extension") return null;
      break;
    }
    case "openclaw": {
      // OpenClaw documents that an absent classification "does not establish
      // human origin", so a prompt counts only when the run was triggered by
      // a user message, from an external user, who is the owner.
      const meta = obj(payload?.openclaw);
      if (!meta || meta.trigger !== "user") return null;
      const provenance = obj(meta.inputProvenance)?.kind;
      if (provenance !== undefined && provenance !== "external_user") return null;
      if (meta.senderIsOwner === false) return null;
      break;
    }
    case "cursor": {
      // Cursor's own transcripts wrap a query in <user_query>; accept that
      // form too if it ever reaches the hook.
      const inner = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw)?.[1];
      if (inner !== undefined) return inner;
      break;
    }
  }
  return raw;
}

/**
 * Cap to at most `max` characters INCLUDING the omission marker, so the
 * envelope's own cap (the same `MAX_USER_MESSAGE_CHARS`) never fires again on
 * a stored message and flags the whole request as truncated.
 */
function capWithin(text: string, max: number): string {
  if (text.length <= max) return text;
  let budget = max;
  for (let i = 0; i < 4; i++) {
    const capped = capHeadTail(text, budget).text;
    if (capped.length <= max) return capped;
    budget -= capped.length - max;
  }
  return capHeadTail(text, budget).text.slice(0, max);
}

/**
 * Redact, then cap. Redacting first means the final cut can never leave half
 * a secret the patterns no longer match. A generous pre-cap bounds what the
 * redaction regexes have to scan (a pasted log can be megabytes); its cut
 * points lie far outside the head and tail the final cap keeps, so a secret
 * it splits never reaches the stored text.
 */
function storable(text: string): string {
  const bounded = capHeadTail(text, MAX_USER_MESSAGE_CHARS * 8).text;
  return capWithin(redactSecrets(bounded).text, MAX_USER_MESSAGE_CHARS);
}

// ── Transcript snapshot ──────────────────────────────────────────────────────

const TAIL_CHUNK_BYTES = 256 * 1024;
/** The furthest back from the end a snapshot will look. */
export const TRANSCRIPT_TAIL_MAX_BYTES = 4 * 1024 * 1024;
/** Only lines containing one of these can hold an agent message. */
const AGENT_LINE_HINTS = ['"assistant"', '"agent_message"', '"AgentMessage"', '"assistant.message"'];

function readTranscriptPath(path: string | undefined): string | null {
  // Virtual paths (opencode-db://, devin-db://, goose-db://) are SQLite
  // sessions, not files.
  if (!path || path.includes("://")) return null;
  return path;
}

function agentTextOfLine(line: Buffer): string | null {
  if (line.length === 0) return null;
  if (!AGENT_LINE_HINTS.some((h) => line.includes(h))) return null;
  try {
    return agentMessageText(JSON.parse(line.toString("utf8")));
  } catch {
    return null;
  }
}

/**
 * The agent's last visible message in a transcript (JSONL of any format
 * `agentMessageText` knows), reading backwards from the end in chunks and at
 * most `TRANSCRIPT_TAIL_MAX_BYTES`. Null when there is no transcript file, no
 * such message within reach, or anything goes wrong. Only a regular file is
 * opened, so a path naming a FIFO or a device cannot stall a hook.
 */
export function lastAgentMessage(transcriptPath: string | undefined, maxBytes: number = TRANSCRIPT_TAIL_MAX_BYTES): string | null {
  const path = readTranscriptPath(transcriptPath);
  if (!path) return null;
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    fd = openSync(path, "r");
    let end = st.size;
    let consumed = 0;
    // Bytes of a line that started before the chunk just read; lines are
    // split on the 0x0A byte, which never occurs inside a UTF-8 sequence, so
    // a multi-byte character across a chunk boundary survives intact.
    let partial: Buffer = Buffer.alloc(0);
    while (end > 0 && consumed < maxBytes) {
      const len = Math.min(TAIL_CHUNK_BYTES, end, maxBytes - consumed);
      const start = end - len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, start);
      consumed += len;
      end = start;
      const buf = partial.length > 0 ? Buffer.concat([chunk, partial]) : chunk;
      let lineEnd = buf.length;
      while (lineEnd > 0) {
        const nl = buf.lastIndexOf(0x0a, lineEnd - 1);
        if (nl < 0) break;
        const found = agentTextOfLine(buf.subarray(nl + 1, lineEnd));
        if (found !== null) return found;
        lineEnd = nl;
      }
      if (start === 0) return agentTextOfLine(buf.subarray(0, lineEnd));
      partial = Buffer.from(buf.subarray(0, lineEnd));
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do.
      }
    }
  }
}

/**
 * Whether a Codex rollout belongs to a sub-agent thread, whose prompts the
 * parent agent wrote. Codex's `SessionSource` serializes the sub-agent variant
 * as an object (`{"subagent": …}`) where every human-driven source is a plain
 * string (`cli`, `vscode`, `exec`, …).
 */
function codexRolloutIsSubagent(transcriptPath: string | undefined): boolean {
  const path = readTranscriptPath(transcriptPath);
  if (!path) return false;
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    fd = openSync(path, "r");
    const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
    readSync(fd, head, 0, head.length, 0);
    const nl = head.indexOf(0x0a);
    const first = JSON.parse(head.subarray(0, nl < 0 ? head.length : nl).toString("utf8")) as {
      type?: string;
      payload?: { source?: unknown; thread_source?: unknown };
    };
    if (first?.type !== "session_meta") return false;
    const source = first.payload?.source;
    if (source !== null && typeof source === "object") return true;
    const marks = [source, first.payload?.thread_source].filter((s): s is string => typeof s === "string");
    return marks.some((s) => /sub[-_ ]?agent/i.test(s));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do.
      }
    }
  }
}

/**
 * Record what the human just typed, from a prompt-submit hook event, with the
 * agent message it replies to. Never throws.
 *
 * Ignored: any event but `UserPromptSubmit`; harnesses with no human prompt
 * channel (see `PROMPT_CHANNELS`); prompts a harness marks as not typed by
 * the human; turns that are entirely harness text (`cleanHumanTurn` → null);
 * session ids that could name a path outside the state directory.
 */
export function captureIntent(ev: CaptureEvent, now: number = Date.now()): void {
  try {
    if (ev?.eventType !== "UserPromptSubmit") return;
    if (!ev.sessionId || !SESSION_ID_RE.test(ev.sessionId)) return;
    const raw = humanPromptText(ev);
    if (raw === null) return;
    const cleaned = cleanHumanTurn(raw);
    if (cleaned === null) return;
    const agent = lastAgentMessage(ev.transcriptPath);
    appendPrompt(ev.sessionId, {
      at: now,
      text: storable(cleaned),
      agent: agent === null ? null : storable(agent),
    });
  } catch {
    // Losing intent only means Jev judges without it.
  }
}

/**
 * What the human asked for recently (oldest first, at most
 * `MAX_RECORDED_PROMPTS`, none older than `INTENT_MAX_AGE_MS`) and the agent
 * message their latest prompt replied to — null when that prompt had none or
 * nothing is recorded.
 */
export function readIntent(
  sessionId?: string,
  now: number = Date.now(),
): { userSaid: string[]; agentLastMessage: string | null } {
  const prompts = livePrompts(sessionId, now);
  const latest = prompts[prompts.length - 1];
  const agent = latest && typeof latest.agent === "string" && latest.agent.length > 0 ? latest.agent : null;
  return { userSaid: prompts.map((p) => p.text), agentLastMessage: agent };
}
