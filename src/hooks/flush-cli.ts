/**
 * `failproofai flush` — deliver what is already spooled, now.
 *
 * The collector is built to be unhurried on purpose. A batch is swept only once
 * it is older than two minutes, at most 64 per pass, on a 60-second cadence —
 * pacing that keeps a backlog from stampeding a server and is exactly wrong for
 * one case: somebody standing at a dashboard waiting to see their own events.
 * They have no way to tell "not delivered yet" from "not working", and the
 * honest answer is usually the first one.
 *
 * WHY A REQUEST FILE, not the work itself. The uploader's concurrency limiter
 * and in-flight set live in the running daemon. A second uploader started by
 * the CLI would share neither, so both would POST the same batch — the exact
 * double-delivery `delivery.rs` keeps one shared `Delivery` to prevent. So this
 * writes a request the daemon drains on its next tick.
 *
 * What it does NOT hand off is the checking — same rule as `backfill-cli.ts`.
 * Every precondition a person can get wrong is verified here, synchronously,
 * before returning success. A CLI that prints "requested" while the daemon is
 * stopped has told the user the opposite of what happened.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { failproofaiHome, spoolDir } from "./fp-home";
import { readConfig } from "./fp-config";
import { readIngestCredential } from "./collector-config";
import { daemonServiceStatus, isDaemonSupportedPlatform } from "./daemon-service";

/** How long `--wait` blocks by default. */
export const DEFAULT_FLUSH_TIMEOUT_SECS = 60;

export interface FlushOptions {
  wait?: boolean;
  timeoutSecs?: number;
  home?: string;
  /** Injected in tests so the wait loop does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FlushResult {
  exitCode: number;
  lines: string[];
  /** Batches still spooled when we stopped looking. */
  pending: number;
}

/** Mirrored from the daemon's `paths::flush_request_path()`. */
export function flushRequestPath(home?: string): string {
  return join(failproofaiHome(home), "state", "flush-request.json");
}

/** Every directory the collector spools batches into. */
function spoolDirs(home?: string): string[] {
  const root = spoolDir(home);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "failed")
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/** Batches awaiting delivery. `.tmp` files are half-written and not counted. */
export function pendingBatches(home?: string): number {
  let n = 0;
  for (const dir of spoolDirs(home)) {
    try {
      n += readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      // A directory that vanished mid-scan is one the collector just drained.
    }
  }
  return n;
}

export async function runFlushCommand(opts: FlushOptions = {}): Promise<FlushResult> {
  const { home, wait = false } = opts;
  const timeoutSecs = opts.timeoutSecs ?? DEFAULT_FLUSH_TIMEOUT_SECS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lines: string[] = [];

  // Preconditions, in the order that produces the most useful message. Each of
  // these makes a flush a no-op, and each has a different remedy.
  const cfg = readConfig();
  if (!cfg.collector?.hooks && !cfg.collector?.sessions) {
    return {
      exitCode: 1,
      pending: 0,
      lines: [
        "Collection is off, so nothing is spooled to flush.",
        "Turn it on with `failproofai config`.",
      ],
    };
  }

  if (!readIngestCredential()) {
    return {
      exitCode: 1,
      pending: 0,
      lines: [
        "This machine is not connected, so there is nowhere to flush to.",
        "Connect it with `failproofai config`.",
      ],
    };
  }

  if (isDaemonSupportedPlatform()) {
    const status = daemonServiceStatus();
    if (status !== "running") {
      return {
        exitCode: 1,
        pending: pendingBatches(home),
        lines: [
          `failproofaid is ${status}, and it is what delivers batches.`,
          "Start it with `failproofai config`.",
        ],
      };
    }
  }

  const before = pendingBatches(home);
  if (before === 0) {
    return { exitCode: 0, pending: 0, lines: ["Nothing spooled — everything already delivered."] };
  }

  const path = flushRequestPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ requestedAtMs: Date.now() }, null, 2)}\n`, {
    mode: 0o600,
  });

  lines.push(`${before} batch${before === 1 ? "" : "es"} spooled. Requested delivery.`);

  if (!wait) {
    lines.push("The daemon picks this up within a few seconds.");
    return { exitCode: 0, pending: before, lines };
  }

  // `--wait` exists so a script can flush and then assert. Poll the spool
  // rather than the server: the question is whether THIS machine still holds
  // events, and the spool is the only place that can answer it locally.
  const deadline = Date.now() + timeoutSecs * 1000;
  let pending = before;
  while (Date.now() < deadline) {
    await sleep(1000);
    pending = pendingBatches(home);
    if (pending === 0) {
      lines.push("Spool drained.");
      return { exitCode: 0, pending: 0, lines };
    }
  }

  // A timeout is not necessarily a failure — a large backlog legitimately takes
  // longer than the budget — so say what is still outstanding rather than
  // calling it broken.
  lines.push(
    `Still ${pending} batch${pending === 1 ? "" : "es"} spooled after ${timeoutSecs}s.`,
    "Delivery continues in the background; re-run with a longer --timeout to keep watching.",
  );
  return { exitCode: 1, pending, lines };
}
