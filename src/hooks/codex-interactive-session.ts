/**
 * Codex sessions may not open an interactive shell or REPL.
 *
 * Codex can leave a command running and type into it later (`exec_command`,
 * then `write_stdin`; in code mode both are called from inside its JavaScript
 * `exec` tool). It runs PreToolUse for the command that starts the session and
 * for nothing typed into it afterwards: in a live codex-cli 0.172 session the
 * only hook call was `Bash` with `{"command": "bash -i"}`, and
 * `failproofai policies list` typed into that shell ran unchecked (found by
 * hermes on FailproofAI/failproofai#1058, FailproofAI/agenteye#1898). Turning
 * `unified_exec` off does not remove those tools in code mode, and turning code
 * mode off leaves Codex's model with no shell at all.
 *
 * So the one point failproofai can enforce is the start: under Codex, a command
 * that opens a program which runs what is typed into it — a shell with no
 * script, an interpreter with no program, a multiplexer, a remote or container
 * shell, an editor or pager with a shell escape, a database client that can
 * shell out — is refused, and the agent is told to run each command on its own,
 * which Codex does hook. A server or build left running (`npm run dev`) stays
 * allowed: it does not run what is typed into it.
 *
 * The list cannot be complete: a program not named here that runs typed text
 * is not refused. Pagers (`less`, `man`) are left off on purpose: agents read
 * documentation with them, and their `!` shell escape needs a terminal.
 */
import { deny, allow } from "./policy-helpers";
import type { PolicyContext, PolicyMatcher, PolicyResult } from "./policy-types";

export const CODEX_SESSION_GUARD_NAME = "failproofai/codex-interactive-session";

export const CODEX_SESSION_GUARD_DESCRIPTION =
  "Refuse a Codex command that opens an interactive shell or REPL, whose typed input Codex runs no hooks for.";

export const CODEX_SESSION_GUARD_MATCH: PolicyMatcher = {
  events: ["PreToolUse"],
  toolNames: ["Bash"],
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "powershell", "busybox"]);
/** Interpreters that read their program from what is typed when given none. */
const STDIN_INTERPRETERS = new Set(["ruby", "perl", "php", "lua", "luajit", "tclsh", "wish"]);
const ALWAYS_INTERACTIVE = new Set([
  "irb", "pry", "ipython", "bpython", "ptpython", "ghci", "iex", "erl", "scala", "clj", "clojure", "R", "julia", "sbcl", "racket",
  "tmux", "screen", "byobu", "zellij", "mosh", "telnet", "ftp", "sftp", "lftp",
  "vi", "vim", "nvim", "view", "ex", "ed", "emacs", "nano", "pico",
  "gdb", "lldb", "pdb", "nix-repl", "redis-cli", "mongosh", "mongo", "expect", "login",
]);
/** Words before the program that run it rather than being it. */
const WRAPPERS = new Set(["env", "exec", "command", "builtin", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "setsid", "chrt", "taskset", "unbuffer", "caffeinate"]);

/** Top-level simple commands of a line, each with whether its stdin comes from a pipe or a redirect. */
function simpleCommands(command: string): Array<{ words: string[]; stdinFed: boolean }> {
  const out: Array<{ words: string[]; stdinFed: boolean }> = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let piped = false;
  let redirected = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (nextPiped: boolean) => {
    endWord();
    if (words.length > 0) out.push({ words, stdinFed: piped || redirected });
    words = [];
    piped = nextPiped;
    redirected = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (ch === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i++;
      endCommand(false);
    } else if (ch === "|" && command[i + 1] !== "|") {
      endCommand(true);
    } else if (ch === ";" || ch === "\n" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      endCommand(false);
    } else if (ch === "<" && command[i + 1] !== "(") {
      // `< file`, `<<EOF`, `<<<word`: what the program reads is not typed.
      redirected = true;
      endWord();
      while (command[i + 1] === "<") i++;
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand(false);
  return out;
}

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** Whether an option word is a cluster carrying `letter` (`-lc` carries `c`). */
const clusterHas = (word: string, letter: string): boolean => /^-[A-Za-z]+$/.test(word) && word.includes(letter);

/** The program a simple command runs, past assignments and wrappers, with its arguments. */
function programOf(words: string[]): { program: string; args: string[] } | null {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++;
      continue;
    }
    const name = baseName(word);
    if (!WRAPPERS.has(name)) break;
    i++;
    // A wrapper's own options and values (`env -u X`, `nice -n 5`, `timeout 30s`).
    while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (name === "timeout" && /^\d/.test(words[i])))) {
      if (["-n", "-u", "-C", "-S", "-o", "-e", "-i", "-c", "-k", "-s", "-p"].includes(words[i]) && name !== "env") i++;
      else if (name === "env" && (words[i] === "-u" || words[i] === "-C" || words[i] === "-S")) i++;
      i++;
    }
  }
  if (i >= words.length) return null;
  return { program: baseName(words[i]), args: words.slice(i + 1) };
}

