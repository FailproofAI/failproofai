/**
 * Built-in security policies for Claude Code hooks.
 */
import { resolve, join } from "node:path";
import { lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
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
 * its own protections.
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
 * The path component `name` (regex source), only where it STARTS a component:
 * at the start, after a path separator, or after what ends a shell word —
 * whitespace, a quote, `=`, `:`, `;`, `|`, `&`, a redirect, a bracket of a
 * subshell or a brace list, a comma — or glued to a cluster of short options
 * (`wget -Onode_modules/…`, `wget -qO.pnpm/…`), which is how those tools take an
 * output file. Anything else in front of it is part of the same name, so it is
 * a different directory: `cached_node_modules/…`, `my-node_modules/…` and
 * `fixture+node_modules/…` are somebody's fixtures. A list of what may come
 * before, not of what may not — the second kind is never finished.
 *
 * The check is a lookbehind placed AFTER the name, so it runs only where the
 * name already matched. A variable-length lookbehind in FRONT of the name ran
 * at every position of the input and rescanned a whole run of letters each
 * time: a command carrying 32,000 letters took 35 s in the guard, long enough
 * to time a hook out. Here each match scans back over the letters just before
 * it, and those runs cannot overlap — every name ends in a non-letter (`_` in
 * `node_modules`, the `.` that starts `.pnpm`) — so the cluster needs no bound,
 * and a long one (`-qqqq…O<path>`) is not a way past.
 */
function pathComponent(name: string): string {
  return String.raw`${name}(?<=(?:^|[\\/\s"'\`=:;|&<>(){},])${name}|(?:^|\s)-[A-Za-z]+${name})`;
}

/**
 * failproofai's INSTALLED CODE: the package a hook command runs, and the bin
 * entry that names it.
 *
 * User-scope hooks run the absolute path `which failproofai` returned at
 * install time. Under nvm, Homebrew, Volta, bun, pnpm and the npx cache that is
 * a package directory the agent's own user can write, and the hook client runs
 * fresh from it on every tool call — so `process.exit(0)` written over
 * `dist/cli.mjs` turned every later hook into an allow, for every session on
 * the machine, with nothing reporting it. The daemon cannot catch that: a
 * tampered client never asks it. The state pattern below needs a `.` the
 * package path does not have (FailproofAI/agenteye#1796).
 *
 * Project-scope hooks are portable instead: `npx -y failproofai --hook …`, so
 * the committed file names no machine's path. npx runs a
 * `node_modules/.bin/failproofai` it finds in the project, or in ANY directory
 * above it, before the global install or its own cache, without checking what
 * the file is. So one Write of `exit 0` to that path turned every later hook in
 * that tree into an allow, and kept doing it in every later session
 * (FailproofAI/agenteye#1795). That entry is matched below too.
 *
 * A checkout of this repository matches none of the shapes below — no
 * `node_modules` above it, and its entry is `bin/failproofai.mjs` — so the guard
 * does not stand in front of working on failproofai itself.
 *
 * Case-insensitive because macOS volumes are by default: every casing of these
 * paths opens the real file. `(?:\.?[\\/])*` absorbs the `//` and `/./` a path
 * resolver collapses. This matches the path as WRITTEN: a shell spelling that
 * only the shell resolves — `..`, a `cd` before a relative path, a command
 * substitution — is beyond it, as it is for the state (see `stripShellQuoting`).
 * The file tools also check the path a write really lands on (`resolveWriteTarget`).
 */
const FAILPROOFAI_CODE_PATH_RE = new RegExp(
  [
    // The package, in every layout a package manager uses, and the daemon's
    // platform package, which `failproofai config` and `update` copy into place
    // (on Linux as root, under `/opt`). `node_modules` as a whole path
    // component (`pathComponent`).
    pathComponent("node_modules") +
      String.raw`[\\/](?:\.?[\\/])*(?:failproofai(?![\w.@-])|@failproofai[\\/](?:\.?[\\/])*failproofaid\b)`,
    // pnpm's virtual store, which holds each package one directory above its
    // own `node_modules/failproofai`. The daemon's entry is recognised by its
    // name alone, so a glob over its platform or version
    // (`@failproofai+failproofaid-*@*`) still names it.
    pathComponent(String.raw`\.pnpm`) + String.raw`[\\/](?:\.?[\\/])*(?:failproofai@|@failproofai\+failproofaid\b)`,
    // The entry a hook command names: `…/bin/failproofai` for npm, nvm,
    // Homebrew, bun, Volta and yarn, `…/pnpm/failproofai` for pnpm's home, and
    // the variables nvm and pnpm export for those directories. A FILE, so a
    // directory of that name (`~/bin/failproofai/src/…`) is not it.
    String.raw`(?:[\\/](?:bin|pnpm)|\$\{?(?:NVM_BIN|PNPM_HOME)\}?)[\\/](?:\.?[\\/])*failproofai(?:\.cmd|\.ps1)?(?![\w.@\\/-])`,
    // The entry `npx -y failproofai` runs first: `.bin/failproofai` in a
    // `node_modules` of the project or of any directory above it (and in the
    // npx cache). With the shims npm (`.cmd`, `.ps1`) and bun (`.exe`, `.bunx`)
    // write beside it on Windows. Not anchored on `node_modules`, so the
    // relative `.bin/failproofai` a command run from inside `node_modules`
    // names is the same file. `.bin` must start a path component
    // (`pathComponent`), so `firmware.bin/failproofai` is not it, while
    // `>.bin/…` and a short option the path is glued to (`-O.bin/…`,
    // `-so.bin/…`) are. A FILE, like the entry above: the rest of
    // `node_modules/.bin` (every other package's binary, run by path all the
    // time) stays out of it.
    pathComponent(String.raw`\.bin`) +
      String.raw`[\\/](?:\.?[\\/])*failproofai(?:\.(?:cmd|ps1|exe|bunx))?(?![\w.@\\/-])`,
  ].join("|"),
  "i",
);

/**
 * failproofai's own files: its state, and the installed code above.
 *
 * Named for the state, which came first. The code joined it because writing
 * over it switches enforcement off as completely as deleting the state does,
 * and every use of this pattern — the file tools, the shell walk, the variable
 * and glob tracking — has to see both.
 *
 * Named separately from the binary walk because it never mentions the binary:
 * the target is a path, and the verb is an ordinary file command.
 */
const FAILPROOFAI_STATE_PATH_RE = new RegExp(
  String.raw`\.failproofai(?:\/|\b)|` + FAILPROOFAI_CODE_PATH_RE.source,
  "i",
);

/**
 * Which of failproofai's own files `path` names, for a deny message that says
 * which. Tool input is untrusted JSON, so a non-string is read the way
 * `RegExp.test` always read it — as its string form — rather than waved through.
 */
function failproofaiFileKind(path: unknown): "state" | "code" | null {
  if (path === undefined || path === null || path === "") return null;
  const text = String(path);
  if (!FAILPROOFAI_STATE_PATH_RE.test(text)) return null;
  return FAILPROOFAI_CODE_PATH_RE.test(text) ? "code" : "state";
}

/**
 * The file a write to `path` actually changes, every symlink resolved.
 *
 * A file tool writes THROUGH a link, so the path it is handed is not
 * necessarily the one it changes — and npm, nvm and bun install the
 * `failproofai` bin entry as exactly such a link into the package.
 *
 * Walked one component at a time, the way the kernel resolves a path: a link is
 * expanded where it stands, and a `..` after it steps out of what it points at.
 * `path.resolve` and Node's `realpathSync` both collapse `..` as TEXT first, so
 * a write to `<link-to-pkg/dist>/../dist/cli.mjs` resolved to a harmless path
 * while `open(2)` wrote the CLI. A component that does not exist is walked as
 * the plain directory a write tool's `mkdir -p` would make of it — NOT taken as
 * the end of the walk: `missing/../alias.mjs` steps straight back out, and
 * `alias.mjs` can be a link into the package (found in review, PR #1050).
 * A relative path is taken from the session's directory, not this process's —
 * the daemon's worker runs somewhere else entirely — and `~` from home.
 *
 * "" when nothing resolves. Never throws, whatever the tool input holds: a
 * throw here would take the always-on guard out of the evaluation.
 */
function resolveWriteTarget(path: unknown, cwd: unknown): string {
  if (typeof path !== "string" || path === "") return "";
  try {
    const expanded = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
    const start = expanded.startsWith("/")
      ? expanded
      : typeof cwd === "string" && cwd.startsWith("/")
        ? `${cwd}/${expanded}`
        : "";
    if (!start) return "";
    const pending = start.split("/");
    let resolved = ""; // "" is the root
    for (let links = 0; pending.length > 0; ) {
      const part = pending.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        resolved = resolved.slice(0, resolved.lastIndexOf("/"));
        continue;
      }
      const next = `${resolved}/${part}`;
      let isLink = false;
      try {
        isLink = lstatSync(next).isSymbolicLink();
      } catch {
        // Missing or unreadable: a plain directory once created, so walk on.
      }
      if (!isLink) {
        resolved = next;
        continue;
      }
      // The kernel's own bound on a chain of links (MAXSYMLINKS).
      if (++links > 40) return "";
      const target = readlinkSync(next);
      if (target.startsWith("/")) resolved = "";
      pending.unshift(...target.split("/"));
    }
    return resolved || "/";
  } catch {
    return "";
  }
}

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
 * Commands that put a file into a directory under the file's OWN name, and the
 * options of each that take a value, short and long.
 *
 * `cp /tmp/stage/failproofai node_modules/.bin/` writes
 * `node_modules/.bin/failproofai`, and that path appears nowhere on the line:
 * the source names a scratch file and the destination names a directory that
 * holds every package's binary. So the name a source would land under is
 * judged as well as the operands as written (FailproofAI/agenteye#1795).
 * A value is not a source: `install -o failproofai -m 0755 agentd /usr/local/bin/`
 * installs `agentd`. `t` is the target directory for all but rsync, where it
 * is `--times`, and scp, which has none. scp's `-T` is not `--no-target-directory`
 * and its `-R` is not recursive.
 */
type IntoDirectoryOptions = { short: string; values: readonly string[]; flags: readonly string[] };

// A Map, not an object literal: a command named `constructor` or `__proto__`
// must not find Object.prototype's member here, or the walk throws and the
// evaluator skips this always-on policy (found by CodeRabbit on #1058).
const INTO_DIRECTORY_OPTIONS = new Map<string, IntoDirectoryOptions>(Object.entries({
  // From each command's `--help` (GNU coreutils 9, rsync 3.4.1): `values` take
  // one, `flags` take none or only an `=VALUE` glued on.
  cp: {
    short: "St",
    values: ["no-preserve", "sparse", "suffix", "target-directory"],
    flags: [
      "archive", "attributes-only", "backup", "context", "copy-contents", "debug", "dereference", "force", "help",
      "interactive", "keep-directory-symlink", "link", "no-clobber", "no-dereference", "no-target-directory",
      "one-file-system", "parents", "preserve", "recursive", "reflink", "remove-destination",
      "strip-trailing-slashes", "symbolic-link", "update", "verbose", "version",
    ],
  },
  mv: {
    short: "St",
    values: ["suffix", "target-directory"],
    flags: [
      "backup", "context", "debug", "exchange", "force", "help", "interactive", "no-clobber", "no-copy",
      "no-target-directory", "strip-trailing-slashes", "update", "verbose", "version",
    ],
  },
  ln: {
    short: "St",
    values: ["suffix", "target-directory"],
    flags: [
      "backup", "force", "help", "interactive", "logical", "no-dereference", "no-target-directory", "physical",
      "relative", "symbolic", "verbose", "version",
    ],
  },
  install: {
    short: "mogSt",
    values: ["group", "mode", "owner", "strip-program", "suffix", "target-directory"],
    flags: [
      "backup", "compare", "context", "directory", "help", "no-target-directory", "preserve-context",
      "preserve-timestamps", "strip", "unprivileged", "verbose", "version",
    ],
  },
  rsync: {
    short: "@BefMT",
    values: [
      "address", "backup-dir", "block-size", "bwlimit", "cc", "checksum-choice", "checksum-seed", "chmod", "chown",
      "compare-dest", "compress-choice", "compress-level", "contimeout", "copy-as", "copy-dest", "debug",
      "early-input", "exclude", "exclude-from", "files-from", "filter", "groupmap", "iconv", "include",
      "include-from", "info", "link-dest", "log-file", "log-file-format", "max-alloc", "max-delete", "max-size",
      "min-size", "modify-window", "only-write-batch", "outbuf", "out-format", "partial-dir", "password-file",
      "port", "protocol", "read-batch", "remote-option", "rsh", "rsync-path", "skip-compress", "sockopts",
      "stop-after", "stop-at", "suffix", "temp-dir", "timeout", "usermap", "write-batch", "zc", "zl",
    ],
    flags: [
      "acls", "append", "append-verify", "archive", "atimes", "backup", "blocking-io", "checksum", "compress",
      "copy-devices", "copy-dirlinks", "copy-links", "copy-unsafe-links", "crtimes", "cvs-exclude", "daemon", "del",
      "delay-updates", "delete", "delete-after", "delete-before", "delete-delay", "delete-during",
      "delete-excluded", "delete-missing-args", "devices", "dirs", "dry-run", "executability", "existing",
      "fake-super", "force", "from0", "fsync", "fuzzy", "group", "hard-links", "help", "human-readable",
      "ignore-errors", "ignore-existing", "ignore-missing-args", "ignore-times", "inplace", "ipv4", "ipv6",
      "itemize-changes", "keep-dirlinks", "links", "list-only", "mkpath", "munge-links", "no-implied-dirs",
      "no-motd", "numeric-ids", "old-args", "old-d", "old-dirs", "omit-dir-times", "omit-link-times",
      "one-file-system", "open-noatime", "owner", "partial", "perms", "preallocate", "progress",
      "prune-empty-dirs", "quiet", "recursive", "relative", "remove-source-files", "safe-links", "secluded-args",
      "size-only", "sparse", "specials", "stats", "stderr", "super", "times", "trust-sender", "update", "verbose",
      "version", "whole-file", "write-devices", "xattrs",
    ],
  },
  // OpenSSH 9's `scp` synopsis: no long options.
  scp: { short: "cDFiJloPSX", values: [], flags: [] },
} satisfies Record<string, IntoDirectoryOptions>));

/**
 * The long option `name` stands for, and whether it takes a value: an exact
 * name first, so `--partial` is not read as an abbreviation of
 * `--partial-dir` and made to swallow the next word, then the one option an
 * abbreviation can only mean. Ambiguous or unknown, the command refuses to run.
 */
function longOptionOf(
  options: { values: readonly string[]; flags: readonly string[] },
  name: string,
): { full: string; value: boolean } | undefined {
  if (options.values.includes(name)) return { full: name, value: true };
  if (options.flags.includes(name)) return { full: name, value: false };
  const matches = [
    ...options.values.filter((full) => full.startsWith(name)).map((full) => ({ full, value: true })),
    ...options.flags.filter((full) => full.startsWith(name)).map((full) => ({ full, value: false })),
  ];
  return name.length > 0 && matches.length === 1 ? matches[0] : undefined;
}

/**
 * npm's bin directory, `node_modules/.bin`. A directory moved, linked or copied
 * recursively ONTO it brings entries the line never names:
 * `ln -s /tmp/stage ~/node_modules/.bin` hands every project under `~` without
 * its own entry a `failproofai` from `/tmp/stage`, because npx searches each
 * parent's `.bin` (#1795). Only npm's: `~/.bin` is somebody's own scripts.
 */
const NPM_BIN_DIRECTORY_RE = /(?:^|[\\/])node_modules[\\/](?:\.?[\\/])*\.bin$/i;

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
 */
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set([
  "clean", "rm", "restore", "checkout", "reset", "stash",
]);

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

/** `NAME=value` or `export NAME=value`, quoted or not, wherever it sits. */
const ASSIGNMENT_RE = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g;

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
  // The installed code (FAILPROOFAI_CODE_PATH_RE): a project install, and the
  // global locations whose prefix is the same on every machine. nvm's version
  // directory and the npx cache's hash are not, so a glob under those is not one
  // this list can anticipate; the literal paths there still match.
  "node_modules/failproofai",
  "./node_modules/failproofai",
  "node_modules/.pnpm/failproofai@1.0.0",
  "./node_modules/.pnpm/failproofai@1.0.0",
  // The daemon's platform package, in pnpm's store and in its scope, for each
  // platform it ships to, so a glob that wildcards its name is still read as
  // aimed at it (`node_modules/.pnpm/@failproofai+*`, `node_modules/@failproofai/f*`).
  ...["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].flatMap((platform) => [
    `node_modules/.pnpm/@failproofai+failproofaid-${platform}@1.0.0`,
    `./node_modules/.pnpm/@failproofai+failproofaid-${platform}@1.0.0`,
    `node_modules/@failproofai/failproofaid-${platform}`,
    `./node_modules/@failproofai/failproofaid-${platform}`,
  ]),
  "/usr/local/lib/node_modules/failproofai",
  "/usr/lib/node_modules/failproofai",
  "/opt/homebrew/lib/node_modules/failproofai",
  "/usr/local/bin/failproofai",
  "/opt/homebrew/bin/failproofai",
  "~/.bun/bin/failproofai",
  "~/.volta/bin/failproofai",
  // The entry a project-scope `npx -y failproofai` runs (FailproofAI/agenteye#1795),
  // and the Windows shims beside it.
  ...["", ".cmd", ".ps1", ".exe", ".bunx"].flatMap((shim) => [
    `node_modules/.bin/failproofai${shim}`,
    `./node_modules/.bin/failproofai${shim}`,
    `.bin/failproofai${shim}`,
  ]),
];

