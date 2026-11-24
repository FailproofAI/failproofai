/**
 * Codex hooks that Codex will actually run, and an honest answer to whether it does.
 *
 * Codex (0.129 onwards) runs a hook from `~/.codex/hooks.json` only once a
 * person has trusted it: interactive `codex` asks "Review hooks", and approving
 * writes the hook's identity hash to the USER's `~/.codex/config.toml` as
 *
 *   [hooks.state."<hooks.json path>:<event_snake>:<group>:<handler>"]
 *   trusted_hash = "sha256:…"
 *
 * Until then every one of our hooks is skipped — silently in headless
 * `codex exec` — so neither local nor cloud policies enforce, while failproofai
 * said they did. Nothing failproofai can write to `hooks.json` changes that.
 *
 * Hooks from Codex's SYSTEM config layer (`/etc/codex/config.toml` on Linux and
 * macOS) are "managed": Codex runs them with no hash and no prompt
 * (`hook_metadata_for_config_layer_source` maps `ConfigLayerSource::System` to
 * `is_managed = true`, and `hook_trust_status` returns `Managed` for those).
 * So when root is available, failproofai writes its Codex hooks there, as TOML
 * hook tables inside one clearly delimited block, and takes them out of
 * `hooks.json` — Codex appends handlers from every layer without
 * de-duplicating, so leaving both would evaluate every tool call twice once the
 * user file is trusted.
 *
 * One block serves every account on the machine, so its hooks run the hook
 * runner (`/opt/failproofai-codex/codex-hook`), a short script root owns that
 * runs an account's own failproofai for each account that set the hooks up,
 * one line per uid, and decides nothing for any other. What it runs before it
 * knows the account (the script, every directory above it, `sh`, `id` and
 * `cat`), and what each line runs, is checked with {@link untrustedPathReason}
 * on every install and every `failproofai update` ({@link refreshCodexSystemHooks});
 * a block that fails is taken out rather than kept. A block in the format
 * earlier versions wrote is rewritten to use the runner.
 *
 * Without root (or on Windows, whose system config lives elsewhere and is not
 * handled here) the hooks stay in `hooks.json`, and {@link codexHookTrust}
 * reads the user's `[hooks.state]` so `failproofai config` and
 * `config --status` stop counting Codex as enforcing until they are trusted.
 *
 * Everything that touches `/etc` or `/opt` goes through the same
 * non-interactive `sudo -n` the daemon install uses; `failproofai config`
 * primes it first.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { canElevate, runPrivileged, writePrivilegedFile } from "./daemon-service";
import { writeConfigFileAtomic } from "./safe-config-write";
import { compareVersions } from "./semver-precedence";
import { shellQuote } from "./shell-quote";
import { FAILPROOFAI_HOOK_MARKER } from "./types";

export const CODEX_MANAGED_BEGIN = "# >>> failproofai managed hooks >>>";
export const CODEX_MANAGED_END = "# <<< failproofai managed hooks <<<";

/**
 * The first Codex that gates `hooks.json` on trust, and the first whose
 * system-layer hooks are `Managed` (both arrived together, in 0.129.0; TOML
 * hooks in config layers date from 0.124). Older Codex runs every hook in
 * `hooks.json` unasked, so it needs neither the system layer nor a warning.
 */
export const CODEX_TRUST_GATE_VERSION = "0.129.0";

const SYSTEM_CONFIG_UNIX = "/etc/codex/config.toml";

/** Every event Codex reads from a config layer's `hooks` table. */
const CODEX_TOML_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const;

/** One hook to write: the PascalCase event and the handler `buildHookEntry` made for it. */
export interface CodexSystemHookEntry {
  event: string;
  command: string;
  timeout: number;
}

/**
 * Codex's system config file, or null where failproofai does not write one.
 *
 * `FAILPROOFAI_CODEX_SYSTEM_CONFIG` overrides it: a path to use instead, or
 * `off` (or empty) for none. The test suites set `off`, so no test run can
 * reach the real `/etc/codex` on a machine with passwordless sudo.
 */
export function codexSystemConfigPath(): string | null {
  const override = process.env.FAILPROOFAI_CODEX_SYSTEM_CONFIG;
  if (override !== undefined) return override === "" || override === "off" ? null : resolve(override);
  // Windows keeps it under %ProgramData%\OpenAI\Codex — not handled here, so
  // Windows stays on hooks.json with the trust warning.
  if (process.platform === "win32") return null;
  return SYSTEM_CONFIG_UNIX;
}

/** The copy of the system config as it was before failproofai first changed it. */
export function codexSystemBackupPath(path: string): string {
  return `${path}.failproofai-backup`;
}

const RUNNER_UNIX = "/opt/failproofai-codex/codex-hook";

/**
 * The hook runner every hook in the system config runs, for the system config
 * at `configPath`: `/opt/failproofai-codex/codex-hook` for Codex's own (its own
 * directory: `/opt/failproofai/<user>` is the daemon's, per account), and a
 * file beside any other config (a test's), so that no test reaches `/opt`.
 */
export function codexHookRunnerPath(configPath: string | null = codexSystemConfigPath()): string | null {
  if (!configPath) return null;
  return configPath === SYSTEM_CONFIG_UNIX ? RUNNER_UNIX : resolve(dirname(configPath), "failproofai-codex-hook");
}

