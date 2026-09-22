/**
 * Hard-floor builtins: deterministic guards for the commands a semantic judge
 * (Jev) is known to miss.
 *
 * The two-tier evaluator lets Jev clear a `reviewable` policy's deny. These six
 * are the opposite: `authority: "hard"`, so a deny from any of them is final
 * whatever Jev says. Each targets a blind spot measured in the adversarial study
 * — commands Jev let through because they are unusual (`dd`, `mkfs`,
 * `gh release delete`), because no danger probe covers them (mass `pkill`,
 * `--no-verify`), or because the harm is hidden behind a variable
 * (`R=/bin/rm; $R -rf …`).
 *
 * All of them read the command through `shell-analysis.ts`, never a regex over
 * the raw string: the program must be in COMMAND POSITION (after `sudo`, `env`,
 * `xargs`, `bash -c`, `find -exec` … are walked off) for its arguments to count,
 * so `git commit -m "never use --no-verify"` and `grep mkfs notes.md` pass.
 *
 * They fail CLOSED, each on its own: a command the analyser could not read to
 * the end (`truncated`) is denied by every one of them, and so is a command
 * that makes one of them throw. The evaluator swallows a throw and allows, and
 * each of these is enabled independently — a guard that relied on another one
 * being on to catch what it could not read would have a trivial bypass.
 *
 * The implementations are plain hoisted functions, never wrappers — see the note
 * on `POLICY_IMPLEMENTATIONS` in builtin-policies.ts for why that matters.
 */
import { posix } from "node:path";
import type { PolicyContext, PolicyResult } from "./policy-types";
import { allow, deny } from "./policy-helpers";
import {
  analyzeShell,
  basenameGlob,
  dropPrefix,
  lexShell,
  literalPrefix,
  literalText,
  normalizeName,
  resolveWord,
  type Invocation,
  type ShellAnalysis,
  type ShellWord,
  type SimpleCommand,
  type WordPart,
} from "./shell-analysis";

// ── Shared ──────────────────────────────────────────────────────────────────

/** Quote one argv element so a joined argv re-lexes to the same words. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The Bash command text, or null for any other tool. An argv array is joined back into a command line. */
function shellCommand(ctx: PolicyContext): string | null {
  if (ctx.toolName !== "Bash") return null;
  const c = ctx.toolInput?.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return c.map(shellQuote).join(" ");
  return null;
}

/**
 * One analysis per command string. Up to six floor policies read the same
 * command in one evaluation, and the warm worker evaluates serially, so a
 * single-entry cache is enough and can never serve a stale answer.
 */
let lastAnalysis: { command: string; analysis: ShellAnalysis } | null = null;

function analysisFor(ctx: PolicyContext): ShellAnalysis | null {
  const command = shellCommand(ctx);
  if (!command || !command.trim()) return null;
  if (lastAnalysis?.command !== command) lastAnalysis = { command, analysis: safeAnalyze(command) };
  return lastAnalysis.analysis;
}

/**
 * The analyser never throws by design; if it ever does, the command is reported
 * as unanalysable (`failed`, `truncated`) instead of the error escaping — an
 * escaping error is swallowed by the evaluator and the hook ALLOWS.
 */
function safeAnalyze(command: string): ShellAnalysis {
  try {
    return analyzeShell(command);
  } catch {
    return {
      commands: [], invocations: [], redirects: [], bindings: new Map(), cdIntoDev: false, chdirs: [],
      truncated: true, failed: true,
    };
  }
}

/**
 * The deny for a command the analyser could not read to the end, or null when
 * it read all of it. Every floor policy returns this when it found nothing
 * else: what it did not read may hold exactly what it looks for.
 */
function unanalysable(a: ShellAnalysis): PolicyResult | null {
  if (!a.truncated) return null;
  return deny(
    a.failed
      ? "This command could not be analysed, so it is blocked. Split it into simpler commands."
      : "This command nests substitutions, shells or wrappers too deeply to check, so it is blocked. " +
          "Split it into simpler commands.",
  );
}

/** A floor policy that throws denies: the evaluator would log the throw and ALLOW. */
function failedClosed(policy: string): PolicyResult {
  return deny(`The ${policy} check could not process this command, so it is blocked. Split it into simpler commands.`);
}

/** Literal text of each argument; null for an argument that is not a plain literal. */
function lits(args: ShellWord[]): Array<string | null> {
  return args.map((w) => literalText(w));
}

/** Every candidate value of a word, or null when it cannot be known statically. */
function valuesOf(a: ShellAnalysis, word: ShellWord | undefined): string[] | null {
  return word ? resolveWord(a, word) : null;
}

// ── block-disk-destruction ──────────────────────────────────────────────────

/** `/dev` entries that are not disks: writing to them destroys nothing. */
const PSEUDO_DEVICE_RE =
  /^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr|tty\w*|console|ptmx|kmsg|fd\/.*|pts\/.*|shm(?:\/.*)?|mqueue(?:\/.*)?|tcp\/.*|udp\/.*)$/;

/** A block device's name as it appears in /dev: what a bare `mkfs sda1` names when the directory is /dev. */
const BLOCK_DEVICE_NAME_RE =
  /^(?:[sh]d[a-z]+\d*|x?vd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|r?disk\d+(?:s\d+)*|loop\d+|md\d+|dm-\d+|sr\d+|mapper\/.+|disk\/by-[a-z-]+\/.+)$/;

/** Variables that name a directory, never a device. */
const SAFE_PATH_VARS = new Set([
  "HOME", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP", "USERPROFILE", "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "RUNNER_TEMP",
  "GITHUB_WORKSPACE", "CLAUDE_PROJECT_DIR",
]);

const MKFS_RE = /^(?:mkfs(?:\..+)?|mke2fs|mkswap|mkntfs|mkdosfs|mkexfatfs|newfs(?:_\w+)?)$/;
const WIPE_TOOLS = new Set(["wipefs", "blkdiscard"]);
const DISKUTIL_DESTRUCTIVE = new Set([
  "erasedisk", "erasevolume", "zerodisk", "randomdisk", "secureerase", "partitiondisk", "reformat",
]);
/** PowerShell / cmd disk formatters. */
const WINDOWS_DISK_TOOLS = new Set(["clear-disk", "format-volume", "remove-partition", "diskpart"]);
/** Redirection operators that write to their target. */
const WRITE_REDIRECT_RE = /^\d*(?:>|>>|>\||&>|&>>|<>|>&)$/;
/** Working directories tracked per command before the set counts as unknown. */
const MAX_CWDS = 64;

