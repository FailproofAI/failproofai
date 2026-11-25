/**
 * The files through which every agent CLI calls failproofai, and the checks the
 * always-on guard (`block-failproofai-commands`) runs against writes to them.
 *
 * Every integration wires failproofai in through a file the agent can write as
 * itself: Claude Code's settings layers, Codex's hooks.json and the trust
 * hashes in its config.toml, Copilot's and Cursor's hook files, OpenCode's
 * config and plugin shim, Pi's settings and extensions, Antigravity's, Factory's,
 * Devin's and Goose's hook files, Hermes' config and plugin link, OpenClaw's
 * config. Editing one of them is the shortest way for an agent to switch its
 * own enforcement off, and it never has to name failproofai to do it:
 * `"disableAllHooks": true` in ANY Claude Code settings layer turns off every
 * hook in the session, wherever the hooks were installed, and Claude Code picks
 * the edit up from a file watcher, so it lands before the agent's next tool
 * call. The guard used to check only `~/.failproofai`, and only reads of these
 * files were ever refused (by the opt-in `block-read-outside-cwd`).
 *
 * Every write is refused, not only the ones that disable hooks, because a
 * content check cannot be finished. Claude Code skips a settings file that does
 * not parse or that holds one value its schema rejects, so an edit that leaves
 * the hooks in place and breaks a different key switches them off just as
 * well. The same files also hold commands Claude Code runs with no hook in front
 * of them (`statusLine`, `apiKeyHelper`, new hooks of its own) and the `env` the
 * hook process inherits (`NODE_OPTIONS`). The person at the keyboard, their
 * editor, `/permissions` and `failproofai policies --install` still write these
 * files: only the agent's own tool calls are refused.
 *
 * Names here are long on purpose. The CLI ships as one scope-hoisted bundle, and
 * a short top-level name that matches a local inside a builtin policy makes the
 * bundler rename that local (config-status.ts explains why that matters: the
 * audit cache in src/audit/cache.ts keys on each policy's source).
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { claudeLocalSettingsPaths } from "./claude-hooks-switch";

/**
 * One shape per protected file, as the path's TAIL from the agent's config
 * directory on. `[\\/]` so a Windows path matches too.
 */
const AGENT_SETTINGS_FILE_SHAPES: readonly RegExp[] = [
  // Claude Code: every settings layer. `disableAllHooks` in any one of them is
  // read after precedence, so a project or local file overrides the user file.
  /\.claude[\\/]settings(?:\.[^\\/]+)?\.json/,
  // Codex: the hooks, and config.toml, which holds the trust hashes Codex checks
  // before it runs a hooks.json hook at all.
  /\.codex[\\/](?:hooks\.json|config\.toml)/,
  // Copilot CLI (user scope), and Copilot CLI / VS Code agent mode (project).
  /\.copilot[\\/]hooks[\\/][^\\/]+\.json/,
  /\.github[\\/]hooks[\\/][^\\/]+\.json/,
  /\.cursor[\\/]hooks\.json/,
  // OpenCode: the config that registers the plugin, and the plugin shim itself.
  /\.opencode[\\/](?:opencode\.jsonc?|plugins[\\/][^\\/]+\.(?:mjs|js|ts))/,
  /\.config[\\/]opencode[\\/](?:opencode\.jsonc?|config\.json|plugins[\\/][^\\/]+\.(?:mjs|js|ts))/,
  // Pi: settings, and the extension directories it loads code from.
  /\.pi[\\/](?:agent[\\/])?(?:settings\.json|extensions(?:[\\/].*)?)/,
  // Antigravity reuses ~/.gemini/; its project hooks live in .agents/.
  /\.gemini[\\/](?:settings\.json|config[\\/]hooks\.json)/,
  /\.agents[\\/]hooks\.json/,
  // Goose: the plugin directory failproofai owns, and the config it registers in.
  /\.agents[\\/]plugins[\\/]failproofai(?:[\\/].*)?/,
  /\.config[\\/]goose[\\/]config\.yaml/,
  /\.factory[\\/]hooks\.json/,
  /(?:\.config[\\/]devin|\.devin)[\\/]config\.json/,
  // Hermes: every profile's config.yaml, and the plugin link in its plugins/.
  /\.hermes(?:-[^\\/]+)?(?:[\\/]profiles[\\/][^\\/]+)?[\\/](?:config\.yaml|plugins[\\/]failproofai(?:[\\/].*)?)/,
  // OpenClaw: every profile's openclaw.json.
  /\.openclaw(?:-[^\\/]+)?[\\/]openclaw\.json/,
];

/**
 * The directories that hold those files. Deleting or moving one removes the
 * file inside it, so `rm -rf ~/.claude` switches the hooks off as surely as
 * editing settings.json does. Only the agents' own directories: `.github` and
 * `.config` hold far too much else, and `.github/hooks/` is also where many
 * repositories keep their GIT hooks, so only its `*.json` files are protected.
 */
