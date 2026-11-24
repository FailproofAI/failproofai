/**
 * Built-in security policies for Claude Code hooks.
 */
import { resolve, join } from "node:path";
import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type {
  BuiltinPolicyDefinition,
  PolicyContext,
  PolicyFunction,
  PolicyResult,
} from "./policy-types";
import { POLICY_CATALOG } from "./policy-catalog";
import { allow, deny, instruct } from "./policy-helpers";
import { normalizePolicyName, registerPolicy } from "./policy-registry";
import { hookLogWarn } from "./hook-logger";
import {
  agentCliSwitchesHooksOff,
  agentSettingsGlobCandidates,
  agentSettingsGlobDecoys,
  agentSettingsShellCwd,
  agentSettingsShellMatcher,
  agentSettingsWriteTarget,
  programNamesAgentSettings,
} from "./agent-settings-guard";

/**
 * Whether `resolved` lives under an agent CLI's home directory
 * (~/.claude/, ~/.codex/, ~/.copilot/, ~/.cursor/, ~/.pi/, ~/.gemini/, or any
 * of OpenCode's three home-side dirs). Used to whitelist agent self-reads of
 * their own config and transcripts.
 *
 * OpenCode splits its data across three locations (verified live on
 * opencode v1.14.33 via `opencode debug paths`):
 *   • ~/.config/opencode/   — config + plugins
 *   • ~/.local/share/opencode/ — sessions, snapshots, opencode.db (SQLite)
 *   • ~/.opencode/          — legacy fallback path
 */
function isAgentInternalPath(resolved: string): boolean {
  // Normalize backslashes to forward slashes so the same `startsWith` check
  // works on Windows. `resolve()` returns forward slashes on POSIX but
  // backslashes on Windows; `join(homedir(), ...)` follows the same OS
  // convention. Comparing both sides under a single forward-slash form
  // avoids per-OS branching.
  const normResolved = resolved.replaceAll("\\", "/");
  for (const dir of [".claude", ".codex", ".copilot", ".cursor", ".opencode", ".pi", ".gemini"]) {
    const root = join(homedir(), dir).replaceAll("\\", "/");
    if (normResolved === root || normResolved.startsWith(root + "/")) return true;
  }
  for (const sub of [join(".config", "opencode"), join(".local", "share", "opencode")]) {
    const root = join(homedir(), sub).replaceAll("\\", "/");
    if (normResolved === root || normResolved.startsWith(root + "/")) return true;
  }
  return false;
}

/**
 * Whether `resolved` is a settings/hooks file for an agent CLI:
 *   • Claude Code:  `.claude/settings.json`, `.claude/settings.local.json`, etc.
 *   • Codex:        `.codex/hooks.json`
 *   • Copilot CLI:  `.copilot/hooks/*.json`, `.github/hooks/*.json`
 *   • Cursor Agent: `.cursor/hooks.json`
 *   • OpenCode:     `.opencode/opencode.{json,jsonc}`,
 *                   `.opencode/plugins/*.{mjs,js,ts}`,
 *                   `~/.config/opencode/{opencode.json,opencode.jsonc,config.json}`,
 *                   `~/.config/opencode/plugins/*.{mjs,js,ts}`
 *   • Pi:           `.pi/settings.json` (project) and `.pi/agent/settings.json`
 *                   (user); also the Pi-managed extension dir
 *                   `.pi/extensions/` / `.pi/agent/extensions/`.
 *   • Antigravity CLI (agy): reuses `~/.gemini/` — `~/.gemini/settings.json`
 *                   and the customization-root hook config
 *                   `~/.gemini/config/hooks.json`.
 * These must NEVER be edited by the agent itself — that would let it disable
 * its own protections. `block-read-outside-cwd` refuses READS of this list;
 * writes are refused by `block-failproofai-commands`, against the wider list
 * in agent-settings-guard.ts that covers all eleven integrations.
 */
function isAgentSettingsFile(resolved: string): boolean {
  if (/[\\/]\.claude[\\/]settings(?:\.[^/\\]+)?\.json$/.test(resolved)) return true;
  if (/[\\/]\.codex[\\/]hooks\.json$/.test(resolved)) return true;
  if (/[\\/]\.copilot[\\/]hooks[\\/][^/\\]+\.json$/.test(resolved)) return true;
  if (/[\\/]\.github[\\/]hooks[\\/][^/\\]+\.json$/.test(resolved)) return true;
  if (/[\\/]\.cursor[\\/]hooks\.json$/.test(resolved)) return true;
  // OpenCode: project config + plugins, user config + plugins, legacy config.
  if (/[\\/]\.opencode[\\/]opencode\.jsonc?$/.test(resolved)) return true;
  if (/[\\/]\.opencode[\\/]plugins[\\/][^/\\]+\.(?:mjs|js|ts)$/.test(resolved)) return true;
  if (/[\\/]\.config[\\/]opencode[\\/]opencode\.jsonc?$/.test(resolved)) return true;
  if (/[\\/]\.config[\\/]opencode[\\/]config\.json$/.test(resolved)) return true;
  if (/[\\/]\.config[\\/]opencode[\\/]plugins[\\/][^/\\]+\.(?:mjs|js|ts)$/.test(resolved)) return true;
  // Pi: settings + extensions dirs (project and user-scope variants).
  if (/[\\/]\.pi[\\/](?:agent[\\/])?settings\.json$/.test(resolved)) return true;
  if (/[\\/]\.pi[\\/](?:agent[\\/])?extensions[\\/]/.test(resolved)) return true;
  // Antigravity (agy) reuses ~/.gemini/: settings.json + the customization-root hooks.json.
  if (/[\\/]\.gemini[\\/]settings\.json$/.test(resolved)) return true;
  if (/[\\/]\.gemini[\\/]config[\\/]hooks\.json$/.test(resolved)) return true;
  return false;
}

// Back-compat aliases — kept for any caller that imports the old names.
const isClaudeInternalPath = isAgentInternalPath;
const isClaudeSettingsFile = isAgentSettingsFile;

function getCommand(ctx: PolicyContext): string {
  return (ctx.toolInput?.command as string) ?? "";
}

function getFilePath(ctx: PolicyContext): string {
  return (ctx.toolInput?.file_path as string) ?? "";
}

/**
 * Parse a command string into argv tokens for safe pattern matching.
 * Splits on whitespace and strips simple single/double quotes.
 * Does not handle all shell syntax — sufficient for prefix-match allowlists.
 */
function parseArgvTokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""));
}

// Shell operators that always act as command separators when whitespace-delimited.
const SHELL_OPERATORS = new Set(["&&", "||", "|", ";"]);

