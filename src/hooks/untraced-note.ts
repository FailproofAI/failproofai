/**
 * A hook event from an agent that `failproofai config` does not trace.
 *
 * A NOTE, never a decision. Hooks for an untraced agent can exist on purpose:
 * committed to a repository's project scope, left in another checkout, or read
 * by VS Code's agent mode from a file another integration wrote. Allowing such
 * a call because the agent is unticked in setup would turn a guard somebody did
 * install into a hole, so the event is evaluated exactly as usual and the log
 * says, once per session, where it came from.
 *
 * "Once per session" needs a record on disk: on the in-process path every hook
 * is its own process. The record is one small file of recent keys, bounded, so
 * it never grows with the number of sessions. Nothing here may throw on the hook
 * path.
 */
import { existsSync, readFileSync } from "node:fs";

import { writeJsonAtomically } from "../../lib/atomic-write";
import { isAgentTraced, readConfig, type FpConfig } from "./fp-config";
import { stateDir } from "./fp-home";
import { hookLogInfo } from "./hook-logger";
import { join } from "node:path";

/** How many session keys the record keeps; the oldest go first. */
const UNTRACED_NOTE_KEEP = 200;

export function untracedNotePath(home?: string): string {
  return join(stateDir(home), "untraced-notes.json");
}

/** True when this call logged the note — for tests. */
export function noteUntracedAgent(cli: string, sessionId: string | undefined, config?: FpConfig): boolean {
  try {
    if (isAgentTraced(cli, config ?? readConfig())) return false;
    const key = `${cli}:${sessionId ?? "no-session"}`;
    const path = untracedNotePath();
    let seen: string[] = [];
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) seen = parsed.filter((k): k is string => typeof k === "string");
    }
    if (seen.includes(key)) return false;
    writeJsonAtomically(path, [...seen, key].slice(-UNTRACED_NOTE_KEEP));
    hookLogInfo(
      `${cli} is not one of the agents failproofai config traces, but a hook for it fired` +
        `${sessionId ? ` (session ${sessionId})` : ""}. Its calls are evaluated as usual: a hook somebody installed keeps enforcing.`,
    );
    return true;
  } catch {
    return false;
  }
}