const AGENT_CONFIG_DIR_SHAPES: readonly RegExp[] = [
  /\.(?:claude|codex|cursor|factory|devin|opencode|gemini|pi|agents)/,
  /\.copilot(?:[\\/]hooks)?/,
  /\.opencode[\\/]plugins/,
  /\.config[\\/](?:opencode(?:[\\/]plugins)?|devin|goose)/,
  /\.pi[\\/](?:agent(?:[\\/]extensions)?|extensions)/,
  /\.gemini[\\/]config/,
  /\.agents[\\/]plugins(?:[\\/]failproofai(?:[\\/]hooks)?)?/,
  /\.hermes(?:-[^\\/]+)?(?:[\\/]profiles(?:[\\/][^\\/]+)?)?(?:[\\/]plugins)?/,
  /\.openclaw(?:-[^\\/]+)?/,
];

const agentSettingsShapeSource = (shapes: readonly RegExp[]): string => shapes.map((shape) => shape.source).join("|");

/**
 * Case-insensitive because macOS's default filesystem is: `~/.Claude/Settings.json`
 * is the same file there. On Linux the wider match only ever refuses more.
 */
const AGENT_SETTINGS_FILE_RE = new RegExp(`(?:^|[\\\\/])(?:${agentSettingsShapeSource(AGENT_SETTINGS_FILE_SHAPES)})$`, "i");
const AGENT_CONFIG_DIR_RE = new RegExp(`(?:^|[\\\\/])(?:${agentSettingsShapeSource(AGENT_CONFIG_DIR_SHAPES)})[\\\\/]?$`, "i");

/**
 * The same files found anywhere in a command's text, including inside quoted
 * code: `python3 -c "open('/home/u/.claude/settings.json','w')"` never presents
 * the path as a word of its own.
 */
const AGENT_SETTINGS_IN_TEXT_RE = new RegExp(`(?<![\\w.-])(?:${agentSettingsShapeSource(AGENT_SETTINGS_FILE_SHAPES)})(?![\\w.-])`, "i");

/**
 * A config directory inside text, after a path separator and before the end of
 * a word: `shutil.rmtree('/home/u/.claude')`. The separator keeps prose such as
 * "the .claude folder" out; a bare `.claude` WORD is caught per word instead.
 */
const AGENT_CONFIG_DIR_IN_TEXT_RE = new RegExp(
  `(?<=[\\\\/])(?:${agentSettingsShapeSource(AGENT_CONFIG_DIR_SHAPES)})[\\\\/]?(?=$|[\\s'"\`;&|()<>])`,
  "i",
);

/**
 * An agent directory's name as a string literal in a program:
 * `os.path.join(os.path.expanduser('~'), '.claude', 'settings.json')` and
 * `path.join(os.homedir(), '.codex', 'hooks.json')` never spell the path.
 * Only read inside programs handed to an interpreter, which are never on the
 * guard's read list anyway.
 */
const AGENT_DIR_IN_PROGRAM_RE =
  /['"`\\/](?:\.(?:claude|codex|cursor|copilot|opencode|pi|gemini|agents|factory|devin)|\.hermes(?:-[^'"`\\/\s]+)?|\.openclaw(?:-[^'"`\\/\s]+)?)['"`\\/]/i;

/** Whether `path` is an agent settings or hook-config file. Anchored at the end. */
export function isAgentSettingsPath(path: string): boolean {
  return AGENT_SETTINGS_FILE_RE.test(path);
}

/** Whether `path` IS an agent config directory (not a path inside one). */
export function isAgentConfigDirPath(path: string): boolean {
  return AGENT_CONFIG_DIR_RE.test(path);
}

/** `~`, `$HOME` and `${HOME}` as the shell would expand them. */
export function expandAgentSettingsHome(path: string): string {
  const home = homedir();
  if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
  const match = /^(?:~|\$HOME|\$\{HOME\})[\\/](.*)$/.exec(path);
  return match ? join(home, match[1]) : path;
}

/**
 * A path as the tool would open it: home expanded, normalised (`a/./b` and
 * `a//b` are `a/b` to the filesystem, never to a regex), and resolved against
 * the session's cwd. A relative path with no cwd stays relative, which the
 * anchored shapes still read (`.claude/settings.json` begins the string).
 */
function resolveAgentSettingsCandidate(path: string, cwd: string | undefined): string {
  const expanded = expandAgentSettingsHome(path);
  if (isAbsolute(expanded)) return resolve(expanded);
  return cwd ? resolve(cwd, expanded) : normalize(expanded);
}

/**
 * Where a path really leads, following every symlink on the way.
 *
 * For a file that does not exist yet (a Write that creates it), the deepest
 * ancestor that does exist is resolved and the rest appended: a project symlink
 * `cfg -> ~/.claude` makes `cfg/settings.local.json` a Claude settings file
 * before it has ever been written. Never throws.
 */
