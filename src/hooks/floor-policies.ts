/**
 * Hard-floor builtins: deterministic guards for the commands a semantic judge
 * (Jev) is known to miss.
 *
 * The two-tier evaluator lets Jev clear a `reviewable` policy's deny. These four
 * are the opposite: `authority: "hard"`, so a deny from any of them is final
 * whatever Jev says. Each targets a blind spot measured in the adversarial study
 * — commands Jev let through because they are unusual (`dd`, `mkfs`,
 * `gh release delete`, `chmod 777`) or because the harm is hidden behind a
 * variable (`R=/bin/rm; $R -rf …`).
 *
 * All of them read the command through `shell-analysis.ts`, never a regex over
 * the raw string: the program must be in COMMAND POSITION (after `sudo`, `env`,
 * `xargs`, `bash -c`, `find -exec` … are walked off) for its arguments to count,
 * so `git commit -m "wipefs is dangerous"` and `grep mkfs notes.md` pass.
 *
 * They fail CLOSED, each on its own: a command the analyser could not read to
 * the end (`truncated`) is denied by every one of them, and so is a command
 * that makes one of them throw. The evaluator swallows a throw and allows, and
 * each of these is enabled independently — a guard that relied on another one
 * being on to catch what it could not read would have a trivial bypass.
 *
 * The implementations are plain hoisted functions, never wrappers — see the note
 * on `POLICY_IMPLEMENTATIONS` in builtin-policies.ts for why that matters.
 *
 * ── What each of them reads, and what none of them reads ──
 *
 * Every rule here turns on something the command STATES about a program's own
 * arguments: the device `dd` writes to, the noun and verb `gh` deletes, the
 * name in command position, the mode `chmod` applies. None of them models what
 * a shell would DO with the text in between — which word feeds which program,
 * what a loop body filters out, what a config setting a later command reads
 * would mean. That line is deliberate, and it is where two more policies were
 * cut:
 *
 * - `block-mass-kill` (a `kill` fed by a broad `ps`/`pgrep` listing) needed to
 *   decide whether a listing reached a kill, and what `awk '$1 != "PID"'` or a
 *   `while read` loop took out of it on the way. Undecidable statically; the
 *   closure that needed no route — deny when one command holds both a broad
 *   listing and a kill naming no PID — denied `ps aux > log; kill $SERVER_PID`.
 * - `block-no-verify` (a commit or push that skips git hooks) needed to resolve
 *   git aliases, `GIT_CONFIG_*` and `core.hooksPath` writes before it could
 *   decide. The value-blind closure denied `git -c core.hooksPath=.husky
 *   commit`, the spelling husky itself installs, and the alias/config
 *   cross-product cost 1.6–4.1 s on a 540 KB command — on a hook that runs
 *   before every tool call.
 *
 * Jev still warns on both classes; they are not on the hard floor. The cost of
 * a bypass here is one guard, and the cost of a false deny is the product.
 *
 * Nothing here compiles or runs text from the command, with one bounded
 * exception in the analyser: a GLOB in command position becomes a RegExp
 * (`basenameGlob`), every metacharacter escaped, adjacent `*` coalesced, the
 * source capped at 1 KB, and matched only against 22 fixed program names.
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

/** An absolute path as a directory key: normalized, without a trailing slash. */
function normalizeDir(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * Where a relative `cd` from `dir` lands. Equivalent to `posix.resolve(dir, rel)`
 * for an absolute, normalized `dir` — and about twice as quick under node,
 * which is the engine the shipped CLI runs this on.
 */
function joinCwd(dir: string, rel: string): string {
  return normalizeDir(dir + "/" + rel);
}

/** The directories a relative path in the command can be relative to. */
interface Cwds {
  dirs: string[];
  /** Some directory the command can run in is unknown: no session cwd, or a `cd` it cannot resolve. */
  unknown: boolean;
}

/**
 * Computed on the first path that could name a device, and not at all for the
 * commands — the overwhelming majority — that name no disk tool and redirect
 * nowhere. `blockDiskDestruction` holds the one instance per evaluation.
 */
type CwdsFn = () => Cwds;

/**
 * Every directory the command's paths can be relative to: the session cwd,
 * plus every `cd`/`pushd`/`--chdir` target in the command resolved against it.
 * The analysis is flat, so every change applies — `cd ..; cd ..` walks up
 * twice from any directory already reached.
 *
 * ── Why this walk remembers what it has already joined ──
 *
 * It used to cost chdirs × directories × rounds, and only the last two of those
 * were bounded: a 500 KB command of `cd ..` under a 60-deep session cwd took
 * 13.6 s under node, on a hook that runs before every tool call and whose
 * timeout lets the call THROUGH. The work was almost entirely repetition — the
 * hundredth `cd ..` joined `..` onto the same directories the ninety-ninth
 * already had, and it was paid whether or not the command named a disk tool.
 *
 * So each target records how much of `list` it has been joined onto, and is
 * only ever joined onto the rest. That is a pure memo, not a cap: joining a
 * target onto a directory twice can only produce a directory the set already
 * holds, so every verdict is the one the repeated walk reached. It is what
 * keeps this linear — a target is joined onto each directory at most once ever,
 * so the joins are bounded by MAX_CWDS per distinct target however long the
 * command is, and what is left per `cd` is one map lookup.
 *
 * A bound on the number of `cd`s read was the other candidate and was measured
 * and rejected: reading fewer of them means not knowing where the command runs,
 * and an unknown directory is the STRICT reading (see `absolutePaths`), so it
 * turned `cd ..`×65 followed by `cp x dev/foo` — allowed today — into a deny.
 */
function possibleCwds(a: ShellAnalysis, sessionCwd: unknown): Cwds {
  const dirs = new Set<string>();
  /** The same directories in insertion order, so a pass can snapshot by index. */
  const list: string[] = [];
  let unknown = false;
  if (typeof sessionCwd === "string" && sessionCwd.startsWith("/")) {
    const start = normalizeDir(sessionCwd);
    dirs.add(start);
    list.push(start);
  } else unknown = true;
  // Past MAX_CWDS directories the set stops growing and counts as unknown:
  // a relative `cd` doubles it, and a command can hold thousands of them.
  const add = (dir: string): boolean => {
    if (dirs.has(dir)) return true;
    if (dirs.size >= MAX_CWDS) {
      unknown = true;
      return false;
    }
    dirs.add(dir);
    list.push(dir);
    return true;
  };
  /** How much of `list` each relative target has already been joined onto. */
  const joined = new Map<string, number>();
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
          if (!add(normalizeDir(t))) break rounds;
        } else if (list.length === 0) unknown = true;
        else {
          // The snapshot the array copy this replaces took: a directory reached
          // earlier in this pass is one a later `cd` in the same command can
          // start from, one reached by THIS join is not — which is how
          // `cd ..; cd ..` still walks up twice, one level per occurrence.
          const from = joined.get(t) ?? 0;
          const n = list.length;
          if (from >= n) continue;
          joined.set(t, n);
          for (let i = from; i < n; i++) if (!add(joinCwd(list[i], t))) break rounds;
        }
      }
    }
    if (dirs.size === before) break;
  }
  return { dirs: list, unknown };
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
function absolutePaths(path: string, cwds: CwdsFn, diskTool: boolean): string[] {
  const p = path.trim();
  if (!p) return [];
  // Before the directory set is ever needed: an absolute path names what it
  // names, and it is the only spelling most commands use.
  if (p.startsWith("/")) return [p];
  const dirs = cwds();
  const out = dirs.dirs.map((d) => joinCwd(d, p));
  if (dirs.unknown) {
    const rel = posix.normalize(p);
    const m = /^(?:\.\.\/)*(dev(?:\/.*)?)$/.exec(rel);
    if (m) out.push("/" + m[1]);
    if (diskTool && BLOCK_DEVICE_NAME_RE.test(rel)) out.push("/dev/" + rel);
  }
  return out;
}