// Shell metacharacters that are unsafe when embedded inside a token. Any command
// whose argv contains one of these in a token is rejected before allowlist matching.
// This closes the bypass where operators are glued to a word (e.g. "nginx;evil" or
// "nginx&&evil") and would otherwise be invisible to the standalone-operator check.
// Note: | is intentionally excluded here because "foo|bar" is a valid grep/sed
// argument value; the standalone-operator check above already handles bare "|" tokens.
const SHELL_METACHAR_RE = /[;&<>`$()\\]/;

// -- Pre-compiled regex constants (hoisted to avoid per-call allocation) --

// sanitizeJwt
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

// sanitizeApiKeys
const API_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9\-_]{20,}/, "Anthropic API key"],
  [/sk-proj-[A-Za-z0-9\-_]{20,}/, "OpenAI project API key"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI API key"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub personal access token"],
  [/github_pat_[A-Za-z0-9_]{82}/, "GitHub fine-grained token"],
  [/AKIA[A-Z0-9]{16}/, "AWS access key ID"],
  [/sk_live_[A-Za-z0-9]{24,}/, "Stripe live secret key"],
  [/sk_test_[A-Za-z0-9]{24,}/, "Stripe test secret key"],
  [/AIza[0-9A-Za-z\-_]{35}/, "Google API key"],
];

// sanitizeConnectionStrings
const CONNECTION_STRING_RE = /(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|amqps?|smtps?):\/\/[^@\s]+@/;

// sanitizePrivateKeyContent
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;

// sanitizeBearerTokens
const BEARER_TOKEN_RE = /Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}/i;

/**
 * Every pattern the `sanitize-*` policies treat as a secret, as one list.
 *
 * Exported so the audit's harm reporter can redact against the SAME definition
 * of "secret" that the engine blocks on, rather than growing a second pattern
 * list beside this one. Two lists is the shape that eventually disagrees, and
 * the direction it disagrees in here is a live credential leaving a machine.
 *
 * The `sanitize-*` FUNCTIONS cannot be reused for this — they are detectors that
 * return a `deny` with a message, not transforms that return scrubbed text. The
 * patterns are the reusable part, so the patterns are what is shared.
 *
 * Ordered most-specific first, which is load-bearing for the API keys: a
 * generic `sk-[A-Za-z0-9]{20,}` placed before `sk-ant-…` would label an
 * Anthropic key as an OpenAI one. (It does not currently MATCH one — the
 * hyphens in `sk-ant-` break the character class — but the ordering is what
 * makes that a design rather than a coincidence.)
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [PRIVATE_KEY_RE, "private key"],
  [JWT_RE, "JWT"],
  [BEARER_TOKEN_RE, "bearer token"],
  [CONNECTION_STRING_RE, "database credentials"],
  ...API_KEY_PATTERNS,
];

// warnDestructiveSql / warnSchemaAlteration
const SQL_TOOL_RE = /\b(?:psql|mysql|sqlite3|pgcli|clickhouse-client)\b/;
const DESTRUCTIVE_SQL_RE = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\b)/i;
const DELETE_NO_WHERE_RE = /\bDELETE\s+FROM\b/i;
const SQL_WHERE_RE = /\bWHERE\b/i;
const SCHEMA_ALTER_RE = /\bALTER\s+TABLE\b[\s\S]*\b(?:DROP\s+COLUMN|ADD\s+COLUMN|RENAME\s+(?:COLUMN|TO)|MODIFY\s+COLUMN)\b/i;

// warnPackagePublish
const PUBLISH_CMD_RE = /(?:npm\s+publish|bun\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|twine\s+upload|poetry\s+publish|cargo\s+publish|gem\s+push)\b/;

// protectEnvVars
const ENV_PRINTENV_RE = /(?:^|\s|;|&&|\|\|)(?:env|printenv)(?:\s|$|;|&&|\|)/;
const ECHO_ENV_RE = /echo\s+.*\$\{?[A-Za-z_]/;
const EXPORT_RE = /(?:^|\s|;|&&|\|\|)export\s+\w+/;
// The other whole-environment dumps: bare `set` / `export` / `export -p` in
// command position (`set -e`, `export FOO=bar` are not), `declare|typeset` with
// -x or -p (not `declare -a`), `compgen -v|-e`, and /proc/<pid>/environ.
const ENV_DUMP_RE =
  /(?:^|[;&|({\n`'"]|\$\()\s*(?:set|export(?:\s+-p)?)\s*(?:$|[|;&>)\n])|\b(?:declare|typeset)\s+-[A-Za-z]*[xp]|\bcompgen\s+-[A-Za-z]*[ev]|\/proc\/(?:self|thread-self|\d+|\$\$|\$BASHPID)\/environ/;
// A script dumping the environment OBJECT, not one variable of it. Two tests,
// both linear: an interpreter in the command, and the object used whole.
const SCRIPT_INTERP_RE = /\b(?:python[\d.]*|node|bun|deno)\b/;
const ENV_OBJECT_RE = /\bos\.environ(?!\s*\[|\.(?:get|setdefault|pop|update)\b)|\bprocess\.env(?![.\[\w])/;
const PS_ENV_VAR_RE = /\$env:[A-Za-z_]/i;
const PS_CHILDITEM_ENV_RE = /(?:Get-ChildItem|dir|gci|ls)\s+Env:/i;
const DOTNET_GETENV_RE = /\[Environment\]::GetEnvironment/i;
const CMD_ECHO_ENV_RE = /echo\s+%[A-Za-z_]/i;

// blockEnvFiles
const ENV_FILE_PATH_RE = /(?:^|[\\/])\.env(?:\.|$)/;
const ENV_CMD_RE = /\.env(?:\b|\s|$|\.)/;

// blockSudo
const PS_ELEVATION_RE = /Start-Process\s+.*-Verb\s+RunAs/i;
const RUNAS_RE = /(?:^|;|&&|\|\|)\s*runas\s/i;

// blockCurlPipeSh
const CURL_PIPE_SH_RE = /(?:curl|wget)\s.*\|\s*(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash)\b/;
/**
 * `failproofai config --pause` in any of its reachable spellings — direct, via
 * `npx`/`bunx`/`pnpm dlx`, by absolute path, or through the `configure`/`setup`
 * aliases the CLI normalizes. Only `--pause` matches: `--resume` and `--status`
 * restore or merely report enforcement, so an agent running either is harmless.
 *
 * Two details carry the whole policy, and an earlier version got both wrong:
 *
 * `failproofai[^\s]*` rather than `\bfailproofai\b`. A word boundary stops at
 * the character after the name, so every ordinary way of pinning or pathing the
 * binary walked straight through: `npx failproofai@latest`, `npx -y
 * failproofai@0.0.16`, `bunx failproofai@latest`, and
 * `node /usr/lib/node_modules/failproofai/bin/failproofai.mjs`. The suffix has
 * to be absorbed by the same token.
 *
 * `\s+--pause` rather than `\s--pause`. With a single `\s`, two spaces before
 * the flag — which no shell cares about and any agent may emit — did not match.
 *
 * This still raises the bar rather than closing the class: base64, a wrapper
 * script, an alias or a shell variable all still reach the same state. Closing
 * it properly means a pause cannot originate from a tool call at all.
 *
 * Matched against BOTH the raw command and its shell-unescaped form (see
 * `stripShellQuoting`), because a shell reconstructs the binary name from
 * fragments a regex over the raw string cannot see.
 *
 * ANCHORED ON COMMAND POSITION, which is the third thing an earlier version got
 * wrong and the most expensive: with no anchor, the pattern fired on any string
 * that merely CONTAINED the invocation, so `grep -rn "failproofai config
 * --pause" docs/`, `git commit -m "docs: explain failproofai config --pause"`,
 * `gh pr create --body "...failproofai config --pause"` and `git log --grep`
 * were all denied. This policy is `defaultEnabled`, and this repo's own
 * CHANGELOG and `docs/built-in-policies.mdx` contain that literal string, so
 * the first thing it did on a real machine was block someone reading the
 * documentation for it. Its sibling `FAILPROOFAI_CLI_RE` was anchored from the
 * start; this one was not.
 *
 * The distinction that matters is structural, not textual: in a real
 * invocation the binary sits where the shell will look for a COMMAND — first in
 * a segment, or behind a runner (`npx`, `pnpm dlx`, `node`, `sh -c`) and its
 * flags. In every false positive above it sits where an ARGUMENT goes.
 */

/**
 * Split a command into the pieces a shell would treat as separate commands.
 *
 * Includes `(`, `)` and backtick alongside the ordinary operators so that
 * command substitution — `echo $(failproofai config --pause)` — puts the inner
 * invocation in command position of its own segment rather than hiding it as an
 * argument of `echo`.
 */
const SEGMENT_SEPARATORS = /[;&|\n\r(){}`]+/;

/**
 * Tokens that stand in front of the real binary without being it: package
 * runners, interpreters, and the `exec`-alikes. Compared by basename, so
 * `/usr/bin/env` and `env` behave identically.
 */
const COMMAND_PREFIX_TOKENS = new Set([
  "npx", "bunx", "pnpx", "npm", "pnpm", "yarn", "dlx", "exec", "run", "eval",
  "node", "bun", "deno", "env", "command", "builtin", "nohup", "setsid",
  "time", "timeout", "nice", "stdbuf", "xargs", "sudo", "doas",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "ash",
]);

/** The binary itself, however it is pinned or pathed: `failproofai`,
 * `failproofai@latest`, `/usr/local/bin/failproofai`,
 * `./node_modules/.bin/failproofai`, `.../failproofai/bin/failproofai.mjs`. */
const SELF_BINARY_TOKEN_RE = /(?:^|\/)failproofai[^/]*$/;

/**
 * The same CLI, reached by path rather than by name.
 *
 * `node <pkg>/dist/cli.mjs config --pause` put `node` in command position, so
 * the walk above settled on a path the binary regex did not match — and it
 * paused enforcement. Verified as a live bypass.
 */
const SELF_ENTRY_PATH_RE = /failproofai\/(?:dist\/(?:cli|index)\.mjs|bin\/failproofai\.mjs)$/;

/** `config`, and the two aliases the entrypoint normalizes to it. */
const CONFIG_SUBCOMMAND_RE = /^(?:config|configure|setup)$/;

/** `--pause`, with or without an `=value` tail. */
const PAUSE_FLAG_RE = /^--pause(?:=|$)/;

/** An `FOO=bar` prefix assignment, which a shell consumes before the command. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A bare operand belonging to the runner in front of it — `timeout 30 …`,
 * `nice -n 5 …`. Skipped so the runner's argument is not mistaken for the
 * command. Safe to skip unconditionally: no binary is named `30` or `5m`.
 */
const RUNNER_OPERAND_RE = /^\d+[a-z]*$/i;

/**
 * True when `command` runs `failproofai config --pause` in command position.
 *
 * Residual false positive, deliberately accepted: a quoted argument that itself
 * contains a shell operator AND the whole invocation — `git commit -m "x;
 * failproofai config --pause"` — survives `stripShellQuoting` as two segments
 * and denies. That is a far narrower miss than matching every mention, and it
 * errs toward refusing rather than toward silently suspending enforcement.
 */
type SelfInvocation = "pause" | "cli";

/**
 * Classify a command by what it does to failproofai itself, or null when it
 * does nothing to failproofai at all.
 *
 * `pause` outranks `cli` wherever both appear, because the pause verdict is the
 * one whose message has to explain that suspending enforcement is a human call.
 */
function classifySelfInvocation(raw: string): SelfInvocation | null {
  // `${X}` before anything else looks at it: braces are SEGMENT SEPARATORS, so
  // the reference was being split into `$` and `X` and matched nothing, while
  // the shell ran it perfectly well.
  const command = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "$$$1");
  let found: SelfInvocation | null = null;
  // Variables assigned the binary earlier in the SAME command.
  //
  // `x=failproofai; $x config --pause` put `$x` in command position, matched
  // nothing, and paused enforcement — verified as a live bypass. A shell would
  // have to be re-implemented to resolve this in general; what is cheap and
  // covers the actual trick is remembering what was assigned right here.
  const selfVars = new Set<string>();
  for (const [, name, value] of command.matchAll(/(?:^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    const bare = value.replace(/^["']|["']$/g, "");
    if (SELF_BINARY_TOKEN_RE.test(bare) || SELF_ENTRY_PATH_RE.test(bare)) selfVars.add(name);
  }
  const isSelfVarRef = (token: string): boolean => {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(token);
    return m ? selfVars.has(m[1]) : false;
  };
  for (const segment of command.split(SEGMENT_SEPARATORS)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    // Walk off everything a shell resolves before it settles on the command:
    // prefix assignments, redirections, runner flags, and the runners.
    while (i < tokens.length) {
      const token = tokens[i];
      const isSkippable =
        ENV_ASSIGNMENT_RE.test(token) ||
        token.startsWith("-") ||
        token.startsWith(">") ||
        token.startsWith("<") ||
        RUNNER_OPERAND_RE.test(token) ||
        COMMAND_PREFIX_TOKENS.has(token.slice(token.lastIndexOf("/") + 1));
      if (!isSkippable) break;
      i++;
    }
    if (i >= tokens.length) continue;
    if (
      !SELF_BINARY_TOKEN_RE.test(tokens[i]) &&
      !SELF_ENTRY_PATH_RE.test(tokens[i]) &&
      !isSelfVarRef(tokens[i])
    ) {
      continue;
    }

    // The binary IS the command here. `config … --pause` is singled out only for
    // its message; every other subcommand is denied just the same.
    const args = tokens.slice(i + 1);
    const configAt = args.findIndex((a) => CONFIG_SUBCOMMAND_RE.test(a));
    if (configAt !== -1 && args.slice(configAt + 1).some((a) => PAUSE_FLAG_RE.test(a))) {
      return "pause";
    }
    found = "cli";
  }
  return found;
}

/**
 * Decode one ANSI-C `$'...'` body (the text between the quotes) to the bytes a
 * shell would produce. Covers the escape forms that can reconstruct an ASCII
 * identifier: `\xHH`, octal `\NNN`, `\uHHHH`, `\UHHHHHHHH`, and the named
 * controls. An out-of-range or malformed sequence is left as-is rather than
 * throwing — this runs on adversarial input and must never crash the hook.
 */
function decodeAnsiC(body: string): string {
  return body.replace(
    /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|.)/g,
    (_, seq: string) => {
      try {
        if (seq[0] === "x") return String.fromCharCode(parseInt(seq.slice(1), 16));
        if (seq[0] === "u" || seq[0] === "U") return String.fromCodePoint(parseInt(seq.slice(1), 16));
        if (/^[0-7]+$/.test(seq)) return String.fromCharCode(parseInt(seq, 8));
      } catch {
        return seq;
      }
      const named: Record<string, string> = {
        a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n",
        r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
      };
      return named[seq] ?? seq;
    },
  );
}

/**
 * Collapse the quoting a POSIX shell resolves LEXICALLY — before it execs a
 * command — so a literal matcher sees roughly what will actually run.
 *
 * Two adversarial red-team rounds defeated the pattern above by reassembling
 * the binary name from fragments the regex could not see: first backslash and
 * quote splitting (`fail\proofai`, `fail"proof"ai`, `f\a\i\l\p\r\o\o\f\a\i`),
 * then ANSI-C quoting (`$'fail\x70roofai'`, octal `\160`, unicode `p`).
 * Each executes the real pause. This now normalizes all three lexical forms:
 * ANSI-C `$'...'` bodies are decoded first (the generic backslash pass below
 * would otherwise turn `\x70` into `x70`), then surrounding single/double
 * quotes and lone backslash-escapes are removed.
 *
 * The boundary is principled, not arbitrary: everything handled here is pure
 * shell LEXING. What remains — a variable (`f=failproofai; $f …`), command
 * substitution (`$(printf failproofai)`), `eval`, an alias, a base64 pipe —
 * requires the shell to EXECUTE something to reconstruct the name, which no
 * PreToolUse hook inspecting a command string can follow. That class is the one
 * the header comment above calls out, and the only real closure is to make the
 * pause ACTION itself refuse to originate from a tool call — deferred with the
 * rest of the daemon-side redesign.
 */
function stripShellQuoting(command: string): string {
  // Line continuation FIRST. A shell deletes a backslash-newline pair entirely
  // and rejoins the fragments, so `fail\<newline>proofai` runs the real binary.
  // The generic `\(.)` strip below cannot catch it — JS `.` excludes newline —
  // so it has to be removed before that pass, or the fragments never join.
  // (A third red-team round rode exactly this in.) `\r?\n` also covers a
  // CRLF-joined line.
  const joined = command.replace(/\\\r?\n/g, "");
  // `$'...'` next, honoring `\'` inside the body, so its own escapes decode
  // before the generic backslash-strip can mangle them.
  const ansiDecoded = joined.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body: string) =>
    decodeAnsiC(body),
  );
  return ansiDecoded.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
}
const PS_WEB_PIPE_RE = /(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\s+.*\|\s*(?:Invoke-Expression|iex)/i;

// blockForcePush
const SHORT_FLAG_BUNDLE_RE = /^-[a-zA-Z]*f[a-zA-Z]*$/;
const SAFE_FORCE_PREFIXES = ["--force-with-lease", "--force-if-includes"] as const;

// blockSecretsWrite
const SECRET_FILE_RE = /\.(?:pem|key)$/;
const SECRET_FILE_ID_RSA_RE = /id_rsa/;
const SECRET_FILE_CREDENTIALS_RE = /credentials/;

// blockWorkOnMain
const GIT_COMMIT_MERGE_RE = /git\s+(commit|merge|rebase|cherry-pick)\b/;

// blockFailproofaiCommands
/**
 * A command that removes or moves failproofai's own state.
 *
 * Named separately from the binary walk because it never mentions the binary:
 * the target is a path, and the verb is an ordinary file command.
 */
const FAILPROOFAI_STATE_PATH_RE = /\.failproofai(?:\/|\b)/;

/**
 * Everything the state guard is allowed to let PAST, as a list of commands that
 * can only read.
 *
 * This is the third shape of this check, and the first that is an allowlist.
 * The first was one verb-then-path regex,
 * `\b(?:rm|unlink|shred|mv|truncate)\b[^;&|]*\.failproofai` — `find
 * ~/.failproofai -delete` names none of those words and walked straight
 * through the one guard that cannot be switched off. The second kept the
 * blocklist shape and added the verbs that miss implied (`find -delete`,
 * `-exec`, `dd`, `tee`, redirects, `--delete`), which left
 * `python3 -c 'shutil.rmtree(...)'`, `perl -e 'rmtree(...)'`,
 * `node -e 'fs.rmSync(...)'`, `git clean -xdff`, `sed -i`, `gio trash`,
 * `install /dev/null`, `tar --overwrite` and `chmod 000` all still open — and
 * `cp /dev/null <path>`, which its own doc comment claimed was covered and
 * which the regex never mentioned.
 *
 * A blocklist of destructive verbs cannot be finished: every interpreter on the
 * machine is one more verb. This list can be, because the reasons to point a
 * command at `~/.failproofai` at all are few and all of them read. So the
 * direction is inverted, and the failure modes go with it: a name missing from
 * a blocklist silently disables enforcement and nothing reports it, while a
 * name missing from THIS list denies a command an operator can see and file a
 * bug about. For the one guard nobody can switch off, take the visible failure.
 */
const STATE_READ_COMMANDS = new Set([
  // Contents
  "cat", "bat", "less", "more", "head", "tail", "nl", "strings", "xxd", "od",
  "jq", "yq", "diff", "cmp", "wc", "sort", "uniq", "column", "awk", "cut",
  // Listing and metadata
  "ls", "dir", "tree", "stat", "file", "du", "df", "readlink", "realpath",
  "basename", "dirname", "pwd", "test", "find",
  // Search
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  // Integrity
  "md5sum", "sha1sum", "sha256sum", "shasum", "cksum",
  // Navigation, which moves no bytes on its own
  "cd", "pushd", "popd",
  // Copy-family: a read only when the state is the SOURCE — see COPY_COMMANDS
  "cp", "rsync", "install", "tee",
  // Editors-as-readers and no-ops
  "sed", "true", "false", ":", "echo", "printf",
  // Shell grammar. `[ -f ~/.failproofai/policies-config.json ]` and
  // `for f in ~/.failproofai/*` are not commands that touch anything — a loop
  // header only expands words, and a test only stats. They were reaching the
  // unknown-head branch and denying, which is how an always-on guard starts
  // blocking the ordinary way of checking whether the state is there.
  "[", "[[", "]", "]]", "test", "read", "for", "select", "case", "done", "fi", "esac",
]);

/**
 * Shell keywords that stand in FRONT of a real command.
 *
 * Skipped like a runner, so `do rm -rf "$f"` is judged as the `rm` it is
 * rather than as an unknown head called `do`. That cuts both ways and both are
 * wanted: `do cat "$f"` stops denying, and `until rm -rf ~/.failproofai` stops
 * relying on `until` being unrecognised.
 */
const SHELL_KEYWORD_PREFIXES = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);

/**
 * A loop header, which hands its word list to the body that follows.
 *
 * `find ~/.failproofai -type f | while read f; do rm "$f"; done` names the
 * state only in the header — every `;` after it starts a pipeline with nothing
 * failproofai-shaped in it, so the body was judged against a path it never
 * mentions. The header's reach has to carry into the body, and stop at `done`.
 */
const LOOP_HEADER_RE = /(?:^|[\s(])(?:while|until|for|select)\s/;

/**
 * Commands whose verdict depends on which END of the argument list the state
 * path sits at.
 *
 * `cp -r ~/.failproofai /tmp/backup` is how somebody preserves the state before
 * touching it; `cp /dev/null ~/.failproofai/policies-config.json` is how
 * somebody empties a file without ever naming `rm`. The tool is the same and
 * only the destination separates them, so the destination is what decides.
 */
const COPY_COMMANDS = new Set(["cp", "rsync", "install"]);

/**
 * Commands that write EVERY path operand they are given.
 *
 * `tee` was an unknown head, so it denied wherever it appeared — including
 * `cat ~/.failproofai/policies-config.json | tee /tmp/out.json`, which is a
 * read with a transcript. What decides is the same thing that decides for the
 * copy family: which end of the pipe the state sits on.
 */
const OPERAND_WRITE_COMMANDS = new Set(["tee"]);

/**
 * Readers whose LAST operand is an output file rather than another input.
 *
 * `uniq /dev/null ~/.failproofai/policies-config.json` and
 * `xxd -r -p /tmp/hex ~/.failproofai/policies-config.json` both empty the
 * config while sitting in the read allowlist. One operand is still a read, so
 * `xxd ~/.failproofai/policies-config.json | head` stays allowed.
 */
const SECOND_OPERAND_WRITERS = new Set(["uniq", "xxd"]);

/**
 * Readers that write to a file NAMED BY A FLAG, per command.
 *
 * `sort -o` is the shape that matters: an allowlisted reader that takes its
 * destination as an option, so nothing about its head or its operand order
 * says it is writing. `curl` is here rather than treated as a pure mention
 * command because `curl -o ~/.failproofai/policies-config.json <url>` replaces
 * the config with whatever a server returns.
 */
const OUTPUT_FLAG_COMMANDS: Record<string, readonly string[]> = {
  sort: ["-o", "--output"],
  tree: ["-o", "--output"],
  curl: ["-o", "--output", "--output-dir", "-D", "--dump-header", "--trace", "--trace-ascii"],
  // `git log --output=<file>` writes whatever `--format` says into it; `-o` is
  // only an output for `archive` and `format-patch`, which the git branch checks.
  git: ["--output", "--output-directory"],
  // `gh release download -O <file>`, `gh run download -D <dir>`.
  gh: ["-O", "--output", "-D", "--dir"],
};

/**
 * `find` actions that write a file of their own, as opposed to running one.
 *
 * `find /etc -fprint ~/.failproofai/policies-config.json` truncates the config
 * without touching the state directory at all — the state is the *report*
 * target, and `find` is on the read allowlist.
 */
const FIND_WRITE_ACTIONS = new Set(["-fprint", "-fprint0", "-fprintf", "-fls"]);

/**
 * Commands safe to hand a matched path to from `find -exec`.
 *
 * Deliberately NARROWER than `STATE_READ_COMMANDS`: the copy family and `sed`
 * are reads only because of where their operands sit, and `-exec` decides that
 * for them — `find ~/.failproofai -type f -exec cp /dev/null {} \;` and
 * `-exec sed -i …` empty every file in the state through two names that were
 * both on the allowlist. `find` itself is excluded for the same reason
 * (`-exec find {} -delete \;`).
 */
const SAFE_EXEC_COMMANDS = new Set([
  "cat", "bat", "head", "tail", "nl", "strings", "xxd", "od", "jq", "yq", "wc",
  "ls", "stat", "file", "du", "readlink", "realpath", "basename", "dirname",
  "grep", "egrep", "fgrep", "rg", "md5sum", "sha1sum", "sha256sum", "shasum",
  "cksum", "echo", "printf", "true", ":",
]);

/**
 * `git` subcommands that rewrite or delete a working tree.
 *
 * `git` is otherwise treated as carrying a path as PROSE — `git commit -m
 * "document ~/.failproofai layout"` must not deny — but `git clean -xdff
 * .failproofai` deletes the directory as thoroughly as `rm -rf` does.
 *
 * The second row moves or rewrites files too: `git mv .claude/settings.json x`
 * takes an agent's hooks away, `git -C ~/.claude pull` or `merge` or `switch`
 * replaces them with whatever another branch holds, `git apply` writes whatever
 * its patch says, and `git bundle create <file>` writes the file it is given.
 * These count only when an OPERAND names a protected path, the repository
 * (`-C`) is one, or the shell stands in one — never a message: `git merge
 * feature -m "notes about ~/.failproofai"` writes nothing there.
 */
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set([
  "clean", "rm", "restore", "checkout", "reset", "stash",
  "mv", "pull", "apply", "merge", "switch", "rebase", "am", "cherry-pick", "revert", "bundle",
]);

/**
 * The options whose value is a message (or a parent number), per destructive
 * subcommand. Per subcommand because `-m` means something else elsewhere:
 * `--merge` to `checkout`, `switch`, `restore` and `rebase`, `--message-id`
 * to `am` — skipping its "value" there would skip the path.
 */
const GIT_MESSAGE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  merge: new Set(["-m", "--message", "-F", "--file"]),
  stash: new Set(["-m", "--message"]),
  revert: new Set(["-m", "--mainline"]),
  "cherry-pick": new Set(["-m", "--mainline"]),
};

/**
 * Whether one of a git command's OPERANDS names the target: messages and
 * config values skipped, `-C`'s repository kept. Once quotes are gone (the
 * unescaped pass) a message is no longer one word, so it runs to the next
 * option instead.
 */
function gitOperandsNameTarget(
  gitWords: string[],
  subcommand: string,
  names: (text: string) => boolean,
  quoted: boolean,
): boolean {
  const messageOptions = GIT_MESSAGE_OPTIONS[subcommand] ?? new Set<string>();
  for (let i = 1; i < gitWords.length; i++) {
    const word = gitWords[i];
    if (word === "-c" || word === "--config-env") {
      i++;
      continue;
    }
    if (messageOptions.has(word)) {
      i++;
      if (!quoted) while (i + 1 < gitWords.length && !gitWords[i + 1].startsWith("-")) i++;
      continue;
    }
    if (messageOptions.size > 0 && (/^--(?:message|file|mainline)=/.test(word) || /^-m./.test(word))) continue;
    if (names(word)) return true;
  }
  return false;
}

/** The repository a git command runs in, from `-C <dir>`, when the text says. */
function gitRepositoryDir(gitWords: string[]): string | undefined {
  const at = gitWords.indexOf("-C");
  return at === -1 ? undefined : cdDestination(undefined, gitWords[at + 1]);
}

/**
 * `git -c` settings that make git run a command: an alias beginning `!`, a
 * pager, an editor, an ssh command, a filter or diff driver, a credential
 * helper. `git -c alias.x='!rm -rf ~/.claude' x` is a deleter wearing a mention
 * command's name.
 */
const GIT_CONFIG_RUNS_CODE_RE =
  /^['"]?(?:alias\.[^=]+=\s*['"]?!|core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass)=|(?:diff|merge|filter)\.[^=]*\.(?:command|textconv|driver|clean|smudge|process)=|credential\.[^=]*helper=|sequence\.editor=)/i;

/**
 * `git`'s own options that swallow the token after them.
 *
 * The subcommand is the first token that is not an option — but `git -c
 * core.x=1 -C ~/.failproofai clean -xdff` makes `core.x=1` the first such
 * token, so the walk settled on it, found no destructive subcommand, and let a
 * `git clean -xdff` of the state directory through.
 */
const GIT_FLAGS_WITH_OPERANDS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * Where the `git` subcommand sits in `args`, with git's own global options
 * walked off first, or `-1` when there is no subcommand at all.
 *
 * The index rather than the value, because a caller that wants to read the
 * SUBCOMMAND's flags (`warnGitClean`) needs to know where they start, and
 * `args.indexOf("clean")` would land on a `-C clean` operand instead.
 */
function gitSubcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (GIT_FLAGS_WITH_OPERANDS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** The `git` subcommand, with git's own global options walked off first. */
function gitSubcommand(args: string[]): string | undefined {
  const i = gitSubcommandIndex(args);
  return i < 0 ? undefined : args[i];
}

/**
 * Commands that take a path as text to record or print, not as a file to open.
 *
 * Without them the always-on guard denies an agent writing a commit message or
 * a PR body that names `~/.failproofai` — the same false positive the binary
 * half of this policy already had to be anchored to avoid.
 */
const STATE_MENTION_COMMANDS = new Set(["git", "gh", "glab", "echo", "printf", "curl", "code", "open"]);

/** `find` actions that hand the matched paths to an arbitrary command. */
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * The pieces a shell treats as SEPARATE commands.
 *
 * `|` is deliberately absent. A pipeline is one unit of work: `find
 * ~/.failproofai -print0 | xargs -0 rm -f` names the path on the left and the
 * verb on the right, and splitting there made each half look innocent. `;`,
 * `&&`, `||`, `&` and a newline do start a genuinely new command, which is what
 * keeps `cat ~/.failproofai/config.json && rm /tmp/scratch` allowed.
 */
const PIPELINE_SEPARATORS = /\|\||&&|[;\n\r&]+/;

/** A `$VAR` or `${VAR}` reference, wherever it sits. */
const VAR_REFERENCE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/**
 * The spellings of the state directory a glob would have to match.
 *
 * A glob is expanded by the shell, so `rm -rf ~/.failproof*` never contains the
 * literal — it was the cheapest bypass left standing, and cheap matters most
 * for the one guard that cannot be switched off. What can be decided from the
 * pre-expansion string is whether the pattern COULD land on the state, so the
 * pattern is compiled and tried against the paths it would have to hit.
 */
const STATE_GLOB_CANDIDATES = [
  ".failproofai",
  "~/.failproofai",
  "$HOME/.failproofai",
  "${HOME}/.failproofai",
  "/root/.failproofai",
  "/home/u/.failproofai",
  "/Users/u/.failproofai",
];

/**
 * Ordinary paths a targeted pattern must NOT be able to match.
 *
 * The floor a bare `*` has to fail. `rm -rf *` in a build directory compiles to
 * a regex that matches every state candidate, and denying it would make the one
 * guard nobody can switch off fire on the most ordinary command there is. A
 * pattern that also lands on `node_modules` or `.config` is not aimed at the
 * state; a pattern that lands on `.failproofai` and on none of these is.
 */
const GLOB_DECOYS = [
  ".config", ".cache", ".local", ".git", ".npm", ".ssh", ".bashrc",
  "node_modules", "dist", "build", "target", "coverage", "tmp", "src",
  "~/.config", "~/.cache", "$HOME/.config", "${HOME}/.cache",
  "/home/u/.config", "/Users/u/.config", "/root/.cache", "/tmp/build",
  "a", "foo.txt", "test-failures",
];

/**
 * True when this token is a glob that could expand onto the target — failproofai's
 * state, or an agent's settings files (see `ProtectedPathTarget`).
 *
 * The floor used to be a literal `fail` in the token, and that is exactly what
 * a glob is for: `rm -rf ~/.f*ailproofai` spells the same directory without the
 * substring anywhere in it, so the pattern was thrown out before it was ever
 * compiled. `.[f]ailproofai`, `.fa*lproofai`, `.fa[i]lproofai` and
 * `.f{a,b}ilproofai` all walked through the same hole.
 *
 * A substring cannot decide this, because the whole point of the metacharacter
 * is to stand where a letter was. What CAN decide it is the pattern's reach: it
 * has to hit the state and miss everything ordinary. So the floor is now
 * computed the same way the match is — compile once, require a candidate, and
 * reject anything that also catches a decoy. `rm -rf *` and `rm -rf ~/.*` stay
 * allowed because they sweep the decoys too; `rm -rf /tmp/test-failures*` stays
 * allowed because it reaches no candidate at all.
 */
function globCouldNameTarget(raw: string, target: ProtectedPathTarget): boolean {
  // Both readings of a trailing `)`: part of the pattern, and the close of a
  // subshell that wrapped it. Trying both is safe in the way widening always is
  // here — the decoy test still has to pass.
  const stripped = raw.replace(/^[()]+|[()]+$/g, "");
  return globWordCouldNameTarget(raw, target) || (stripped !== raw && globWordCouldNameTarget(stripped, target));
}

function globWordCouldNameTarget(token: string, target: ProtectedPathTarget): boolean {
  if (!GLOB_METACHAR_RE.test(token)) return false;
  // Braces FIRST, because that is the order the shell works in: brace expansion
  // rewrites the word into several words, and only then is each one matched
  // against the disk. Compiling `{a*,x}` as an alternation of escaped literals
  // put a literal `*` inside the pattern, so `~/.f{a*,x}ilproofai` — which the
  // shell turns into `~/.fa*ilproofai` and then into `~/.failproofai` — read as
  // naming nothing at all.
  for (const word of expandBraces(token)) {
    if (wordNamesTarget(word, target)) return true;
  }
  return false;
}

/**
 * How many words one token may expand into before the expansion is abandoned.
 *
 * `{a,b}{c,d}{e,f}…` multiplies, so this is bounded rather than trusted. A real
 * attempt needs a handful; anything past this is answered by the fallback in
 * `expandBraces`, which is a superset and so cannot hide anything.
 */
const BRACE_EXPANSION_LIMIT = 4096;

/**
 * How many expansion passes one token gets. One pass resolves the outermost
 * group of every word, so this is a nesting-depth budget — and, like the width
 * one, running out collapses what is left rather than leaving it unresolved.
 */
const BRACE_EXPANSION_ROUNDS = 24;

/**
 * The words a token expands into, the way the shell would expand them.
 *
 * When the product would exceed the limit, every brace group collapses to `*`
 * instead. That is a SUPERSET of what the braces could produce — it reaches at
 * least everything they reach — so an oversized token can still be recognised,
 * and is still held to the same decoy test that keeps `rm -rf *` allowed.
 */
function expandBraces(token: string): string[] {
  let words = [token];
  // Bounded on WORK, not on nesting depth. A round cap that returned its
  // half-expanded words handed a still-braced word to a compiler that escapes
  // braces as literals, so seventeen levels of `{x,{x,…{x,a*}…}}` — legal shell
  // with a branch that becomes `~/.fa*ilproofai` — came out matching nothing.
  // Running out of budget must never mean "unresolved", only "collapsed".
  for (let round = 0; round < BRACE_EXPANSION_ROUNDS; round++) {
    const next: string[] = [];
    let expanded = false;
    for (const word of words) {
      const group = firstBraceGroup(word);
      if (!group) {
        next.push(word);
        continue;
      }
      expanded = true;
      for (const alternative of group.alternatives) {
        next.push(word.slice(0, group.start) + alternative + word.slice(group.end + 1));
      }
    }
    if (!expanded) return next;
    if (next.length > BRACE_EXPANSION_LIMIT) return [collapseBraces(token)];
    words = next;
  }
  return words.map(collapseBraces);
}

/**
 * Every brace group in a word replaced by `*`, innermost first.
 *
 * The answer whenever expansion is given up on, and safe to be the answer
 * because it can only WIDEN: `{a*,x}` reaches strictly less than `*` does. So a
 * token too deep or too wide to expand is still decided, and still has to pass
 * the same decoy test that keeps `rm -rf *` allowed. A brace left unmatched
 * becomes `*` too, on the same reasoning.
 */
function collapseBraces(word: string): string {
  let out = "";
  let depth = 0;
  for (const ch of word) {
    if (ch === "{") {
      // The OUTERMOST group, replaced whole. Resolving innermost-first needs one
      // pass per level, which is another depth budget and another way to run out
      // holding a word that still has braces in it. One pass, any depth.
      if (depth === 0) out += "*";
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** The first brace group in a word, split on its TOP-LEVEL commas. */
function firstBraceGroup(word: string): { start: number; end: number; alternatives: string[] } | null {
  const start = word.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  const alternatives: string[] = [];
  let current = "";
  for (let i = start; i < word.length; i++) {
    const ch = word[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        alternatives.push(current);
        return { start, end: i, alternatives };
      }
    } else if (ch === "," && depth === 1) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * True when one brace-expanded word names the state.
 *
 * The literal check comes first because expansion can PRODUCE the literal:
 * `~/.{failproofai,other}` carries no `.failproofai` as written, and the word it
 * expands to needs no glob compilation to be recognised.
 */
function wordNamesTarget(word: string, target: ProtectedPathTarget): boolean {
  if (target.namesLiteral(word)) return true;
  // Every path PREFIX, not just the whole word. The candidates are the state
  // directory itself, so `~/.f*ailproofai/policies-config.json` — a glob in a
  // segment that is not the last one — compiled to a pattern that could never
  // equal `~/.failproofai` and was read as naming nothing. Naming a file INSIDE
  // the state is naming the state.
  const segments = word.split("/");
  for (let end = 1; end <= segments.length; end++) {
    if (globPrefixNamesTarget(segments.slice(0, end).join("/"), target)) return true;
  }
  return false;
}

/**
 * Everything that makes a token a PATTERN rather than a path.
 *
 * The extended-glob operators are two characters wide, and three of them begin
 * with a character that means nothing on its own — which is how
 * `rm -rf ~/.f@(ailproofai)` was not even recognised as a glob, let alone
 * compiled wrong.
 */
const GLOB_METACHAR_RE = /[*?[{]|[@+!]\(/;

/**
 * A glob compiled to regex source, extended-glob operators included.
 *
 * `@(a|b)`, `?(a|b)`, `*(a|b)`, `+(a|b)` and `!(a|b)` are groups carrying a
 * quantifier, and their alternatives are patterns in their own right — so this
 * recurses rather than escaping whatever it finds inside them. `!(…)` is a
 * negation a regex cannot express against a whole path segment, so it becomes
 * `[^/]*`: a superset, which is the direction that stays safe here, because
 * reaching too far is settled by the decoy test and reaching too little is a
 * bypass.
 */
function compileGlobPattern(token: string): string {
  let pattern = "";
  for (let i = 0; i < token.length; i++) {
    const extended = extglobAt(token, i);
    if (extended) {
      pattern += extended.source;
      i = extended.end;
      continue;
    }
    const ch = token[i];
    if (ch === "*") pattern += "[^/]*";
    else if (ch === "?") pattern += "[^/]";
    else if (ch === "[") {
      const bracket = bracketExpressionAt(token, i);
      if (!bracket) {
        // An unclosed `[` is a literal `[` to the shell, so it is one here.
        // Bailing out would answer "names nothing" on the strength of a
        // malformed pattern — the same shape as a budget that returns instead
        // of collapsing.
        pattern += "\\[";
        continue;
      }
      pattern += bracket.source;
      i = bracket.end;
    } else pattern += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return pattern;
}

/** One `@(…)`-style group, with its alternatives compiled as patterns. */
function extglobAt(token: string, start: number): { source: string; end: number } | null {
  const operator = token[start];
  if (!"?*+@!".includes(operator) || token[start + 1] !== "(") return null;
  const alternatives: string[] = [];
  let current = "";
  let depth = 0;
  let i = start + 1;
  for (; i < token.length; i++) {
    const ch = token[i];
    if (ch === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        alternatives.push(current);
        break;
      }
    } else if (ch === "|" && depth === 1) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  // Unterminated, so the operator is an ordinary character rather than a group.
  if (i >= token.length) return null;
  if (operator === "!") return { source: "[^/]*", end: i };
  const body = alternatives.map((alternative) => compileGlobPattern(alternative)).join("|");
  const quantifier = operator === "?" ? "?" : operator === "*" ? "*" : operator === "+" ? "+" : "";
  return { source: `(?:${body})${quantifier}`, end: i };
}

/**
 * One shell bracket expression, translated into a JavaScript character class.
 *
 * Copying the shell's text into a regex verbatim reads two of its spellings
 * backwards. POSIX negates with `!`, so bash expands `~/.f[!b]ilproofai` onto
 * the state while JavaScript read `[!b]` as "either `!` or `b`" and matched
 * nothing — a one-character bypass of the guard nobody can switch off. And a
 * `]` in the FIRST position is a literal `]` rather than the end of the class,
 * so scanning for the next `]` closed `[]abc]` on the wrong character.
 *
 * Anything exotic — a POSIX class, a collating symbol, an equivalence class —
 * becomes `[^/]`, which matches any single character a path segment can hold
 * and so reaches at least as far as the original. Widening is safe here in a
 * way narrowing never is: the decoy test is what decides, and it is unchanged.
 */
function bracketExpressionAt(token: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let negated = false;
  if (token[i] === "!" || token[i] === "^") {
    negated = true;
    i++;
  }
  // A `]` here is content, not the terminator.
  let body = "";
  if (token[i] === "]") {
    body += "]";
    i++;
  }
  while (i < token.length && token[i] !== "]") {
    // `[:alpha:]`, `[.a.]` and `[=a=]` carry a `]` of their own, which closed
    // the class early and left a stray `]` matching as a literal.
    const inner = token[i] === "[" ? token[i + 1] : undefined;
    if (inner === ":" || inner === "." || inner === "=") {
      const close = token.indexOf(`${inner}]`, i + 2);
      if (close !== -1) {
        body += token.slice(i, close + 2);
        i = close + 2;
        continue;
      }
    }
    body += token[i];
    i++;
  }
  if (i >= token.length) return null;
  if (/\[[.=:]/.test(body)) return { source: "[^/]", end: i };
  // `\` and `]` are the two characters that would end or escape the class in
  // JavaScript; the rest of a bracket expression means the same in both.
  const escaped = body.replace(/[\\\]]/g, "\\$&");
  if (escaped.length === 0) return { source: "[^/]", end: i };
  return { source: `[${negated ? "^" : ""}${escaped}]`, end: i };
}

/**
 * One `/`-delimited prefix of a brace-expanded word, compiled and tried against
 * the candidates. Braces are already gone by here; an unmatched one is literal.
 */
/** One atom of a glob with no extended-glob groups. */
type GlobAtom = { kind: "char"; ch: string } | { kind: "one" } | { kind: "star" } | { kind: "class"; test: RegExp };

/**
 * A glob of literals, `?`, `*` and bracket expressions as atoms, or null when
 * it holds an extended-glob group (left to the regex path). Runs of `*`
 * collapse into one, as the shell reads them without globstar.
 */
function globAtoms(token: string): GlobAtom[] | null {
  const atoms: GlobAtom[] = [];
  for (let i = 0; i < token.length; i++) {
    if (extglobAt(token, i)) return null;
    const ch = token[i];
    if (ch === "*") {
      if (atoms[atoms.length - 1]?.kind !== "star") atoms.push({ kind: "star" });
    } else if (ch === "?") atoms.push({ kind: "one" });
    else if (ch === "[") {
      const bracket = bracketExpressionAt(token, i);
      if (!bracket) {
        atoms.push({ kind: "char", ch: "[" });
        continue;
      }
      atoms.push({ kind: "class", test: new RegExp(`^${bracket.source}$`) });
      i = bracket.end;
    } else atoms.push({ kind: "char", ch });
  }
  return atoms;
}

/**
 * Whether one path segment matches a segment's atoms, with no backtracking
 * beyond the last `*`: the classic greedy wildcard walk, O(atoms × length).
 * A regex built from many `*` backtracked through every way of splitting a
 * candidate between them — a 226-character word ran for over a minute.
 */
function globSegmentMatches(atoms: GlobAtom[], text: string): boolean {
  let a = 0;
  let t = 0;
  let starAtom = -1;
  let starText = 0;
  while (t < text.length) {
    const atom = atoms[a];
    if (atom && atom.kind === "star") {
      starAtom = a++;
      starText = t;
      continue;
    }
    if (
      atom &&
      (atom.kind === "one" || (atom.kind === "char" && atom.ch === text[t]) || (atom.kind === "class" && atom.test.test(text[t])))
    ) {
      a++;
      t++;
      continue;
    }
    if (starAtom === -1) return false;
    a = starAtom + 1;
    t = ++starText;
  }
  while (atoms[a]?.kind === "star") a++;
  return a === atoms.length;
}

/**
 * A matcher for a glob word against whole paths: segment by segment, since no
 * `*`, `?` or bracket expression matches `/`. Null when the word holds an
 * extended-glob group.
 */
function globMatcher(token: string): ((path: string) => boolean) | null {
  const segments = token.split("/").map((segment) => globAtoms(segment));
  if (segments.some((atoms) => atoms === null)) return null;
  return (path: string): boolean => {
    const parts = path.split("/");
    return parts.length === segments.length && parts.every((part, i) => globSegmentMatches(segments[i]!, part));
  };
}

function globPrefixNamesTarget(token: string, target: ProtectedPathTarget): boolean {
  if (!GLOB_METACHAR_RE.test(token)) return false;
  const matcher = globMatcher(token);
  if (matcher) {
    if (!target.globCandidates.some(matcher)) return false;
    return !target.globDecoys.some(matcher);
  }
  // Extended-glob groups go through a regex, with runs of `*` collapsed first.
  const pattern = "^" + compileGlobPattern(token.replace(/\*{2,}/g, "*"));
  let re: RegExp;
  try {
    re = new RegExp(pattern + "$");
  } catch {
    return false;
  }
  // V8 compiles a pattern on its first use, so one too large to compile throws
  // here, not at `new RegExp`. A pattern that large is a literal far longer
  // than any path it could be tried against.
  try {
    if (!target.globCandidates.some((candidate) => re.test(candidate))) return false;
    return !target.globDecoys.some((decoy) => re.test(decoy));
  } catch {
    return false;
  }
}

/**
 * Every command-substitution body in a command, `$(…)` and backticked alike.
 *
 * A substitution runs its contents as a command of its own, so
 * `echo $(rm -rf ~/.failproofai)` deletes the state while presenting `echo` —
 * a mention command — as the head. Splitting on parentheses instead would have
 * cost the opposite case: `rm -rf $(ls -d ~/.failproofai)` is a real delete
 * whose INNER command only reads, and the outer `rm` has to keep denying. So
 * the bodies are pulled out and judged as commands as well as, not instead of,
 * the whole string.
 */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < command.length; i++) {
    // A backslash makes the next character literal in every quoting context:
    // `\`` and `\$(` never start a substitution.
    if (command[i] === "\\") {
      i++;
      continue;
    }
    if (command[i] === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) break;
      bodies.push(command.slice(i + 1, close));
      i = close;
      continue;
    }
    // `$(…)`, and the process substitutions `>(…)` and `<(…)`, which run their
    // body as a command just the same: `echo x > >(tee <path>)`.
    if (!((command[i] === "$" || command[i] === ">" || command[i] === "<") && command[i + 1] === "(")) continue;
    let depth = 1;
    let j = i + 2;
    for (; j < command.length && depth > 0; j++) {
      if (command[j] === "(") depth++;
      else if (command[j] === ")") depth--;
    }
    if (depth === 0) bodies.push(command.slice(i + 2, j - 1));
    i = j - 1;
  }
  return bodies;
}

/** An output redirect and the token it targets: `>f`, `> f`, `2>f`, `>>f`, `>|f`. */
const REDIRECT_TARGET_RE = /\d*>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;

/**
 * Strip the punctuation a shell consumes, so `(cd` reads as `cd`.
 *
 * Quotes come off for the same reason the brackets do, and they are the pair
 * that mattered: `bash -c 'cat ~/.failproofai/policies-config.json'` presented
 * a head of `'cat`, which is on no allowlist, so the guard denied a plain read
 * of the config through the most ordinary wrapper there is. Stripping them
 * cannot let a deleter past — `"rm"` unquotes to `rm`, which is still not a
 * reader.
 */
function bareToken(token: string): string {
  return token.replace(/^[(){}'"]+|[(){}'"]+$/g, "");
}

/**
 * Quotes only, for the glob scan.
 *
 * `bareToken` also drops `(`, `)`, `{` and `}`, because a shell group and a
 * subshell write them around a command. Every one of those characters is ALSO
 * how a pattern is spelled, and both spellings end the token with one: a brace
 * expansion (`~/.{fail*,zz}`) and an extended glob (`~/.f@(ailproofai)`) each
 * arrived here decapitated — an unterminated group that expands to nothing and
 * compiles to a pattern matching nothing. A closing character that really did
 * belong to a shell group leaves a word still carrying the literal path, which
 * the literal check reads, and `globCouldNameTarget` tries the stripped form too.
 */
function unquotedToken(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, "");
}

/** The name a shell would exec, given a token: `/usr/bin/rm` → `rm`. */
function commandBasename(token: string): string {
  const bare = bareToken(token);
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/**
 * Walk off everything a shell resolves before it settles on the command word,
 * and return the tokens from the command word on. Mirrors the walk in
 * `classifySelfInvocation` — the same prefixes hide a deleter that hid the
 * binary, and `xargs -0 rm -f` is the one that matters most here.
 */
function commandWords(simpleCommand: string): string[] {
  const tokens = simpleCommand.trim().split(/\s+/).map(bareToken).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // A redirect operator and, when it stands alone, the token it targets —
    // `> file` must not leave `file` sitting where the command word goes.
    if (/^\d*(?:>{1,2}\|?|<{1,3})/.test(token)) {
      i += /^\d*(?:>{1,2}\|?|<{1,3})$/.test(token) ? 2 : 1;
      continue;
    }
    const skippable =
      ENV_ASSIGNMENT_RE.test(token) ||
      token.startsWith("-") ||
      RUNNER_OPERAND_RE.test(token) ||
      SHELL_KEYWORD_PREFIXES.has(token) ||
      COMMAND_PREFIX_TOKENS.has(commandBasename(token));
    if (!skippable) break;
    i++;
  }
  return tokens.slice(i);
}

/**
 * True when this one simple command would destroy whatever it is pointed at.
 *
 * Reached only for a command that already names the protected target, so the
 * question is narrow: is this a read, or is it everything else.
 */
function simpleCommandDestroys(
  words: string[],
  namesState: (text: string) => boolean,
  target: ProtectedPathTarget,
  rawSimple: string,
  cwdInTarget = false,
): boolean {
  if (words.length === 0) return false;
  const head = commandBasename(words[0]);
  const args = words.slice(1);

  // `find` is a read until one of its ACTIONS turns it into something else.
  // `-delete` is the miss that started all of this; `-exec` runs anything at
  // all, so it is judged by the command it hands the paths to, and an
  // unrecognised one is treated as destructive rather than waved through.
  if (head === "find") {
    if (args.some((a) => a === "-delete")) return true;
    // `-fprint <file>` and its siblings truncate the file they report INTO, so
    // `find /etc -fprint ~/.failproofai/policies-config.json` empties the config
    // while never descending into the state at all.
    if (args.some((a) => FIND_WRITE_ACTIONS.has(a))) return true;
    // EVERY `-exec`, not the first: `find … -exec cat {} + -o -exec rm {} +`
    // put a read in front of the deleter and walked past a findIndex.
    return args.some(
      (a, i) => FIND_EXEC_ACTIONS.has(a) && !SAFE_EXEC_COMMANDS.has(commandBasename(args[i + 1] ?? "")),
    );
  }

  // `sed -i` edits in place — and so does the `w` command inside a script,
  // which needs no flag at all: `sed 's/a/b/w <state>' /etc/hosts` writes the
  // state without `-i` anywhere on the line.
  if (head === "sed") {
    // In place, alone or bundled: `-i`, `-i.bak`, `-Ei`, `-ni`, `--in-place`.
    if (args.some((a) => /^-(?!-)[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) return true;
    // Only the SCRIPT is read for `e`, `w` and `W`. Reading every word made a
    // file operand under `/workspaces/…` or `/Users/Wei/…` look like a `w`
    // command. A script read from a file (`-f`) cannot be checked at all.
    const scripts = sedScripts(rawSimple);
    if (scripts === null) return true;
    for (const script of scripts) {
      // `e` runs a shell command, as a command (`1e cp …`) or as the flag on
      // `s` (`s/x/y/e`), so a sed that reads nothing can still write anything.
      if (SED_RUNS_COMMAND_RE.test(script)) return true;
      // `w`/`W` write the rest of the line's text as a file name, glued on
      // (`s/a/b/w<path>`) or after a space; an address can stand in front.
      for (const [, file] of script.matchAll(SED_WRITE_FILE_RE)) {
        if (namesState(file.trim())) return true;
      }
    }
    return false;
  }

  // `yq -i` rewrites the file it reads, and reads JSON as readily as YAML.
  if (head === "yq") {
    if (args.some((a) => /^-[A-Za-z]*i/.test(a) || /^--in-?place/.test(a))) return true;
  }

  // `awk` can run a shell (`system("rm -rf …")`) or pipe into one, so its
  // program has to be read for those two, not just for the `>` the redirect
  // scan already catches.
  if (head === "awk" || head === "gawk" || head === "mawk") {
    // gawk's `inplace` extension rewrites every input file, loaded by flag
    // (`-i inplace`, `--include=inplace`) or from the program (`@include`).
    const inplace = args.some(
      (a, i) =>
        ((a === "-i" || a === "--include" || a === "@include") && /^inplace/.test(args[i + 1] ?? "")) ||
        /^(?:-iinplace|--include=inplace)/.test(a),
    );
    if (inplace || args.some((a) => /system\s*\(|\|\s*["']|\|&/.test(a))) return true;
    // `print > ARGV[1]` writes a file the program names only at run time, so
    // the redirect scan finds nothing to read. A program that prints AND holds
    // a `>` is treated as writing; a comparison beside a print is the cost.
    // String literals come out first, so a `}` or a `>` inside one neither ends
    // the statement nor counts as a redirect; a comparison BEFORE the print
    // (`$2 > 1 {print $1}`) is not one either.
    return quoteAwareWords(rawSimple).some((w) =>
      /\bprintf?\b[^;}\n]*>/.test(w.replace(/"(?:[^"\\]|\\.)*"/g, '""')),
    );
  }

  // `rg --pre <cmd>` runs a command over every file it searches.
  if ((head === "rg" || head === "ripgrep") && args.some((a) => a === "--pre" || a.startsWith("--pre="))) return true;

  // Copying the state OUT is a backup. Copying anything ONTO it — classically
  // `/dev/null` — empties it without naming a delete verb. The destination is
  // the last operand, unless `-t` names it instead: `cp -t ~/.failproofai
  // /dev/null` puts the destination FIRST and left the last operand innocent.
  if (COPY_COMMANDS.has(head)) {
    // `rsync --remove-source-files` deletes what it just copied, so the state
    // being the SOURCE — the shape that makes every other copy a backup — is
    // what makes this one a move.
    if (args.includes("--remove-source-files") && args.some((a) => namesState(a))) return true;
    // `cp -l` and `cp -s` make a hard or symbolic link instead of a copy, so
    // the protected file as SOURCE gets a second name that any later write
    // reaches it through: `cp -l ~/.claude/settings.json /tmp/x; echo … > /tmp/x`.
    const links = args.some((a) => /^-(?!-)[A-Za-z]*[ls]/.test(a) || a === "--link" || a === "--symbolic-link");
    if (head === "cp" && links && args.some((a) => !a.startsWith("-") && namesState(a))) return true;
    const targetAt = args.findIndex((a) => a === "-t" || a === "--target-directory");
    if (targetAt !== -1 && namesState(args[targetAt + 1] ?? "")) return true;
    if (args.some((a) => a.startsWith("--target-directory=") && namesState(a))) return true;
    const operands = args.filter((a) => !a.startsWith("-"));
    const destination = operands[operands.length - 1];
    return destination !== undefined && namesState(destination);
  }

  // `tee` writes every operand it is given and reads none of them.
  if (OPERAND_WRITE_COMMANDS.has(head)) {
    return args.some((a) => !a.startsWith("-") && namesState(a));
  }

  // `uniq INPUT OUTPUT` and `xxd IN OUT`: the second operand is written.
  if (SECOND_OPERAND_WRITERS.has(head)) {
    const operands = args.filter((a) => !a.startsWith("-"));
    return operands.length > 1 && namesState(operands[operands.length - 1]);
  }

  // `git` normally carries the path as prose in a message or a body.
  if (head === "git") {
    const subcommand = gitSubcommand(args);
    const gitWords = quoteAwareCommandWords(rawSimple).words;
    // A relative output path lands in the repository `-C` names.
    const repository = gitRepositoryDir(gitWords);
    const namesInRepository = (text: string): boolean =>
      namesState(text) || (repository !== undefined && isRelativeShellWord(text) && namesState(resolve(repository, text)));
    // Output files, whatever the subcommand: `git log --output=<file>` writes
    // what `--format` says into it, and `-o` is the archive's or the patches'.
    if (writesViaOutputFlag("git", args, namesInRepository)) return true;
    if ((subcommand === "archive" || subcommand === "format-patch") && writesViaOutputFlag("git", args, namesInRepository, ["-o"])) {
      return true;
    }
    // Config that runs a command, judged by what it runs: `alias.x='!rm …'`
    // is a deleter, `core.pager=cat` is not.
    if (gitWords.some((w, i) => (gitWords[i - 1] === "-c" || gitWords[i - 1] === "--config-env") && GIT_CONFIG_RUNS_CODE_RE.test(w) && namesState(w))) {
      return true;
    }
    // Subcommands that run a command of their own, with nothing to say what it touches.
    if (subcommand === "rebase" && args.some((a) => a === "-x" || a === "--exec" || a.startsWith("--exec=") || /^-(?!-)[A-Za-z]*x/.test(a))) {
      return true;
    }
    if ((subcommand === "submodule" && args.includes("foreach")) || (subcommand === "bisect" && args.includes("run"))) return true;
    if (subcommand === "filter-branch" || subcommand === "filter-repo") return true;
    if ((subcommand === "difftool" || subcommand === "mergetool") && args.some((a) => a === "-x" || a === "--extcmd" || a.startsWith("--extcmd="))) {
      return true;
    }
    // `git config` writes `.git/config`; only `-f <file>` writes elsewhere.
    if (subcommand === "config") {
      return gitWords.some((w, i) => ((gitWords[i - 1] === "-f" || gitWords[i - 1] === "--file") && namesInRepository(w)) ||
        (w.startsWith("--file=") && namesInRepository(w.slice("--file=".length))));
    }
    // `restore --staged` alone touches the index, never the file on disk.
    const staged = args.some((a) => a === "--staged" || /^-(?!-)[A-Za-z]*S/.test(a));
    const worktree = args.some((a) => a === "--worktree" || /^-(?!-)[A-Za-z]*W/.test(a));
    if (subcommand === "restore" && staged && !worktree) return false;
    if (subcommand === undefined || !GIT_DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) return false;
    return cwdInTarget || gitOperandsNameTarget(gitWords, subcommand, namesInRepository, /['"]/.test(rawSimple));
  }

  // A reader whose destination arrives as an option rather than as an operand.
  // Checked before the allowlist, or `sort -o <state> /dev/null` reads as the
  // `sort` it is named after.
  if (writesViaOutputFlag(head, args, namesState)) return true;

  if (STATE_READ_COMMANDS.has(head) || STATE_MENTION_COMMANDS.has(head)) return false;
  if (target.harmlessCommands?.has(head)) return false;
  return true;
}

/**
 * True when a flag on this command names the state as an output file.
 *
 * `sort -o`, `tree -o` and `curl -o` all take their destination as an option,
 * so nothing about the head or the operand order says they are writing — and
 * all three heads were on a list that said they only read. Short options bundle
 * (`curl -sfo <file>`), so the trailing letter is what decides — and a short
 * option can carry its value glued on (`sort -o<file>`, `curl -so<file>`).
 */
function writesViaOutputFlag(
  head: string,
  args: string[],
  namesState: (text: string) => boolean,
  flags: readonly string[] | undefined = OUTPUT_FLAG_COMMANDS[head],
): boolean {
  if (!flags) return false;
  const shortLetters = flags.filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const long = flags.find((f) => f.startsWith("--") && arg.startsWith(`${f}=`));
    if (long && namesState(arg.slice(long.length + 1))) return true;
    const bundled = /^-[A-Za-z]+$/.test(arg) && shortLetters.includes(arg[arg.length - 1]);
    if ((flags.includes(arg) || bundled) && namesState(args[i + 1] ?? "")) return true;
    if (/^-[A-Za-z]/.test(arg)) {
      for (const letter of shortLetters) {
        const glued = arg.indexOf(letter, 1);
        if (glued > 0 && /^[A-Za-z]*$/.test(arg.slice(1, glued)) && glued < arg.length - 1) {
          if (namesState(arg.slice(glued + 1))) return true;
        }
      }
    }
  }
  return false;
}

/**
 * What the shell walk below protects, so one walk serves two targets.
 *
 * It was written for failproofai's own state. An agent's settings and hook
 * files need exactly the same reading of a command — which end of a copy the
 * path sits on, whether `sed` has `-i`, where a variable or a `cd` carries the
 * path — so the walk takes its target as a parameter instead of existing twice.
 */
interface ProtectedPathTarget {
  /** Whether a word, a value or a whole pipeline names the target as written. */
  namesLiteral(text: string): boolean;
  /**
   * Whether a program handed to an interpreter names the target. Defaults to
   * `namesLiteral`; the settings target also reads directory names as string
   * literals, which is how programs build those paths.
   */
  namesProgram?(program: string): boolean;
  /** Paths a glob has to be able to reach to count as aimed at the target. */
  globCandidates: readonly string[];
  /** Ordinary paths a glob aimed at the target must miss. */
  globDecoys: readonly string[];
  /** Heads that cannot write or remove the target, beyond the shared read and mention lists. */
  harmlessCommands?: ReadonlySet<string>;
  /**
   * Where the shell starts, when it is known. A relative word is resolved
   * against it — and against wherever a `cd` moves it — so
   * `cd ~/.claude && cp /tmp/x settings.json` names the file it writes.
   */
  cwd?: string;
  /**
   * Text every one of the target's paths contains somewhere. A relative word
   * is resolved only when it, or the directory the shell stands in, could be
   * one; the rest of a long command is not worth a path resolution per word.
   */
  hint?: RegExp;
  /**
   * Whether a word leads to the target through a symlink (relative to `cwd`
   * when relative). Asked of every word, ahead of `hint`, which reads only text.
   */
  namesThroughLinks?(word: string, cwd: string | undefined): boolean;
}

/** failproofai's own state. Names, not copies, so widening any of them widens the walk. */
const FAILPROOFAI_STATE_TARGET: ProtectedPathTarget = {
  namesLiteral: (text) => FAILPROOFAI_STATE_PATH_RE.test(text),
  globCandidates: STATE_GLOB_CANDIDATES,
  globDecoys: GLOB_DECOYS,
  hint: /failproof/i,
};

/**
 * `mkdir` and `touch` create, and neither can overwrite or remove a settings
 * file — while an agent making `.claude/commands/` is ordinary work.
 */
const AGENT_SETTINGS_HARMLESS_COMMANDS: ReadonlySet<string> = new Set(["mkdir", "touch"]);

/**
 * Agents' settings and hook files (agent-settings-guard.ts), for a shell that
 * starts in `cwd`. `extraPaths` are settings files known for this session that
 * no shape describes (a config directory moved by `CLAUDE_CONFIG_DIR`).
 */
function agentSettingsShellTarget(cwd: string | undefined, extraPaths: readonly string[]): ProtectedPathTarget {
  const matcher = agentSettingsShellMatcher(extraPaths, cwd);
  return {
    namesLiteral: matcher.names,
    namesProgram: (program) => matcher.names(program) || programNamesAgentSettings(program),
    globCandidates: agentSettingsGlobCandidates(cwd, extraPaths),
    globDecoys: agentSettingsGlobDecoys(cwd, GLOB_DECOYS),
    harmlessCommands: AGENT_SETTINGS_HARMLESS_COMMANDS,
    cwd,
    hint: matcher.hint,
    namesThroughLinks: matcher.throughLinks,
  };
}

/** Interpreters that take a program inline or on stdin. Never readers. */
const INLINE_INTERPRETERS = "python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|perl|ruby|php|lua|osascript|pwsh|powershell";
const INLINE_INTERPRETER_RE = new RegExp(`^(?:${INLINE_INTERPRETERS})$`);

/**
 * A program handed to an interpreter on its command line: `python3 -c "…"`,
 * `node -e '…'`, `perl -pe '…'`, `deno eval "…"`, glued (`-c"…"`) or not.
 *
 * The program is not shell, but the walk splits it like shell — on every `;` —
 * so `python3 -c "import json; p='<path>'; json.dump(d, open(p,'w'))"` left the
 * path in a piece that reads as a bare assignment with no command in front of
 * it, and the interpreter's own piece named nothing. So the whole program is
 * judged as one: an interpreter is never on the read list, and naming the
 * target anywhere in its program is enough.
 *
 * Bounded on purpose: at most six words between the interpreter and its flag,
 * all on one line (a backslash-newline is joined first). An unbounded gap
 * re-scanned the rest of the input for every interpreter-shaped word.
 */
const INLINE_PROGRAM_RE = new RegExp(
  String.raw`(?:^|[\s;&|(\x60])(?:[^\s;&|()\x60]*/)?(?:${INLINE_INTERPRETERS})(?:[ \t]+[^\s;&|]+){0,6}?[ \t]+(?:-[A-Za-z]*[ceErp]|--eval=?|--print=?|--command=?|-Command|eval)[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*')`,
  "g",
);

/** Heads that run their quoted arguments, or a heredoc, as shell. */
const SHELL_HEADS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "eval", "source", ".", "su",
  "ssh", "docker", "podman", "kubectl", "watch",
]);

/** Shells and interpreters that read a program from stdin when given no script: `| sh`, `| node`. */
const STDIN_PROGRAM_HEADS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "node", "bun", "deno",
]);

/** Words a shell walks past before the command that receives the arguments. */
const MASK_TRANSPARENT_WORDS: ReadonlySet<string> = new Set([
  "sudo", "doas", "env", "nohup", "time", "timeout", "nice", "stdbuf", "setsid", "command", "builtin",
  "exec", "xargs", "then", "do", "else", "elif", "if", "while", "until", "!",
]);

/** Characters that steer the walk and mean nothing to the shell inside a quoted argument. */
const MASKABLE_IN_QUOTES = "\n\r;&|<>()";

/** What a quoted message holds and a quoted word does not. */
const NOT_IN_A_QUOTED_WORD = ` \t\v\f${MASKABLE_IN_QUOTES}`;

/** One command context: the top level, a `$(…)`, a backtick or a `( … )` subshell. */
interface LexCommandFrame {
  kind: "cmd";
  /** What closes it: `)` for `$(` and `(`, a backtick for a backtick, nothing for the top level. */
  closer: ")" | "`" | null;
  /** Opened by `$(` or a backtick: its output is spliced into the command around it. */
  substitution: boolean;
  /** The current simple command's head, once its first real word is read. */
  head: string | null;
  /** The current simple command's words so far (the first few). */
  words: string[];
  word: string;
}

interface LexQuoteFrame {
  kind: "sq" | "dq" | "ansi";
  /** Blank separators inside: the command receiving this argument is not a shell. */
  mask: boolean;
  /** Where the quoted text starts. */
  start: number;
  /**
   * Nothing inside so far that a message has and a word does not: no blank,
   * separator, escape or expansion. Such a quote is a quoted WORD, and
   * `commandsOnly` gives it back when it closes — `codex features disable
   * "hooks"` is that command whether or not `hooks` is quoted.
   */
  plain: boolean;
}

interface LexArithFrame {
  kind: "arith";
  depth: number;
}

/** `${…}`: part of one word, whatever spaces, `#`, `;` or `)` it holds. */
interface LexParamFrame {
  kind: "param";
  depth: number;
}

type LexFrame = LexCommandFrame | LexQuoteFrame | LexArithFrame | LexParamFrame;

/** A simple command as it ended: its head and its first words. */
interface LexEndedCommand {
  head: string | null;
  words: string[];
}

interface PendingHeredoc {
  delimiter: string;
  literal: boolean;
  /** Index, in the line's ended commands, of the command the operator belongs to. */
  commandIndex: number;
  /** Inside a `$(…)`/backtick: the command the substitution is an argument of; undefined at the top level. */
  outer: LexEndedCommand | null | undefined;
}

/** What one pass over a command learns. Every string has the command's length. */
interface ShellLex {
  /** Comments and STORED heredoc bodies blanked; everything else as written. */
  readable: string;
  /** `readable`, with separators, redirects and parentheses inside quoted arguments blanked too. */
  splittable: string;
  /** The command with only LITERAL stored heredoc bodies blanked: where substitutions are looked for. */
  substitutionSource: string;
  /** `splittable` with ALL text inside a non-shell command's quoted arguments blanked: the commands alone. */
  commandsOnly: string;
  /** Bodies of heredocs that an interpreter reads as its program. */
  programBodies: string[];
}

function isShellHead(head: string | null | undefined): boolean {
  return head !== null && head !== undefined && SHELL_HEADS.has(head);
}

function isInterpreterHead(head: string | null | undefined): boolean {
  return head !== null && head !== undefined && INLINE_INTERPRETER_RE.test(head);
}

/** `cat`, `cat -` or `cat /dev/stdin`: copies its stdin and nothing else. */
function catReadsOnlyStdin(command: LexEndedCommand): boolean {
  return command.head === "cat" && command.words.slice(1).every((word) => word === "-" || word === "/dev/stdin");
}

/** `-F -`, `-F-`, `--file=/dev/stdin` and the like: a message read from stdin. */
function readsMessageFromStdin(words: string[], options: readonly string[]): boolean {
  const stdin = (value: string | undefined): boolean => value === "-" || value === "/dev/stdin";
  return words.some((word, i) => {
    if (options.includes(word)) return stdin(words[i + 1]);
    return options.some((option) => (option.startsWith("--") ? word === `${option}=-` || word === `${option}=/dev/stdin` : stdin(word.slice(option.length)) && word.startsWith(option)));
  });
}

/** `git commit|tag|notes … -F -`: the heredoc is the commit message. */
function gitTakesMessageFromStdin(command: LexEndedCommand): boolean {
  if (command.head !== "git") return false;
  const sub = command.words.slice(1).find((word) => !word.startsWith("-"));
  return (sub === "commit" || sub === "tag" || sub === "notes") && readsMessageFromStdin(command.words, ["-F", "--file"]);
}

/** `gh … --body-file -`: the heredoc is the body of an issue, a PR or a release. */
function ghTakesBodyFromStdin(command: LexEndedCommand): boolean {
  return command.head === "gh" && readsMessageFromStdin(command.words, ["--body-file", "-F"]);
}

/** Commands whose `$(cat <<'EOF' …)` argument is a message they store, never run. */
function outerStoresMessage(outer: LexEndedCommand | null | undefined): boolean {
  // Not `echo` or `printf`: their output is the body itself, and
  // `echo "$(cat <<'EOF' …)" > x.sh && sh x.sh` runs it.
  if (!outer || outer.head === null) return false;
  const sub = outer.words.slice(1).find((word) => !word.startsWith("-"));
  if (outer.head === "git") return sub === "commit" || sub === "tag" || sub === "notes" || sub === "merge";
  if (outer.head === "gh" || outer.head === "glab") return sub !== "alias" && sub !== "extension";
  return false;
}

/** A pipe into a shell or interpreter, or an eval/source, anywhere after `at`. */
const RUNS_TEXT_LATER_RE =
  /\|\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|ash|fish|python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|perl|ruby|php|lua|pwsh|powershell)(?=[\s;&|)]|$)|(?:^|[\s;&|(`])(?:eval|source)(?=\s)/;

/** The file a `cat > F` or `tee F` heredoc writes, or null. */
function heredocWritesFile(command: LexEndedCommand): string | null {
  const words = command.words;
  if (command.head === "cat") {
    for (let i = 1; i < words.length; i++) {
      const m = /^>{1,2}(.*)$/.exec(words[i]);
      if (m) return m[1] || words[i + 1] || null;
    }
    return null;
  }
  if (command.head === "tee") return words.slice(1).find((word) => !word.startsWith("-")) ?? null;
  return null;
}

/**
 * Whether a heredoc's body is text being STORED rather than read by anything
 * that acts on it — the only bodies the walk may skip.
 *
 * An allowlist, because the other direction failed: `git apply <<EOF`,
 * `xargs rm <<EOF`, `while read f; … done <<EOF` and `cat > x.sh <<EOF; bash
 * x.sh` all use their body, and skipping "everything but a shell" hid every one
 * of them. What is left is the message shapes agents write — a `$(cat <<'EOF'
 * …)` handed to `git commit -m`, `gh` or `echo`, a message `git commit -F -` or
 * `gh … --body-file -` reads from stdin (directly or through `cat |`) — and a
 * file written by `cat > F` or `tee F` that nothing in the same command runs.
 * Anything that later pipes into a shell, `eval`s or `source`s keeps its body.
 */
function heredocIsStoredText(
  doc: PendingHeredoc,
  own: LexEndedCommand,
  downstream: LexEndedCommand[],
  later: { runsText: boolean; names: { has(name: string): boolean } },
  substitutionBody: boolean,
): boolean {
  if (later.runsText) return false;
  if (downstream.length === 0) {
    if (catReadsOnlyStdin(own)) {
      // Inside a substitution whose text the outer command stores; or a body
      // being judged on its own (depth 1), whose outer command was judged with it.
      if (doc.outer !== undefined ? outerStoresMessage(doc.outer) : substitutionBody) return true;
    }
    if (gitTakesMessageFromStdin(own) || ghTakesBodyFromStdin(own)) return true;
    const file = doc.outer === undefined ? heredocWritesFile(own) : null;
    if (file) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      return name.length > 0 && !later.names.has(name);
    }
    return false;
  }
  return (
    downstream.length === 1 &&
    catReadsOnlyStdin(own) &&
    (gitTakesMessageFromStdin(downstream[0]) || ghTakesBodyFromStdin(downstream[0]))
  );
}

/**
 * A heredoc delimiter word, read the way the shell reads it: quotes and
 * backslashes come off, and any of them makes the body literal. `<<E\OF` is
 * `EOF`, and so is `<<"EOF"`; `<<"EOF"x` is `EOFx`.
 */
function readHeredocDelimiter(text: string, from: number): { delimiter: string; literal: boolean; end: number } | null {
  let j = from;
  if (text[j] === "-") j++;
  while (text[j] === " " || text[j] === "\t") j++;
  let delimiter = "";
  let literal = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "'") {
      literal = true;
      const close = text.indexOf("'", j + 1);
      const end = close === -1 ? text.length : close;
      delimiter += text.slice(j + 1, end);
      j = end + 1;
      continue;
    }
    if (c === '"') {
      literal = true;
      let k = j + 1;
      for (; k < text.length && text[k] !== '"'; k++) {
        if (text[k] === "\\" && k + 1 < text.length) k++;
        delimiter += text[k];
      }
      j = k + 1;
      continue;
    }
    if (c === "\\") {
      literal = true;
      if (j + 1 < text.length) delimiter += text[j + 1];
      j += 2;
      continue;
    }
    if (/\s/.test(c) || ";&|<>()".includes(c)) break;
    delimiter += c;
    j++;
  }
  return delimiter ? { delimiter, literal, end: j } : null;
}

/**
 * One linear pass over a command, as a shell would read it: quotes, `$'…'`,
 * `${…}`, `$(…)` and backticks (also inside double quotes), `$((…))`,
 * `( … )` subshells, comments, and heredocs with their bodies.
 *
 * The regexes this replaced read `<<word` inside a quoted string, a comment, a
 * here-string or `$((1<<n))` as a heredoc and skipped the commands after it;
 * read an apostrophe inside a comment as a quote and joined the next line to
 * the comment's command; and rescanned the line for every quote, which made a
 * long `printf` quadratic. `substitutionBody` is set when the text is the body
 * of a `$(…)` judged on its own, whose outer command was judged with it.
 */
function lexShell(text: string, substitutionBody = false): ShellLex {
  const n = text.length;
  // Which outputs blank each position: one byte per character rather than four
  // arrays of one-character strings, which made each pass allocate dozens of
  // bytes per character of the command.
  const READABLE = 1;
  const SPLITTABLE = 2;
  const SUBSTITUTION = 4;
  const COMMANDS = 8;
  const blanks = new Uint8Array(n);
  const blankAt = (k: number, outputs: number): void => {
    if (k < n) blanks[k] |= outputs;
  };
  const programBodies: string[] = [];
  const newCommand = (closer: ")" | "`" | null, substitution: boolean): LexCommandFrame => ({
    kind: "cmd", closer, substitution, head: null, words: [], word: "",
  });
  const stack: LexFrame[] = [newCommand(null, false)];
  const pending: PendingHeredoc[] = [];
  // Commands ended since the first pending heredoc on this line, in order: a
  // heredoc's own command, then the ones its output is piped to. One list per
  // line, so many operators on one line stay linear.
  const lineCommands: LexEndedCommand[] = [];

  const commandFrame = (): LexCommandFrame => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const frame = stack[k];
      if (frame.kind === "cmd") return frame;
    }
    return stack[0] as LexCommandFrame;
  };
  const outerCommand = (): LexEndedCommand | null | undefined => {
    // The substitution frame closest to the top, then the command below it.
    for (let k = stack.length - 1; k >= 0; k--) {
      const frame = stack[k];
      if (frame.kind !== "cmd") continue;
      if (!frame.substitution) return undefined;
      for (let j = k - 1; j >= 0; j--) {
        const below = stack[j];
        if (below.kind === "cmd") return { head: below.head ?? (below.word ? commandBasename(below.word) : null), words: [...below.words] };
      }
      return null;
    }
    return undefined;
  };
  const endWord = (frame: LexCommandFrame): void => {
    if (!frame.word) return;
    if (frame.words.length < 32) frame.words.push(frame.word);
    if (frame.head === null) {
      const base = commandBasename(frame.word);
      const skipped =
        ENV_ASSIGNMENT_RE.test(frame.word) || frame.word.startsWith("-") || RUNNER_OPERAND_RE.test(frame.word) ||
        MASK_TRANSPARENT_WORDS.has(base);
      if (!skipped) frame.head = base;
    }
    frame.word = "";
  };
  const endCommand = (frame: LexCommandFrame): void => {
    endWord(frame);
    if (pending.length > 0) lineCommands.push({ head: frame.head, words: frame.words.map((w) => w.replace(/^q+$/, "")) });
    frame.head = null;
    frame.words = [];
  };
  const quoteMask = (frame: LexCommandFrame): boolean => frame.head !== null && !isShellHead(frame.head);
  const closeQuote = (frame: LexQuoteFrame, end: number): void => {
    if (!frame.mask || !frame.plain) return;
    for (let k = frame.start; k < end; k++) blanks[k] &= ~COMMANDS;
  };
  const blankStored = (start: number, end: number, literal: boolean): void => {
    for (let k = start; k < end; k++) {
      if (text[k] === "\n") continue;
      blankAt(k, READABLE | SPLITTABLE | COMMANDS | (literal ? SUBSTITUTION : 0));
    }
  };
  // Whether anything from `pos` on pipes into a shell or `eval`s, and whether
  // a file name appears from `pos` on. `pos` only grows, and each answer comes
  // from a scan that never goes back over text: the next match of
  // RUNS_TEXT_LATER_RE, and the last place each name appears. `pos` follows a
  // newline, which stands in for the start of the text the regex once saw.
  let nextRunsText = -2;
  let lastNamed: Map<string, number> | undefined;
  const runsTextFrom = (pos: number): boolean => {
    if (nextRunsText === -1) return false;
    if (nextRunsText >= pos - 1) return true;
    const scan = new RegExp(RUNS_TEXT_LATER_RE.source, "g");
    scan.lastIndex = Math.max(0, pos - 1);
    nextRunsText = scan.exec(text)?.index ?? -1;
    return nextRunsText !== -1;
  };
  const namedFrom = (name: string, pos: number): boolean => {
    if (lastNamed === undefined) {
      lastNamed = new Map();
      for (const word of text.matchAll(/[^\s;&|<>()'"`=]+/g)) {
        lastNamed.set(word[0].slice(word[0].lastIndexOf("/") + 1), word.index);
      }
    }
    return (lastNamed.get(name) ?? -1) >= pos;
  };
  /** Read every pending heredoc's body, starting at `at`; return where lexing resumes. */
  const consumeBodies = (at: number): number => {
    let pos = at;
    const spans: Array<{ doc: PendingHeredoc; start: number; end: number }> = [];
    for (const doc of pending.splice(0)) {
      let bodyEnd = n;
      let next = n;
      for (let line = pos; line <= n; ) {
        const end = text.indexOf("\n", line);
        const content = text.slice(line, end === -1 ? n : end);
        if (content.trim() === doc.delimiter) {
          bodyEnd = line;
          next = end === -1 ? n : end + 1;
          break;
        }
        if (end === -1) break;
        line = end + 1;
      }
      spans.push({ doc, start: pos, end: bodyEnd });
      pos = next;
    }
    // What runs after the bodies, once for every heredoc on the line (a check
    // per heredoc made thousands of operators on one line quadratic), and
    // looked up rather than read: reading the rest of the text again for each
    // line of heredocs made a script of them quadratic.
    const later = { runsText: runsTextFrom(pos), names: { has: (name: string) => namedFrom(name, pos) } };
    for (const { doc, start, end } of spans) {
      const own = lineCommands[doc.commandIndex] ?? { head: null, words: [] };
      const downstream = lineCommands.slice(doc.commandIndex + 1);
      if (heredocIsStoredText(doc, own, downstream, later, substitutionBody)) blankStored(start, end, doc.literal);
      else if (isInterpreterHead(own.head) || downstream.some((command) => isInterpreterHead(command.head))) {
        programBodies.push(text.slice(start, end));
      }
    }
    lineCommands.length = 0;
    return pos;
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    const frame = stack[stack.length - 1];
    if (frame.kind === "sq") {
      if (ch === "'") {
        closeQuote(frame, i);
        stack.pop();
      } else if (frame.mask) {
        if (MASKABLE_IN_QUOTES.includes(ch)) blankAt(i, SPLITTABLE);
        if (ch !== "\n") blankAt(i, COMMANDS);
        if (frame.plain && NOT_IN_A_QUOTED_WORD.includes(ch)) frame.plain = false;
      }
      i++;
      continue;
    }
    if (frame.kind === "ansi") {
      if (ch === "\\") {
        frame.plain = false;
        if (frame.mask) {
          blankAt(i, COMMANDS);
          if (i + 1 < n && text[i + 1] !== "\n") blankAt(i + 1, COMMANDS);
        }
        i += 2;
        continue;
      }
      if (ch === "'") {
        closeQuote(frame, i);
        stack.pop();
      } else if (frame.mask) {
        if (MASKABLE_IN_QUOTES.includes(ch)) blankAt(i, SPLITTABLE);
        if (ch !== "\n") blankAt(i, COMMANDS);
        if (frame.plain && NOT_IN_A_QUOTED_WORD.includes(ch)) frame.plain = false;
      }
      i++;
      continue;
    }
    if (frame.kind === "arith") {
      if (ch === "(") frame.depth++;
      else if (ch === ")") {
        if (frame.depth === 0 && text[i + 1] === ")") {
          blankAt(i, SPLITTABLE);
          blankAt(i + 1, SPLITTABLE);
          stack.pop();
          i += 2;
          continue;
        }
        frame.depth = Math.max(0, frame.depth - 1);
      }
      i++;
      continue;
    }
    if (frame.kind === "param") {
      // Nothing inside `${…}` separates, redirects, opens a subshell or starts
      // a comment: `${X:- #}; rm …` runs the `rm`.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        stack.push({ kind: ch === "'" ? "sq" : "dq", mask: true, start: i + 1, plain: true });
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "(") {
        stack.push(newCommand(")", true));
        blankAt(i + 1, SPLITTABLE);
        i += 2;
        continue;
      }
      if (ch === "{") frame.depth++;
      else if (ch === "}") {
        if (frame.depth === 0) {
          stack.pop();
          i++;
          continue;
        }
        frame.depth--;
      } else if (MASKABLE_IN_QUOTES.includes(ch)) blankAt(i, SPLITTABLE);
      i++;
      continue;
    }
    if (frame.kind === "dq") {
      if (ch === "\\") {
        frame.plain = false;
        if (frame.mask) {
          blankAt(i, COMMANDS);
          if (i + 1 < n && text[i + 1] !== "\n") blankAt(i + 1, COMMANDS);
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        closeQuote(frame, i);
        stack.pop();
        i++;
        continue;
      }
      if (ch === "`" || (ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) frame.plain = false;
      // The parentheses of `$(…)` and `$((…))` open no subshell: blanked where
      // the walk counts subshells, so a `cd "$(dirname …)"` keeps its reach.
      if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
        stack.push({ kind: "arith", depth: 0 });
        blankAt(i + 1, SPLITTABLE);
        blankAt(i + 2, SPLITTABLE);
        i += 3;
        continue;
      }
      if (ch === "$" && text[i + 1] === "(") {
        stack.push(newCommand(")", true));
        blankAt(i + 1, SPLITTABLE);
        i += 2;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        stack.push({ kind: "param", depth: 0 });
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.push(newCommand("`", true));
        i++;
        continue;
      }
      if (frame.mask) {
        if (MASKABLE_IN_QUOTES.includes(ch)) blankAt(i, SPLITTABLE);
        if (ch !== "\n") blankAt(i, COMMANDS);
        if (frame.plain && NOT_IN_A_QUOTED_WORD.includes(ch)) frame.plain = false;
      }
      i++;
      continue;
    }

    // A command context.
    const command = frame as LexCommandFrame;
    if (ch === "\\") {
      // A backslash-newline joins lines; any other escaped character is literal.
      if (text[i + 1] !== "\n") command.word += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`" && command.closer === "`") {
      endCommand(command);
      stack.pop();
      commandFrame().word += "q";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === "$" && text[i + 1] === "'")) {
      stack.push({
        kind: ch === "'" ? "sq" : ch === '"' ? "dq" : "ansi",
        mask: quoteMask(command),
        start: i + (ch === "$" ? 2 : 1),
        plain: true,
      });
      command.word += "q";
      i += ch === "$" ? 2 : 1;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
      stack.push({ kind: "arith", depth: 0 });
      blankAt(i + 1, SPLITTABLE);
      blankAt(i + 2, SPLITTABLE);
      command.word += "q";
      i += 3;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      stack.push(newCommand(")", true));
      blankAt(i + 1, SPLITTABLE);
      command.word += "q";
      i += 2;
      continue;
    }
    if (ch === "$" && text[i + 1] === "{") {
      stack.push({ kind: "param", depth: 0 });
      command.word += "q";
      i += 2;
      continue;
    }
    if (ch === "`") {
      stack.push(newCommand("`", true));
      command.word += "q";
      i++;
      continue;
    }
    if (ch === "#" && command.word === "") {
      // A comment runs to the end of the line, and nothing in it is shell.
      let j = i;
      for (; j < n && text[j] !== "\n"; j++) {
        blankAt(j, READABLE | SPLITTABLE | COMMANDS);
      }
      i = j;
      continue;
    }
    if (ch === "(") {
      endWord(command);
      stack.push(newCommand(")", false));
      i++;
      continue;
    }
    if (ch === ")") {
      if (command.closer === ")") {
        endCommand(command);
        stack.pop();
        if (command.substitution) {
          blankAt(i, SPLITTABLE);
          commandFrame().word += "q";
        }
      }
      i++;
      continue;
    }
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      const op = readHeredocDelimiter(text, i + 2);
      if (op) {
        endWord(command);
        pending.push({
          delimiter: op.delimiter,
          literal: op.literal,
          commandIndex: lineCommands.length,
          outer: outerCommand(),
        });
        i = op.end;
        continue;
      }
    }
    if (ch === "\n") {
      endCommand(command);
      i = pending.length > 0 ? consumeBodies(i + 1) : i + 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      endCommand(command);
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord(command);
      i++;
      continue;
    }
    command.word += ch;
    i++;
  }
  if (pending.length > 0) {
    endCommand(commandFrame());
    consumeBodies(n);
  }
  // Each output is the text with its blanked positions turned into spaces, or
  // the text itself when nothing in it was blanked.
  const render = (output: number): string => {
    let out = "";
    let from = 0;
    let blanked = false;
    for (let k = 0; k < n; ) {
      if ((blanks[k] & output) === 0) {
        k++;
        continue;
      }
      let end = k;
      while (end < n && (blanks[end] & output) !== 0) end++;
      out += text.slice(from, k) + " ".repeat(end - k);
      from = end;
      k = end;
      blanked = true;
    }
    return blanked ? out + text.slice(from) : text;
  };
  return {
    readable: render(READABLE),
    splittable: render(SPLITTABLE),
    substitutionSource: render(SUBSTITUTION),
    commandsOnly: render(COMMANDS),
    programBodies,
  };
}

/**
 * Index past the end of a `$(…)`, `${…}` or backtick that starts at `i`,
 * quotes inside it included: what the shell keeps inside one word.
 */
function endOfExpansion(text: string, i: number): number {
  if (text[i] === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "`") return j + 1;
    }
    return text.length;
  }
  const open = text[i + 1];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", j + 1);
      if (end === -1) return text.length;
      j = end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

/**
 * A simple command's words the way the shell will split them: whitespace
 * outside quotes and expansions separates, and quotes and backslash escapes
 * come off. `$(…)`, `${…}` and backticks stay whole, as written, so
 * `cd $(echo ~/.claude)` has one operand.
 */
function quoteAwareWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      current += text.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "$" && text[i + 1] === "'") {
      let j = i + 2;
      let body = "";
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          body += text[j] + text[j + 1];
          j++;
        } else body += text[j];
      }
      current += decodeAnsiC(body);
      inWord = true;
      i = j;
      continue;
    }
    if ((ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) || ch === "`") {
      const end = endOfExpansion(text, i);
      current += text.slice(i, end);
      inWord = true;
      i = end - 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "$" && (text[j + 1] === "(" || text[j + 1] === "{")) {
          const end = endOfExpansion(text, j);
          current += text.slice(j, end);
          j = end - 1;
        } else if (text[j] === "\\" && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) {
          current += text[j + 1];
          j++;
        } else current += text[j];
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * The words of a simple command from its head on, the prefixes a shell walks
 * past dropped. `viaXargs`: an `xargs` stood among those prefixes.
 * `readsStdinProgram`: the command is a bare shell or interpreter, which runs
 * whatever is piped into it (`echo '…' | sh`).
 */
function quoteAwareCommandWords(simple: string): { words: string[]; viaXargs: boolean; readsStdinProgram: boolean } {
  const all = quoteAwareWords(simple);
  let viaXargs = false;
  let shell = false;
  let i = 0;
  for (; i < all.length; i++) {
    const word = all[i];
    const base = commandBasename(word);
    if (base === "xargs") viaXargs = true;
    if (STDIN_PROGRAM_HEADS.has(base)) shell = true;
    const skippable =
      ENV_ASSIGNMENT_RE.test(word) || word.startsWith("-") || RUNNER_OPERAND_RE.test(word) ||
      SHELL_KEYWORD_PREFIXES.has(word) || COMMAND_PREFIX_TOKENS.has(base);
    if (!skippable) break;
  }
  const words = all.slice(i);
  return { words, viaXargs, readsStdinProgram: shell && words.length === 0 };
}

/** `e`: sed runs a shell command, as a command (`1e cp …`) or as the flag on `s` (`s/x/y/e`). */
const SED_RUNS_COMMAND_RE = /(?:^|[;{}\s/0-9$,!])[ \t]*[gpIiMm0-9]*e[gpIiMm0-9]*(?=$|[\s;}])/;

/** `w` and `W`: sed writes the rest of the line's text as a file name, glued on or after a space. */
const SED_WRITE_FILE_RE = /(?:^|[;{}\s/0-9$,!])[ \t]*[gpIiMm0-9]*[wW][ \t]*([^\n]+)/g;

/**
 * The script texts a `sed` command runs: each `-e`/`--expression` value, or the
 * first operand when there is none. Null when a script comes from a file
 * (`-f`), which cannot be read from here. Options that take a value
 * (`-l <n>`, `--line-length <n>`) take it, so the value is never the script.
 */
function sedScripts(rawSimple: string): string[] | null {
  const words = quoteAwareWords(rawSimple);
  const at = words.findIndex((w) => commandBasename(w) === "sed");
  if (at === -1) return [];
  const scripts: string[] = [];
  let explicit = false;
  for (let i = at + 1; i < words.length; i++) {
    const a = words[i];
    if (a === "-e" || a === "--expression") {
      scripts.push(words[++i] ?? "");
      explicit = true;
      continue;
    }
    if (a.startsWith("--expression=")) {
      scripts.push(a.slice("--expression=".length));
      explicit = true;
      continue;
    }
    if (a === "--file" || a.startsWith("--file=") || /^-(?!-)[A-Za-z]*f/.test(a)) return null;
    if (a === "-l" || a === "--line-length") {
      i++;
      continue;
    }
    if (/^-(?!-)[A-Za-z]*e$/.test(a)) {
      scripts.push(words[++i] ?? "");
      explicit = true;
      continue;
    }
    if (/^-(?!-)[A-Za-z]*e./.test(a)) {
      scripts.push(a.slice(a.indexOf("e") + 1));
      explicit = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (!explicit && scripts.length === 0) scripts.push(a);
  }
  return scripts;
}

/**
 * `text` with each expansion — `$VAR`, `${…}`, `$(…)`, backticks — turned into
 * `*`, a pattern that reaches at least every word the shell could produce:
 * `~/.claude/settings$X.json`, `~/.clau${X}de/settings.json`,
 * `settings$( true ).json` and `~/.fa${X:-ilproofai}` all reach their file, and
 * are tried against it like any other glob. Spliced before the text is cut into
 * words, so an expansion holding a space stays in its word; an expansion
 * standing alone becomes a bare `*`, which the decoys keep from naming
 * anything.
 *
 * One pass with a bracket stack, so nesting and length cost nothing extra: a
 * regex bounded to keep unclosed `${` linear also let an expansion longer than
 * its bound through unspliced. An unclosed one stays as written.
 */
function spliceWordExpansions(text: string, commandSubstitutionsOnly = false): string {
  const spans: Array<[number, number]> = [];
  const stack: Array<{ close: string; start: number; expansion: boolean }> = [];
  const outermost = (): boolean => !stack.some((open) => open.expansion);
  let backtick = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      if (backtick === -1) backtick = i;
      else {
        if (outermost()) spans.push([backtick, i + 1]);
        backtick = -1;
      }
      continue;
    }
    if (backtick !== -1) continue;
    if (ch === "$" && (text[i + 1] === "{" || text[i + 1] === "(")) {
      const brace = text[i + 1] === "{";
      stack.push({ close: brace ? "}" : ")", start: i, expansion: !(brace && commandSubstitutionsOnly) });
      i++;
      continue;
    }
    if (ch === "$" && !commandSubstitutionsOnly && /[A-Za-z_]/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      if (outermost()) spans.push([i, j]);
      i = j - 1;
      continue;
    }
    if (ch === "{" || ch === "(") {
      stack.push({ close: ch === "{" ? "}" : ")", start: i, expansion: false });
      continue;
    }
    if ((ch === "}" || ch === ")") && stack.length > 0 && stack[stack.length - 1].close === ch) {
      const open = stack.pop()!;
      if (open.expansion && outermost()) spans.push([open.start, i + 1]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [start, end] of spans) {
    if (start < pos) continue;
    out += text.slice(pos, start) + "*";
    pos = end;
  }
  return out + text.slice(pos);
}

/** `$(…)` and backticks, which the shell splices into the word around them. */

/** A word the shell resolves against the current directory. */
function isRelativeShellWord(word: string): boolean {
  return word.length > 0 && !/^[-/~$]/.test(word) && !word.includes("://") && !GLOB_METACHAR_RE.test(word);
}

/**
 * Where `cd <operand>` leaves a shell that stood in `from`, or undefined when
 * that cannot be known from the text (`cd -`, `cd $DIR`, `cd "$(dirname …)"`).
 */
function cdDestination(from: string | undefined, operand: string | undefined): string | undefined {
  if (operand === undefined || operand === "~" || operand === "$HOME" || operand === "${HOME}") return homedir();
  const home = /^(?:~|\$HOME|\$\{HOME\})\/(.*)$/.exec(operand);
  if (home) return resolve(homedir(), home[1]);
  if (operand === "-" || operand.includes("$") || operand.includes("`")) return undefined;
  if (operand.startsWith("/")) return resolve(operand);
  return from === undefined ? undefined : resolve(from, operand);
}

/** `text` cut at every match of `separator`, as `[start, end)` ranges. */
function cutRanges(text: string, separator: RegExp): Array<[number, number]> {
  const global = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : `${separator.flags}g`);
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(global)) {
    ranges.push([start, match.index]);
    start = match.index + match[0].length;
  }
  ranges.push([start, text.length]);
  return ranges;
}

/** True when `command` would delete, move or overwrite failproofai's own state. */
function destroysFailproofaiState(command: string): boolean {
  return destroysProtectedPath(command, FAILPROOFAI_STATE_TARGET);
}

/**
 * True when `command` would delete, move or overwrite the target — written for
 * failproofai's own state, which is what the examples below are about.
 *
 * Deleting the state IS disabling enforcement, and it never names the binary:
 * `rm ~/.failproofai/policies/packs/installed.json` switches off every pack
 * policy on the machine, and fail-closed does NOT fire, because a missing store
 * reads as a fresh machine rather than a broken one — so nothing anywhere
 * reports it.
 *
 * Two things carry the path into a command that never spells it, and both were
 * live bypasses of the per-segment version:
 *
 * - `cd ~/.failproofai && rm -rf .` — the path is an argument of `cd`, and the
 *   destroying command names only `.`
 * - `D=~/.failproofai; rm -rf $D` — the path is a value, and the destroying
 *   command names only `$D`
 *
 * So the walk is stateful: it remembers which variables hold the path, whether
 * the shell has been moved INTO the directory, and — where it can tell — which
 * directory the shell stands in, so a relative destination
 * (`cd ~/.failproofai && cp /dev/null policies-config.json`) is read as the path
 * it is. What it does NOT do is treat every later command as suspect —
 * `cat ~/.failproofai/config.json && rm /tmp/scratch` has to stay allowed, and
 * does, because nothing in the second command reaches the state.
 */
function destroysProtectedPath(command: string, target: ProtectedPathTarget, depth = 0, unescapedPass = false): boolean {
  const lexed = lexShell(command, depth > 0);

  // A substitution runs its body as a command of its own, so it is judged as
  // one — `echo $(rm -rf ~/.failproofai)` otherwise presents `echo` as the head
  // and walks straight through. Bounded, because a body can contain another.
  // Breadth-first with a budget rather than depth-limited recursion: a nest
  // deeper than the limit is trivial to write (`echo $(echo $(… rm …))`), and
  // every level of it presents `echo` as the head. The budget is what bounds
  // the work instead, because siblings multiply where depth does not.
  //
  // Not on a text whose quotes and backslashes are already gone
  // (`unescapedPass`): there an escaped backtick in a commit message reads as a
  // substitution. Each body is judged raw AND unescaped here instead, so a
  // quote-broken path inside one (`$(rm ~/.claude/"settings.json")`) is caught.
  if (depth === 0 && !unescapedPass) {
    const bodies = substitutionBodies(lexed.substitutionSource);
    for (let i = 0; i < bodies.length && i < 64; i++) {
      if (destroysProtectedPath(bodies[i], target, 1)) return true;
      const unescapedBody = stripShellQuoting(bodies[i]);
      if (unescapedBody !== bodies[i] && destroysProtectedPath(unescapedBody, target, 1, true)) return true;
      bodies.push(...substitutionBodies(lexShell(bodies[i], true).substitutionSource));
    }
  }

  // Variables that hold the path. The scan used to ask only whether a value
  // CONTAINED the path, which caught `D=~/.failproofai; rm -rf $D` and missed
  // `A=~/.failproofai; B=$A; rm -rf $B` — the second hop names no path at all,
  // only the first variable. So a value referencing a known state variable
  // counts too. Repeating to a fixpoint costs four lines and makes the result
  // independent of the order the assignments appear in, rather than resting on
  // a shell evaluating them top to bottom.
  const assignments = [
    ...lexed.readable.matchAll(/(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g),
  ].map(([, name, value]) => [name, value.replace(/^["']|["']$/g, "")] as const);
  const stateVars = new Set<string>();
  for (let pass = 0; pass < assignments.length + 1; pass++) {
    const before = stateVars.size;
    for (const [name, value] of assignments) {
      const holdsState =
        target.namesLiteral(value) ||
        [...value.matchAll(VAR_REFERENCE_RE)].some(([, ref]) => stateVars.has(ref));
      if (holdsState) stateVars.add(name);
    }
    if (stateVars.size === before) break;
  }

  // The directory the shell stands in, where the text says. Undefined once it
  // cannot be known; `pushd` keeps the one it left for `popd` to return to, on
  // a stack shared by reference, so a subshell can hand the parent's back.
  let walkCwd = target.cwd;
  type DirStack = { dir: string | undefined; below: DirStack } | null;
  let dirStack: DirStack = null;

  const namesState = (text: string): boolean => {
    if (target.namesLiteral(text)) return true;
    for (const [, name] of text.matchAll(VAR_REFERENCE_RE)) {
      if (stateVars.has(name)) return true;
    }
    // Per token, not over the whole text: a glob compiled from a whole command
    // line matches nothing, and it is the individual operand — `~/.failproof*`
    // — that would expand onto the state. Expansions are spliced first, so one
    // holding a space (`settings$( true ).json`) stays inside its word.
    const spliced = spliceWordExpansions(text);
    return spliced.split(/\s+/).some((token) => {
      const word = unquotedToken(token);
      if (globCouldNameTarget(word, target)) return true;
      if (target.namesThroughLinks?.(word, walkCwd)) return true;
      if (walkCwd === undefined) return false;
      // A relative word lands where the shell stands: `settings.json` after
      // `cd ~/.claude`, `opencode` after `cd ~/.config`. Only words that could
      // be one of the target's names, or `.`/`..` steps, are resolved: the
      // rest cannot land on it, and resolving every word of a long line cost
      // more than the whole walk.
      const cwdHinted = target.hint === undefined || target.hint.test(walkCwd);
      for (const form of word.includes("=") ? [word, word.slice(word.indexOf("=") + 1)] : [word]) {
        if (!isRelativeShellWord(form)) continue;
        if (!cwdHinted && !target.hint!.test(form) && !/^\.{1,2}(?:\/\.{1,2})*\/?$/.test(form)) continue;
        if (target.namesLiteral(resolve(walkCwd, form))) return true;
      }
      return GLOB_METACHAR_RE.test(word) && !/^[-/~$]/.test(word) && globCouldNameTarget(resolve(walkCwd, word), target);
    });
  };

  // Programs handed to an interpreter, judged whole (see INLINE_PROGRAM_RE).
  // Found where the interpreter really is a command: through the comment and
  // stored-text masks (`readable`), and only where its name is still there in
  // `commandsOnly`, which also blanks what a command that is not a shell takes
  // as a quoted argument — the example in `git commit -m 'Refuse python3 -c
  // "…"'`. Line continuations become blanks of the same width, so an offset in
  // one view is the same place in the other.
  const namesProgram = (program: string): boolean => (target.namesProgram ?? target.namesLiteral)(program) || namesState(program);
  const programText = lexed.readable.replace(/\\\r?\n/g, (joined) => " ".repeat(joined.length));
  for (const match of programText.matchAll(INLINE_PROGRAM_RE)) {
    const at = match.index + (/^[\s;&|(\x60]/.test(match[0]) ? 1 : 0);
    if (lexed.commandsOnly[at] !== programText[at]) continue;
    if (namesProgram(match[1])) return true;
  }
  for (const body of lexed.programBodies) {
    if (namesProgram(body)) return true;
  }

  let cwdInState = false;
  // How deep in `( … )` the walk is. A `cd`, `pushd` or `popd` inside a
  // subshell moves the subshell only, so where the shell stood — its
  // directory, its `pushd` stack, and whether that was inside the target —
  // comes back when the parenthesis closes: `(cd ~/.failproofai && cat x); rm
  // -rf node_modules` was denying a cleanup in an entirely unrelated
  // directory, and `(cd /tmp; pushd /tmp); popd` handed the parent a stack
  // entry it never had.
  let parenDepth = 0;
  const cwdScopes: Array<{ depth: number; cwd: string | undefined; inState: boolean; dirs: DirStack }> = [];
  // A loop header hands its word list to the body, and the body is a separate
  // pipeline that names nothing. Without this, `for f in ~/.failproofai/*; do
  // rm -rf $f; done` is a header that only expands and a body that only deletes
  // something called `$f`.
  let loopCarriesState = false;
  // A destination after a `cd` into the target names it, even relative — and
  // when the walk has lost track of where the shell stands, every relative
  // destination counts: `cd $D && cp x policies-config.json`.
  const namesHere = (text: string): boolean =>
    namesState(text) || (cwdInState && walkCwd === undefined && isRelativeShellWord(bareToken(text)));
  // The walk SPLITS the splittable text and READS the readable one: both keep
  // every offset, so each piece of one is the same piece of the other. Comments
  // and stored heredoc bodies are blank in both; separators inside a quoted
  // argument are blank only in the first, so a sed or awk program still
  // arrives with the separators and redirects it really has.
  const { readable, splittable } = lexed;
  for (const [pipelineStart, pipelineEnd] of cutRanges(splittable, PIPELINE_SEPARATORS)) {
    const pipeline = readable.slice(pipelineStart, pipelineEnd);
    const splitPipeline = splittable.slice(pipelineStart, pipelineEnd);
    if (!pipeline.trim()) continue;
    const reachesState = namesState(pipeline) || cwdInState || loopCarriesState;
    if (reachesState && LOOP_HEADER_RE.test(splitPipeline)) loopCarriesState = true;
    if (/(?:^|\s)done(?:\s|$)/.test(splitPipeline)) loopCarriesState = false;

    // A redirect is a write with no command in front of it — `> path` empties a
    // file on its own. Only a redirect whose TARGET is the state counts: the
    // previous version matched any `>` anywhere in the segment, so
    // `grep -r sudo ~/.failproofai 2>/dev/null` and
    // `cat ~/.failproofai/config.json > /tmp/backup.json` both denied, which is
    // exactly the diagnosis this guard must not block.
    if (reachesState) {
      for (const [, redirected] of splitPipeline.matchAll(REDIRECT_TARGET_RE)) {
        if (namesHere(redirected.replace(/^["']|["']$/g, ""))) return true;
      }
    }

    const simples = cutRanges(splitPipeline, /\|/);
    for (const [simpleIndex, [simpleStart, simpleEnd]] of simples.entries()) {
      const simple = pipeline.slice(simpleStart, simpleEnd);
      const splitSimple = splitPipeline.slice(simpleStart, simpleEnd);
      parenDepth += (splitSimple.match(/\(/g) ?? []).length;
      // A command substitution is one word however many spaces it holds:
      // `cp x ~/.claude/settings$( true ).json` has three operands, not five.
      const words = commandWords(spliceWordExpansions(simple, true));
      const head = words.length > 0 ? commandBasename(words[0]) : "";
      // Track the shell's position before judging: a `cd` INTO the state makes
      // every later relative path a state path, and a `cd` back out ends that.
      if (head === "cd" || head === "pushd" || head === "popd") {
        // Every command of a pipeline runs in a subshell, so one before a `|`
        // moves nothing: `cd ~/.claude | cat; cp x settings.json` copies into
        // the directory the shell already stood in. zsh runs the LAST command
        // in the shell itself and bash does not, so after that one the walk no
        // longer knows where the shell stands, and counts it inside the target
        // when either place is.
        if (simpleIndex === simples.length - 1) {
          if (parenDepth > 0) cwdScopes.push({ depth: parenDepth, cwd: walkCwd, inState: cwdInState, dirs: dirStack });
          const before = walkCwd;
          if (head === "popd") {
            // `popd` returns to wherever the shell was before `pushd`, which
            // ends the window as surely as a `cd` out does. Without it every
            // command for the rest of the line was judged as if it stood in
            // the state directory. On an empty stack it fails and the shell
            // stays where it is.
            if (dirStack !== null) {
              cwdInState = false;
              walkCwd = dirStack.dir;
              dirStack = dirStack.below;
            }
          } else {
            // Quote-aware, so `cd "$(dirname ~/.claude/settings.json)"` is one operand.
            const operand = quoteAwareCommandWords(simple).words.slice(1).find((w) => !w.startsWith("-"));
            cwdInState = operand !== undefined && namesState(operand);
            if (head === "pushd") dirStack = { dir: walkCwd, below: dirStack };
            walkCwd = cdDestination(walkCwd, operand);
          }
          if (simples.length > 1) {
            cwdInState ||= (before !== undefined && namesState(before)) || (walkCwd !== undefined && namesState(walkCwd));
            walkCwd = undefined;
          }
        }
      } else if (reachesState && simpleIndex > 0 && quoteAwareCommandWords(simple).readsStdinProgram) {
        // A bare shell or interpreter after a pipe runs the text piped into it:
        // `echo 'rm -rf ~/.claude' | sh`. Whatever names the target upstream is
        // its program.
        return true;
      } else if (reachesState && words.length > 0) {
        // `xargs` hands the paths on its stdin to the command after it, so a
        // copy or a `tee` fed by `echo <path> |` names its destination nowhere
        // in its own words. Judged like `find -exec`: only a reader is safe.
        // Read from the command's own words, not its quoted arguments.
        if (quoteAwareCommandWords(simple).viaXargs && !SAFE_EXEC_COMMANDS.has(head)) return true;
        // Judged BEFORE the closing parenthesis is counted: a `rm -rf ./*)`
        // still runs inside the subshell it closes.
        if (simpleCommandDestroys(words, namesHere, target, simple, cwdInState)) return true;
      }
      parenDepth -= (splitSimple.match(/\)/g) ?? []).length;
      while (cwdScopes.length > 0 && parenDepth < cwdScopes[cwdScopes.length - 1].depth) {
        const scope = cwdScopes.pop()!;
        walkCwd = scope.cwd;
        cwdInState = scope.inState;
        dirStack = scope.dirs;
      }
    }
  }
  return false;
}

const FAILPROOFAI_UNINSTALL_RE = /(?:npm\s+(?:uninstall|remove|un|r)\s.*failproofai|bun\s+remove\s.*failproofai|yarn\s+global\s+remove\s+failproofai|pnpm\s+(?:remove|uninstall|un)\s.*failproofai)/;

// warnGitAmend
const GIT_AMEND_RE = /\bgit\s+commit\b.*--amend\b/;

// warnGitStashDrop
const GIT_STASH_DROP_RE = /\bgit\s+stash\s+(?:drop|clear)\b/;

// warnGitClean
/**
 * `git`, however the command line spells it. Same shape as {@link RM_CMD_RE}:
 * an absolute path to the binary does not change what it does.
 */
const GIT_CMD_RE = /^(?:\/\S*\/)?git$/;

/** A short-flag cluster: `-f`, `-fdx`, `-xdf`. */
const SHORT_FLAG_CLUSTER_RE = /^-[A-Za-z]+$/;

/**
 * `clean.requireForce=false`, the config that makes `git clean` delete with no
 * `-f` at all — and settable per invocation as `git -c
 * clean.requireForce=false clean -xd`. Reading the subcommand's flags alone
 * would call that "no force, no warning" on the one spelling that needs none.
 */
const GIT_CLEAN_FORCE_WAIVED_RE = /^clean\.requireforce=(?:false|0|no|off)$/i;

/**
 * The default `destructiveFlags`, and why the condition is these three letters
 * rather than "any `git clean`".
 *
 * `git clean` deletes nothing without `-f` / `--force` (or the config above),
 * and `-n` / `--dry-run` only prints — so force is the precondition and
 * dry-run is the exemption. What force ALONE removes is untracked files in the
 * current directory: the narrowest spelling, and the one people mean when they
 * tidy up. These are the letters that widen the blast radius past that:
 *
 * - `-x` also removes IGNORED files — `.env`, local config, editor state,
 *   scratch work. That is the data that genuinely cannot be rebuilt by running
 *   a command, and it is what makes `git clean -fdx` the severe spelling.
 * - `-X` removes ONLY ignored files: the same loss, tracked tree untouched.
 * - `-d` also removes untracked DIRECTORIES — whole new subtrees git has never
 *   had a copy of.
 *
 * A bare `git clean -f` is deliberately absent. It has the smallest radius and
 * by far the most traffic, and a guard that fires on the ordinary spelling is
 * one people switch off — which would cost them the `-fdx` warning too. Add
 * `"f"` to `destructiveFlags` to opt into it.
 */
const GIT_CLEAN_DESTRUCTIVE_FLAGS = ["d", "x", "X"];

// warnAllFilesStaged
const GIT_ADD_ALL_RE = /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$|;|&&|\|\|))/;

// warnGlobalPackageInstall
const NPM_GLOBAL_RE = /\bnpm\s+(?:install|i)\b(?=.*(?:\s-g\b|--global\b))/;
const YARN_GLOBAL_RE = /\byarn\s+global\s+add\b/;
const PNPM_GLOBAL_RE = /\bpnpm\s+(?:add|install|i)\b(?=.*(?:\s-g\b|--global\b))/;
const BUN_GLOBAL_RE = /\bbun\s+(?:install|add)\b(?=.*(?:\s-g\b|--global\b))/;
const CARGO_INSTALL_RE = /\bcargo\s+install\b/;
const PIP_SYSTEM_RE = /\bpip(?:3)?\s+install\b(?=.*(?:--user\b|--break-system-packages\b))/;

// preferPackageManager — maps manager name → detection patterns
const PKG_MANAGER_DETECTORS: Record<string, RegExp[]> = {
  pip: [/\bpip\b/, /\bpip3\b/, /\bpython3?\s+-m\s+pip\b/],
  npm: [/\bnpm\b/, /\bnpx\b/],
  yarn: [/\byarn\b/],
  pnpm: [/\bpnpm\b/, /\bpnpx\b/],
  bun: [/\bbun\b/, /\bbunx\b/],
  uv: [/\buv\b/],
  poetry: [/\bpoetry\b/],
  pipenv: [/\bpipenv\b/],
  conda: [/\bconda\b/],
  cargo: [/\bcargo\b/],
};

// warnBackgroundProcess
const NOHUP_RE = /\bnohup\s+\S/;
const SCREEN_DETACH_RE = /\bscreen\s+-[A-Za-z]*d[A-Za-z]*\b/;
const TMUX_DETACH_RE = /\btmux\s+(?:new-session|new)\b[^|&;]*-d\b/;
const DISOWN_RE = /\bdisown\b/;
const BACKGROUND_AMPERSAND_RE = /(?<![&|])\s?&\s*(?:$|#|;)/;

// Infra Commands — leading-token detection across shell separators.
// Each regex matches the CLI name only when it appears as the first token of a
// command segment (start-of-string or after ; && || |). Trailing \s prevents
// false matches on names like "kubectlx" or "awsctl".
const KUBECTL_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*kubectl(?:\s|$)/;
const TERRAFORM_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*(?:terraform|tofu)(?:\s|$)/;
const AWS_CLI_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*aws(?:\s|$)/;
const GCLOUD_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*gcloud(?:\s|$)/;
const AZ_CLI_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*az(?:\s|$)/;
const HELM_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*helm(?:\s|$)/;
// gh: only mutating / pipeline-trigger subcommands. Read-only forms
// (gh pr view, gh run list, gh api ...) are intentionally allowed because
// failproofai's own workflow policies depend on them.
const GH_PIPELINE_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*gh\s+(?:workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel)|pr\s+merge|release\s+(?:create|delete)|cache\s+delete|secret\s+(?:set|delete))\b/;

// Caches the current branch per cwd to avoid repeated execSync calls, gated
// on .git/HEAD's mtime rather than reused unconditionally for the life of
// the process. In the one-shot-process model that unconditional reuse cost
// nothing (the cache never outlived a single hook call), but the daemon's
// warm worker keeps this Map alive across many calls and potentially many
// different projects' cwds — reusing a branch name forever would silently
// deny/allow a Stop based on a branch the user checked out an hour ago.
// git updates .git/HEAD's mtime on every checkout/switch, so a cheap local
// statSync (no subprocess) is a real, precise invalidation signal. Falls
// back to always re-fetching (no caching) when .git/HEAD can't be stat'd
// (worktrees/submodules), matching today's behavior for that case. Bounded
// at 500 entries so a warm worker touching many projects over its lifetime
// doesn't grow this unboundedly.
const gitBranchCache = new Map<string, { branch: string; headMtimeMs: number }>();
const GIT_BRANCH_CACHE_MAX_ENTRIES = 500;

function statGitHeadMtimeMs(cwd: string): number | null {
  try {
    return statSync(join(cwd, ".git", "HEAD")).mtimeMs;
  } catch {
    return null;
  }
}

function getCurrentBranch(cwd: string): string | null {
  try {
    const headMtimeMs = statGitHeadMtimeMs(cwd);
    const cached = gitBranchCache.get(cwd);
    if (cached && headMtimeMs !== null && cached.headMtimeMs === headMtimeMs) {
      return cached.branch || null;
    }
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    if (headMtimeMs !== null) {
      if (gitBranchCache.size >= GIT_BRANCH_CACHE_MAX_ENTRIES) gitBranchCache.clear();
      gitBranchCache.set(cwd, { branch, headMtimeMs });
    }
    return branch || null;
  } catch {
    return null;
  }
}

function getHeadSha(cwd: string): string | null {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

interface CiCheck {
  name: string;
  status: string;
  conclusion: string;
}

/** Fetch third-party check runs (non-GitHub-Actions) for a commit via the Checks API. */
function getThirdPartyCheckRuns(cwd: string, sha: string): CiCheck[] {
  try {
    const json = execFileSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        "--jq",
        '.check_runs | map(select(.app.slug != "github-actions")) | map({name: .name, status: .status, conclusion: (.conclusion // "")})',
      ],
      {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      },
    ).trim();

    if (!json || json === "[]") return [];
    return JSON.parse(json) as CiCheck[];
  } catch {
    return [];
  }
}

/** Fetch commit statuses (legacy Status API) and normalize to CiCheck format. */
function getCommitStatuses(cwd: string, sha: string): CiCheck[] {
  try {
    const json = execFileSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/statuses`,
        "--jq",
        'map({name: .context, state: .state}) | unique_by(.name)',
      ],
      {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      },
    ).trim();

    if (!json || json === "[]") return [];
    const statuses = JSON.parse(json) as Array<{ name: string; state: string }>;
    return statuses.map((s) => ({
      name: s.name,
      status: s.state === "pending" ? "in_progress" : "completed",
      conclusion: s.state === "pending" ? "" : s.state === "success" ? "success" : "failure",
    }));
  } catch {
    return [];
  }
}

/**
 * Check if a command matches an allow pattern using token-by-token comparison.
 * The "*" token is a wildcard. Extra command tokens beyond the pattern are allowed,
 * UNLESS any token is a standalone shell operator (&&, ||, |, ;) OR contains an
 * embedded shell metacharacter — both cases are rejected to prevent bypass via
 * appended sub-commands or glued operators (e.g. "nginx;" or "nginx;evil").
 */
function matchesAllowedPattern(cmd: string, pattern: string): boolean {
  const cmdTokens = parseArgvTokens(cmd);
  const patTokens = parseArgvTokens(pattern);
  if (cmdTokens.length < patTokens.length) return false;
  // Reject commands containing standalone shell-operator tokens
  if (cmdTokens.some((tok) => SHELL_OPERATORS.has(tok))) return false;
  // Reject any token containing embedded shell metacharacters
  if (cmdTokens.some((tok) => SHELL_METACHAR_RE.test(tok))) return false;
  return patTokens.every((tok, i) => tok === "*" || tok === cmdTokens[i]);
}

// -- Policy implementations --

function sanitizeJwt(ctx: PolicyContext): PolicyResult {
  // PostToolUse: scrub JWT patterns from tool output
  const output = JSON.stringify(ctx.payload);
  if (JWT_RE.test(output)) {
    return {
      decision: "deny",
      reason: "JWT token detected in tool output",
      message: "[REDACTED: JWT token removed by failproofai]",
    };
  }
  return allow();
}

function sanitizeApiKeys(ctx: PolicyContext): PolicyResult {
  // PostToolUse: scrub common API key patterns from tool output
  const output = JSON.stringify(ctx.payload);
  for (const [pattern, label] of API_KEY_PATTERNS) {
    if (pattern.test(output)) {
      return {
        decision: "deny",
        reason: `${label} detected in tool output`,
        message: `[REDACTED: ${label} removed by failproofai]`,
      };
    }
  }

  // Check additional user-configured patterns
  const additional = ((ctx.params?.additionalPatterns ?? []) as Array<{ regex: string; label: string }>);
  for (const { regex, label } of additional) {
    try {
      if (new RegExp(regex).test(output)) {
        return {
          decision: "deny",
          reason: `${label} detected in tool output`,
          message: `[REDACTED: ${label} removed by failproofai]`,
        };
      }
    } catch {
      hookLogWarn(`additionalPatterns: invalid regex "${regex}", skipping`);
    }
  }

  return allow();
}

function sanitizeConnectionStrings(ctx: PolicyContext): PolicyResult {
  // PostToolUse: scrub database connection strings with embedded credentials
  const output = JSON.stringify(ctx.payload);
  if (CONNECTION_STRING_RE.test(output)) {
    return {
      decision: "deny",
      reason: "Database connection string with credentials detected in tool output",
      message: "[REDACTED: connection string removed by failproofai]",
    };
  }
  return allow();
}

function sanitizePrivateKeyContent(ctx: PolicyContext): PolicyResult {
  // PostToolUse: scrub PEM private key blocks from tool output
  const output = JSON.stringify(ctx.payload);
  if (PRIVATE_KEY_RE.test(output)) {
    return {
      decision: "deny",
      reason: "Private key content detected in tool output",
      message: "[REDACTED: private key content removed by failproofai]",
    };
  }
  return allow();
}

function sanitizeBearerTokens(ctx: PolicyContext): PolicyResult {
  // PostToolUse: scrub Authorization: Bearer tokens from tool output
  const output = JSON.stringify(ctx.payload);
  if (BEARER_TOKEN_RE.test(output)) {
    return {
      decision: "deny",
      reason: "Bearer token detected in tool output",
      message: "[REDACTED: Bearer token removed by failproofai]",
    };
  }
  return allow();
}

function warnDestructiveSql(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (!SQL_TOOL_RE.test(cmd)) return allow();

  // DROP or TRUNCATE always warns
  if (DESTRUCTIVE_SQL_RE.test(cmd)) {
    return instruct(
      "STOP: This command contains destructive SQL (DROP/TRUNCATE/DELETE). Confirm with the user before executing.",
    );
  }

  // DELETE FROM without WHERE warns
  if (DELETE_NO_WHERE_RE.test(cmd) && !SQL_WHERE_RE.test(cmd)) {
    return instruct(
      "STOP: This command contains destructive SQL (DROP/TRUNCATE/DELETE). Confirm with the user before executing.",
    );
  }

  return allow();
}

function warnLargeFileWrite(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Write") return allow();
  const content = ctx.toolInput?.content as string | undefined;
  if (typeof content !== "string") return allow();
  const thresholdKb = ((ctx.params?.thresholdKb ?? 1024) as number);
  const thresholdBytes = thresholdKb * 1024;
  if (content.length > thresholdBytes) {
    return instruct(
      `STOP: You are writing a file larger than ${thresholdKb}KB (${Math.round(content.length / 1024)}KB). This is unusually large. Confirm this is intentional before proceeding.`,
    );
  }
  return allow();
}

function warnPackagePublish(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (PUBLISH_CMD_RE.test(cmd)) {
    return instruct(
      "STOP: This command publishes a package to a public registry. Confirm with the user that this is intentional.",
    );
  }
  return allow();
}

function protectEnvVars(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  // Block: env, printenv, echo $VAR, export VAR=
  if (ENV_PRINTENV_RE.test(cmd)) {
    return deny("Command reads environment variables");
  }
  if (ECHO_ENV_RE.test(cmd)) {
    return deny("Command echoes environment variable");
  }
  if (EXPORT_RE.test(cmd)) {
    return deny("Command exports environment variable");
  }
  if (ENV_DUMP_RE.test(cmd) || (SCRIPT_INTERP_RE.test(cmd) && ENV_OBJECT_RE.test(cmd))) {
    return deny("Command dumps environment variables");
  }
  // PowerShell: $env:VAR
  if (PS_ENV_VAR_RE.test(cmd)) {
    return deny("Command reads environment variable via PowerShell");
  }
  // PowerShell: Get-ChildItem Env: / dir env: / gci env: / ls env:
  if (PS_CHILDITEM_ENV_RE.test(cmd)) {
    return deny("Command reads environment variables via PowerShell");
  }
  // PowerShell: [Environment]::GetEnvironmentVariable
  if (DOTNET_GETENV_RE.test(cmd)) {
    return deny("Command reads environment variable via .NET");
  }
  // cmd: echo %VAR%
  if (CMD_ECHO_ENV_RE.test(cmd)) {
    return deny("Command echoes environment variable via cmd");
  }
  return allow();
}

function blockEnvFiles(ctx: PolicyContext): PolicyResult {
  const cmd = getCommand(ctx);
  const filePath = getFilePath(ctx);

  // Check file_path for Read/Write tools (match both / and \ path separators)
  if (filePath && ENV_FILE_PATH_RE.test(filePath)) {
    return deny("Access to .env file blocked");
  }
  // Check Bash commands referencing .env files
  if (ctx.toolName === "Bash" && ENV_CMD_RE.test(cmd)) {
    return deny("Command references .env file");
  }
  return allow();
}

/**
 * True when a segment runs an elevation binary IN COMMAND POSITION.
 *
 * Anchored structurally rather than by token, for the reason `namesSelfPause`
 * is: `SUDO_RE` required the literal token `sudo` at a command boundary, so
 * **`/usr/bin/sudo rm -rf /` was ALLOWED** — a direct invocation, no
 * obfuscation, one absolute path away from root on a `defaultEnabled` guard.
 * Every other form the shell resolves before settling on the binary — prefix
 * assignments, redirections, runners and their flags — is walked off first, and
 * the comparison is on the BASENAME so a path cannot hide the name.
 *
 * `doas` is included because it is the same capability under a different name;
 * a machine with `doas` installed and only `sudo` blocked is not blocked.
 *
 * This raises the bar; it does not close the class. `bash -c "sudo …"`, a
 * variable (`S=sudo; $S …`) and base64-through-a-pipe all still reach root,
 * because static inspection of one command string cannot follow them. Closing
 * that properly needs enforcement below the shell, not a better regex.
 */
/**
 * Split a command into per-segment TOKEN LISTS the way a shell reads it.
 *
 * Distinct from `shellSegments` below, which returns raw segment STRINGS and is
 * what the deletion policies want. Named apart deliberately: defining a second
 * `shellSegments` here shadowed that one, silently broke every `rm -rf` check,
 * and disabled this matcher too — caught only because `tsc` reports duplicate
 * implementations.
 *
 * Segmentation happens on the RAW string and skips separators inside quotes,
 * which is the whole point: stripping quoting FIRST turns `\|` — a literal pipe
 * in a grep alternation — into a real separator, so `grep "a\|sudo b"` parses
 * as a command called `sudo` and gets denied. That is a common enough pattern
 * that over-blocking it is worse than the evasion it would catch.
 *
 * Each token is unquoted individually afterwards, which still defeats `\sudo`
 * and `"sudo"` without ever letting quote removal change where the boundaries
 * are. Quoted tokens are returned separately so a caller can decide whether
 * their CONTENTS deserve a second look — see `EVAL_FLAG_RE`.
 */
function quoteAwareSegments(command: string): Array<string[]> {
  const segments: Array<string[]> = [];
  let tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (token) tokens.push(token);
    token = "";
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      // Inside single quotes a backslash is literal; inside double quotes it escapes.
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        token += command[++i];
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      token += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      // An escaped character is literal — `\sudo` is still sudo, and `\|` is a
      // pipe CHARACTER rather than a separator.
      token += command[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      endToken();
      continue;
    }
    if (/[;&|\n\r(){}`]/.test(c)) {
      endSegment();
      continue;
    }
    token += c;
  }
  endSegment();
  return segments;
}

/** `-c` and friends: the flags whose ARGUMENT is a command, not data. */
const EVAL_FLAG_RE = /^-{1,2}c$/;

/**
 * True when a command runs an elevation binary IN COMMAND POSITION.
 *
 * Anchored structurally rather than by token, for the reason `namesSelfPause`
 * is: `SUDO_RE` required the literal token `sudo` at a command boundary, so
 * **`/usr/bin/sudo rm -rf /` was ALLOWED** — a direct invocation, no
 * obfuscation, one absolute path away from root on a `defaultEnabled` guard.
 * Every other form the shell resolves before settling on the binary — prefix
 * assignments, redirections, runners and their flags — is walked off first, and
 * the comparison is on the BASENAME so a path cannot hide the name.
 *
 * `doas` is included because it is the same capability under a different name;
 * a machine with `doas` installed and only `sudo` blocked is not blocked.
 *
 * A quoted argument is re-examined ONLY when the command that owns it is a
 * shell runner invoked with an eval flag (`bash -c "sudo …"`). That distinction
 * is load-bearing: `bash -c "sudo x"` and `grep "a|sudo x"` are identical from
 * the outside, and the only thing separating an execution from a search string
 * is whether the receiving binary evaluates its argument.
 *
 * This raises the bar; it does not close the class. A variable (`S=sudo; $S …`),
 * base64 through a pipe, and a wrapper script on disk all still reach root,
 * because static inspection of one command string cannot follow them. Closing
 * that properly needs enforcement below the shell, not a better matcher.
 */
function namesElevation(command: string, depth = 0): boolean {
  for (const tokens of quoteAwareSegments(command)) {
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      const base = token.slice(token.lastIndexOf("/") + 1);
      // `sudo`/`doas` are themselves in COMMAND_PREFIX_TOKENS (they legitimately
      // stand in front of another binary), so they must be tested BEFORE the
      // skip list or the walk would step straight over the thing being looked for.
      if (base === "sudo" || base === "doas") return true;
      const isSkippable =
        ENV_ASSIGNMENT_RE.test(token) ||
        token.startsWith("-") ||
        token.startsWith(">") ||
        token.startsWith("<") ||
        RUNNER_OPERAND_RE.test(token) ||
        COMMAND_PREFIX_TOKENS.has(base);
      if (!isSkippable) break;
      // `sh -c "…"` / `bash -c "…"`: the next token is a COMMAND. Bounded
      // recursion so a nested `bash -c "bash -c …"` cannot spin.
      if (EVAL_FLAG_RE.test(token) && depth < 3 && i + 1 < tokens.length) {
        if (namesElevation(tokens[i + 1], depth + 1)) return true;
      }
      i++;
    }
  }
  return false;
}

function blockSudo(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx).trimStart();
  // ONE pass. `shellSegments` unquotes each token individually, so `\sudo` and
  // `"sudo"` are still caught — without a whole-string strip, which is what
  // turned an escaped pipe in `grep "a\|sudo b"` into a segment separator and
  // denied an ordinary search.
  if (namesElevation(cmd)) {
    // Check allowPatterns — match against parsed tokens, not raw string
    const allowPatterns = ((ctx.params?.allowPatterns ?? []) as string[]);
    if (allowPatterns.some((p) => matchesAllowedPattern(cmd, p))) return allow();
    return deny("sudo commands are blocked");
  }
  // PowerShell: Start-Process -Verb RunAs (elevation)
  if (PS_ELEVATION_RE.test(cmd)) {
    return deny("Elevated process launch is blocked");
  }
  // Windows: runas command
  if (RUNAS_RE.test(cmd)) {
    return deny("runas elevation is blocked");
  }
  return allow();
}

/**
 * A pause the agent can issue is not a guardrail.
 *
 * `failproofai config --pause` is a human affordance: you watched the agent get
 * blocked, you judged the block wrong, you suspended enforcement for a bit. An
 * agent that can run it turns every other policy advisory — it need only shell
 * out once to switch them all off, and the pause even survives into later turns.
 *
 * This raises the bar rather than closing the class: an agent can still reach
 * the same state obfuscated (base64, a wrapper script, an alias). Closing it
 * properly means the pause cannot originate from a tool call at all — a
 * dashboard action, or a daemon that accepts it only from a TTY. Until then,
 * the honest description of this policy is "stops the obvious attempt".
 *
 * It is deliberately NOT redundant with `block-failproofai-commands`, which
 * blocks the CLI far more broadly. That one anchors on a command boundary
 * (`FAILPROOFAI_CLI_RE`), so `npx -y failproofai config --pause` does not match
 * it — and being broad, it is a policy people plausibly switch off so agents
 * can run `failproofai audit`. Neither gap should leave pausing reachable, so
 * this stays narrow, matches the runner forms, and survives that one being off.
 */

function blockCurlPipeSh(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (CURL_PIPE_SH_RE.test(cmd)) {
    return deny("Piping downloads to shell is blocked");
  }
  // PowerShell: iwr | iex, irm | iex, Invoke-WebRequest | Invoke-Expression
  if (PS_WEB_PIPE_RE.test(cmd)) {
    return deny("Piping downloads to Invoke-Expression is blocked");
  }
  return allow();
}

function extractGitPushArgs(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => /^git\s+push\s/.test(s))
    .map((s) => s.replace(/^git\s+push\s+/, ""));
}

function blockPushMaster(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const protectedBranches = ((ctx.params?.protectedBranches ?? ["main", "master"]) as string[]);
  if (protectedBranches.length === 0) return allow();
  const args = extractGitPushArgs(getCommand(ctx));
  const branchPattern = new RegExp(`\\b(?:${protectedBranches.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
  if (args.some((a) => branchPattern.test(a))) {
    return deny(`Pushing to ${protectedBranches.join("/")} is blocked`);
  }
  return allow();
}

// -- block-rm-rf: deletion-target resolution --

/**
 * Leading shell forms that resolve to a home directory: `~`, `~user`, `$HOME`,
 * `${HOME}`. The lookahead keeps `$HOMEBREW_PREFIX` (a variable this policy
 * cannot resolve) from being mistaken for `$HOME`.
 */
const HOME_PREFIX_RE = /^(?:~[A-Za-z0-9_.-]*|\$HOME|\$\{HOME\})(?=$|\/)/;

/** `rm`, `/bin/rm`, `/usr/bin/rm`, … — the command word of a delete. */
const RM_CMD_RE = /^(?:\/\S*\/)?rm$/;

/** `find` expression that deletes: `-delete`, `-exec rm`, `-execdir rm`, `-ok rm`. */
// Same shape as RM_CMD_RE: `find` is just as dangerous when invoked by
// absolute path (`/usr/bin/find / -delete`), so match both forms.
const FIND_CMD_RE = /^(?:\/\S*\/)?find$/;
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir)$/;

/** find's global options, which precede its path operands (`find -L / -delete`). */
const FIND_GLOBAL_OPT_RE = /^-(?:[HLP]|D|O\d*)$/;

/** First token of find's expression — everything before it is a path operand. */
const FIND_EXPR_START_RE = /^(?:-|\\?[(!])/;

/**
 * Roots that exist to hold throwaway data. A delete of the root itself is still
 * catastrophic (`rm -rf /tmp` wipes every process's scratch space); a delete of
 * something *inside* one is ordinary work.
 */
const SCRATCH_ROOTS = ["/tmp", "/var/tmp"];

/**
 * How many path segments below a root (`/` or a home directory) a delete has to
 * reach before it stops being catastrophic. `/etc` (1) and `/home/chetan` (2)
 * are system- and user-level directories; `/home/chetan/project` (3) is a
 * specific thing the caller meant to delete.
 */
const CATASTROPHIC_DEPTH = 2;

/** Expand the leading `~` / `$HOME` / `${HOME}` of a path to the real home directory. */
function expandHomePrefix(path: string): string {
  const m = path.match(/^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/);
  return m ? homedir() + path.slice(m[0].length) : path;
}

/** Drop a trailing `/*` glob and any trailing slashes: `/tmp/foo/*` → `/tmp/foo`. */
function stripTrailingGlob(path: string): string {
  return path.replace(/\/\*$/, "").replace(/\/+$/, "");
}

/**
 * Would deleting this target be catastrophic?
 *
 * Rather than pattern-matching the raw command text, this resolves the token as
 * far as the shell would: quotes are stripped, `~` / `$HOME` are recognised as a
 * root in their own right, and the remaining path segments are counted. A target
 * within {@link CATASTROPHIC_DEPTH} segments of either root (`/` or home) takes
 * out the machine or the user's data.
 *
 * Fails safe: a token whose head is an expansion this policy cannot evaluate —
 * command substitution (`$(…)`, backticks) or any variable other than `$HOME` —
 * could expand to `/`, so it counts as catastrophic. Relative targets are not
 * flagged: they resolve under the working directory, not under a root.
 */
function isCatastrophicTarget(token: string): boolean {
  const raw = token.replace(/^['"]|['"]$/g, "");
  if (raw === "") return false;

  const homePrefix = raw.match(HOME_PREFIX_RE);
  // Unresolvable head: `$(echo /)`, `` `pwd` ``, `$TARGET_DIR`, …
  if (!homePrefix && /^[$`]/.test(raw)) return true;

  const belowRoot = homePrefix ? raw.slice(homePrefix[0].length) : raw.startsWith("/") ? raw : null;
  if (belowRoot === null) return false;

  const segments = stripTrailingGlob(belowRoot).split("/").filter(Boolean);
  if (!homePrefix && SCRATCH_ROOTS.some((r) => `/${segments.join("/")}`.startsWith(`${r}/`))) return false;
  return segments.length <= CATASTROPHIC_DEPTH;
}

/**
 * The paths a single command segment would recursively delete, or `null` when the
 * segment is not a recursive delete at all.
 *
 * Understands the two shapes that reach every file under a target: `rm` with both
 * `-r` and `-f` (in any spelling or order), and `find`, which recurses by design,
 * paired with `-delete` or an `-exec rm`.
 */
function recursiveDeletionTargets(seg: string): string[] | null {
  const tokens = parseArgvTokens(seg);

  const findIdx = tokens.findIndex((t) => FIND_CMD_RE.test(t));
  if (findIdx >= 0) {
    const expr = tokens.slice(findIdx + 1);
    const execIdx = expr.findIndex((t) => FIND_EXEC_RE.test(t));
    const deletes = expr.includes("-delete") || (execIdx >= 0 && RM_CMD_RE.test(expr[execIdx + 1] ?? ""));
    if (deletes) {
      // find's path operands sit between the leading global options and the
      // first expression token: `find -L /home/chetan -name '*.log' -delete`
      let start = 0;
      while (start < expr.length && FIND_GLOBAL_OPT_RE.test(expr[start])) {
        start += expr[start] === "-D" ? 2 : 1;
      }
      const rest = expr.slice(start);
      const end = rest.findIndex((t) => FIND_EXPR_START_RE.test(t));
      return end < 0 ? rest : rest.slice(0, end);
    }
  }

  const rmIdx = tokens.findIndex((t) => RM_CMD_RE.test(t));
  if (rmIdx >= 0) {
    const args = tokens.slice(rmIdx + 1);
    const shortFlags = args.filter((t) => /^-[^-]/.test(t)).join("");
    const longFlags = args.filter((t) => /^--/.test(t));
    const recursive = /r/i.test(shortFlags) || longFlags.some((f) => /^--recursive$/i.test(f));
    const force = /f/.test(shortFlags) || longFlags.some((f) => /^--force$/i.test(f));
    if (recursive && force) return args.filter((t) => !t.startsWith("-"));
  }

  return null;
}

/** Split a command into the segments the shell would run as separate commands. */
function shellSegments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[|;\n]/).map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Check whether all recursive-delete targets in a command are under an allowlisted path.
 * Splits on shell operators first so that `/tmp` appearing in an unrelated
 * sub-command (e.g. `echo /tmp && rm -rf /`) does not trigger a false allow.
 * Uses path-boundary comparison so `/tmp` does not cover `/tmp2`.
 * Non-recursive rm segments (no -r/-R flag) are skipped — they pose no catastrophic risk.
 * Quoted paths with spaces are handled via a segment-level regex fallback.
 * Home-relative targets and allowPaths entries are expanded, so `~/scratch` is
 * covered by an allowPaths entry of either `~/scratch` or the absolute home path.
 */
function deletionTargetIsAllowed(cmd: string, allowPaths: string[]): boolean {
  if (allowPaths.length === 0) return false;
  const normalizedAllowPaths = allowPaths.map((p) => stripTrailingGlob(expandHomePrefix(p)) || "/");
  let sawRecursiveDelete = false;
  for (const seg of shellSegments(cmd)) {
    const targets = recursiveDeletionTargets(seg);
    if (targets === null) continue;
    sawRecursiveDelete = true;
    for (const target of targets) {
      const normalized = stripTrailingGlob(expandHomePrefix(target)) || "/";
      const covered = normalizedAllowPaths.some((np) => normalized === np || normalized.startsWith(np + "/"));
      if (!covered) {
        // Fallback: check the raw segment for quoted paths that contain spaces
        // (parseArgvTokens splits on whitespace, so "/tmp/my dir" becomes two tokens)
        const segCovered = allowPaths.some((p) => {
          const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`${escaped}(?:[/"'\\s/*]|$)`).test(seg);
        });
        if (!segCovered) return false;
      }
    }
  }
  return sawRecursiveDelete;
}

function blockRmRf(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);

  const hasCatastrophicTarget = shellSegments(cmd).some((seg) => {
    const targets = recursiveDeletionTargets(seg);
    return targets !== null && targets.some(isCatastrophicTarget);
  });
  if (hasCatastrophicTarget) {
    const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);
    if (deletionTargetIsAllowed(cmd, allowPaths)) return allow();
    return deny("Catastrophic deletion blocked");
  }

  // PowerShell: Remove-Item -Recurse -Force on root/drive
  if (/Remove-Item\s+.*-Recurse.*-Force.*(?:[A-Z]:\\(?:\s|$)|\\\*)/i.test(cmd)) {
    return deny("Catastrophic deletion blocked");
  }
  // cmd: rd /s /q or rmdir /s /q on drive root
  if (/(?:rd|rmdir)\s+\/s\s+\/q\s+[A-Z]:\\/i.test(cmd)) {
    return deny("Catastrophic deletion blocked");
  }
  return allow();
}

function blockForcePush(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  for (const segment of extractGitPushArgs(getCommand(ctx))) {
    let sawEndOfOptions = false;
    for (const token of segment.split(/\s+/)) {
      if (token === "--") {
        sawEndOfOptions = true;
        continue;
      }
      if (sawEndOfOptions) continue;
      if (isForcePushFlag(token)) {
        return deny("Force-pushing is blocked");
      }
    }
  }
  return allow();
}

function isForcePushFlag(token: string): boolean {
  if (token === "--force") return true;
  if (SAFE_FORCE_PREFIXES.some((prefix) => token.startsWith(prefix))) return false;
  if (token.startsWith("--force")) return true;
  return SHORT_FLAG_BUNDLE_RE.test(token);
}

function blockSecretsWrite(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Write") return allow();
  const filePath = getFilePath(ctx);
  if (SECRET_FILE_RE.test(filePath) || SECRET_FILE_ID_RSA_RE.test(filePath) || SECRET_FILE_CREDENTIALS_RE.test(filePath)) {
    return deny("Writing secret key files is blocked");
  }
  const additionalPatterns = ((ctx.params?.additionalPatterns ?? []) as string[]);
  for (const pattern of additionalPatterns) {
    if (filePath.includes(pattern)) {
      return deny(`Writing blocked file pattern: ${pattern}`);
    }
  }
  return allow();
}

/** Read-like commands that access file system contents. */
const READ_LIKE_CMDS =
  /(?:^|;|&&|\|\||\|)\s*(?:ls|find|cat|head|tail|less|more|wc|file|stat|tree|du)\s/;

/**
 * Extract absolute paths from a Bash command string.
 * Scans quoted strings only in the first pipeline segment (before the first
 * bare pipe) and only when the quoted content has no glob or regex metacharacters.
 * This catches `cat "/etc/passwd"` while avoiding false positives from grep
 * patterns and find glob patterns that appear in later pipeline stages.
 * Unquoted absolute paths are extracted from the whole command as before.
 *
 * The negative lookbehind also excludes glob metacharacters ('*', '?') and
 * separator characters that appear in compound argv tokens (':' for Docker
 * volume mounts and PATH-like lists, '=' for env var assignments) so that a
 * suffix like '/dashboard.mdx' in 'docs/STAR/dashboard.mdx' or '/docs' in
 * '-v HOST_DIR:/docs' is not misread as a standalone absolute path. '/' is in
 * that list too, so a match cannot START on the second slash of a protocol
 * separator: 'http://localhost:3000/x' used to yield '/localhost:3000/x'.
 * A match that starts on the FIRST slash is untouched, so '//etc/passwd' —
 * a real, working spelling of /etc/passwd — is still extracted and still
 * resolves to /etc/passwd.
 *
 * A run of slashes with nothing else ('//', '///') that opens a line after
 * the first is dropped: that is a line-comment marker in a heredoc body, not a
 * directory. It used to resolve to the filesystem root, which denied a heredoc
 * writing a TypeScript file into the project. Anywhere else a slash-run is
 * the root, as a lone '/' is: `cd // && cat etc/shadow` reads /etc/shadow.
 */
function extractAbsolutePaths(command: string): string[] {
  const paths: string[] = [];
  const pathRe = /(?<![a-zA-Z0-9_.\-~\\*?:=/])(?:~\/[^\s;|&"'()\[\]{}]*|~(?=\s|$|[;|&"'()\[\]{}])|\/[^\s;|&"'()\[\]{}]*)/g;

  function addPaths(s: string): void {
    pathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(s)) !== null) {
      let p = m[0];
      // A `//` that opens a line after the first (a heredoc body) is a comment
      // marker. Anywhere else a slash-run is the root: `cd // && cat etc/shadow`,
      // and `cd \<newline>//`, which bash joins into one line.
      if (/^\/{2,}$/.test(p)) {
        const nl = s.lastIndexOf("\n", m.index - 1);
        if (nl !== -1 && s[nl - 1] !== "\\" && /^[ \t]*$/.test(s.slice(nl + 1, m.index))) continue;
      }
      if (p === "~") p = homedir();
      else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
      paths.push(p);
    }
  }

  // Find the index of the first bare pipe (not inside quotes) to limit quoted extraction.
  let firstBarePipe = command.length;
  let inDouble = false, inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "|" && !inDouble && !inSingle) { firstBarePipe = i; break; }
  }

  // Extract paths from quoted strings in the FIRST pipeline segment only,
  // and only when the content has no glob/regex metacharacters.
  const firstSegment = command.slice(0, firstBarePipe);
  const quotedRe = /"([^"]*)"|'([^']*)'/g;
  let qm: RegExpExecArray | null;
  while ((qm = quotedRe.exec(firstSegment)) !== null) {
    const content = qm[1] ?? qm[2] ?? "";
    // Skip patterns that contain glob or common regex metacharacters
    if (/[*?\[\]^$+()\\]/.test(content)) continue;
    addPaths(content);
  }

  // Extract from unquoted portions of the whole command (existing behaviour).
  const stripped = command
    .replace(/"[^"]*"/g, (m) => " ".repeat(m.length))
    .replace(/'[^']*'/g, (m) => " ".repeat(m.length));
  addPaths(stripped);

  return paths;
}

function blockReadOutsideCwd(ctx: PolicyContext): PolicyResult {
  // Prefer $CLAUDE_PROJECT_DIR (stable project root) over ctx.session.cwd,
  // which tracks the live shell CWD and drifts when Claude `cd`s into a subdir.
  const cwd = process.env.CLAUDE_PROJECT_DIR || ctx.session?.cwd;
  if (!cwd) return allow(); // Can't enforce without cwd

  const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);

  // For Bash tool: check read-like commands for absolute paths outside cwd
  if (ctx.toolName === "Bash") {
    const cmd = getCommand(ctx);
    if (!READ_LIKE_CMDS.test(cmd)) return allow();

    const paths = extractAbsolutePaths(cmd);
    const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
    for (const p of paths) {
      const resolved = resolve(cwd, p);
      if (isClaudeSettingsFile(resolved)) {
        return deny(`Reading agent settings file blocked: ${resolved}`);
      }
      if (isClaudeInternalPath(resolved)) continue; // Whitelist ~/.claude/
      if (resolved === "/dev/null") continue; // Harmless special file
      if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
        if (allowPaths.some((ap) => resolved === ap || resolved.startsWith(ap.endsWith("/") ? ap : ap + "/"))) continue;
        return deny(`Bash read outside project directory blocked: ${resolved}`);
      }
    }
    return allow();
  }

  // For Read/Glob/Grep: existing file_path / path check
  const filePath = getFilePath(ctx);
  const searchPath = (ctx.toolInput?.path as string) ?? "";

  const target = filePath || searchPath;
  if (!target) return allow();

  const resolved = resolve(cwd, target);

  // Block settings files in any .claude directory before whitelisting
  if (isClaudeSettingsFile(resolved)) {
    return deny(`Reading agent settings file blocked: ${resolved}`);
  }

  // Whitelist ~/.claude/ — Claude Code's own config, plans, memory, and settings
  if (isClaudeInternalPath(resolved)) return allow();

  // Whitelist /dev/null — harmless special file commonly used in shell commands
  if (resolved === "/dev/null") return allow();

  const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
  if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
    if (allowPaths.some((ap) => resolved === ap || resolved.startsWith(ap.endsWith("/") ? ap : ap + "/"))) return allow();
    return deny(`Access outside project directory blocked: ${resolved}`);
  }
  return allow();
}