function realpathOfAgentSettingsCandidate(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
  return path;
}

/** Linux gives up after this many links in one path (MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

/**
 * `path` walked the way the kernel walks it: one component at a time from
 * `base`, a symlink replaced by where it points before the walk goes on. So a
 * `..` after a link climbs out of the link's TARGET: with `link ->
 * ~/.claude/subdir`, `link/../settings.json` is `~/.claude/settings.json`,
 * where text normalisation drops `link/..` and lands beside the link. A link
 * that leads nowhere yet is followed too — a write through it creates its
 * target. Past the first component that does not exist, the rest is joined as
 * text. Null on a loop or a link that cannot be read; both fail the write too.
 */
function physicalWalk(base: string, path: string): string | null {
  let parts = path.split("/");
  let current = base;
  let hops = 0;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(next, { throwIfNoEntry: false });
    } catch {
      // ENOTDIR under a file, EACCES, a component too long: nothing to follow.
      stat = undefined;
    }
    if (stat === undefined) return join(next, ...parts.slice(k + 1));
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null;
    }
    if (target.startsWith("/")) current = "/";
    parts = [...target.split("/"), ...parts.slice(k + 1)];
    k = -1;
  }
  return current;
}

/** Paths longer than this cannot be opened (PATH_MAX), so they write nothing. */
const MAX_PHYSICAL_PATH = 4096;

/**
 * Where `path` really leads from `cwd`, symlinks and `..` taken in the
 * kernel's order (see physicalWalk), home expanded. Null when it cannot be
 * known: a relative path with no cwd, or one too long to open. `bases` keeps
 * each cwd's own walk for a caller that resolves many words from one.
 */
export function physicalAgentPath(
  path: string,
  cwd: string | undefined,
  bases?: Map<string, string | null>,
): string | null {
  // Only the home prefix: `join` would also drop `link/..` before the walk
  // could follow `link` (`~/link/../settings.json`).
  const home = homedir();
  const prefixed = /^(?:~|\$HOME|\$\{HOME\})(\/.*)?$/.exec(path);
  const expanded = prefixed ? `${home}${prefixed[1] ?? ""}` : path;
  if (expanded.length === 0 || expanded.length > MAX_PHYSICAL_PATH) return null;
  if (isAbsolute(expanded)) return physicalWalk("/", expanded);
  if (!cwd) return null;
  let base = bases?.get(cwd);
  if (base === undefined) {
    base = physicalWalk("/", resolve(cwd));
    bases?.set(cwd, base);
  }
  return base === null ? null : physicalWalk(base, expanded);
}

/** Agent settings files under the home directory, relative to it. */
const HOME_AGENT_SETTINGS_FILES: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".copilot/hooks/failproofai.json",
  ".cursor/hooks.json",
  ".config/opencode/opencode.json",
  ".config/opencode/opencode.jsonc",
  ".config/opencode/config.json",
  ".config/opencode/plugins/failproofai.mjs",
  ".opencode/opencode.json",
  ".pi/agent/settings.json",
  ".gemini/settings.json",
  ".gemini/config/hooks.json",
  ".agents/plugins/failproofai/hooks/hooks.json",
  ".config/goose/config.yaml",
  ".factory/hooks.json",
  ".config/devin/config.json",
  ".hermes/config.yaml",
  ".openclaw/openclaw.json",
];

/** The agent directories under the home directory, relative to it. */
const HOME_AGENT_CONFIG_DIRS: readonly string[] = [
  ".claude", ".codex", ".copilot", ".cursor", ".config/opencode", ".opencode", ".pi", ".gemini",
  ".agents", ".config/goose", ".factory", ".config/devin", ".hermes", ".openclaw",
];

/** A project's agent settings files, relative to the project root. */
const PROJECT_AGENT_SETTINGS_FILES: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
  ".github/hooks/failproofai.json",
  ".opencode/opencode.json",
  ".pi/settings.json",
  ".gemini/settings.json",
  ".agents/hooks.json",
  ".factory/hooks.json",
  ".devin/config.json",
];

function realpathsOf(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const real = settingsLinkTarget(path);
    if (real !== null) out.add(real);
  }
  return out;
}

/**
 * Where a settings path really is: its realpath, or — for a link whose target
 * does not exist yet — that target, walked the way the kernel would create
 * it: `.claude/settings.local.json -> ../config/new.json` makes a first
 * write of config/new.json a write of the settings. Null when there is
 * neither a file nor a link there.
 */
function settingsLinkTarget(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      if (!lstatSync(path).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return physicalAgentPath(path, undefined);
  }
}

/**
 * Where the settings this session's agent reads really are, after symlinks:
 * the home directory's files (the dotfiles layout, `~/.claude/settings.json`
 * linked into a repository of dotfiles), the project's files (a committed
 * `.claude/settings.json` that links to `config/claude.json`), and the file the
 * hook itself was loaded from. The file an agent edits there names no agent
 * directory at all.
 */
