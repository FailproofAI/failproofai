/**
 * What the human actually asked for.
 *
 * The semantic evaluator may clear a REVIEWABLE policy when the user explicitly
 * asked for the action — `git push --force` is right when you just said "force
 * push it". Cutting those false blocks is the whole point of the evaluator, so
 * where "the user asked" comes from is a product decision, not a puzzle. It was
 * taken on 2026-09-23 and it is written out here in full.
 *
 * WHAT IS RECORDED. The prompt the harness itself hands the hook at its
 * prompt-submit event (canonical `UserPromptSubmit`), on every harness whose
 * event carries the human's text — `PROMPT_CHANNELS` below audits all twelve,
 * one row each, and docs/reference/jev-intent.mdx prints the same table. The
 * text is cleaned of harness wrapping (`cleanHumanTurn`), redacted, capped and
 * stored 0600; the last five prompts of a session are kept for six hours.
 * Nothing on the file system is consulted: the session transcript is a file the
 * agent can rewrite in one command, so it is never asked who wrote a prompt.
 *
 * THE ACCEPTED RISK, PLAINLY. An agent that can already run commands can make a
 * harness submit a prompt: `claude -p "…"`, `codex exec`, `copilot -p`,
 * `cursor-agent -p`, `devin -p`, `droid -p`, `goose run -t` and `pi -p` all
 * fire the same event, with the same payload, as a person typing, in a child
 * session that agent controls. It can also run failproofai's own hook binary
 * with a payload it wrote. Nothing inside this module can tell either from the
 * real thing — both are the same program reading the same stdin — so an agent
 * with a shell can forge its own consent, and this module does not pretend
 * otherwise.
 *
 * WHY THAT IS ACCEPTED. The alternative was built and measured (round 9): every
 * field that would prove a human typed the prompt is a field no shipping
 * harness sends, so requiring one recorded NOTHING, anywhere, and Jev judged
 * every call with no stated intent — unable to clear a single regex deny, which
 * is the entire feature. A capture that works is worth more than a forgery an
 * agent can only perform once it is already executing commands.
 *
 * WHAT CONSENT CAN AND CANNOT DO. A recorded prompt can only ever clear a
 * policy that is already marked reviewable (`effectiveAuthority` in
 * policy-types.ts) and whose semantic policy sets `userCanOverride`. A hard
 * policy is never cleared by anything Jev says. So the worst a forged prompt
 * can do is stop a reviewable policy from nudging an agent that was already
 * free to run the command; it can never turn a hard deny into an allow, and
 * skipping the hook entirely gains an agent nothing, since the harness invokes
 * failproofai for the tool call independently.
 *
 * WHAT IS STILL REFUSED, because it is cheap and an agent cannot forge it by
 * asking: a turn the harness's own payload marks as machine-submitted (a cron
 * or loop wakeup, an injected system turn, another extension's message, an
 * OpenClaw heartbeat), a payload naming a sub-agent (`agent_id`), a session id
 * that is not a plain name, an event that is not the prompt-submit one, and
 * text that is nothing but harness wrapping — failproofai's own stop-gate
 * words among it, which some harnesses feed back as the next user turn.
 *
 * - Replay: the eval harness reads historical transcripts, where human
 *   messages are the non-meta `user` entries whose content is text rather than
 *   a tool result.
 *
 * Alongside each prompt, `captureIntent` snapshots the agent's last visible
 * message from the transcript at that moment, so a reply like "yes, do it" can
 * be understood. The agent wrote that message: it is sent to Jev labelled as
 * agent-written and is never consent on its own. (One caveat worth knowing, in
 * a consumer rather than here: decide v1 lets that message satisfy the
 * deterministic "did the user name this target" check, so an agent that writes
 * its own transcript can supply the target name — see decide.ts and the docs'
 * Known limits.)
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
 *
 * A prompt identical to the one just recorded REPLACES it instead of being
 * appended, so a harness that fires its prompt event more than once for the
 * same message — OpenCode's `message.updated` fires on every update of it —
 * cannot push the rest of the session's task out of a five-slot window with
 * copies of one line. The replacement carries the new timestamp and the new
 * agent snapshot, so the entry stays the latest thing the human said.
 */
