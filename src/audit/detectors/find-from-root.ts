import type { Detector } from "../types";

const RISKY_ROOTS = ["/", "/home", "/usr", "/etc", "/var", "/opt", "/Users"];

/** Bash `find` invoked against the filesystem root or another high-level
 *  directory — tends to exhaust resources and rarely returns useful results. */
export const findFromRoot: Detector = {
  name: "find-from-root",
  description: "Bash `find` against `/`, `/home`, `/usr`, etc. — scope to cwd instead.",
  category: "Risky",
  severity: "warn",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command.trim();
    // find / OR find /home OR find "/etc" …  — first non-flag arg
    const match = /(?:^|[\s;|&])find\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)/.exec(cmd);
    if (!match) return null;
    const raw = match[1].replace(/^["']|["']$/g, "");
    const stripped = raw.replace(/\/+$/, "") || "/";
    if (!RISKY_ROOTS.includes(stripped)) return null;
    return { example: cmd.slice(0, 160) };
  },
};
