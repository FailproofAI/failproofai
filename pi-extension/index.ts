/**
 * failproofai policy bridge for Pi (pi-coding-agent).
 *
 * This extension is loaded by Pi at startup and registered via
 * `pi install <abs-path-to-this-dir> [-l]` (or by hand-authoring an entry in
 * `<scope>/.pi/settings.json`). It subscribes to Pi's `tool_call`, `user_bash`,
 * `input`, and `session_start` events and forwards them to the failproofai
 * binary as `failproofai --hook <Event> --cli pi`. failproofai prints a
 * decision JSON to stdout; this shim parses it and translates into Pi's
 * `{ block: true, reason }` return shape so policy `deny` decisions cancel
 * tool execution.
 *
 * Marker comment for failproofai's installer detection (do not remove):
 *   __failproofai_hook__: true
 *
 * Binary resolution. failproofai ships two entrypoints:
 *   • dist/cli.mjs — bundled, node-compatible (production npm install)
 *   • bin/failproofai.mjs — source, requires `bun` (dev / monorepo)
 *
 * dist/cli.mjs is preferred because spawning `node bin/failproofai.mjs`
 * fails with ERR_IMPORT_ATTRIBUTE_MISSING (the source `import package.json`
 * needs `with { type: "json" }` under node, which bun handles transparently
 * but the build:cli step transpiles away in dist/cli.mjs). When dist/cli.mjs
 * isn't present, fall back to running bin/failproofai.mjs with `bun`. Pi
 * spawns extensions with an undefined cwd contract, so paths are resolved
 * relative to this file via `import.meta.url`, NOT process.cwd().
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_BIN = resolve(HERE, "..", "dist", "cli.mjs");
const SRC_BIN = resolve(HERE, "..", "bin", "failproofai.mjs");
// Prefer the bundled dist/cli.mjs (node-compatible); fall back to source +
// bun for dev workflows where dist/ hasn't been built yet.
function resolveSpawn(): { cmd: string; args: string[] } {
  if (process.env.FAILPROOFAI_BINARY_OVERRIDE) {
    return { cmd: "node", args: [process.env.FAILPROOFAI_BINARY_OVERRIDE] };
  }
  if (existsSync(DIST_BIN)) {
    return { cmd: "node", args: [DIST_BIN] };
  }
  return { cmd: "bun", args: [SRC_BIN] };
}

interface PolicyDecision {
  permission?: "allow" | "deny";
  reason?: string;
}

/**
 * Spawn `failproofai --hook <eventName> --cli pi`, write the JSON payload to
 * stdin, and parse the flat `{permission, reason}` JSON we expect failproofai
 * to print on stdout. Fail-open on any subprocess / parse error.
 */
/** Optional stderr trace for debugging the shim. Enabled with
 *  FAILPROOFAI_PI_DEBUG=1; silent otherwise. */
function debug(msg: string): void {
  if (process.env.FAILPROOFAI_PI_DEBUG === "1") {
    process.stderr.write(`[failproofai-pi-shim] ${msg}\n`);
  }
}

function callPolicy(eventName: string, payload: unknown): { block: boolean; reason: string } {
  const { cmd, args } = resolveSpawn();
  debug(`callPolicy event=${eventName} cmd=${cmd}`);
  try {
    const result = spawnSync(
      cmd,
      [...args, "--hook", eventName, "--cli", "pi"],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (result.status !== 0) return { block: false, reason: "" };
    const stdout = (result.stdout || "").trim();
    if (!stdout) return { block: false, reason: "" };
    const parsed = JSON.parse(stdout) as PolicyDecision;
    if (parsed.permission === "deny") {
      debug(`DENY reason=${parsed.reason}`);
      return { block: true, reason: parsed.reason ?? "Blocked by failproofai" };
    }
  } catch (err) {
    debug(`EXCEPTION ${err instanceof Error ? err.message : String(err)}`);
    // Fail-open: never block tool execution because of an infra failure.
  }
  return { block: false, reason: "" };
}

interface PiToolCallEvent {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  cwd?: string;
  sessionId?: string;
}

/**
 * Pi emits tool names in lowercase (`bash`, `read`, `edit`, `write`, `glob`,
 * `grep`). failproofai's builtin policies match on Claude PascalCase
 * (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`) via case-sensitive
 * `Array.includes` in policy-registry.ts. Map between the two so existing
 * tool-name match clauses fire on Pi sessions.
 *
 * Keys must stay in sync with PI_TOOL_MAP in src/hooks/types.ts (this shim is
 * loaded in-process by Pi and must be self-contained — no imports from the
 * failproofai package). Update both whenever Pi adds a tool ID we care about.
 *
 * Unknown tools (anything not in this map) pass through unchanged so custom
 * policies that match on raw Pi tool IDs still work.
 */
const PI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
};