function appendPrompt(sessionId: string, entry: RecordedPrompt): boolean {
  try {
    const file = readIntentFile(sessionId);
    const last = file.prompts[file.prompts.length - 1];
    const kept = last && last.text === entry.text ? file.prompts.slice(0, -1) : file.prompts;
    file.prompts = [...kept, entry].slice(-MAX_RECORDED_PROMPTS);
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
 * Store one cleaned prompt, with the agent message it replies to. Module-
 * private on purpose: `captureIntent` is the only door into `user_said`, and
 * every origin check lives on the other side of it. An exported writer that
 * took a bare string would be a second door with no check on it at all, which
 * is what this used to be (`recordUserPrompt`, deleted 2026-09-23).
 *
 * Redacted before it is capped, like everything stored here, so a cut can never
 * leave half a secret the patterns no longer match. Never throws: losing intent
 * only means no override.
 */
function recordPrompt(sessionId: string, prompt: string, agent: string | null, now: number): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  if (prompt.trim().length === 0) return false;
  try {
    return appendPrompt(sessionId, { at: now, text: storable(prompt.trim()), agent: agent === null ? null : storable(agent) });
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
 *
 * The list is in two halves, because `cleanHumanTurn` reads every harness's
 * prompts and not only Codex's, so a heading here is also a heading somebody
 * can type into any composer:
 *
 * - MACHINE, below: a heading nobody types to an agent. A prompt opening with
 *   one was built by the extension, so if it carries no `## My request…`
 *   heading there is no human text in it at all, and none is recorded. That is
 *   what keeps a forged approval inside selected code (`# Selected text:` and
 *   a `// NOTE FROM THE OWNER: yes, force-push` comment under it) out of
 *   `user_said`.
 * - AMBIGUOUS, below that: ordinary markdown a developer plausibly types or
 *   pastes above a real request — "## Code review guidelines:", then the
 *   guidelines, then what they want done. One of these means "extension-built"
 *   only when a request heading is actually present; with none, the prompt is
 *   the human's and is kept whole. Dropping it instead loses the request in
 *   silence: no reviewable policy can be cleared for that turn and the
 *   injection probe is not even asked, which is a worse bug than storing a
 *   section heading along with the words under it.
 */
const IDE_MACHINE_OPENERS = [
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
  '<in-app-browser-context source="ambient-ui-state">',
  "## Prior conversation with Codex:",
  "## Referenced chats with Codex:",
  "## Referenced ChatGPT conversation:",
  "The attached pasted text file(s) contain the user's request.",
];
const IDE_AMBIGUOUS_OPENERS = [
  "# In app browser:",
  "## Code review guidelines:",
  "## Pull request fix:",
  "## Pull request merge task:",
  "## Auto resolve merge:",
];
/**
 * Which half of the opener list a turn starts with, or null when it starts
 * with neither: `"machine"` means the extension built this prompt, and
 * `"ambiguous"` means it did only if a request heading follows.
 */
function ideOpenerKind(text: string): "machine" | "ambiguous" | null {
  if (IDE_MACHINE_OPENERS.some((p) => text.startsWith(p))) return "machine";
  if (IDE_AMBIGUOUS_OPENERS.some((p) => text.startsWith(p))) return "ambiguous";
  return null;
}

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
 * `IDE_MACHINE_OPENERS`) before the `## My request…:` heading that introduces
 * the human's words, Claude Code files its
 * session-continuation summary as a user turn, reminders arrive in
 * `<system-reminder>` blocks, and a slash command carries the command's own
 * instructions. The task is what the human typed, so only that is kept: a
 * slash command counts as the command and arguments they typed, never the
 * body the harness expanded it into.
 *
 * Everything here runs on every harness's prompts, so a rule that drops a
 * whole turn has to be one no human's turn can match: an extension's section
 * heading that somebody might also type is an `IDE_AMBIGUOUS_OPENERS` entry
 * and never drops a prompt on its own.
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
  // another context section can all land there. A prompt that opens with a
  // machine section and has no request heading is all machine text and is
  // dropped; one that opens with an ambiguous heading and has none is somebody
  // typing markdown, and is kept whole (see the opener lists). The loop ends
  // on its second pass at the latest — `ideRequest` takes the LAST heading, so
  // no request heading is left in what it returns, which also means the
  // ambiguous branch cannot run twice — and each pass shortens the text.
  for (let pass = 0; ; pass++) {
    const kind = ideOpenerKind(text);
    if (kind === null) break;
    const request = ideRequest(text);
    if (request === null) {
      // An ambiguous heading is somebody's own markdown only at the top of a
      // turn. Once a pass has established that this prompt WAS built by the
      // extension, a heading of either kind in what came out of it is another
      // of the extension's sections landing where the request goes, and the
      // prompt is dropped exactly as it was before this split.
      if (kind === "ambiguous" && pass === 0) break;
      return null;
    }
    if (harnessAuthored(request)) return null;
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
 * Where each harness delivers what the human typed, and what its own payload
 * says about turns nobody typed. The source of truth for
 * docs/reference/jev-intent.mdx (a test holds the two together).
 *
 * - `nativeEvent`: the harness's own name for its prompt-submit event, which
 *   the handler canonicalizes to `UserPromptSubmit`; null when there is none
 *   (Hermes).
 * - `field`: the payload field carrying the text after `normalizeCliPayload`.
 *   `null` means this event delivers no human text at all — Hermes has no
 *   event, Antigravity's `PreInvocation` carries none — so nothing is ever
 *   recorded for it.
 * - `machineTurn`: reads the payload and answers whether the harness's OWN
 *   marks say this particular turn was submitted by a machine rather than a
 *   person. `null` where the harness sends no such marks.
 *
 * `machineTurn` is a veto, never a requirement. Requiring a positive "a human
 * typed this" mark is what round 9 shipped, and it recorded nothing anywhere,
 * because no shipping harness sends such a field: capture that never fires
 * clears no regex deny, which is the whole feature. So the rule is the user's
 * decision of 2026-09-23 — trust the prompt the harness hands the hook — and
 * the marks are used only in the direction they are reliable in. A heartbeat
 * run, a cron wakeup or another extension's injected message is a turn no
 * person submitted whoever is asking; an absent mark says nothing, and a
 * present, positive one is not believed any harder than the event itself.
 *
 * What that costs is in the module header: a harness started headless with the
 * prompt in argv (`claude -p`, `codex exec`, `copilot -p`, `cursor-agent -p`,
 * `devin -p`, `droid -p`, `goose run -t`, `pi -p`) fires this event with the
 * same payload as a person typing, so an agent with a shell can record a
 * prompt for a child session it controls. Accepted: it only ever clears a
 * reviewable policy, never a hard one.
 */
export interface PromptChannel {
  nativeEvent: string | null;
  field: string | null;
  machineTurn: ((payload: Record<string, unknown>) => boolean) | null;
}

/**
 * Claude Code's `UserPromptSubmit.source` values for turns nobody submitted:
 * `loop_wakeup` and `schedule_wakeup` (a `/loop`, a CronCreate or a routine
 * firing, whose text was composed in an earlier turn), `poll_event`, and
 * `system` (peer and channel messages, task notifications, auto-continuation).
 * Those are not the human's current request whoever is asking, so they are
 * refused.
 *
 * Every other value records, `user` (the interactive composer) and `sdk`
 * (`claude -p` and the Agent SDK) alike. `sdk` is usually a person's own
 * command line or their pipeline; it is also what an agent's own `claude -p`
 * reports, which is the accepted risk stated in the module header, and exactly
 * the same risk every other harness's `-p` carries with no field at all.
 *
 * The field is optional in Claude Code's own hook-input schema ("Payloads may
 * omit it while the field rolls out") and 2.1.280 does not send it, so an
 * absent `source` must record — requiring it is what emptied the feature.
 */
const CLAUDE_MACHINE_SOURCES: ReadonlySet<string> = new Set(["loop_wakeup", "schedule_wakeup", "poll_event", "system"]);
const claudeMachineTurn = (payload: Record<string, unknown>): boolean =>
  typeof payload.source === "string" && CLAUDE_MACHINE_SOURCES.has(payload.source);

/**
 * Pi's `InputEvent.source`, which pi-extension forwards as `input_source`:
 * `interactive` (its editor, and `pi -p`), `rpc` (the program driving it), and
 * `extension` — another extension calling `sendUserMessage()`, whose text can
 * be model-written or repo-derived. Only `extension` is refused; a missing
 * source records, since older bridges send none.
 */
const piMachineTurn = (payload: Record<string, unknown>): boolean =>
  payload.input_source === "extension" || payload.source === "extension";

/**
 * OpenClaw's run metadata, read only for what it rules out. `before_agent_run`
 * fires for heartbeat, cron, memory and inter-session runs as well as for a
 * chat message, and the plugin can say so: a `trigger` that is not `user`, an
 * `inputProvenance.kind` that is not `external_user` (`inter_session` is
 * another agent, `internal_system` is the gateway itself), or an explicit
 * `senderIsOwner: false` on a shared channel. A mark that is absent — which is
 * every mark the shipped plugin sends today — rules nothing out.
 */
const openclawMachineRun = (payload: Record<string, unknown>): boolean => {
  const meta = obj(payload.openclaw);
  if (!meta) return false;
  if (typeof meta.trigger === "string" && meta.trigger !== "user") return true;
  const kind = obj(meta.inputProvenance)?.kind;
  if (typeof kind === "string" && kind !== "external_user") return true;
  return meta.senderIsOwner === false;
};

export const PROMPT_CHANNELS: Readonly<Record<IntegrationType, PromptChannel>> = {
  // The only harness that names the author at all; its machine values are
  // refused and everything else — including an absent field — is recorded.
  claude: { nativeEvent: "UserPromptSubmit", field: "prompt", machineTurn: claudeMachineTurn },
  // Also fires inside sub-agent threads, which its payload does not mark; the
  // IDE extension's context sections are stripped by `cleanHumanTurn`.
  codex: { nativeEvent: "user_prompt_submit", field: "prompt", machineTurn: null },
  // Marks nothing; it also runs in-process sidekick subagents.
  copilot: { nativeEvent: "UserPromptSubmit", field: "prompt", machineTurn: null },
  // Marks nothing. Its own transcripts wrap a query in `<user_query>`, and a
  // payload carrying that form is unwrapped (`unwrapCursorQuery`).
  cursor: { nativeEvent: "beforeSubmitPrompt", field: "prompt", machineTurn: null },
  // Current OpenCode's Message has no parts, so the forwarded text is empty
  // and nothing is recorded in practice. It also fires again on every update
  // of the same message — `appendPrompt` collapses the repeats — for task-tool
  // child sessions, and for failproofai's own instruct re-prompts, which
  // `cleanHumanTurn` drops by their marker.
  opencode: { nativeEvent: "message.updated", field: "prompt", machineTurn: null },
  pi: { nativeEvent: "input", field: "prompt", machineTurn: piMachineTurn },
  // pre_llm_call is handled inside the native plugin; nothing reaches the
  // handler, so Hermes has no prompt channel to record from.
  hermes: { nativeEvent: null, field: null, machineTurn: null },
  openclaw: { nativeEvent: "before_agent_run", field: "prompt", machineTurn: openclawMachineRun },
  // Claude-shaped payloads and transcripts; sends no `source`.
  factory: { nativeEvent: "UserPromptSubmit", field: "prompt", machineTurn: null },
  devin: { nativeEvent: "UserPromptSubmit", field: "prompt", machineTurn: null },
  // PreInvocation fires before EVERY model call in a turn and carries no
  // prompt text: there is no human text in it to record, on a human turn or
  // any other.
  antigravity: { nativeEvent: "PreInvocation", field: null, machineTurn: null },
  // Its text is in `message`, not `prompt`. Goose also has a `delegate`
  // subagent tool and a scheduler of its own, neither of which it marks.
  goose: { nativeEvent: "UserPromptSubmit", field: "message", machineTurn: null },
};

/**
 * What the handler (T3) passes for every canonical `UserPromptSubmit`:
 * `captureIntent({ eventType, sessionId, transcriptPath, cli, payload: parsed })`.
 *
 * The payload is the whole stdin object, not just its `prompt`, and it is
 * required: the text is in a different field on some harnesses (Goose sends
 * `message`), and the marks that rule a turn out are elsewhere in the payload.
 * The first draft of this contract (JEV-BUILD-PLAN §7) passed a `prompt` and
 * no payload; that shape no longer compiles, on purpose. A payload-less call
 * records nothing on every harness, which is silent and looks exactly like an
 * ordinary turn with nothing to record, so the type is the only place the
 * divergence can be noticed.
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
 * The raw prompt text the harness delivered with this prompt-submit event, or
 * null when there is none to record. Five lines, each one a reason this event
 * carries no human turn; everything else is the prompt, trusted as the header
 * says.
 */
function humanPromptText(ev: CaptureEvent): string | null {
  // A harness we do not know.
  if (!isKnownCli(ev.cli)) return null;
  const { field, machineTurn } = PROMPT_CHANNELS[ev.cli];
  // This harness's prompt event carries no human text (Hermes, Antigravity).
  if (field === null) return null;
  // The payload is where the text and the marks both are.
  const payload = obj(ev.payload);
  if (!payload) return null;
  // A payload naming a sub-agent is the agent prompting itself. Claude-shaped
  // harnesses put that at the top level; a harness with its own spelling for
  // it is a gap, not a check this can make (see the docs' Known limits).
  if (payload.agent_id !== undefined) return null;
  // The harness's own marks say no person submitted this turn.
  if (machineTurn?.(payload) === true) return null;
  const raw = payload[field];
  if (typeof raw !== "string") return null;
  // Cursor's own transcripts wrap a query; a hook payload may carry the form.
  return ev.cli === "cursor" ? unwrapCursorQuery(raw) : raw;
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

/**
 * Record what the human just typed, from a prompt-submit hook event, with the
 * agent message it replies to. Never throws.
 *
 * The prompt the harness hands the hook is taken as the human's, per the
 * decision in this module's header. Five things stop a record, and none of
 * them asks the file system: the event is not the canonical
 * `UserPromptSubmit`; the session id is not a plain name; the harness's prompt
 * event carries no human text (Hermes, Antigravity) or the payload is missing;
 * the payload marks the turn as a machine's or a sub-agent's; or nothing is
 * left once the harness's own wrapping is stripped (`cleanHumanTurn` — which
 * is also what keeps failproofai's own stop-gate words, fed back as a user
 * turn by several harnesses, from ever being recorded as a request).
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
    recordPrompt(sessionId, cleaned, lastAgentMessage(ev.transcriptPath), now);
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