/** Operands: arguments that are not options (and not an option's value from `valued`). */
function operands(args: string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === "--") return [...out, ...args.slice(k + 1)];
    if (arg.startsWith("-") && arg !== "-") {
      if (valued.has(arg)) k++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const SHELL_VALUED = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SSH_VALUED = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B", "-P"]);

/** Why `program args` opens an interactive session, or null when it does not. */
function sessionReason(program: string, args: string[], stdinFed: boolean): string | null {
  const name = /^python[0-9.]*$|^pypy[0-9.]*$/.test(program) ? "python" : program;
  if (SHELLS.has(name)) {
    if (args.some((a) => a === "-c" || clusterHas(a, "c") || a === "--command")) return null;
    const ops = operands(args, SHELL_VALUED);
    if (name === "busybox" && ops[0] !== undefined && !SHELLS.has(ops[0])) return null;
    if ((name === "busybox" ? ops.length > 1 : ops.length > 0) && !args.includes("-s")) return null;
    return stdinFed ? null : `an interactive ${name} shell`;
  }
  if (name === "python") {
    if (args.some((a) => a === "-i" || clusterHas(a, "i"))) return "an interactive Python session";
    const m = args.indexOf("-m");
    if (m !== -1) return ["code", "asyncio", "pdb", "IPython", "idlelib", "ptpython", "bpython"].includes(args[m + 1] ?? "") ? "an interactive Python session" : null;
    if (args.includes("-c")) return null;
    const ops = operands(args, new Set(["-W", "-X", "-Q"]));
    if (ops.length > 0 && ops[0] !== "-") return null;
    return stdinFed ? null : "an interactive Python session";
  }
  if (name === "node" || name === "nodejs") {
    if (args.some((a) => a === "-i" || a === "--interactive")) return "an interactive Node.js session";
    if (args.some((a) => ["-e", "-p", "--eval", "--print", "--test", "--check", "-c", "--version", "-v", "--help", "-h"].includes(a))) return null;
    return operands(args, new Set(["-r", "--require", "--import", "--loader", "--input-type"])).length > 0 || stdinFed ? null : "an interactive Node.js session";
  }
  if (name === "bun" || name === "deno") {
    if (args[0] === "repl") return `an interactive ${name} session`;
    return name === "deno" && args.length === 0 && !stdinFed ? "an interactive deno session" : null;
  }
  if (STDIN_INTERPRETERS.has(name)) {
    if (name === "php" && args.includes("-a")) return "an interactive PHP session";
    if ((name === "lua" || name === "luajit") && args.includes("-i")) return `an interactive ${name} session`;
    if (name === "perl" && args.some((a) => /^-d/.test(a))) return "the Perl debugger";
    if (args.some((a) => a === "-e" || a === "-E" || a === "-r" || clusterHas(a, "e") || clusterHas(a, "E"))) return null;
    return operands(args, new Set(["-I", "-M", "-f", "-F", "-v"])).length > 0 || stdinFed ? null : `${name} reading its program from typed input`;
  }
  if (ALWAYS_INTERACTIVE.has(name)) {
    if (name === "tmux" && ["send-keys", "send", "ls", "list-sessions", "kill-session", "kill-server", "capture-pane", "has-session", "-V"].includes(operands(args, new Set(["-L", "-S", "-f", "-c", "-t"]))[0] ?? args[0] ?? "")) return null;
    if (name === "screen" && args.some((a) => a === "-ls" || a === "-list" || a === "-X" || a === "-Q" || a === "-v")) return null;
    if ((name === "gdb" || name === "lldb") && args.some((a) => a === "-batch" || a === "--batch")) return null;
    if (name === "emacs" && args.some((a) => a === "--batch" || a === "--script" || a === "-batch")) return null;
    if ((name === "redis-cli" || name === "mongosh" || name === "mongo") && args.some((a) => a === "--eval" || a === "-e")) return null;
    if (name === "redis-cli" && operands(args, new Set(["-h", "-p", "-a", "-n", "-u", "--user", "--pass"])).length > 0) return null;
    if ((name === "sftp" || name === "ftp" || name === "lftp") && args.some((a) => a === "-b" || a === "-c" || a === "-f")) return null;
    if (name === "R" && args.some((a) => a === "-e" || a === "-f" || a.startsWith("--file") || a === "CMD")) return null;
    if (name === "julia" && (args.some((a) => a === "-e" || a === "-E") || operands(args, new Set(["-p", "-t", "-J"])).length > 0)) return null;
    if (name === "erl" && args.some((a) => a === "-noshell" || a === "-eval" || a === "-s")) return null;
    if (name === "expect" && operands(args, new Set(["-c"])).length > 0) return null;
    return `an interactive ${name} session`;
  }
  if (name === "sqlite3") return operands(args, new Set(["-cmd", "-separator", "-nullvalue"])).length > 1 || stdinFed ? null : "an interactive sqlite3 session";
  if (name === "psql") return args.some((a) => /^(-c|-f|--command|--file)(=|$)/.test(a)) || stdinFed ? null : "an interactive psql session";
  if (name === "mysql" || name === "mariadb") return args.some((a) => /^(-e|--execute)(=|$)/.test(a)) || stdinFed ? null : `an interactive ${name} session`;
  if (name === "ssh") {
    const ops = operands(args, SSH_VALUED);
    if (args.some((a) => a === "-N" || a === "-V" || a === "-G" || a === "-Q")) return null;
    return ops.length === 1 && !stdinFed ? "a remote shell over ssh" : ops.length > 1 && /^(bash|sh|zsh|fish|-?i?bash)$/.test(baseName(ops[1])) && ops.length === 2 ? "a remote shell over ssh" : null;
  }
  if (name === "su") return args.some((a) => a === "-c" || a === "--command" || a.startsWith("--command=")) ? null : "a shell through su";
  if (name === "sudo" || name === "doas") {
    if (args.some((a) => a === "-i" || a === "-s" || a === "--login" || a === "--shell" || clusterHas(a, "i") || clusterHas(a, "s"))) return `a shell through ${name}`;
    const rest = programOf(skipSudoOptions(args));
    return rest ? sessionReason(rest.program, rest.args, stdinFed) : null;
  }
  if (name === "script") return args.some((a) => a === "-c" || a === "--command" || clusterHas(a, "c")) ? null : "a recorded interactive shell (script)";
  if (name === "docker" || name === "podman" || name === "nerdctl") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "attach") return `an attached ${name} container`;
    if (sub !== "exec" && sub !== "run") return null;
    const after = args.slice(args.indexOf(sub) + 1);
    return after.some((a) => a === "-i" || a === "--interactive" || a === "--interactive=true" || clusterHas(a, "i")) ? `an interactive ${name} ${sub}` : null;
  }
  if (name === "kubectl" || name === "oc") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "attach") return `an attached ${name} pod`;
    if (sub !== "exec" && sub !== "run" && sub !== "debug") return null;
    return args.some((a) => a === "-i" || a === "--stdin" || a === "--stdin=true" || clusterHas(a, "i")) ? `an interactive ${name} ${sub}` : null;
  }
  if (name === "nix-shell") return args.some((a) => a === "--run" || a === "--command") ? null : "an interactive nix-shell";
  if (name === "nix" && (args[0] === "repl" || ((args[0] === "develop" || args[0] === "shell") && !args.some((a) => a === "-c" || a === "--command")))) return `an interactive nix ${args[0]}`;
  if ((name === "poetry" || name === "pipenv" || name === "hatch") && args[0] === "shell") return `an interactive ${name} shell`;
  if (name === "vagrant" && args[0] === "ssh" && !args.some((a) => a === "-c" || a === "--command")) return "a remote shell over vagrant ssh";
  return null;
}