function blockWorkOnMain(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  const match = cmd.match(GIT_COMMIT_MERGE_RE);
  if (!match) return allow();

  const cwd = ctx.session?.cwd;
  if (!cwd) return allow();

  const branch = getCurrentBranch(cwd);
  if (!branch) return allow();

  const protectedBranches = ((ctx.params?.protectedBranches ?? ["main", "master"]) as string[]);
  if (protectedBranches.includes(branch)) {
    return deny(
      `Git ${match[1]} on ${branch} is blocked. Create a feature branch first.`,
    );
  }
  return allow();
}

/**
 * The one policy that cannot be turned off — see `alwaysOn` on its definition.
 *
 * Merged from the former `block-self-pause` and `block-failproofai-commands`,
 * which were two halves of one guard that disagreed with each other.
 *
 * `block-self-pause` had the hardened matcher: it walks off runner prefixes and
 * re-checks the shell-unescaped form, so `sudo failproofai …`, `npx failproofai
 * …` and `fail\proofai …` do not get through. But it only ever looked for
 * `config --pause`. `block-failproofai-commands` had the whole surface — any CLI
 * call, plus package-manager uninstall — on a regex a single `sudo` defeated.
 * Keeping the broad surface and dropping the weak matcher is the only
 * combination stronger than either half.
 *
 * They also contradicted each other: `block-self-pause` deliberately ALLOWED
 * `config --resume`, `config --status` and `policies --install`, while
 * `block-failproofai-commands` denied them. Both were `defaultEnabled`, so the
 * deny is what actually happened on every machine and the allow never ran. The
 * merge keeps the behaviour users have.
 */
