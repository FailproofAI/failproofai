/**
 * What the human actually asked for.
 *
 * The semantic evaluator may clear a policy when the user explicitly asked for
 * the action — `git push --force` is right when you just said "force push it".
 * That makes "the user asked" the most valuable thing a prompt injection could
 * forge, so it is only ever read from a channel the agent cannot write to:
 *
 * - Live: a harness's prompt-submit event (canonical `UserPromptSubmit`).
 *   `captureIntent` records the part of it the human typed — harness wrappers
 *   stripped, redacted, capped — into a 0600 file under failproofai's state
 *   directory, which the always-on self-protection guard already stops the
 *   agent from modifying.
 *
 *   It records ONLY when the event itself establishes human origin, and the
 *   event is the hook's stdin: the canonical event type and the field, in the
 *   payload the harness wrote, that names who authored this prompt. The agent
 *   cannot edit either. Nothing on the file system is consulted for origin.
 *   The session transcript in particular is not evidence: it is a file the
 *   agent can truncate, replace, pad or rewrite in one command, and every
 *   attempt to prove a prompt human from it has been forged again by the next
 *   spelling.
 *
 *   Each harness is audited separately (`PROMPT_CHANNELS` below and
 *   docs/reference/jev-intent.mdx). A prompt is recorded only where the
 *   harness's own payload names the operator as its author — Claude Code's
 *   `source`, OpenClaw's run metadata. A harness that sends no such field is
 *   not capturable and records nothing at all, however its prompt event is
 *   meant to be used: every one of these CLIs can be started headless with
 *   the prompt in argv (`copilot -p`, `cursor-agent -p`, `devin -p`,
 *   `goose run -t`, `pi -p`), which fires the same event with the same
 *   payload, and an agent with a shell can do that in one command. Neither
 *   field is populated by a shipping build today, so live capture currently
 *   records nothing on any harness and starts working, with no change here,
 *   on the first build that sends one.
 *
 *   What failing closed costs, stated exactly: with no recorded prompt Jev
 *   has no task to judge the call against, so it can clear no reviewable
 *   policy — strictly stricter. It is not free, though: the injection probe
 *   and the beyond-the-task check are asked only when there is a human
 *   message, so a fired warn policy that prompt injection would have
 *   escalated to a block stays a nudge. Nothing is ever ALLOWED for want of a
 *   prompt; some things are judged less harshly.
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
 * Append one prompt to the session's file, the newest `MAX_RECORDED_PROMPTS`
 * kept. Atomic, 0600 file in a 0700 directory. Returns false instead of
 * throwing: losing intent only means no override.
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
 * Delete session files last written longer ago than `INTENT_MAX_AGE_MS`. A
 * file's mtime is its newest recorded prompt's, so every prompt in such a
 * file is already outside the window every read filters by and can never be
 * read again. Removing it loses nothing and keeps one-file-per-session from
 * growing without bound.
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

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * Where each harness delivers what the human typed, and how its own payload
 * names the operator as the author of this prompt. The source of truth for
 * docs/reference/jev-intent.mdx (a test holds the two together).
 *
 * - `nativeEvent`: the harness's own name for its prompt-submit event, which
 *   the handler canonicalizes to `UserPromptSubmit`; null when there is none.
 * - `field`: the payload field carrying the text after `normalizeCliPayload`.
 * - `namesOperator`: reads the payload and answers whether the harness says a
 *   person at the keyboard authored THIS prompt. `null` means the harness has
 *   no such field, so nothing it sends is ever recorded: not capturable.
 *
 * Why a field naming the author is the whole bar. Every one of these CLIs can
 * be started headless with the prompt in argv — `claude -p`, `codex exec`,
 * `copilot -p`, `cursor-agent -p`, `devin -p`, `droid -p`, `goose run -t`,
 * `pi -p` — and that run fires the same prompt-submit event, with the same
 * payload, as a person typing. An agent holding a shell can start one in a
 * single command, and the session it starts is the session whose intent it
 * would clear a policy with. So "this harness only fires the event for real
 * submissions" is not something the event can establish; only a field that
 * names the author can. A harness that does not send one is not capturable,
 * whatever its transcript would say — the agent writes the transcript.
 */
