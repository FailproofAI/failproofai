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
  resetResolution,
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
 *
 * Each read starts from the analysis as `analyzeShell` left it: a word one
 * policy could not resolve (a variable chain too deep to follow) truncates
 * that policy's verdict only — not the policies after it, and not a later
 * hook event carrying the same command.
 */
let lastAnalysis: { command: string; analysis: ShellAnalysis } | null = null;

function analysisFor(ctx: PolicyContext): ShellAnalysis | null {
  const command = shellCommand(ctx);
  if (!command || !command.trim()) return null;
  if (lastAnalysis?.command !== command) lastAnalysis = { command, analysis: safeAnalyze(command) };
  resetResolution(lastAnalysis.analysis);
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
      if (literalPrefix(w).startsWith("of=")) {
        const dev = deviceTarget(a, dropPrefix(w, 3), cwds, DISK_TOOL_STRICT);
        if (dev) return `dd of=${dev}`;
        continue;
      }
      // `T=of=/dev/sda; dd if=/dev/zero $T` hides the operand, not just its
      // value: the whole word has to be resolved before it reads as harmless.
      if (literalText(w) !== null) continue;
      for (const v of resolveWord(a, w) ?? []) {
        if (!v.startsWith("of=")) continue;
        const target = v.slice(3);
        if (isDevicePath(target, cwds, true)) return `dd of=${target}`;
      }
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

/** Verbs that destroy the resource named before them. */
const GH_DELETE_VERBS = new Set(["delete", "remove"]);

/**
 * Every reading of a `gh` positional word, lower-cased, or null when the
 * command string cannot say what it is. `N=release; gh $N delete v1` deletes
 * the release the literal form does, so the word is resolved rather than read
 * as empty — which is what let a one-variable rewrite walk past this policy.
 */
function ghPositional(a: ShellAnalysis, word: ShellWord, literal: string | null): string[] | null {
  if (literal !== null) return [literal.toLowerCase()];
  const values = resolveWord(a, word);
  return values && values.length ? values.map((v) => v.trim().toLowerCase()) : null;
}

function ghHit(a: ShellAnalysis, args: ShellWord[]): string | null {
  const texts = lits(args);
  if (texts.some((t) => t === "--help" || t === "-h")) return null;
  // `values` is null for a word this command cannot resolve to anything.
  const positional: Array<{ values: string[] | null; index: number }> = [];
  for (let k = 0; k < args.length && positional.length < 3; k++) {
    const t = texts[k];
    if (t === null) {
      positional.push({ values: ghPositional(a, args[k], null), index: k });
      continue;
    }
    if (t === "-R" || t === "--repo" || t === "--hostname") {
      k++;
      continue;
    }
    if (t.startsWith("-")) continue;
    positional.push({ values: [t.toLowerCase()], index: k });
  }
  if (!positional.length) return null;
  const firsts = positional[0].values;
  const nouns = firsts === null ? null : firsts.map((v) => (Object.hasOwn(GH_NOUN_ALIASES, v) ? GH_NOUN_ALIASES[v] : v));
  // Absent (no second word), unresolvable (null), or its readings.
  const verbs = positional[1] === undefined ? undefined : positional[1].values;
  const thirds = positional[2]?.values;
  const verbIs = (v: string) => verbs?.includes(v) ?? false;
  if (nouns?.includes("api")) {
    const hit = ghApiHit(a, args.slice(positional[0].index + 1));
    if (hit) return hit;
  }
  const deletable = nouns?.find((n) => GH_DELETABLE.has(n));
  if (deletable !== undefined) {
    // `gh release $VERB v1` with a verb the command cannot resolve: the same
    // rule `gh api -X $METHOD` follows, on a command shape just as destructive.
    if (verbs === null) return `gh ${deletable} <unresolved verb>`;
    const verb = [...GH_DELETE_VERBS].find(verbIs);
    if (verb) return `gh ${deletable} ${verb}`;
  }
  // An unresolvable noun with a delete verb: `gh $N delete v1` deletes something.
  if (nouns === null && verbs?.some((v) => GH_DELETE_VERBS.has(v))) return "gh <unresolved> delete";
  if (nouns?.includes("release") && verbIs("delete-asset")) return "gh release delete-asset";
  if (nouns?.includes("project")) {
    const verb = ["item-delete", "field-delete"].find(verbIs);
    if (verb) return `gh project ${verb}`;
  }
  if (nouns?.includes("repo") && verbIs("deploy-key") && thirds?.includes("delete")) return "gh repo deploy-key delete";
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

/**
 * POSIX character classes, which pgrep/killall/grep understand and JavaScript
 * does not: `[[:alpha:]]ode` compiles in JS to "one of `[:alph`, then a literal
 * `]`, then ode", which matches nothing, so the pattern read as a JS regex said
 * "narrow" about a pattern that reaches every `node` on the box.
 */
const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z", alnum: "A-Za-z0-9", digit: "0-9", lower: "a-z", upper: "A-Z",
  space: "\\s", blank: " \\t", word: "\\w", cntrl: "\\x00-\\x1f", print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e", punct: "!-/:-@\\[-`{-~", xdigit: "0-9A-Fa-f",
};

/** A POSIX ERE rewritten so a JS regex reads it the way pgrep/grep would. */
function toJsRegex(pattern: string): string {
  return pattern.replace(/\[:([a-z]+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole);
}

/**
 * Whether an unanchored pattern selects a generic process name the way pkill
 * really applies it: as a REGEX SEARCH over the name, so `nod`, `ode`, `n.de`,
 * `^nod` and `nod.*` all reach every `node` on the box, and `ytho` reaches
 * every `python`. Comparing normalised strings instead let every one of those
 * spellings walk past a policy that denies `pkill node`.
 *
 * The match runs the caller's pattern against names of at most a dozen
 * characters, so even a pathological pattern cannot cost much; an invalid
 * regex (pkill would reject it too) falls back to substring containment.
 *
 * The direction matters and is the reason this stays quiet on ordinary
 * commands: the pattern is matched against the generic name, never the other
 * way round, so `pkill vite`, `pkill my-worker` and `pkill -f node.*worker`
 * match nothing in the list. `nod$` does not match `node` either — and pkill
 * would not kill it.
 */
function matchesGenericName(pattern: string, ignoreCase = false, exact = false): boolean {
  let re: RegExp;
  try {
    // `-x` makes pkill require the WHOLE name to match, which is still a regex:
    // `pkill -x 'node|myapp'` reaches every node.
    re = new RegExp(exact ? `^(?:${toJsRegex(pattern)})$` : toJsRegex(pattern), ignoreCase ? "i" : "");
  } catch {
    const raw = stripPattern(pattern);
    if (raw.length === 0) return false;
    return exact ? GENERIC_PROCESS_NAMES.has(raw) : [...GENERIC_PROCESS_NAMES].some((n) => n.includes(raw));
  }
  for (const name of GENERIC_PROCESS_NAMES) if (re.test(name)) return true;
  return false;
}

/**
 * Whether a pkill/pgrep pattern (a regex matched as a substring unless `-x`)
 * reaches too much.
 *
 * The regex reading comes FIRST, before the `|` split. pkill compiles the
 * pattern whole, so `n(o|0)de` reaches every `node`; splitting on `|` first
 * shredded it into `n(o` and `0)de`, two fragments that compile to nothing and
 * match nothing — a parenthesised alternation was a one-character rewrite past
 * a policy that denies `pkill nod`. The split stays for the case it was written
 * for, a top-level list (`node|myapp`), where it catches an alternative that is
 * broad on its own even though the whole pattern is not.
 */
function broadPattern(pattern: string, exact: boolean, ignoreCase = false): boolean {
  const raw = stripPattern(pattern);
  if (/^[.*+?\s\\^$]*$/.test(raw)) return true;
  if (GENERIC_PROCESS_NAMES.has(patternTarget(pattern))) return true;
  if (matchesGenericName(pattern, ignoreCase, exact)) return true;
  if (pattern.includes("|")) return pattern.split("|").some((alt) => broadPattern(alt, exact, ignoreCase));
  // `-x` compares the whole name, so only the name itself reaches the name.
  if (exact) return false;
  // Unanchored and short, it is a substring of half the process table: `pkill sh`.
  return raw.length <= 2;
}

/** Why a pkill/pgrep invocation selects processes en masse, or null. */
function pgrepMass(a: ShellAnalysis, tool: string, args: ShellWord[]): string | null {
  let exact = false;
  let full = false;
  let inverse = false;
  let userSel = false;
  let ignoreCase = false;
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
      else if (flag === "--ignore-case") ignoreCase = true;
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
        else if (ch === "i") ignoreCase = true;
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
  const hit = values?.find((v) => broadPattern(v, exact, ignoreCase));
  return hit !== undefined ? `${tool} ${full ? "-f " : ""}${hit || "''"}` : null;
}

function killallMass(a: ShellAnalysis, args: ShellWord[]): string | null {
  let regex = false;
  let userSel = false;
  let info = false;
  let ignoreCase = false;
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
      else if (flag === "--ignore-case") ignoreCase = true;
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
        else if (ch === "I") ignoreCase = true;
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
      if (regex ? broadPattern(v, false, ignoreCase) : GENERIC_PROCESS_NAMES.has(patternTarget(v))) return `killall ${v}`;
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

// ── what narrows a `ps` listing ─────────────────────────────────────────────

/**
 * `ps … | awk '/node/ {print $2}' | xargs kill` reaches exactly the processes
 * `ps … | grep node | awk '{print $2}' | xargs kill` reaches, and is the more
 * common spelling of the two. So do the `sed`, `perl` and `python` forms. Only
 * grep used to count as a filter, which made a one-word rewrite a bypass.
 */
const AWK_NAMES = new Set(["awk", "gawk", "mawk", "nawk", "busybox-awk"]);
const SCRIPT_FILTERS = new Set([
  ...AWK_NAMES, "sed", "perl", "python", "python2", "python3", "ruby",
]);
/** A filter script longer than this is not read further; the cost is not worth it. */
const MAX_SCRIPT_TEXT = 4000;
/** At most this many literals are taken out of one script. */
const MAX_SCRIPT_LITERALS = 64;

/** The scripts an awk/sed/perl/python invocation may run, flags dropped and variables resolved. */
function filterScripts(a: ShellAnalysis, args: ShellWord[]): string[] {
  const out: string[] = [];
  for (const w of args) {
    const t = literalText(w);
    if (t !== null) {
      if (t.startsWith("-") && t.length > 1) continue;
      out.push(t);
      continue;
    }
    for (const v of resolveWord(a, w) ?? []) if (!v.startsWith("-")) out.push(v);
  }
  return out;
}

/** A literal is a selector only where it decides which lines survive. */
const AWK_MATCH_CALL = /(?:index|match)\([^()]*,?$/;

/**
 * The literals in a filter script that DECIDE WHICH PROCESSES SURVIVE: an awk
 * pattern or a `~`/`==` comparison, a sed address, a perl match, an
 * `index(…)`/`match(…)` argument.
 *
 * Everything else is dropped, and that is the point. A `s///`'s search text and
 * a `sub(/…/,"")`'s pattern cannot remove a line from the listing, so they say
 * nothing about how far the kill reaches — reading them as patterns denied nine
 * ordinary, already-narrowed pipelines (`ps aux | grep myapp | sed 's/node/N/'
 * | awk '{print $2}' | xargs kill`) on a policy no judge can clear. When such a
 * stage is the ONLY thing on a chain, the listing was never narrowed at all,
 * and the "ps listing every process" rule below is what catches it.
 */
function scriptSelectors(tool: string, scriptText: string): string[] {
  const script = scriptText.slice(0, MAX_SCRIPT_TEXT);
  const selectors: string[] = [];
  const awk = AWK_NAMES.has(tool);
  const sed = tool === "sed";
  let depth = 0;
  // The significant characters just before, spaces dropped: enough to tell a
  // `~`/`==` comparison, an `index($0, …)` and a sed address from ordinary
  // script text. Long enough to hold the longest of those openers.
  let prev = "";
  const note = (ch: string) => {
    prev = (prev + ch).slice(-16);
  };
  for (let i = 0; i < script.length && selectors.length < MAX_SCRIPT_LITERALS; i++) {
    const ch = script[i];
    if (ch === "'" || ch === '"') {
      let value = "";
      let j = i + 1;
      for (; j < script.length && script[j] !== ch; j++) {
        if (script[j] === "\\" && j + 1 < script.length) value += script[++j];
        else value += script[j];
      }
      if (/[=~]$/.test(prev) || AWK_MATCH_CALL.test(prev)) selectors.push(value);
      i = j;
      note("S");
      continue;
    }
    if (ch === "/") {
      let value = "";
      let j = i + 1;
      for (; j < script.length && script[j] !== "/" && script[j] !== "\n"; j++) {
        if (script[j] === "\\" && j + 1 < script.length) {
          value += script[j] + script[j + 1];
          j++;
        } else value += script[j];
      }
      if (j >= script.length || script[j] !== "/") {
        note("/");
        continue;
      }
      const address = prev === "" || /[;{}!,\n]$/.test(prev);
      const selects = awk
        ? depth === 0 || /~$/.test(prev) || AWK_MATCH_CALL.test(prev)
        : sed
          ? address
          : /(?:[~(!]|if|unless|&&|\|\|)$/.test(prev) || AWK_MATCH_CALL.test(prev);
      if (selects) selectors.push(value);
      i = j;
      note("R");
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (!/\s/.test(ch)) note(ch);
    else if (ch === "\n") note("\n");
  }
  return selectors;
}

/** A pattern that names a generic process outright — no substring reading, for a literal that may not be a selector at all. */
function targetsGenericName(pattern: string): boolean {
  return pattern.split("|").some((alt) => GENERIC_PROCESS_NAMES.has(patternTarget(alt)));
}

/**
 * Two lines with no generic process name in them. A selector that takes BOTH
 * selects nothing in particular, so the stage in front of the kill narrowed
 * the listing by nothing.
 */
const NOT_A_SELECTION = ["myapp", "4242 pts/1    00:00:07 /opt/my-worker --flag"];

/** Whether a selector matches every line there is: an empty pattern, a bare dot-star, a lone space. */
function matchesEverything(pattern: string): boolean {
  // `^$` has nothing left once the anchors come off too, and matches only a
  // blank line — so the anchors have to be read, not just what they leave.
  if (!/[$^]/.test(pattern) && stripPattern(pattern).replace(/[.*+?\\\s]/g, "") === "") return true;
  try {
    const re = new RegExp(toJsRegex(pattern));
    return NOT_A_SELECTION.every((line) => re.test(line));
  } catch {
    return false;
  }
}

/**
 * Whether an awk/sed/perl SELECTOR reaches processes en masse.
 *
 * Deliberately NOT the grep-tuned `broadPattern`. That one calls any pattern of
 * two characters or fewer, or one made only of metacharacters, broad — true of
 * a pkill pattern, which is matched against a process NAME, and false of a
 * script selector, which is a test over a line of a listing: `$2 ~ /^Z/` reaps
 * zombies, `$2 ~ /:/` picks out an elapsed time, `/^$/` drops blank lines, and
 * none of them says anything about a process name. Only two readings belong
 * here: the selector names a generic process, or it takes every line there is.
 */
function broadScriptSelector(pattern: string): boolean {
  return targetsGenericName(pattern) || matchesGenericName(pattern) || matchesEverything(pattern);
}

/** `ps` long options that pick a subset of processes, so the listing is not everything. */
const PS_SELECT_LONG = new Set([
  "--pid", "--ppid", "--quick-pid", "--sid", "--tty", "--user", "--User", "--group", "--Group",
  "--command",
]);
/** `ps` long options whose value is a separate word and says nothing about which processes. */
const PS_VALUE_LONG = new Set(["--format", "--sort", "--width", "--cols", "--columns", "--rows", "--lines"]);
/** `ps` short options that pick a subset of processes. Each takes a value, so scanning stops there. */
const PS_SELECT_SHORT = new Set(["p", "q", "s", "t", "u", "U", "G", "g", "C", "T"]);

/**
 * Whether a `ps` invocation lists every process on the box: `ps aux`, `ps -e`,
 * `ps -A`, `ps -ef`, `ps -eo pid=`.
 *
 * The option ARGUMENTS are consumed, not scanned. Reading a flag bundle as a
 * bag of letters made `ps -eopid=` — the same listing as `ps -eo pid=`, checked
 * on this box — look like the `-p <pid>` selector, because its output FORMAT
 * ends in letters a selector also uses. One space was the whole difference
 * between a pinned deny and an allow.
 */
function psListsEverything(texts: Array<string | null>): boolean {
  let all = false;
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k];
    // A word the command string cannot read could be a selector.
    if (t === null) return false;
    // BSD `ps 1234`: one process.
    if (/^\d+$/.test(t)) return false;
    if (t.startsWith("--")) {
      const flag = t.split("=")[0];
      if (PS_SELECT_LONG.has(flag)) return false;
      if (PS_VALUE_LONG.has(flag) && !t.includes("=")) k++;
      continue;
    }
    const dashed = t.startsWith("-");
    const bundle = dashed ? t.slice(1) : t;
    // `aux` and the widely written `-aux` are the BSD spelling of "every
    // process"; its `u` is an output format, not the `-u <user>` selector.
    if (bundle.includes("a") && bundle.includes("x")) {
      all = true;
      continue;
    }
    for (let j = 0; j < bundle.length; j++) {
      const ch = bundle[j];
      // `-o`/`-O` take a format: the rest of this word, or the next one. Either
      // way it is a value, and no letter in it is a flag.
      if (ch === "o" || ch === "O") {
        if (j === bundle.length - 1) k++;
        break;
      }
      // A dashless word is an operand or a BSD bundle, never a `-p`-style
      // selector — `ps axo pid=` must stay "every process".
      if (dashed && PS_SELECT_SHORT.has(ch)) return false;
      if (ch === "e" || ch === "A") all = true;
    }
  }
  return all;
}

/** Tools that reshape or reorder lines and cannot drop one: none of them can take a process out of the listing. */
const LINE_PASSTHROUGH = new Set(["ps", "xargs", "kill", "tr", "cut", "cat", "tee", "sort", "uniq", "nl", "rev"]);

/** Column headings `ps` prints, for the matches that can only drop the header line. */
const PS_HEADER_WORDS =
  "user|pid|ppid|uid|gid|command|cmd|args|tty|tt|stat|s|state|time|start|started|elapsed|etime|" +
  "rss|vsz|sz|%cpu|%mem|c|ni|pri|nlwp|lwp|psr|wchan";
/** `/^USER/`, `!/^PID/`: an awk test that can only take out the header line. */
const AWK_HEADER_TEST = new RegExp(`!?/\\^?(?:${PS_HEADER_WORDS})\\b[^/\\n]*/`, "gi");

/** `tail` that drops only LEADING lines (`tail -n +2`): every process row after the header survives. */
function tailDropsOnlyLeadingLines(texts: Array<string | null>): boolean {
  let fromLine = false;
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k];
    if (t === null) return false;
    if (t === "-n" || t === "--lines") {
      const v = texts[k + 1];
      if (typeof v !== "string" || !/^\+\d+$/.test(v)) return false;
      fromLine = true;
      k++;
      continue;
    }
    if (/^--lines=\+\d+$/.test(t) || /^-n\+\d+$/.test(t) || /^\+\d+$/.test(t)) {
      fromLine = true;
      continue;
    }
    if (t === "-q" || t === "--quiet" || t === "--silent") continue;
    return false;
  }
  return fromLine;
}

/** `s/…/…/flags`: a substitution rewrites a line and cannot delete one. */
function isSedSubstitution(script: string): boolean {
  if (script.length < 5 || script[0] !== "s") return false;
  const delim = script[1];
  if (/[\\\s\w]/.test(delim)) return false;
  let seen = 0;
  for (let i = 2; i < script.length; i++) {
    if (script[i] === "\\") {
      i++;
      continue;
    }
    if (script[i] !== delim) continue;
    if (++seen === 2) return /^[gpiImw0-9]*$/.test(script.slice(i + 1));
  }
  return false;
}

/**
 * A `sed` that keeps every process row: a substitution, or a delete.
 *
 * A delete is an INVERSE selection, the same shape as `grep -v` above:
 * `sed 1d` and `sed '/^$/d'` take out the header and the blank lines, and even
 * `sed '/node/d'` leaves every other process for the kill — none of them
 * narrows the listing to a subset anybody chose. `sed '/node/!d'` does, and is
 * not here; neither is `-n`, which prints only what a `p` asks for.
 */
function sedKeepsEveryProcess(a: ShellAnalysis, args: ShellWord[]): boolean {
  if (lits(args).some((t) => t !== null && /^-[a-zA-Z]*n/.test(t))) return false;
  const scripts = filterScripts(a, args);
  if (scripts.length === 0) return false;
  return scripts.every((text) =>
    text.length <= MAX_SCRIPT_TEXT &&
    text
      .split(/[;\n]/)
      .map((one) => one.trim())
      .filter(Boolean)
      .every(
        (one) =>
          /^\d+(?:,\d+)?\s*d$/.test(one) ||
          /^\/(?:[^/\\\n]|\\.)*\/\s*d$/.test(one) ||
          isSedSubstitution(one),
      ),
  );
}

/**
 * An `awk` that keeps every process row: its only tests are on the record
 * NUMBER (`NR>1`, `NR!=1`) or on the `ps` header line (`/^USER/{next}`), and a
 * `sub()`/`gsub()` only rewrites what it matched. None of those can drop a
 * process, so none of them narrows the listing the kill is about to read.
 */
function awkKeepsEveryProcess(a: ShellAnalysis, args: ShellWord[]): boolean {
  const scripts = filterScripts(a, args);
  if (scripts.length === 0) return false;
  return scripts.every((text) => {
    if (text.length > MAX_SCRIPT_TEXT) return false;
    const rest = text
      .replace(/\bNR\s*(?:[<>]=?|[!=]=)\s*\d+/g, "T")
      .replace(/\d+\s*(?:[<>]=?|[!=]=)\s*\bNR\b/g, "T")
      .replace(AWK_HEADER_TEST, "T")
      .replace(/\bg?sub\s*\(\s*\/(?:[^/\n\\]|\\.)*\/\s*,/g, "T(");
    // `$1 == "node"` and `$0 ~ /node/` decide which rows survive; `NF`, a
    // `getline` or an `exit` can end the stream early.
    return !/[~<>]|==|!=|\bNF\b|\bNR\b|\bgetline\b|\bexit\b|\bsystem\b|\/(?:[^/\n\\]|\\.)*\//.test(rest);
  });
}

/** Whether a grep invocation is an INVERSE match, which selects no process in particular. */
function grepIsInverse(texts: Array<string | null>): boolean {
  return texts.some((t) => t !== null && (t === "--invert-match" || (/^-[a-zA-Z]+$/.test(t) && t.includes("v"))));
}

/**
 * A stage that cannot take a process OUT of the listing — it reshapes lines,
 * reorders them, or drops the header `ps` printed. Used for the one case no
 * pattern can describe: nothing on the chain narrows at all, so the kill
 * reaches every process `ps` found.
 *
 * Header stripping belongs here, not outside. The rule used to accept only an
 * awk program with no test in it, which made `ps aux | awk '{print $2}'` — the
 * one spelling that does NOT work, because `kill` aborts on the literal `PID`
 * the header puts first — the only denied form, while `NR>1`, `tail -n +2`,
 * `sed 1d` and a `cat` in the middle all walked through and killed the box.
 */
function keepsEveryProcess(a: ShellAnalysis, name: string, args: ShellWord[]): boolean {
  if (LINE_PASSTHROUGH.has(name)) return true;
  if (name === "tail") return tailDropsOnlyLeadingLines(lits(args));
  if (name === "sed") return sedKeepsEveryProcess(a, args);
  if (AWK_NAMES.has(name)) return awkKeepsEveryProcess(a, args);
  // `grep -v node` excludes one name and keeps every other process, which is
  // still every process this kill can reach; `grep node` selects.
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") return grepIsInverse(lits(args));
  return false;
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
        if (grepIsInverse(texts)) continue;
        const ignoreCase = texts.some(
          (t) => t !== null && (t === "--ignore-case" || (/^-[a-zA-Z]+$/.test(t) && t.includes("i"))),
        );
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
        if (pattern !== null && broadPattern(pattern, false, ignoreCase)) return `ps | grep ${pattern}`;
      } else if (psPresent && SCRIPT_FILTERS.has(name)) {
        for (const script of filterScripts(a, inv.args)) {
          const selector = scriptSelectors(name, script).find(broadScriptSelector);
          if (selector !== undefined) return `ps | ${name} ${selector || "''"}`;
        }
      }
    }
  }
  // Nothing on the chain narrows a listing of every process, so the kill takes
  // all of them: `ps aux | awk '{print $2}' | xargs kill`, `ps -eo pid= | xargs
  // kill`. Every stage has to be demonstrably unable to drop a row — anything
  // this cannot read that way leaves the rule silent and the checks above in
  // charge.
  const everything = invs.some((inv) => inv.names.includes("ps") && psListsEverything(lits(inv.args)));
  if (everything && invs.every((inv) => inv.names.some((n) => keepsEveryProcess(a, n, inv.args)))) {
    return "ps listing every process";
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
  assignments: Map<string, ShellWord[]> | null;
  derived: Map<string, string[]> | null;
  filterNames: Set<string> | null;
}
const killMemos = new WeakMap<ShellAnalysis, KillMemo>();

