import type { Detector } from "../types";

const SLEEP_THRESHOLD_SECONDS = 30;

/** Bash `sleep N` where N ≥ 30 (busy polling), or `while …; sleep …; done`. */
export const sleepPollingLoop: Detector = {
  name: "sleep-polling-loop",
  description: "Bash long `sleep` or while-sleep polling loops.",
  category: "Wasteful",
  severity: "info",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command;
    // while-sleep loop
    if (/\bwhile\b[\s\S]*?\bsleep\b[\s\S]*?\bdone\b/.test(cmd)) {
      return { example: cmd.replace(/\s+/g, " ").trim().slice(0, 160) };
    }
    // Standalone long sleep
    const match = /\bsleep\s+(\d+)(?:\.\d+)?(m|h|d)?\b/.exec(cmd);
    if (match) {
      const n = parseInt(match[1], 10);
      const unit = match[2] ?? "s";
      const seconds = unit === "m" ? n * 60 : unit === "h" ? n * 3600 : unit === "d" ? n * 86400 : n;
      if (seconds >= SLEEP_THRESHOLD_SECONDS) {
        return { example: cmd.replace(/\s+/g, " ").trim().slice(0, 160) };
      }
    }
    return null;
  },
};