function agentSettingsRealTargets(cwd: string | undefined, extraPaths: readonly string[]): Set<string> {
  const home = homedir();
  return realpathsOf([
    ...HOME_AGENT_SETTINGS_FILES.map((path) => join(home, path)),
    ...agentProjectRoots(cwd).flatMap((root) => PROJECT_AGENT_SETTINGS_FILES.map((path) => join(root, path))),
    ...agentLocalSettingsFiles(cwd),
    ...extraPaths,
  ]);
}

/**
 * Where Claude Code reads this session's `settings.local.json`, the places the
 * walk to the repository root does not reach included: a linked worktree's
 * are at the main checkout's root (the same files `config --status` reads).
 */
function agentLocalSettingsFiles(cwd: string | undefined): string[] {
  return cwd ? claudeLocalSettingsPaths(cwd) : [];
}

/**
 * The directories whose project settings apply to a session in `cwd`: `cwd`
 * itself and each directory above it up to the repository root. Agents read
 * project and local settings at the root from a subdirectory (Claude Code
 * keeps `settings.local.json` there), so a root file's link target is theirs
 * too. Outside a repository, `cwd` alone.
 */
function agentProjectRoots(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const roots: string[] = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    roots.push(dir);
    if (existsSync(join(dir, ".git"))) return roots;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [resolve(cwd)];
}

/**
 * Directories whose every file is part of an agent's hooks, wherever they
 * live: what Hermes' `plugins/failproofai` links to (the package's
 * `hermes-plugin/`, or a copy), in every profile, and the package's own plugin
 * directories, which OpenClaw and Pi load in place. Editing one of their
 * files changes what the hook does without touching any settings file.
 */
function agentPluginTrees(): string[] {
  const home = homedir();
  const hermesHomes = [join(home, ".hermes")];
  try {
    for (const name of readdirSync(join(home, ".hermes", "profiles"))) hermesHomes.push(join(home, ".hermes", "profiles", name));
  } catch {
    // No profiles.
  }
  try {
    for (const name of readdirSync(home)) if (name.startsWith(".hermes-")) hermesHomes.push(join(home, name));
  } catch {
    // Unreadable home: the default profile alone.
  }
  const trees = new Set<string>();
  for (const hermes of hermesHomes) {
    const link = join(hermes, "plugins", "failproofai");
    try {
      const real = realpathSync(link);
      if (real !== link) trees.add(real);
    } catch {
      // Not installed for this profile.
    }
  }
  const packageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
  if (packageRoot) {
    for (const name of ["hermes-plugin", "openclaw-plugin", "pi-extension"]) {
      const dir = join(packageRoot, name);
      try {
        trees.add(realpathSync(dir));
      } catch {
        // Not in this package.
      }
    }
  }
  return [...trees];
}

/** Whether `path` is one of `trees` or lies inside one. */
function insideAgentPluginTree(path: string, trees: readonly string[]): boolean {
  return trees.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

/** The string values of a tool input, a few levels deep (Codex wraps a patch in an array). */
function agentSettingsInputStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (depth < 3 && Array.isArray(value)) for (const item of value) agentSettingsInputStrings(item, depth + 1, out);
  else if (depth < 3 && value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) agentSettingsInputStrings(item, depth + 1, out);
  }
  return out;
}

/**
 * The files a patch touches: OpenAI's apply_patch envelope (`*** Update File:`,
 * `*** Add File:`, `*** Delete File:`, `*** Move to:`) and unified-diff headers.
 * Leading whitespace is allowed on each, because Codex applies an indented
 * marker too.
 */
export function agentPatchTargetPaths(patch: string): string[] {
  const out: string[] = [];
  for (const [, path] of patch.matchAll(/^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): *(.+?) *$/gm)) {
    out.push(path);
  }
  for (const [, path] of patch.matchAll(/^[ \t]*(?:\+\+\+|---) (?:[ab][\\/])?([^\t\r\n]+?)(?:\t.*)? *$/gm)) {
    if (path !== "/dev/null") out.push(path);
  }
  return out;
}

/** The keys a patch arrives under, across the CLIs that canonicalize apply_patch to Edit. */
const AGENT_PATCH_CARRIER_KEYS: readonly string[] = ["patch", "patchText", "patch_text", "input", "command", "diff", "changes"];

/**
 * Every path a file-writing tool call would write.
 *
 * `file_path` (Write, Edit, MultiEdit), `notebook_path` (NotebookEdit) and
 * `path` cover the canonical inputs. Codex, Copilot and OpenCode `apply_patch`
 * canonicalize to `Edit` with the paths inside the patch text, so the keys a
 * patch travels under are read as patches as well, whether or not a path key is
 * there too. `content`, `old_string` and `new_string` never are: a Write whose
 * content happens to be a diff writes its own file_path.
 */
