import type { Detector } from "../types";

const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|scala|sh|bash|zsh|json|yaml|yml|toml|md|txt|sql|html|css|scss|sass)$/i;

/** `cat | head | tail | less | more` invoked on a single source file with no
 *  shell pipeline / redirection. The Read tool is the right answer. .env files
 *  are intentionally excluded (covered by `block-env-files`). */
export const preferEditOverReadCat: Detector = {
  name: "prefer-edit-over-read-cat",
  description: "Bash `cat`/`head`/`tail`/`less`/`more` on a single source file — use Read.",
  category: "Wasteful",
  severity: "info",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command.trim();
    // Reject any shell pipeline, redirection, command chaining or substitution.
    if (/[|<>;&`$()]/.test(cmd)) return null;
    const match = /^(cat|head|tail|less|more)\s+(?:-\S+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd);
    if (!match) return null;
    const path = match[2] ?? match[3] ?? match[4] ?? "";
    if (!path) return null;
    // .env is covered by block-env-files; skip to avoid double-counting.
    if (/(?:^|\/)\.env(?:\..+)?$/.test(path)) return null;
    if (!SOURCE_EXT_RE.test(path)) return null;
    return { example: cmd };
  },
};