function blockFailproofaiCommands(ctx: PolicyContext): PolicyResult {
  // A file tool reaches the state without a shell at all. Writing
  // `{"enabledPolicies":[]}` over `~/.failproofai/policies-config.json`, or an
  // empty `policies/packs/installed.json`, disables enforcement exactly as
  // completely as `rm -rf` does — and the machine still reads as fresh, so
  // fail-closed never fires. Reading is not offered by these tools' write half,
  // so naming the state at all is the whole test.
  if (ctx.toolName === "Write" || ctx.toolName === "Edit" || ctx.toolName === "MultiEdit" || ctx.toolName === "NotebookEdit") {
    const path = getFilePath(ctx) || ((ctx.toolInput?.notebook_path as string) ?? "");
    if (FAILPROOFAI_STATE_PATH_RE.test(path)) {
      return deny(
        "Writing to failproofai's own state would switch enforcement off. " +
          "If a policy is blocking legitimate work, say so and let the operator decide.",
      );
    }
    // The agent CLI's own settings and hook files are how it calls failproofai
    // at all. `"disableAllHooks": true` in any Claude Code settings layer, or a
    // hooks file with our entries taken out, switches off every policy — this
    // one included — and Claude Code's file watcher applies it before the next
    // tool call. Checked after symlinks, and through apply_patch's patch text.
    const settingsFile = agentSettingsWriteTarget(ctx.toolInput, ctx.session?.cwd, sessionAgentSettingsPaths(ctx));
    if (settingsFile) {
      return deny(
        `${settingsFile} is an agent settings or hook file, and editing it could switch failproofai's hooks off. ` +
          "If this change is needed, say so and let the user make it.",
      );
    }
    return allow();
  }
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  // The raw command AND its shell-unescaped form: a shell strips quotes and
  // backslashes before running the binary, so `fail\proofai config --pause`
  // reaches the pause CLI even though the literal name is broken.
  const unescaped = stripShellQuoting(cmd);
  const kind = classifySelfInvocation(cmd) ?? classifySelfInvocation(unescaped) ?? classifyTextPipedIntoShell(cmd);

  if (kind === "pause") {
    return deny(
      "Pausing failproofai enforcement is a human action, not an agent one. " +
        "If a policy is blocking legitimate work, say so and let the operator decide.",
    );
  }
  if (kind === "cli") {
    return deny("Running failproofai CLI commands is blocked");
  }
  // Package-manager removal puts the manager in command position, not the
  // binary, so the walk above never reaches it.
  if (FAILPROOFAI_UNINSTALL_RE.test(cmd) || FAILPROOFAI_UNINSTALL_RE.test(unescaped)) {
    return deny("Uninstalling failproofai is blocked");
  }
  // Deleting the state IS disabling enforcement, without ever naming the binary.
  // Checked on the raw command AND its shell-unescaped form for the same reason
  // the binary walk is: `rm -rf ~/.failproof"ai"` presents a broken literal to a
  // matcher and a real path to the shell.
  if (destroysFailproofaiState(cmd) || destroysFailproofaiState(unescaped)) {
    return deny(
      "Deleting, moving or overwriting failproofai's own state would switch enforcement off. " +
        "If a policy is blocking legitimate work, say so and let the operator decide.",
    );
  }
  // An agent CLI's own command can turn its hooks off with no settings path in
  // it at all: `codex features disable hooks` rewrites config.toml. Read from
  // the commands alone, so a commit message that quotes one is still a message.
  const lexed = lexShell(cmd);
  // Text piped into a shell is a command too: `echo 'codex features disable hooks' | sh`.
  const pipesIntoShell = /\|\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|ash|fish)(?=[\s;&|)]|$)/.test(lexed.commandsOnly);
  const cliText = pipesIntoShell ? cmd : lexed.commandsOnly;
  if (agentCliSwitchesHooksOff(cliText) || agentCliSwitchesHooksOff(stripShellQuoting(cliText))) {
    return deny(
      "Turning an agent's hooks off would switch failproofai's enforcement off. " +
        "If this change is needed, say so and let the user make it.",
    );
  }
  // The same walk, aimed at the agents' settings and hook files: `jq
  // '.disableAllHooks=true' ~/.claude/settings.json > t && mv t
  // ~/.claude/settings.json` switches the hooks off without naming failproofai.
  // The unescaped pass is built from the MASKED command, so quoted arguments
  // stay one argument after their quotes come off.
  const settingsTarget = agentSettingsShellTarget(
    agentSettingsShellCwd(ctx.toolInput, ctx.session?.cwd),
    sessionAgentSettingsPaths(ctx),
  );
  const maskedUnescaped = stripShellQuoting(lexed.splittable);
  if (destroysProtectedPath(cmd, settingsTarget) || destroysProtectedPath(maskedUnescaped, settingsTarget, 0, true)) {
    return deny(
      "Writing, moving or deleting an agent's settings or hook files could switch failproofai's hooks off. " +
        "If this change is needed, say so and let the user make it.",
    );
  }
  return allow();
}