/** The directories a relative path in the command can be relative to. */
interface Cwds {
  dirs: string[];
  /** Some directory the command can run in is unknown: no session cwd, or a `cd` it cannot resolve. */
  unknown: boolean;
}

/**
 * Every directory the command's paths can be relative to: the session cwd,
 * plus every `cd`/`pushd`/`--chdir` target in the command resolved against it.
 * The analysis is flat, so every change applies — `cd ..; cd ..` walks up
 * twice from any directory already reached.
 */
function possibleCwds(a: ShellAnalysis, sessionCwd: unknown): Cwds {
  const dirs = new Set<string>();
  let unknown = false;
  if (typeof sessionCwd === "string" && sessionCwd.startsWith("/")) dirs.add(posix.normalize(sessionCwd));
  else unknown = true;
  // Past MAX_CWDS directories the set stops growing and counts as unknown:
  // a relative `cd` doubles it, and a command can hold thousands of them.
  const add = (dir: string): boolean => {
    if (dirs.size >= MAX_CWDS && !dirs.has(dir)) {
      unknown = true;
      return false;
    }
    dirs.add(dir);
    return true;
  };
  const rounds = Math.min(a.chdirs.length, 8);
  rounds: for (let round = 0; round < rounds; round++) {
    const before = dirs.size;
    for (const targets of a.chdirs) {
      if (targets === null) {
        unknown = true;
        continue;
      }
      for (const raw of targets) {
        const t = raw.trim();
        if (!t) continue;
        if (t.startsWith("~")) unknown = true;
        else if (t.startsWith("/")) {
          if (!add(posix.normalize(t))) break rounds;
        } else if (dirs.size === 0) unknown = true;
        else for (const d of [...dirs]) if (!add(posix.resolve(d, t))) break rounds;
      }
    }
    if (dirs.size === before) break;
  }
  return { dirs: [...dirs], unknown };
}

function isDeviceAbs(path: string): boolean {
  const norm = posix.normalize(path);
  return (norm === "/dev" || norm.startsWith("/dev/")) && !PSEUDO_DEVICE_RE.test(norm);
}

/**
 * The absolute paths a path in the command can name. A relative path is
 * resolved against every possible cwd; from an unknown one, `dev/sda` and
 * `../../dev/sda` can each be /dev/sda, and — for a disk tool (`diskTool`) — a
 * bare `sda1` can be /dev/sda1.
 */
function absolutePaths(path: string, cwds: Cwds, diskTool: boolean): string[] {
  const p = path.trim();
  if (!p) return [];
  if (p.startsWith("/")) return [p];
  const out = cwds.dirs.map((d) => posix.resolve(d, p));
  if (cwds.unknown) {
    const rel = posix.normalize(p);
    const m = /^(?:\.\.\/)*(dev(?:\/.*)?)$/.exec(rel);
    if (m) out.push("/" + m[1]);
    if (diskTool && BLOCK_DEVICE_NAME_RE.test(rel)) out.push("/dev/" + rel);
  }
  return out;
}

function isDevicePath(path: string, cwds: Cwds, diskTool: boolean): boolean {
  return absolutePaths(path, cwds, diskTool).some(isDeviceAbs);
}

/**
 * How to read a word that may name a device.
 * - `unresolved`: a target the command string cannot resolve counts as a
 *   device. For tools whose only job is disks (`dd`, `mkfs`, `wipefs`), where
 *   `of=$DISK` is exactly the shape worth stopping. A redirect or `tee` to an
 *   unknown `$FILE` is ordinary and stays allowed.
 * - `diskTool`: a bare device name (`sda1`) counts when the cwd is unknown.
 */
interface TargetMode {
  unresolved: boolean;
  diskTool: boolean;
}

const DISK_TOOL_STRICT: TargetMode = { unresolved: true, diskTool: true };
const DISK_TOOL_LITERAL: TargetMode = { unresolved: false, diskTool: true };
const ORDINARY: TargetMode = { unresolved: false, diskTool: false };

/** The device a word writes to, or null when it is not one. */
function deviceTarget(a: ShellAnalysis, word: ShellWord, cwds: Cwds, mode: TargetMode): string | null {
  const values = resolveWord(a, word);
  if (values) return values.find((v) => isDevicePath(v, cwds, mode.diskTool)) ?? null;
  const prefix = literalPrefix(word);
  if (prefix) {
    // `/dev/tcp/$HOST/5432` is a socket; `/dev/sd$X` is a disk. Decide on
    // the literal part with a placeholder for the rest.
    if (absolutePaths(prefix + "x", cwds, mode.diskTool).some((p) => posix.normalize(p).startsWith("/dev/") && isDeviceAbs(p))) {
      return word.text;
    }
    // `/$X` or `/de$X` can still become /dev/….
    if (mode.unresolved && absolutePaths(prefix, cwds, false).some((p) => "/dev/".startsWith(posix.normalize(p)))) {
      return word.text;
    }
    return null;
  }
  if (!mode.unresolved) return null;
  const first = word.parts[0];
  if (first?.kind === "param" && SAFE_PATH_VARS.has(first.name)) return null;
  return word.text;
}

function diskHit(a: ShellAnalysis, inv: Invocation, name: string, cwds: Cwds): string | null {
  const args = inv.args;
  const operands = args.filter((w) => !(literalText(w) ?? "").startsWith("-"));
  if (name === "dd") {
    for (const w of args) {
      if (!literalPrefix(w).startsWith("of=")) continue;
      const dev = deviceTarget(a, dropPrefix(w, 3), cwds, DISK_TOOL_STRICT);
      if (dev) return `dd of=${dev}`;
    }
    return null;
  }
  if (MKFS_RE.test(name) || WIPE_TOOLS.has(name)) {
    for (const w of operands) {
      if (literalText(w) === null) continue;
      const dev = deviceTarget(a, w, cwds, DISK_TOOL_LITERAL);
      if (dev) return `${name} ${dev}`;
    }
    // The device is the last operand; one the command cannot resolve is not given the benefit of the doubt.
    const last = operands[operands.length - 1];
    if (last && literalText(last) === null) {
      const dev = deviceTarget(a, last, cwds, DISK_TOOL_STRICT);
      if (dev) return `${name} ${dev}`;
    }
    return null;
  }
  if (name === "shred" || name === "tee") {
    for (const w of operands) {
      const dev = deviceTarget(a, w, cwds, ORDINARY);
      if (dev) return `${name} ${dev}`;
    }
    return null;
  }
  if (name === "cp" && operands.length >= 2) {
    const dev = deviceTarget(a, operands[operands.length - 1], cwds, ORDINARY);
    return dev ? `cp … ${dev}` : null;
  }
  if (name === "diskutil") {
    // A bare `diskutil` (or only flags) has no verb.
    const verbs = lits(operands).map((t) => t ?? "");
    const verb = (verbs[0] ?? "").toLowerCase() === "apfs" ? verbs[1] : verbs[0];
    const lower = verb?.toLowerCase();
    if (lower && (DISKUTIL_DESTRUCTIVE.has(lower) || /^delete(?:container|volume)$/.test(lower))) {
      return `diskutil ${verb}`;
    }
    return null;
  }
  if (WINDOWS_DISK_TOOLS.has(name)) return name;
  if (name === "format" && lits(args).some((t) => t !== null && /^[a-z]:\\?$/i.test(t))) return "format <drive>";
  return null;
}