export interface PromptChannel {
  nativeEvent: string | null;
  field: string | null;
  namesOperator: ((payload: Record<string, unknown>) => boolean) | null;
}

/**
 * Claude Code's `UserPromptSubmit.source` is `user` for the interactive
 * composer, and names something else for every prompt a person did not type:
 * `sdk` (`-p` / Agent SDK, which is what an agent's own `claude -p` reports),
 * `loop_wakeup`, `schedule_wakeup` (a CronCreate or routine firing), `system`
 * (peer and channel messages, task notifications, auto-continuation) and
 * `poll_event`. The field is optional in Claude Code's own hook-input schema
 * — "Payloads may omit it while the field rolls out" — and a payload without
 * it records nothing.
 */
const claudeComposer = (payload: Record<string, unknown>): boolean => payload.source === "user";

/**
 * OpenClaw's run metadata, all three marks required: it documents that an
 * absent classification "does not establish human origin" and sets
 * `senderIsOwner` only "when available", so on a shared channel an unmarked
 * sender may be anyone in the chat. Only a message the owner sent from
 * outside the agent counts.
 */
const openclawOwnerMessage = (payload: Record<string, unknown>): boolean => {
  const meta = obj(payload.openclaw);
  return meta?.trigger === "user" && obj(meta.inputProvenance)?.kind === "external_user" && meta.senderIsOwner === true;
};

export const PROMPT_CHANNELS: Readonly<Record<IntegrationType, PromptChannel>> = {
  // The one harness that names the author of a prompt it submits.
  claude: { nativeEvent: "UserPromptSubmit", field: "prompt", namesOperator: claudeComposer },
  // Fires user_prompt_submit inside sub-agent threads too, whose prompts the
  // parent agent wrote, and names no author. The rollout's `session_meta` was
  // a file on disk the agent can rewrite.
  codex: { nativeEvent: "user_prompt_submit", field: "prompt", namesOperator: null },
  // Names no author, and `copilot -p "<text>"` fires this event; it also runs
  // in-process sidekick subagents.
  copilot: { nativeEvent: "UserPromptSubmit", field: "prompt", namesOperator: null },
  // Names no author, and `cursor-agent -p "<text>"` fires this event.
  cursor: { nativeEvent: "beforeSubmitPrompt", field: "prompt", namesOperator: null },
  // message.updated carries no text in current OpenCode (the Message has no
  // parts), fires again on every update of the same message, and fires for
  // task-tool child sessions and for failproofai's own instruct re-prompts.
  opencode: { nativeEvent: "message.updated", field: "prompt", namesOperator: null },
  // `input_source` names the input channel, not the author: Pi reports
  // `interactive` both for its editor and for `pi -p "<text>"`, and `rpc` for
  // whatever program is driving it. Neither excludes the agent.
  pi: { nativeEvent: "input", field: "prompt", namesOperator: null },
  // pre_llm_call is handled inside the native plugin; nothing reaches the handler.
  hermes: { nativeEvent: null, field: null, namesOperator: null },
  // Heartbeat, cron, memory and inter-session runs fire before_agent_run too,
  // and the run metadata says which — and who sent the message.
  openclaw: { nativeEvent: "before_agent_run", field: "prompt", namesOperator: openclawOwnerMessage },
  // Claude-shaped payloads and transcripts, ships SubagentStop, sends no
  // `source`, and `droid -p "<text>"` fires this event.
  factory: { nativeEvent: "UserPromptSubmit", field: "prompt", namesOperator: null },
  // Names no author, and `devin -p "<text>"` fires this event.
  devin: { nativeEvent: "UserPromptSubmit", field: "prompt", namesOperator: null },
  // PreInvocation fires before every model call, carries no text, and hooks
  // can inject userMessage steps into the same conversation.
  antigravity: { nativeEvent: "PreInvocation", field: null, namesOperator: null },
  // Names no author; `goose run -t "<text>"` fires this event, and Goose also
  // has a `delegate` subagent tool and a cron scheduler of its own.
  goose: { nativeEvent: "UserPromptSubmit", field: "message", namesOperator: null },
};