function killMemo(a: ShellAnalysis): KillMemo {
  let m = killMemos.get(a);
  if (!m) killMemos.set(a, (m = { subs: new WeakMap(), filters: new Map(), byCommand: null, assignments: null, derived: null, filterNames: null }));
  return m;
}

/** Words that can stand in front of an assignment without ending the command prefix. */
const COMMAND_PREFIX_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "{", "(", "!", "time"]);

/**
 * Every value a name is given, including the assignments the analysis does not
 * carry: `if …; then P=$(pgrep node); kill $P; fi` and `do cl=$(…)` assign in a
 * command prefix the parser reads as an argument of `then`/`do`, so they never
 * reach `bindings` — and a `then` in front of the assignment used to be enough
 * to hide the listing that feeds a kill.
 *
 * Only a real command prefix counts: keywords, then assignment words, stopping
 * at the first command word, so `echo P=$(pgrep node)` still assigns nothing.
 */
function assignmentsIn(a: ShellAnalysis): Map<string, ShellWord[]> {
  const memo = killMemo(a);
  if (memo.assignments) return memo.assignments;
  const out = new Map<string, ShellWord[]>();
  for (const [name, words] of a.bindings) out.set(name, [...words]);
  for (const cmd of a.commands) {
    for (const w of cmd.words) {
      const t = literalText(w);
      if (t !== null && COMMAND_PREFIX_KEYWORDS.has(t)) continue;
      const m = /^([A-Za-z_]\w*)=/.exec(literalPrefix(w));
      if (!m) break;
      const value = dropPrefix(w, m[0].length);
      const list = out.get(m[1]);
      if (!list) out.set(m[1], [value]);
      else if (!list.some((v) => v.text === value.text)) list.push(value);
    }
  }
  memo.assignments = out;
  return out;
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

/** Derived names followed out from the PID variable, and how many of them are kept. */
const MAX_PID_NAME_ROUNDS = 4;
const MAX_PID_NAMES = 64;
/** Tools whose arguments decide something about one process. */
const FILTER_TOOLS = new Set(["[", "[[", "test", "grep", "egrep", "rg"]);

/** Every name a word expands, including inside a substitution or a parameter's default. */
function namesRead(word: ShellWord): Set<string> {
  const out = new Set<string>();
  for (const p of word.parts) {
    if (p.kind === "lit") continue;
    if (p.kind === "param" && p.name) out.add(p.name);
    for (const m of p.source.matchAll(/\$\{?(\w+)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * Which names a name flows INTO: `cl=$(tr '\0' ' ' < /proc/$p/cmdline)` records
 * p → cl, so a `case "$cl" in` counts as a decision about the process that
 * `$p` names. Built once per analysis; the walk below is per PID variable.
 */
function derivedFrom(a: ShellAnalysis): Map<string, string[]> {
  const memo = killMemo(a);
  if (memo.derived) return memo.derived;
  const out = new Map<string, string[]>();
  for (const [name, words] of assignmentsIn(a)) {
    for (const w of words) {
      for (const read of namesRead(w)) {
        if (read === name) continue;
        const list = out.get(read);
        if (!list) out.set(read, [name]);
        else if (!list.includes(name)) list.push(name);
      }
    }
  }
  memo.derived = out;
  return out;
}

/** The PID variable and the names the command derives from it. */
function pidNames(a: ShellAnalysis, variable: string): Set<string> {
  const names = new Set([variable]);
  const edges = derivedFrom(a);
  let frontier = [variable];
  for (let round = 0; round < MAX_PID_NAME_ROUNDS && frontier.length && names.size < MAX_PID_NAMES; round++) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const derived of edges.get(name) ?? []) {
        if (names.has(derived) || names.size >= MAX_PID_NAMES) continue;
        names.add(derived);
        next.push(derived);
      }
    }
    frontier = next;
  }
  return names;
}

/**
 * Every name some per-process decision reads: a test or a grep's arguments
 * (`[ "$p" = "$$" ]`, `grep -q x /proc/$p/cmdline`) and a `case`/`if` head
 * (`case "$cl" in`). Built once per analysis.
 */
function filterNames(a: ShellAnalysis): Set<string> {
  const memo = killMemo(a);
  if (memo.filterNames) return memo.filterNames;
  const out = new Set<string>();
  const add = (w: ShellWord) => {
    for (const n of namesRead(w)) out.add(n);
  };
  for (const inv of a.invocations) {
    if (!inv.names.some((n) => FILTER_TOOLS.has(n))) continue;
    for (const w of inv.args) add(w);
  }
  for (const cmd of a.commands) {
    const at = cmd.words.findIndex((w) => {
      const t = literalText(w);
      return t === "case" || t === "if" || t === "elif";
    });
    if (at >= 0) for (const w of cmd.words.slice(at + 1)) add(w);
  }
  memo.filterNames = out;
  return out;
}

/**
 * The command decides per process before killing: a `case`/`if` head, a test or
 * a grep THAT READS THE PID VARIABLE (`grep -q x /proc/$p/cmdline && kill $p`,
 * `case "$cl" in` where `cl` came from `$p`). A grep that only builds the list
 * (`$(ps aux | grep node)`) is not a filter, and neither is a conditional that
 * decides something else: `if true; then kill $P; fi` and `[ 1 = 1 ]` used to
 * count, which made a no-op conditional anywhere in the command a one-line
 * bypass of a policy no reviewer can clear.
 *
 * Memoized per variable, which is sound because the answer depends on the
 * variable's data dependencies and nothing about the kill site.
 */
function filtersBeforeKilling(a: ShellAnalysis, variable: string): boolean {
  const memo = killMemo(a).filters;
  const cached = memo.get(variable);
  if (cached !== undefined) return cached;
  const filters = filterNames(a);
  let hit = false;
  for (const name of pidNames(a, variable)) {
    if (!filters.has(name)) continue;
    hit = true;
    break;
  }
  memo.set(variable, hit);
  return hit;
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
      for (const bound of assignmentsIn(a).get(p.name) ?? []) {
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

/**
 * The commands git SHIPS, which an alias can never stand for.
 *
 * git.c runs `handle_builtin()`, then `execv_dashed_external()`, and only then
 * `handle_alias()` — so `git -c alias.commit=status commit --no-verify` runs
 * the real commit and IGNORES the alias entirely (checked against git 2.43:
 * `git -c alias.version=status version` prints the version, while the same
 * line with a name git does not ship expands). Expanding such an alias and
 * trusting what it said about the expansion skipped every check the real
 * subcommand would have failed — one `-c alias.commit=status` removed the deny
 * from every `--no-verify` spelling there is.
 *
 * `git --list-cmds=builtins` from 2.43, plus the shipped porcelain scripts. A
 * name here is one no alias can shadow; a name missing from it is only expanded
 * as an alias, which is what the checks below already handle.
 */
const GIT_COMMANDS = new Set(
  ("add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr " +
    "check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index cherry " +
    "cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential " +
    "credential-cache credential-cache--daemon credential-store describe diagnose diff diff-files " +
    "diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch " +
    "fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc " +
    "get-tar-commit-id grep hash-object help hook index-pack init init-db interpret-trailers log " +
    "ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file " +
    "merge-index merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree " +
    "merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant " +
    "pack-refs patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase " +
    "receive-pack reflog remote remote-ext remote-fd repack replace request-pull rerere reset restore " +
    "rev-list rev-parse revert rm send-pack shortlog show show-branch show-index show-ref " +
    "sparse-checkout stage stash status stripspace submodule submodule--helper switch symbolic-ref " +
    "tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive " +
    "upload-archive--writer upload-pack var verify-commit verify-pack verify-tag version whatchanged " +
    "worktree write-tree").split(" "),
);
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
  /**
   * The KEYS of `-c key=value` settings whose value is not plain literal text:
   * `-c alias.ci="$B"`, `-c alias.ci=$(cat body)`, `-c alias.ci="${B:-…}"`.
   * Such a value is resolved only as far as the command string states it, and
   * for an alias BODY a partial reading is worse than none — the resolver takes
   * the first word of a `${X:-…}` default, so `${B:-commit --no-verify}` reads
   * back as a plain `commit`.
   */
  opaqueConfigKeys: string[];
}

/**
 * How this parse reads a word: its literal text, or — for `git $SUB`, `git $F`
 * — the value the command binds it to. A word with several readings is read as
 * the one that matters: a hook-running subcommand or an option, so
 * `git ${X:-commit}` is checked as a commit.
 *
 * Null only when the command string genuinely cannot say, which is where the
 * parse still gives up (`git commit $ARGS` is not treated as `--no-verify`).
 */
function gitWord(a: ShellAnalysis, word: ShellWord): string | null {
  const t = literalText(word);
  if (t !== null) return t;
  const values = resolveWord(a, word);
  if (!values || values.length === 0) return null;
  return (
    values.find((v) => HOOK_SUBCOMMANDS.has(v.trim().toLowerCase()) || GIT_GLOBAL_OPERAND.has(v) || v.startsWith("-")) ??
    values[0]
  );
}

/** Every reading of a `-c key=value` word, falling back to its source when it cannot be resolved. */
function configValues(a: ShellAnalysis, word: ShellWord | undefined): string[] {
  if (!word) return [""];
  return resolveWord(a, word) ?? [word.text];
}

function parseGit(a: ShellAnalysis, args: ShellWord[]): GitCall {
  const configs: string[] = [];
  const configEnvs: string[] = [];
  const opaqueConfigKeys: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = gitWord(a, args[k]);
    if (t === null) return { sub: null, subArgs: [], configs, configEnvs, opaqueConfigKeys };
    if (GIT_GLOBAL_OPERAND.has(t)) {
      if (t === "-c") {
        const value = args[k + 1];
        configs.push(...configValues(a, value));
        if (value && literalText(value) === null) {
          opaqueConfigKeys.push((/^([^=]*)=/.exec(literalPrefix(value)) ?? [])[1] ?? "");
        }
      } else if (t === "--config-env") configEnvs.push(...configValues(a, args[k + 1]));
      k++;
      continue;
    }
    if (t.startsWith("--config-env=")) {
      configEnvs.push(t.slice("--config-env=".length));
      continue;
    }
    if (t.startsWith("-")) continue;
    return { sub: t.toLowerCase(), subArgs: args.slice(k + 1), configs, configEnvs, opaqueConfigKeys };
  }
  return { sub: null, subArgs: [], configs, configEnvs, opaqueConfigKeys };
}

/** What one `git commit` argument is: the hook skip itself, an option that takes the next word, `--`, or neither. */
type CommitArg = { hit: string } | "operand" | "end" | "plain";

function classifyCommitArg(t: string): CommitArg {
  if (t === "--") return "end";
  if (t.startsWith("--")) {
    const flag = t.split("=")[0];
    if (NO_VERIFY_RE.test(flag)) return { hit: "git commit --no-verify" };
    return !t.includes("=") && COMMIT_OPERAND_LONG.has(flag) ? "operand" : "plain";
  }
  if (t.startsWith("-") && t.length > 1) {
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (ch === "n") return { hit: "git commit -n" };
      // The rest of the bundle is this option's value (`-mn` is the message "n").
      if (COMMIT_OPERAND_SHORT.has(ch)) return j === t.length - 1 ? "operand" : "plain";
      if (ch === "S" || ch === "u") return "plain";
    }
  }
  return "plain";
}

/**
 * `--no-verify`/`-n` among a `git commit`'s arguments, whether written there or
 * bound to a variable the command sets: `F=--no-verify; git commit $F -m x`
 * skips hooks exactly as the literal does. A word the command string cannot
 * resolve is left alone — `git commit $ARGS` is not read as a skip.
 */
function commitSkipsHooks(a: ShellAnalysis, args: ShellWord[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const t = literalText(args[k]);
    if (t !== null) {
      const c = classifyCommitArg(t);
      if (typeof c === "object") return c.hit;
      if (c === "end") break;
      if (c === "operand") k++;
      continue;
    }
    const values = resolveWord(a, args[k]);
    if (!values || values.length === 0) continue;
    const kinds = values.map((v) => classifyCommitArg(v));
    const hit = kinds.find((c): c is { hit: string } => typeof c === "object");
    if (hit) return hit.hit;
    // Only a reading every value agrees on can move the cursor.
    if (kinds.every((c) => c === "end")) break;
    if (kinds.every((c) => c === "operand")) k++;
  }
  return null;
}

/** `--no-verify` among a `git push`/`merge`/… argument list, written or bound to a variable. */
function hasNoVerify(a: ShellAnalysis, args: ShellWord[]): boolean {
  const skips = (t: string) => NO_VERIFY_RE.test(t.split("=")[0]);
  for (const w of args) {
    const t = literalText(w);
    if (t === null) {
      if ((resolveWord(a, w) ?? []).some(skips)) return true;
      continue;
    }
    if (t === "--") return false;
    if (skips(t)) return true;
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

const MAX_ALIAS_DEFINITIONS = 4;

/**
 * Every inline alias this command defines for `sub`, expanded into the command
 * it stands for: `git -c alias.ci='commit --no-verify' ci -m x` →
 * `git commit --no-verify -m x`, `git -c alias.x='!git commit -n' x` →
 * `git commit -n`. Empty when `sub` is not an alias in scope.
 *
 * ALL of them, not the first: git takes the LAST `-c alias.a=…` on the line
 * (checked against git 2.43: `git -c alias.a=status -c alias.a=version a`
 * prints the version), so reading only the first lets
 * `-c alias.a=status -c alias.a='commit --no-verify'` hide a real commit behind
 * a definition git never uses. A floor checks every definition and denies if
 * any of them reaches a hook skip.
 *
 * Distinct bodies only, and at most `MAX_ALIAS_DEFINITIONS + 1` of them: each
 * one is analysed and recursed into, so N definitions of one name at each of
 * two levels is N² analyses — 120 of each held the hook for 330 ms. Repeating
 * one definition is free after the first, and past the cap the caller stops
 * rather than reads on.
 */
/**
 * One argument of the alias's tail, written so the expansion re-lexes to the
 * same word. `ShellWord.text` has the quotes REMOVED, so joining the tail with
 * it and re-lexing turned a commit message into flags: `git -c alias.ci=commit
 * ci -m 'do not use --no-verify here'` was denied for a `--no-verify` nobody
 * passed — exactly what the note at the top of this file promises cannot
 * happen. A word the command string cannot read keeps its source text, which is
 * what the inner analysis would have seen anyway.
 */
function quoteForRelex(word: ShellWord): string {
  const t = literalText(word);
  return t === null ? word.text : shellQuote(t);
}

function expandInlineAliases(configs: string[], sub: string, subArgs: ShellWord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of configs) {
    const m = /^alias\.([^=]+)=([\s\S]*)$/i.exec(c.trim());
    if (!m || m[1].toLowerCase() !== sub) continue;
    const rest = subArgs.map(quoteForRelex).join(" ");
    const body = m[2].trim();
    const expanded = body.startsWith("!") ? `${body.slice(1)} ${rest}` : `git ${body} ${rest}`;
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
    if (out.length > MAX_ALIAS_DEFINITIONS) break;
  }
  return out;
}

/**
 * What an enclosing `git` invocation still imposes on the command an alias
 * expands to. Expanding an alias used to throw this away and re-read the body
 * on its own, which dropped exactly the settings that disable hooks:
 * `git -c core.hooksPath=/dev/null -c alias.a=commit a`, `HUSKY=0 git -c
 * alias.a=commit a`, and — the reason the `depth` guard below could never fire —
 * the `-c alias.*` definitions that name the NEXT alias in a chain.
 *
 * All four really do reach the expansion: git puts its command-line `-c`
 * settings in `GIT_CONFIG_PARAMETERS`, so they apply to the alias and to any
 * `git` a `!`-alias shells out to (checked against git 2.43:
 * `git -c alias.b='!git a' -c alias.a=version b` prints the version), and an
 * environment prefix is simply inherited.
 *
 * `env` values are resolved at the level that wrote them, because a `ShellWord`
 * can only be resolved against its own analysis.
 */
interface AliasScope {
  configs: string[];
  configEnvs: string[];
  env: Array<{ name: string; values: string[] }>;
  /** `-c` keys whose value the command string does not state; see `GitCall`. */
  opaqueConfigKeys: string[];
}
const EMPTY_SCOPE: AliasScope = { configs: [], configEnvs: [], env: [], opaqueConfigKeys: [] };

/** What the whole walk learned that no single level can see on its own. */
interface HookScan {
  /** Some git invocation, at any depth, runs a subcommand that fires hooks. */
  runsHooks: boolean;
  /** Every analysis the walk read, so an `export` in an alias body counts too. */
  seen: ShellAnalysis[];
}

/** Why this command skips git hooks, or null. `depth` bounds alias expansion. */
function noVerifyHit(a: ShellAnalysis, depth: number, scope: AliasScope, scan: HookScan): string | null {
  scan.seen.push(a);
  for (const inv of a.invocations) {
    if (!inv.names.includes("git")) continue;
    const g = parseGit(a, inv.args);
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
    // Everything the enclosing invocations imposed is still in force here.
    const configs = [...scope.configs, ...g.configs];
    const configEnvs = [...scope.configEnvs, ...g.configEnvs];
    const opaqueConfigKeys = [...scope.opaqueConfigKeys, ...g.opaqueConfigKeys];
    const env = [
      ...scope.env,
      ...inv.env.map(({ name, value }) => ({ name, values: resolveWord(a, value) ?? [] })),
    ];
    // An alias NAMED after a command git ships is dead text: git runs its own
    // command and never looks at the alias. Reading it as the expansion, and
    // stopping there, let `-c alias.commit=status` disarm every check the real
    // `commit` below would have made.
    if (!GIT_COMMANDS.has(g.sub)) {
      const aliasKey = `alias.${g.sub}`;
      // An alias body the command string does not state is as unreadable as a
      // `--config-env core.hooksPath`, and decides far more: it IS the command
      // that runs. `--config-env=alias.ci=E` really does define one (checked
      // against git 2.43), and nothing in the command says what it holds.
      if (
        [...opaqueConfigKeys, ...configEnvs.map((c) => c.trim().split("=")[0])].some(
          (key) => key.toLowerCase() === aliasKey,
        )
      ) {
        return `git -c ${aliasKey}=… (body not in the command)`;
      }
      const expansions = expandInlineAliases(configs, g.sub, g.subArgs);
      if (expansions.length > 0) {
        // An alias defined inside an alias inside an alias is built to hide what
        // it runs; one level more than is expanded is not waved through.
        if (depth >= 2) return `git -c ${aliasKey}=… (too deeply nested to check)`;
        if (expansions.length > MAX_ALIAS_DEFINITIONS) return `git -c ${aliasKey}=… (too many definitions to check)`;
        for (const expanded of expansions) {
          const inner = analyzeShell(expanded);
          const why = noVerifyHit(inner, depth + 1, { configs, configEnvs, env, opaqueConfigKeys }, scan);
          if (why) return `git -c ${aliasKey}=… → ${why}`;
          if (inner.truncated) return `git -c ${aliasKey}=… (too deeply nested to check)`;
        }
        continue;
      }
    }
    if (!HOOK_SUBCOMMANDS.has(g.sub)) continue;
    scan.runsHooks = true;
    const hooksPath = configs.find((c) => {
      const m = /^core\.hookspath=([\s\S]*)$/i.exec(c.trim());
      return m !== null && hooksPathDisablesHooks(m[1]);
    });
    if (hooksPath !== undefined) return `git -c ${hooksPath.trim()} ${g.sub}`;
    // `--config-env` reads the value from the environment, which the command string does not show.
    if (configEnvs.some((c) => /^core\.hookspath=/i.test(c.trim()))) return `git --config-env core.hooksPath=… ${g.sub}`;
    if (g.sub === "commit") {
      const why = commitSkipsHooks(a, g.subArgs);
      if (why) return why;
    } else if (hasNoVerify(a, g.subArgs)) {
      return `git ${g.sub} --no-verify`;
    }
    for (const { name, values } of env) {
      for (const v of values) {
        if (envSkipsHooks(name, v, true)) return `${name}=${v} git ${g.sub}`;
      }
    }
  }
  return null;
}

function blockNoVerify(ctx: PolicyContext): PolicyResult {
  try {
    const a = analysisFor(ctx);
    if (!a) return allow();
    const scan: HookScan = { runsHooks: false, seen: [] };
    let why = noVerifyHit(a, 0, EMPTY_SCOPE, scan);
    if (!why && scan.runsHooks) why = exportSkipsHooks(scan.seen);
    if (why) return deny(`Skipping git hooks is blocked (${why}). Fix what the hook reports instead of bypassing it.`);
    return unanalysable(a) ?? allow();
  } catch {
    return failedClosed("block-no-verify");
  }
}

/**
 * `export HUSKY=0; git commit …`. A plain `HUSKY=0;` is a shell variable git
 * never sees, and `HUSKY=0 npm ci` applies to npm alone, so only an export
 * reaches the hook manager.
 *
 * Over every analysis the walk read, not just the command string: an alias body
 * is a command in its own right, so `git -c alias.a='!export HUSKY=0; git
 * commit' a` exports for the commit the same way.
 */
function exportSkipsHooks(analyses: ShellAnalysis[]): string | null {
  for (const a of analyses) {
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