/** `codex --version`, as a bare semver, or null when there is no codex to ask. */
export function detectCodexVersion(): string | null {
  try {
    const out = execSync("codex --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True for a Codex that only runs trusted `hooks.json` hooks (and treats system-config hooks as managed). */
export function codexGatesHookTrust(version: string | null): boolean {
  // Unknown is treated as current: every Codex shipped since 0.129 gates.
  if (!version) return true;
  const cmp = compareVersions(version, CODEX_TRUST_GATE_VERSION);
  return cmp === null ? true : cmp >= 0;
}

// ── The managed block ───────────────────────────────────────────────────────

/** The block failproofai owns in the system config, newline-terminated. */
export function renderCodexManagedBlock(entries: readonly CodexSystemHookEntry[]): string {
  const lines = [
    CODEX_MANAGED_BEGIN,
    "# Written by failproofai. Codex runs hooks from its system config without",
    "# asking to trust them. Each hook runs failproofai's hook runner, which runs",
    "# failproofai for the accounts that set it up. `failproofai uninstall` takes",
    "# an account out, and this block once none is left. Edit outside the markers",
    "# only: everything between them is replaced.",
  ];
  for (const entry of entries) {
    lines.push(
      "",
      `[[hooks.${entry.event}]]`,
      `[[hooks.${entry.event}.hooks]]`,
      'type = "command"',
      // JSON's string escapes are a subset of TOML's basic-string escapes.
      `command = ${JSON.stringify(entry.command)}`,
      `timeout = ${Math.trunc(entry.timeout)}`,
    );
  }
  lines.push(CODEX_MANAGED_END);
  return `${lines.join("\n")}\n`;
}

/** Where the block sits: [start, end) covers the BEGIN line through the END line's newline. */
type BlockSpan = { start: number; end: number } | null | "malformed";

function findBlock(text: string): BlockSpan {
  const beginRe = new RegExp(`^${escapeRe(CODEX_MANAGED_BEGIN)}[ \\t]*$`, "m");
  const begin = beginRe.exec(text);
  if (!begin) {
    return new RegExp(`^${escapeRe(CODEX_MANAGED_END)}[ \\t]*$`, "m").test(text) ? "malformed" : null;
  }
  const endRe = new RegExp(`^${escapeRe(CODEX_MANAGED_END)}[ \\t]*$`, "mg");
  endRe.lastIndex = begin.index + begin[0].length;
  const end = endRe.exec(text);
  if (!end) return "malformed";
  let stop = end.index + end[0].length;
  if (text[stop] === "\r") stop++;
  if (text[stop] === "\n") stop++;
  return { start: begin.index, end: stop };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` holds failproofai's block. */
export function hasCodexManagedBlock(text: string): boolean {
  const span = findBlock(text);
  return span !== null && span !== "malformed";
}

/**
 * Put `block` into `original` (replacing ours if it is there), or take ours out
 * when `block` is null. Every byte outside the block is kept as it was.
 *
 * Appended after one blank line, which removal takes back out, so a file that
 * ended in a newline round-trips byte for byte. (One that did not gets the
 * newline the separator needed; {@link removeCodexSystemHooks} restores such a
 * file from its backup.)
 */
export function mergeCodexManagedBlock(original: string, block: string | null): string {
  const span = findBlock(original);
  if (span === "malformed") throw new Error("failproofai's managed block is missing its begin or end marker");
  if (span) {
    const before = original.slice(0, span.start);
    const after = original.slice(span.end);
    if (block !== null) return before + block + after;
    const trimmed = before.endsWith("\n\n") && after === "" ? before.slice(0, -1) : before;
    return trimmed + after;
  }
  if (block === null) return original;
  if (original === "") return block;
  return `${original}${original.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

/**
 * A `hooks` definition elsewhere in the file that our `[[hooks.<Event>]]`
 * tables would collide with, making the whole file invalid TOML — and Codex
 * refuses to start on a config it cannot parse, for every user on the machine.
 *
 * Arrays of tables (`[[hooks.PreToolUse]]`) and `[hooks.state…]` tables extend
 * cleanly and are fine. An inline `hooks = {…}`, an event assigned as a value
 * (`PreToolUse = [...]` under `[hooks]`, or `hooks.PreToolUse = …`), or an
 * event opened as a plain table are not. Returns the offending line, or null.
 */
export function conflictingHooksDefinition(text: string): string | null {
  const events = CODEX_TOML_EVENTS.join("|");
  const inlineHooks = /^\s*hooks\s*=/;
  const dottedEvent = new RegExp(`^\\s*hooks\\s*\\.\\s*"?(${events})"?\\s*(=|\\.)`);
  const plainEventTable = new RegExp(`^\\s*\\[\\s*hooks\\s*\\.\\s*"?(${events})"?\\s*(\\]|\\.)`);
  const eventKey = new RegExp(`^\\s*"?(${events})"?\\s*(=|\\.)`);
  let inHooksTable = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*\[\[/.test(line)) {
      inHooksTable = false;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (plainEventTable.test(line)) return line.trim();
      inHooksTable = /^\s*\[\s*hooks\s*\]/.test(line);
      continue;
    }
    if (inlineHooks.test(line) || dottedEvent.test(line)) return line.trim();
    if (inHooksTable && eventKey.test(line)) return line.trim();
  }
  return null;
}

// ── The hook runner ─────────────────────────────────────────────────────────

/** The line after the shebang that marks a hook runner as failproofai's. */
export const CODEX_RUNNER_MARKER = "# failproofai Codex hook runner";

/**
 * An account the hook runner runs failproofai for: its uid and its own
 * failproofai. Root's line also names the program that runs failproofai
 * (`interpreter`), so that nothing on it is looked up through PATH.
 */
export interface CodexRunnerAccount {
  uid: number;
  cli: string;
  interpreter?: string;
  /** The account's name, for whoever reads the file. */
  name?: string;
}

/**
 * The programs the hook runner uses before it knows whose hook it is running,
 * by absolute path: its interpreter, `id` and `cat`.
 */
export interface CodexRunnerPrograms {
  sh: string;
  id: string;
  cat: string;
}

/** Root's own directories, the only ones the runner's programs come from. */
const RUNNER_PROGRAM_DIRS = ["/bin", "/usr/bin"] as const;

/** `sh`, `id` and `cat` from {@link RUNNER_PROGRAM_DIRS}, never through PATH; null when one is missing. */
export function codexRunnerPrograms(): CodexRunnerPrograms | null {
  const find = (name: string): string | null => {
    for (const dir of RUNNER_PROGRAM_DIRS) {
      const candidate = `${dir}/${name}`;
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not in this directory: try the next.
      }
    }
    return null;
  };
  const sh = find("sh");
  const id = find("id");
  const cat = find("cat");
  return sh && id && cat ? { sh, id, cat } : null;
}

const PROGRAM_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * The hook runner for `accounts`. Codex runs it with the event on stdin; it
 * compares the uid it runs as with each account's and hands the event to that
 * account's failproofai, or reads it and exits 0 (no decision) for an account
 * that is not listed. Everything before that comparison is named by absolute
 * path, and every path in a line is single-quoted.
 */
export function renderCodexHookRunner(accounts: readonly CodexRunnerAccount[], programs: CodexRunnerPrograms): string {
  for (const program of [programs.sh, programs.id, programs.cat]) {
    if (!PROGRAM_PATH.test(program)) throw new Error(`refusing to name ${JSON.stringify(program)} in the Codex hook runner`);
  }
  const arms = [...accounts]
    .sort((a, b) => a.uid - b.uid)
    .map((a) => {
      const run = a.interpreter ? `${shellQuote(a.interpreter)} ${shellQuote(a.cli)}` : shellQuote(a.cli);
      return `  ${a.uid}) exec ${run} "$@" ;;${a.name ? ` # ${a.name}` : ""}`;
    });
  return [
    `#!${programs.sh}`,
    CODEX_RUNNER_MARKER,
    "# Codex runs every hook in its system config for every account. This runs",
    "# an account's own failproofai only for the accounts listed below, each of",
    "# which set it up, and for any other account reads the event and decides",
    "# nothing. failproofai rewrites this file; `failproofai policies",
    "# --uninstall --cli codex` takes an account out.",
    `case "$(${programs.id} -u)" in`,
    ...arms,
    "esac",
    `exec ${programs.cat} >/dev/null`,
    "",
  ].join("\n");
}

const RUNNER_ARM = /^ {2}(\d+)\) exec '((?:[^']|'\\'')*)'(?: '((?:[^']|'\\'')*)')? "\$@" ;;(?: # ([A-Za-z0-9._-]+))?$/;
const unquote = (word: string): string => word.replace(/'\\''/g, "'");

/** The accounts and programs in a hook runner failproofai wrote, or null for any other file. */
export function parseCodexHookRunner(
  text: string,
): { accounts: CodexRunnerAccount[]; programs: CodexRunnerPrograms } | null {
  const lines = text.split("\n");
  if (lines[1] !== CODEX_RUNNER_MARKER) return null;
  const sh = /^#!(\/\S+)$/.exec(lines[0])?.[1];
  const id = lines.map((line) => /^case "\$\((\/\S+) -u\)" in$/.exec(line)?.[1]).find(Boolean);
  const cat = lines.map((line) => /^exec (\/\S+) >\/dev\/null$/.exec(line)?.[1]).find(Boolean);
  if (!sh || !id || !cat) return null;
  const accounts: CodexRunnerAccount[] = [];
  for (const line of lines) {
    const arm = RUNNER_ARM.exec(line);
    if (!arm) continue;
    const [, uid, first, second, name] = arm;
    accounts.push({
      uid: Number(uid),
      ...(second === undefined ? { cli: unquote(first) } : { interpreter: unquote(first), cli: unquote(second) }),
      ...(name ? { name } : {}),
    });
  }
  return { accounts, programs: { sh, id, cat } };
}

// ── Who may change what the runner runs ─────────────────────────────────────

/** Every name looked at while resolving a path, with its lstat; where it ends; whether its own last name is a link. */
type Chain = { seen: Array<{ name: string; st: Stats }>; last: string; finalLink: boolean };

function resolveChain(path: string): Chain | { error: string; code?: string } {
  if (!isAbsolute(path)) return { error: `${path} is not an absolute path` };
  const seen: Array<{ name: string; st: Stats }> = [];
  let current = "/";
  let finalLink: boolean | null = null;
  try {
    seen.push({ name: "/", st: lstatSync("/") });
    const todo = path.split("/").filter((part) => part !== "" && part !== ".");
    let links = 0;
    while (todo.length > 0) {
      const part = todo.shift()!;
      if (part === "..") {
        current = dirname(current);
        continue;
      }
      const next = current === "/" ? `/${part}` : `${current}/${part}`;
      const st = lstatSync(next);
      seen.push({ name: next, st });
      // The first time nothing is left to resolve, this is the path's own last name.
      if (todo.length === 0 && finalLink === null) finalLink = st.isSymbolicLink();
      if (st.isSymbolicLink()) {
        if (++links > 40) return { error: `${path} goes through too many symbolic links` };
        const target = readlinkSync(next);
        todo.unshift(...target.split("/").filter((p) => p !== "" && p !== "."));
        if (target.startsWith("/")) current = "/";
        continue;
      }
      current = next;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      error: code === "ENOENT" || code === "ENOTDIR" ? `${path} does not exist` : `${path} cannot be read (${code ?? err})`,
      ...(code ? { code } : {}),
    };
  }
  return { seen, last: current, finalLink: finalLink ?? false };
}

/**
 * Why an account outside `trusted` could change what `path` names, or null
 * when none can.
 *
 * Walks the path the way the kernel resolves it, from `/`, following every
 * symbolic link, and requires each directory, link and the final entry to be
 * owned by a trusted uid. A directory others can write is allowed only with
 * the sticky bit (`/tmp`), where no one renames or removes an entry another
 * account owns; the final file must be writable by its owner alone.
 * `groupWritable` lets a directory or file be writable by its group (an
 * account's own install, which a umask of 002 leaves that way). `dir` expects
 * a directory at the end; `link` accepts a symbolic link as the last name
 * (`/bin/sh`), whose target is checked the same way.
 */
export function untrustedPathReason(
  path: string,
  trusted: ReadonlySet<number>,
  opts: { dir?: boolean; link?: boolean; groupWritable?: boolean } = {},
): string | null {
  const chain = resolveChain(path);
  if ("error" in chain) return chain.error;
  const { seen, last } = chain;
  const others = opts.groupWritable ? 0o002 : 0o022;
  if (!opts.link && chain.finalLink) return `${resolve(path)} is a symbolic link`;
  for (const { name, st } of seen) {
    if (!trusted.has(st.uid)) return `${name} is owned by uid ${st.uid}`;
    if (st.isDirectory() && (st.mode & others) !== 0 && (st.mode & 0o1000) === 0) {
      return `${name} can be written by accounts other than its owner`;
    }
  }
  const end = seen[seen.length - 1].st;
  if (opts.dir) return end.isDirectory() ? null : `${last} is not a directory`;
  if (!end.isFile()) return `${last} is not a regular file`;
  if ((end.mode & others) !== 0) return `${last} can be written by accounts other than its owner`;
  return null;
}

/** The uids that own anything resolving `path` goes through, root's left out; or why it does not resolve. */
function pathOwners(path: string): Set<number> | { error: string; code?: string } {
  const chain = resolveChain(path);
  if ("error" in chain) return chain;
  const owners = new Set(chain.seen.map((e) => e.st.uid));
  owners.delete(0);
  return owners;
}

/** Another account's files that this process may not read: nothing can be judged about them from here. */
function unreadableHere(path: string): boolean {
  const chain = resolveChain(path);
  return "error" in chain && (chain.code === "EACCES" || chain.code === "EPERM");
}

/**
 * The uids whose files may sit where the runner and its programs are: root,
 * and for a config path other than Codex's own (a test's), the owner of that
 * path's directory, who can rewrite that config anyway. Root alone for
 * `/etc/codex/config.toml`.
 */
export function codexTrustedOwners(configPath: string, deps: CodexSystemDeps = {}): ReadonlySet<number> {
  if (deps.trustedUids) return new Set(deps.trustedUids);
  const owners = new Set<number>([0]);
  if (resolve(configPath) === SYSTEM_CONFIG_UNIX) return owners;
  for (let dir = dirname(configPath); ; dir = dirname(dir)) {
    try {
      owners.add(statSync(dir).uid);
      return owners;
    } catch {
      if (dirname(dir) === dir) return owners;
    }
  }
}

/** Why the runner at `runner`, with `programs`, could run anything but root's before it knows the account. */
function runnerProblem(
  runner: string,
  programs: CodexRunnerPrograms,
  trusted: ReadonlySet<number>,
  written: boolean,
): string | null {
  return (
    untrustedPathReason(dirname(runner), trusted, { dir: true }) ??
    (written ? untrustedPathReason(runner, trusted) : null) ??
    untrustedPathReason(programs.sh, trusted, { link: true }) ??
    untrustedPathReason(programs.id, trusted, { link: true }) ??
    untrustedPathReason(programs.cat, trusted, { link: true })
  );
}

/**
 * Why the runner must not keep `account`'s line: what the line runs can be
 * changed by an account other than that one or root. Root's line names its
 * interpreter, and everything it runs must be root's alone, group included;
 * another account's own install may be writable by its group.
 */
function accountProblem(account: CodexRunnerAccount, trusted: ReadonlySet<number>): string | null {
  if (!usableCliPath(account.cli)) return `${JSON.stringify(account.cli)} cannot go into the hook runner`;
  // Another account's install under a home this process cannot enter (0750)
  // is kept as it is: only what can be seen to fail is taken out.
  if (unreadableHere(account.cli) || (account.interpreter && unreadableHere(account.interpreter))) return null;
  if (account.uid === 0) {
    if (!account.interpreter || !usableCliPath(account.interpreter)) {
      return "root's line must name the program that runs failproofai";
    }
    return (
      untrustedPathReason(account.interpreter, trusted, { link: true }) ??
      untrustedPathReason(account.cli, trusted, { link: true })
    );
  }
  const own = new Set([...trusted, account.uid]);
  return (
    (account.interpreter ? untrustedPathReason(account.interpreter, own, { link: true, groupWritable: true }) : null) ??
    untrustedPathReason(account.cli, own, { link: true, groupWritable: true })
  );
}

// ── Reading and writing the root-owned files ────────────────────────────────

/** Seams for tests: the files, the Codex version, the privileges and the account. */
export interface CodexSystemDeps {
  /** The system config path; `null` = none on this machine. Default {@link codexSystemConfigPath}. */
  path?: string | null;
  codexVersion?: () => string | null;
  canElevate?: () => boolean;
  /** The hook runner. Default {@link codexHookRunnerPath} for the config. */
  runnerPath?: string;
  /** The runner's `sh`, `id` and `cat`. Default {@link codexRunnerPrograms}. */
  programs?: CodexRunnerPrograms;
  /** The uids whose files the runner may run. Default {@link codexTrustedOwners}. */
  trustedUids?: readonly number[];
  /** This account's uid. Default the process's. */
  uid?: number;
  /** This account's name. Default the process's user. */
  userName?: string;
  /** What runs failproofai on root's line. Default `process.execPath`. */
  interpreter?: string;
  /** Write as this process (true) or through `sudo -n` (false). Default: whichever the files allow. */
  direct?: boolean;
}

function resolvedPath(deps: CodexSystemDeps): string | null {
  return deps.path !== undefined ? deps.path : codexSystemConfigPath();
}

function resolvedRunner(deps: CodexSystemDeps, configPath: string): string {
  return deps.runnerPath ?? codexHookRunnerPath(configPath)!;
}

/** This account, or null where there are no uids (Windows). */
function selfAccount(deps: CodexSystemDeps): { uid: number; name?: string } | null {
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === undefined) return null;
  let name = deps.userName;
  if (name === undefined) {
    try {
      name = userInfo().username;
    } catch {
      name = undefined;
    }
  }
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? { uid, name } : { uid };
}

/** A path the runner can name: absolute, on one line. */
function usableCliPath(cli: string): boolean {
  return isAbsolute(cli) && !/[\x00-\x1f\x7f]/.test(cli);
}

/**
 * True when this process can write `path` itself (root, or a test's temp dir).
 * `replaced`: the file is only ever renamed over or removed, never written in
 * place (the runner), so only its directory counts, whatever sits at `path`.
 */
function writableDirectly(path: string, replaced = false): boolean {
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  try {
    accessSync(dir, fsConstants.W_OK);
    if (!replaced && existsSync(path)) accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function fileMode(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    return "0644";
  }
}

/**
 * `replaceLink` replaces a symbolic link at `path` rather than writing through
 * it: the runner must be the file failproofai wrote, wherever a link pointed.
 * The mode is set when the file is created, not after, whatever the umask.
 */
function writeSystemFile(path: string, contents: string, mode: string, direct: boolean, replaceLink = false): void {
  if (direct) {
    writeConfigFileAtomic(path, contents, {
      backup: false,
      mode: parseInt(mode, 8),
      ...(replaceLink ? { symlinks: "replace" as const } : {}),
    });
    chmodSync(path, parseInt(mode, 8));
    return;
  }
  runPrivileged("install", ["-d", "-m", "0755", dirname(path)]);
  writePrivilegedFile(path, contents, mode);
}

function removeSystemFile(path: string, direct: boolean): void {
  if (direct) rmSync(path, { force: true });
  else runPrivileged("rm", ["-f", path]);
}

/** Makes `dir` exist, each directory made here 0755 from the moment it is made. */
function ensureSystemDir(dir: string, direct: boolean): void {
  if (!direct) {
    runPrivileged("install", ["-d", "-m", "0755", dir]);
    return;
  }
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;
  }
  for (const d of missing) {
    mkdirSync(d, { mode: 0o755 });
    chmodSync(d, 0o755);
  }
}

/** The program a hook command runs: the double-quoted path `buildHookEntry` puts first. */
function commandProgram(command: string): string | null {
  return /^"([^"]*)"(?= |$)/.exec(command)?.[1] ?? null;
}