function blockDiskDestruction(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    const cwds = possibleCwds(a, ctx.session?.cwd);
    for (const inv of a.invocations) {
      for (const name of inv.names) {
        const hit = diskHit(a, inv, name, cwds);
        if (hit) {
          return deny(`Formatting, wiping or writing raw data to a disk device is blocked (${hit}).`);
        }
      }
    }
    for (const r of a.redirects) {
      if (!r.target || !WRITE_REDIRECT_RE.test(r.op)) continue;
      // `>&2` duplicates a file descriptor; only `>&file` writes a file.
      if (r.op.endsWith(">&") && /^(?:\d+|-)$/.test(r.target.text)) continue;
      const dev = deviceTarget(a, r.target, cwds, ORDINARY);
      if (dev) return deny(`Formatting, wiping or writing raw data to a disk device is blocked (redirect to ${dev}).`);
    }
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-disk-destruction");
  }
}

// ── block-gh-destructive ────────────────────────────────────────────────────

/** `gh <noun> delete` for these nouns removes something on GitHub. */
const GH_DELETABLE = new Set([
  "release", "repo", "issue", "run", "gist", "label", "variable", "secret", "cache",
  "ssh-key", "gpg-key", "codespace", "project",
]);
const GH_NOUN_ALIASES: Record<string, string> = { cs: "codespace" };
/** `gh api` short options that take a value (pflag): `-X`, `-F`, `-f`, `-H`, `-p`, `-q`, `-t`. */
const GH_API_SHORT_VALUE = new Set(["X", "F", "f", "H", "p", "q", "t"]);
/** `gh api` long options that take a value. */
const GH_API_LONG_VALUE = new Set([
  "--method", "--field", "--raw-field", "--header", "--hostname", "--input", "--jq", "--template",
  "--preview", "--cache",
]);

/** A GraphQL mutation whose name starts with `delete` (`deleteRef`, `deleteIssue`, …). Linear, unlike one regex with `[\s\S]*`. */
function graphqlDelete(query: string): boolean {
  const at = query.search(/\bmutation\b/);
  return at >= 0 && /\bdelete[A-Z]/.test(query.slice(at));
}

/**
 * `gh api` with a DELETE method or a delete mutation. Options are read the way
 * gh's pflag reads them: a short option that takes a value takes the rest of
 * its bundle (`-XDELETE`, `-iXDELETE`, with a leading `=` dropped: `-X=DELETE`)
 * or the next word (`-X DELETE`, `-iX DELETE`); a long one takes `=value` or
 * the next word.
 */
function ghApiHit(a: ShellAnalysis, args: ShellWord[]): string | null {
  const methods: Array<string | ShellWord | undefined> = [];
  const fields: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const flag = eq === -1 ? t : t.slice(0, eq);
      if (!GH_API_LONG_VALUE.has(flag)) continue;
      const value: string | ShellWord | undefined = eq === -1 ? args[k + 1] : t.slice(eq + 1);
      if (eq === -1) k++;
      if (flag === "--method") methods.push(value);
      else if (flag === "--field" || flag === "--raw-field") fields.push(typeof value === "string" ? value : value?.text ?? "");
      continue;
    }
    if (!t.startsWith("-") || t.length < 2) continue;
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (!GH_API_SHORT_VALUE.has(ch)) continue;
      let value: string | ShellWord | undefined;
      if (j + 1 < t.length) {
        const rest = t.slice(j + 1);
        value = rest.length > 1 && rest[0] === "=" ? rest.slice(1) : rest;
      } else {
        value = args[k + 1];
        k++;
      }
      if (ch === "X") methods.push(value);
      else if (ch === "f" || ch === "F") fields.push(typeof value === "string" ? value : value?.text ?? "");
      break;
    }
  }
  for (const m of methods) {
    if (m === undefined) continue;
    const values = typeof m === "string" ? [m] : valuesOf(a, m);
    if (values === null) return "gh api -X <unresolved method>";
    if (values.some((v) => v.trim().toUpperCase() === "DELETE")) return "gh api -X DELETE";
  }
  if (fields.some((f) => f.startsWith("query=") && graphqlDelete(f))) return "gh api graphql delete mutation";
  return null;
}

function ghHit(a: ShellAnalysis, args: ShellWord[]): string | null {
  const texts = lits(args);
  if (texts.some((t) => t === "--help" || t === "-h")) return null;
  const positional: Array<{ text: string; index: number }> = [];
  for (let k = 0; k < args.length && positional.length < 3; k++) {
    const t = texts[k];
    if (t === null) {
      positional.push({ text: "", index: k });
      continue;
    }
    if (t === "-R" || t === "--repo" || t === "--hostname") {
      k++;
      continue;
    }
    if (t.startsWith("-")) continue;
    positional.push({ text: t.toLowerCase(), index: k });
  }
  const first = positional[0]?.text ?? "";
  const noun = Object.hasOwn(GH_NOUN_ALIASES, first) ? GH_NOUN_ALIASES[first] : first;
  const verb = positional[1]?.text;
  if (!noun) return null;
  if (noun === "api") return ghApiHit(a, args.slice(positional[0].index + 1));
  if (GH_DELETABLE.has(noun) && (verb === "delete" || verb === "remove")) return `gh ${noun} ${verb}`;
  if (noun === "release" && verb === "delete-asset") return "gh release delete-asset";
  if (noun === "project" && (verb === "item-delete" || verb === "field-delete")) return `gh project ${verb}`;
  if (noun === "repo" && verb === "deploy-key" && positional[2]?.text === "delete") return "gh repo deploy-key delete";
  return null;
}

