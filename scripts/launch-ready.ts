/**
 * Watches the dashboard server start, so the launch screen can say it is live.
 *
 * Only `start` mode can: it pipes the standalone server's output, which is
 * where Next says it is listening. Three signals decide the start, in order of
 * preference:
 *
 *  - Next's `Ready in` line on stdout (`makeNextStartupFilter`), logged from the
 *    server's own `listening` handler.
 *  - A TCP connect to the bind address, tried every 250ms once 5s have passed
 *    with no ready line: a Next upgrade that rewords the line must not leave
 *    the screen waiting for the deadline.
 *  - The server exiting first. That is a failure to start, and the cause is in
 *    what it wrote to stderr.
 *
 * Until then the server's output is held back, so the screen opens the output
 * rather than appearing halfway down it. After 30s with no answer the screen
 * prints anyway, marked as still starting, and Next's own banner is let through
 * from then on, so a late start still says when it happened.
 */
// Aliased: in the scope-hoisted CLI bundle a bare `connect` binding would make
// the bundler rename every local `connect` elsewhere (the setup wizard has one).
import { connect as connectDashboardProbe } from "node:net";
import { createInterface } from "node:readline";
import type { EventEmitter } from "node:events";
import { makeNextStartupFilter, makeSkewLogFilter } from "./skew-log-filter";

export interface DashboardChild extends EventEmitter {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
}

export interface DashboardSink {
  write(chunk: string): unknown;
}

export type DashboardStartOutcome =
  | { kind: "ready"; via: "ready-line" | "probe" }
  | { kind: "timeout" }
  | { kind: "failed"; code: number | null; portInUse: boolean; cause: string | null };

export interface DashboardStartWatch {
  child: DashboardChild;
  stdout: DashboardSink;
  stderr: DashboardSink;
  /** True once something accepts a connection on the bind address and port. */
  probe: () => Promise<boolean>;
  /**
   * Called once, when the start is decided. The held-back output is released
   * right after it for a ready or a timeout, so the screen comes first, and
   * right before it for a failure, so the ✕ line comes last.
   */
  onSettled: (outcome: DashboardStartOutcome) => void;
  /** The server exited, or errored, after the start was decided. */
  onExit: (code: number | null, error?: Error) => void;
  probeAfterMs?: number;
  probeEveryMs?: number;
  timeoutMs?: number;
  /** How long to wait after `exit` for the streams to close, in case a grandchild holds them open. */
  exitGraceMs?: number;
}

