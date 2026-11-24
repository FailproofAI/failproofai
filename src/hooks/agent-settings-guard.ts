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
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

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
    try {
      out.add(realpathSync(path));
    } catch {
      // Not on this machine.
    }
  }
  return out;
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
    ...(cwd ? PROJECT_AGENT_SETTINGS_FILES.map((path) => join(cwd, path)) : []),
    ...extraPaths,
  ]);
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
  for (const raw of agentToolWritePaths(toolInput)) {
    const lexical = resolveAgentSettingsCandidate(raw, cwd);
    if (isAgentSettingsPath(lexical) || extras.has(lexical)) return lexical;
    // Relative and no cwd: nothing on disk to follow.
    if (!isAbsolute(lexical)) continue;
    const real = realpathOfAgentSettingsCandidate(lexical);
    if (real !== lexical && (isAgentSettingsPath(real) || extras.has(real))) return lexical;
    realTargets ??= agentSettingsRealTargets(cwd, [...extras]);
    if (realTargets.has(real)) return lexical;
  }
  return null;
}

/** Shell punctuation that can stand around a word without being part of the path. */
function bareAgentSettingsWord(word: string): string {
  return word.replace(/^[(){}'"`;&|<>]+|[(){}'"`;&|<>]+$/g, "");
}

/** A path as a regex literal that must end where a shell word or a quoted string would. */
function agentSettingsPathInTextRe(path: string, isDirectory: boolean): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}${isDirectory ? "[\\\\/]?" : ""}(?=$|[\\s'"\`;&|()<>])`, "i");
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
): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const home = homedir();
  for (const absolute of relocatedAgentSettings(extraPaths)) {
    files.add(absolute);
    dirs.add(dirname(absolute));
  }
  // `.github/hooks/` is protected as a directory only in a project that keeps
  // failproofai's Copilot hooks there; elsewhere it is where git hooks live.
  if (cwd && existsSync(join(cwd, ".github", "hooks", "failproofai.json"))) dirs.add(join(resolve(cwd), ".github", "hooks"));
  for (const relativePath of HOME_AGENT_SETTINGS_FILES) {
    const lexical = join(home, relativePath);
    try {
      const real = realpathSync(lexical);
      if (real !== lexical) files.add(real);
    } catch {
      // Not on this machine.
    }
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
  return { files, dirs };
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

/**
 * What a shell command can name for this session: the shapes, anywhere in its
 * text; each word on its own, home expanded and normalised; and the session's
 * extra files and directories. Relative words are left to the caller, which
 * knows the directory a `cd` has moved the shell to.
 */
export function agentSettingsShellNamer(extraPaths: readonly string[], cwd?: string): (text: string) => boolean {
  const extras = agentSettingsShellExtras(extraPaths, cwd);
  const textForms = [
    ...[...extras.files].flatMap((path) => withAgentSettingsHomeForm(path).map((form) => agentSettingsPathInTextRe(form, false))),
    ...[...extras.dirs].flatMap((path) => withAgentSettingsHomeForm(path).map((form) => agentSettingsPathInTextRe(form, true))),
  ];
  return (text: string): boolean => {
    if (AGENT_SETTINGS_IN_TEXT_RE.test(text) || AGENT_CONFIG_DIR_IN_TEXT_RE.test(text)) return true;
    if (textForms.some((re) => re.test(text))) return true;
    for (const raw of text.split(/\s+/)) {
      for (const word of agentSettingsWordForms(raw)) {
        if (!word || word.startsWith("-")) continue;
        // A variable other than HOME is the caller's to follow (it tracks which
        // ones hold an agent path); resolving `$D` as a file name means nothing.
        if (word.includes("$") && !/^\$\{?HOME\}?(?:[\\/]|$)/.test(word)) continue;
        const path = resolveAgentSettingsCandidate(word, undefined);
        if (isAgentSettingsPath(path) || isAgentConfigDirPath(path)) return true;
        if (isAbsolute(path) && (extras.files.has(path) || extras.dirs.has(path.replace(/[\\/]+$/, "")))) return true;
      }
    }
    return false;
  };
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
  /(?:^|[\s;&|(`])(?:\S*\/)?codex\s+(?:[^\n;&|]*\s)?features\s+disable\s+[^\n;&|]*\b(?:codex_)?hooks\b/i,
  /(?:^|[\s;&|(`])(?:\S*\/)?pi\s+(?:remove|uninstall|rm)\s+[^\n;&|]*(?:failproofai|pi-extension)/i,
  /(?:^|[\s;&|(`])(?:\S*\/)?(?:hermes|openclaw)\s+plugins?\s+(?:disable|remove|uninstall|rm|delete)\s+[^\n;&|]*failproofai/i,
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
