/**
 * The sealed-eligible half of the builtin policy set — 32 of 39.
 *
 * Every policy here decides from the hook payload alone. None spawns a
 * process, opens a file, or reads ambient host identity, which is what makes
 * them eligible for the `sealed` execution tier: a fresh interpreter context
 * per evaluation, running as the service account, with no bindings registered.
 *
 * **The import list is a security boundary, not a style choice.** Execution
 * tiers are derived from a policy's *resolved import graph*, so one
 * `node:child_process` anywhere reachable from this file silently demotes all
 * 32 policies to `user-context` and empties the sealed tier — an architecture
 * that looks implemented and delivers no verdict integrity.
 * `__tests__/hooks/builtin-tier-split.test.ts` walks the real graph and fails
 * if that happens.
 *
 * `node:path` is the one permitted host-module import: `resolve` and `join`
 * are pure string arithmetic with no syscall surface, and the sealed worker
 * supplies them. Home-directory and project-root lookups, which are *not*
 * pure, arrive as request data through `./host-context`.
 *
 * The seven policies that genuinely need the host live in `./host-access.ts`.
 * The registry that names, describes, and orders all 39 stays in
 * `../builtin-policies.ts`, which is still the only module anything imports.
 */
import { resolve, join } from "node:path";
import type { PolicyContext, PolicyResult } from "../policy-types";
import { allow, deny, instruct } from "../policy-helpers";
import {
  getCommand,
  getFilePath,
  matchesAllowedPattern,
  parseArgvTokens,
  shellSegments,
} from "./shared";
import { resolveHome, resolveProjectDir } from "./host-context";
import { policyWarn } from "./warn";

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
 *
 * `home` is passed in rather than read from `os.homedir()` (Stage 0 / P2).
 * The daemon evaluates on behalf of another UID, so its own homedir is the
 * service account's — and because this predicate *widens* the allow set, a
 * wrong or forged home would whitelist the wrong tree. See `./host-context`.
 */