export function watchDashboardStart(watch: DashboardStartWatch): void {
  const probeAfterMs = watch.probeAfterMs ?? 5_000;
  const probeEveryMs = watch.probeEveryMs ?? 250;
  const timeoutMs = watch.timeoutMs ?? 30_000;
  const exitGraceMs = watch.exitGraceMs ?? 500;
  // A server that floods its output before it listens stops being held back
  // past this many lines, and so does what is kept to find a failure's cause.
  const holdLimit = 2_000;

  let starting = true;
  let holding = true;
  let bannerActive = true;
  let finished = false;
  const held: Array<{ sink: DashboardSink; line: string; fromStderr: boolean }> = [];
  const startupText: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const release = (dropStderr: boolean): void => {
    holding = false;
    for (const entry of held.splice(0)) {
      if (!(dropStderr && entry.fromStderr)) entry.sink.write(`${entry.line}\n`);
    }
  };

  const decide = (outcome: DashboardStartOutcome): void => {
    if (!starting) return;
    starting = false;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (outcome.kind === "failed") {
      // Next's own dump for a port in use is a stack trace that says what the
      // ✕ line already says; anything else is the evidence, and stays.
      release(outcome.portInUse);
      watch.onSettled(outcome);
      return;
    }
    if (outcome.kind === "timeout") bannerActive = false;
    try {
      watch.onSettled(outcome);
    } finally {
      release(false);
    }
  };

  const pipe = (src: NodeJS.ReadableStream | null, sink: DashboardSink, fromStderr: boolean): void => {
    if (!src) return;
    // One of each per stream: both filters are stateful.
    const skew = makeSkewLogFilter();
    const banner = fromStderr ? null : makeNextStartupFilter(() => decide({ kind: "ready", via: "ready-line" }));
    createInterface({ input: src, crlfDelay: Infinity }).on("line", (raw) => {
      let line = skew(raw);
      if (line !== null && banner && bannerActive) line = banner(line);
      if (line === null) return;
      if (starting && startupText.length < holdLimit) startupText.push(line);
      if (holding && held.length >= holdLimit) release(false);
      if (holding) held.push({ sink, line, fromStderr });
      else sink.write(`${line}\n`);
    });
  };
  pipe(watch.child.stdout, watch.stdout, false);
  pipe(watch.child.stderr, watch.stderr, true);

  const probeOnce = (): void => {
    if (!starting) return;
    const next = (): void => {
      if (starting) later(probeOnce, probeEveryMs);
    };
    let attempt: Promise<boolean>;
    try {
      attempt = watch.probe();
    } catch {
      next();
      return;
    }
    attempt.then((up) => {
      if (!starting) return;
      if (up) decide({ kind: "ready", via: "probe" });
      else next();
    }, next);
  };
  later(probeOnce, probeAfterMs);
  later(() => decide({ kind: "timeout" }), timeoutMs);

  // `close` comes after the streams have ended, so the last lines (where the
  // cause is) have been read. `exit` alone can arrive first; the grace timer
  // covers a grandchild that keeps a stream open and so delays `close`.
  let grace: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number | null, error?: Error): void => {
    if (finished) return;
    finished = true;
    if (grace) clearTimeout(grace);
    if (!starting) {
      watch.onExit(code, error);
      return;
    }
    const portInUse = !error && startupText.some((line) => line.includes("EADDRINUSE"));
    decide({
      kind: "failed",
      code,
      portInUse,
      cause: error ? error.message : portInUse ? null : dashboardStartupCause(startupText),
    });
  };
  watch.child.on("exit", (code: number | null) => {
    if (grace === undefined) grace = setTimeout(() => finish(code), exitGraceMs);
  });
  watch.child.on("close", (code: number | null) => finish(code));
  watch.child.on("error", (error: Error) => finish(null, error));
}

/**
 * The line that says why the server stopped: the first `Error:` line (Node
 * prints the message first), else Next's first `⨯` line. A plain `Error: `
 * prefix is dropped as noise; a named one (`TypeError: …`) is kept.
 */
export function dashboardStartupCause(lines: readonly string[]): string | null {
  const plain = lines.map((line) => line.replace(/\x1B\[[0-9;]*m/g, "").trim());
  for (const line of plain) {
    const match = /(?:^|[\s[])((?:[A-Z][A-Za-z]*)?Error): (.+)$/.exec(line);
    if (match) return match[1] === "Error" ? match[2].trim() : `${match[1]}: ${match[2].trim()}`;
  }
  for (const line of plain) {
    if (line.startsWith("⨯ ")) return line.slice(2).trim();
  }
  return null;
}

/** Where to probe for a bind address: a wildcard bind answers on loopback. */
export function dashboardProbeHost(bindHost: string): string {
  const raw = bindHost.trim();
  if (raw === "" || raw === "0.0.0.0") return "127.0.0.1";
  if (raw === "::" || raw === "[::]" || raw === "0:0:0:0:0:0:0:0") return "::1";
  return raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
}

/** One TCP connect: true when something accepts it within `timeoutMs`. */
export function probeDashboardPort(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((settle) => {
    let socket: ReturnType<typeof connectDashboardProbe>;
    try {
      socket = connectDashboardProbe({ host, port });
    } catch {
      // A port that is not a port (`--port abc`) throws here; the server has
      // already failed on it, and its exit says why.
      settle(false);
      return;
    }
    let answered = false;
    const answer = (up: boolean): void => {
      if (answered) return;
      answered = true;
      socket.destroy();
      settle(up);
    };
    socket.setTimeout(timeoutMs, () => answer(false));
    socket.once("connect", () => answer(true));
    socket.once("error", () => answer(false));
  });
}
