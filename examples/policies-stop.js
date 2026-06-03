/**
 * policies-stop.js — Stop event hook example
 *
 * Demonstrates intercepting the `Stop` event that fires when the AI agent
 * finishes a task and is about to exit. The hook enforces a pre-exit gate:
 *   - BLOCK the stop if there are uncommitted git changes
 *   - ALLOW the stop (with a logged summary) when the working tree is clean
 *
 * Install:
 *   failproofai --install-hooks custom ./examples/policies-stop.js
 *
 * Test:
 *   1. Make a dirty working tree (e.g. `echo x >> scratch.txt`) and let Claude
 *      finish a task. The hook will deny the stop with a human-readable reason.
 *   2. Commit or stash everything, then let Claude finish — the hook will allow
 *      the stop and append a line to `task-summary.log`.
 */
import { customPolicies, allow, deny } from "failproofai";
import { execSync } from "child_process";
import fs from "fs";

customPolicies.add({
  name: "enforce-stop-cleanup-and-checks",
  description:
    "Gate the agent's exit: block if uncommitted changes exist, allow and log a summary otherwise.",
  match: { events: ["Stop"] },
  fn: async (ctx) => {
    // ── "Block the stop" path ─────────────────────────────────────────
    // WHY: An AI agent that exits with uncommitted changes leaves the
    //      developer in an ambiguous state — did the task succeed?  Were
    //      the edits intentional?  Blocking the stop forces the agent to
    //      commit or stash first, producing a clean audit trail.
    try {
      const status = execSync("git status --porcelain", { encoding: "utf8" });
      if (status.trim().length > 0) {
        return deny(
          "Uncommitted changes detected. Please commit or stash before stopping."
        );
      }
    } catch {
      // If git is unavailable or the cwd isn't a repo, skip the check
      // rather than crashing the hook — graceful degradation is important
      // so the hook doesn't block every non-git project.
    }

    // ── "Let it stop" path ────────────────────────────────────────────
    // WHY: When the working tree is clean we know the task's output has
    //      been captured in a commit.  We take a side-effect action
    //      (appending to a log file) so the team has an out-of-band
    //      record that the session completed, then allow the exit.
    try {
      const timestamp = new Date().toISOString();
      const sessionId = ctx.session?.sessionId ?? "unknown";
      fs.appendFileSync(
        "task-summary.log",
        `[${timestamp}] session=${sessionId} — task completed, stop allowed\n`
      );
    } catch {
      // Logging is best-effort; never block the agent just because the
      // log file couldn't be written.
    }

    return allow();
  },
});
