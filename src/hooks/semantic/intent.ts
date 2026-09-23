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
 *   for text no human typed, and those are never recorded. Where the only
 *   thing separating a typed prompt from one the agent arranged is the
 *   harness's own transcript, the prompt counts only while that evidence can
 *   still be read — a file the agent can truncate, replace or hide must never
 *   read as "the human said this" once it stops being readable (see
 *   `transcriptVouchesForPrompt` and `codexRolloutOrigin`).
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
import { MAX_USER_MESSAGE_CHARS, redactSecrets } from "./envelope";

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

/**
 * Record a prompt as given: no harness check and no cleaning (`captureIntent`
 * does both). Redacted before it is capped, like everything stored here, so a
 * cut can never leave half a secret the patterns no longer match. Never
 * throws: losing intent only means no override.
 */
export function recordUserPrompt(sessionId: string | undefined, prompt: unknown, now: number = Date.now()): boolean {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return false;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false;
  try {
    return appendPrompt(sessionId, { at: now, text: storable(prompt.trim()) });
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

/**
 * Harness-generated user entries: slash-command echoes, caveats,
 * notifications — and failproofai's own words. Cursor submits a Stop gate's
 * `followup_message` as the next user message, and Copilot, Devin and
 * OpenClaw feed a Stop block's reason back into the next turn, so what
 * policy-evaluator.ts wrote can arrive looking like a prompt.
 *
 * Also the wrappers Claude Code puts around a user-role turn that another
 * agent or session wrote (a peer session, a teammate, a coordinator, a
 * channel): its own classifier calls those "never user intent".
 */
const NON_HUMAN_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification>",
  "<system-reminder>",
  "[Request interrupted",
  "MANDATORY ACTION REQUIRED from failproofai",
  "Instruction from failproofai:",
  "<cross-session-message",
  "<teammate-message",
  "<agent-message",
  "<coordinator-relay",
  "<channel source=",
];

// ── Tag blocks, in linear time ───────────────────────────────────────────────
//
// A prompt can be megabytes of pasted text, and it is cleaned on the hook path
// before anything caps it. A lazy regex such as /<x>[\s\S]*?<\/x>/g rescans to
// the end of the text from every opener that has no closer, so its cost grows
// with the square of the number of unclosed openers: 1 MB of them took over
// 20 s, long enough for the daemon client to give up and deny every hook on
// the machine. These helpers find exactly the regex's matches with indexOf:
// once an opener has no closer after it, no later opener can have one either,
// so the scan stops there.

/**
 * Replace every block the lazy regex `/<tag>([\s\S]*?)<\/tag>/g` matches —
 * with `attributes`, `/<tag[^>]*>([\s\S]*?)<\/tag[^>]*>/g` — by
 * `replace(inner)`. Same matches, same order, linear time.
 */
function replaceTagBlocks(text: string, tag: string, replace: (inner: string) => string, attributes = false): string {
  const open = attributes ? `<${tag}` : `<${tag}>`;
  const close = attributes ? `</${tag}` : `</${tag}>`;
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(open, from);
    if (at < 0) break;
    let inner = at + open.length;
    if (attributes) {
      const gt = text.indexOf(">", inner);
      if (gt < 0) break;
      inner = gt + 1;
    }
    const closeAt = text.indexOf(close, inner);
    if (closeAt < 0) break;
    let end = closeAt + close.length;
    if (attributes) {
      const gt = text.indexOf(">", end);
      if (gt < 0) break;
      end = gt + 1;
    }
    out += text.slice(from, at) + replace(text.slice(inner, closeAt));
    from = end;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** The inner text of the first block `/<tag>([\s\S]*?)<\/tag>/` matches, in linear time. */
function firstTagContent(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const at = text.indexOf(open);
  if (at < 0) return undefined;
  const closeAt = text.indexOf(`</${tag}>`, at + open.length);
  return closeAt < 0 ? undefined : text.slice(at + open.length, closeAt);
}

function stripHarnessMarkup(text: string): string {
  const noReminders = replaceTagBlocks(text, "system-reminder", () => "");
  return replaceTagBlocks(noReminders, "pasted_content", () => "[pasted content]", true).trim();
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
    const args = firstTagContent(trimmed, "command-args")?.trim();
    return args ? args : null;
  }
  if (NON_HUMAN_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  const cleaned = stripHarnessMarkup(trimmed);
  return cleaned.length > 0 ? cleaned : null;
}

// ── Harness-written text (intent mode v1) ────────────────────────────────────

const CONTINUATION_PREFIX = "This session is being continued from a previous conversation";

/**
 * How the Codex IDE extension starts a prompt it builds around the human's
 * words: every section it can put first (the extension's own prompt builder,
 * openai.chatgpt 26.803, and the shapes seen in codex_vscode rollouts). The
 * sections carry the active file, open tabs, text selected in the editor,
 * diff and browser comments, files and apps mentioned, PR checks, earlier
 * conversations: all of it is file, repo or tool text that the agent or the
 * repo can write, and none of it is what the human typed.
 */
const IDE_CONTEXT_OPENERS = [
  "# Context from my IDE setup:",
  "# Selected text:",
  "# Files mentioned by the user:",
  "# Applications mentioned by the user:",
  "# Response annotations:",
  "# Diff comments:",
  "# Browser comments:",
  "# MCP app context:",
  "# Failing PR checks:",
  "# Pull request merge conflict:",
  "# Chrome tabs:",
  "# In app browser:",
  '<in-app-browser-context source="ambient-ui-state">',
  "## Prior conversation with Codex:",
  "## Referenced chats with Codex:",
  "## Referenced ChatGPT conversation:",
  "## Code review guidelines:",
  "## Pull request fix:",
  "## Pull request merge task:",
  "## Auto resolve merge:",
  "The attached pasted text file(s) contain the user's request.",
];
/**
 * The heading the extension puts right before the human's words, in both
 * spellings: older builds wrote "for Codex", 26.803 writes `## My request:`.
 * The extension itself shows the text after the last one as the message.
 */
const IDE_REQUEST_HEADINGS = ["## My request for Codex:", "## My request:"];

/**
 * The human's request from a prompt the Codex IDE extension built, or null
 * when there is none: the text after the LAST request heading, since the
 * human's words come last and a selection above them can contain the heading.
 */
function ideRequest(text: string): string | null {
  let at = -1;
  let heading = "";
  for (const h of IDE_REQUEST_HEADINGS) {
    const i = text.lastIndexOf(h);
    if (i > at) {
      at = i;
      heading = h;
    }
  }
  return at < 0 ? null : text.slice(at + heading.length).trim();
}

/**
 * Whether a turn is text a harness, a tool or another agent wrote: the
 * session-continuation summary, or anything opening with a
 * `NON_HUMAN_PREFIXES` marker (failproofai's own words among them).
 *
 * Asked of a whole turn, and again of every span pulled out of one — the text
 * after a Codex IDE prompt's request heading is a span the repo, an extension
 * or a Stop gate's follow-up can land in, so it has to pass the same test the
 * turn did rather than inherit its answer.
 */
function harnessAuthored(text: string): boolean {
  return text.startsWith(CONTINUATION_PREFIX) || NON_HUMAN_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * The part of one "user" turn the human actually typed, or null when none of
 * it is theirs.
 *
 * Harnesses deliver more than the human's words in a user turn, and every
 * extra is written by something other than the human: Codex's IDE extension
 * puts the active file, open tabs, selected text and more (see
 * `IDE_CONTEXT_OPENERS`) before the `## My request…:` heading that introduces
 * the human's words, Claude Code files its
 * session-continuation summary as a user turn, reminders arrive in
 * `<system-reminder>` blocks, and a slash command carries the command's own
 * instructions. The task is what the human typed, so only that is kept: a
 * slash command counts as the command and arguments they typed, never the
 * body the harness expanded it into.
 */
export function cleanHumanTurn(raw: string): string | null {
  // Reminders first: one can precede the human's words in the same turn, and
  // a turn that merely starts with a reminder is not therefore machine-written.
  // Every step is linear in the prompt's length (see replaceTagBlocks): this
  // runs on the hook path, on the whole prompt, before anything caps it.
  let text = replaceTagBlocks(raw, "system-reminder", () => "").trim();
  if (!text) return null;
  if (harnessAuthored(text)) return null;
  // Unwrap an extension-built prompt, then judge what came out exactly as the
  // turn itself was judged. The request is whatever follows the last heading,
  // and the extension appends its sections around text it did not write: a
  // Stop gate's follow-up, a continuation summary, a peer session's message or
  // another context section can all land there. The loop ends on its second
  // pass at the latest — `ideRequest` takes the LAST heading, so no request
  // heading is left in what it returns — and each pass shortens the text.
  while (IDE_CONTEXT_OPENERS.some((p) => text.startsWith(p))) {
    const request = ideRequest(text);
    if (request === null || harnessAuthored(request)) return null;
    text = request;
  }
  if (/^<command-(?:name|message)>/.test(text)) {
    const name = firstTagContent(text, "command-name")?.trim() ?? "";
    const args = firstTagContent(text, "command-args")?.trim() ?? "";
    const typed = `${name} ${args}`.trim();
    return typed.length > 0 ? typed : null;
  }
  text = replaceTagBlocks(text, "pasted_content", (inner) => `[pasted by the human]\n${inner}\n[end of pasted text]`, true).trim();
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
  // UserPromptSubmit also fires for prompts the model scheduled for itself
  // (CronCreate, ScheduleWakeup, /loop), with a payload identical to a typed
  // one. Only the transcript tells them apart: see `scheduledPromptVerdict`
  // and `transcriptVouchesForPrompt`.
  claude: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  codex: { nativeEvent: "user_prompt_submit", field: "prompt", capture: "yes" },
  copilot: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  cursor: { nativeEvent: "beforeSubmitPrompt", field: "prompt", capture: "yes" },
  // message.updated carries no text in current OpenCode (the Message has no
  // parts), fires again on every update of the same message, and fires for
  // task-tool child sessions and for failproofai's own instruct re-prompts.
  opencode: { nativeEvent: "message.updated", field: "prompt", capture: "no" },
  // Another extension's sendUserMessage() fires `input` too, and its text can
  // be model-written or repo-derived: only a source the bridge forwards as
  // typed (or sent by an RPC client) counts. See `PI_HUMAN_SOURCES`.
  pi: { nativeEvent: "input", field: "prompt", capture: "gated" },
  // pre_llm_call is handled inside the native plugin; nothing reaches the handler.
  hermes: { nativeEvent: null, field: null, capture: "no" },
  // Heartbeat, cron, memory and inter-session runs fire before_agent_run too.
  openclaw: { nativeEvent: "before_agent_run", field: "prompt", capture: "gated" },
  // Claude-shaped payloads: the same transcript cross-check runs for Factory.
  // Devin's transcript is not JSONL, so there is nothing to cross-check.
  factory: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  devin: { nativeEvent: "UserPromptSubmit", field: "prompt", capture: "yes" },
  // PreInvocation fires before every model call, carries no text, and hooks
  // can inject userMessage steps into the same conversation.
  antigravity: { nativeEvent: "PreInvocation", field: null, capture: "no" },
  goose: { nativeEvent: "UserPromptSubmit", field: "message", capture: "yes" },
};

/**
 * What the handler (T3) passes for every canonical `UserPromptSubmit`:
 * `captureIntent({ eventType, sessionId, transcriptPath, cli, payload: parsed })`.
 *
 * Pass the whole payload, not just its `prompt`. The text is in a different
 * field on some harnesses (Goose sends `message`), and the marks that tell a
 * human's prompt from one a subagent, an extension or a scheduled run sent
 * are elsewhere in the payload.
 *
 * The first draft of this contract (JEV-BUILD-PLAN §7) passed `prompt` and no
 * payload. That shape still compiles and is still honoured where it loses
 * nothing: for a harness that applies no origin check (`NO_ORIGIN_CHECK`), a
 * `prompt` given without a payload is read as the payload `{ prompt }`. Every
 * harness whose origin check can refuse a prompt today records nothing without
 * the payload (fail closed): its checks were written against the payload the
 * handler has, and a caller that leaves it out is not running them.
 */
export interface CaptureEvent {
  /** Canonical event type; anything but `UserPromptSubmit` is ignored. */
  eventType: string;
  sessionId?: string;
  transcriptPath?: string;
  cli: string;
  /** The stdin payload after `normalizeCliPayload`: the handler's `parsed`. */
  payload: Record<string, unknown>;
  /** Ignored: with a payload, the text is read from the payload. */
  prompt?: unknown;
}

/**
 * The §7 draft's shape: the prompt and no payload. Recorded only for a
 * harness in `NO_ORIGIN_CHECK`; nothing is recorded for any other.
 */
export interface PromptOnlyCaptureEvent {
  eventType: string;
  sessionId?: string;
  transcriptPath?: string;
  cli: string;
  prompt?: unknown;
  payload?: undefined;
}

/**
 * Harnesses whose prompt is recorded from its text alone: no mark in the
 * payload or the transcript is *needed* to tell a human's prompt from anyone
 * else's. Goose also needs none, but its text is in `message`, so a bare
 * `prompt` is not its text.
 *
 * Devin is here although the switch below reads `agent_id` on its payload:
 * that check is defence in depth against a future Devin build (its payloads
 * are Claude-shaped and it has subagents), not a mark today's Devin sets, so
 * a caller that passes no payload loses nothing by it.
 */
const NO_ORIGIN_CHECK: ReadonlySet<IntegrationType> = new Set<IntegrationType>(["copilot", "cursor", "devin"]);

/**
 * Pi's `InputEvent.source` values that count as the operator's own input:
 * typed in Pi's editor (`pi -p` reports this too), or sent by the program
 * driving Pi in RPC mode. Not `extension`: another extension's
 * `sendUserMessage()`, whose text can be model-written or repo-derived.
 */
const PI_HUMAN_SOURCES: ReadonlySet<string> = new Set(["interactive", "rpc"]);

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
function humanPromptText(ev: CaptureEvent | PromptOnlyCaptureEvent): string | null {
  if (!isKnownCli(ev.cli)) return null;
  const channel = PROMPT_CHANNELS[ev.cli];
  if (channel.capture === "no" || channel.field === null) return null;
  // No payload, no way to run the checks below: record nothing (fail closed),
  // unless the harness has no checks to run (see `CaptureEvent`).
  const payload = obj(ev.payload) ?? (NO_ORIGIN_CHECK.has(ev.cli) ? { prompt: ev.prompt } : undefined);
  if (!payload) return null;
  const raw = payload[channel.field];
  if (typeof raw !== "string") return null;

  switch (ev.cli) {
    // The three harnesses whose payload is Claude-shaped, and which all ship a
    // SubagentStop event, so all three have subagents.
    case "claude":
    case "factory":
    case "devin":
      // Defence in depth only. Claude Code sets agent_id on hook payloads
      // fired inside a subagent, but not on UserPromptSubmit (2.1.278 builds
      // that payload without it), so today this never fires; it is here in
      // case a later version — of any of the three — starts marking the event.
      if (str(payload.agent_id)) return null;
      // Devin's transcript is one JSON document, not JSONL: there are no turns
      // to read, so only the two JSONL harnesses run the scheduled-prompt check.
      if (ev.cli !== "devin" && !transcriptVouchesForPrompt(ev, raw)) return null;
      break;
    case "codex":
      // Codex's origin evidence is its rollout's session_meta, which Codex
      // writes when the session starts — before any prompt — so a Codex
      // session always has it. Anything else (no rollout found, a rollout
      // that is not a readable regular file, an empty one, a first line that
      // is not session_meta, one with no source mark at all) is the evidence
      // missing, not a human answering: record nothing, the same way pi and
      // openclaw below treat a missing mark. A sub-agent thread's prompts are
      // written by the parent agent, and recording one would let the agent
      // clear a reviewable policy with words it wrote itself.
      if (codexRolloutOrigin(ev.transcriptPath) !== "human") return null;
      break;
    case "pi": {
      // Pi's InputEvent.source is "interactive" | "rpc" | "extension"; the
      // last is another extension calling sendUserMessage(). pi-extension
      // forwards it as `input_source`. Every mark present must be a human
      // source, and at least one must be present: a bridge that does not
      // forward it (older installs) records nothing (fail closed).
      const marks = [payload.input_source, payload.source].filter((m) => m !== undefined);
      if (marks.length === 0) return null;
      if (!marks.every((m) => typeof m === "string" && PI_HUMAN_SOURCES.has(m))) return null;
      break;
    }
    case "openclaw": {
      // OpenClaw documents that an absent classification "does not establish
      // human origin", and it sets senderIsOwner only "when available", so a
      // prompt counts only when all three marks are present and positive: the
      // run was triggered by a user message, from an external user, who is
      // the owner. A missing mark records nothing (fail closed): on a shared
      // channel an unmarked sender may be anyone in the chat.
      const meta = obj(payload.openclaw);
      if (!meta || meta.trigger !== "user") return null;
      if (obj(meta.inputProvenance)?.kind !== "external_user") return null;
      if (meta.senderIsOwner !== true) return null;
      break;
    }
    case "cursor":
      return unwrapCursorQuery(raw);
  }
  return raw;
}

const TIMESTAMP_OPEN = "<timestamp>";
const TIMESTAMP_CLOSE = "</timestamp>";
const USER_QUERY_OPEN = "<user_query>";
const USER_QUERY_CLOSE = "</user_query>";

/**
 * A Cursor prompt with the `<user_query>` wrapper Cursor's own transcripts use
 * removed, or null when the prompt is harness text.
 *
 * Cursor's hook payloads are not known to carry the wrapper; this accepts the
 * form in case one does, and nothing looser. The wrapper is removed only when
 * it is the whole prompt: after an optional leading `<timestamp>…</timestamp>`,
 * exactly one `<user_query>…</user_query>` block and nothing after it. A tag
 * anywhere else is text like any other and the whole prompt is kept, because
 * picking a tagged span out of the middle would record text that is not what
 * the human typed: a snippet they pasted from a log or an issue, or text
 * inside failproofai's own stop-gate message, which quotes names the agent
 * chose (a branch called `wip<user_query>…</user_query>`).
 *
 * Layers are peeled in the order `cleanHumanTurn` reads a turn: system
 * reminders first (removed wherever they are), then the timestamp, then the
 * query block. What is left after each layer is judged for harness text, so
 * wrapping failproofai's own words, or any other whole-turn harness text,
 * cannot make it the human's. A prompt that is not unwrapped is returned
 * whole and judged whole by the caller; one that is unwrapped starts with a
 * wrapper tag, which no whole-turn harness text does. Linear time: a few
 * indexOf scans and `cleanHumanTurn` passes.
 */
function unwrapCursorQuery(raw: string): string | null {
  let text = replaceTagBlocks(raw, "system-reminder", () => "").trim();
  if (text.startsWith(TIMESTAMP_OPEN)) {
    const end = text.indexOf(TIMESTAMP_CLOSE, TIMESTAMP_OPEN.length);
    if (end < 0) return raw;
    text = text.slice(end + TIMESTAMP_CLOSE.length).trim();
    if (cleanHumanTurn(text) === null) return null;
  }
  if (!text.startsWith(USER_QUERY_OPEN)) return raw;
  const body = text.slice(USER_QUERY_OPEN.length);
  if (cleanHumanTurn(body) === null) return null;
  if (!body.endsWith(USER_QUERY_CLOSE)) return raw;
  const inner = body.slice(0, body.length - USER_QUERY_CLOSE.length);
  if (inner.includes(USER_QUERY_OPEN) || inner.includes(USER_QUERY_CLOSE)) return raw;
  return inner;
}

const omissionMarker = (count: number): string => `\n…[${count} characters omitted]…\n`;

/** `capHeadTail`'s head/tail split and marker, keeping `budget` characters of `text`. */
function cutHeadTail(text: string, budget: number): string {
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}${omissionMarker(text.length - budget)}${text.slice(text.length - tail)}`;
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
    const capped = cutHeadTail(text, budget);
    if (capped.length <= max) return capped;
    budget -= capped.length - max;
  }
  return cutHeadTail(text, budget).slice(0, max);
}

/**
 * A prefix of `head` and a suffix of `tail` around one omission marker, in at
 * most `max` characters, the marker included (see `capWithin`). The head gets
 * 60% of the room unless the tail needs less, and the tail gets the rest. The
 * marker counts `omitted` plus whatever of either piece is left out.
 */
function joinWithin(head: string, tail: string, omitted: number, max: number): string {
  // Room for the text around the longest marker this can need.
  const room = Math.max(0, max - omissionMarker(omitted + head.length + tail.length).length);
  const keepTail = Math.min(tail.length, room - Math.min(head.length, Math.ceil(room * 0.6)));
  const keepHead = Math.min(head.length, room - keepTail);
  const dropped = omitted + (head.length - keepHead) + (tail.length - keepTail);
  return head.slice(0, keepHead) + omissionMarker(dropped) + tail.slice(tail.length - keepTail);
}

/**
 * The pre-cap: a bound on what the redaction regexes scan (a pasted log can be
 * megabytes, and some patterns cost the square of the length on the text they
 * scan), and far more than the final cap keeps.
 */
const PRE_CAP_CHARS = MAX_USER_MESSAGE_CHARS * 8;
/**
 * Text this close to a pre-cap cut is never stored. A secret the cut split no
 * longer matches any pattern, so its piece on our side of the cut is left
 * unredacted, and redaction elsewhere in the same piece (a long JWT becomes a
 * 14-character marker) can pull that piece into the head or tail the final
 * cap keeps.
 */
const PRE_CAP_GUARD_CHARS = 256;
/**
 * How much further a token the guard ends inside is followed, so all of a
 * long one is dropped, not just its end. Bounded so the start of a giant
 * paste with no whitespace in it can still be kept.
 */
const PRE_CAP_TOKEN_CHARS = 4_096;

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * Where the kept part of a pre-capped head ends: `PRE_CAP_GUARD_CHARS` short
 * of the cut, moved back to the start of any token that reaches into the
 * guard (up to `PRE_CAP_TOKEN_CHARS` back). A secret is almost always one
 * token, so no piece of one the cut split survives, whatever its length.
 */
function headEndClearOfCut(head: string): number {
  let end = Math.max(0, head.length - PRE_CAP_GUARD_CHARS);
  if (end > 0 && !isSpace(head[end])) {
    const floor = Math.max(0, end - PRE_CAP_TOKEN_CHARS);
    while (end > floor && !isSpace(head[end - 1])) end--;
  }
  return end;
}

/** `headEndClearOfCut` for the tail: where its kept part starts. */
function tailStartClearOfCut(tail: string): number {
  let start = Math.min(tail.length, PRE_CAP_GUARD_CHARS);
  if (start < tail.length && !isSpace(tail[start - 1])) {
    const ceiling = Math.min(tail.length, start + PRE_CAP_TOKEN_CHARS);
    while (start < ceiling && !isSpace(tail[start])) start++;
  }
  return start;
}

/**
 * Redact, then cap. Redacting first means the final cut can never leave half
 * a secret the patterns no longer match.
 *
 * A text longer than the pre-cap is redacted as two pieces, its head and its
 * tail, and the middle is never looked at. The pre-cap's cuts CAN split a
 * secret, so each piece drops the text next to its cut before the final cap
 * picks what to keep: a piece that redaction shrank to almost nothing
 * contributes almost nothing, rather than the fragment by its cut. The
 * marker counts every character left out, in the redacted text's terms.
 */
function storable(text: string): string {
  if (text.length <= PRE_CAP_CHARS) return capWithin(redactSecrets(text).text, MAX_USER_MESSAGE_CHARS);
  const headLen = Math.ceil(PRE_CAP_CHARS * 0.6);
  const tailLen = PRE_CAP_CHARS - headLen;
  const head = redactSecrets(text.slice(0, headLen)).text;
  const tail = redactSecrets(text.slice(text.length - tailLen)).text;
  const keptHead = head.slice(0, headEndClearOfCut(head));
  const keptTail = tail.slice(tailStartClearOfCut(tail));
  const omitted = head.length - keptHead.length + (text.length - headLen - tailLen) + (tail.length - keptTail.length);
  return joinWithin(keptHead, keptTail, omitted, MAX_USER_MESSAGE_CHARS);
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
 * Visit a transcript's lines from the last to the first, reading backwards
 * from the end in chunks and at most `maxBytes`, until `visit` returns true.
 * Only whole lines are visited, empty ones included. Does nothing when there
 * is no transcript file, and stops quietly if anything goes wrong. Only a
 * regular file is opened, so a path naming a FIFO or a device cannot stall a
 * hook.
 */
function visitLinesBackwards(transcriptPath: string | undefined, maxBytes: number, visit: (line: Buffer) => boolean): void {
  const path = readTranscriptPath(transcriptPath);
  if (!path) return;
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return;
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
        if (visit(buf.subarray(nl + 1, lineEnd))) return;
        lineEnd = nl;
      }
      if (start === 0) {
        visit(buf.subarray(0, lineEnd));
        return;
      }
      partial = Buffer.from(buf.subarray(0, lineEnd));
    }
    // The budget ran out. What is left in `partial` starts exactly where the
    // reading stopped; if the byte before it ends a line, it is a whole line,
    // read in full, and gets looked at like any other.
    if (end > 0 && partial.length > 0) {
      const before = Buffer.alloc(1);
      if (readSync(fd, before, 0, 1, end - 1) === 1 && before[0] === 0x0a) visit(partial);
    }
  } catch {
    // An unreadable transcript is one with nothing in it.
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
 * The agent's last visible message in a transcript (JSONL of any format
 * `agentMessageText` knows), reading backwards from the end and at most
 * `maxBytes`. Null when there is no transcript file, no such message within
 * reach, or anything goes wrong.
 */
export function lastAgentMessage(transcriptPath: string | undefined, maxBytes: number = TRANSCRIPT_TAIL_MAX_BYTES): string | null {
  let found: string | null = null;
  visitLinesBackwards(transcriptPath, maxBytes, (line) => {
    found = agentTextOfLine(line);
    return found !== null;
  });
  return found;
}

// ── Prompts the model scheduled (Claude Code) ────────────────────────────────
//
// Claude Code runs UserPromptSubmit hooks for prompts the model scheduled for
// itself — CronCreate, ScheduleWakeup and /loop fire their prompt through the
// same submit path as a typed one — and 2.1.278 builds the same payload for
// both, with no field saying where the prompt came from. The model writes
// those prompts, so recording one would let the agent put words in the
// human's mouth. The transcript is the only witness:
//
// - When a scheduled task fires, Claude Code appends a
//   `{type:"system", subtype:"scheduled_task_fire", prompt}` entry just
//   before submitting the task's prompt. `prompt` there is the task's prompt
//   with control characters and ANSI escapes removed and whitespace
//   collapsed, cut to 200 characters.
// - The model scheduled it with a tool call whose input carries the prompt
//   (`CronCreate` / `ScheduleWakeup` `input.prompt`).

/** Lines that can hold a scheduling tool call or a fire entry. */
const SCHEDULE_HINTS = ['"scheduled_task_fire"', '"prompt":'].map((h) => Buffer.from(h));
/** Lines that can hold a conversation entry (Claude Code's user/assistant, Factory's message). */
const TURN_HINTS = ['"type":"user"', '"type":"assistant"', '"type":"message"'].map((h) => Buffer.from(h));
/** Claude Code cuts a fire entry's prompt to this many characters. */
const FIRE_PROMPT_CHARS = 200;

/** Claude Code's ANSI-escape pattern, which it strips from a fire entry's prompt. */
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\u0007|\u001B\\|\u009C))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
/** Whitespace and every character Claude Code strips from a fire entry's prompt. */
const INVISIBLE_RE = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

/** Text reduced to its visible characters, so two spellings of one prompt compare equal. */
const visibleText = (text: string): string => text.replace(ANSI_RE, "").replace(INVISIBLE_RE, "");

/** The `prompt` of every tool call in an entry: Claude Code and Factory `tool_use`, Pi `toolCall`. */
function toolCallPrompts(entry: unknown): string[] {
  const content = (entry as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return [];
  const prompts: string[] = [];
  for (const block of content) {
    const b = obj(block);
    if (b?.type !== "tool_use" && b?.type !== "toolCall") continue;
    const prompt = (obj(b.input) ?? obj(b.arguments))?.prompt;
    if (typeof prompt === "string") prompts.push(prompt);
  }
  return prompts;
}

function isTurnEntry(entry: unknown): boolean {
  const type = (entry as { type?: unknown })?.type;
  return type === "user" || type === "assistant" || type === "message";
}

/**
 * What the transcript says about who wrote `raw`:
 *
 * - `"scheduled"` — the model wrote it, shown by any of:
 *   - a scheduled-task fire entry newer than every conversation entry — the
 *     prompt being submitted is the one that fire started, whatever it says;
 *   - a fire entry whose prompt is this prompt (or, cut to 200 characters, its
 *     start) — the task fired while a turn was running and its prompt waited
 *     in the queue;
 *   - a tool call whose `prompt` input is this prompt.
 * - `"typed"` — the transcript holds conversation and none of it scheduled
 *   this prompt.
 * - `"unknown"` — no conversation entry could be read at all, so the
 *   transcript says nothing either way. Not a "no": see
 *   `transcriptVouchesForPrompt`.
 *
 * Reads at most `TRANSCRIPT_TAIL_MAX_BYTES` from the end. A match that is
 * really the human typing the same words again only costs that prompt its
 * standing as intent.
 */
type ScheduleVerdict = "scheduled" | "typed" | "unknown";

function scheduledPromptVerdict(transcriptPath: string, raw: string): ScheduleVerdict {
  let typed: string | undefined;
  const visible = (): string => (typed ??= visibleText(raw));
  let turnSeen = false;
  // Any entry that parsed: the transcript is readable and holds a
  // conversation, which is what tells "nothing scheduled this" apart from
  // "nothing could be read". A turn-hinted line stops being parsed once
  // `turnSeen` is set, and by then this is already true.
  let entrySeen = false;
  let scheduled = false;
  visitLinesBackwards(transcriptPath, TRANSCRIPT_TAIL_MAX_BYTES, (line) => {
    const hinted = SCHEDULE_HINTS.some((h) => line.includes(h));
    if (!hinted && (turnSeen || !TURN_HINTS.some((h) => line.includes(h)))) return false;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = obj(JSON.parse(line.toString("utf8")));
    } catch {
      return false;
    }
    if (!entry) return false;
    if (typeof entry.type === "string") entrySeen = true;
    if (entry.type === "system" && entry.subtype === "scheduled_task_fire") {
      if (!turnSeen) return (scheduled = true);
      const fired = typeof entry.prompt === "string" ? visibleText(entry.prompt) : "";
      if (fired.length > 0) {
        const cut = (entry.prompt as string).length >= FIRE_PROMPT_CHARS - 1;
        if (cut ? visible().startsWith(fired) : visible() === fired) return (scheduled = true);
      }
      return false;
    }
    if (hinted && visible().length > 0 && toolCallPrompts(entry).some((p) => visibleText(p) === visible())) return (scheduled = true);
    if (isTurnEntry(entry)) turnSeen = true;
    return false;
  });
  return scheduled ? "scheduled" : entrySeen ? "typed" : "unknown";
}

/**
 * Whether the transcript lets this prompt count as the human's.
 *
 * The check exists because Claude Code fires `UserPromptSubmit` for prompts
 * the model scheduled for itself, with a payload identical to a typed one, so
 * an unusable transcript must not read as "nobody scheduled this". Every way
 * of making one unusable — truncating it, replacing it with a FIFO or a
 * device, `chmod 000`, moving it aside, padding it past the read budget with
 * junk — is one command in a shell the agent already has.
 *
 * Two things are NOT the agent taking the evidence away:
 *
 * - A harness that names no transcript at all. The path comes from the hook's
 *   stdin (Claude Code and droid both put it there); the agent cannot edit the
 *   payload, so a missing path is the harness saying there is nothing to
 *   cross-check, as on Devin. Codex is the opposite case — there the path is
 *   discovered on the file system, so its absence IS arrangeable, and that
 *   branch fails closed.
 * - A session's FIRST prompt. At that moment a real Claude Code transcript
 *   holds only session-start bookkeeping (`mode`, `permission-mode`,
 *   `file-history-snapshot`) or does not exist yet, so "no conversation" is
 *   what an honest transcript looks like — and a prompt the model scheduled
 *   cannot be a session's first, since scheduling one takes a turn. Believing
 *   it only there keeps `claude -p "…"` and the opening prompt of every
 *   session working; from the second prompt on, a transcript showing no
 *   conversation means the evidence was taken away, and nothing is recorded.
 */
function transcriptVouchesForPrompt(ev: CaptureEvent | PromptOnlyCaptureEvent, raw: string): boolean {
  const path = readTranscriptPath(ev.transcriptPath);
  if (!path) return true;
  switch (scheduledPromptVerdict(path, raw)) {
    case "scheduled":
      return false;
    case "typed":
      return true;
    default:
      return !sessionHasRecorded(ev.sessionId);
  }
}

/**
 * Whether this session has ever recorded a prompt: its file is written on the
 * first one and only `pruneExpiredSessions` removes it, long after every
 * prompt in it has expired. The agent cannot create or delete it — the
 * always-on self-protection guard stops it from touching failproofai's state.
 */
function sessionHasRecorded(sessionId: string | undefined): boolean {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return false;
  return fileExists(intentFile(sessionId));
}

/** A session source or thread source naming a sub-agent, however it is spelled. */
const SUBAGENT_NAME_RE = /sub[-_ ]?agent/i;
/**
 * The same rule over the raw text of a session_meta line too long to parse:
 * an object-form source, or a string source or thread source naming a
 * sub-agent.
 */
const RAW_SUBAGENT_SOURCE_RE = /"source"\s*:\s*(?:\{|"[^"]*sub[-_ ]?agent)|"thread_source"\s*:\s*"[^"]*sub[-_ ]?agent/i;
/** A string `source` or `thread_source` in a session_meta line too long to parse. */
const RAW_SOURCE_MARK_RE = /"(?:thread_)?source"\s*:\s*"/;

/**
 * Who a Codex rollout says its thread belongs to:
 *
 * - `"subagent"`: a thread whose prompts the parent agent wrote. Codex's
 *   `SessionSource` serializes the sub-agent variant as an object
 *   (`{"subagent": …}`) where every human-driven source is a plain string
 *   (`cli`, `vscode`, `exec`, …); a string source or `thread_source` naming a
 *   sub-agent counts too.
 * - `"human"`: a session_meta line carrying a source mark that names no
 *   sub-agent. Every rollout Codex writes carries one (verified on 0.131
 *   through 0.154: `source` is always present, `thread_source` sometimes).
 * - `"unknown"`: no evidence. The rollout was not found, is not a readable
 *   regular file (a FIFO, a device, `/dev/null`, a directory, mode 000), is
 *   empty, does not start with a session_meta line, or carries no source mark
 *   at all. Every one of those is a single command away for an agent holding
 *   a shell in its own sub-agent thread, so none of them may read as "human".
 */
type RolloutOrigin = "subagent" | "human" | "unknown";

function codexRolloutOrigin(transcriptPath: string | undefined): RolloutOrigin {
  const path = readTranscriptPath(transcriptPath);
  if (!path) return "unknown";
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return "unknown";
    fd = openSync(path, "r");
    // session_meta carries the base instructions: ~13–22 KB in 0.153/0.154.
    const head = Buffer.alloc(Math.min(st.size, 256 * 1024));
    // Only what was actually read: a file truncated between the stat and the
    // read leaves an empty first line, which parses as nothing → "unknown".
    const body = head.subarray(0, readSync(fd, head, 0, head.length, 0));
    const nl = body.indexOf(0x0a);
    const firstLine = body.subarray(0, nl < 0 ? body.length : nl).toString("utf8");
    let first: { type?: string; payload?: { source?: unknown; thread_source?: unknown } };
    try {
      first = JSON.parse(firstLine);
    } catch {
      // A first line longer than the read: judge by the raw text, by the
      // same rule as the parsed line below.
      if (!/"type"\s*:\s*"session_meta"/.test(firstLine)) return "unknown";
      if (RAW_SUBAGENT_SOURCE_RE.test(firstLine)) return "subagent";
      return RAW_SOURCE_MARK_RE.test(firstLine) ? "human" : "unknown";
    }
    if (first?.type !== "session_meta") return "unknown";
    const source = first.payload?.source;
    if (source !== null && typeof source === "object") return "subagent";
    const marks = [source, first.payload?.thread_source].filter((s): s is string => typeof s === "string");
    if (marks.some((s) => SUBAGENT_NAME_RE.test(s))) return "subagent";
    return marks.length > 0 ? "human" : "unknown";
  } catch {
    return "unknown";
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
 * channel (see `PROMPT_CHANNELS`); an event without its payload, whose origin
 * cannot be checked, for every harness that checks origin (see
 * `CaptureEvent`); prompts a harness marks as not typed by the human; prompts
 * whose origin evidence — a Codex rollout's `session_meta`, a Claude Code or
 * droid transcript's conversation — cannot be read (see `codexRolloutOrigin`
 * and `transcriptVouchesForPrompt`); turns that are entirely harness text
 * (`cleanHumanTurn` → null); session ids that could name a path outside the
 * state directory.
 */
export function captureIntent(ev: CaptureEvent | PromptOnlyCaptureEvent, now: number = Date.now()): void {
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