function blockGhDestructive(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    for (const inv of a.invocations) {
      if (!inv.names.includes("gh")) continue;
      const hit = ghHit(a, inv.args);
      if (hit) return deny(`Deleting GitHub resources through the gh CLI is blocked (${hit}).`);
    }
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-gh-destructive");
  }
}

// ── block-mass-kill ─────────────────────────────────────────────────────────

/**
 * Process names that match far more than the agent started: interpreters,
 * shells, editors, browsers, the agent CLIs themselves, system daemons.
 * `killall node` takes down every language server, every other session and
 * the agent's own harness; `killall vite` takes down vite.
 */
const GENERIC_PROCESS_NAMES = new Set([
  "node", "nodejs", "bun", "deno", "npm", "npx", "yarn", "pnpm", "python", "python2", "python3",
  "pip", "pip3", "ruby", "perl", "php", "java", "javaw", "dotnet", "go", "bash", "sh", "zsh",
  "fish", "dash", "ksh", "tcsh", "csh", "pwsh", "powershell", "cmd", "conhost", "login", "sshd",
  "ssh", "ssh-agent", "gpg-agent", "tmux", "screen", "code", "electron", "chrome", "chromium",
  "firefox", "safari", "claude", "codex", "cursor", "docker", "dockerd", "containerd", "systemd",
  "init", "launchd", "xorg", "gnome-shell", "explorer", "finder", "dock", "windowserver", "sudo",
  "su", "git", "vim", "nvim", "emacs",
]);

/** pgrep/pkill flags that take a value. */
const PGREP_OPERAND_SHORT = new Set(["g", "G", "P", "s", "t", "u", "U", "F", "r", "d"]);
const PGREP_OPERAND_LONG = new Set([
  "--pgroup", "--group", "--parent", "--session", "--terminal", "--euid", "--uid", "--pidfile",
  "--runstates", "--ns", "--nslist", "--signal", "--delimiter", "--cgroup", "--env",
]);
const KILLALL_OPERAND_SHORT = new Set(["s", "u", "y", "o", "n", "Z", "t", "c"]);
const KILLALL_OPERAND_LONG = new Set([
  "--signal", "--user", "--younger-than", "--older-than", "--ns", "--context",
]);
/** `-KILL`, `-SIGTERM`, `-9`: a signal, not a flag bundle. */
const SIGNAL_FLAG_RE = /^-(?:\d+|(?:SIG)?[A-Z][A-Z0-9+-]+)$/;

/** Normalise a process pattern to the name it targets: anchors, `.*`, `[n]ode` and a path removed. */
function stripPattern(pattern: string): string {
  let s = pattern.trim().toLowerCase();
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  s = s.replace(/^(?:\.\*|\.\+)+/, "");
  // A loop, not `/(?:\.\*|\.\+)+$/`: that backtracks quadratically on a long `.*.*…x`.
  while (s.endsWith(".*") || s.endsWith(".+")) s = s.slice(0, -2);
  return s.replace(/\[([^\]^])\]/g, "$1").replace(/\\(.)/g, "$1").trim();
}

/** The process name a pattern targets: anchors, `.*`, `[n]ode`, `.exe` and an ABSOLUTE binary path removed. */
function patternTarget(pattern: string): string {
  let s = stripPattern(pattern);
  // `/usr/bin/node` targets node; `linux-x64/rg` is a specific path fragment.
  if (s.startsWith("/") && !/\s/.test(s)) s = s.slice(s.lastIndexOf("/") + 1);
  return s.replace(/\.exe$/, "");
}

/** Whether a pkill/pgrep pattern (a regex matched as a substring unless `-x`) reaches too much. */
function broadPattern(pattern: string, exact: boolean): boolean {
  if (pattern.includes("|")) return pattern.split("|").some((alt) => broadPattern(alt, exact));
  const raw = stripPattern(pattern);
  if (/^[.*+?\s\\^$]*$/.test(raw)) return true;
  // Unanchored and short, it is a substring of half the process table: `pkill sh`.
  if (!exact && raw.length <= 2) return true;
  return GENERIC_PROCESS_NAMES.has(patternTarget(pattern));
}

/** Why a pkill/pgrep invocation selects processes en masse, or null. */
function pgrepMass(a: ShellAnalysis, tool: string, args: ShellWord[]): string | null {
  let exact = false;
  let full = false;
  let inverse = false;
  let userSel = false;
  let pattern: ShellWord | null = null;
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) {
      pattern ??= args[k];
      continue;
    }
    if (t === "--") {
      pattern ??= args[k + 1] ?? null;
      break;
    }
    if (t.startsWith("--")) {
      const flag = t.split("=")[0];
      if (flag === "--help" || flag === "--version") return null;
      if (flag === "--exact") exact = true;
      else if (flag === "--full") full = true;
      else if (flag === "--inverse") inverse = true;
      else if (flag === "--euid" || flag === "--uid") userSel = true;
      if (PGREP_OPERAND_LONG.has(flag) && !t.includes("=")) k++;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (SIGNAL_FLAG_RE.test(t)) continue;
      if (t === "-V") return null;
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === "x") exact = true;
        else if (ch === "f") full = true;
        else if (ch === "v") inverse = true;
        if (ch === "u" || ch === "U") userSel = true;
        if (PGREP_OPERAND_SHORT.has(ch)) {
          if (j === t.length - 1) k++;
          break;
        }
      }
      continue;
    }
    pattern ??= args[k];
  }
  if (inverse) return `${tool} -v`;
  if (!pattern) return userSel ? `${tool} -u <user>` : null;
  const values = resolveWord(a, pattern);
  const hit = values?.find((v) => broadPattern(v, exact));
  return hit !== undefined ? `${tool} ${full ? "-f " : ""}${hit || "''"}` : null;
}

function killallMass(a: ShellAnalysis, args: ShellWord[]): string | null {
  let regex = false;
  let userSel = false;
  let info = false;
  const names: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) {
      names.push(args[k]);
      continue;
    }
    if (t === "--") {
      names.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith("--")) {
      const flag = t.split("=")[0];
      if (flag === "--regexp") regex = true;
      else if (flag === "--user") userSel = true;
      else if (flag === "--list" || flag === "--version" || flag === "--help") info = true;
      if (KILLALL_OPERAND_LONG.has(flag) && !t.includes("=")) k++;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (SIGNAL_FLAG_RE.test(t)) continue;
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === "r" || ch === "m") regex = true;
        else if (ch === "l" || ch === "V") info = true;
        if (ch === "u") userSel = true;
        if (KILLALL_OPERAND_SHORT.has(ch)) {
          if (j === t.length - 1) k++;
          break;
        }
      }
      continue;
    }
    names.push(args[k]);
  }
  if (names.length === 0) {
    if (info) return null;
    return userSel ? "killall -u <user>" : "killall with no process name";
  }
  for (const w of names) {
    for (const v of resolveWord(a, w) ?? []) {
      if (regex ? broadPattern(v, false) : GENERIC_PROCESS_NAMES.has(patternTarget(v))) return `killall ${v}`;
    }
  }
  return null;
}