function canonicalizeToolName(piToolName: string | undefined): string | undefined {
  if (!piToolName) return undefined;
  return PI_TOOL_MAP[piToolName] ?? piToolName;
}

/**
 * Per-tool input-key translation. Pi's Read / Write / Edit tools deliver
 * `path` (not `file_path`); failproofai's `block-env-files` and
 * `block-secrets-write` builtins only read `file_path`, so without this map
 * they silently no-op on Pi. `block-read-outside-cwd` already has a `path`
 * fallback so it works either way. Pi's Edit tool nests `edits[{oldText,
 * newText}]` which doesn't translate flatly to Claude's `{old_string,
 * new_string}` — we only map the top-level `path`; the nested array stays
 * Pi-shape (no current builtin reads it).
 *
 * Keep in sync with PI_TOOL_INPUT_MAP in src/hooks/types.ts.
 */
const PI_TOOL_INPUT_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path" },
};

function canonicalizeToolInput(
  canonicalToolName: string | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || !canonicalToolName) return args;
  const map = PI_TOOL_INPUT_MAP[canonicalToolName];
  if (!map) return args;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) out[map[k] ?? k] = args[k];
  return out;
}

/** Resolve the cwd for the policy payload. Pi events don't include cwd, so
 *  fall back to the extension's process.cwd() — which is where Pi was
 *  launched and where `.failproofai/` config lives. */
function resolveCwd(eventCwd: string | undefined): string {
  return eventCwd ?? process.cwd();
}

/**
 * Pi (verified empirically against pi-coding-agent v0.71.1) does NOT
 * populate `event.sessionId` on any of its events — `session_start`,
 * `tool_call`, `user_bash`, `input`, `tool_result`, `agent_end`,
 * `session_shutdown` all leave it undefined. Without help the shim can't
 * tag activity records with a session id, so the dashboard renders
 * `Session ID: —` for every Pi row.
 *
 * What Pi DOES do: at session start it creates a JSONL transcript at
 * `~/.pi/agent/sessions/<encodedCwd>/<isoTimestamp>_<uuid>.jsonl` where
 * the filename encodes the sessionId. We discover ours by scanning the
 * encoded-cwd directory for the most-recently-modified matching file.
 *
 * Strategy: scan once and cache. Pi runs one session per process so the
 * cache is per-process and lives for the session's lifetime. If Pi ever
 * multiplexes, we'd need a keyed map.
 */
const PI_FILE_RE = /^[\d-]+T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Encode a cwd into Pi's on-disk session-dir name. Pi strips the leading
 *  `/` before replacing remaining slashes with `-`, e.g.
 *  `/home/u/repo` → `--home-u-repo--`. */