/**
 * The failproofai CLI inside text piped into a shell, which runs it:
 * `echo 'failproofai config --pause' | sh`. Each quoted string is read as the
 * command it becomes there.
 */
function classifyTextPipedIntoShell(cmd: string): SelfInvocation | null {
  if (!/\|\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|ash|fish)(?=[\s;&|)]|$)/.test(cmd)) return null;
  for (const [, single, double] of cmd.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const piped = single ?? double ?? "";
    const kind = classifySelfInvocation(piped) ?? classifySelfInvocation(stripShellQuoting(piped));
    if (kind) return kind;
  }
  return null;
}

/**
 * The settings file this session's hook was loaded from, when the hook process
 * could tell (handler.ts reads it from the agent's own environment, so a
 * `CLAUDE_CONFIG_DIR` or `CODEX_HOME` that moved it is followed).
 */
function sessionAgentSettingsPaths(ctx: PolicyContext): string[] {
  const path = ctx.session?.agentSettingsPath;
  return typeof path === "string" && path.length > 0 ? [path] : [];
}

// Shared CLI-blocker: deny any command whose argv begins with the matched CLI,
// unless an entry in `allowPatterns` matches via `matchesAllowedPattern` (which
// already defends against shell-operator injection).
function blockInfraCli(ctx: PolicyContext, re: RegExp, denyMsg: string): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (!re.test(cmd)) return allow();
  const allowPatterns = ((ctx.params?.allowPatterns ?? []) as string[]);
  if (allowPatterns.some((p) => matchesAllowedPattern(cmd, p))) return allow();
  return deny(denyMsg);
}