/** `kill -1` / `kill -9 -1` / `kill -- -1`: signal every process the user can reach. */
function killsEveryProcess(args: ShellWord[]): boolean {
  let options = true;
  let signalSeen = false;
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) {
      options = false;
      continue;
    }
    if (options) {
      if (t === "--") {
        options = false;
        continue;
      }
      if (t === "-l" || t === "-L" || t === "--list") return false;
      if (t === "-s" || t === "-n" || t === "--signal") {
        k++;
        signalSeen = true;
        continue;
      }
      if (t.startsWith("-") && t.length > 1 && !signalSeen) {
        signalSeen = true;
        continue;
      }
      options = false;
    }
    if (t === "-1") return true;
  }
  return false;
}

/** PowerShell `-Name`/`-ProcessName` values (`Stop-Process -Name node`, `kill -Name node`). */
function psNames(args: ShellWord[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (!/^-(?:name|processname)$/i.test(literalText(args[k]) ?? "")) continue;
    for (let j = k + 1; j < args.length; j++) {
      const t = literalText(args[j]);
      if (t === null || t.startsWith("-")) break;
      out.push(...t.split(",").filter(Boolean));
    }
  }
  return out;
}

function isGenericOrWildcard(name: string): boolean {
  return name.includes("*") || GENERIC_PROCESS_NAMES.has(patternTarget(name));
}

/**
 * A broad process listing among `invs` — `pgrep node`, `pidof python3`,
 * `ps -C node`, `ps aux | grep node`, `Get-Process node` — or null.
 */
function massSource(a: ShellAnalysis, invs: Invocation[]): string | null {
  const psPresent = invs.some((inv) => inv.names.includes("ps"));
  for (const inv of invs) {
    for (const name of inv.names) {
      const texts = lits(inv.args);
      if (name === "pgrep") {
        const why = pgrepMass(a, "pgrep", inv.args);
        if (why) return why;
      } else if (name === "pidof") {
        const generic = texts.find((t) => t !== null && !t.startsWith("-") && GENERIC_PROCESS_NAMES.has(patternTarget(t)));
        if (generic) return `pidof ${generic}`;
      } else if (name === "get-process" || name === "gps") {
        const named = [...psNames(inv.args), ...texts.filter((t): t is string => t !== null && !t.startsWith("-"))]
          .find(isGenericOrWildcard);
        if (named) return `Get-Process ${named}`;
      } else if (name === "ps") {
        const k = texts.findIndex((t) => t === "-C");
        const value = k >= 0 ? texts[k + 1] : null;
        if (value && value.split(",").some((v) => GENERIC_PROCESS_NAMES.has(patternTarget(v)))) return `ps -C ${value}`;
      } else if (psPresent && (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg")) {
        if (texts.includes("-v")) continue;
        let pattern: string | null = null;
        for (let k = 0; k < texts.length; k++) {
          const t = texts[k];
          if (t === null) break;
          if (t === "-e" || t === "--regexp") {
            pattern = texts[k + 1] ?? null;
            break;
          }
          if (t.startsWith("-")) continue;
          pattern = t;
          break;
        }
        if (pattern !== null && broadPattern(pattern, false)) return `ps | grep ${pattern}`;
      }
    }
  }
  return null;
}

/**
 * Per-analysis memos for the kill checks, so a command repeating `kill $P`
 * or `x | kill` thousands of times stays linear: each substitution is analysed
 * once, each variable's filter looked up once, each pipeline's invocations
 * indexed once.
 */
interface KillMemo {
  subs: WeakMap<WordPart, string | null>;
  filters: Map<string, boolean>;
  byCommand: Map<SimpleCommand, Invocation[]> | null;
}
const killMemos = new WeakMap<ShellAnalysis, KillMemo>();

function killMemo(a: ShellAnalysis): KillMemo {
  let m = killMemos.get(a);
  if (!m) killMemos.set(a, (m = { subs: new WeakMap(), filters: new Map(), byCommand: null }));
  return m;
}

/** A broad listing inside a `$( … )` of this word. */
function massSourceInSubstitutions(a: ShellAnalysis, word: ShellWord): string | null {
  const memo = killMemo(a).subs;
  for (const p of word.parts) {
    if (p.kind !== "sub") continue;
    let why = memo.get(p);
    if (why === undefined) {
      const inner = analyzeShell(p.body);
      why = massSource(inner, inner.invocations);
      memo.set(p, why);
    }
    if (why) return why;
  }
  return null;
}

/**
 * The command decides per process before killing: a `case`/`if`/test, or a
 * grep that reads the PID variable (`grep -q x /proc/$p/cmdline && kill $p`).
 * A grep that only builds the list (`$(ps aux | grep node)`) is not a filter.
 */
function filtersBeforeKilling(a: ShellAnalysis, variable: string): boolean {
  const memo = killMemo(a).filters;
  const cached = memo.get(variable);
  if (cached !== undefined) return cached;
  const readsVariable = (w: ShellWord) => w.parts.some((p) => p.kind === "param" && p.name === variable);
  let filters = a.invocations.some((inv) =>
    inv.names.some((n) => n === "[" || n === "[[" || n === "test") ||
    (inv.names.some((n) => n === "grep" || n === "egrep" || n === "rg") && inv.args.some(readsVariable)));
  filters ||= a.commands.some((cmd) => cmd.words.some((w) => {
    const t = literalText(w);
    return t === "case" || t === "if" || t === "elif";
  }));
  memo.set(variable, filters);
  return filters;
}

/** The invocations of each simple command, indexed once per analysis. */
function invocationsOf(a: ShellAnalysis, cmd: SimpleCommand): Invocation[] {
  const memo = killMemo(a);
  if (!memo.byCommand) {
    memo.byCommand = new Map();
    for (const inv of a.invocations) {
      const list = memo.byCommand.get(inv.command) ?? [];
      list.push(inv);
      memo.byCommand.set(inv.command, list);
    }
  }
  return memo.byCommand.get(cmd) ?? [];
}

/**
 * What feeds a kill its PIDs, when that is a broad listing:
 * - a substitution in its arguments: `kill $(pgrep node)`;
 * - the pipeline it reads: `pgrep node | xargs kill`, `ps aux | grep node | … | xargs kill`;
 * - a variable holding such a substitution: `P=$(pgrep node); kill $P`,
 *   `for p in $(pgrep node); do kill $p; done` — unless the command filters
 *   each process first, which is the careful form (`… case "$cmdline" in …`).
 */
function killFedByMass(a: ShellAnalysis, inv: Invocation): string | null {
  for (const w of inv.args) {
    const why = massSourceInSubstitutions(a, w);
    if (why) return why;
  }
  const chain: SimpleCommand[] = [];
  const onChain = new Set<SimpleCommand>();
  for (let c = inv.command.pipedFrom; c && !onChain.has(c); c = c.pipedFrom) {
    onChain.add(c);
    chain.push(c);
  }
  if (chain.length) {
    const why = massSource(a, chain.flatMap((c) => invocationsOf(a, c)));
    if (why) return why;
  }
  for (const w of inv.args) {
    for (const p of w.parts) {
      if (p.kind !== "param") continue;
      for (const bound of a.bindings.get(p.name) ?? []) {
        const why = massSourceInSubstitutions(a, bound);
        if (why && !filtersBeforeKilling(a, p.name)) return why;
      }
    }
  }
  return null;
}

function blockMassKill(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    const hit = (why: string) =>
      deny(`Killing processes en masse is blocked (${why}). Stop the specific process you started, by PID or with an exact name.`);
    for (const inv of a.invocations) {
      for (const name of inv.names) {
        switch (name) {
          case "killall5":
            return hit("killall5");
          case "killall": {
            const why = killallMass(a, inv.args);
            if (why) return hit(why);
            break;
          }
          case "pkill": {
            const why = pgrepMass(a, "pkill", inv.args);
            if (why) return hit(why);
            break;
          }
          case "kill":
          case "stop-process":
          case "spps": {
            if (name === "kill" && killsEveryProcess(inv.args)) return hit("kill -1");
            const named = psNames(inv.args).find(isGenericOrWildcard);
            if (named) return hit(`${name} -Name ${named}`);
            if (lits(inv.args).some((t) => t === "-l" || t === "-L")) break;
            const fed = killFedByMass(a, inv);
            if (fed) return hit(`${name} fed by ${fed}`);
            break;
          }
          case "taskkill": {
            const texts = lits(inv.args);
            for (let k = 0; k < texts.length; k++) {
              const flag = (texts[k] ?? "").toLowerCase();
              const value = texts[k + 1] ?? "";
              if ((flag === "/im" || flag === "-im") && isGenericOrWildcard(value)) return hit(`taskkill /IM ${value}`);
              if (flag === "/fi" || flag === "-fi") {
                const m = /^\s*imagename\s+eq\s+(\S+)/i.exec(value);
                if (m && isGenericOrWildcard(m[1])) return hit(`taskkill /FI imagename eq ${m[1]}`);
              }
            }
            break;
          }
        }
      }
    }
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-mass-kill");
  }
}