export function agentToolWritePaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const named = ["file_path", "notebook_path", "path"]
    .map((key) => toolInput[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const patched = AGENT_PATCH_CARRIER_KEYS.flatMap((key) =>
    agentSettingsInputStrings(toolInput[key]).flatMap((text) => agentPatchTargetPaths(text)),
  );
  return [...named, ...patched];
}

/**
 * The agent settings file a file-tool call would write, or null.
 *
 * Checked as written, then after symlinks: a path that leads into an agent
 * directory through a link, and a file that IS the target of one of the agent's
 * settings links, are the same file to the agent CLI. `extraPaths` are settings
 * files known for this session that no shape describes: the file the hook was
 * loaded from when `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moved it.
 */
export function agentSettingsWriteTarget(
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  extraPaths: readonly string[] = [],
): string | null {
  const extras = new Set([...extraPaths.map((path) => resolve(path)), ...relocatedAgentSettings(extraPaths)]);
  let realTargets: Set<string> | undefined;
  let trees: string[] | undefined;
  for (const raw of agentToolWritePaths(toolInput)) {
    const lexical = resolveAgentSettingsCandidate(raw, cwd);
    if (isAgentSettingsPath(lexical) || extras.has(lexical)) return lexical;
    // Relative and no cwd: nothing on disk to follow.
    if (!isAbsolute(lexical)) continue;
    const real = realpathOfAgentSettingsCandidate(lexical);
    if (real !== lexical && (isAgentSettingsPath(real) || extras.has(real))) return lexical;
    realTargets ??= agentSettingsRealTargets(cwd, [...extras]);
    if (realTargets.has(real)) return lexical;
    // `lexical` lost its `..` before any link was followed; the filesystem
    // follows the link first: `link/../settings.json` with `link ->
    // ~/.claude/subdir` writes `~/.claude/settings.json`.
    const physical = physicalAgentPath(raw, cwd);
    if (physical !== null && physical !== real && (isAgentSettingsPath(physical) || extras.has(physical) || realTargets.has(physical))) {
      return lexical;
    }
    trees ??= agentPluginTrees();
    if ([lexical, real, physical].some((path) => path !== null && insideAgentPluginTree(path, trees!))) return lexical;
  }
  return null;
}

/** Shell punctuation that can stand around a word without being part of the path. */
function bareAgentSettingsWord(word: string): string {
  return word.replace(/^[(){}'"`;&|<>]+|[(){}'"`;&|<>]+$/g, "");
}

/** What can stand right before a path that starts a shell word, a quoted string or a value. */
const PATH_START_EDGE = String.raw`\s'"\x60;&|()<>=,{}\[\]:@/`;

/**
 * A path as a regex literal that must start and end where a shell word or a
 * quoted string would — or right after a glued short option (`-C/srv/x`) — so
 * `/backup/srv/profile/settings.json` is not read as `/srv/profile/settings.json`.
 */
function agentSettingsPathInTextRe(path: string, isDirectory: boolean): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = `(?<=^|[${PATH_START_EDGE}]|(?:^|[${PATH_START_EDGE}])-[A-Za-z])`;
  return new RegExp(`${start}${escaped}${isDirectory ? "[\\\\/]?" : ""}(?=$|[\\s'"\`;&|()<>])`, "i");
}

/** A directory as a regex literal that matches it and every path inside it, from where a word starts. */
function agentSettingsTreeInTextRe(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = `(?<=^|[${PATH_START_EDGE}]|(?:^|[${PATH_START_EDGE}])-[A-Za-z])`;
  return new RegExp(`${start}${escaped}(?=$|[\\/\\s'"\`;&|()<>])`, "i");
}

/**
 * A word as each form the shell may hand it over in: the word itself, and the
 * value after `=` for `--output=<path>`, `of=<path>` and `FOO=<path>`.
 */
function agentSettingsWordForms(raw: string): string[] {
  const word = bareAgentSettingsWord(raw);
  const eq = word.indexOf("=");
  return eq > 0 ? [word, word.slice(eq + 1)] : [word];
}

/**
 * Settings files and directories known for this session beyond the shapes:
 * `extraPaths` with their directories, and the real locations behind the home
 * directory's agent links (a dotfiles checkout). A shell command reaching any of
 * them reaches the agent's settings.
 */
function agentSettingsShellExtras(
  extraPaths: readonly string[],
  cwd: string | undefined,
): { files: Set<string>; dirs: Set<string>; trees: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const home = homedir();
  for (const absolute of relocatedAgentSettings(extraPaths)) {
    files.add(absolute);
    dirs.add(dirname(absolute));
    // And where it really is, existing or not yet: CLAUDE_CONFIG_DIR's
    // settings.json linked to /tmp/actual/primary.json is written as that.
    const real = settingsLinkTarget(absolute);
    if (real !== null && real !== absolute) files.add(real);
  }
  // `.github/hooks/` is protected as a directory only in a project that keeps
  // failproofai's Copilot hooks there; elsewhere it is where git hooks live.
  const roots = agentProjectRoots(cwd);
  for (const root of roots) {
    if (existsSync(join(root, ".github", "hooks", "failproofai.json"))) dirs.add(join(root, ".github", "hooks"));
  }
  // A project's settings linked elsewhere (`.claude/settings.json ->
  // ../config/claude.json`) are written through the target's own name, from
  // the root's subdirectories too.
  const projectFiles = [
    ...roots.flatMap((root) => PROJECT_AGENT_SETTINGS_FILES.map((path) => join(root, path))),
    ...agentLocalSettingsFiles(cwd),
  ];
  for (const lexical of [...HOME_AGENT_SETTINGS_FILES.map((path) => join(home, path)), ...projectFiles]) {
    const real = settingsLinkTarget(lexical);
    if (real !== null && real !== lexical) files.add(real);
  }
  for (const relativePath of HOME_AGENT_CONFIG_DIRS) {
    const lexical = join(home, relativePath);
    try {
      const real = realpathSync(lexical);
      if (real !== lexical) dirs.add(real);
    } catch {
      // Not on this machine.
    }
  }
  return { files, dirs, trees: agentPluginTrees() };
}

/**
 * The session's settings files that no shape describes — a config directory
 * moved by `CLAUDE_CONFIG_DIR` or `CODEX_HOME` — with the files beside them
 * that switch the same hooks off: Claude Code's `settings.local.json`, Codex's
 * `config.toml` (its hook trust and `[features] hooks`). A file the shapes
 * already cover adds nothing: its directory may be a shared one
 * (`.github/hooks`), where a directory rule would only refuse ordinary work.
 */
function relocatedAgentSettings(extraPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of extraPaths) {
    const absolute = resolve(path);
    if (isAgentSettingsPath(absolute)) continue;
    out.push(absolute);
    const name = basename(absolute).toLowerCase();
    if (name === "settings.json") out.push(join(dirname(absolute), "settings.local.json"));
    if (name === "hooks.json") out.push(join(dirname(absolute), "config.toml"));
  }
  return out;
}

/** A path under the home directory as `~/…` too, the way commands usually spell it. */
function withAgentSettingsHomeForm(path: string): string[] {
  const home = homedir();
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [path, `~/${rel}`] : [path];
}

/** Text that every agent settings path or directory contains somewhere. */
const AGENT_SETTINGS_HINT_SOURCE =
  "claude|codex|cursor|copilot|github|opencode|\\.pi|gemini|agents|factory|devin|goose|hermes|openclaw|settings|hooks|config|plugins|extensions";

/**
 * The hint for this session: the agents' names, plus every name in the
 * session's extra settings files and the real locations behind the home
 * directory's links, so a word that could reach one is never skipped.
 */
function agentSettingsHintFrom(extras: { files: Set<string>; dirs: Set<string>; trees: readonly string[] }): RegExp {
  const names = [...extras.files, ...extras.dirs, ...extras.trees]
    .flatMap((path) => path.split(/[\\/]/))
    .filter((segment) => segment.length > 2)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp([AGENT_SETTINGS_HINT_SOURCE, ...names].join("|"), "i");
}

/**
 * What a shell command can name for this session: the shapes, anywhere in its
 * text; each word on its own, home expanded and normalised; and the session's
 * extra files and directories. Relative words are left to the caller, which
 * knows the directory a `cd` has moved the shell to.
 */
export function agentSettingsShellMatcher(
  extraPaths: readonly string[],
  cwd?: string,
): {
  names: (text: string) => boolean;
  hint: RegExp;
  /** Whether a word (relative to `cwd` when relative) leads to one of them through a symlink. */
  throughLinks: (word: string, cwd: string | undefined) => boolean;
} {
  const extras = agentSettingsShellExtras(extraPaths, cwd);
  const hint = agentSettingsHintFrom(extras);
  const textForms = [
    ...[...extras.files].flatMap((path) => withAgentSettingsHomeForm(path).map((form) => agentSettingsPathInTextRe(form, false))),
    ...[...extras.dirs].flatMap((path) => withAgentSettingsHomeForm(path).map((form) => agentSettingsPathInTextRe(form, true))),
    // A plugin tree is reached by any path inside it, not only by its own name.
    ...extras.trees.flatMap((path) => withAgentSettingsHomeForm(path).map((form) => agentSettingsTreeInTextRe(form))),
  ];
  const names = (text: string): boolean => {
    if (AGENT_SETTINGS_IN_TEXT_RE.test(text) || AGENT_CONFIG_DIR_IN_TEXT_RE.test(text)) return true;
    if (textForms.some((re) => re.test(text))) return true;
    for (const raw of text.split(/\s+/)) {
      // A word with none of the agents' names in it cannot be one of their
      // paths; skipping it spares a path resolution per word of a long line.
      if (!hint.test(raw)) continue;
      for (const word of agentSettingsWordForms(raw)) {
        if (!word || word.startsWith("-")) continue;
        // A variable other than HOME is the caller's to follow (it tracks which
        // ones hold an agent path); resolving `$D` as a file name means nothing.
        if (word.includes("$") && !/^\$\{?HOME\}?(?:[\\/]|$)/.test(word)) continue;
        const path = resolveAgentSettingsCandidate(word, undefined);
        if (isAgentSettingsPath(path) || isAgentConfigDirPath(path)) return true;
        if (isAbsolute(path) && (extras.files.has(path) || extras.dirs.has(path.replace(/[\\/]+$/, "")))) return true;
        if (isAbsolute(path) && insideAgentPluginTree(path.replace(/[\\/]+$/, ""), extras.trees)) return true;
      }
    }
    return false;
  };
  // A word whose own text names nothing can still lead to a settings file: a
  // link in the project (`cfg.json -> ~/.claude/settings.json`), a linked
  // directory (`agent-dir/settings.json`), a `..` after a link. Looked up on
  // disk, so ahead of the hint, which only reads the text; once per word.
  const physicalHits = new Map<string, boolean>();
  const physicalBases = new Map<string, string | null>();
  const throughLinks = (raw: string, cwd: string | undefined): boolean => {
    const forms = agentSettingsWordForms(raw);
    // A value glued to a short option is a path too: `-oarchive/link/../settings.json`.
    if (/^-[A-Za-z]./.test(raw) && !raw.startsWith("--")) forms.push(...agentSettingsWordForms(raw.slice(2)));
    for (const word of forms) {
      if (!word || word.startsWith("-") || (word.includes("$") && !/^\$\{?HOME\}?(?:[\\/]|$)/.test(word))) continue;
      const key = `${cwd ?? ""}\0${word}`;
      let hit = physicalHits.get(key);
      if (hit === undefined) {
        const physical = physicalAgentPath(word, cwd, physicalBases);
        hit = physical !== null && physical !== resolveAgentSettingsCandidate(word, cwd) && names(physical);
        physicalHits.set(key, hit);
      }
      if (hit) return true;
    }
    return false;
  };
  return { names, hint, throughLinks };
}

/** Whether a program handed to an interpreter builds an agent settings path. */
export function programNamesAgentSettings(program: string): boolean {
  return AGENT_DIR_IN_PROGRAM_RE.test(program);
}

/**
 * The directory a shell command runs in: Antigravity's `run_command` carries
 * its own `Cwd` (canonicalized to `tool_input.cwd`), which wins over the
 * session's; every other CLI runs in the session's cwd.
 */
export function agentSettingsShellCwd(toolInput: Record<string, unknown> | undefined, sessionCwd: string | undefined): string | undefined {
  const own = toolInput?.cwd;
  if (typeof own !== "string" || own.length === 0) return sessionCwd;
  return resolveAgentSettingsCandidate(own, sessionCwd);
}

/**
 * Commands of the agent CLIs themselves that turn hooks off for good, with no
 * settings path in them: `codex features disable hooks` writes
 * `[features] hooks = false` into config.toml (verified on Codex 0.160.0), and
 * `pi remove <failproofai's extension>` takes it out of Pi's settings. Hermes'
 * and OpenClaw's plugin commands are matched by their documented shape. A
 * one-run override (`claude --settings`, `codex -c features.hooks=false`)
 * starts a separate agent rather than changing this one's settings, and is
 * not matched.
 */
const AGENT_CLI_HOOKS_OFF_RES: readonly RegExp[] = [
  /(?:^|[\s;&|(`])(?:[^\s;&|()`<>]*\/)?codex\s+(?:[^\n;&|]*\s)?features\s+disable\s+[^\n;&|]*\b(?:codex_)?hooks\b/i,
  /(?:^|[\s;&|(`])(?:[^\s;&|()`<>]*\/)?pi\s+(?:remove|uninstall|rm)\s+[^\n;&|]*(?:failproofai|pi-extension)/i,
  /(?:^|[\s;&|(`])(?:[^\s;&|()`<>]*\/)?(?:hermes|openclaw)\s+plugins?\s+(?:disable|remove|uninstall|rm|delete)\s+[^\n;&|]*failproofai/i,
];

export function agentCliSwitchesHooksOff(command: string): boolean {
  return AGENT_CLI_HOOKS_OFF_RES.some((re) => re.test(command));
}

/**
 * Agent paths as a glob would have to reach them: relative to a project, and
 * under a home directory spelled every way a command can spell it.
 */
const PROJECT_AGENT_SETTINGS_GLOB_PATHS: readonly string[] = [
  ".claude", ".claude/settings.json", ".claude/settings.local.json",
  ".codex", ".codex/hooks.json", ".codex/config.toml",
  ".cursor", ".cursor/hooks.json",
  ".github/hooks/failproofai.json",
  ".opencode", ".opencode/opencode.json", ".opencode/plugins/failproofai.mjs",
  ".pi", ".pi/settings.json", ".pi/extensions",
  ".gemini", ".gemini/settings.json",
  ".agents", ".agents/hooks.json", ".agents/plugins/failproofai",
  ".factory", ".factory/hooks.json",
  ".devin", ".devin/config.json",
];

const HOME_AGENT_SETTINGS_GLOB_PATHS: readonly string[] = [
  ".claude", ".claude/settings.json", ".claude/settings.local.json",
  ".codex", ".codex/hooks.json", ".codex/config.toml",
  ".cursor", ".cursor/hooks.json",
  ".copilot", ".copilot/hooks", ".copilot/hooks/failproofai.json",
  ".config/opencode", ".config/opencode/opencode.json", ".config/opencode/plugins/failproofai.mjs",
  ".pi", ".pi/agent/settings.json", ".pi/agent/extensions",
  ".gemini", ".gemini/settings.json", ".gemini/config/hooks.json",
  ".agents", ".agents/plugins/failproofai", ".agents/plugins/failproofai/hooks/hooks.json",
  ".config/goose", ".config/goose/config.yaml",
  ".factory", ".factory/hooks.json",
  ".config/devin", ".config/devin/config.json",
  ".hermes", ".hermes/config.yaml", ".hermes/plugins/failproofai",
  ".openclaw", ".openclaw/openclaw.json",
];

/**
 * Ordinary nested paths a glob aimed at agent settings must NOT reach.
 *
 * The state guard's decoys are top-level names, because its target is a
 * top-level directory. Settings files sit one level down, so removing every
 * `.json` one directory deep in a repository compiled to a pattern that reaches
 * `.claude/settings.json` and no decoy at all. These are the ordinary files such
 * a pattern also lands on — and the ordinary siblings of agent files that live
 * in a shared directory (`~/.config`, `.github`, git hooks in `.github/hooks`),
 * so a sweep of one reads as the sweep it is. Agents' own directories get no
 * siblings here: a glob over `~/.claude` IS aimed at the settings inside it.
 */
const AGENT_SETTINGS_GLOB_DECOY_PATHS: readonly string[] = [
  "src/settings.json", "config/hooks.json", "app/config.toml", "deploy/config.yaml",
  "lib/plugins/index.mjs", "projects", "docs",
  ".config/git", ".config/gh", ".config/nvim", ".github/workflows", ".github/hooks/pre-commit",
];

const AGENT_SETTINGS_HOME_SPELLINGS = ["~", "$HOME", "${HOME}", "/home/u", "/Users/u", "/root"] as const;

function underEveryAgentSettingsHome(paths: readonly string[]): string[] {
  const homes = [...AGENT_SETTINGS_HOME_SPELLINGS, homedir().replaceAll("\\", "/")];
  return homes.flatMap((home) => paths.map((path) => `${home}/${path}`));
}

/**
 * The paths a glob has to be able to reach to count as aimed at agent settings.
 *
 * When the session already stands in an agent directory, the files directly in
 * it are reachable by a bare `*.json`, so their names join the list, and so do
 * the session's extra settings files and directories.
 */
export function agentSettingsGlobCandidates(cwd: string | undefined, extraPaths: readonly string[] = []): string[] {
  const candidates = [...PROJECT_AGENT_SETTINGS_GLOB_PATHS, ...underEveryAgentSettingsHome(HOME_AGENT_SETTINGS_GLOB_PATHS)];
  for (const absolute of relocatedAgentSettings(extraPaths)) {
    candidates.push(...withAgentSettingsHomeForm(absolute), ...withAgentSettingsHomeForm(dirname(absolute)));
  }
  if (cwd && isAgentConfigDirPath(cwd)) {
    const here = cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    for (const path of [...PROJECT_AGENT_SETTINGS_GLOB_PATHS, ...HOME_AGENT_SETTINGS_GLOB_PATHS]) {
      // `.config/opencode/opencode.json` from inside `~/.config/opencode` is
      // `opencode.json`: every split of the path whose directory half is where
      // the session stands.
      for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
        if (here.endsWith(`/${path.slice(0, cut).toLowerCase()}`)) candidates.push(path.slice(cut + 1));
      }
    }
  }
  return candidates;
}

/**
 * Decoys for those candidates, in the same spellings, on top of the shared
 * `baseDecoys`. From inside an agent directory the bare-name decoys go: they
 * are what keeps `rm -rf *` allowed in a project, and in `~/.claude` that
 * command removes the settings.
 */
export function agentSettingsGlobDecoys(cwd: string | undefined, baseDecoys: readonly string[]): string[] {
  const decoys = [...baseDecoys, ...AGENT_SETTINGS_GLOB_DECOY_PATHS, ...underEveryAgentSettingsHome(AGENT_SETTINGS_GLOB_DECOY_PATHS)];
  return cwd && isAgentConfigDirPath(cwd) ? decoys.filter((decoy) => decoy.includes("/")) : decoys;
}
