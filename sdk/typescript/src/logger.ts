/**
 * The one logging surface for this SDK.
 *
 * Python's SDK reaches for `logging.getLogger(__name__)`, which gives the host
 * application a named, level-filtered, individually-silenceable channel for
 * free. Node has no stdlib equivalent, and this package is contractually
 * zero-dependency, so it cannot pull in `pino` or `debug` — a telemetry library
 * that installs into other people's agent processes must not hand them a
 * dependency they did not choose.
 *
 * So: a minimal level-filtered logger over `console`, with a `setLogger()`
 * escape hatch so a host that already has structured logging can route ours
 * into it rather than having two formats interleaved on stderr.
 *
 * DEFAULT LEVEL IS `warn`, deliberately. Every `logger.warning(...)` in the
 * ported modules marks a condition that silently costs the caller telemetry —
 * a full queue, a dropped event, an unresolvable session. Defaulting to
 * `error` would hide exactly the messages that exist because the failure is
 * otherwise invisible; defaulting to `info` would put startup chatter into
 * somebody's agent output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function envLevel(): LogLevel {
  const raw = (process.env.FAILPROOFAI_SDK_LOG_LEVEL ?? "").trim().toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "warn";
}

let level: LogLevel = envLevel();
let sink: Logger | null = null;

/** Route this SDK's log lines into the host's own logger. `null` restores the default. */
export function setLogger(next: Logger | null): void {
  sink = next;
}

/** Override the level. Also readable from `FAILPROOFAI_SDK_LOG_LEVEL`. */
export function setLogLevel(next: LogLevel): void {
  level = next;
}

/** Re-read `FAILPROOFAI_SDK_LOG_LEVEL`. Used by tests that mutate the environment. */
export function resetLogLevel(): void {
  level = envLevel();
}

function emit(
  method: "debug" | "info" | "warn" | "error",
  message: string,
  args: unknown[],
): void {
  if (ORDER[method] < ORDER[level]) return;
  // A logger that throws is a logger that takes the host agent down over a
  // diagnostic. Nothing in this file may do that.
  try {
    if (sink) {
      sink[method](message, ...args);
      return;
    }
    // `console.warn`/`console.error` go to stderr, which is where a library's
    // diagnostics belong: stdout is frequently the agent's own protocol channel
    // (an MCP server speaks JSON-RPC over it) and writing there corrupts it.
    const line = `[failproofai-sdk] ${message}`;
    if (method === "warn") console.warn(line, ...args);
    else console.error(line, ...args);
  } catch {
    /* empty */
  }
}

export const logger: Logger = {
  debug: (message, ...args) => emit("debug", message, args),
  info: (message, ...args) => emit("info", message, args),
  warn: (message, ...args) => emit("warn", message, args),
  error: (message, ...args) => emit("error", message, args),
};

/** `logger.error` plus the error's stack, mirroring Python's `logger.exception`. */
export function logException(message: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  emit("error", `${message}: ${detail}`, []);
}