// ── block-no-verify ─────────────────────────────────────────────────────────

/** git subcommands that run hooks and accept `--no-verify`. */
const HOOK_SUBCOMMANDS = new Set(["commit", "push", "merge", "pull", "rebase", "am", "cherry-pick", "revert"]);
/** git global options that take a separate value. */
const GIT_GLOBAL_OPERAND = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
/** `git commit` options that take the next word as a value. */
const COMMIT_OPERAND_LONG = new Set([
  "--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message",
  "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file",
]);
const COMMIT_OPERAND_SHORT = new Set(["m", "F", "C", "c", "t"]);
/** `--no-verify` and the unambiguous prefixes git's option parser accepts for it. */
const NO_VERIFY_RE = /^--no-veri(?:f|fy)?$/;

/**
 * A `core.hooksPath` value that turns hooks off: empty, or a null device. An
 * ordinary directory (`.husky`, `.githooks`) is how hook managers install
 * themselves, and runs hooks.
 */
function hooksPathDisablesHooks(value: string): boolean {
  const v = value.trim();
  return v === "" || v === "/dev/null" || v.toLowerCase() === "nul";
}

interface GitCall {
  sub: string | null;
  subArgs: ShellWord[];
  /** `-c key=value` settings. */
  configs: string[];
  /** `--config-env key=ENVVAR` settings: the value lives in an environment variable. */
  configEnvs: string[];
}

function parseGit(args: ShellWord[]): GitCall {
  const configs: string[] = [];
  const configEnvs: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) return { sub: null, subArgs: [], configs, configEnvs };
    if (GIT_GLOBAL_OPERAND.has(t)) {
      if (t === "-c") configs.push(args[k + 1]?.text ?? "");
      else if (t === "--config-env") configEnvs.push(args[k + 1]?.text ?? "");
      k++;
      continue;
    }
    if (t.startsWith("--config-env=")) {
      configEnvs.push(t.slice("--config-env=".length));
      continue;
    }
    if (t.startsWith("-")) continue;
    return { sub: t.toLowerCase(), subArgs: args.slice(k + 1), configs, configEnvs };
  }
  return { sub: null, subArgs: [], configs, configEnvs };
}

function commitSkipsHooks(args: ShellWord[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const flag = t.split("=")[0];
      if (NO_VERIFY_RE.test(flag)) return "git commit --no-verify";
      if (!t.includes("=") && COMMIT_OPERAND_LONG.has(flag)) k++;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === "n") return "git commit -n";
        if (COMMIT_OPERAND_SHORT.has(ch)) {
          if (j === t.length - 1) k++;
          break;
        }
        if (ch === "S" || ch === "u") break;
      }
    }
  }
  return null;
}

function hasNoVerify(args: ShellWord[]): boolean {
  for (const t of lits(args)) {
    if (t === "--") return false;
    if (t !== null && NO_VERIFY_RE.test(t.split("=")[0])) return true;
  }
  return false;
}

/** Environment switches that turn a hook manager off for one command. */
function envSkipsHooks(name: string, value: string, prefixOnly: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (name === "HUSKY") return v === "0" || v === "false";
  if (name === "HUSKY_SKIP_HOOKS") return v === "1" || v === "true";
  if (name === "LEFTHOOK") return v === "0" || v === "false";
  if (/^GIT_CONFIG_KEY_\d+$/.test(name)) return v === "core.hookspath";
  if (name === "GIT_CONFIG_PARAMETERS") return v.includes("core.hookspath");
  // pre-commit's per-hook skip list. Only as a prefix on the git command itself:
  // `SKIP` is too generic a name to read from an unrelated `export`.
  if (name === "SKIP") return prefixOnly && v.length > 0;
  return false;
}

