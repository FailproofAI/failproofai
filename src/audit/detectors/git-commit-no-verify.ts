import type { Detector } from "../types";

/** `git commit ... --no-verify` (or short `-n`) — skipping pre-commit hooks. */
export const gitCommitNoVerify: Detector = {
  name: "git-commit-no-verify",
  description: "git commit invoked with --no-verify / -n, skipping hooks.",
  category: "Risky",
  severity: "warn",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command;
    if (!/\bgit\s+commit\b/.test(cmd)) return null;
    if (/\s--no-verify\b/.test(cmd) || /\s-n\b/.test(cmd)) {
      return { example: cmd.replace(/\s+/g, " ").trim().slice(0, 160) };
    }
    return null;
  },
};
