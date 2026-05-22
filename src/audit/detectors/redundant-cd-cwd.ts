import type { Detector } from "../types";

/** Bash command starting with `cd <absolute-path> && …` where the absolute
 *  path equals (or is the same realpath as) the session's cwd. The agent's
 *  shell already runs in cwd — the prefix is pure waste. Explicitly called
 *  out in the Claude Code system prompt for git commands. */
export const redundantCdCwd: Detector = {
  name: "redundant-cd-cwd",
  description:
    "Bash commands prefixed with `cd <cwd> && …` even though commands already run in cwd.",
  category: "Wasteful",
  severity: "info",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string" || !event.cwd) return null;
    const trimmed = command.trimStart();
    const match = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*([\s\S]+)$/.exec(trimmed);
    if (!match) return null;
    const path = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\/+$/, "");
    const cwd = event.cwd.replace(/\/+$/, "");
    if (path !== cwd) return null;
    const rest = match[4].trim();
    return { example: `cd ${path} && ${rest}` };
  },
};