/**
 * An inline alias, expanded into the command it stands for:
 * `git -c alias.ci='commit --no-verify' ci -m x` → `git commit --no-verify -m x`,
 * `git -c alias.x='!git commit -n' x` → `git commit -n`. Null when `sub` is
 * not an alias this command defines.
 */
function expandInlineAlias(configs: string[], sub: string, subArgs: ShellWord[]): string | null {
  for (const c of configs) {
    const m = /^alias\.([^=]+)=([\s\S]*)$/i.exec(c.trim());
    if (!m || m[1].toLowerCase() !== sub) continue;
    const rest = subArgs.map((w) => w.text).join(" ");
    const body = m[2].trim();
    return body.startsWith("!") ? `${body.slice(1)} ${rest}` : `git ${body} ${rest}`;
  }
  return null;
}

/** Why this command skips git hooks, or null. `depth` bounds alias expansion. */
function noVerifyHit(a: ShellAnalysis, depth: number): string | null {
  let runsHooks = false;
  for (const inv of a.invocations) {
    if (!inv.names.includes("git")) continue;
    const g = parseGit(inv.args);
    if (!g.sub) continue;
    if (g.sub === "config") {
      const texts = lits(g.subArgs);
      const k = texts.findIndex((t) => t !== null && t.toLowerCase() === "core.hookspath");
      if (k >= 0 && k + 1 < texts.length) {
        const value = (texts[k + 1] ?? "").trim();
        if (hooksPathDisablesHooks(value)) return `git config core.hooksPath ${value || "''"}`;
      }
      continue;
    }
    const expanded = expandInlineAlias(g.configs, g.sub, g.subArgs);
    if (expanded !== null) {
      // An alias defined inside an alias inside an alias is built to hide what
      // it runs; one level more than is expanded is not waved through.
      if (depth >= 2) return `git -c alias.${g.sub}=… (too deeply nested to check)`;
      const inner = analyzeShell(expanded);
      const why = noVerifyHit(inner, depth + 1);
      if (why) return `git -c alias.${g.sub}=… → ${why}`;
      if (inner.truncated) return `git -c alias.${g.sub}=… (too deeply nested to check)`;
      continue;
    }
    if (!HOOK_SUBCOMMANDS.has(g.sub)) continue;
    runsHooks = true;
    const hooksPath = g.configs.find((c) => {
      const m = /^core\.hookspath=([\s\S]*)$/i.exec(c.trim());
      return m !== null && hooksPathDisablesHooks(m[1]);
    });
    if (hooksPath !== undefined) return `git -c ${hooksPath.trim()} ${g.sub}`;
    // `--config-env` reads the value from the environment, which the command string does not show.
    if (g.configEnvs.some((c) => /^core\.hookspath=/i.test(c.trim()))) return `git --config-env core.hooksPath=… ${g.sub}`;
    if (g.sub === "commit") {
      const why = commitSkipsHooks(g.subArgs);
      if (why) return why;
    } else if (hasNoVerify(g.subArgs)) {
      return `git ${g.sub} --no-verify`;
    }
    for (const { name, value } of inv.env) {
      for (const v of resolveWord(a, value) ?? []) {
        if (envSkipsHooks(name, v, true)) return `${name}=${v} git ${g.sub}`;
      }
    }
  }
  if (runsHooks) {
    // `export HUSKY=0; git commit …`. A plain `HUSKY=0;` is a shell variable
    // git never sees, and `HUSKY=0 npm ci` applies to npm alone, so only an
    // export reaches the hook manager.
    for (const inv of a.invocations) {
      if (!inv.names.some((n) => n === "export" || n === "declare" || n === "typeset")) continue;
      const texts = lits(inv.args);
      if (!inv.names.includes("export") && !texts.some((t) => t !== null && /^-[a-zA-Z]*x/.test(t))) continue;
      for (const w of inv.args) {
        const m = /^([A-Za-z_]\w*)=/.exec(literalPrefix(w));
        if (!m) continue;
        for (const v of resolveWord(a, dropPrefix(w, m[0].length)) ?? []) {
          if (envSkipsHooks(m[1], v, false)) return `export ${m[1]}=${v}`;
        }
      }
    }
  }
  return null;
}

function blockNoVerify(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    const why = noVerifyHit(a, 0);
    if (why) return deny(`Skipping git hooks is blocked (${why}). Fix what the hook reports instead of bypassing it.`);
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-no-verify");
  }
}

// ── block-indirect-exec ─────────────────────────────────────────────────────

/** Programs that destroy data, and so must never run from a name the reader cannot see. */
const DESTRUCTIVE_RE = /^(?:rm|srm|dd|shred|wipefs|blkdiscard|mke2fs|mkswap|mkntfs|mkdosfs|mkexfatfs|mkfs(?:\.[\w.+-]+)?|newfs(?:_\w+)?)$/;
/** Names a basename glob in command position is tested against. */
const DESTRUCTIVE_SAMPLES = [
  "rm", "srm", "dd", "shred", "wipefs", "blkdiscard", "mke2fs", "mkswap", "mkntfs", "mkdosfs",
  "mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.xfs", "mkfs.btrfs", "mkfs.vfat", "mkfs.fat", "mkfs.ntfs",
  "mkfs.exfat", "newfs", "newfs_apfs", "newfs_hfs",
];

/** Arguments that only make sense for rm or dd — the shape of a hidden destructive call. */
function looksDestructive(args: ShellWord[]): boolean {
  const texts = lits(args);
  // rm's flags come first (`$R -rf dir`); `$K apply -R -f dir` is a subcommand
  // with flags, not rm, so only the leading run of flags is read.
  const leading: string[] = [];
  for (const t of texts) {
    if (t === null || !t.startsWith("-") || t === "--") break;
    leading.push(t);
  }
  const bundles = leading.filter((t) => /^-[a-zA-Z]+$/.test(t));
  const recursive = bundles.some((t) => /[rR]/.test(t)) || leading.includes("--recursive");
  const force = bundles.some((t) => t.includes("f")) || leading.includes("--force");
  if (recursive && force) return true;
  if (leading.includes("--no-preserve-root")) return true;
  return texts.some((t) => t !== null && /^(?:of|if)=/.test(t));
}