function piEncodeCwd(cwd: string): string {
  const inner = cwd.replace(/^\/+/, "").replace(/\//g, "-");
  return `--${inner}--`;
}

/** Process start boundary — files older than this aren't from the current
 *  Pi session. Captured at module load so cold-start in a cwd with stale
 *  transcripts doesn't pin a previous session's UUID. We allow a small
 *  tolerance below `processStartMs` because mtime resolution and clock
 *  skew can put a "current" file's mtime a few hundred ms before module
 *  load on slow startup. */
const PROCESS_START_MS = Date.now();
const STALE_TOLERANCE_MS = 2_000;

/** Find the newest `<ts>_<uuid>.jsonl` file under `~/.pi/agent/sessions/<encodedCwd>/`
 *  whose mtime indicates it belongs to the CURRENT Pi process (≥ process
 *  start, with a small tolerance). Files older than that are stale
 *  transcripts from prior sessions in the same cwd — caching their UUID
 *  would cross-attribute every event of the new session.
 *  Returns undefined when the dir doesn't exist, has no matching file, or
 *  every matching file is stale. */
function discoverPiSessionId(cwd: string): string | undefined {
  const root = process.env.PI_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions");
  const dir = join(root, piEncodeCwd(cwd));
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return undefined; }
  const boundary = PROCESS_START_MS - STALE_TOLERANCE_MS;
  let best: { sessionId: string; mtime: number } | undefined;
  for (const name of entries) {
    const m = PI_FILE_RE.exec(name);
    if (!m) continue;
    let mtime: number;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (mtime < boundary) continue;
    if (!best || mtime > best.mtime) best = { sessionId: m[1], mtime };
  }
  return best?.sessionId;
}

/** sessionId cache, keyed by cwd. Per-cwd so a multi-cwd Pi (extension running
 *  across multiple workspace roots) can't cross-attribute. Cleared on
 *  session_shutdown reasons `new`/`resume`/`fork` (Pi reuses the process). */
const cachedSessionIdByCwd = new Map<string, string>();

/** Pending Stop-policy deny reason from agent_end, keyed by sessionId.
 *  Drained by before_agent_start on the next user turn in the same Pi
 *  process. Cleared on every session_shutdown.
 *
 *  Why this exists: Pi's agent_end has no Result type — the agent loop
 *  has already exited when it fires, so a deny return cannot keep Pi
 *  running the way Claude's exit-2-from-Stop does. The closest analog
 *  is to capture the deny here and re-inject it as a MANDATORY ACTION
 *  system-prompt addition on the NEXT before_agent_start, which fires
 *  after the user submits a prompt but before the agent loop runs.
 *  Best-effort: bounded by the Pi process lifetime — same bound Claude
 *  has on exit-2-from-Stop (kill the agent and the gate is missed).
 *
 *  Why per-session not per-cwd: a Pi process can host multiple sessions
 *  via /resume and /fork; per-cwd would cross-attribute a stale block
 *  from a prior session into a fresh one. */
const pendingStopBlockBySession = new Map<string, string>();
function resolveSessionId(eventSessionId: string | undefined, cwd: string): string | undefined {
  if (eventSessionId) {
    cachedSessionIdByCwd.set(cwd, eventSessionId);
    return eventSessionId;
  }
  const cached = cachedSessionIdByCwd.get(cwd);
  if (cached) return cached;
  // Pi v0.71.1 never sets sessionId — discover from disk.
  const discovered = discoverPiSessionId(cwd);
  if (discovered) cachedSessionIdByCwd.set(cwd, discovered);
  return discovered;
}
/** Clear the cached sessionId for a cwd. Called on session_shutdown reasons
 *  that indicate a new session is starting in the same process (`new`,
 *  `resume`, `fork`). Without this, the next session would inherit the prior
 *  sessionId until disk discovery refreshed it. */
function resetSessionIdCache(cwd: string): void {
  cachedSessionIdByCwd.delete(cwd);
}

interface PiUserBashEvent {
  type?: string;
  command?: string;
  cwd?: string;
  sessionId?: string;
}

interface PiInputEvent {
  type?: string;
  text?: string;
  source?: string;
  cwd?: string;
  sessionId?: string;
}

interface PiSessionStartEvent {
  type?: string;
  reason?: string;
  cwd?: string;
  sessionId?: string;
}

interface PiSessionShutdownEvent {
  type?: string;
  /** "quit" | "reload" | "new" | "resume" | "fork" per pi-coding-agent v0.72.1 */
  reason?: string;
  targetSessionFile?: string;
  cwd?: string;
  sessionId?: string;
}