function blockKubectl(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, KUBECTL_RE, "kubectl commands are blocked");
}

function blockTerraform(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, TERRAFORM_RE, "terraform/tofu commands are blocked");
}

function blockAwsCli(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, AWS_CLI_RE, "aws CLI commands are blocked");
}

function blockGcloud(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, GCLOUD_RE, "gcloud commands are blocked");
}

function blockAzCli(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, AZ_CLI_RE, "az (Azure) CLI commands are blocked");
}

function blockHelm(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, HELM_RE, "helm commands are blocked");
}

// gh-pipeline only fires on mutating subcommands; allowPatterns are still
// supported in case a user wants to permit a specific scripted invocation.
function blockGhPipeline(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, GH_PIPELINE_RE, "gh pipeline-trigger commands are blocked");
}

// Maximum size of the per-session tool-call sidecar before we stop updating it.
// If exceeded, repeated-call detection degrades gracefully (allows through) rather
// than growing the file unboundedly.
const TOOL_CALL_TRACKER_MAX_BYTES = 65_536; // 64 KB

async function warnRepeatedToolCalls(ctx: PolicyContext): Promise<PolicyResult> {
  const THRESHOLD = 3;
  const transcriptPath = ctx.session?.transcriptPath;
  if (!transcriptPath || !ctx.toolName || !ctx.toolInput) return allow();

  // Sidecar file tracks { fingerprint: count } — O(1) per call vs O(transcript) per call.
  const trackerPath = `${transcriptPath}.tool-calls.json`;
  const fingerprint = JSON.stringify({ tool: ctx.toolName, input: ctx.toolInput });

  let counts: Record<string, number> = {};
  try {
    const raw = await readFile(trackerPath, "utf8");
    counts = JSON.parse(raw) as Record<string, number>;
  } catch { /* first call or unreadable — start fresh */ }

  const prevCount = counts[fingerprint] ?? 0;
  if (prevCount >= THRESHOLD) {
    return instruct(
      `STOP: You have already called ${ctx.toolName} ${prevCount} times with identical parameters. This is wasteful and unproductive. Do NOT repeat this call — use a different approach or ask the user for clarification.`,
    );
  }

  counts[fingerprint] = prevCount + 1;
  try {
    const serialized = JSON.stringify(counts);
    if (serialized.length <= TOOL_CALL_TRACKER_MAX_BYTES) {
      await writeFile(trackerPath, serialized, "utf8");
    }
  } catch { /* non-fatal */ }

  return allow();
}