/** How many `/`-separated segments the deepest glob candidate has. */
const GLOB_CANDIDATE_DEPTH = Math.max(...STATE_GLOB_CANDIDATES.map((candidate) => candidate.split("/").length));

/**
 * The candidates a mid-path stretch is tried against: the relative ones of two
 * segments or more (`node_modules/failproofai`, `node_modules/.bin/failproofai`),
 * which stand for the same files under any directory.
 */
const MULTI_SEGMENT_GLOB_CANDIDATES = STATE_GLOB_CANDIDATES.filter(
  (candidate) => /^[^~/$]/.test(candidate) && candidate.replace(/^\.\//, "").includes("/"),
);

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
  // Neighbours of the installed-code candidates, so `rm -rf node_modules/*` and
  // its global equivalents are read as the sweeps they are.
  "node_modules/react", "node_modules/.bin", "./node_modules/react", "node_modules/.pnpm/react@18.0.0",
  "./node_modules/.pnpm/react@18.0.0",
  "node_modules/.pnpm/@types+node@20.0.0", "./node_modules/.pnpm/@types+node@20.0.0",
  "node_modules/@types/node", "./node_modules/@types/node",
  "/usr/local/lib/node_modules/npm", "/usr/lib/node_modules/npm", "/opt/homebrew/lib/node_modules/npm",
  "/usr/local/bin/node", "/opt/homebrew/bin/node", "~/.bun/bin/bun", "~/.volta/bin/node",
  // Other packages' entries beside it, so `rm -rf node_modules/.bin/*` is the
  // sweep it is rather than an aim at failproofai's.
  "node_modules/.bin/tsc", "./node_modules/.bin/tsc", ".bin/tsc",
  "node_modules/.bin/tsc.cmd", "./node_modules/.bin/tsc.cmd", ".bin/tsc.cmd",
  // Another dotfile ending in `ai`, so the `.*ai` of a sed program is a sweep.
  ".openai",
];

/**
 * True when this token is a glob that could expand onto failproofai's state.
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
function globCouldNameState(raw: string): boolean {
  // Both readings of a trailing `)`: part of the pattern, and the close of a
  // subshell that wrapped it. Trying both is safe in the way widening always is
  // here — the decoy test still has to pass.
  const stripped = raw.replace(/^[()]+|[()]+$/g, "");
  return globWordCouldNameState(raw) || (stripped !== raw && globWordCouldNameState(stripped));
}

function globWordCouldNameState(token: string): boolean {
  if (!GLOB_METACHAR_RE.test(token)) return false;
  // Braces FIRST, because that is the order the shell works in: brace expansion
  // rewrites the word into several words, and only then is each one matched
  // against the disk. Compiling `{a*,x}` as an alternation of escaped literals
  // put a literal `*` inside the pattern, so `~/.f{a*,x}ilproofai` — which the
  // shell turns into `~/.fa*ilproofai` and then into `~/.failproofai` — read as
  // naming nothing at all.
  for (const word of expandBraces(token)) {
    if (wordNamesState(word)) return true;
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
function wordNamesState(word: string): boolean {
  if (FAILPROOFAI_STATE_PATH_RE.test(word)) return true;
  // Every path PREFIX, not just the whole word. The candidates are the state
  // directory itself, so `~/.f*ailproofai/policies-config.json` — a glob in a
  // segment that is not the last one — compiled to a pattern that could never
  // equal `~/.failproofai` and was read as naming nothing. Naming a file INSIDE
  // the state is naming the state.
  // `//`, `/./` and `..` change nothing a shell opens (`~//.failproof*`), and
  // somebody else's home is the same place as the candidates' `/home/u`:
  // `/home/alice/.failproof*` and `~alice/.failproof*` named nothing.
  const segments = (/\/\/|(?:^|\/)\.\.?\//.test(word) ? shellPath(undefined, word) : word)
    .replace(/^\/(home|Users)\/[^/]+(?=\/)/, "/$1/u")
    .replace(/^~[A-Za-z0-9._-]+(?=\/)/, "~")
    .split("/");
  // A prefix with more segments than the deepest candidate cannot equal one:
  // a compiled `*` never crosses a `/`.
  for (let end = 1; end <= Math.min(segments.length, GLOB_CANDIDATE_DEPTH); end++) {
    if (globPrefixNamesState(segments.slice(0, end).join("/"))) return true;
  }
  // And every stretch that starts after a `/`, because the paths the
  // multi-segment candidates stand for can sit under any directory:
  // `/work/proj/node_modules/.bin/fail*` named nothing as a whole word
  // (FailproofAI/agenteye#1795). A one-segment stretch only when it starts
  // with a literal `.`: a shell's `*` never matches a dotfile, so `models/*ai`
  // cannot reach `.failproofai`, while `/var/lib/jenkins/.failproof*` — a home
  // no candidate spells — can.
  for (let start = 1; start < segments.length; start++) {
    const last = Math.min(segments.length, start + GLOB_CANDIDATE_DEPTH);
    const first = segments[start].startsWith(".") ? start + 1 : start + 2;
    for (let end = first; end <= last; end++) {
      const candidates = end - start === 1 ? STATE_GLOB_CANDIDATES : MULTI_SEGMENT_GLOB_CANDIDATES;
      if (globPrefixNamesState(segments.slice(start, end).join("/"), candidates)) return true;
    }
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
function globPrefixNamesState(token: string, candidates: readonly string[] = STATE_GLOB_CANDIDATES): boolean {
  if (!GLOB_METACHAR_RE.test(token)) return false;
  const pattern = "^" + compileGlobPattern(token);
  let re: RegExp;
  try {
    // Case-insensitive, like FAILPROOFAI_STATE_PATH_RE: on a default macOS
    // volume `NODE_MODULES/fail*` reaches the real `node_modules/failproofai`,
    // because the literal parent is resolved by the filesystem.
    re = new RegExp(pattern + "$", "i");
  } catch {
    return false;
  }
  if (!candidates.some((candidate) => re.test(candidate))) return false;
  return !GLOB_DECOYS.some((decoy) => re.test(decoy));
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
    if (command[i] === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) break;
      bodies.push(command.slice(i + 1, close));
      i = close;
      continue;
    }
    if (command[i] !== "$" || command[i + 1] !== "(") continue;
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
 * the literal check reads, and `globCouldNameState` tries the stripped form too.
 */
function unquotedToken(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, "");
}

/** The name a shell would exec, given a token: `/usr/bin/rm` → `rm`. */
function commandBasename(token: string): string {
  const bare = bareToken(token);
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/** A redirect operator, with an optional fd (`2>`, `{fd}>`), and the same alone. */
const REDIRECT_OPERATOR_RE = /^(?:\d*|\{[A-Za-z_]\w*\})(?:>{1,2}\|?|<{1,3})/;
const LONE_REDIRECT_OPERATOR_RE = /^(?:\d*|\{[A-Za-z_]\w*\})(?:>{1,2}\|?|<{1,3})$/;

/**
 * A simple command split the way a shell splits it: on whitespace outside
 * quotes, so `-H 'X-Ticket: #1795'` is one word. `quoted` says the word starts
 * inside quotes or with an escape, where `#` and `>` are characters, not a
 * comment or a redirect.
 */
function shellWords(text: string): Array<{ raw: string; quoted: boolean }> {
  const words: Array<{ raw: string; quoted: boolean }> = [];
  let current = "";
  let started = false;
  let quoted = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === null && /\s/.test(ch)) {
      if (started) words.push({ raw: current, quoted });
      current = "";
      started = false;
      continue;
    }
    if (!started) {
      started = true;
      quoted = ch === "'" || ch === '"' || ch === "\\";
    }
    current += ch;
    if (ch === "\\" && quote !== "'" && i + 1 < text.length) {
      current += text[++i];
    } else if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
    } else if (ch === quote) {
      quote = null;
    }
  }
  if (started) words.push({ raw: current, quoted });
  return words;
}

/**
 * Walk off everything a shell resolves before it settles on the command word,
 * and return the words from the command word on. Mirrors the walk in
 * `classifySelfInvocation` — the same prefixes hide a deleter that hid the
 * binary, and `xargs -0 rm -f` is the one that matters most here.
 *
 * Redirects and a comment are not words, after the command word either. The
 * copy checks take the LAST operand for the destination, so a redirect or a
 * comment after it became the destination they judged:
 * `cp /dev/null ~/.failproofai/policies-config.json 2>/dev/null` and
 * `… node_modules/.bin/failproofai # keep` both walked through, while
 * `uniq -c < <state file>` read the file it only reads as one it writes. Split
 * on whitespace alone, a quoted `#` or `<` cut off the real words after it, so
 * the command is split the way a shell splits it (`shellWords`)
 * (FailproofAI/agenteye#1795). A command word starting with `#` is a comment line.
 */