/** The hooks in a block of ours, read back as {@link renderCodexManagedBlock} wrote them, or null. */
export function parseCodexManagedBlock(block: string): CodexSystemHookEntry[] | null {
  const tables = block.match(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/gm) ?? [];
  const entries: CodexSystemHookEntry[] = [];
  for (const m of block.matchAll(/^\[\[hooks\.([A-Za-z]+)\.hooks\]\]\ntype = "command"\ncommand = (".*")\ntimeout = (\d+)$/gm)) {
    let command: unknown;
    try {
      command = JSON.parse(m[2]);
    } catch {
      return null;
    }
    if (typeof command !== "string") return null;
    entries.push({ event: m[1], command, timeout: Number(m[3]) });
  }
  return entries.length > 0 && entries.length === tables.length ? entries : null;
}

/** What a block of ours runs: the runner, or (an earlier format) one program for every account. */
type BlockForm =
  | { kind: "runner"; entries: CodexSystemHookEntry[] }
  | { kind: "direct"; entries: CodexSystemHookEntry[] | null; program: string | null };

function blockForm(block: string, runner: string): BlockForm {
  const entries = parseCodexManagedBlock(block);
  const programs = new Set((entries ?? []).map((e) => commandProgram(e.command)));
  if (entries && programs.size === 1 && programs.has(runner)) return { kind: "runner", entries };
  const [program] = programs;
  return { kind: "direct", entries, program: programs.size === 1 && program ? program : null };
}