function warnGitAmend(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_AMEND_RE.test(cmd)) {
    return instruct(
      "STOP: This command amends the last commit, which rewrites git history. If this commit has already been pushed to a shared branch, this will cause divergence for other contributors. Confirm with the user before executing.",
    );
  }
  return allow();
}

function warnGitStashDrop(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_STASH_DROP_RE.test(cmd)) {
    return instruct(
      "STOP: This command permanently deletes stashed changes (git stash drop/clear). Stash entries cannot be recovered after deletion. Confirm with the user before executing.",
    );
  }
  return allow();
}

/** What one `git clean` argument list asks for. */
interface GitCleanFlags {
  force: boolean;
  dryRun: boolean;
  /** Short-flag letters, with `--force` counted as `f` so widening works either way. */
  letters: Set<string>;
}

/**
 * Read `git clean`'s own options: clusters (`-fdx`) and the two long forms
 * that matter (`--force`, `--dry-run`).
 *
 * Everything after `--` is a pathspec, not a flag — `git clean -n -- -fdx`
 * asks about a file literally called `-fdx` and deletes nothing.
 */
function readGitCleanFlags(args: string[]): GitCleanFlags {
  const letters = new Set<string>();
  let force = false;
  let dryRun = false;
  let sawEndOfOptions = false;
  for (const token of args) {
    if (token === "--") {
      sawEndOfOptions = true;
      continue;
    }
    if (sawEndOfOptions) continue;
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token.startsWith("--")) continue;
    if (!SHORT_FLAG_CLUSTER_RE.test(token)) continue;
    for (const letter of token.slice(1)) {
      if (letter === "f") force = true;
      if (letter === "n") dryRun = true;
      letters.add(letter);
    }
  }
  if (force) letters.add("f");
  return { force, dryRun, letters };
}