function commandWordList(simpleCommand: string): string[] {
  const split = (text: string) => shellWords(text).map(({ raw, quoted }) => ({ raw, quoted, token: bareToken(raw) }));
  const all = split(simpleCommand.trim());
  let i = 0;
  for (let programs = 0; i < all.length; ) {
    const { raw, quoted, token } = all[i];
    if (token === "") {
      i++;
      continue;
    }
    // A quoted word where the command goes is a program handed to a shell
    // (`bash -c 'rm -rf …'`): its own words are the command.
    if (quoted && /\s/.test(token) && programs++ < 4) {
      all.splice(i, 1, ...split(token));
      continue;
    }
    // A redirect operator and, when it stands alone, the token it targets —
    // `> file` must not leave `file` sitting where the command word goes.
    if (!quoted && REDIRECT_OPERATOR_RE.test(raw)) {
      i += LONE_REDIRECT_OPERATOR_RE.test(raw) ? 2 : 1;
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
  const words: string[] = [];
  for (let j = i; j < all.length; j++) {
    const { raw, quoted, token } = all[j];
    if (!quoted && raw.startsWith("#")) break;
    if (j > i && !quoted && REDIRECT_OPERATOR_RE.test(raw)) {
      if (LONE_REDIRECT_OPERATOR_RE.test(raw)) j++;
      continue;
    }
    words.push(token);
  }
  return words;
}

/**
 * True when a copy, move or link writes a protected path that its words never
 * spell (see `INTO_DIRECTORY_OPTIONS`), or puts a directory onto npm's bin
 * directory (see `NPM_BIN_DIRECTORY_RE`).
 *
 * The destination is `-t`'s value in any spelling (`-t DIR`, `-tDIR`, `-vt DIR`,
 * `--target-directory=DIR`, `--target DIR`), or else the last operand. Each
 * source is judged where it would land, `<destination>/<its name>`. Whether the
 * destination really is a directory is not checked: when it is a file, that
 * path is one nothing writes, and it matches only when a source is named like a
 * protected file and the destination like the directory that holds one.
 *
 * A source that is itself protected is a copy OUT, so it counts only when it
 * lands on installed code: `cp -r ~/.failproofai /tmp/backup/` lands at
 * `/tmp/backup/.failproofai`, which the state pattern matches by name, and is a
 * backup; `cp /tmp/bin/failproofai node_modules/.bin/` is not, however its
 * source is spelled. A source ending in a separator copies what is IN it, whose
 * names are not on the line, so it is judged only through the bin-directory
 * check. `inShell` resolves a relative word against a `cd` the walk followed;
 * `lost` says the walk could not follow one, so a relative destination may be
 * npm's bin directory and the entry's own name there is refused.
 * `landsOnState` judges where a written path really lands, symlinks followed.
 */
function landsInDirectoryAs(
  words: string[],
  namesState: (text: string) => boolean,
  inShell: (word: string) => string = (word) => word,
  lost = false,
  landsOnState: (written: string) => boolean = () => false,
  isBinDir: (written: string) => boolean = () => false,
): boolean {
  if (words.length === 0) return false;
  const head = commandBasename(words[0]);
  const options = INTO_DIRECTORY_OPTIONS.get(head);
  if (!options) return false;
  const operands: string[] = [];
  let directory: string | undefined;
  let createsDirectories = false;
  let recursive = false;
  let ontoItself = false;
  const args = words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const value = eq === -1 ? undefined : arg.slice(eq + 1);
      // GNU takes any unambiguous prefix of a long option: `--target DIR` is
      // `--target-directory`, `--rec` is `--recursive`, `--suf x` is `--suffix x`.
      const option = longOptionOf(options, name);
      if (option?.full === "target-directory") {
        directory = value ?? args[++i];
      } else if (option?.value) {
        if (value === undefined) i++;
      } else if (option?.full === "recursive" || option?.full === "archive") {
        recursive = true;
      } else if (option?.full === "no-target-directory") {
        ontoItself = true;
      } else if (option?.full === "directory" && head === "install") {
        createsDirectories = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let c = 1; c < arg.length; c++) {
        const flag = arg[c];
        if (options.short.includes(flag)) {
          // The rest of the cluster is the value, or else the next word is.
          const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i];
          if (flag === "t" && head !== "rsync") directory = value;
          break;
        }
        if (flag === "r" || ((flag === "R" || flag === "a") && head !== "scp")) recursive = true;
        if (flag === "T" && head !== "rsync" && head !== "scp") ontoItself = true;
        if (flag === "d" && head === "install") createsDirectories = true;
      }
      continue;
    }
    operands.push(arg);
  }
  if (createsDirectories) return false;

  // `ln -s <target>` alone links it into the current directory.
  const sources = directory !== undefined ? operands : head === "ln" && operands.length === 1 ? operands : operands.slice(0, -1);
  const written = directory ?? (head === "ln" && operands.length === 1 ? "." : operands[operands.length - 1]);
  if (written === undefined || sources.length === 0) return false;
  // `host:path` is somewhere else's disk.
  if (head === "scp" && /^[^/\\]{2,}:/.test(written)) return false;
  const destination = inShell(written);
  if (directory === undefined && (namesState(destination) || landsOnState(written))) return true;
  const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (lost && directory === undefined && relativeWord(written) && couldBeEntryName(baseName(written))) return true;

  const into = destination.replace(/(?:[\\/]+\.?)+$/, "");
  // A directory becomes npm's bin directory when it is moved, linked or copied
  // recursively onto a path that does not exist yet. `-t` needs a directory
  // that exists, and so does `ln` given a trailing separator, so neither can.
  // Copying what is IN a directory (`src/.`, rsync's `src/`, `-T`) fills an
  // existing one with names that are not on the line.
  // rsync never makes the destination a copy of a source directory: it puts
  // `src` inside it, or with `src/` what is in `src`.
  const createsDirectory =
    directory === undefined &&
    !(head === "ln" && /[\\/]$/.test(written)) &&
    (head === "mv" || head === "ln" || (recursive && head !== "rsync"));
  const copiesContents = recursive && (ontoItself || sources.some((s) => /[\\/]\.?$/.test(s)));
  // The destination as written, or wherever a link there points.
  const intoBin = NPM_BIN_DIRECTORY_RE.test(into) || isBinDir(written);
  if (intoBin && (createsDirectory || copiesContents)) return true;
  if (into === "" || ontoItself) return false;
  return sources.some((source) => {
    // A trailing separator keeps the directory's own name everywhere but rsync,
    // where `src/` means what is in it.
    if (head === "rsync" && /[\\/]$/.test(source)) return false;
    // A remote source (`host:path`) lands under the name after the host.
    const local = head === "scp" || head === "rsync" ? source.replace(/^[^/\\]{2,}:/, "") : source;
    const name = baseName(local.replace(/[\\/]+$/, ""));
    if (name === "" || name === "." || name === "..") return false;
    if (lost && relativeWord(into) && couldBeEntryName(name)) return true;
    const landing = `${into}/${name}`;
    // A directory named `.bin` landing in a `node_modules` is the same swap.
    const writtenLanding = `${written.replace(/[\\/]+$/, "")}/${name}`;
    if (
      (NPM_BIN_DIRECTORY_RE.test(landing) || isBinDir(writtenLanding)) &&
      (head === "mv" || head === "ln" || recursive)
    ) {
      return true;
    }
    // A glob source puts names the line does not spell into the directory.
    if (intoBin && GLOB_METACHAR_RE.test(name) && globCouldBeEntry(name)) return true;
    if (!namesState(landing) && !landsOnState(`${written.replace(/[\\/]+$/, "")}/${name}`)) return false;
    return !namesState(inShell(source)) || FAILPROOFAI_CODE_PATH_RE.test(landing) || landsOnState(`${written.replace(/[\\/]+$/, "")}/${name}`);
  });
}

/** The entry's own name and the Windows shims npm and bun write beside it. */
const ENTRY_NAMES = ["failproofai", "failproofai.cmd", "failproofai.ps1", "failproofai.exe", "failproofai.bunx"];

/** True when a one-segment glob could expand to the entry's name or a shim's. */
function globCouldBeEntry(name: string): boolean {
  try {
    const pattern = new RegExp(`^${compileGlobPattern(name)}$`, "i");
    return ENTRY_NAMES.some((entry) => pattern.test(entry));
  } catch {
    return true;
  }
}

/**
 * True when this one simple command would destroy whatever it is pointed at.
 *
 * Reached only for a command that already names failproofai's state, so the
 * question is narrow: is this a read, or is it everything else.
 */
function simpleCommandDestroys(words: string[], namesState: (text: string) => boolean): boolean {
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
    if (args.some((a) => a.startsWith("-i") || a.startsWith("--in-place"))) return true;
    // The filename may ride in the same token (`'s/a/b/w<path>'`) or in the
    // next one, because a quoted script containing a space is two tokens by the
    // time it gets here. `s/a/b/w` and a bare `w` both end in a `w` that
    // follows a delimiter, which is what separates them from a word like `raw`.
    return args.some(
      (a, i) => /(?:^|[;}/\s])w$/.test(a) && namesState(args[i + 1] ?? ""),
    ) || args.some((a) => /(?:^|[;}/\s])w\s*\S*\.failproofai/.test(a));
  }

  // `awk` can run a shell (`system("rm -rf …")`) or pipe into one, so its
  // program has to be read for those two, not just for the `>` the redirect
  // scan already catches.
  if (head === "awk" || head === "gawk" || head === "mawk") {
    return args.some((a) => /system\s*\(|\|\s*["']|\|&/.test(a));
  }

  // Copying the state OUT is a backup. Copying anything ONTO it — classically
  // `/dev/null` — empties it without naming a delete verb. The destination is
  // the last operand, unless `-t` names it instead: `cp -t ~/.failproofai
  // /dev/null` puts the destination FIRST and left the last operand innocent.
  if (COPY_COMMANDS.has(head)) {
    // `rsync --remove-source-files` deletes what it just copied, so the state
    // being the SOURCE — the shape that makes every other copy a backup — is
    // what makes this one a move.
    if (args.includes("--remove-source-files") && args.some((a) => namesState(a))) return true;
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
    return subcommand !== undefined && GIT_DESTRUCTIVE_SUBCOMMANDS.has(subcommand);
  }

  // A reader whose destination arrives as an option rather than as an operand.
  // Checked before the allowlist, or `sort -o <state> /dev/null` reads as the
  // `sort` it is named after.
  if (writesViaOutputFlag(head, args, namesState)) return true;

  if (STATE_READ_COMMANDS.has(head) || STATE_MENTION_COMMANDS.has(head)) return false;
  return true;
}

/**
 * True when a flag on this command names the state as an output file.
 *
 * `sort -o`, `tree -o` and `curl -o` all take their destination as an option,
 * so nothing about the head or the operand order says they are writing — and
 * all three heads were on a list that said they only read. Short options bundle
 * (`curl -sfo <file>`), so the trailing letter is what decides.
 */
function writesViaOutputFlag(head: string, args: string[], namesState: (text: string) => boolean): boolean {
  const flags = OUTPUT_FLAG_COMMANDS[head];
  if (!flags) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const long = flags.find((f) => f.startsWith("--") && arg.startsWith(`${f}=`));
    if (long && (namesState(arg) || namesState(arg.slice(long.length + 1)))) return true;
    const bundled = /^-[A-Za-z]*[oD]$/.test(arg) && flags.includes(`-${arg[arg.length - 1]}`);
    if ((flags.includes(arg) || bundled) && namesState(args[i + 1] ?? "")) return true;
    // Or the value glued on, after the option alone or at the end of a
    // cluster: `curl -o<file>`, `curl -so<file>`.
    if (/^-[A-Za-z]/.test(arg)) {
      for (let c = 1; c < arg.length - 1 && /[A-Za-z]/.test(arg[c]); c++) {
        if (flags.includes(`-${arg[c]}`) && namesState(arg.slice(c + 1))) return true;
      }
    }
  }
  return false;
}

/** wget's short options that take a value (`wget --help`, GNU Wget 1.21). */
const WGET_VALUE_OPTIONS = "eoaiBtOTwQPlARDIXU";

/** curl's short options that take a value (`curl --help all`, curl 8). */
const CURL_VALUE_OPTIONS = "AbcCdDEeFHKmoPQrTtuUwxXyYz";

/** Short options that take a value, for the commands whose list is known. */
const SHORT_VALUE_OPTIONS: Record<string, string> = { curl: CURL_VALUE_OPTIONS, wget: WGET_VALUE_OPTIONS };

/** More letters than a short-option cluster has when written to be read. */
const MAX_OPTION_CLUSTER = 32;

/** More paths than a glob in a directory component is expanded to on disk; past it, read as reaching the state. */
const GLOB_DISK_LIMIT = 4096;

/** How many of the words a brace expands to are each read on disk. */
const MAX_BRACE_WORDS_ON_DISK = 64;

/**
 * The values an option word may carry glued on, each a path the command may
 * write: `--output=<file>`, and the rest of a short-option cluster,
 * `curl -so<file>`. Where a command's value-taking letters are known the
 * cluster is read as getopt reads it, flags up to the first letter that takes
 * a value; elsewhere any letter may take one (`gcc -o<file>`, `tar -cf<file>`),
 * so the rest of the word after each letter is a candidate. `null` for a
 * cluster longer than `MAX_OPTION_CLUSTER`, which is read as reaching the
 * state rather than tried at every split.
 */
function gluedOptionValues(head: string, word: string): string[] | null {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    return eq > 2 && eq < word.length - 1 ? [word.slice(eq + 1)] : [];
  }
  if (!/^-[A-Za-z]/.test(word)) return [];
  const known = SHORT_VALUE_OPTIONS[head];
  const values: string[] = [];
  for (let c = 1; c < word.length - 1 && /[A-Za-z]/.test(word[c]); c++) {
    if (known !== undefined) {
      if (known.includes(word[c])) return [word.slice(c + 1)];
      continue;
    }
    if (c > MAX_OPTION_CLUSTER) return null;
    values.push(word.slice(c + 1));
  }
  return values;
}

