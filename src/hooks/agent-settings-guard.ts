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
 * well; `env` in the same file reaches the hook process; a hook command
 * repointed at `true` keeps its marker. The person at the keyboard, their
 * editor, `/permissions` and `failproofai policies --install` still write these
 * files: only the agent's own tool calls are refused.
 *
 * Names here are long on purpose: the CLI ships as one scope-hoisted bundle,
 * and a short top-level name that matches a local inside a builtin policy makes
 * the bundler rename that local, which changes the source the audit cache keys
 * on (see config-status.ts).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
 * `.config` hold far too much else to refuse every write to them.
 */
const AGENT_CONFIG_DIR_SHAPES: readonly RegExp[] = [
  /\.(?:claude|codex|cursor|factory|devin|opencode|gemini|pi|agents)/,
  /\.copilot(?:[\\/]hooks)?/,
  /\.github[\\/]hooks/,
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
 * "the .claude folder" out; a bare `.claude` WORD is caught per token instead.
 */
const AGENT_CONFIG_DIR_IN_TEXT_RE = new RegExp(
  `(?<=[\\\\/])(?:${agentSettingsShapeSource(AGENT_CONFIG_DIR_SHAPES)})[\\\\/]?(?=$|[\\s'"\`;&|()<>])`,
  "i",
);

/** Whether `path` is an agent settings or hook-config file. Anchored at the end. */
export function isAgentSettingsPath(path: string): boolean {
  return AGENT_SETTINGS_FILE_RE.test(path);
}

/** Whether `path` IS an agent config directory (not a path inside one). */
export function isAgentConfigDirPath(path: string): boolean {
  return AGENT_CONFIG_DIR_RE.test(path);
}

/** `~`, `$HOME` and `${HOME}` as the shell would expand them. */
function expandAgentSettingsHome(path: string): string {
  const home = homedir();
  if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
  const match = /^(?:~|\$HOME|\$\{HOME\})[\\/](.*)$/.exec(path);
  return match ? join(home, match[1]) : path;
}

/**
 * A path as the tool would open it: home expanded and resolved against the
 * session's cwd. A relative path with no cwd stays relative, which the anchored
 * shapes still read (`.claude/settings.json` begins at the start of the string).
 */
function resolveAgentSettingsCandidate(path: string, cwd: string | undefined): string {
  const expanded = expandAgentSettingsHome(path);
  if (isAbsolute(expanded) || !cwd) return expanded;
  return resolve(cwd, expanded);
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

/**
 * Agent settings files under the home directory, as their home-relative paths.
 *
 * Their REAL paths are compared against a write's real path, which is what
 * catches the dotfiles layout: `~/.claude/settings.json` symlinked to
 * `~/dotfiles/claude/settings.json`, where the file the agent edits names no
 * agent directory at all.
 */
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

function homeAgentSettingsRealpaths(): Set<string> {
  const home = homedir();
  const out = new Set<string>();
  for (const relative of HOME_AGENT_SETTINGS_FILES) {
    try {
      out.add(realpathSync(join(home, relative)));
    } catch {
      // Not on this machine.
    }
  }
  return out;
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
 */
export function agentPatchTargetPaths(patch: string): string[] {
  const out: string[] = [];
  for (const [, path] of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): *(.+?) *$/gm)) {
    out.push(path);
  }
  for (const [, path] of patch.matchAll(/^(?:\+\+\+|---) (?:[ab][\\/])?([^\t\r\n]+?)(?:\t.*)? *$/gm)) {
    if (path !== "/dev/null") out.push(path);
  }
  return out;
}

/**
 * Every path a file-writing tool call would write.
 *
 * `file_path` (Write, Edit, MultiEdit), `notebook_path` (NotebookEdit) and
 * `path` cover the canonical inputs. Codex, Copilot and OpenCode `apply_patch`
 * canonicalize to `Edit` with NO path key at all, because the paths sit inside
 * the patch text; for those, and only those, the input's strings are read as a
 * patch. A Write whose CONTENT happens to be a diff names its own file_path.
 */
export function agentToolWritePaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const named = ["file_path", "notebook_path", "path"]
    .map((key) => toolInput[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (named.length > 0) return named;
  return agentSettingsInputStrings(toolInput).flatMap((text) => agentPatchTargetPaths(text));
}

/**
 * The agent settings file a file-tool call would write, or null.
 *
 * Checked as written, then after symlinks: a path that leads into an agent
 * directory through a link, and a file that IS the target of one of the home
 * directory's settings symlinks, are the same file to the agent CLI.
 */
export function agentSettingsWriteTarget(
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
): string | null {
  let homeReals: Set<string> | undefined;
  for (const raw of agentToolWritePaths(toolInput)) {
    const lexical = resolveAgentSettingsCandidate(raw, cwd);
    if (isAgentSettingsPath(lexical)) return lexical;
    // Relative and no cwd: nothing on disk to follow.
    if (!isAbsolute(lexical)) continue;
    const real = realpathOfAgentSettingsCandidate(lexical);
    if (real !== lexical && isAgentSettingsPath(real)) return lexical;
    homeReals ??= homeAgentSettingsRealpaths();
    if (homeReals.has(real)) return lexical;
  }
  return null;
}

/** Shell punctuation that can stand around a word without being part of the path. */
function bareAgentSettingsWord(word: string): string {
  return word.replace(/^[(){}'"`;&|<>]+|[(){}'"`;&|<>]+$/g, "");
}

/**
 * Whether shell text names an agent settings file or config directory.
 *
 * The text forms catch a path anywhere, quoted code included. Then each word on
 * its own, resolved the way the shell would: `~` expanded, and a relative word
 * against the session's cwd, so `sed -i … settings.json` from a shell that an
 * earlier call left in `~/.claude` names the file even though the text never
 * says where it is.
 */
export function shellTextNamesAgentSettings(text: string, cwd: string | undefined): boolean {
  if (AGENT_SETTINGS_IN_TEXT_RE.test(text) || AGENT_CONFIG_DIR_IN_TEXT_RE.test(text)) return true;
  for (const raw of text.split(/\s+/)) {
    const word = bareAgentSettingsWord(raw);
    if (!word || word.startsWith("-")) continue;
    // A variable other than HOME is the walker's to follow (it tracks which
    // ones hold an agent path); resolving `$D` as a file name would mean nothing.
    if (word.includes("$") && !/^\$\{?HOME\}?(?:[\\/]|$)/.test(word)) continue;
    const path = resolveAgentSettingsCandidate(word, cwd);
    if (isAgentSettingsPath(path) || isAgentConfigDirPath(path)) return true;
  }
  return false;
}

/**
 * Agent paths as a glob would have to reach them: relative to a project, and
 * under a home directory spelled every way a command can spell it.
 */
const PROJECT_AGENT_SETTINGS_GLOB_PATHS: readonly string[] = [
  ".claude", ".claude/settings.json", ".claude/settings.local.json",
  ".codex", ".codex/hooks.json", ".codex/config.toml",
  ".cursor", ".cursor/hooks.json",
  ".github/hooks", ".github/hooks/failproofai.json",
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
 * a pattern also lands on — and the ordinary siblings of the agent directories
 * that live inside a shared parent, so a sweep of `~/.config` or `.github`
 * reads as the sweep it is. Agents' own directories get no siblings here: a
 * glob over `~/.claude` IS aimed at the settings inside it.
 */
const AGENT_SETTINGS_GLOB_DECOY_PATHS: readonly string[] = [
  "src/settings.json", "config/hooks.json", "app/config.toml", "deploy/config.yaml",
  "lib/plugins/index.mjs", "projects", "docs",
  ".config/git", ".config/gh", ".config/nvim", ".github/workflows",
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
 * it are reachable by a bare `*.json`, so their names join the list.
 */
export function agentSettingsGlobCandidates(cwd: string | undefined): string[] {
  const candidates = [...PROJECT_AGENT_SETTINGS_GLOB_PATHS, ...underEveryAgentSettingsHome(HOME_AGENT_SETTINGS_GLOB_PATHS)];
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

/** Decoys for those candidates, in the same spellings. */
export function agentSettingsGlobDecoys(): string[] {
  return [...AGENT_SETTINGS_GLOB_DECOY_PATHS, ...underEveryAgentSettingsHome(AGENT_SETTINGS_GLOB_DECOY_PATHS)];
}