/** True when git's own `-c key=value` options waive `clean.requireForce`. */
function gitCleanForceWaived(globalOptions: string[]): boolean {
  for (let i = 0; i < globalOptions.length; i++) {
    const token = globalOptions[i];
    const value =
      token === "-c" ? globalOptions[i + 1] : token.startsWith("-c") ? token.slice(2) : undefined;
    if (value !== undefined && GIT_CLEAN_FORCE_WAIVED_RE.test(value)) return true;
  }
  return false;
}

/**
 * The gap this closes: `git clean -fdx` was caught by NEITHER tier — no regex
 * builtin matched the string at all, and the semantic check that covers
 * unrecoverable deletion cannot fire on it. See the note on the catalog entry
 * for the measurement and for why this policy is `hard`.
 */
function warnGitClean(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const destructiveFlags = ((ctx.params?.destructiveFlags ?? GIT_CLEAN_DESTRUCTIVE_FLAGS) as string[]);
  if (destructiveFlags.length === 0) return allow();

  for (const segment of shellSegments(getCommand(ctx))) {
    const tokens = parseArgvTokens(segment);
    // `findIndex`, not `tokens[0]`, so an env prefix (`GIT_DIR=x git clean …`)
    // and an absolute binary path both still resolve to the git invocation.
    const gitIdx = tokens.findIndex((t) => GIT_CMD_RE.test(t));
    if (gitIdx < 0) continue;
    const args = tokens.slice(gitIdx + 1);
    const subIdx = gitSubcommandIndex(args);
    if (subIdx < 0 || args[subIdx] !== "clean") continue;

    const flags = readGitCleanFlags(args.slice(subIdx + 1));
    // `-n` / `--dry-run` prints what would go and removes nothing, whatever
    // else is on the line — the safe inspection form, never a warning.
    if (flags.dryRun) continue;
    if (!flags.force && !gitCleanForceWaived(args.slice(0, subIdx))) continue;
    if (!destructiveFlags.some((f) => flags.letters.has(f))) continue;

    return instruct(
      "STOP: This command deletes untracked files from the working tree (git clean). Git has no copy of " +
        "untracked or ignored files, so nothing it removes can be recovered: -d takes whole untracked " +
        "directories, and -x / -X also take .gitignore'd files such as .env, local config and scratch work. " +
        "Re-run it with --dry-run and confirm the exact paths with the user before executing.",
    );
  }
  return allow();
}

function warnAllFilesStaged(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_ADD_ALL_RE.test(cmd)) {
    return instruct(
      "STOP: This command stages all files in the working tree (git add -A / --all / .). This may inadvertently include build artifacts, generated files, or sensitive files not covered by .gitignore. Confirm with the user before executing.",
    );
  }
  return allow();
}

function warnSchemaAlteration(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (!SQL_TOOL_RE.test(cmd)) return allow();
  if (SCHEMA_ALTER_RE.test(cmd)) {
    return instruct(
      "STOP: This command contains a schema-altering SQL statement (ALTER TABLE with column or rename operation). Schema changes on production databases are irreversible or disruptive. Confirm with the user before executing.",
    );
  }
  return allow();
}

function warnGlobalPackageInstall(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  const isGlobal =
    NPM_GLOBAL_RE.test(cmd) ||
    YARN_GLOBAL_RE.test(cmd) ||
    PNPM_GLOBAL_RE.test(cmd) ||
    BUN_GLOBAL_RE.test(cmd) ||
    CARGO_INSTALL_RE.test(cmd) ||
    // Bare 'pip install' respects the active venv when one is present;
    // only flag explicit system-level flags (--user, --break-system-packages).
    PIP_SYSTEM_RE.test(cmd);
  if (isGlobal) {
    return instruct(
      "STOP: This command installs a package globally, which modifies the system-wide environment outside the project. This can conflict with other projects or system tools. Confirm with the user before executing.",
    );
  }
  return allow();
}

// Split a compound shell command into independent segments.
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||\||;)\s*/;

function preferPackageManager(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (!cmd) return allow();

  const allowed = (ctx.params?.allowed ?? []) as string[];
  if (allowed.length === 0) return allow();

  const allowedSet = new Set(allowed.map((a) => a.toLowerCase()));
  const blocked = (ctx.params?.blocked ?? []) as string[];
  const allowedList = allowed.join(", ");

  // Evaluate each shell segment independently so that
  // "uv --version && pip install flask" correctly denies the pip segment.
  const segments = cmd.split(SEGMENT_SPLIT_RE);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Check if this segment uses an allowed manager — if so, skip it.
    let segmentAllowed = false;
    for (const manager of allowedSet) {
      const patterns = PKG_MANAGER_DETECTORS[manager];
      if (!patterns) continue;
      for (const pattern of patterns) {
        if (pattern.test(trimmed)) { segmentAllowed = true; break; }
      }
      if (segmentAllowed) break;
    }
    if (segmentAllowed) continue;

    // Check if this segment uses a non-allowed builtin manager.
    for (const [manager, patterns] of Object.entries(PKG_MANAGER_DETECTORS)) {
      if (allowedSet.has(manager)) continue;
      for (const pattern of patterns) {
        if (pattern.test(trimmed)) {
          return deny(
            `"${manager}" is not an allowed package manager. ` +
              `Allowed package managers for this project: ${allowedList}. ` +
              `Rewrite this command using an allowed package manager.`,
          );
        }
      }
    }

    // Check user-specified blocked managers.
    for (const name of blocked) {
      const lower = name.toLowerCase();
      if (allowedSet.has(lower)) continue;
      const re = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(trimmed)) {
        return deny(
          `"${lower}" is not an allowed package manager. ` +
            `Allowed package managers for this project: ${allowedList}. ` +
            `Rewrite this command using an allowed package manager.`,
        );
      }
    }
  }

  return allow();
}

function warnBackgroundProcess(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  const isBackground =
    NOHUP_RE.test(cmd) ||
    SCREEN_DETACH_RE.test(cmd) ||
    TMUX_DETACH_RE.test(cmd) ||
    DISOWN_RE.test(cmd) ||
    BACKGROUND_AMPERSAND_RE.test(cmd);
  if (isBackground) {
    return instruct(
      "STOP: This command starts a background or detached process (nohup, screen -d, tmux -d, or trailing &). Background processes persist after Claude's session and may be difficult to track or stop. Confirm with the user before executing.",
    );
  }
  return allow();
}

// -- Workflow (Stop event) policies --

/**
 * Claude Code plan mode (permission_mode: "plan") is research-and-plan-only — the
 * agent makes no commits, pushes, or PRs by design. The Stop-workflow gates below
 * all assume the agent produced code changes, so in plan mode they demand actions
 * plan mode forbids (e.g. a push with nothing to push). Skip them there. Only Claude
 * reports "plan" today; every other CLI resolves to "default".
 */
function isPlanMode(ctx: PolicyContext): boolean {
  return ctx.session?.permissionMode === "plan";
}

function requireCommitBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping commit check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping commit check.");

  try {
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (status.length > 0) {
      return deny(
        "You have uncommitted changes in the working directory. Commit all changes now.",
      );
    }
    return allow("All changes are committed.");
  } catch {
    return allow("Not a git repository, skipping commit check.");
  }
}

function requirePushBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping push check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping push check.");

  try {
    const remotes = execSync("git remote", {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();

    if (!remotes) return allow("No git remote configured, skipping push check.");

    const remote = (ctx.params?.remote as string) ?? "origin";

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping push check.");

    const baseBranch = (ctx.params?.baseBranch as string) ?? "main";

    // If on the base branch itself, no push of a feature branch is needed
    if (branch === baseBranch) {
      return allow(`On base branch "${baseBranch}", skipping push check.`);
    }

    // Check if branch has diverged from base in any meaningful way
    try {
      const ahead = execFileSync(
        "git",
        ["log", `${remote}/${baseBranch}..HEAD`, "--oneline"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!ahead) {
        // No commits ahead — branch is fully merged (regular merge / fast-forward)
        return allow(`No commits ahead of ${remote}/${baseBranch}, skipping push check.`);
      }

      // Commits exist but might be from a squash-merged PR.
      // Check actual file diff — if trees are identical, work is already in base.
      const diff = execFileSync(
        "git",
        ["diff", "--stat", `${remote}/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!diff) {
        return allow(`No file changes compared to ${remote}/${baseBranch}, skipping push check.`);
      }
    } catch {
      // remote/{baseBranch} ref missing — fall through to existing push checks
    }

    // Check if remote tracking branch exists
    let hasTracking = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", `${remote}/${branch}`], {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
      });
      hasTracking = true;
    } catch {
      // Remote tracking branch does not exist
    }

    if (!hasTracking) {
      return deny(
        `Branch "${branch}" has not been pushed to remote "${remote}". ` +
        `Run now: git push -u ${remote} ${branch}`,
      );
    }

    // Check for unpushed commits
    const unpushed = execFileSync("git", ["log", `${remote}/${branch}..HEAD`, "--oneline"], {
      cwd,
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (unpushed.length > 0) {
      const commitCount = unpushed.split("\n").length;
      return deny(
        `You have ${commitCount} unpushed commit${commitCount > 1 ? "s" : ""} on branch "${branch}". ` +
        `Run now: git push`,
      );
    }

    return allow(`All commits pushed to "${remote}".`);
  } catch {
    return allow("Could not check push status, skipping.");
  }
}

function requirePrBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping PR check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping PR check.");

  try {
    // Check if gh CLI is available
    try {
      execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    } catch {
      return allow("GitHub CLI (gh) not installed, skipping PR check.");
    }

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping PR check.");

    const baseBranch = (ctx.params?.baseBranch as string) ?? "main";

    // If on the base branch itself, no PR is needed
    if (branch === baseBranch) {
      return allow(`On base branch "${baseBranch}", skipping PR check.`);
    }

    // Check if branch has diverged from base in any meaningful way
    try {
      const ahead = execFileSync(
        "git",
        ["log", `origin/${baseBranch}..HEAD`, "--oneline"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!ahead) {
        // No commits ahead — branch is fully merged (regular merge / fast-forward)
        return allow(`No commits ahead of origin/${baseBranch}, skipping PR check.`);
      }

      // Commits exist but might be from a squash-merged PR.
      // Check actual file diff — if trees are identical, work is already in main.
      const diff = execFileSync(
        "git",
        ["diff", "--stat", `origin/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      ).trim();

      if (!diff) {
        return allow(`No file changes compared to origin/${baseBranch}, skipping PR check.`);
      }
    } catch {
      // origin/{baseBranch} ref missing or git error — fall through to gh pr view
    }

    // Check if a PR exists for this branch
    let prJson: string;
    try {
      prJson = execSync("gh pr view --json number,url,state", {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      }).trim();
    } catch {
      // gh pr view exits non-zero when no PR exists
      return deny(
        `No pull request found for branch "${branch}". ` +
        `Run now: gh pr create`,
      );
    }

    const pr = JSON.parse(prJson) as { number: number; url: string; state: string };

    if (pr.state === "OPEN") {
      return allow(`PR #${pr.number} exists: ${pr.url}`);
    }

    // Trust GitHub's authoritative state. Local-ref reconciliation can never
    // converge after squash-merge or rebase-merge (the original branch commit
    // is orphaned, never an ancestor of base) or when base is auto-modified
    // post-merge (e.g. release-workflow version bumps). The PR being MERGED
    // is itself the proof that the work shipped.
    if (pr.state === "MERGED") {
      return allow(
        `PR #${pr.number} was merged: ${pr.url}. ` +
        `Switch off this branch (e.g. 'git checkout ${baseBranch} && git pull') before stopping again.`,
      );
    }

    // Reaches here only for CLOSED-without-merge — PR was rejected.
    return deny(
      `Pull request for branch "${branch}" is ${pr.state.toLowerCase()}. Run now: gh pr create`,
    );
  } catch {
    return allow("Could not check PR status, skipping.");
  }
}

function requireNoConflictsBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping conflict check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping conflict check.");

  const branch = getCurrentBranch(cwd);
  if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping conflict check.");

  const baseBranch = (ctx.params?.baseBranch as string) ?? "main";
  if (branch === baseBranch) {
    return allow(`On base branch "${baseBranch}", skipping conflict check.`);
  }

  // -- Precheck: only enforce when an OPEN PR exists on GitHub. Without a
  // confirmable merge target there is nothing to enforce, so we skip both
  // the local merge-tree probe and the GitHub mergeability probe.
  try {
    execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
  } catch {
    return allow("gh CLI not installed, skipping conflict check.");
  }

  let prJson: string;
  try {
    prJson = execSync("gh pr view --json mergeable,number,url,state", {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
    }).trim();
  } catch {
    return allow("No pull request found for branch, skipping conflict check.");
  }

  let pr: { mergeable: string; number: number; url: string; state: string };
  try {
    pr = JSON.parse(prJson);
  } catch {
    return allow("Could not parse gh pr view output, skipping conflict check.");
  }

  // GitHub stops computing mergeability for non-OPEN PRs (returns UNKNOWN forever).
  if (pr.state !== "OPEN") {
    return allow(`PR #${pr.number} is ${pr.state.toLowerCase()}; skipping conflict check.`);
  }

  // -- Layer 1: local git merge-tree --
  try {
    execFileSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000,
    });

    const ahead = execFileSync(
      "git", ["log", `origin/${baseBranch}..HEAD`, "--oneline"],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    ).trim();

    if (ahead) {
      execFileSync(
        "git",
        ["merge-tree", "--write-tree", "--name-only", `origin/${baseBranch}`, "HEAD"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
    }
    // !ahead or merge-tree exit 0 → fall through to Layer 2
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    if (e.status === 1) {
      // git merge-tree exit 1 = conflicts. stdout: <tree>\n<file>\n<file>\n\n<messages>
      const out = (typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "").trim();
      const lines = out.split("\n");
      const files: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === "") break;
        files.push(line);
      }
      const fileList = files.length ? files.join(", ") : "one or more files";
      return deny(
        `Branch "${branch}" has merge conflicts with ${baseBranch} in: ${fileList}. ` +
        `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`,
      );
    }
    // any other failure (e.g. missing origin/<base>, log failure) → fall through
  }

  // -- Layer 2: GitHub PR mergeability (reuses pr from precheck) --
  if (pr.mergeable === "CONFLICTING") {
    return deny(
      `PR #${pr.number} has merge conflicts per GitHub (${pr.url}). ` +
      `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`,
    );
  }
  if (pr.mergeable === "UNKNOWN") {
    return deny(
      `GitHub is still computing mergeability for PR #${pr.number} (${pr.url}). ` +
      `Wait ~10 seconds, then re-check with \`gh pr view --json mergeable\` before attempting to stop again.`,
    );
  }
  return allow(`PR #${pr.number} merges cleanly per GitHub.`);
}

function requireCiGreenBeforeStop(ctx: PolicyContext): PolicyResult {
  if (isPlanMode(ctx)) return allow("Plan mode — no changes made, skipping CI check.");
  const cwd = ctx.session?.cwd;
  if (!cwd) return allow("No working directory available, skipping CI check.");

  try {
    // Check if gh CLI is available
    try {
      execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    } catch {
      return allow("GitHub CLI (gh) not installed, skipping CI check.");
    }

    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return allow("Detached HEAD, skipping CI check.");

    // Resolve HEAD up front — the workflow-runs filter below uses it to
    // ignore runs targeting prior commits on the same branch (otherwise a
    // stale failure on commit X is still reported after the fix on Y lands).
    // Third-party checks and commit statuses (queried by SHA below) already
    // scope to HEAD via getThirdPartyCheckRuns / getCommitStatuses.
    const sha = getHeadSha(cwd);

    // 1. GitHub Actions workflow runs (filtered to current HEAD, deduped by name)
    let workflowRuns: CiCheck[] = [];
    try {
      // --limit 20 (was 5): a busy branch can push the latest run for some
      // workflow out of the top-5 window after the SHA filter. 20 covers
      // ~4 commits worth of runs for a 5-workflow repo without being slow.
      const runsJson = execFileSync(
        "gh",
        ["run", "list", "--branch", branch, "--limit", "20", "--json", "status,conclusion,name,headSha"],
        { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      ).trim();

      if (runsJson && runsJson !== "[]") {
        const allWorkflowRuns = JSON.parse(runsJson) as Array<CiCheck & { headSha?: string }>;
        // Filter to runs targeting the current HEAD commit only — not
        // historical runs for prior commits on the same branch. When `sha`
        // is unavailable (e.g. brand-new repo with no commits) fall back
        // to the unfiltered list so the policy still has something to act on.
        const headRuns = sha
          ? allWorkflowRuns.filter((r) => r.headSha === sha)
          : allWorkflowRuns;
        // Dedupe by workflow name, keeping the first occurrence (gh run list
        // returns newest-first). This handles GitHub's "Re-run all jobs" which
        // creates a fresh run record with the same name + headSha — without
        // dedupe the older failed record would still trip the deny.
        const seen = new Set<string>();
        workflowRuns = headRuns.filter((r) => {
          if (seen.has(r.name)) return false;
          seen.add(r.name);
          return true;
        });
      }
    } catch {
      // fail-open for workflow runs; continue to check third-party checks
    }

    // 2. Third-party check runs (CodeRabbit, SonarCloud, Codecov, etc.)
    let thirdPartyChecks: CiCheck[] = [];
    let commitStatuses: CiCheck[] = [];
    if (sha) {
      thirdPartyChecks = getThirdPartyCheckRuns(cwd, sha);
      commitStatuses = getCommitStatuses(cwd, sha);
    }

    // 3. Merge all checks
    const allChecks = [...workflowRuns, ...thirdPartyChecks, ...commitStatuses];

    if (allChecks.length === 0) return allow(`No CI runs found for branch "${branch}".`);

    const failing = allChecks.filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== "success" &&
        r.conclusion !== "skipped" &&
        r.conclusion !== "cancelled" &&
        r.conclusion !== "neutral",
    );
    if (failing.length > 0) {
      const names = failing.map((r) => `"${r.name}"`).join(", ");
      return deny(
        `CI checks are failing on branch "${branch}": ${names}. Fix the failing checks now.`,
      );
    }

    const pending = allChecks.filter(
      (r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting",
    );
    if (pending.length > 0) {
      const names = pending.map((r) => `"${r.name}"`).join(", ");
      return deny(
        `CI checks are still running on branch "${branch}": ${names}. Wait for all checks to complete, then verify they pass.`,
      );
    }

    return allow(`All CI checks passed on branch "${branch}".`);
  } catch {
    return allow("Could not check CI status, skipping.");
  }
}

// -- Registry --

/**
 * Name → implementation. The other half of {@link POLICY_CATALOG}.
 *
 * Each value is the identical hoisted function object, never a wrapper. Two
 * things depend on that and neither fails loudly: `audit/cache.ts` hashes
 * `fn.toString()` into the audit cache's `engineVersion`, so wrapping every
 * entry would collapse 40 distinct hashes into one and freeze the key — stale
 * audit results would then be served for the full 30-day TTL with no symptom;
 * and `gitBranchCache` is module-scoped, so a per-call factory would silently
 * reset it on every hook event.
 */
const POLICY_IMPLEMENTATIONS: Record<string, PolicyFunction> = {
  "sanitize-jwt": sanitizeJwt,
  "sanitize-api-keys": sanitizeApiKeys,
  "sanitize-connection-strings": sanitizeConnectionStrings,
  "sanitize-private-key-content": sanitizePrivateKeyContent,
  "sanitize-bearer-tokens": sanitizeBearerTokens,
  "protect-env-vars": protectEnvVars,
  "block-env-files": blockEnvFiles,
  "block-read-outside-cwd": blockReadOutsideCwd,
  "block-sudo": blockSudo,
  "block-curl-pipe-sh": blockCurlPipeSh,
  "block-rm-rf": blockRmRf,
  "block-failproofai-commands": blockFailproofaiCommands,
  "block-kubectl": blockKubectl,
  "block-terraform": blockTerraform,
  "block-aws-cli": blockAwsCli,
  "block-gcloud": blockGcloud,
  "block-az-cli": blockAzCli,
  "block-helm": blockHelm,
  "block-gh-pipeline": blockGhPipeline,
  "block-secrets-write": blockSecretsWrite,
  "block-push-master": blockPushMaster,
  "block-force-push": blockForcePush,
  "block-work-on-main": blockWorkOnMain,
  "warn-git-amend": warnGitAmend,
  "warn-git-stash-drop": warnGitStashDrop,
  "warn-git-clean": warnGitClean,
  "warn-all-files-staged": warnAllFilesStaged,
  "warn-destructive-sql": warnDestructiveSql,
  "warn-schema-alteration": warnSchemaAlteration,
  "warn-package-publish": warnPackagePublish,
  "warn-global-package-install": warnGlobalPackageInstall,
  "prefer-package-manager": preferPackageManager,
  "warn-large-file-write": warnLargeFileWrite,
  "warn-background-process": warnBackgroundProcess,
  "warn-repeated-tool-calls": warnRepeatedToolCalls,
  "require-commit-before-stop": requireCommitBeforeStop,
  "require-push-before-stop": requirePushBeforeStop,
  "require-pr-before-stop": requirePrBeforeStop,
  "require-no-conflicts-before-stop": requireNoConflictsBeforeStop,
  "require-ci-green-before-stop": requireCiGreenBeforeStop,
};

/**
 * Catalog and implementations must be in BIJECTION, and this throws rather than
 * warns because the failure is otherwise invisible in the worst direction: a
 * name present here but not there yields `fn: undefined`, `registerPolicy`
 * stores it unvalidated, and the `TypeError` at `await policy.fn(ctx)` is
 * swallowed by `policy-evaluator.ts` (warn, count, `continue`). The hook then
 * ALLOWS, exits 0, and still lists the policy in `matchedPolicies` — a machine
 * reporting that a guard ran when it never did.
 */
function assertCatalogBijection(): void {
  const implNames = new Set(Object.keys(POLICY_IMPLEMENTATIONS));
  const missing = POLICY_CATALOG.filter((e) => !implNames.has(e.name)).map((e) => e.name);
  if (missing.length > 0) {
    throw new Error(
      `failproofai: builtin policies missing an implementation: ${missing.join(", ")}`,
    );
  }
  const catalogNames = new Set(POLICY_CATALOG.map((e) => e.name));
  const orphaned = [...implNames].filter((n) => !catalogNames.has(n));
  if (orphaned.length > 0) {
    throw new Error(
      `failproofai: policy implementations with no catalog entry: ${orphaned.join(", ")}`,
    );
  }
}
assertCatalogBijection();

/**
 * The joined view, and the shape every consumer has always seen.
 *
 * Deliberately a positional, spread-only, eager `.map()`: it preserves catalog
 * order, adds no fields, fills no defaults, drops no rows and calls no factory.
 * Each of those alternatives changes observable behaviour — see the rules on
 * {@link POLICY_CATALOG} and the invariants in
 * `__tests__/hooks/policy-catalog.test.ts`.
 */
export const BUILTIN_POLICIES: BuiltinPolicyDefinition[] = POLICY_CATALOG.map((entry) => ({
  ...entry,
  fn: POLICY_IMPLEMENTATIONS[entry.name] as PolicyFunction,
}));

export function registerBuiltinPolicies(enabledNames: string[]): void {
  // Tolerate both flat ("sanitize-jwt") and qualified ("failproofai/sanitize-jwt")
  // forms in the user's enabledPolicies config — canonicalize both sides.
  const enabledSet = new Set(enabledNames.map(normalizePolicyName));
  for (const policy of BUILTIN_POLICIES) {
    // `alwaysOn` deliberately bypasses the enabled set, and the caller's three
    // ways of producing an empty one with it: a policy the user never enabled,
    // an active session pause (`handler.ts` passes `[]`), and a config file that
    // failed to parse (`hooks-config.ts` soft-fails to `{enabledPolicies: []}`).
    // A guard against the agent disabling failproofai that any of those can
    // switch off is not a guard.
    if (policy.alwaysOn || enabledSet.has(normalizePolicyName(policy.name))) {
      // `alwaysOn` travels with the declaration so the self-protection guard
      // resolves to hard even if its catalog entry ever said otherwise.
      registerPolicy(policy.name, policy.description, policy.fn, policy.match, 0, policy.params, {
        authority: policy.authority,
        reviewedBy: policy.reviewedBy,
        alwaysOn: policy.alwaysOn,
      });
    }
  }
}

/** Clears the git branch cache. Exposed for test isolation only. */
export function clearGitBranchCache(): void {
  gitBranchCache.clear();
}