/**
 * Whose a block in the earlier format is, judged by the program it runs:
 * - `root`: everything resolving it is root's alone, so it can stay as it is;
 * - `account`: one account owns it (its own install), and keeps it through the runner;
 * - `none`: it is gone, unreadable, or more than one account can change it.
 * `owners` are the uids that own any part of it.
 */
type EarlierBlock =
  | { kind: "root" }
  | { kind: "account"; account: CodexRunnerAccount; owners: Set<number> }
  | { kind: "none"; reason: string; owners: Set<number> }
  /** Its program is under a directory this process cannot enter: nothing can be judged from here. */
  | { kind: "unknown"; owners: Set<number> };

function earlierBlock(form: BlockForm, trusted: ReadonlySet<number>, self: { uid: number; name?: string }): EarlierBlock {
  if (form.kind !== "direct" || !form.program || !usableCliPath(form.program)) {
    return { kind: "none", reason: "they could not be read back", owners: new Set() };
  }
  const program = form.program;
  const owners = pathOwners(program);
  if (!(owners instanceof Set)) {
    return owners.code === "EACCES" || owners.code === "EPERM"
      ? { kind: "unknown", owners: new Set() }
      : { kind: "none", reason: "the failproofai they ran is gone", owners: new Set() };
  }
  if (owners.size === 0) {
    const problem = untrustedPathReason(program, new Set([0]), { link: true });
    return problem ? { kind: "none", reason: problem, owners } : { kind: "root" };
  }
  if (owners.size > 1) return { kind: "none", reason: `more than one account can change ${program}`, owners };
  const [uid] = owners;
  const account: CodexRunnerAccount = { uid, cli: program, ...(uid === self.uid && self.name ? { name: self.name } : {}) };
  const problem = accountProblem(account, trusted);
  return problem ? { kind: "none", reason: problem, owners } : { kind: "account", account, owners };
}

/** `lists`, one entry per uid, the later list winning. */
function mergeAccounts(...lists: ReadonlyArray<readonly CodexRunnerAccount[]>): CodexRunnerAccount[] {
  const byUid = new Map<number, CodexRunnerAccount>();
  for (const list of lists) for (const account of list) byUid.set(account.uid, account);
  return [...byUid.values()].sort((a, b) => a.uid - b.uid);
}

type RunnerState =
  | { kind: "absent" }
  | { kind: "ours"; text: string; accounts: CodexRunnerAccount[]; programs: CodexRunnerPrograms }
  | { kind: "foreign" };

function readRunner(runner: string): RunnerState {
  let text: string;
  try {
    text = readFileSync(runner, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "foreign" };
  }
  const parsed = parseCodexHookRunner(text);
  return parsed ? { kind: "ours", text, ...parsed } : { kind: "foreign" };
}

/** The system config, failproofai's block in it, and the hook runner, as they are now. */
interface SystemState {
  path: string;
  current: string;
  existed: boolean;
  span: { start: number; end: number } | null;
  form: BlockForm | null;
  runner: string;
  runnerState: RunnerState;
  trusted: ReadonlySet<number>;
}

