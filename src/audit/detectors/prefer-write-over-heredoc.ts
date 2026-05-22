import type { Detector } from "../types";

/** `cat << EOF > file` heredoc patterns or `echo … > file` writing multi-line
 *  content. The Write tool is the right answer. */
export const preferWriteOverHeredoc: Detector = {
  name: "prefer-write-over-heredoc",
  description: "Bash heredoc / `echo > file` writing multi-line content — use Write.",
  category: "Wasteful",
  severity: "info",
  detect(event) {
    if (event.toolName !== "Bash") return null;
    const command = (event.toolInput as { command?: unknown }).command;
    if (typeof command !== "string") return null;
    const cmd = command;
    // Heredoc redirected to a file IMMEDIATELY after the delimiter:
    //   `cat <<'EOF' > path`   ← match (heredoc opens AND redirects in one step)
    //   `cat <<EOF` inside `$(...)` ← skip (heredoc captured by command substitution,
    //                                   later `> file` is unrelated)
    // The redirect must appear before the next whitespace/newline that ends the
    // heredoc opener line — otherwise it's a body or downstream redirect.
    if (/<<-?\s*['"]?[A-Z_]+['"]?\s*>\s*\S/.test(cmd)) {
      const summary = cmd.replace(/\s+/g, " ").trim().slice(0, 160);
      return { example: summary };
    }
    // `echo "multi\nline" > file` or `printf "..." > file` with embedded newlines.
    if (/(?:^|\s|;|&&|\|\|)(?:echo|printf)\s+["'][^"']*\n[^"']*["']\s*>\s*\S/.test(cmd)) {
      const summary = cmd.replace(/\s+/g, " ").trim().slice(0, 160);
      return { example: summary };
    }
    return null;
  },
};