function isAgentInternalPath(resolved: string, home: string): boolean {
  // Normalize backslashes to forward slashes so the same `startsWith` check
  // works on Windows. `resolve()` returns forward slashes on POSIX but
  // backslashes on Windows; `join(home, ...)` follows the same OS
  // convention. Comparing both sides under a single forward-slash form
  // avoids per-OS branching.
  const normResolved = resolved.replaceAll("\\", "/");
  for (const dir of [".claude", ".codex", ".copilot", ".cursor", ".opencode", ".pi", ".gemini"]) {
    const root = join(home, dir).replaceAll("\\", "/");
    if (normResolved === root || normResolved.startsWith(root + "/")) return true;
  }
  for (const sub of [join(".config", "opencode"), join(".local", "share", "opencode")]) {
    const root = join(home, sub).replaceAll("\\", "/");
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
const SUDO_RE = /(?:^|;|&&|\|\|)\s*sudo\s/;
const PS_ELEVATION_RE = /Start-Process\s+.*-Verb\s+RunAs/i;
const RUNAS_RE = /(?:^|;|&&|\|\|)\s*runas\s/i;

// blockCurlPipeSh
const CURL_PIPE_SH_RE = /(?:curl|wget)\s.*\|\s*(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash)\b/;
const PS_WEB_PIPE_RE = /(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\s+.*\|\s*(?:Invoke-Expression|iex)/i;

// blockForcePush
const SHORT_FLAG_BUNDLE_RE = /^-[a-zA-Z]*f[a-zA-Z]*$/;
const SAFE_FORCE_PREFIXES = ["--force-with-lease", "--force-if-includes"] as const;

// blockSecretsWrite
const SECRET_FILE_RE = /\.(?:pem|key)$/;
const SECRET_FILE_ID_RSA_RE = /id_rsa/;
const SECRET_FILE_CREDENTIALS_RE = /credentials/;

// blockFailproofaiCommands
const FAILPROOFAI_CLI_RE = /(?:^|;|&&|\|\||\|)\s*failproofai(?:\s|$)/;
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

// -- Policy implementations --

export function sanitizeJwt(ctx: PolicyContext): PolicyResult {
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

export function sanitizeApiKeys(ctx: PolicyContext): PolicyResult {
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
      policyWarn(`additionalPatterns: invalid regex "${regex}", skipping`);
    }
  }

  return allow();
}

export function sanitizeConnectionStrings(ctx: PolicyContext): PolicyResult {
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

export function sanitizePrivateKeyContent(ctx: PolicyContext): PolicyResult {
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

export function sanitizeBearerTokens(ctx: PolicyContext): PolicyResult {
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

export function warnDestructiveSql(ctx: PolicyContext): PolicyResult {
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

export function warnLargeFileWrite(ctx: PolicyContext): PolicyResult {
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

export function warnPackagePublish(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (PUBLISH_CMD_RE.test(cmd)) {
    return instruct(
      "STOP: This command publishes a package to a public registry. Confirm with the user that this is intentional.",
    );
  }
  return allow();
}

export function protectEnvVars(ctx: PolicyContext): PolicyResult {
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

export function blockEnvFiles(ctx: PolicyContext): PolicyResult {
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

export function blockSudo(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx).trimStart();
  if (SUDO_RE.test(cmd) || cmd.startsWith("sudo ")) {
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

export function blockCurlPipeSh(ctx: PolicyContext): PolicyResult {
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

export function blockPushMaster(ctx: PolicyContext): PolicyResult {
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

/**
 * Expand the leading `~` / `$HOME` / `${HOME}` of a path to the real home
 * directory. `home` is threaded in rather than read from `os.homedir()`
 * (Stage 0 / P2) — see `./host-context`.
 */
function expandHomePrefix(path: string, home: string): string {
  const m = path.match(/^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/);
  return m ? home + path.slice(m[0].length) : path;
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
function deletionTargetIsAllowed(cmd: string, allowPaths: string[], home: string): boolean {
  if (allowPaths.length === 0) return false;
  const normalizedAllowPaths = allowPaths.map((p) => stripTrailingGlob(expandHomePrefix(p, home)) || "/");
  let sawRecursiveDelete = false;
  for (const seg of shellSegments(cmd)) {
    const targets = recursiveDeletionTargets(seg);
    if (targets === null) continue;
    sawRecursiveDelete = true;
    for (const target of targets) {
      const normalized = stripTrailingGlob(expandHomePrefix(target, home)) || "/";
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

export function blockRmRf(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);

  const hasCatastrophicTarget = shellSegments(cmd).some((seg) => {
    const targets = recursiveDeletionTargets(seg);
    return targets !== null && targets.some(isCatastrophicTarget);
  });
  if (hasCatastrophicTarget) {
    const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);
    if (deletionTargetIsAllowed(cmd, allowPaths, resolveHome(ctx))) return allow();
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

export function blockForcePush(ctx: PolicyContext): PolicyResult {
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

export function blockSecretsWrite(ctx: PolicyContext): PolicyResult {
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
 *
 * `home` is threaded in rather than read from `os.homedir()` (Stage 0 / P2).
 */
function extractAbsolutePaths(command: string, home: string): string[] {
  const paths: string[] = [];
  const pathRe = /(?<![a-zA-Z0-9_.\-~\\*?:=])(?:~\/[^\s;|&"'()\[\]{}]*|~(?=\s|$|[;|&"'()\[\]{}])|\/[^\s;|&"'()\[\]{}]*)/g;

  function addPaths(s: string): void {
    pathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(s)) !== null) {
      let p = m[0];
      if (p === "~") p = home;
      else if (p.startsWith("~/")) p = join(home, p.slice(2));
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

export function blockReadOutsideCwd(ctx: PolicyContext): PolicyResult {
  // Prefer $CLAUDE_PROJECT_DIR (stable project root) over ctx.session.cwd,
  // which tracks the live shell CWD and drifts when Claude `cd`s into a subdir.
  // Both now arrive as request data, with a host fallback for the legacy
  // in-process path (Stage 0 / P2) — see ./host-context.
  const cwd = resolveProjectDir(ctx) || ctx.session?.cwd;
  if (!cwd) return allow(); // Can't enforce without cwd

  const home = resolveHome(ctx);
  const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);

  // For Bash tool: check read-like commands for absolute paths outside cwd
  if (ctx.toolName === "Bash") {
    const cmd = getCommand(ctx);
    if (!READ_LIKE_CMDS.test(cmd)) return allow();

    const paths = extractAbsolutePaths(cmd, home);
    const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
    for (const p of paths) {
      const resolved = resolve(cwd, p);
      if (isClaudeSettingsFile(resolved)) {
        return deny(`Reading agent settings file blocked: ${resolved}`);
      }
      if (isClaudeInternalPath(resolved, home)) continue; // Whitelist ~/.claude/
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
  if (isClaudeInternalPath(resolved, home)) return allow();

  // Whitelist /dev/null — harmless special file commonly used in shell commands
  if (resolved === "/dev/null") return allow();

  const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
  if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
    if (allowPaths.some((ap) => resolved === ap || resolved.startsWith(ap.endsWith("/") ? ap : ap + "/"))) return allow();
    return deny(`Access outside project directory blocked: ${resolved}`);
  }
  return allow();
}

export function blockFailproofaiCommands(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);

  // Block direct failproofai CLI invocations
  if (FAILPROOFAI_CLI_RE.test(cmd)) {
    return deny("Running failproofai CLI commands is blocked");
  }

  // Block package-manager uninstallation of failproofai
  if (FAILPROOFAI_UNINSTALL_RE.test(cmd)) {
    return deny("Uninstalling failproofai is blocked");
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

export function blockKubectl(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, KUBECTL_RE, "kubectl commands are blocked");
}

export function blockTerraform(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, TERRAFORM_RE, "terraform/tofu commands are blocked");
}

export function blockAwsCli(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, AWS_CLI_RE, "aws CLI commands are blocked");
}

export function blockGcloud(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, GCLOUD_RE, "gcloud commands are blocked");
}

export function blockAzCli(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, AZ_CLI_RE, "az (Azure) CLI commands are blocked");
}

export function blockHelm(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, HELM_RE, "helm commands are blocked");
}

// gh-pipeline only fires on mutating subcommands; allowPatterns are still
// supported in case a user wants to permit a specific scripted invocation.
export function blockGhPipeline(ctx: PolicyContext): PolicyResult {
  return blockInfraCli(ctx, GH_PIPELINE_RE, "gh pipeline-trigger commands are blocked");
}

export function warnGitAmend(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_AMEND_RE.test(cmd)) {
    return instruct(
      "STOP: This command amends the last commit, which rewrites git history. If this commit has already been pushed to a shared branch, this will cause divergence for other contributors. Confirm with the user before executing.",
    );
  }
  return allow();
}

export function warnGitStashDrop(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_STASH_DROP_RE.test(cmd)) {
    return instruct(
      "STOP: This command permanently deletes stashed changes (git stash drop/clear). Stash entries cannot be recovered after deletion. Confirm with the user before executing.",
    );
  }
  return allow();
}

export function warnAllFilesStaged(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  if (GIT_ADD_ALL_RE.test(cmd)) {
    return instruct(
      "STOP: This command stages all files in the working tree (git add -A / --all / .). This may inadvertently include build artifacts, generated files, or sensitive files not covered by .gitignore. Confirm with the user before executing.",
    );
  }
  return allow();
}

export function warnSchemaAlteration(ctx: PolicyContext): PolicyResult {
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

export function warnGlobalPackageInstall(ctx: PolicyContext): PolicyResult {
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

export function preferPackageManager(ctx: PolicyContext): PolicyResult {
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

export function warnBackgroundProcess(ctx: PolicyContext): PolicyResult {
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

/**
 * The sealed-eligible tier, as data.
 *
 * `builtin-policies.ts` holds the authoritative registry — name, description,
 * category, defaults, params — and references these same function objects. This
 * list exists so tier membership is machine-checkable rather than a comment,
 * and so the sealed worker can enumerate what it is allowed to run without
 * importing the registry (which is not import-pure).
 */
export const PAYLOAD_ONLY_POLICIES: ReadonlyArray<{ name: string; fn: (ctx: PolicyContext) => PolicyResult }> = [
  { name: "sanitize-jwt", fn: sanitizeJwt },
  { name: "sanitize-api-keys", fn: sanitizeApiKeys },
  { name: "sanitize-connection-strings", fn: sanitizeConnectionStrings },
  { name: "sanitize-private-key-content", fn: sanitizePrivateKeyContent },
  { name: "sanitize-bearer-tokens", fn: sanitizeBearerTokens },
  { name: "protect-env-vars", fn: protectEnvVars },
  { name: "block-env-files", fn: blockEnvFiles },
  { name: "block-read-outside-cwd", fn: blockReadOutsideCwd },
  { name: "block-sudo", fn: blockSudo },
  { name: "block-curl-pipe-sh", fn: blockCurlPipeSh },
  { name: "block-rm-rf", fn: blockRmRf },
  { name: "block-failproofai-commands", fn: blockFailproofaiCommands },
  { name: "block-kubectl", fn: blockKubectl },
  { name: "block-terraform", fn: blockTerraform },
  { name: "block-aws-cli", fn: blockAwsCli },
  { name: "block-gcloud", fn: blockGcloud },
  { name: "block-az-cli", fn: blockAzCli },
  { name: "block-helm", fn: blockHelm },
  { name: "block-gh-pipeline", fn: blockGhPipeline },
  { name: "block-secrets-write", fn: blockSecretsWrite },
  { name: "block-push-master", fn: blockPushMaster },
  { name: "block-force-push", fn: blockForcePush },
  { name: "warn-git-amend", fn: warnGitAmend },
  { name: "warn-git-stash-drop", fn: warnGitStashDrop },
  { name: "warn-all-files-staged", fn: warnAllFilesStaged },
  { name: "warn-destructive-sql", fn: warnDestructiveSql },
  { name: "warn-schema-alteration", fn: warnSchemaAlteration },
  { name: "warn-package-publish", fn: warnPackagePublish },
  { name: "warn-global-package-install", fn: warnGlobalPackageInstall },
  { name: "prefer-package-manager", fn: preferPackageManager },
  { name: "warn-large-file-write", fn: warnLargeFileWrite },
  { name: "warn-background-process", fn: warnBackgroundProcess },
];
