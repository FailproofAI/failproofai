/**
 * What the human actually asked for.
 *
 * The semantic evaluator may clear a policy when the user explicitly asked for
 * the action — `git push --force` is right when you just said "force push it".
 * That makes "the user asked" the most valuable thing a prompt injection could
 * forge, so it is only ever read from a channel the agent cannot write to:
 *
 * - Live: `UserPromptSubmit` fires when a human submits a message, before the
 *   model sees it. Each prompt is recorded here, redacted, into a 0600 file
 *   under failproofai's state directory — which the always-on self-protection
 *   guard already stops the agent from modifying.
 * - Replay: the eval harness reads historical transcripts, where human
 *   messages are the non-meta `user` entries whose content is text rather than
 *   a tool result.
 *
 * Text inside a tool call claiming "the user approved this" is never consulted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { semanticDir } from "../fp-home";
import { MAX_USER_MESSAGE_CHARS, capHeadTail, redactSecrets } from "./envelope";

export const MAX_RECORDED_PROMPTS = 5;
/** Older than this and a prompt no longer describes what the agent is doing. */
export const INTENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const intentFile = (sessionId: string): string => resolve(semanticDir(), "sessions", `${sessionId}.json`);

interface IntentFile {
  prompts: Array<{ at: number; text: string }>;
}

function readIntentFile(sessionId: string): IntentFile {
  try {
    const parsed = JSON.parse(readFileSync(intentFile(sessionId), "utf8")) as IntentFile;
    return Array.isArray(parsed?.prompts) ? parsed : { prompts: [] };
  } catch {
    return { prompts: [] };
  }
}

/** Record a human prompt. Never throws: losing intent only means no override. */
export function recordUserPrompt(sessionId: string | undefined, prompt: unknown, now: number = Date.now()): boolean {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return false;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false;
  try {
    // `blunt: false`: the credential-header and credential-flag rules give up
    // a whole line or a whole argument on the strength of a NAME, which is the
    // right trade for the Jev request body and the wrong one here. This is the
    // evaluator's record of what the HUMAN asked for — it never leaves the
    // machine, `buildEnvelope` redacts it again (bluntly) before it does, and
    // storing it cut off after a `cookie:` or an `authorization:` lost the
    // targets the human named. The narrow rules still run.
    const text = redactSecrets(capHeadTail(prompt.trim(), MAX_USER_MESSAGE_CHARS).text, { blunt: false }).text;
    const file = readIntentFile(sessionId);
    file.prompts = [...file.prompts, { at: now, text }].slice(-MAX_RECORDED_PROMPTS);
    const dir = resolve(semanticDir(), "sessions");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = intentFile(sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** Recent human prompts for a session, oldest first. */
export function readUserIntent(sessionId: string | undefined, now: number = Date.now()): string[] {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return [];
  return readIntentFile(sessionId)
    .prompts.filter((p) => typeof p?.text === "string" && now - p.at <= INTENT_MAX_AGE_MS)
    .map((p) => p.text);
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

/** The visible text of an assistant transcript entry (Claude Code or Codex), or null. */
export function agentMessageText(entry: unknown): string | null {
  const e = entry as {
    type?: string;
    isSidechain?: boolean;
    message?: { role?: string; content?: unknown };
    payload?: { type?: string; message?: unknown };
  };
  // Codex: the clean agent message is an event, like the human's.
  if (e?.type === "event_msg" && e.payload?.type === "agent_message" && typeof e.payload.message === "string") {
    return e.payload.message.trim() || null;
  }
  if (e?.type !== "assistant" || e.isSidechain) return null;
  const content = e.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => (b as { type?: string })?.type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

// ── Live capture (T4 contract) ───────────────────────────────────────────────

/**
 * Record what the human just typed, from a prompt-submit hook event. Never
 * throws. T0 stub: records the raw prompt for Claude-style `UserPromptSubmit`
 * only. T4 extends it to every CLI, cleans the prompt, and snapshots the
 * agent's last visible message from the transcript.
 */
export function captureIntent(ev: {
  eventType: string;
  sessionId?: string;
  prompt?: unknown;
  transcriptPath?: string;
  cli: string;
}): void {
  if (ev.eventType !== "UserPromptSubmit") return;
  recordUserPrompt(ev.sessionId, ev.prompt);
}

/**
 * What the human asked for recently (oldest first) and the agent message a
 * reply like "yes" refers to. T0 stub: no agent message yet.
 */
export function readIntent(sessionId?: string): { userSaid: string[]; agentLastMessage: string | null } {
  return { userSaid: readUserIntent(sessionId), agentLastMessage: null };
}