/** Why an invocation runs a destructive program through indirection, or null. */
function indirectHit(inv: Invocation): string | null {
  if (!inv.indirect) return null;
  const written = inv.word.parts.some((p) => p.kind === "lit" && p.ansi) ? "$'…'" : inv.word.text;
  const named = inv.names.find((n) => DESTRUCTIVE_RE.test(n));
  if (named) return `${written} runs ${named}`;
  const glob = basenameGlob(inv.word);
  if (glob) {
    const matched = DESTRUCTIVE_SAMPLES.find((n) => glob.test(n));
    if (matched) return `${written} can expand to ${matched}`;
  }
  for (const p of inv.word.parts) {
    if (p.kind !== "sub") continue;
    for (const cmd of lexShell(p.body, 6)) {
      const found = cmd.words.map((w) => literalText(w)).find((t) => t !== null && DESTRUCTIVE_RE.test(normalizeName(t)));
      if (found) return `${written} names ${normalizeName(found)}`;
    }
  }
  if (inv.names.length === 0 && looksDestructive(inv.args)) {
    return `${written} is called with rm/dd-style arguments`;
  }
  return null;
}

function blockIndirectExec(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    for (const inv of a.invocations) {
      const why = indirectHit(inv);
      if (why) {
        return deny(
          `Running rm, dd or mkfs through a variable, substitution or glob is blocked (${why}). ` +
            "Write the command out literally so it can be checked.",
        );
      }
    }
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-indirect-exec");
  }
}

// ── block-chmod-777 ─────────────────────────────────────────────────────────

const CHMOD_FLAG_RE = /^-[RfvchHLP]+$/;

/**
 * Whether a chmod-style mode grants write to "others" (world-writable).
 *
 * The sticky bit changes nothing for a file — `chmod 1777 file` leaves it
 * `-rwxrwxrwt`, writable by anyone — and `chmod -R` applies the mode to files
 * too. Only a mode given to a directory being CREATED (`mkdir -m 1777`) is the
 * /tmp-style shared directory the sticky bit makes safe; pass `directory` for
 * that and it is exempt.
 */
export function worldWritableMode(mode: string, directory = false): boolean {
  const m = mode.trim();
  if (/^[0-7]+$/.test(m)) {
    // Any number of digits (`00777`); only the last four carry permission bits.
    const v = parseInt(m.slice(-4), 8);
    if ((v & 0o002) === 0) return false;
    return !(directory && (v & 0o1000) !== 0);
  }
  for (const clause of m.split(",")) {
    const cm = /^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/.exec(clause);
    if (!cm) continue;
    const who = cm[1];
    if (!who.includes("a") && !who.includes("o")) continue;
    for (const op of cm[2].matchAll(/([-+=])([rwxXstugo]*)/g)) {
      const perms = op[2];
      if (op[1] === "-") continue;
      if (!perms.includes("w") && !/[ug]/.test(perms)) continue;
      if (directory && perms.includes("t")) continue;
      return true;
    }
  }
  return false;
}

/** The mode word a chmod invocation applies, or null (`--reference`, no operand). */
function chmodModeWord(args: ShellWord[]): ShellWord | null {
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) return args[k];
    if (t === "--") return args[k + 1] ?? null;
    if (t.startsWith("--reference")) return null;
    if (t.startsWith("--")) continue;
    if (CHMOD_FLAG_RE.test(t)) continue;
    return args[k];
  }
  return null;
}

/** The `-m`/`--mode` value of mkdir/install. */
function modeFlagWord(args: ShellWord[]): ShellWord | null {
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t === null) continue;
    if (t === "--") break;
    if (t === "--mode") return args[k + 1] ?? null;
    if (t.startsWith("--mode=")) return dropPrefix(args[k], "--mode=".length);
    if (t.startsWith("--")) continue;
    // `-m 777`, `-pm 777`, `-m777`, `-Dm644`.
    const m = /^-[a-zA-Z]*?m(.*)$/.exec(t);
    if (m) return m[1] ? dropPrefix(args[k], t.length - m[1].length) : (args[k + 1] ?? null);
  }
  return null;
}

/** Whether `install` is creating directories (`install -d`), so its mode applies to a directory. */
function installCreatesDirectories(args: ShellWord[]): boolean {
  for (const t of lits(args)) {
    if (t === null) continue;
    if (t === "--") break;
    if (t === "--directory") return true;
    if (!t.startsWith("--") && /^-[a-zA-Z]*d/.test(t)) return true;
  }
  return false;
}

/** icacls grants of write/modify/full control to Everyone. */
function icaclsWorldWrite(args: ShellWord[]): string | null {
  // An unquoted `*S-1-1-0:F` is a glob to literalText, but icacls reads it as
  // written; a word of plain text is taken as its text.
  const texts = args.map((w) => literalText(w) ?? (w.parts.every((p) => p.kind === "lit") ? w.text : null));
  for (let k = 0; k < texts.length; k++) {
    if (!/^\/grant(?::r)?$/i.test(texts[k] ?? "")) continue;
    for (let j = k + 1; j < texts.length; j++) {
      const t = texts[j];
      if (t === null || t.startsWith("/")) break;
      const sep = t.indexOf(":");
      if (sep === -1) continue;
      const who = t.slice(0, sep).toLowerCase();
      if (who !== "everyone" && who !== "*s-1-1-0") continue;
      const perms = t.slice(sep + 1).toUpperCase().replace(/\((?:OI|CI|IO|NP|I)\)/g, "");
      if (/(?:^|[(,])(?:F|M|W|WD|AD|GA|GW)(?:$|[),])/.test(perms)) return `icacls /grant ${t}`;
    }
  }
  return null;
}

function blockChmod777(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    const hit = (why: string) =>
      deny(`Making files world-writable is blocked (${why}). Grant only what is needed, e.g. chmod 755 or chmod u+w.`);
    for (const inv of a.invocations) {
      for (const name of inv.names) {
        let modeWord: ShellWord | null = null;
        let directory = false;
        if (name === "chmod") modeWord = chmodModeWord(inv.args);
        else if (name === "mkdir" || name === "install") {
          modeWord = modeFlagWord(inv.args);
          directory = name === "mkdir" || installCreatesDirectories(inv.args);
        } else if (name === "icacls") {
          const why = icaclsWorldWrite(inv.args);
          if (why) return hit(why);
          continue;
        }
        if (!modeWord) continue;
        const mode = valuesOf(a, modeWord)?.find((v) => worldWritableMode(v, directory));
        if (mode !== undefined) return hit(`${name} ${name === "chmod" ? "" : "-m "}${mode}`);
      }
    }
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-chmod-777");
  }
}

export {
  blockDiskDestruction,
  blockGhDestructive,
  blockMassKill,
  blockNoVerify,
  blockIndirectExec,
  blockChmod777,
};
