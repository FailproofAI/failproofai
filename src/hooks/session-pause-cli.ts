/**
 * `failproofai config --pause | --resume | --status`.
 *
 * Lives on `config` rather than as its own verb because `config` is the single
 * place this product configures anything. The state it writes is NOT config
 * though — see session-pause.ts for why a pause must never reach a file that
 * gets committed.
 */
import {
  PAUSE_CEILING_MS,
  clearPause,
  formatDuration,
  listActivePauses,
  parsePauseDuration,
  readActivePause,
  resolveSessionForCwd,
  writePause,
  type ActivePause,
} from "./session-pause";

export interface PauseCommandOptions {
  action: "pause" | "resume" | "status";
  /** Raw `--pause <duration>` argument, if any. */
  duration?: string;
  /** Explicit `--session <id>`. */
  sessionId?: string;
  /** `--all`. */
  all?: boolean;
  cwd?: string;
  now?: number;
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

function describe(pause: ActivePause, now: number): string {
  const remaining = formatDuration(Math.max(0, pause.expiresAt - now));
  const at = new Date(pause.expiresAt).toLocaleTimeString();
  const where = pause.cwd ? ` · ${pause.cwd}` : "";
  return `  ${pause.sessionId}  ${remaining} left (until ${at})${where}`;
}

export function runPauseCommand(opts: PauseCommandOptions): PauseCommandResult {
  const now = opts.now ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();

  if (opts.action === "status") {
    const active = listActivePauses(now);
    if (active.length === 0) {
      return { exitCode: 0, lines: ["Enforcement is active — nothing is paused."], affected: 0 };
    }
    return {
      exitCode: 0,
      lines: [
        `Enforcement paused for ${active.length} session${active.length === 1 ? "" : "s"}:`,
        ...active.map((p) => describe(p, now)),
        "",
        "Cloud-managed policies keep enforcing regardless.",
        "Resume early with: failproofai config --resume",
      ],
      affected: active.length,
    };
  }

  if (opts.action === "resume") {
    if (opts.all) {
      const active = listActivePauses(now);
      let cleared = 0;
      for (const pause of active) if (clearPause(pause.sessionId)) cleared++;
      return {
        exitCode: 0,
        lines: [cleared === 0 ? "Nothing was paused." : `Resumed enforcement for ${cleared} session(s).`],
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
      lines: [cleared ? "Enforcement resumed." : "Nothing was paused for that session."],
      affected: cleared ? 1 : 0,
    };
  }

  // pause
  let durationMs: number;
  try {
    durationMs = parsePauseDuration(opts.duration, effectiveCeilingMs());
  } catch (err) {
    return { exitCode: 1, lines: [err instanceof Error ? err.message : String(err)], affected: 0 };
  }

  const sessionId = opts.sessionId ?? resolveSessionForCwd(cwd, undefined, now);
  if (!sessionId) {
    // Deliberately an error, not a guess. Pausing the wrong session would leave
    // the user believing enforcement is off while it is on, or vice versa.
    return {
      exitCode: 1,
      lines: [
        "No recent agent session found for this directory.",
        "",
        "A pause applies to one agent session, and the session id only appears once",
        "an agent has run at least one tool call here. Either run your agent first,",
        "or name the session explicitly:",
        "",
        "  failproofai config --pause --session <id>",
        "",
        "Session ids are listed in the dashboard's activity view.",
      ],
      affected: 0,
    };
  }

  const existing = readActivePause(sessionId, now);
  const pause = writePause({ sessionId, durationMs, cwd, setBy: "cli", now });
  const until = new Date(pause.expiresAt).toLocaleTimeString();

  return {
    exitCode: 0,
    lines: [
      existing
        ? `Enforcement pause extended · ${formatDuration(durationMs)} · resumes at ${until}`
        : `Enforcement paused · ${formatDuration(durationMs)} · resumes at ${until}`,
      "",
      "  Builtin, custom and convention policies are suspended for this session.",
      "  Cloud-managed policies keep enforcing.",
      "",
      "It lifts on its own — no action needed. To end it early:",
      "  failproofai config --resume",
    ],
    affected: 1,
  };
}