function readSystemState(path: string, deps: CodexSystemDeps): SystemState | { error: string } {
  let current = "";
  const existed = existsSync(path);
  if (existed) {
    try {
      current = readFileSync(path, "utf8");
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  const span = findBlock(current);
  if (span === "malformed") return { error: "failproofai's block has lost one of its markers" };
  const runner = resolvedRunner(deps, path);
  return {
    path,
    current,
    existed,
    span,
    form: span ? blockForm(current.slice(span.start, span.end), runner) : null,
    runner,
    runnerState: readRunner(runner),
    trusted: codexTrustedOwners(path, deps),
  };
}

/**
 * The accounts the runner on disk names. Only while a block of ours is there:
 * a runner left behind by a block taken out (by hand, or by an earlier
 * version's uninstall) names accounts nothing runs any more.
 */
function runnerAccounts(state: SystemState): CodexRunnerAccount[] {
  return state.span && state.runnerState.kind === "ours" ? state.runnerState.accounts : [];
}

/** A block's hooks, each running `runner` instead of its program; null when they cannot be read back. */
function retargetedBlock(form: BlockForm, runner: string): string | null {
  if (!form.entries) return null;
  const entries: CodexSystemHookEntry[] = [];
  for (const entry of form.entries) {
    const program = commandProgram(entry.command);
    if (program === null) return null;
    entries.push({ ...entry, command: `"${runner}"${entry.command.slice(program.length + 2)}` });
  }
  return renderCodexManagedBlock(entries);
}

/** An account taken out of the runner, and why. */
export interface CodexDroppedAccount {
  uid: number;
  reason: string;
}

type Applied =
  | { ok: true; changed: boolean; dropped: CodexDroppedAccount[] }
  | { ok: false; reason: "no-root" | "unsafe" | "write-failed"; detail?: string };

/**
 * Puts the system config and the runner in the state that runs `accounts`'
 * failproofai through `block` (null: the block already there), or takes both
 * out when no account is left. An account whose line fails
 * {@link accountProblem} is left out; the runner and its programs are checked
 * before the block is written, and what was written is read back. When any of
 * that fails, the block is taken out instead.
 *
 * `probe`: whether to ask `sudo -n` when this process cannot write the files
 * itself. Without it, a change that needs root is reported as "no-root".
 */
function applySystemState(
  state: SystemState,
  want: { accounts: CodexRunnerAccount[]; block: string | null; programs: CodexRunnerPrograms | null; probe: boolean },
  deps: CodexSystemDeps,
): Applied {
  const { path, current, span, runner, runnerState, trusted } = state;
  const runnerOurs = runnerState.kind === "ours";
  const direct = deps.direct ?? (writableDirectly(path) && writableDirectly(runner, true));
  const elevate = (): boolean => direct || (want.probe && (deps.canElevate ?? canElevate)());
  const takeOut = (): void => {
    if (span) {
      const stripped = mergeCodexManagedBlock(current, null);
      const backupPath = codexSystemBackupPath(path);
      let backup: string | null = null;
      try {
        if (existsSync(backupPath)) backup = readFileSync(backupPath, "utf8");
      } catch {
        backup = null;
      }
      if (backup !== null && (stripped === backup || stripped === `${backup}\n`)) {
        // Nothing else changed since: put back the exact bytes.
        writeSystemFile(path, backup, fileMode(path), direct);
        removeSystemFile(backupPath, direct);
      } else if (backup === null && stripped.trim() === "") {
        // failproofai created this file, and it holds nothing of anyone else's.
        removeSystemFile(path, direct);
      } else {
        writeSystemFile(path, stripped, fileMode(path), direct);
      }
    }
    // After the block: Codex stops running the runner before it goes.
    if (runnerOurs) removeSystemFile(runner, direct);
  };
  const unsafe = (detail: string): Applied => {
    takeOut();
    return { ok: false, reason: "unsafe", detail };
  };

  const dropped: CodexDroppedAccount[] = [];
  const kept = want.accounts.filter((account) => {
    const problem = accountProblem(account, trusted);
    if (problem) dropped.push({ uid: account.uid, reason: problem });
    return !problem;
  });

  try {
    if (kept.length === 0) {
      if (!span && !runnerOurs) return { ok: true, changed: false, dropped };
      if (!elevate()) return { ok: false, reason: "no-root" };
      takeOut();
      return { ok: true, changed: true, dropped };
    }
    const programs = want.programs;
    // A file failproofai did not write is never replaced: the block goes instead.
    const refusal =
      runnerState.kind === "foreign"
        ? `${runner} is there, and failproofai did not write it`
        : !programs
          ? `no sh, id or cat in ${RUNNER_PROGRAM_DIRS.join(" or ")} for the hook runner`
          : null;
    if (refusal !== null || !programs) {
      const detail = refusal ?? "";
      if (!span && !runnerOurs) return { ok: false, reason: "unsafe", detail };
      return elevate() ? unsafe(detail) : { ok: false, reason: "no-root", detail };
    }
    const runnerText = renderCodexHookRunner(kept, programs);
    const next = want.block === null ? current : mergeCodexManagedBlock(current, want.block);
    const runnerChanged = runnerState.kind !== "ours" || runnerState.text !== runnerText;
    if (!runnerChanged && next === current) {
      const problem = runnerProblem(runner, programs, trusted, true);
      if (!problem) return { ok: true, changed: false, dropped };
      return elevate() ? unsafe(problem) : { ok: false, reason: "no-root", detail: problem };
    }
    if (!elevate()) return { ok: false, reason: "no-root" };

    ensureSystemDir(dirname(runner), direct);
    const before = runnerProblem(runner, programs, trusted, false);
    if (before) return unsafe(before);
    if (runnerChanged) writeSystemFile(runner, runnerText, "0755", direct, true);
    // Read back: what Codex will run is what was meant, and only root can change it.
    const after = untrustedPathReason(runner, trusted) ?? (readFileOr(runner) === runnerText ? null : `${runner} does not hold what failproofai wrote`);
    if (after) {
      takeOut();
      // Written by this call, so it is ours to remove even when it was not before.
      if (!runnerOurs) removeSystemFile(runner, direct);
      return { ok: false, reason: "unsafe", detail: after };
    }
    if (next !== current) {
      // Once: the file as it was before failproofai ever touched it. A file
      // that already holds our block is not that, and an existing backup is kept.
      const mode = state.existed ? fileMode(path) : "0644";
      const backup = codexSystemBackupPath(path);
      if (state.existed && !span && !existsSync(backup)) writeSystemFile(backup, current, mode, direct);
      writeSystemFile(path, next, mode, direct);
      if (readFileOr(path) !== next) {
        return unsafe(`${path} does not hold what failproofai wrote`);
      }
    }
    return { ok: true, changed: true, dropped };
  } catch (err) {
    return { ok: false, reason: "write-failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

function readFileOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Removes the runner's own directory once it is empty; best effort. Never the system config's. */
function tidyRunnerDir(state: SystemState, direct: boolean): void {
  const dir = dirname(state.runner);
  if (dir === dirname(state.path) || !existsSync(dir)) return;
  try {
    if (direct) rmdirSync(dir);
    else runPrivileged("rmdir", [dir]);
  } catch {
    // Not empty, or not ours to remove: left as it is.
  }
}

/**
 * Whether failproofai's Codex hooks in the system config run for this account:
 * a block that runs the runner and a runner that lists this uid, or a block in
 * the earlier format, which runs for every account. Read-only, never throws.
 */
export function codexSystemHooksPresent(deps: CodexSystemDeps = {}): boolean {
  const path = resolvedPath(deps);
  if (!path) return false;
  try {
    const text = readFileSync(path, "utf8");
    const span = findBlock(text);
    if (span === null || span === "malformed") return false;
    const runner = resolvedRunner(deps, path);
    if (blockForm(text.slice(span.start, span.end), runner).kind === "direct") return true;
    const self = selfAccount(deps);
    const runnerState = readRunner(runner);
    return !!self && runnerState.kind === "ours" && runnerState.accounts.some((a) => a.uid === self.uid);
  } catch {
    return false;
  }
}

export type CodexSystemInstall =
  | { ok: true; path: string; changed: boolean; dropped: CodexDroppedAccount[] }
  | {
      ok: false;
      reason:
        | "unsupported-platform"
        | "codex-not-found"
        | "codex-too-old"
        | "no-root"
        | "conflict"
        | "unreadable"
        | "unsafe"
        | "write-failed";
      detail?: string;
      path?: string;
    };

/**
 * Set this account's Codex hooks up in the system config: this account's uid
 * and its failproofai, `cliPath`, go into the hook runner (with the accounts
 * already there), and the block holds `entriesFor(runner)`, which must all run
 * the runner. Replaces only our block. Never prompts: it uses root, or a
 * `sudo -n` that `failproofai config` primed.
 *
 * Refused ("unsafe") when this account's line, the runner or its programs fail
 * the ownership check; this account's hooks are then not in the system config.
 */
export function installCodexSystemHooks(
  cliPath: string,
  entriesFor: (runner: string) => readonly CodexSystemHookEntry[],
  deps: CodexSystemDeps = {},
): CodexSystemInstall {
  const path = resolvedPath(deps);
  if (!path) return { ok: false, reason: "unsupported-platform" };
  const self = selfAccount(deps);
  if (!self) return { ok: false, reason: "unsupported-platform" };
  const version = (deps.codexVersion ?? detectCodexVersion)();
  if (!version) return { ok: false, reason: "codex-not-found", path };
  const cmp = compareVersions(version, CODEX_TRUST_GATE_VERSION);
  if (cmp !== null && cmp < 0) return { ok: false, reason: "codex-too-old", detail: version, path };

  const state = readSystemState(path, deps);
  if ("error" in state) return { ok: false, reason: "unreadable", detail: state.error, path };
  const { current, span, runner, runnerState, trusted } = state;
  const outside = span ? current.slice(0, span.start) + current.slice(span.end) : current;
  const conflict = conflictingHooksDefinition(outside);
  if (conflict) return { ok: false, reason: "conflict", detail: conflict, path };
  const entries = entriesFor(runner);
  if (entries.length === 0 || entries.some((e) => commandProgram(e.command) !== runner)) {
    return { ok: false, reason: "write-failed", detail: `every Codex system hook must run ${runner}`, path };
  }
  const programs = codexRunnerProgramsFor(deps);
  if (runnerState.kind === "foreign") {
    // Our block must not run a file failproofai did not write: it is taken out, the file is left.
    if (state.form?.kind === "runner") applySystemState(state, { accounts: [], block: null, programs: null, probe: true }, deps);
    return { ok: false, reason: "conflict", detail: `${runner} is there, and failproofai did not write it`, path };
  }

  const mine: CodexRunnerAccount = {
    ...self,
    cli: cliPath,
    ...(self.uid === 0 ? { interpreter: deps.interpreter ?? process.execPath } : {}),
  };
  const earlier = state.form ? earlierAccounts(earlierBlock(state.form, trusted, self)) : [];
  const others = mergeAccounts(earlier, runnerAccounts(state)).filter((a) => a.uid !== self.uid);
  const problem = accountProblem(mine, trusted);
  if (problem) {
    // This account's hooks are not in the system config now: an old line of its own goes too.
    if (runnerAccounts(state).some((a) => a.uid === self.uid)) {
      applySystemState(state, { accounts: others, block: null, programs, probe: true }, deps);
    }
    return { ok: false, reason: "unsafe", detail: problem, path };
  }
  const applied = applySystemState(
    state,
    { accounts: mergeAccounts(others, [mine]), block: renderCodexManagedBlock(entries), programs, probe: true },
    deps,
  );
  if (!applied.ok) return { ok: false, reason: applied.reason, ...(applied.detail ? { detail: applied.detail } : {}), path };
  return { ok: true, path, changed: applied.changed, dropped: applied.dropped };
}

function codexRunnerProgramsFor(deps: CodexSystemDeps): CodexRunnerPrograms | null {
  return deps.programs ?? codexRunnerPrograms();
}

/** The account an earlier block keeps through the runner, if any. */
function earlierAccounts(earlier: EarlierBlock): CodexRunnerAccount[] {
  return earlier.kind === "account" ? [earlier.account] : [];
}

export type CodexSystemRemoval =
  | { status: "absent" }
  | { status: "removed"; path: string; hooks: number; remaining: number }
  | { status: "failed"; path: string; reason: string };

/**
 * Take this account out of failproofai's Codex hooks in the system config:
 * out of the runner, and the block and runner out entirely when no account is
 * left. The file is then restored from its backup when what is left is
 * exactly what was backed up, and deleted when failproofai created it and
 * nothing else was ever added. A block in the earlier format that another
 * account's install ran is rewritten to run the runner, for that account only.
 */
export function removeCodexSystemHooks(deps: CodexSystemDeps = {}): CodexSystemRemoval {
  const path = resolvedPath(deps);
  if (!path || !existsSync(path)) return { status: "absent" };
  const state = readSystemState(path, deps);
  if ("error" in state) {
    return {
      status: "failed",
      path,
      reason: /marker/.test(state.error) ? "one of failproofai's markers is missing; remove the block by hand" : state.error,
    };
  }
  const { span, form } = state;
  const self = selfAccount(deps);
  if (!span || !form || !self) return { status: "absent" };

  const earlier = form.kind === "direct" ? earlierBlock(form, state.trusted, self) : null;
  const before = mergeAccounts(earlier ? earlierAccounts(earlier) : [], runnerAccounts(state));
  const programs = codexRunnerProgramsFor(deps);
  // An earlier block runs for every account. It is another account's when that
  // account's own install is what it runs, or when this account cannot read
  // what it runs; otherwise it is this account's to remove.
  const theirs = earlier?.kind === "unknown" || (earlier?.kind === "account" && earlier.account.uid !== self.uid);
  const mine = before.some((a) => a.uid === self.uid) || (earlier !== null && !theirs);
  if (!mine) {
    // Another account's earlier block now runs only for that account, where
    // root allows; nothing of this account's was there either way.
    const block = earlier?.kind === "account" ? retargetedBlock(form, state.runner) : null;
    if (block !== null) applySystemState(state, { accounts: before, block, programs, probe: true }, deps);
    return { status: "absent" };
  }
  let accounts = before.filter((a) => a.uid !== self.uid);
  let block: string | null = null;
  if (form.kind === "direct" && accounts.length > 0) {
    block = retargetedBlock(form, state.runner);
    // A block that cannot be read back is taken out rather than guessed at.
    if (block === null) accounts = [];
  }
  const applied = applySystemState(state, { accounts, block, programs, probe: true }, deps);
  if (applied.ok && accounts.length === 0) tidyRunnerDir(state, deps.direct ?? writableDirectly(state.runner, true));
  if (applied.ok || applied.reason === "unsafe") {
    const hooks = (state.current.slice(span.start, span.end).match(/^\[\[hooks\.[A-Za-z]+\.hooks\]\]/gm) ?? []).length;
    return { status: "removed", path, hooks, remaining: applied.ok ? accounts.length - applied.dropped.length : 0 };
  }
  if (applied.reason === "no-root") return { status: "failed", path, reason: "removing it needs root, and sudo is not available" };
  return { status: "failed", path, reason: applied.detail ?? applied.reason };
}

export type CodexSystemRefresh =
  /** No block of ours: nothing to check. */
  | { status: "absent" }
  /** Nothing to change. */
  | { status: "current"; path: string }
  /** Rewritten: an earlier block now runs the runner, or accounts were taken out of it. */
  | { status: "rewritten"; path: string; runner: string; migrated: boolean; dropped: CodexDroppedAccount[] }
  /** The block failed the check, or had nothing left to run, and was taken out. */
  | { status: "removed"; path: string; reason: string }
  /** It has to change, this account set it up, and changing it needs root, which was not available. */
  | { status: "needs-root"; path: string; reason: string }
  /** It has to change, and only an account that set it up, or root, can do that. */
  | { status: "others"; path: string; reason: string }
  | { status: "failed"; path: string; reason: string };

/**
 * `failproofai update`'s check of the Codex hooks in the system config. A block
 * that runs the runner keeps running only while the runner and each account's
 * line pass the ownership check; a block in the earlier format is rewritten to
 * run the runner, for the account whose own install it ran. Root is asked for
 * (`sudo -n`) only when something has to change and this account is one of
 * those it runs for, or owns what it runs: anyone else is told, and nothing
 * is changed or asked for.
 */
export function refreshCodexSystemHooks(deps: CodexSystemDeps = {}): CodexSystemRefresh {
  const path = resolvedPath(deps);
  if (!path) return { status: "absent" };
  const state = existsSync(path) ? readSystemState(path, deps) : null;
  if (state && "error" in state) return { status: "failed", path, reason: state.error };
  const self = selfAccount(deps);
  if (!self) return { status: "absent" };
  if (!state || !state.form) {
    // A runner with no block runs nothing; tidy it away where that needs no one.
    const runner = resolvedRunner(deps, path);
    if (readRunner(runner).kind === "ours" && (deps.direct ?? writableDirectly(runner, true))) {
      try {
        removeSystemFile(runner, true);
      } catch {
        // Best effort.
      }
    }
    return { status: "absent" };
  }
  const { form, runner, runnerState } = state;
  const listed = runnerAccounts(state).some((a) => a.uid === self.uid);

  const settle = (
    applied: Applied,
    involved: boolean,
    reason: string,
    done: (a: Extract<Applied, { ok: true }>) => CodexSystemRefresh,
  ): CodexSystemRefresh => {
    if (applied.ok) return done(applied);
    if (applied.reason === "no-root") {
      return { status: involved ? "needs-root" : "others", path, reason: applied.detail ?? reason };
    }
    if (applied.reason === "unsafe") return { status: "removed", path, reason: applied.detail ?? reason };
    return { status: "failed", path, reason: applied.detail ?? reason };
  };
  const programs = codexRunnerProgramsFor(deps);

  if (form.kind === "runner") {
    const problem =
      runnerState.kind === "ours"
        ? runnerProblem(runner, runnerState.programs, state.trusted, true)
        : runnerState.kind === "absent"
          ? `${runner} is missing`
          : `${runner} was not written by failproofai`;
    if (problem) {
      const applied = applySystemState(state, { accounts: [], block: null, programs: null, probe: listed }, deps);
      return settle(applied, listed, problem, () => ({ status: "removed", path, reason: problem }));
    }
    const accounts = runnerAccounts(state);
    if (accounts.every((a) => accountProblem(a, state.trusted) === null)) return { status: "current", path };
    const applied = applySystemState(state, { accounts, block: null, programs: runnerState.kind === "ours" ? runnerState.programs : programs, probe: listed }, deps);
    const reason = "an account's failproofai can be changed by another account";
    return settle(applied, listed, reason, (a) =>
      a.changed ? { status: "rewritten", path, runner, migrated: false, dropped: a.dropped } : { status: "current", path },
    );
  }

  // The earlier format: every hook runs one program, for every account.
  const earlier = earlierBlock(form, state.trusted, self);
  if (earlier.kind === "root") return { status: "current", path };
  if (earlier.kind === "unknown") {
    return { status: "others", path, reason: "they run a failproofai this account cannot read" };
  }
  const involved = listed || earlier.owners.has(self.uid);
  const accounts = mergeAccounts(earlierAccounts(earlier), runnerAccounts(state));
  const block = retargetedBlock(form, runner);
  if (accounts.length === 0 || block === null) {
    const reason = earlier.kind === "none" ? earlier.reason : "they could not be read back";
    const applied = applySystemState(state, { accounts: [], block: null, programs: null, probe: involved }, deps);
    return settle(applied, involved, reason, () => ({ status: "removed", path, reason }));
  }
  const applied = applySystemState(state, { accounts, block, programs, probe: involved }, deps);
  return settle(applied, involved, "they predate the hook runner", (a) => ({
    status: "rewritten",
    path,
    runner,
    migrated: true,
    dropped: a.dropped,
  }));
}

/** What `failproofai update` says about {@link refreshCodexSystemHooks}' result; nothing when nothing changed. */
export function codexRefreshLines(result: CodexSystemRefresh): string[] {
  switch (result.status) {
    case "absent":
    case "current":
      return [];
    case "rewritten": {
      const lines = result.migrated
        ? [
            `✓ Codex: failproofai's hooks in ${result.path} now go through ${result.runner},`,
            "  which runs failproofai only for the accounts that set it up.",
          ]
        : [];
      for (const { uid, reason } of result.dropped) {
        lines.push(`▲ Codex: took uid ${uid} out of failproofai's hooks in ${result.path}: ${reason}.`);
      }
      if (result.dropped.length > 0) lines.push("  That account can run `failproofai config` to set them up again.");
      return lines;
    }
    case "removed":
      return [
        `▲ Codex: took failproofai's hooks out of ${result.path}: ${result.reason}.`,
        "  Run `failproofai config` to set them up again.",
      ];
    case "needs-root":
      return [
        `✕ Codex: failproofai's hooks in ${result.path} need updating, which needs root: ${result.reason}.`,
        "  Run `sudo -v` and then `failproofai update` again.",
      ];
    case "others":
      return [
        `▲ Codex: failproofai's hooks in ${result.path} need updating by an account that set them up, or by root: ${result.reason}.`,
      ];
    case "failed":
      return [`✕ Codex: could not check failproofai's hooks in ${result.path}: ${result.reason}.`];
  }
}

// ── Trust ───────────────────────────────────────────────────────────────────

/**
 * What every screen says when Codex's hooks sit in hooks.json untrusted. A
 * `notice` message: the fix on its own line. "Allow sudo", not "with sudo":
 * `failproofai config` refuses to run under sudo, and asks for it itself.
 */
export const CODEX_UNTRUSTED_NOTICE =
  "Codex won't run failproofai's hooks until they're trusted.\n" +
  "Re-run  `failproofai config`  and allow sudo, or open  `codex`  once and approve the hooks.";

export type CodexHookTrust =
  /** No failproofai Codex hooks at user scope. */
  | { kind: "none" }
  /** In Codex's system config: managed, run without trust. */
  | { kind: "system"; path: string }
  /** In hooks.json, and every one trusted at its current hash. */
  | { kind: "trusted"; path: string }
  /** In hooks.json, on a Codex old enough to run hooks without trust. */
  | { kind: "ungated"; path: string; version: string }
  /** In hooks.json and not all trusted: Codex skips the untrusted ones. */
  | { kind: "untrusted"; path: string; untrusted: number; total: number };

/** The Codex profile's home: `CODEX_HOME` when set, else `~/.codex`. */
export function codexHome(): string {
  const dir = process.env.CODEX_HOME?.trim();
  return dir ? resolve(dir) : resolve(homedir(), ".codex");
}

export interface CodexTrustDeps extends CodexSystemDeps {
  /** `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json`). */
  hooksJsonPath?: string;
  /** `$CODEX_HOME/config.toml`, where Codex keeps `[hooks.state]`. */
  userConfigPath?: string;
}

/**
 * Whether Codex will run the failproofai hooks installed at user scope.
 *
 * Mirrors Codex's own discovery: the state key is
 * `<hooks.json path>:<event_snake>:<group index>:<handler index>`, and a hook
 * runs only when the `trusted_hash` stored under it equals the hash of the
 * hook as it is now (a hook edited since it was trusted reads "modified" in
 * Codex, and is skipped like an untrusted one).
 */
export function codexHookTrust(deps: CodexTrustDeps = {}): CodexHookTrust {
  const systemPath = resolvedPath(deps);
  if (systemPath && codexSystemHooksPresent({ ...deps, path: systemPath })) return { kind: "system", path: systemPath };

  const hooksJsonPath = deps.hooksJsonPath ?? resolve(codexHome(), "hooks.json");
  const ours = failproofaiCodexHookIdentities(hooksJsonPath);
  if (ours.length === 0) return { kind: "none" };

  const version = (deps.codexVersion ?? detectCodexVersion)();
  if (version && !codexGatesHookTrust(version)) return { kind: "ungated", path: hooksJsonPath, version };

  let trustedHashes = new Map<string, string>();
  try {
    trustedHashes = parseCodexTrustedHashes(
      readFileSync(deps.userConfigPath ?? resolve(codexHome(), "config.toml"), "utf8"),
    );
  } catch {
    // No user config: nothing is trusted.
  }
  const untrusted = ours.filter((hook) => trustedHashes.get(hook.key) !== hook.hash).length;
  return untrusted === 0
    ? { kind: "trusted", path: hooksJsonPath }
    : { kind: "untrusted", path: hooksJsonPath, untrusted, total: ours.length };
}

/** `PreToolUse` → `pre_tool_use`, the label Codex puts in state keys and hashes. */
function snakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Events whose matcher Codex ignores, so the hash carries none. */
const MATCHERLESS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);

/** The state key and expected trust hash of every failproofai handler in a hooks.json. */
export function failproofaiCodexHookIdentities(hooksJsonPath: string): Array<{ key: string; hash: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = (parsed as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: Array<{ key: string; hash: string }> = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      const handlers = (group as { hooks?: unknown })?.hooks;
      if (!Array.isArray(handlers)) return;
      handlers.forEach((handler: unknown, handlerIndex) => {
        if (!isOurs(handler)) return;
        const matcher = (group as { matcher?: unknown }).matcher;
        out.push({
          key: `${hooksJsonPath}:${snakeEvent(event)}:${groupIndex}:${handlerIndex}`,
          hash: codexHookHash(event, typeof matcher === "string" ? matcher : null, handler as Record<string, unknown>),
        });
      });
    });
  }
  return out;
}

function isOurs(handler: unknown): boolean {
  if (!handler || typeof handler !== "object") return false;
  const h = handler as Record<string, unknown>;
  if (h[FAILPROOFAI_HOOK_MARKER] === true) return true;
  const cmd = typeof h.command === "string" ? h.command : "";
  return cmd.includes("failproofai") && cmd.includes("--hook");
}

/**
 * Codex's trust hash for one command handler (`hook_hash` in
 * codex-rs/hooks/src/engine/discovery.rs): the normalized identity
 * `{event_name, matcher?, hooks: [handler]}` as TOML, converted to JSON with
 * every object's keys sorted, serialized compactly, SHA-256, `sha256:<hex>`.
 * Normalization: the timeout defaults to 600 (SessionEnd/Interrupt: 1, capped
 * at 3), `async` defaults to false, `commandWindows` is dropped, and absent
 * optional fields do not appear.
 */
export function codexHookHash(event: string, matcher: string | null, handler: Record<string, unknown>): string {
  const short = event === "SessionEnd" || event === "Interrupt";
  const raw = typeof handler.timeout === "number" && Number.isFinite(handler.timeout) ? Math.trunc(handler.timeout) : null;
  const timeout = short ? Math.min(3, Math.max(1, raw ?? 1)) : Math.max(1, raw ?? 600);
  const normalized: Record<string, unknown> = {
    async: handler.async === true,
    command: typeof handler.command === "string" ? handler.command : "",
    timeout,
    type: "command",
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (typeof limit === "number" && limit !== 2500) normalized.additionalContextLimit = limit;
  const identity: Record<string, unknown> = { event_name: snakeEvent(event), hooks: [normalized] };
  if (matcher !== null && !MATCHERLESS.has(event)) identity.matcher = matcher;
  return `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}`;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `trusted_hash` per state key from a Codex `config.toml`, without a TOML
 * dependency (this package has none on purpose). Reads every form Codex or a
 * person writes it in — `[hooks.state."<key>"]` tables, an inline
 * `"<key>" = { trusted_hash = "…" }` under `[hooks.state]`, and dotted keys —
 * and ignores everything else, multi-line strings included.
 */
export function parseCodexTrustedHashes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const record = (path: string[], value: string): void => {
    if (path.length === 4 && path[0] === "hooks" && path[1] === "state" && path[3] === "trusted_hash") {
      const key = path[2].trim();
      if (key) found.set(key, value);
    }
  };
  let table: string[] = [];
  let inMultiline: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    if (trimmed.startsWith("[[")) {
      const header = readKeyPath(trimmed, 2);
      table = header ? [...header.path, "[]"] : ["[]"];
      continue;
    }
    if (trimmed.startsWith("[")) {
      const header = readKeyPath(trimmed, 1);
      table = header && trimmed[skipWs(trimmed, header.end)] === "]" ? header.path : ["?"];
      continue;
    }
    const key = readKeyPath(trimmed, 0);
    if (!key) continue;
    let i = skipWs(trimmed, key.end);
    if (trimmed[i] !== "=") continue;
    i = skipWs(trimmed, i + 1);
    const full = [...table, ...key.path];
    if (trimmed.startsWith('"""', i) || trimmed.startsWith("'''", i)) {
      const quote = trimmed.slice(i, i + 3);
      if (!trimmed.slice(i + 3).includes(quote)) inMultiline = quote;
      continue;
    }
    const str = readString(trimmed, i);
    if (str) {
      record(full, str.value);
      continue;
    }
    if (trimmed[i] === "{") {
      // Inline table of string values: { trusted_hash = "…", enabled = true }
      let j = i + 1;
      for (;;) {
        j = skipWs(trimmed, j);
        const inner = readKeyPath(trimmed, j);
        if (!inner) break;
        j = skipWs(trimmed, inner.end);
        if (trimmed[j] !== "=") break;
        j = skipWs(trimmed, j + 1);
        const v = readString(trimmed, j);
        if (v) {
          record([...full, ...inner.path], v.value);
          j = v.end;
        } else {
          while (j < trimmed.length && trimmed[j] !== "," && trimmed[j] !== "}") j++;
        }
        j = skipWs(trimmed, j);
        if (trimmed[j] !== ",") break;
        j++;
      }
    }
  }
  return found;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

/** A dotted TOML key starting at `i`: bare, "basic" and 'literal' segments. */
function readKeyPath(s: string, i: number): { path: string[]; end: number } | null {
  const path: string[] = [];
  for (;;) {
    i = skipWs(s, i);
    const quoted = readString(s, i);
    if (quoted) {
      path.push(quoted.value);
      i = quoted.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!bare) return null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    const next = skipWs(s, i);
    if (s[next] !== ".") return { path, end: i };
    i = next + 1;
  }
}

/** A single-line basic or literal TOML string at `i`, unescaped. */
function readString(s: string, i: number): { value: string; end: number } | null {
  if (s[i] === "'") {
    const close = s.indexOf("'", i + 1);
    return close < 0 ? null : { value: s.slice(i + 1, close), end: close + 1 };
  }
  if (s[i] !== '"') return null;
  let value = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return { value, end: j + 1 };
    if (c !== "\\") {
      value += c;
      continue;
    }
    const e = s[++j];
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\x1b" };
    if (e in simple) value += simple[e];
    else if (e === "u" || e === "U") {
      const len = e === "u" ? 4 : 8;
      const hex = s.slice(j + 1, j + 1 + len);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) return null;
      value += String.fromCodePoint(parseInt(hex, 16));
      j += len;
    } else return null;
  }
  return null;
}