/**
 * What the handler (T3) passes for every canonical `UserPromptSubmit`:
 * `captureIntent({ eventType, sessionId, transcriptPath, cli, payload: parsed })`.
 *
 * The payload is the whole stdin object, not just its `prompt`, and it is
 * required: the text is in a different field on some harnesses (Goose sends
 * `message`), and the field that names the prompt's author is elsewhere in
 * the payload. The first draft of this contract (JEV-BUILD-PLAN §7) passed a
 * `prompt` and no payload; that shape no longer compiles, on purpose. A
 * caller passing it is not running the origin check at all, and the type is
 * where that has to be noticed — a payload-less call records nothing, which
 * looks exactly like the intended behaviour on a harness that records
 * nothing anyway.
 */
export interface CaptureEvent {
  /** Canonical event type; anything but `UserPromptSubmit` is ignored. */
  eventType: string;
  sessionId?: string;
  /** Read only for the agent's last message. Never consulted for origin. */
  transcriptPath?: string;
  cli: string;
  /** The stdin payload after `normalizeCliPayload`: the handler's `parsed`. */
  payload: Record<string, unknown>;
}

function isKnownCli(cli: string): cli is IntegrationType {
  return Object.prototype.hasOwnProperty.call(PROMPT_CHANNELS, cli);
}

/**
 * The raw prompt text of a prompt-submit event when the harness's own payload
 * says a person at the keyboard authored it, else null. Six lines, each one a
 * way the event fails to establish that, and everything it cannot answer
 * answers null.
 */
function humanPromptText(ev: CaptureEvent): string | null {
  // A harness we do not know.
  if (!isKnownCli(ev.cli)) return null;
  const { field, namesOperator } = PROMPT_CHANNELS[ev.cli];
  // Not capturable: this harness sends no field naming a prompt's author.
  if (field === null || namesOperator === null) return null;
  // The payload is the only thing origin is read from.
  const payload = obj(ev.payload);
  if (!payload) return null;
  // A payload naming a sub-agent is the agent prompting itself.
  if (payload.agent_id !== undefined) return null;
  // The harness must say this prompt is the operator's own.
  if (!namesOperator(payload)) return null;
  const raw = payload[field];
  return typeof raw === "string" ? raw : null;
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

/**
 * Record what the human just typed, from a prompt-submit hook event, with the
 * agent message it replies to. Never throws.
 *
 * A prompt is recorded only when the event establishes human origin on its
 * own: the canonical `UserPromptSubmit`, a session id that is a plain name, a
 * harness whose payload names the operator as this prompt's author, no
 * sub-agent mark in the payload, and something left after the harness
 * wrappers are stripped (`cleanHumanTurn`). Everything else records nothing —
 * including every case where the honest answer is "cannot tell". That costs a
 * stated intent, never a guard: with nothing recorded Jev judges the call
 * with no task to judge it against, so it can clear no reviewable policy.
 *
 * The transcript is read for exactly one thing, and never for origin: the
 * agent's last visible message at this moment. The agent wrote that message
 * by definition — it is sent to Jev labelled that way and is never consent.
 */
export function captureIntent(ev: CaptureEvent, now: number = Date.now()): void {
  try {
    if (ev?.eventType !== "UserPromptSubmit") return;
    const sessionId = ev.sessionId;
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return;
    const raw = humanPromptText(ev);
    if (raw === null) return;
    const cleaned = cleanHumanTurn(raw);
    if (cleaned === null) return;
    const agent = lastAgentMessage(ev.transcriptPath);
    appendPrompt(sessionId, { at: now, text: storable(cleaned), agent: agent === null ? null : storable(agent) });
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
