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

/** The `git` subcommand, with git's own global options walked off first. */
function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (GIT_FLAGS_WITH_OPERANDS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
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
 * True when this token is a glob that could expand onto failproofai's state.
 *
 * Requires a literal `fail` in the pattern as well as a match. Without that
 * floor a bare `*` compiles to a regex that matches every candidate, and
 * `cd /tmp/build && rm -rf *` — a command with nothing to do with failproofai
 * — would deny. With it, `rm -rf /tmp/test-failures*` also stays allowed,
 * because carrying the word is not the same as being able to match.
 */
function globCouldNameState(token: string): boolean {
  if (!/[*?[]/.test(token)) return false;
  if (!token.includes("fail")) return false;
  let pattern = "^";
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "*") pattern += "[^/]*";
    else if (ch === "?") pattern += "[^/]";
    else if (ch === "[") {
      const close = token.indexOf("]", i + 1);
      if (close === -1) return false;
      pattern += token.slice(i, close + 1);
      i = close;
    } else pattern += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    const re = new RegExp(pattern + "$");
    return STATE_GLOB_CANDIDATES.some((candidate) => re.test(candidate));
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
    if (long && namesState(arg)) return true;
    const bundled = /^-[A-Za-z]*[oD]$/.test(arg) && flags.includes(`-${arg[arg.length - 1]}`);
    if ((flags.includes(arg) || bundled) && namesState(args[i + 1] ?? "")) return true;
  }
  return false;
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
function destroysFailproofaiState(command: string, depth = 0): boolean {
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
      if (destroysFailproofaiState(bodies[i], 1)) return true;
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
    ...command.matchAll(/(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g),
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

  const namesState = (text: string): boolean => {
    if (FAILPROOFAI_STATE_PATH_RE.test(text)) return true;
    for (const [, name] of text.matchAll(VAR_REFERENCE_RE)) {
      if (stateVars.has(name)) return true;
    }
    // Per token, not over the whole text: a glob compiled from a whole command
    // line matches nothing, and it is the individual operand — `~/.failproof*`
    // — that would expand onto the state.
    return text.split(/\s+/).some((token) => globCouldNameState(bareToken(token)));
  };

  let cwdInState = false;
  // How deep in `( … )` the walk is, and how deep it was when the `cd` fired.
  // A `cd` inside a subshell moves the subshell only, so the window closes when
  // the parenthesis does: `(cd ~/.failproofai && cat x); rm -rf node_modules`
  // was denying a cleanup in an entirely unrelated directory.
  let parenDepth = 0;
  let cdParenDepth: number | null = null;
  // A loop header hands its word list to the body, and the body is a separate
  // pipeline that names nothing. Without this, `for f in ~/.failproofai/*; do
  // rm -rf $f; done` is a header that only expands and a body that only deletes
  // something called `$f`.
  let loopCarriesState = false;
  for (const pipeline of command.split(PIPELINE_SEPARATORS)) {
    if (!pipeline.trim()) continue;
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
    if (reachesState) {
      for (const [, target] of pipeline.matchAll(REDIRECT_TARGET_RE)) {
        if (namesState(target.replace(/^["']|["']$/g, ""))) return true;
      }
    }

    for (const simple of simpleCommands) {
      parenDepth += (simple.match(/\(/g) ?? []).length;
      const words = commandWords(simple);
      const head = words.length > 0 ? commandBasename(words[0]) : "";
      // Track the shell's position before judging: a `cd` INTO the state makes
      // every later relative path a state path, and a `cd` back out ends that.
      if (head === "cd" || head === "pushd") {
        const operand = words.slice(1).find((w) => !w.startsWith("-"));
        cwdInState = operand !== undefined && namesState(operand);
        cdParenDepth = cwdInState ? parenDepth : null;
      } else if (head === "popd") {
        // `popd` returns to wherever the shell was before `pushd`, which ends
        // the window as surely as a `cd` out does. Without it every command for
        // the rest of the line was judged as if it stood in the state directory.
        cwdInState = false;
        cdParenDepth = null;
      } else if (reachesState && words.length > 0 && simpleCommandDestroys(words, namesState)) {
        // Judged BEFORE the closing parenthesis is counted: a `rm -rf ./*)`
        // still runs inside the subshell it closes.
        return true;
      }
      parenDepth -= (simple.match(/\)/g) ?? []).length;
      if (cdParenDepth !== null && parenDepth < cdParenDepth) {
        cwdInState = false;
        cdParenDepth = null;
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
 * '-v HOST_DIR:/docs' is not misread as a standalone absolute path.
 */
function extractAbsolutePaths(command: string): string[] {
  const paths: string[] = [];
  const pathRe = /(?<![a-zA-Z0-9_.\-~\\*?:=])(?:~\/[^\s;|&"'()\[\]{}]*|~(?=\s|$|[;|&"'()\[\]{}])|\/[^\s;|&"'()\[\]{}]*)/g;

  function addPaths(s: string): void {
    pathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(s)) !== null) {
      let p = m[0];
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
  if (ctx.toolName === "Write" || ctx.toolName === "Edit" || ctx.toolName === "NotebookEdit") {
    const path = getFilePath(ctx) || ((ctx.toolInput?.notebook_path as string) ?? "");
    if (FAILPROOFAI_STATE_PATH_RE.test(path)) {
      return deny(
        "Writing to failproofai's own state would switch enforcement off. " +
          "If a policy is blocking legitimate work, say so and let the operator decide.",
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
  // matcher and a real path to the shell.
  if (destroysFailproofaiState(cmd) || destroysFailproofaiState(unescaped)) {
    return deny(
      "Deleting, moving or overwriting failproofai's own state would switch enforcement off. " +
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
 * entry would collapse 39 distinct hashes into one and freeze the key — stale
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
      registerPolicy(policy.name, policy.description, policy.fn, policy.match, 0, policy.params);
    }
  }
}

/** Clears the git branch cache. Exposed for test isolation only. */
export function clearGitBranchCache(): void {
  gitBranchCache.clear();
}