function skipSudoOptions(args: string[]): string[] {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    if (["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group"].includes(args[k])) k++;
    k++;
  }
  return args.slice(k);
}

/** Why this command opens an interactive session (the first one found), or null. */
export function opensInteractiveSession(command: string): string | null {
  for (const { words, stdinFed } of simpleCommands(command)) {
    const found = programOf(words);
    if (!found) continue;
    const reason = sessionReason(found.program, found.args, stdinFed);
    if (reason) return reason;
  }
  return null;
}

/** Whether a canonicalized Codex call is a shell command that opens one. */
export function codexCallOpensSession(eventType: string, toolName: string | undefined, toolInput: unknown): string | null {
  if (eventType !== "PreToolUse" || toolName !== "Bash") return null;
  const command = (toolInput as Record<string, unknown> | null | undefined)?.command;
  return typeof command === "string" ? opensInteractiveSession(command) : null;
}

/** The guard for one Codex call found to open an interactive session. */
export function codexSessionGuardFor(reason: string): (ctx: PolicyContext) => PolicyResult {
  return (ctx) => {
    if (ctx.eventType !== "PreToolUse") return allow();
    return deny(
      `failproofai refused this because it opens ${reason}, and Codex runs no hooks for what is typed into one. ` +
        "Run each command on its own instead, without keeping a shell or REPL open.",
    );
  };
}
