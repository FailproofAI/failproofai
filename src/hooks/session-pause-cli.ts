/**
 * `failproofai config --pause | --resume`.
 *
 * Lives on `config` rather than as its own verb because `config` is the single
 * place this product configures anything. The state it writes is NOT config
 * though — see session-pause.ts for why a pause must never reach a file that
 * gets committed.
 *
 * `--status` used to be answered here too. It is a whole-machine screen now
 * (config-status.ts), which lists every pause among the rest of the machine's
 * state; this module keeps the two commands that change a pause.
 */
import {
  PAUSE_CEILING_MS,
  clearPause,
  listActivePauses,
  parsePauseDuration,
  readActivePause,
  resolveSessionForCwd,
  writePause,
} from "./session-pause";
import { INDENT, optsFor, screenKit, type RenderOpts } from "./tui";

/**
 * How a clock time is written. Both default to the machine's own, which is what
 * a person reading their terminal expects; tests pin them so the output does not
 * depend on where the suite runs.
 */
export interface PauseClock {
  locale?: string;
  timeZone?: string;
}

export interface PauseCommandOptions {
  action: "pause" | "resume";
  /** Raw `--pause <duration>` argument, if any. */
  duration?: string;
  /** Explicit `--session <id>`. */
  sessionId?: string;
  /** `--all`. */
  all?: boolean;
  cwd?: string;
  now?: number;
  /** Width and colour. Defaults to the stream the result is printed on. */
  render?: RenderOpts;
  clock?: PauseClock;
}

export interface PauseCommandResult {
  exitCode: number;
  lines: string[];
  /** For telemetry; never the session id itself. */
  affected: number;
}

/**
 * The ceiling on a single `--pause`.
 *
 * Took a `cwd` and consulted `readMergedHooksConfig(cwd).maxPauseMs` to let a
 * project LOWER it. That path was dead: the merge in `hooks-config.ts` builds
 * its result field by field and never emits `maxPauseMs`, so the lookup could
 * only ever read `undefined` — and the two tests that claimed to cover it
 * `vi.mock`ed `readMergedHooksConfig` to return a field the real function
 * cannot produce, which is why the gap survived. The knob is removed rather
 * than wired up: nothing documented it, nothing could have used it, and the
 * hard ceiling was doing all the work already.
 *
 * Kept as a function, and still the only thing `--pause` measures against, so
 * reinstating a config lowering later is a change in one place.
 */
export function effectiveCeilingMs(): number {
  return PAUSE_CEILING_MS;
}

/**
 * `14:32`, or `2:32 PM` — the locale's own clock, to the minute.
 *
 * Seconds are dropped: a pause is minutes long, and `14:32:07` puts the one
 * number a reader wants among two they do not.
 */
export function pauseClockTime(epochMs: number, clock: PauseClock = {}): string {
  return new Date(epochMs).toLocaleTimeString(clock.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(clock.timeZone ? { timeZone: clock.timeZone } : {}),
  });
}

/** `30 minutes`, `1 hour 30 minutes`, `45 seconds` — a duration in words. */
export function pauseDurationWords(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export function runPauseCommand(opts: PauseCommandOptions): PauseCommandResult {
  const now = opts.now ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();
  // Painted for the stream it lands on: a result goes to stdout and a refusal to
  // stderr, and only one of the two may be a terminal.
  const kitFor = (ok: boolean) => screenKit(opts.render ?? optsFor(ok ? process.stdout : process.stderr));
  // "this session" is the one resolved from this directory; a session named on
  // the command line is named back, so a pause set from elsewhere says whose it is.
  const target = (explicit: string | undefined) => (explicit ? `session ${explicit}` : "this session");

  if (opts.action === "resume") {
    const kit = kitFor(true);
    if (opts.all) {
      const active = listActivePauses(now);
      let cleared = 0;
      for (const pause of active) if (clearPause(pause.sessionId)) cleared++;
      return {
        exitCode: 0,
        lines: [
          cleared === 0
            ? "Nothing was paused."
            : kit.ok(`Resumed enforcement for ${cleared} session${cleared === 1 ? "" : "s"}.`),
        ],
        affected: cleared,
      };
    }
    const sessionId = opts.sessionId ?? resolveSessionForCwd(cwd, undefined, now);
    if (!sessionId) {
      return { exitCode: 0, lines: ["Nothing was paused for this directory."], affected: 0 };
    }
    const cleared = clearPause(sessionId);
    return {
      exitCode: 0,
      lines: [
        cleared
          ? kit.ok(`Resumed enforcement for ${target(opts.sessionId)}.`)
          : `Nothing was paused for ${opts.sessionId ? `session ${opts.sessionId}` : "that session"}.`,
      ],
      affected: cleared ? 1 : 0,
    };
  }

  // pause
  let durationMs: number;
  try {
    durationMs = parsePauseDuration(opts.duration, effectiveCeilingMs());
  } catch (err) {
    return {
      exitCode: 1,
      lines: [kitFor(false).fail(err instanceof Error ? err.message : String(err))],
      affected: 0,
    };
  }

  const sessionId = opts.sessionId ?? resolveSessionForCwd(cwd, undefined, now);
  if (!sessionId) {
    // Deliberately an error, not a guess. Pausing the wrong session would leave
    // the user believing enforcement is off while it is on, or vice versa.
    const kit = kitFor(false);
    const retry = `failproofai config --pause${opts.duration ? ` ${opts.duration}` : ""} --session <id>`;
    return {
      exitCode: 1,
      lines: [
        kit.fail("No recent agent session found for this directory."),
        `${INDENT}Name one from the dashboard's activity view:  ${kit.cmd(retry)}`,
      ],
      affected: 0,
    };
  }

  const kit = kitFor(true);
  const existing = readActivePause(sessionId, now);
  const pause = writePause({ sessionId, durationMs, cwd, setBy: "cli", now });
  // What was actually granted, not what was asked for: a renewal is capped at 8h
  // from the FIRST pause in the run, so it can be shorter than requested, and a
  // line repeating the request would misstate when enforcement comes back.
  const granted = Math.max(0, pause.expiresAt - now);
  const capped = pause.expiresAt < now + durationMs;
  const when = `until ${pauseClockTime(pause.expiresAt, opts.clock)} (${pauseDurationWords(granted)})`;
  const resume = opts.sessionId
    ? `failproofai config --resume --session ${opts.sessionId}`
    : "failproofai config --resume";

  return {
    exitCode: 0,
    lines: [
      kit.ok(
        existing
          ? `Extended the pause for ${target(opts.sessionId)} ${when}.`
          : `Paused enforcement for ${target(opts.sessionId)} ${when}.`,
      ),
      ...(capped
        ? [`${INDENT}Capped at ${pauseDurationWords(PAUSE_CEILING_MS)} from when this pause began.`]
        : []),
      `${INDENT}Cloud-managed policies keep enforcing.`,
      `${INDENT}Resume early:  ${kit.cmd(resume)}`,
    ],
    affected: 1,
  };
}