/**
 * The files a download names after its URL rather than on the line, as
 * `{dir, name}`: `wget <url>`, and `curl -O` / `--remote-name`, save the URL's
 * last segment into `-P` / `--directory-prefix` (wget), `--output-dir` (curl)
 * or the current directory. So `cd node_modules/.bin && wget https://…/failproofai`
 * writes the entry with `.bin/failproofai` nowhere on the line
 * (FailproofAI/agenteye#1795). `name` is `null` when the server picks it
 * (`--content-disposition`, `-J`), or the URLs come from a file (`-i`): then
 * it could be anything, the entry's included. A name the line gives (`-O`
 * for wget, `-o` for curl) is judged with the other operands, and a recursive
 * wget puts what it fetches under a directory named after the host.
 */
function downloadLandings(words: string[]): Array<{ dir: string; name: string | null }> {
  const head = words.length > 0 ? commandBasename(words[0]) : "";
  if (head !== "wget" && head !== "curl") return [];
  const valueOptions = head === "wget" ? WGET_VALUE_OPTIONS : CURL_VALUE_OPTIONS;
  let dir = ".";
  let urlNamed = head === "wget";
  let serverNamed = false;
  let named = false;
  let recursive = false;
  let flat = false;
  let dirGiven = false;
  // What curl's `-o` / `--output` name, which `--output-dir` also prefixes.
  const outputs: string[] = [];
  const urls: string[] = [];
  const args = words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      urls.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const value = eq === -1 ? undefined : arg.slice(eq + 1);
      if (name === "directory-prefix" || name === "output-dir") {
        dir = value ?? args[++i] ?? dir;
        dirGiven = true;
      } else if (head === "curl" && name === "output") outputs.push(value ?? args[++i] ?? "");
      else if (name === "output-document" || name === "spider") named = true;
      else if (name === "remote-name" || name === "remote-name-all") urlNamed = true;
      else if (name === "content-disposition" || name === "remote-header-name" || name === "input-file") serverNamed = true;
      else if (name === "recursive" || name === "mirror" || name === "page-requisites" || name === "force-directories") recursive = true;
      else if (name === "no-directories") flat = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // wget's two-letter `-n?` options (`-nd`, `-nH`, `-nc`, `-np`, `-nv`).
      if (head === "wget" && /^-n[A-Za-z]$/.test(arg)) {
        if (arg === "-nd") flat = true;
        continue;
      }
      for (let c = 1; c < arg.length; c++) {
        const flag = arg[c];
        if (valueOptions.includes(flag)) {
          const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i];
          if (head === "wget" && flag === "P") {
            dir = value ?? dir;
            dirGiven = true;
          }
          if (head === "curl" && flag === "o") outputs.push(value ?? "");
          if (head === "wget" && flag === "O") named = true;
          if (head === "wget" && flag === "i") serverNamed = true;
          break;
        }
        if (head === "curl" && flag === "O") urlNamed = true;
        if (head === "curl" && flag === "J") serverNamed = true;
        if (head === "wget" && "rmpx".includes(flag)) recursive = true;
      }
      continue;
    }
    urls.push(arg);
  }
  // curl puts a file `-o` names in `--output-dir` as well: `--output-dir
  // node_modules/.bin -o failproofai` writes the entry (found by hermes on
  // FailproofAI/failproofai#1058).
  const landings: Array<{ dir: string; name: string | null }> =
    head === "curl" && dirGiven ? outputs.filter((output) => relativeWord(output)).map((name) => ({ dir, name })) : [];
  if (!urlNamed || named || (recursive && !flat)) return landings;
  if (serverNamed || recursive) return [...landings, { dir, name: null }];
  for (const url of urls) {
    // The last segment of the path, without the scheme, host, query or
    // fragment, as written and percent-decoded.
    const path = url.replace(/^[A-Za-z][\w+.-]*:\/\/[^/?#]*/, "").replace(/[?#][\s\S]*$/, "");
    const last = path.slice(path.lastIndexOf("/") + 1);
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      // Not valid percent-encoding: the name as written is what lands.
    }
    for (const name of new Set([last, decoded])) if (name !== "") landings.push({ dir, name });
  }
  return landings;
}

/**
 * True when `command` would delete, move or overwrite failproofai's own state.
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
 * So the walk is stateful: it remembers which variables hold the path and
 * whether the shell has been moved INTO the directory, and carries both
 * forward. What it does NOT do is treat every later command as suspect —
 * `cat ~/.failproofai/config.json && rm /tmp/scratch` has to stay allowed, and
 * does, because nothing in the second command reaches the state.
 */