function isDevicePath(path: string, cwds: CwdsFn, diskTool: boolean): boolean {
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
function deviceTarget(a: ShellAnalysis, word: ShellWord, cwds: CwdsFn, mode: TargetMode): string | null {
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

/**
 * The programs below react to. Checked BEFORE any per-argument work: a command
 * can hold tens of thousands of invocations and all but a handful of them are
 * an `npm`, a `git` or an `echo` this policy has nothing to say about.
 */
const DISK_TOOL_NAMES = new Set([
  "dd", "shred", "tee", "cp", "diskutil", "format", ...WIPE_TOOLS, ...WINDOWS_DISK_TOOLS,
]);

function diskHit(a: ShellAnalysis, inv: Invocation, name: string, cwds: CwdsFn): string | null {
  if (!DISK_TOOL_NAMES.has(name) && !MKFS_RE.test(name)) return null;
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
    // Once per evaluation, and only if a path that could be relative is ever
    // reached: `git status; npm run build` and `dd of=/dev/sda` alike never
    // walk the command's `cd`s at all.
    let walked: Cwds | null = null;
    const cwds: CwdsFn = () => (walked ??= possibleCwds(a, ctx.session?.cwd));
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

// ── block-indirect-exec ─────────────────────────────────────────────────────

/** Programs that destroy data, and so must never run from a name the reader cannot see. */
const DESTRUCTIVE_RE = /^(?:rm|srm|dd|shred|wipefs|blkdiscard|mke2fs|mkswap|mkntfs|mkdosfs|mkexfatfs|mkfs(?:\.[\w.+-]+)?|newfs(?:_\w+)?)$/;
/** Names a basename glob in command position is tested against. */
const DESTRUCTIVE_SAMPLES = [
  "rm", "srm", "dd", "shred", "wipefs", "blkdiscard", "mke2fs", "mkswap", "mkntfs", "mkdosfs",
  "mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.xfs", "mkfs.btrfs", "mkfs.vfat", "mkfs.fat", "mkfs.ntfs",
  "mkfs.exfat", "newfs", "newfs_apfs", "newfs_hfs",
];

/**
 * Arguments that name a destructive program's OWN interface — the last resort
 * for an invocation whose program name cannot be read at all.
 *
 * A leading `-r` together with an `-f` used to count here, and that is the one
 * thing in this file that denied ordinary work: the program name is unreadable
 * for every `$GREP`, `$RSYNC`, `$TAR`, `$MAKE`, `$CP`, `$SCP`, `$CHOWN` and
 * `$CHMOD` a developer writes, and `-rf` / `--recursive --force` is how all of
 * them spell the same everyday thing (in grep, tar and make the `-f` even takes
 * the operand after it, so `$GREP -rf patterns.txt src/` is a pattern FILE).
 * A flag shape a dozen programs share is not evidence about the program, so it
 * is gone. What is left is spelt by the destructive family and by nothing else:
 *
 * - `--no-preserve-root`, the "yes, really, operate on /" flag. Nobody types it
 *   by accident, and the programs that take it (rm, and the recursive
 *   chown/chmod/chgrp) are equally final when they do.
 * - `if=`/`of=`, dd's operand syntax.
 *
 * An unreadable name carrying an ordinary argument list is Jev's to judge, not
 * the floor's. The floor still denies the moment the name RESOLVES to one of
 * DESTRUCTIVE_RE, expands to one through a glob, or is printed by a
 * substitution — which is every row this policy was built for.
 */
function looksDestructive(args: ShellWord[]): boolean {
  const texts = lits(args);
  // rm's flags come first (`$R --no-preserve-root /`); `$K apply -R -f dir` is
  // a subcommand with flags, not rm, so only the leading run of flags is read.
  for (const t of texts) {
    if (t === null || !t.startsWith("-") || t === "--") break;
    if (t === "--no-preserve-root") return true;
  }
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
    return `${written} is called with arguments only rm or dd take`;
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

export { blockDiskDestruction, blockGhDestructive, blockIndirectExec, blockChmod777 };