interface PiToolResultEvent {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  /** TextContent | ImageContent — opaque to us; forwarded as-is. */
  content?: unknown[];
  isError?: boolean;
  cwd?: string;
  sessionId?: string;
}

interface PiAgentEndEvent {
  type?: string;
  /** AgentMessage[] — opaque; not forwarded (Stop policies don't need it). */
  messages?: unknown[];
  cwd?: string;
  sessionId?: string;
}

/** Pi v0.73.x before_agent_start event payload. Fires once per turn,
 *  after the user submits a prompt but before the agent loop runs. */
interface PiBeforeAgentStartEvent {
  type?: string;
  prompt?: string;
  /** The fully assembled system prompt for this turn — we append to it. */
  systemPrompt?: string;
  cwd?: string;
  sessionId?: string;
}

interface PiExtensionApi {
  on(event: string, handler: (event: unknown) => unknown): void;
}

export default function failproofaiBridge(pi: PiExtensionApi) {
  // tool_call → PreToolUse. Block tool execution when failproofai denies.
  pi.on("tool_call", (event: unknown): unknown => {
    const e = event as PiToolCallEvent;
    const canonicalTool = canonicalizeToolName(e.toolName);
    const decision = callPolicy("tool_call", {
      tool_name: canonicalTool,
      tool_input: canonicalizeToolInput(canonicalTool, e.input),
      session_id: resolveSessionId(e.sessionId, resolveCwd(e.cwd)),
      cwd: resolveCwd(e.cwd),
      hook_event_name: "PreToolUse",
    });
    if (decision.block) return { block: true, reason: decision.reason };
    return undefined;
  });

  // user_bash → PreToolUse with synthesized toolName=Bash.
  pi.on("user_bash", (event: unknown): unknown => {
    const e = event as PiUserBashEvent;
    const decision = callPolicy("user_bash", {
      tool_name: "Bash",
      tool_input: { command: e.command },
      session_id: resolveSessionId(e.sessionId, resolveCwd(e.cwd)),
      cwd: resolveCwd(e.cwd),
      hook_event_name: "PreToolUse",
    });
    if (decision.block) return { block: true, reason: decision.reason };
    return undefined;
  });

  // input → UserPromptSubmit. Honor block decisions if Pi accepts them
  // (Pi's docs describe block on input but it's not exhaustively tested).
  pi.on("input", (event: unknown): unknown => {
    const e = event as PiInputEvent;
    const decision = callPolicy("input", {
      prompt: e.text,
      session_id: resolveSessionId(e.sessionId, resolveCwd(e.cwd)),
      cwd: resolveCwd(e.cwd),
      hook_event_name: "UserPromptSubmit",
    });
    if (decision.block) return { block: true, reason: decision.reason };
    return undefined;
  });

  // session_start → SessionStart. Observe-only; we still forward so the
  // activity feed records the session and any UserPromptSubmit policies that
  // need session_id continuity see the metadata.
  pi.on("session_start", (event: unknown): unknown => {
    const e = event as PiSessionStartEvent;
    callPolicy("session_start", {
      session_id: resolveSessionId(e.sessionId, resolveCwd(e.cwd)),
      cwd: resolveCwd(e.cwd),
      reason: e.reason,
      hook_event_name: "SessionStart",
    });
    return undefined;
  });

  // tool_result → PostToolUse. Observation-only on Pi: ToolResultEventResult
  // exposes {content, details, isError} for mutation but no `block`. We
  // forward to the failproofai binary so PostToolUse builtins (sanitize-jwt,
  // sanitize-api-keys, sanitize-connection-strings, sanitize-private-key-
  // content, sanitize-bearer-tokens) run and get their decisions logged to
  // the activity store + stderr — but Pi keeps the original tool result.
  pi.on("tool_result", (event: unknown): unknown => {
    const e = event as PiToolResultEvent;
    const canonicalTool = canonicalizeToolName(e.toolName);
    callPolicy("tool_result", {
      tool_name: canonicalTool,
      tool_input: canonicalizeToolInput(canonicalTool, e.input) ?? {},
      tool_response: { content: e.content, isError: e.isError },
      session_id: resolveSessionId(e.sessionId, resolveCwd(e.cwd)),
      cwd: resolveCwd(e.cwd),
      hook_event_name: "PostToolUse",
    });
    return undefined;
  });

  // agent_end → Stop. Pi cannot veto agent_end (the agent loop has already
  // exited when this fires — see the AgentEndEvent typedef in pi-coding-agent
  // which has NO Result type). Instead we capture any deny reason and stash
  // it keyed by sessionId for the next before_agent_start handler to drain.
  // The 5 require-*-before-stop builtins thus enforce by gating the NEXT
  // user turn's system prompt rather than by retrying the same loop. If the
  // user kills Pi between turns, the gate is missed — same bound Claude has.
  pi.on("agent_end", (event: unknown): unknown => {
    const e = event as PiAgentEndEvent;
    const cwd = resolveCwd(e.cwd);
    const sessionId = resolveSessionId(e.sessionId, cwd);
    const decision = callPolicy("agent_end", {
      session_id: sessionId,
      cwd,
      hook_event_name: "Stop",
    });
    if (decision.block && decision.reason && sessionId) {
      pendingStopBlockBySession.set(sessionId, decision.reason);
      debug(`agent_end deny stored for session=${sessionId}`);
    }
    return undefined;
  });

  // before_agent_start → drain any pending Stop-policy deny captured at
  // agent_end. This is Pi's only first-class channel to influence the next
  // turn before the LLM call: the result type accepts a `systemPrompt`
  // replacement (chained across extensions) and an optional injected
  // CustomMessage. We only return systemPrompt — sufficient for the LLM to
  // see the MANDATORY ACTION directive immediately, and avoids polluting the
  // visible conversation history with framework chrome. The reason text
  // already carries the policy-attributed MANDATORY ACTION wording from
  // policy-evaluator's Pi-Stop branch.
  pi.on("before_agent_start", (event: unknown): unknown => {
    const e = event as PiBeforeAgentStartEvent;
    const cwd = resolveCwd(e.cwd);
    const sessionId = resolveSessionId(e.sessionId, cwd);
    if (!sessionId) return undefined;
    const pending = pendingStopBlockBySession.get(sessionId);
    if (!pending) return undefined;
    pendingStopBlockBySession.delete(sessionId);
    debug(`before_agent_start drains stop-block for session=${sessionId}`);
    const base = e.systemPrompt ?? "";
    return { systemPrompt: `${base}\n\n${pending}` };
  });

  // session_shutdown → SessionEnd. Observation-only; emits a SessionEnd
  // record so per-session telemetry has a clean close. Reset the per-cwd
  // sessionId cache for shutdown reasons that mean "Pi is starting a new
  // session in the same process" — without the reset, the next session's
  // events would inherit the prior session's id until disk discovery
  // refreshed it.
  pi.on("session_shutdown", (event: unknown): unknown => {
    const e = event as PiSessionShutdownEvent;
    const cwd = resolveCwd(e.cwd);
    callPolicy("session_shutdown", {
      session_id: resolveSessionId(e.sessionId, cwd),
      cwd,
      reason: e.reason,
      hook_event_name: "SessionEnd",
    });
    // Capture sessionId BEFORE the cache reset so we delete the pending
    // entry under the just-ending session's id. After resetSessionIdCache,
    // a subsequent resolveSessionId would re-discover from disk and could
    // bind to a different (stale) file — wrong key for the cleanup below.
    const sessionId = resolveSessionId(e.sessionId, cwd);
    if (e.reason === "new" || e.reason === "resume" || e.reason === "fork") {
      resetSessionIdCache(cwd);
    }
    // Drop any pending Stop-policy deny for this session on every shutdown
    // reason — `quit` ends the session for good (don't leak the entry into
    // GC); `new`/`resume`/`fork` start a different session in the same
    // process and must not inherit the prior session's gate.
    if (sessionId) pendingStopBlockBySession.delete(sessionId);
    return undefined;
  });
}