function destroysFailproofaiState(command: string, depth = 0, startDir?: string, startUnknown = false): boolean {
  // A substitution runs its body as a command of its own, so it is judged as
  // one — `echo $(rm -rf ~/.failproofai)` otherwise presents `echo` as the head
  // and walks straight through. Bounded, because a body can contain another.
  // Breadth-first with a budget rather than depth-limited recursion: a nest
  // deeper than the limit is trivial to write (`echo $(echo $(… rm …))`), and
  // every level of it presents `echo` as the head. The budget is what bounds
  // the work instead, because siblings multiply where depth does not.
  if (depth === 0) {
    const bodies = substitutionBodies(command);
    for (let i = 0; i < bodies.length && i < 64; i++) {
      if (destroysFailproofaiState(bodies[i], 1, startDir, startUnknown)) return true;
      bodies.push(...substitutionBodies(bodies[i]));
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
    ...command.matchAll(ASSIGNMENT_RE),
  ].map(([, name, value]) => [name, value.replace(/^["']|["']$/g, "")] as const);
  const stateVars = new Set<string>();
  for (let pass = 0; pass < assignments.length + 1; pass++) {
    const before = stateVars.size;
    for (const [name, value] of assignments) {
      const holdsState =
        FAILPROOFAI_STATE_PATH_RE.test(value) ||
        [...value.matchAll(VAR_REFERENCE_RE)].some(([, ref]) => stateVars.has(ref));
      if (holdsState) stateVars.add(name);
    }
    if (stateVars.size === before) break;
  }

  // Asked again and again for the same words (every check below, for the words
  // as written and as expanded), so answered once per text.
  const named = new Map<string, boolean>();
  const globbed = new Map<string, boolean>();
  const globNamesState = (token: string): boolean => {
    let verdict = globbed.get(token);
    if (verdict === undefined) globbed.set(token, (verdict = globCouldNameState(token)));
    return verdict;
  };
  const namesState = (text: string): boolean => {
    let verdict = named.get(text);
    if (verdict !== undefined) return verdict;
    verdict = FAILPROOFAI_STATE_PATH_RE.test(text);
    for (const [, name] of verdict ? [] : text.matchAll(VAR_REFERENCE_RE)) {
      if (stateVars.has(name)) verdict = true;
    }
    // Per token, not over the whole text: a glob compiled from a whole command
    // line matches nothing, and it is the individual operand — `~/.failproof*`
    // — that would expand onto the state.
    verdict ||= text.split(/\s+/).some((token) => globNamesState(unquotedToken(token)));
    named.set(text, verdict);
    return verdict;
  };

  let cwdInState = false;
  // How deep in `( … )` the walk is, and how deep it was when the `cd` fired.
  // A `cd` inside a subshell moves the subshell only, so the window closes when
  // the parenthesis does: `(cd ~/.failproofai && cat x); rm -rf node_modules`
  // was denying a cleanup in an entirely unrelated directory.
  let parenDepth = 0;
  let cdParenDepth: number | null = null;

  // Where the shell stands, when the walk can tell: the session's directory to
  // begin with, then wherever each `cd`, `pushd` and `popd` moves it. A
  // protected FILE sits in a directory nothing protects, so `cwdInState` never
  // fires for it: `cd node_modules/.bin && printf 'exit 0' > failproofai`, or
  // the same `printf` in a session a previous call left there, names
  // `node_modules/.bin/failproofai` only once `failproofai` is read from there
  // (FailproofAI/agenteye#1795).
  //
  // `dir` is the directory's last `SHELL_DIR_SEGMENTS` segments, which is what
  // words are read from: every pattern matches the end of a path, and an
  // unbounded path made every later word slower to judge. `full` is the whole
  // path, absolute when the session's directory is known and otherwise relative
  // to wherever the line started (`.`); it is what a `..` that climbs above
  // `dir` and a symlink are resolved from. Past `FULL_DIR_SEGMENTS` it is
  // dropped and `deep` set. `lost` marks a `cd` the walk could not follow
  // (`cd "$(npm root)/.bin"`, `cd $ELSEWHERE`): a relative word is then also
  // judged as if it stood in an installed location (`AS_IF_INSTALLED`).
  // `anywhere` marks a directory read from where the line started when the
  // agent may have run it somewhere its hook does not report (Codex's
  // `workdir`): a relative destination there may be npm's bin directory.
  type Where = { dir: string | undefined; full: string | undefined; deep: boolean; lost: boolean; inState: boolean; anywhere?: boolean };
  const startFull = typeof startDir === "string" && startDir !== "" ? shellPath(undefined, startDir) || "." : ".";
  let at: Where = {
    dir: startFull === "." ? undefined : shellTail(startFull),
    full: startFull,
    deep: false,
    lost: false,
    inState: false,
    anywhere: startUnknown,
  };
  let previous: Where | null = null;
  // `set -P` / `set -o physical`: every later `cd` is a `cd -P`.
  let physicalMoves = false;
  const dirStack: Where[] = [];
  // Where the shell may stand instead. A `cd` can fail, and a command after
  // `;`, a newline, `&` or `||` runs anyway, in the directory the shell never
  // left: `cd /nonexistent; printf x > failproofai`. Only `&&` makes what
  // follows wait for the `cd`. So the directories a move leaves are held in
  // `pending` until the next separator, and become possible (`alts`) unless
  // that separator is `&&`.
  let alts: Where[] = [];
  let pending: Where[] = [];
  const scopes: Array<{
    depth: number;
    at: Where;
    previous: Where | null;
    stack: Where[];
    alts: Where[];
    pending: Where[];
    physical: boolean;
  }> = [];
  const sameWhere = (x: Where, y: Where) => x.dir === y.dir && x.full === y.full && x.lost === y.lost;
  // A directory the walk cannot name: where the shell may be once there are
  // more possibilities than it tracks.
  const UNKNOWN: Where = { dir: undefined, full: undefined, deep: false, lost: true, inState: false };
  // Each place once. Past the limit the oldest are not dropped, since the
  // shell may still be in any of them: the newest few are kept and the rest
  // read as a directory the walk lost.
  const fold = (list: Where[], limit: number): Where[] => {
    const kept: Where[] = [];
    for (const where of list) if (!kept.some((other) => sameWhere(other, where))) kept.push(where);
    if (kept.length <= limit) return kept;
    return [...kept.filter((where) => !sameWhere(where, UNKNOWN)).slice(-(limit - 1)), UNKNOWN];
  };
  // Where else the shell may stand: not where it certainly is.
  const possible = (list: Where[]): Where[] => fold(list.filter((where) => !sameWhere(where, at)), MAX_ALTERNATE_DIRS);
  // Symlinks this line makes (`ln -s <target> <link>`), which no `lstat` sees
  // yet: keyed by where the link really is, holding its target as written.
  const links = new Map<string, string>();
  // Where an absolute path really is, as the kernel resolves it: one component
  // at a time from the root, each link (this line's or one on disk) replaced
  // by its target where it is met, and each `..` taken from the directory
  // reached so far. So `inline/../failproofai` through a link to
  // `node_modules/.bin/sub` is `.bin/failproofai`, which collapsing `..` as
  // text first read as `./failproofai` (found by hermes on
  // FailproofAI/failproofai#1058). Past 40 links (the kernel's MAXSYMLINKS)
  // the write fails, but where it was headed is unknown, so that is `ELOOP`
  // and read as landing on the state. Through a link whose target is a
  // substitution or a variable the walk cannot read, `{ via, lost }` is that
  // target as written and what remains of the path after it.
  const ELOOP = Symbol("ELOOP");
  type Lost = { via: string; lost: string };
  type RealPath = string | typeof ELOOP | Lost;
  type Walk = { reached: string; hops: number } | typeof ELOOP | Lost;
  // The kernel's walk from `reached` ("" is the root) with `hops` links
  // already followed, over the components still `pending`.
  const walkFrom = (reached: string, hops: number, pending: string[]): Walk => {
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        reached = reached.slice(0, reached.lastIndexOf("/"));
        continue;
      }
      const next = `${reached}/${part}`;
      let target = links.get(next);
      const made = target !== undefined;
      if (!made) {
        try {
          if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
        } catch {
          // Missing or unreadable: a plain name once created, so walk on.
        }
      }
      if (target === undefined) {
        reached = next;
        continue;
      }
      if (made && /[$`]/.test(target)) return { via: target, lost: pending.filter((p) => p !== "").join("/") };
      if (++hops > 40) return ELOOP;
      if (target.startsWith("/")) reached = "";
      pending.unshift(...target.split("/"));
    }
    return { reached, hops };
  };
  // Each directory is walked once: every word read from the same place shares
  // it, and the option values glued into a long command line are many words.
  const directoryWalks = new Map<string, Walk>();
  const realPaths = new Map<string, RealPath>();
  const realPath = (raw: string): RealPath => {
    // Longer than PATH_MAX, no write can open it, and walking it on disk one
    // component at a time cost a second for a 128 KB word of `a/a/a/…`.
    if (raw.length > PATH_MAX_BYTES) return shellPath(undefined, raw);
    let real = realPaths.get(raw);
    if (real !== undefined) return real;
    const cut = raw.lastIndexOf("/");
    const name = raw.slice(cut + 1);
    let walked: Walk;
    if (cut > 0 && name !== "" && name !== "." && name !== "..") {
      const directory = raw.slice(0, cut);
      let parent = directoryWalks.get(directory);
      if (parent === undefined) directoryWalks.set(directory, (parent = walkFrom("", 0, directory.split("/"))));
      walked =
        parent === ELOOP
          ? ELOOP
          : "reached" in parent
            ? walkFrom(parent.reached, parent.hops, [name])
            : { via: parent.via, lost: parent.lost === "" ? name : `${parent.lost}/${name}` };
    } else {
      walked = walkFrom("", 0, raw.split("/"));
    }
    real = walked === ELOOP || !("reached" in walked) ? walked : walked.reached || "/";
    realPaths.set(raw, real);
    return real;
  };

  // A relative word read from `base`, and `//`, `.` and `..` resolved in any.
  const fromBase = (base: Where, word: string): string =>
    relativeWord(word) && base.dir !== undefined
      ? shellPath(base.dir, word)
      : /\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(word)
        ? shellPath(undefined, word) || "."
        : word;
  const resolvesFrom = (base: Where, text: string): boolean => {
    // An option is not a path to read from where the shell stands.
    if (text.startsWith("-")) return false;
    if (base.lost && relativeWord(text)) {
      if (AS_IF_INSTALLED.some((dir) => namesState(dir + text))) return true;
      // From a directory the walk cannot see, `bins/failproofai` may go
      // through a link to npm's bin directory.
      if (text.includes("/") && couldBeEntryName(text.slice(text.lastIndexOf("/") + 1))) return true;
    }
    // A `..` can climb above `dir`. Then it is read from the whole path, cut
    // the same way, or when even that was too long to keep, as if from an
    // installed location.
    if (relativeWord(text) && text.includes("..") && !base.lost) {
      const climbed = fromBase(base, text);
      if (climbed.startsWith("..") || (base.dir !== undefined && !climbed.startsWith("/") && base.full?.startsWith("/"))) {
        if (base.full !== undefined) {
          const whole = shellPath(base.full === "." ? undefined : base.full, text);
          if (FAILPROOFAI_STATE_PATH_RE.test(whole) || namesState(shellTail(whole))) return true;
        } else if (base.deep && climbed.startsWith("..")) {
          const rest = climbed.replace(/^(?:\.\.\/)+/, "");
          if (AS_IF_INSTALLED.some((dir) => namesState(dir + rest))) return true;
        }
      }
    }
    if (base.lost) return false;
    // Every pattern spells `failproof`, so only a word or a directory that
    // does, or a glob that could, can resolve onto one. A glob as written is
    // already tried against every candidate that starts with a relative
    // directory, so it is read from where the shell stands only when that is a
    // directory a candidate continues from by one name (`node_modules/.bin`
    // and `fail*`), or when it climbs out with `..`.
    if (!/failproof/i.test(text) && !/failproof/i.test(base.dir ?? "")) {
      if (!GLOB_METACHAR_RE.test(text)) return false;
      const parent = (base.dir ?? "").slice((base.dir ?? "").lastIndexOf("/") + 1).toLowerCase();
      if (!GLOB_PARENT_DIRECTORIES.has(parent) && !text.includes("..")) return false;
    }
    const resolved = fromBase(base, text);
    return resolved !== text && namesState(resolved);
  };
  // Whether `text`, read from where the shell stands or may stand, names what
  // `namesState` protects — asked apart from `namesState(text)` where the whole
  // line has already been judged as written.
  const resolvesOntoState = (text: string): boolean =>
    resolvesFrom(at, text) || alts.some((base) => resolvesFrom(base, text));
  // A written path as the absolute path it spells from `base`: `raw` as the
  // kernel walks it, each `..` taken after any link before it, and `plain` as
  // text.
  const absoluteFrom = (base: Where, written: string): { raw: string; plain: string } | undefined => {
    if (written === "" || written.startsWith("-") || written.includes("$") || GLOB_METACHAR_RE.test(written)) {
      return undefined;
    }
    const raw = written.startsWith("/")
      ? written
      : written === "~" || written.startsWith("~/")
        ? homedir() + written.slice(1)
        : relativeWord(written) && !base.lost && base.full?.startsWith("/")
          ? `${base.full}/${written}`
          : undefined;
    if (raw === undefined) return undefined;
    return { raw, plain: shellPath(undefined, raw) };
  };
  // Where a written path really is, from each place the shell may stand: as
  // the kernel resolves it, through links on disk and those this line makes.
  const realPathsOf = (written: string): Array<{ plain: string; real: RealPath }> => {
    const out: Array<{ plain: string; real: RealPath }> = [];
    for (const base of [at, ...alts]) {
      const path = absoluteFrom(base, written);
      if (path !== undefined) out.push({ plain: path.plain, real: realPath(path.raw) });
    }
    return out;
  };
  // Through a link whose target the walk cannot read, the target as written
  // and what remains after it, and that remainder alone the way a word is read
  // once the walk has lost the shell's directory: as if from an installed
  // location. `ln -s "$(npm root)/.bin" b; printf x > b/failproofai`.
  const lostNamesState = ({ via, lost }: { via: string; lost: string }): boolean =>
    namesState(lost === "" ? via : `${via}/${lost}`) ||
    (lost !== "" && AS_IF_INSTALLED.some((dir) => namesState(dir + lost))) ||
    couldBeEntryName(lost.slice(lost.lastIndexOf("/") + 1));
  // Whether a written directory really is npm's bin directory, through links.
  // Through one the walk cannot read, it is when the target ends in `.bin`, or
  // is a substitution (`$(npm root)/.bin` arrives cut short as `$(npm`); a
  // variable the line never sets is read as an unknown `cd` is, which is not
  // taken for npm's bin (`ln -sfn "$RELEASE" current && cp -r config current/`).
  const isBinDir = (written: string): boolean =>
    realPathsOf(written.replace(/[\\/]+$/, "") || written).some(({ real }) => {
      if (real === ELOOP) return true;
      if (typeof real === "string") return NPM_BIN_DIRECTORY_RE.test(real);
      const reached = real.lost === "" ? real.via : `${real.via}/${real.lost}`;
      return /(?:^|[\\/])\.bin[\\/]*$/i.test(reached) || (real.lost === "" && /\$\(|`/.test(real.via));
    });
  // Whether a path really lands on what `namesState` protects once symlinks
  // are followed — those on disk, as the file tools already follow them, and
  // those this line makes: `printf x > bins/failproofai` where `bins` links to
  // `node_modules/.bin`. Only a link counts, so a backup that merely carries a
  // protected name somewhere else (`/tmp/backup/.failproofai`) does not.
  // Whether a path exists, as `lstat` finds it: a missing name, or one under a
  // file (`ENOTDIR`), does not.
  const exists = (path: string): boolean => {
    try {
      return lstatSync(path || "/", { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  };
  // What a directory holds, read once.
  const listings = new Map<string, Set<string> | null>();
  const listingOf = (directory: string): Set<string> | null => {
    let names = listings.get(directory);
    if (names === undefined) {
      try {
        names = new Set(readdirSync(directory || "/"));
      } catch {
        names = null;
      }
      listings.set(directory, names);
    }
    return names;
  };
  // A pattern as the shell expands it against the disk, from directory
  // `from`: each component with a pattern matched against what the directory
  // before it holds, a leading `.` only by a pattern that spells one (no
  // `dotglob`), and the whole path required to exist. `null` past
  // GLOB_DISK_LIMIT paths.
  const expandOnDisk = (from: string, pattern: string): string[] | null => {
    let paths = [from === "/" ? "" : from];
    let reads = 0;
    for (const part of pattern.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." || !GLOB_METACHAR_RE.test(part)) {
        paths = paths.map((path) => `${path}/${part}`);
        continue;
      }
      let matcher: RegExp;
      try {
        matcher = new RegExp(`^${compileGlobPattern(part)}$`);
      } catch {
        return null;
      }
      const next: string[] = [];
      for (const path of paths) {
        if (++reads > GLOB_DISK_LIMIT / 4) return null;
        for (const name of listingOf(path) ?? []) {
          if (name.startsWith(".") && !part.startsWith(".")) continue;
          if (!matcher.test(name)) continue;
          next.push(`${path}/${name}`);
          if (next.length > GLOB_DISK_LIMIT) return null;
        }
      }
      if (next.length === 0) return [];
      paths = next;
    }
    return paths.filter(exists);
  };
  // A glob expands where its literal directories really are: `cp x bins/fail*`
  // with `bins` a link to `node_modules/.bin`, and `fail*` from a directory
  // reached through one, both expand onto the entry. So the directories before
  // the first pattern are resolved, and the pattern is read from there. A
  // pattern in a directory component (`b*/failproofai`) is expanded on disk as
  // the shell expands it and each path it reaches resolved, and each word a
  // brace expands to is read the same way (found by hermes on
  // FailproofAI/failproofai#1058).
  const patternLandsOnState = (word: string): boolean => {
    const parts = word.split("/");
    const first = parts.findIndex((part) => GLOB_METACHAR_RE.test(part));
    if (first === -1) return false;
    const prefix = first === 0 ? "" : parts.slice(0, first).join("/") || "/";
    const pattern = parts.slice(first).join("/");
    if (/[$`]/.test(prefix)) return false;
    const inDirectory = parts.slice(first, -1).some((part) => GLOB_METACHAR_RE.test(part));
    return [at, ...alts].some((base) => {
      const raw =
        prefix === ""
          ? !base.lost && base.full?.startsWith("/")
            ? base.full
            : undefined
          : absoluteFrom(base, prefix)?.raw;
      if (raw === undefined) return false;
      const real = realPath(raw);
      if (real === ELOOP) return true;
      if (typeof real !== "string") return lostNamesState({ via: real.via, lost: real.lost === "" ? pattern : `${real.lost}/${pattern}` });
      if (real !== shellPath(undefined, raw) && namesState(`${real === "/" ? "" : real}/${pattern}`)) return true;
      if (!inDirectory) return false;
      const matches = expandOnDisk(real, pattern);
      if (matches === null) return true;
      return matches.some((match) => {
        const reached = realPath(match);
        return reached === ELOOP ? true : typeof reached !== "string" ? lostNamesState(reached) : namesState(reached);
      });
    });
  };
  const globLandsOnState = (written: string): boolean => {
    const words = expandBraces(written);
    for (let w = 0; w < words.length && w < MAX_BRACE_WORDS_ON_DISK; w++) {
      const word = words[w];
      if (GLOB_METACHAR_RE.test(word) ? patternLandsOnState(word) : word !== written && landsOnState(word)) return true;
    }
    return false;
  };
  const landsOnState = (written: string): boolean =>
    realPathsOf(written).some(({ plain, real }) =>
      real === ELOOP ? true : typeof real !== "string" ? lostNamesState(real) : real !== plain && namesState(real),
    ) ||
    (GLOB_METACHAR_RE.test(written) && globLandsOnState(written));
  const namesHere = (text: string): boolean => namesState(text) || resolvesOntoState(text) || landsOnState(text);
  // From a directory the agent may have run the line in without saying so
  // (`anywhere`), a relative destination that would be the entry, or the
  // package, wherever that directory is: `printf … > failproofai`, and through
  // any directory on the way, since one there may be a link into a bin
  // directory or a `node_modules` that no lstat can see from here
  // (`bins/failproofai`, `deps/failproofai/dist/cli.mjs`; found by hermes on
  // FailproofAI/failproofai#1058).
  const anywhereHere = (): boolean => at.anywhere === true || alts.some((base) => base.anywhere === true);
  const plantsAnywhere = (written: string): boolean => {
    if (!relativeWord(written) || /[$`]/.test(written)) return false;
    const parts = written.replace(/[\\/]+$/, "").split(/[\\/]+/);
    if (couldBeEntryName(parts[parts.length - 1])) return true;
    // The package is read from each component that could start it, a few at most.
    let tried = 0;
    for (let i = 0; i < parts.length && tried < 16; i++) {
      if (!/^(?:failproof|\.pnpm$|@failproofai$)/i.test(parts[i])) continue;
      tried++;
      const rest = parts.slice(i).join("/");
      if (AS_IF_INSTALLED.some((dir) => FAILPROOFAI_CODE_PATH_RE.test(dir + rest))) return true;
    }
    return false;
  };
  // What a simple command writes that its options or operands name, read from
  // such a directory: an output flag's value, separate or glued (`curl -o`,
  // `wget -O`, `gcc -o`, `--output=`), every operand of a command that writes
  // them all (`tee`), the last of one that writes its second (`uniq`), and
  // `dd of=`. Copies, moves, links and downloads are judged where they land.
  const writesEntryAnywhere = (list: string[]): boolean => {
    if (list.length === 0) return false;
    const head = commandBasename(list[0]);
    const args = list.slice(1);
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (OPERAND_WRITE_COMMANDS.has(head) && operands.some(plantsAnywhere)) return true;
    if (SECOND_OPERAND_WRITERS.has(head) && operands.length > 1 && plantsAnywhere(operands[operands.length - 1])) return true;
    // A copy's destination into the package (`deps/failproofai/dist/cli.mjs`);
    // where its sources land by name is judged with the other landings.
    if (COPY_COMMANDS.has(head) && operands.length > 1 && plantsAnywhere(operands[operands.length - 1])) return true;
    if (head === "dd" && args.some((arg) => arg.startsWith("of=") && plantsAnywhere(arg.slice(3)))) return true;
    return args.some((arg, i) => {
      const long = /^--(?:output|out)[\w-]*(=)?/.exec(arg);
      if (long) return plantsAnywhere(long[1] ? arg.slice(arg.indexOf("=") + 1) : (args[i + 1] ?? ""));
      if (!/^-[A-Za-z]/.test(arg)) return false;
      if (/^-[A-Za-z]*[oO]$/.test(arg)) return plantsAnywhere(args[i + 1] ?? "");
      // Glued on after an `o` or `O`; read as getopt reads it where the
      // command's value letters are known.
      const known = SHORT_VALUE_OPTIONS[head];
      for (let c = 1; c < arg.length - 1 && /[A-Za-z]/.test(arg[c]); c++) {
        if (c > MAX_OPTION_CLUSTER) return /failproof/i.test(arg);
        if ((arg[c] === "o" || arg[c] === "O") && plantsAnywhere(arg.slice(c + 1))) return true;
        if (known?.includes(arg[c])) return false;
      }
      return false;
    });
  };
  // `namesHere` for a value glued to an option, of which a long command line
  // has one per letter of its option words. Every protected name spells
  // `failproof`, so a value that spells none, climbs nowhere and expands to
  // nothing can only reach one through a link: one this line made, or one on
  // disk under a first component that exists, which each directory's listing,
  // read once, answers.
  const existsIn = (directory: string, name: string): boolean => {
    const names = listingOf(directory);
    return names === null ? exists(`${directory}/${name}`) : names.has(name);
  };
  const gluedValueNamesHere = (value: string): boolean => {
    if (/failproof|\.\.|[$~]|[*?[{]|[@+!]\(/i.test(value) || links.size > 0 || value.startsWith("/")) {
      return namesHere(value);
    }
    const relative = value.replace(/^(?:\.\/+)+/, "");
    const first = relative.slice(0, (relative.indexOf("/") + 1 || relative.length + 1) - 1);
    return (
      first !== "" &&
      [at, ...alts].some((base) => !base.lost && base.full?.startsWith("/") === true && existsIn(base.full, first)) &&
      landsOnState(value)
    );
  };
  // What the line has assigned by the point the walk reaches, so a word built
  // from it is judged as the path it spells: `B=~/node_modules/.bin; ln -s
  // /tmp/stage $B`. In a loop a later assignment can come first, so there the
  // last one is known from the start. `$PWD` and `~+` are where the shell
  // stands, `~-` where it stood, `$HOME` is `~` unless the line sets it. A
  // variable the line never sets stays a reference, and a `cd` into one is a
  // `cd` the walk cannot follow. Every word is judged as written as well, so an
  // assignment the shell never makes (`: D=x`) cannot hide one.
  const values = new Map<string, string>(LOOP_HEADER_RE.test(command) ? assignments : []);
  const expandAt = (word: string, here: Where): string => {
    let out = word;
    if (out.startsWith("~+") && here.dir !== undefined && !here.lost) out = here.dir + out.slice(2);
    else if (out.startsWith("~-") && previous?.dir !== undefined && !previous.lost) out = previous.dir + out.slice(2);
    for (let pass = 0; pass < 3 && out.includes("$"); pass++) {
      out = out.replace(VAR_REFERENCE_RE, (reference, name: string) =>
        name === "PWD" && here.dir !== undefined && !here.lost
          ? here.dir
          : values.get(name) ?? (name === "HOME" ? "~" : reference),
      );
      // A value that refers to itself grows with every pass.
      if (out.length > 4096) return word;
    }
    return out;
  };
  const expand = (word: string): string => expandAt(word, at);
  // `$PWD` and `~+` name wherever the shell stands, which after a move that
  // may have failed is any of the places it may be.
  const NAMES_PWD_RE = /\$\{?PWD\b|^~\+/;
  const expandEverywhere = (word: string): string[] =>
    NAMES_PWD_RE.test(word) ? alts.map((alt) => expandAt(word, alt)) : [];
  // `named` is the operand as written, judged when the walk cannot follow it.
  // A `physical` move (`cd -P`, or any `cd` after `set -P`) goes where the path
  // really is, each link followed and each `..` taken after it: with `deep` a
  // link to `node_modules/.bin/sub`, `cd -P deep/..` stands in `.bin`, which
  // collapsing `..` as text read as the directory it started from (found by
  // hermes on FailproofAI/failproofai#1058).
  const whereAfter = (base: Where, target: string, named: string, physical = false): Where => {
    if (/\$|`/.test(target)) return { dir: undefined, full: undefined, deep: false, lost: true, inState: namesState(named) };
    const relative = relativeWord(target);
    if (relative && base.lost) {
      return { dir: undefined, full: undefined, deep: false, lost: true, inState: namesState(named) };
    }
    const homeBased = target === "~" || target.startsWith("~/");
    let full: string | undefined = !relative
      ? target.startsWith("/")
        ? shellPath(undefined, target)
        : homeBased
          ? shellPath(undefined, homedir() + target.slice(1))
          : undefined
      : base.full !== undefined
        ? shellPath(base.full === "." ? undefined : base.full, target) || "."
        : undefined;
    if (physical) {
      const raw = !relative
        ? target.startsWith("/")
          ? target
          : homeBased
            ? homedir() + target.slice(1)
            : undefined
        : base.full?.startsWith("/")
          ? `${base.full}/${target}`
          : undefined;
      if (raw !== undefined) {
        const real = realPath(raw);
        if (typeof real !== "string") return { dir: undefined, full: undefined, deep: false, lost: true, inState: namesState(named) };
        full = real;
      }
    }
    // `~user` and a `cd` from a directory too deep to keep are read from `dir`.
    const fromDir = shellPath(relative ? base.dir : undefined, target);
    let deep = relative && base.deep;
    if (full !== undefined && full.length > FULL_DIR_SEGMENTS && full.split("/").length > FULL_DIR_SEGMENTS) {
      full = undefined;
      deep = true;
    }
    const kept = full !== undefined ? (full === "." ? undefined : shellTail(full)) : shellTail(fromDir);
    // Inside the state: going further down from inside stays inside, so only a
    // move that names a new path or climbs out reads the whole path again.
    const climbs = /(?:^|\/)\.\.(?:\/|$)/.test(target);
    const inState =
      namesState(named) ||
      (kept !== undefined && namesState(kept)) ||
      (relative && !climbs
        ? base.inState
        : full !== undefined && (!relative || base.inState) && FAILPROOFAI_STATE_PATH_RE.test(full));
    return { dir: kept, full, deep, lost: false, inState, anywhere: relative && base.anywhere };
  };
  // Moves the shell to `to`, and anywhere else it may stand to `others`. If
  // the move fails, it stays wherever it was, which `pending` keeps — unless
  // it returns somewhere the shell has already stood (`popd`, `cd -`, the
  // session's own directory), which exists.
  const moveTo = (to: Where, others: Where[] = [], certain = false) => {
    if (sameWhere(to, at) && alts.length === 0) return;
    previous = at;
    if (!certain) pending = fold([...pending, at, ...alts], 2 * MAX_ALTERNATE_DIRS);
    at = to;
    alts = possible(others);
    cwdInState = at.inState;
    cdParenDepth = cwdInState ? parenDepth : null;
  };
  // `cd`, `pushd` and `popd` as bash runs them. A move that fails — `popd` on
  // an empty stack, `cd -` with nowhere to go back to, `cd ""` — leaves the
  // shell where it was, never somewhere safe. `+N` / `-N` count entries the
  // way `dirs` lists them: the current directory first, then the stack from
  // its top, and `-n` changes the stack without moving. `cd -` is `$OLDPWD` and
  // a bare `cd` is `$HOME`, either of which the line may set itself.
  const moveShell = (head: string, args: string[], expandedArgs: string[]) => {
    const stackOnly = head !== "cd" && args.includes("-n");
    const k = args.findIndex((w) => !w.startsWith("-") || w === "-" || /^[+-]\d+$/.test(w));
    // `cd -P` and `-L`, the last one given winning; `pushd` follows `set -P`.
    let physical = physicalMoves;
    if (head === "cd") {
      for (const option of args.slice(0, k === -1 ? args.length : k)) {
        if (!/^-[A-Za-z@]+$/.test(option)) continue;
        for (const flag of option.slice(1)) {
          if (flag === "P") physical = true;
          else if (flag === "L") physical = false;
        }
      }
    }
    const named = k === -1 ? undefined : args[k];
    const operand = k === -1 ? undefined : expandedArgs[k];
    if (operand !== undefined && head !== "cd" && /^[+-]\d+$/.test(operand)) {
      const entries = [at, ...[...dirStack].reverse()];
      const n = Number(operand.slice(1));
      const index = operand.startsWith("+") ? n : entries.length - 1 - n;
      if (index < 0 || index >= entries.length || stackOnly) return;
      if (head === "pushd") {
        const rotated = [...entries.slice(index), ...entries.slice(0, index)];
        dirStack.splice(0, dirStack.length, ...rotated.slice(1).reverse());
        moveTo(rotated[0], [], true);
      } else if (entries.length > 1) {
        const rest = entries.filter((_, i) => i !== index);
        dirStack.splice(0, dirStack.length, ...rest.slice(1).reverse());
        if (index === 0) moveTo(rest[0], [], true);
      }
      return;
    }
    if (head === "popd") {
      const top = dirStack.pop();
      if (top && !stackOnly) moveTo(top, [], true);
      return;
    }
    if (head === "pushd" && operand === undefined) {
      if (stackOnly) return;
      const top = dirStack.pop();
      if (top) {
        dirStack.push(at);
        moveTo(top, [], true);
      }
      return;
    }
    if (operand === "-") {
      const oldpwd = values.get("OLDPWD");
      if (oldpwd !== undefined) moveTo(whereAfter(at, expand(oldpwd), oldpwd, physical));
      else if (previous) moveTo(previous, [], true);
      return;
    }
    if (operand === "") return;
    const target = operand ?? expand("$HOME");
    const to = whereAfter(at, target, named ?? target, physical);
    if (stackOnly) {
      dirStack.push(to);
      return;
    }
    if (head === "pushd") dirStack.push(at);
    // Wherever else the shell may stand moves too, the same way.
    moveTo(
      to,
      alts.map((where) => whereAfter(where, target, named ?? target, physical)),
      startFull.startsWith("/") && to.full === startFull,
    );
  };
  // `ln -s <target>… <link or directory>`, in every form GNU ln takes: `-t DIR`
  // in any spelling, a last operand that is a directory (`.`, `dir/`, one on
  // disk, or a link to one unless `-n`), several targets into one directory,
  // and `-r`, which reads each target from where the shell stands rather than
  // from the link. `ln -s node_modules/.bin/failproofai .` made `./failproofai`
  // a link to the entry while the walk recorded the directory itself. Each link
  // is keyed by where it really is, its parent resolved through every link
  // before it, so a later write through it on the same line lands where it would.
  const LN_OPTIONS = INTO_DIRECTORY_OPTIONS.get("ln")!;
  const baseNameOf = (word: string): string => {
    const trimmed = word.replace(/[\\/]+$/, "");
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
  };
  // Where a link written as `word` from `base` goes: its parent resolved, its
  // own name not followed, as `symlink()` creates it.
  const linkPlace = (base: Where, word: string): string | undefined => {
    const path = absoluteFrom(base, word.replace(/[\\/]+$/, "") || word);
    if (path === undefined) return undefined;
    const cut = path.raw.replace(/\/+$/, "").lastIndexOf("/");
    const parent = realPath(path.raw.slice(0, cut) || "/");
    const name = path.raw.replace(/\/+$/, "").slice(cut + 1);
    if (typeof parent !== "string" || name === "" || name === "." || name === "..") return undefined;
    return `${parent === "/" ? "" : parent}/${name}`;
  };
  // Whether `word` is a directory for `ln` to put links into: on disk, or a
  // link this line made to one, followed unless `-n`. `undefined` when it does
  // not exist yet, which a `mkdir` earlier on the line may change.
  const linksInto = (base: Where, word: string, noDereference: boolean): boolean | undefined => {
    if (/[\\/]$/.test(word) || word === "." || word === ".." || /[\\/]\.\.?$/.test(word)) return true;
    const place = linkPlace(base, word);
    if (place === undefined) return false;
    if (links.has(place)) {
      if (noDereference) return false;
      const real = realPath(place);
      if (typeof real !== "string") return true;
      try {
        return statSync(real).isDirectory();
      } catch {
        return undefined;
      }
    }
    try {
      return (noDereference ? lstatSync(place) : statSync(place)).isDirectory();
    } catch {
      return undefined;
    }
  };
  const recordLink = (args: string[]): void => {
    let symbolic = false;
    let fromShell = false;
    let noDereference = false;
    let ontoItself = false;
    let directory: string | undefined;
    const operands: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        operands.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        const option = longOptionOf(LN_OPTIONS, arg.slice(2, eq === -1 ? undefined : eq));
        if (option?.full === "target-directory") directory = eq === -1 ? args[++i] : arg.slice(eq + 1);
        else if (option?.value) i += eq === -1 ? 1 : 0;
        else if (option?.full === "symbolic") symbolic = true;
        else if (option?.full === "relative") fromShell = true;
        else if (option?.full === "no-dereference") noDereference = true;
        else if (option?.full === "no-target-directory") ontoItself = true;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        for (let c = 1; c < arg.length; c++) {
          const flag = arg[c];
          if (LN_OPTIONS.short.includes(flag)) {
            // The rest of the cluster is the value, or else the next word is.
            const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i];
            if (flag === "t") directory = value;
            break;
          }
          if (flag === "s") symbolic = true;
          else if (flag === "r") fromShell = true;
          else if (flag === "n") noDereference = true;
          else if (flag === "T") ontoItself = true;
        }
        continue;
      }
      operands.push(arg);
    }
    if (!symbolic || operands.length === 0) return;
    for (const base of [at, ...alts]) {
      const placed: Array<[string | undefined, string]> = [];
      if (directory !== undefined) {
        for (const target of operands) placed.push([linkPlace(base, `${directory}/${baseNameOf(target)}`), target]);
      } else if (operands.length === 1) {
        placed.push([linkPlace(base, baseNameOf(operands[0])), operands[0]]);
      } else {
        const last = operands[operands.length - 1];
        const targets = operands.slice(0, -1);
        const into = targets.length > 1 ? true : ontoItself ? false : linksInto(base, last, noDereference);
        // Into the directory, or the operand itself; both when it does not
        // exist yet, since the line may have made it.
        if (into !== false) for (const target of targets) placed.push([linkPlace(base, `${last.replace(/[\\/]+$/, "")}/${baseNameOf(target)}`), target]);
        if (into !== true) placed.push([linkPlace(base, last), targets[0]]);
      }
      for (const [place, written] of placed) {
        if (place === undefined || written === undefined) continue;
        let target = written === "~" || written.startsWith("~/") ? homedir() + written.slice(1) : written;
        // `-r` reads the target from where the shell stands.
        if (fromShell && relativeWord(target) && !/[$`]/.test(target)) {
          const fromHere = absoluteFrom(base, target);
          if (fromHere === undefined) continue;
          target = fromHere.raw;
        }
        links.set(place, target);
      }
    }
    // Every path resolved so far may now run through one of these.
    realPaths.clear();
    directoryWalks.clear();
  };

  // A loop header hands its word list to the body, and the body is a separate
  // pipeline that names nothing. Without this, `for f in ~/.failproofai/*; do
  // rm -rf $f; done` is a header that only expands and a body that only deletes
  // something called `$f`.
  let loopCarriesState = false;
  const parts = command.split(new RegExp(`(${PIPELINE_SEPARATORS.source})`));
  for (let part = 0; part < parts.length; part += 2) {
    const pipeline = parts[part];
    // A move the next command does not depend on may have failed, so from
    // there on the directory before it is possible too.
    if (part > 0 && parts[part - 1] !== "&&" && pending.length > 0) {
      alts = possible([...pending, ...alts]);
      pending = [];
    }
    if (!pipeline.trim()) continue;
    for (const [, name, value] of pipeline.matchAll(ASSIGNMENT_RE)) values.set(name, value.replace(/^["']|["']$/g, ""));
    const simpleCommands = pipeline.split("|");
    const reachesState = namesState(pipeline) || cwdInState || loopCarriesState;
    if (reachesState && LOOP_HEADER_RE.test(pipeline)) loopCarriesState = true;
    if (/(?:^|\s)done(?:\s|$)/.test(pipeline)) loopCarriesState = false;

    // A redirect is a write with no command in front of it — `> path` empties a
    // file on its own. Only a redirect whose TARGET is the state counts: the
    // previous version matched any `>` anywhere in the segment, so
    // `grep -r sudo ~/.failproofai 2>/dev/null` and
    // `cat ~/.failproofai/config.json > /tmp/backup.json` both denied, which is
    // exactly the diagnosis this guard must not block.
    for (const [, target] of pipeline.matchAll(REDIRECT_TARGET_RE)) {
      const written = target.replace(/^["']|["']$/g, "");
      if (namesHere(written) || namesHere(expand(written)) || expandEverywhere(written).some(namesHere)) return true;
      if (anywhereHere() && (plantsAnywhere(written) || plantsAnywhere(expand(written)))) return true;
    }

    for (const simple of simpleCommands) {
      // Parentheses inside quotes or escaped open and close nothing, and a
      // substitution's are not a subshell: `cd $(npm root)/.bin` moves this shell.
      const shellText = withoutSubstitutions(simple.replace(/\\[()]|'[^']*'|"(?:[^"\\]|\\.)*"/g, ""));
      parenDepth += (shellText.match(/\(/g) ?? []).length;
      const words = commandWordList(simple);
      const expanded = words.map(expand);
      const lists = expanded.some((word, k) => word !== words[k]) ? [words, expanded] : [words];
      if (alts.length > 0 && words.some((word) => NAMES_PWD_RE.test(word))) {
        for (const alt of alts) lists.push(words.map((word) => expandAt(word, alt)));
      }
      const head = words.length > 0 ? commandBasename(words[0]) : "";
      if (head === "cd" || head === "pushd" || head === "popd") {
        // Every stage of a pipeline runs in a subshell of its own, so a `cd`
        // there moves nothing the rest of the line sees.
        if (simpleCommands.length === 1) {
          if (parenDepth > 0) {
            scopes.push({ depth: parenDepth, at, previous, stack: dirStack.slice(), alts: alts.slice(), pending: pending.slice(), physical: physicalMoves });
          }
          moveShell(head, words.slice(1), expanded.slice(1));
        }
      } else if (
        [at, ...alts].some((base) =>
          lists.some(
            (list) =>
              landsInDirectoryAs(list, namesState, (word) => fromBase(base, word), base.lost, landsOnState, isBinDir) ||
              // From a directory the agent may have run the line in without
              // saying, a copy is also read as written, from somewhere unknown.
              (base.anywhere === true && landsInDirectoryAs(list, namesState, (word) => word, true, landsOnState, isBinDir)) ||
              downloadLandings(list).some(({ dir, name }) => {
                const into = fromBase(base, dir).replace(/(?:[\\/]+\.?)+$/, "");
                if (name === null) return NPM_BIN_DIRECTORY_RE.test(into) || isBinDir(dir) || (base.anywhere === true && relativeWord(dir));
                const landing = `${dir.replace(/[\\/]+$/, "")}/${name}`;
                return (
                  namesState(fromBase(base, landing)) ||
                  landsOnState(landing) ||
                  ((base.lost || base.anywhere === true) && relativeWord(dir) && couldBeEntryName(name))
                );
              }),
          ),
        ) ||
        (anywhereHere() && lists.some(writesEntryAnywhere))
      ) {
        // Before the `reachesState` gate, because the point is that nothing on
        // the line names the path: the source's name and the directory do.
        return true;
      } else if (
        words.length > 0 &&
        // Operands only: the command word is a program, not a path written to.
        // The line as written is `reachesState`; a word adds to it only by
        // resolving from where the shell stands or through a symlink, or by
        // what expansion made it.
        (reachesState ||
          words.some(
            (word, k) =>
              k > 0 &&
              (resolvesOntoState(word) || landsOnState(word) || (expanded[k] !== word && namesHere(expanded[k]))),
          ) ||
          // A value glued to its option is a path too, read from where the
          // shell stands and through links: `cd node_modules/.bin && curl
          // -sofailproofai <url>`, and `curl -sohook <url>` with `hook` a link
          // to the entry (found by hermes on FailproofAI/failproofai#1058).
          lists.some((list) =>
            list.some((word, k) => {
              if (k === 0 || !word.startsWith("-")) return false;
              const values = gluedOptionValues(head, word);
              return values === null || values.some(gluedValueNamesHere);
            }),
          )) &&
        lists.some((list) => simpleCommandDestroys(list, namesHere))
      ) {
        // Judged BEFORE the closing parenthesis is counted: a `rm -rf ./*)`
        // still runs inside the subshell it closes.
        return true;
      } else if (head === "ln" && simpleCommands.length === 1) {
        recordLink(expanded.slice(1));
      } else if (head === "set" && simpleCommands.length === 1) {
        // Inside `( … )` it is the subshell's setting only, put back when it
        // closes (found by hermes on FailproofAI/failproofai#1058).
        if (parenDepth > 0) {
          scopes.push({ depth: parenDepth, at, previous, stack: dirStack.slice(), alts: alts.slice(), pending: pending.slice(), physical: physicalMoves });
        }
        for (let i = 1; i < words.length; i++) {
          if (/^[-+][A-Za-z]+$/.test(words[i]) && words[i].includes("P")) physicalMoves = words[i][0] === "-";
          else if ((words[i] === "-o" || words[i] === "+o") && words[i + 1] === "physical") physicalMoves = words[i] === "-o";
        }
      }
      parenDepth = Math.max(0, parenDepth - (shellText.match(/\)/g) ?? []).length);
      if (cdParenDepth !== null && parenDepth < cdParenDepth) {
        cwdInState = false;
        cdParenDepth = null;
      }
      // Leaving a subshell puts back where the shell stood before it, inside
      // the state included: `cd ~/.failproofai && (cd /tmp) && rm -rf *`.
      while (scopes.length > 0 && parenDepth < scopes[scopes.length - 1].depth) {
        const scope = scopes.pop()!;
        at = scope.at;
        previous = scope.previous;
        alts = scope.alts;
        pending = scope.pending;
        physicalMoves = scope.physical;
        dirStack.splice(0, dirStack.length, ...scope.stack);
        cwdInState = at.inState;
        cdParenDepth = cwdInState ? parenDepth : null;
      }
    }
  }
  return false;
}

/** How much of the shell's directory the walk reads words from; see `shellTail`. */
const SHELL_DIR_SEGMENTS = 16;

/**
 * How much of the shell's whole path the walk keeps for a `..` that climbs
 * above `SHELL_DIR_SEGMENTS` and for following symlinks. Bounded so that a
 * script of a thousand `cd`s stays linear.
 */
const FULL_DIR_SEGMENTS = 64;

/** How many directories a failed `cd` can leave the shell in that the walk tracks. */
const MAX_ALTERNATE_DIRS = 4;

/** Linux's PATH_MAX: `open(2)` refuses a longer path with ENAMETOOLONG. */
const PATH_MAX_BYTES = 4096;

/**
 * Where a relative word is also read once the walk has lost the shell's
 * directory: the places an installed failproofai entry or package lives. Only
 * a word that names one there can match, so an ordinary file is unaffected.
 */
const AS_IF_INSTALLED = ["node_modules/.bin/", "node_modules/", "/bin/"];

/**
 * The directories a glob candidate continues from by one name: `.bin` and
 * `bin` hold the entry, `node_modules` and `.pnpm` the package, `pnpm` is
 * pnpm's home. Only from these can a relative glob that does not spell the
 * name itself (`fail*`) land on installed code.
 */
const GLOB_PARENT_DIRECTORIES = new Set([".bin", "bin", "node_modules", ".pnpm", "pnpm"]);

/**
 * `text` without its `$(…)` command substitutions, so their parentheses are
 * not counted as a subshell's. One left open runs to the end of the text.
 */
function withoutSubstitutions(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += text[i];
  }
  return out;
}

/** A word a shell reads from its current directory: not `~`, `/`, `$…` or `C:`. */
function relativeWord(word: string): boolean {
  return word !== "" && !/^(?:[~/\\$]|[A-Za-z]:)/.test(word);
}

/** The entry's own name, a Windows shim of it, or a glob that could be either. */
function couldBeEntryName(name: string): boolean {
  return /^failproofai(?:\.(?:cmd|ps1|exe|bunx))?$/i.test(name) || (GLOB_METACHAR_RE.test(name) && globCouldBeEntry(name));
}

/**
 * `word` read from directory `base` (as given when absolute, or with no base),
 * with `//`, `.` and `..` resolved as text, the way a shell's logical `cd`
 * does.
 */
function shellPath(base: string | undefined, word: string): string {
  const joined = base === undefined ? word : `${base}/${word}`;
  const absolute = joined.startsWith("/");
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/**
 * A directory cut to its last `SHELL_DIR_SEGMENTS` segments. Every protected
 * pattern matches the END of a path, so the dropped head never decides
 * anything, and the cut keeps a script of a thousand `cd`s from growing every
 * later word it is joined to.
 */
function shellTail(path: string): string {
  let cut = path.length;
  for (let kept = 0; kept < SHELL_DIR_SEGMENTS; kept++) {
    if (cut <= 0) return path;
    cut = path.lastIndexOf("/", cut - 1);
    if (cut < 0) return path;
  }
  return path.slice(cut + 1);
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
 * A patch's file headers: every file it adds, updates or deletes, and where
 * `*** Move to:` renames one, in the format Codex's `apply_patch` takes
 * (lenient about spacing, as its parser is); and the `---` / `+++` paths of a
 * unified diff.
 */
const PATCH_FILE_RE = /^[ \t]*\*\*\*[ \t]*(?:(?:Add|Update|Delete)[ \t]+File|Move[ \t]+to)[ \t]*:[ \t]*(.*?)[ \t]*\r?$/gim;
const UNIFIED_DIFF_FILE_RE = /^(?:---|\+\+\+)[ \t]+(.*?)(?:\t.*)?\r?$/gm;

/** Input keys that hold what a file tool writes, never a patch to apply. */
const FILE_CONTENT_KEYS = new Set(["content", "old_string", "new_string", "new_source", "file_text", "old_str", "new_str"]);

/**
 * The files an edit tool's patch writes, when the tool carries a patch instead
 * of a path. Codex's `apply_patch` (canonical `Edit`) delivers its patch as
 * `tool_input.command`, with no `file_path` at all, so the path check below
 * had nothing to read and a native patch could plant `node_modules/.bin/failproofai`
 * (found by hermes on FailproofAI/failproofai#1058). OpenCode's sends `patchText`.
 * Read from every input that is not a file's content, as text or a list of it.
 */
function patchTargets(input: Record<string, unknown> | undefined): string[] {
  const targets = new Set<string>();
  for (const [key, value] of Object.entries(input ?? {})) {
    if (FILE_CONTENT_KEYS.has(key)) continue;
    const texts = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    for (const text of texts) {
      for (const [, path] of text.matchAll(PATCH_FILE_RE)) if (path) targets.add(path);
      for (const [, written] of text.matchAll(UNIFIED_DIFF_FILE_RE)) {
        const path = written.replace(/^"(.*)"$/, "$1");
        if (!path || path === "/dev/null") continue;
        targets.add(path);
        // `a/` and `b/` are git's prefixes, not directories, unless they are.
        if (/^[ab]\//.test(path)) targets.add(path.slice(2));
      }
    }
  }
  return [...targets];
}

/** The builtins that print their arguments and run none of them. */
const PRINT_COMMANDS = new Set(["echo", "printf"]);

/** Readers a pipeline can hand printed text to without running any of it. */
const TEXT_READERS = new Set([
  "cat", "less", "more", "head", "tail", "wc", "grep", "egrep", "fgrep", "sort", "uniq", "cut", "tr", "column",
  "nl", "fold", "fmt", "rev",
]);

/** Where a print's own redirect can send it without keeping it anywhere it may be run from. */
const HARMLESS_OUTPUT_RE = /^(?:&\d*-?|\/dev\/(?:null|stdout|stderr|tty))$/;

/**
 * Commands that run a file or text they are handed: shells, interpreters and
 * what runs a command for you. A line with one of these, or a command named by
 * a path (`./notes.md`), may run a file it has just printed into.
 */
const RUNS_FILES = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "busybox", "source", ".", "eval", "xargs", "env",
  "nohup", "timeout", "sudo", "doas", "su", "nice", "ionice", "chroot", "setsid", "stdbuf", "watch", "script",
  "expect", "python", "python2", "python3", "node", "nodejs", "deno", "bun", "bunx", "npx", "pnpx", "perl", "ruby",
  "php", "lua", "tclsh", "Rscript", "osascript", "pwsh", "powershell", "awk", "gawk", "mawk", "make", "chmod",
  "crontab", "at", "batch", "systemd-run",
]);

/**
 * Commands after which what a line prints may be run or kept to run: a
 * compound command (`for … do echo '…'; done | sh`), a function or alias
 * definition that can stand in for `echo`, and `exec`, which redirects the
 * shell itself.
 */
const RUNS_PRINTED_TEXT = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function",
  "coproc", "alias", "enable", "shopt", "exec",
]);

/**
 * `command` with each `>` and `<` blanked where it is text that `echo` or
 * `printf` only prints: `echo 'cat > node_modules/.bin/failproofai'` documents
 * a command rather than running one (found by hermes on
 * FailproofAI/failproofai#1058). The walk reads redirects from the text,
 * quotes and all, because a quoted program handed to `bash -c` or piped into
 * `sh` really does redirect, and the unescaped pass drops the quotes, so both
 * read that `>` as a redirect.
 *
 * Text means quoted (`'…'`, `"…"`, `$'…'`) or escaped (`\>`). Blanked only
 * where nothing on the line can run it: an `echo` or `printf` (not
 * `printf -v`, which stores it) outside any subshell, group or substitution,
 * holding no substitution, piped into nothing but text readers, and
 * redirected, if at all, to another descriptor or `/dev/null`; on a line with
 * no compound command, function, alias, `exec`, heredoc or process
 * substitution. Otherwise the text is left as it is.
 */
function blankPrintedRedirects(command: string): string {
  if (!/['"\\]/.test(command) || !/[<>]/.test(command)) return command;
  // Per character: text (quoted or escaped), and inside a subshell, group or
  // substitution, or a substitution's own start.
  const text = new Uint8Array(command.length);
  const nested = new Uint8Array(command.length);
  const pieces: Array<{ start: number; end: number; pipeIn: boolean; pipeOut: boolean }> = [];
  let quote: "'" | '"' | "$'" | null = null;
  let depth = 0;
  let backquoted = false;
  let start = 0;
  let pipeIn = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else text[i] = 1;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") quote = null;
      else {
        text[i] = 1;
        if (ch === "\\" && i + 1 < command.length) text[++i] = 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      text[i] = 1;
      // A substitution inside double quotes still runs.
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) nested[i] = 1;
      if (ch === "\\" && i + 1 < command.length) text[++i] = 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) text[++i] = 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch === "'" && command[i - 1] === "$" ? "$'" : ch;
      continue;
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") return command;
    if (ch === "<" && command[i + 1] === "<") return command;
    if (ch === "(" || ch === "{") depth++;
    if (ch === "`") backquoted = !backquoted;
    if (depth > 0 || backquoted || "`(){}".includes(ch)) nested[i] = 1;
    if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    // `&` beside a `>`, and `|` after one, belong to a redirect (`>&2`, `&>`,
    // `>|`), not a separator.
    const redirecting = (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) || (ch === "|" && command[i - 1] === ">");
    if ("|;&\n\r".includes(ch) && !redirecting) {
      let j = i;
      while (j < command.length && "|;&\n\r".includes(command[j])) j++;
      const run = command.slice(i, j);
      const pipe = run === "|" || run === "|&";
      pieces.push({ start, end: i, pipeIn, pipeOut: pipe });
      pipeIn = pipe;
      start = j;
      i = j - 1;
    }
  }
  if (quote !== null || depth > 0 || backquoted) return command;
  pieces.push({ start, end: command.length, pipeIn, pipeOut: false });
  // The line read with its text blanked, for the commands that can run it.
  let bare = "";
  for (let i = 0; i < command.length; i++) bare += text[i] ? " " : command[i];
  if (/\w\s*\(\s*\)/.test(bare)) return command;
  // Each piece's command word, past any assignments in front of it.
  const commandOf = (from: number, to: number): string =>
    bare.slice(from, to).trim().split(/\s+/).find((word) => !/^[A-Za-z_]\w*=/.test(word)) ?? "";
  let runsFiles = false;
  for (const { start: from, end: to } of pieces) {
    const word = commandOf(from, to);
    if (RUNS_PRINTED_TEXT.has(word)) return command;
    if (RUNS_FILES.has(word) || word.includes("/")) runsFiles = true;
  }

  // Whether a piece stands alone at the top of the line with only harmless
  // output redirects, and the command it runs.
  const plain = (from: number, to: number): string | undefined => {
    for (let k = from; k < to; k++) if (nested[k]) return undefined;
    for (let k = from; k < to; k++) {
      if (command[k] !== ">" || text[k]) continue;
      let j = k + 1;
      if (command[j] === ">" || command[j] === "|") j++;
      const duplicate = command[j] === "&";
      if (duplicate) j++;
      while (j < to && /[ \t]/.test(command[j])) j++;
      let target = duplicate ? "&" : "";
      for (; j < to && !/\s/.test(command[j]); j++) if (command[j] !== "'" && command[j] !== '"') target += command[j];
      // Into a file, as documentation is, unless something on the line may
      // run what it holds (`echo '…' > notes.md` stays text; `… && sh notes.md`
      // does not).
      if (!HARMLESS_OUTPUT_RE.test(target) && (runsFiles || target === "" || target.startsWith("&"))) return undefined;
      k = j - 1;
    }
    const words = shellWords(command.slice(from, to));
    return words.length > 0 ? words[0].raw : undefined;
  };
  const out = command.split("");
  for (let p = 0; p < pieces.length; p++) {
    if (pieces[p].pipeIn) continue;
    // The pipeline this piece starts.
    let last = p;
    while (pieces[last].pipeOut && last + 1 < pieces.length) last++;
    const head = plain(pieces[p].start, pieces[p].end);
    if (head === undefined || !PRINT_COMMANDS.has(head)) continue;
    const words = shellWords(command.slice(pieces[p].start, pieces[p].end));
    if (head === "printf" && words.some(({ raw }) => /^-[A-Za-z]*v/.test(raw))) continue;
    let readers = true;
    for (let q = p + 1; q <= last && readers; q++) {
      const reader = plain(pieces[q].start, pieces[q].end);
      readers = reader !== undefined && (TEXT_READERS.has(reader) || (reader === "tee" && !runsFiles));
    }
    if (!readers) continue;
    for (let k = pieces[p].start; k < pieces[last].end; k++) if (text[k] && (command[k] === ">" || command[k] === "<")) out[k] = "_";
  }
  return out.join("");
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
  if (ctx.toolName === "Write" || ctx.toolName === "Edit" || ctx.toolName === "NotebookEdit") {
    // The path the tool names, and every file a patch it carries names.
    const paths = [getFilePath(ctx) || ((ctx.toolInput?.notebook_path as string) ?? ""), ...patchTargets(ctx.toolInput)];
    // A patch's relative paths are read from the session's directory, and
    // from the one the call names when it names one.
    const toolCwd = ctx.toolInput?.workdir ?? ctx.toolInput?.cwd;
    const cwds = [ctx.session?.cwd, ...(typeof toolCwd === "string" && toolCwd !== "" ? [toolCwd] : [])];
    for (const path of paths) {
      // The path as given AND the file it lands on. The bin entry a user-scope
      // hook runs is usually a symlink into the package, so writing through it
      // changes the hook's code without the package's path ever being named.
      const kind =
        failproofaiFileKind(path) ??
        cwds.map((cwd) => failproofaiFileKind(resolveWriteTarget(path, cwd))).find((found) => found !== null) ??
        null;
      if (kind === "code") {
        return deny(
          "Writing to failproofai's installed code would switch enforcement off. " +
            "If a policy is blocking legitimate work, say so and let the operator decide.",
        );
      }
      if (kind === "state") {
        return deny(
          "Writing to failproofai's own state would switch enforcement off. " +
            "If a policy is blocking legitimate work, say so and let the operator decide.",
        );
      }
    }
    return allow();
  }
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  // The raw command AND its shell-unescaped form: a shell strips quotes and
  // backslashes before running the binary, so `fail\proofai config --pause`
  // reaches the pause CLI even though the literal name is broken.
  const unescaped = stripShellQuoting(cmd);
  const kind = classifySelfInvocation(cmd) ?? classifySelfInvocation(unescaped);

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
  // matcher and a real path to the shell. The walk starts where the command runs:
  // the session's directory, or the one an Antigravity `run_command` names.
  const toolCwd = ctx.toolInput?.cwd ?? ctx.toolInput?.workdir;
  const reported = typeof toolCwd === "string" && toolCwd !== "";
  const shellCwd = reported ? toolCwd : ctx.session?.cwd;
  // Codex runs a command in the `workdir` its shell tool names, and its hook
  // payload carries the session's directory and the command only: a native
  // `printf … > failproofai` with workdir `node_modules/.bin` arrived as a
  // write in the project root (found by hermes on FailproofAI/failproofai#1058).
  // Unless the call reports one, the line may start anywhere, which the walk
  // reads as it reads a directory it has lost.
  const startUnknown = ctx.cli === "codex" && !reported;
  // Quoted text an `echo` or `printf` only prints is read as text, in both
  // passes (see `blankPrintedRedirects`).
  const walked = blankPrintedRedirects(cmd);
  // The walk must not throw: a policy that throws is skipped by the evaluator,
  // and for this one that is an allow. So a throw is a deny, said as one.
  let destroys: boolean;
  try {
    destroys =
      destroysFailproofaiState(walked, 0, shellCwd, startUnknown) ||
      destroysFailproofaiState(walked === cmd ? unescaped : stripShellQuoting(walked), 0, shellCwd, startUnknown);
  } catch (err) {
    return deny(
      "failproofai could not read this command to check it against its own files, so it is refused. " +
        `Rewrite it more simply, or say so and let the operator decide. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (destroys) {
    return deny(
      "Deleting, moving or overwriting failproofai's own state or installed code would switch enforcement off. " +
        "If a policy is blocking legitimate work, say so and let the operator decide.",
    );
  }
  return allow();
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
