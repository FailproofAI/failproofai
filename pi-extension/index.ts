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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

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
 * Pi emits tool names in lowercase (`bash`, `read`, `edit`, `write`).
 * failproofai's builtin policies match on Claude-shaped capitalized names
 * (`Bash`, `Read`, `Edit`, `Write`). Map between the two so existing
 * tool-name match clauses fire on Pi sessions.
 */
function canonicalizeToolName(piToolName: string | undefined): string | undefined {
  if (!piToolName) return undefined;
  return piToolName.charAt(0).toUpperCase() + piToolName.slice(1);
}

/** Resolve the cwd for the policy payload. Pi events don't include cwd, so
 *  fall back to the extension's process.cwd() — which is where Pi was
 *  launched and where `.failproofai/` config lives. */
function resolveCwd(eventCwd: string | undefined): string {
  return eventCwd ?? process.cwd();
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

interface PiExtensionApi {
  on(event: string, handler: (event: unknown) => unknown): void;
}

export default function failproofaiBridge(pi: PiExtensionApi) {
  // tool_call → PreToolUse. Block tool execution when failproofai denies.
  pi.on("tool_call", (event: unknown): unknown => {
    const e = event as PiToolCallEvent;
    const decision = callPolicy("tool_call", {
      tool_name: canonicalizeToolName(e.toolName),
      tool_input: e.input,
      session_id: e.sessionId,
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
      session_id: e.sessionId,
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
      session_id: e.sessionId,
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
      session_id: e.sessionId,
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
    callPolicy("tool_result", {
      tool_name: canonicalizeToolName(e.toolName),
      tool_input: e.input ?? {},
      tool_response: { content: e.content, isError: e.isError },
      session_id: e.sessionId,
      cwd: resolveCwd(e.cwd),
      hook_event_name: "PostToolUse",
    });
    return undefined;
  });

  // agent_end → Stop. Observation-only on Pi: the agent loop has already
  // exited when this fires, so a deny decision cannot keep Pi running the
  // way Claude's exit-2-from-Stop can. We still forward so the 5
  // require-*-before-stop builtins run and log their findings (visible in
  // the dashboard's activity feed and stderr) — best-effort visibility.
  pi.on("agent_end", (event: unknown): unknown => {
    const e = event as PiAgentEndEvent;
    callPolicy("agent_end", {
      session_id: e.sessionId,
      cwd: resolveCwd(e.cwd),
      hook_event_name: "Stop",
    });
    return undefined;
  });

  // session_shutdown → SessionEnd. Observation-only; emits a SessionEnd
  // record so per-session telemetry has a clean close.
  pi.on("session_shutdown", (event: unknown): unknown => {
    const e = event as PiSessionShutdownEvent;
    callPolicy("session_shutdown", {
      session_id: e.sessionId,
      cwd: resolveCwd(e.cwd),
      reason: e.reason,
      hook_event_name: "SessionEnd",
    });
    return undefined;
  });
}
