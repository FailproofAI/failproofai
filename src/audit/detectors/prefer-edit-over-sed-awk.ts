import type { Detector } from "../types";

/** In-place edits with `sed -i` or `awk … > file` that should have been done
 *  with the Edit tool. */
export const preferEditOverSedAwk: Detector = {
  name: "prefer-edit-over-sed-awk",
  description: "Bash `sed -i`/`awk` in-place edits — use Edit.",
  category: "Wasteful",
  severity: "info",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command.trim();
    // `sed -i ...` (GNU/macOS) or `sed -i'.bak' ...` (BSD-style)
    if (/(?:^|\s|;|&&|\|\|)sed\b[^|]*\s-i(?=\b|['"])/.test(cmd)) {
      return { example: cmd };
    }
    // `awk '...' file > out` or `awk '...' file > file` (in-place via redirection)
    if (/(?:^|\s|;|&&|\|\|)awk\b[^|]*\s>\s*\S+/.test(cmd) && !/\|/.test(cmd)) {
      return { example: cmd };
    }
    return null;
  },
};
