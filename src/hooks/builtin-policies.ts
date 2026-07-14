/**
 * Built-in security policies for Claude Code hooks.
 */
import { resolve, join } from "node:path";
import { readFile, writeFile, stat, open } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { BuiltinPolicyDefinition, PolicyContext, PolicyResult, PolicyParamsSchema } from "./policy-types";
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
const FORCE_PUSH_RE = /(?:--force|-f\b)/;

// blockSecretsWrite
const SECRET_FILE_RE = /\.(?:pem|key)$/;
const SECRET_FILE_ID_RSA_RE = /id_rsa/;
const SECRET_FILE_CREDENTIALS_RE = /credentials/;

// blockWorkOnMain
const GIT_COMMIT_MERGE_RE = /git\s+(commit|merge|rebase|cherry-pick)\b/;

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

// Caches the current branch per cwd to avoid repeated execSync calls.
// Trade-off: if the user switches branches externally mid-session, the cache serves
// the stale value until the process restarts. This is acceptable since branch switches
// during an active Claude session are rare.
const gitBranchCache = new Map<string, string>();

function getCurrentBranch(cwd: string): string | null {
  try {
    let branch = gitBranchCache.get(cwd);
    if (branch === undefined) {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000,
      }).trim();
      gitBranchCache.set(cwd, branch);
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

function blockSudo(ctx: PolicyContext): PolicyResult {
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

/**
 * Check whether all *recursive* rm path targets in a command are under an allowlisted path.
 * Splits on shell operators first so that `/tmp` appearing in an unrelated
 * sub-command (e.g. `echo /tmp && rm -rf /`) does not trigger a false allow.
 * Uses path-boundary comparison so `/tmp` does not cover `/tmp2`.
 * Non-recursive rm segments (no -r/-R flag) are skipped — they pose no catastrophic risk.
 * Quoted paths with spaces are handled via a segment-level regex fallback.
 */
function rmTargetIsAllowed(cmd: string, allowPaths: string[]): boolean {
  if (allowPaths.length === 0) return false;
  const segments = cmd
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => /\brm\b/.test(s));
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const tokens = parseArgvTokens(seg);
    const rmIdx = tokens.findIndex((t) => t === "rm");
    if (rmIdx < 0) continue;
    // Only validate recursive rm segments — non-recursive rm has no catastrophic-deletion risk
    const flagTokens = tokens.slice(rmIdx + 1).filter((t) => /^-[^-]/.test(t));
    const longFlagsInSeg = tokens.slice(rmIdx + 1).filter((t) => /^--/.test(t));
    if (!/r/i.test(flagTokens.join("")) && !longFlagsInSeg.some(f => /^--recursive$/i.test(f))) continue;
    const pathArgs = tokens.slice(rmIdx + 1).filter((t) => !t.startsWith("-"));
    for (const target of pathArgs) {
      const normalized = target.replace(/\/\*$/, "").replace(/\/+$/, "") || "/";
      const covered = allowPaths.some((p) => {
        const np = p.replace(/\/+$/, "") || "/";
        return normalized === np || normalized.startsWith(np + "/");
      });
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
  return true;
}

function blockRmRf(ctx: PolicyContext): PolicyResult {
  if (ctx.toolName !== "Bash") return allow();
  const cmd = getCommand(ctx);
  const hasDestructivePath = parseArgvTokens(cmd).some((token) => {
    const normalized = token.replace(/\/\*$/, "").replace(/\/+$/, "") || (token.startsWith("/") ? "/" : "");
    return normalized === "/" || normalized === "~" || /^\/[A-Za-z_][\w.-]*$/.test(normalized);
  });

  // Combined flags in one token: rm -rf /, rm -fr /
  if (hasDestructivePath && (
    /rm\s+-[^\s]*r[^\s]*f[^\s]*/.test(cmd) ||
    /rm\s+-[^\s]*f[^\s]*r[^\s]*/.test(cmd)
  )) {
    const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);
    if (rmTargetIsAllowed(cmd, allowPaths)) return allow();
    return deny("Catastrophic deletion blocked");
  }

  // Separated flags: rm -r -f /, rm -f -r /, rm -r -v -f /, etc.
  if (hasDestructivePath && /\brm\b/.test(cmd)) {
    const tokens = parseArgvTokens(cmd);
    const shortFlags = tokens.filter((t) => /^-[^-]/.test(t)).join("");
    const longFlags = tokens.filter((t) => /^--/.test(t));
    const hasRecursive = /r/i.test(shortFlags) || longFlags.some(f => /^--recursive$/i.test(f));
    const hasForce = /f/.test(shortFlags) || longFlags.some(f => /^--force$/i.test(f));
    if (hasRecursive && hasForce) {
      const allowPaths = ((ctx.params?.allowPaths ?? []) as string[]);
      if (rmTargetIsAllowed(cmd, allowPaths)) return allow();
      return deny("Catastrophic deletion blocked");
    }
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
  const args = extractGitPushArgs(getCommand(ctx));
  if (args.some((a) => FORCE_PUSH_RE.test(a))) {
    return deny("Force-pushing is blocked");
  }
  return allow();
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

function blockFailproofaiCommands(ctx: PolicyContext): PolicyResult {
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

export const BUILTIN_POLICIES: BuiltinPolicyDefinition[] = [
  {
    name: "sanitize-jwt",
    description: "Stop Claude from reading JWTs in tool responses",
    displayTitle: "Redacted JWT tokens from tool output",
    impact: "Stops the agent from echoing auth tokens it saw in command output.",
    fn: sanitizeJwt,
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-api-keys",
    description: "Stop Claude from reading API keys (OpenAI, Anthropic, GitHub, AWS, Stripe, Google) in tool responses",
    displayTitle: "Redacted API keys from tool output",
    impact: "Catches OpenAI / Anthropic / GitHub / AWS / Stripe / Google keys before the model sees them.",
    fn: sanitizeApiKeys,
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
    params: {
      additionalPatterns: {
        type: "pattern[]",
        description: "Additional API key patterns to scrub, each with { regex, label }",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "sanitize-connection-strings",
    description: "Stop Claude from reading database connection strings with embedded credentials in tool responses",
    displayTitle: "Redacted database connection strings from tool output",
    impact: "Strips embedded DB credentials before they reach the model context.",
    fn: sanitizeConnectionStrings,
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-private-key-content",
    description: "Stop Claude from reading PEM private key content in tool responses",
    displayTitle: "Redacted PEM private keys from tool output",
    impact: "Prevents private key bodies from being echoed into chat context.",
    fn: sanitizePrivateKeyContent,
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-bearer-tokens",
    displayTitle: "Redacted bearer tokens from tool output",
    impact: "Strips Authorization: Bearer values before they hit the model.",
    description: "Stop Claude from reading Authorization Bearer tokens in tool responses",
    fn: sanitizeBearerTokens,
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "protect-env-vars",
    displayTitle: "Tried to dump environment variables to chat",
    impact: "Env vars often contain secrets; blocking `env` / `printenv` keeps them out of the model context.",
    description: "Prevent commands that read environment variables",
    fn: protectEnvVars,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Environment",
  },
  {
    name: "block-env-files",
    displayTitle: "Tried to read or write a .env file",
    impact: "`.env` files routinely contain API keys and DB credentials.",
    description: "Block reading/writing .env files",
    fn: blockEnvFiles,
    match: { events: ["PreToolUse"] },
    defaultEnabled: true,
    category: "Environment",
  },
  {
    name: "block-read-outside-cwd",
    displayTitle: "Tried to read files outside your project directory",
    impact: "Stops the agent from peeking at neighboring repos or your home directory.",
    description: "Block file reads outside the session working directory",
    fn: blockReadOutsideCwd,
    match: { events: ["PreToolUse"], toolNames: ["Read", "Glob", "Grep", "Bash"] },
    defaultEnabled: false,
    category: "Environment",
    params: {
      allowPaths: {
        type: "string[]",
        description: "Absolute paths outside cwd that are allowed to be read",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-sudo",
    displayTitle: "Tried to run a command with sudo",
    impact: "Sudo gives the agent root — blocked unless explicitly allow-listed.",
    description: "Block sudo commands",
    fn: blockSudo,
    // PermissionRequest is Codex's escalation-approval event; fire the same
    // sudo guard there so Codex sandbox bypasses are blocked too.
    match: { events: ["PreToolUse", "PermissionRequest"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Dangerous Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "Sudo command patterns to allow, matched token-by-token (e.g. 'sudo systemctl status')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-curl-pipe-sh",
    displayTitle: "Tried to pipe a downloaded script straight to a shell",
    impact: "`curl ... | sh` runs unverified remote code on your machine.",
    description: "Block piping downloads to shell",
    fn: blockCurlPipeSh,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Dangerous Commands",
  },
  {
    name: "block-rm-rf",
    displayTitle: "Tried to recursively delete a system path",
    impact: "Catches catastrophic `rm -rf /` and Windows equivalents.",
    description: "Prevent catastrophic deletions",
    fn: blockRmRf,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Dangerous Commands",
    params: {
      allowPaths: {
        type: "string[]",
        description: "Paths that are allowed to be recursively deleted",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-failproofai-commands",
    displayTitle: "Tried to disable or modify failproofai itself",
    impact: "Prevents the agent from turning off the policies that protect you.",
    description: "Block failproofai CLI commands and uninstallation",
    fn: blockFailproofaiCommands,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Dangerous Commands",
  },
  {
    name: "block-kubectl",
    displayTitle: "Tried to run a Kubernetes command",
    impact: "kubectl can change live cluster state — gated unless allow-listed.",
    description: "Block kubectl commands (Kubernetes cluster mutations)",
    fn: blockKubectl,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "kubectl command patterns to allow, matched token-by-token (e.g. 'kubectl get *', 'kubectl describe *')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-terraform",
    displayTitle: "Tried to run a Terraform/OpenTofu command",
    impact: "Terraform mutates real infrastructure — gated unless allow-listed.",
    description: "Block terraform and tofu (OpenTofu) commands",
    fn: blockTerraform,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "terraform/tofu command patterns to allow (e.g. 'terraform plan', 'terraform validate')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-aws-cli",
    displayTitle: "Tried to run an AWS CLI command",
    impact: "AWS CLI can spend money or break prod — gated.",
    description: "Block aws CLI commands",
    fn: blockAwsCli,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "aws CLI command patterns to allow (e.g. 'aws s3 ls *', 'aws sts get-caller-identity')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-gcloud",
    displayTitle: "Tried to run a Google Cloud command",
    impact: "gcloud can spend money or break prod — gated.",
    description: "Block gcloud (Google Cloud) CLI commands",
    fn: blockGcloud,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "gcloud command patterns to allow (e.g. 'gcloud auth list', 'gcloud config list')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-az-cli",
    displayTitle: "Tried to run an Azure CLI command",
    impact: "az can spend money or break prod — gated.",
    description: "Block az (Azure) CLI commands",
    fn: blockAzCli,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "az CLI command patterns to allow (e.g. 'az account show', 'az group list')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-helm",
    displayTitle: "Tried to run a Helm command",
    impact: "Helm releases mutate cluster state — gated.",
    description: "Block helm commands",
    fn: blockHelm,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "helm command patterns to allow (e.g. 'helm list', 'helm status *')",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-gh-pipeline",
    displayTitle: "Tried to run a privileged GitHub CLI pipeline command",
    impact: "Catches `gh workflow run`, `gh pr merge`, `gh secret set`, etc.",
    description: "Block gh CLI pipeline-trigger subcommands (workflow run, run rerun/cancel, pr merge, release create/delete, cache delete, secret set/delete)",
    fn: blockGhPipeline,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Infra Commands",
    params: {
      allowPatterns: {
        type: "string[]",
        description: "gh pipeline command patterns to allow (e.g. specific scripted invocations); read-only gh subcommands like 'gh pr view' and 'gh run list' are not matched by this policy",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-secrets-write",
    displayTitle: "Tried to write a secret-key file",
    impact: "Stops the agent from creating `.pem`, `id_rsa`, `credentials.json`, etc.",
    description: "Block writing secret key files",
    fn: blockSecretsWrite,
    match: { events: ["PreToolUse"], toolNames: ["Write"] },
    defaultEnabled: false,
    category: "Dangerous Commands",
    params: {
      additionalPatterns: {
        type: "string[]",
        description: "Additional filename patterns (substrings) to block",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-push-master",
    displayTitle: "Tried to push directly to main/master",
    impact: "Direct pushes to a protected branch bypass review.",
    description: "Block pushing to main/master",
    fn: blockPushMaster,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Git",
    params: {
      protectedBranches: {
        type: "string[]",
        description: "Branch names to protect from direct pushes",
        default: ["main", "master"],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "block-force-push",
    displayTitle: "Tried to force-push",
    impact: "Force-pushes rewrite history and can clobber teammates' work.",
    description: "Prevent force-pushing to any branch",
    fn: blockForcePush,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "block-work-on-main",
    displayTitle: "Tried to commit or merge on main/master",
    impact: "Work should land via PR — direct commits skip review.",
    description: "Block git commits and merges on main/master branch",
    fn: blockWorkOnMain,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
    params: {
      protectedBranches: {
        type: "string[]",
        description: "Branch names where commits/merges are blocked",
        default: ["main", "master"],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "warn-git-amend",
    displayTitle: "Used git commit --amend",
    impact: "Amending after a push rewrites history that others may have pulled.",
    description: "Warns before amending git commits, which rewrites history",
    fn: warnGitAmend,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-git-stash-drop",
    displayTitle: "Tried to drop or clear git stash",
    impact: "Stash deletions are permanent and silent.",
    description: "Warns before permanently deleting stashed changes",
    fn: warnGitStashDrop,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-all-files-staged",
    displayTitle: "Staged all files with git add -A / .",
    impact: "Wide stages routinely catch generated files or secrets you didn't intend to commit.",
    description: "Warns before staging all working tree files with git add -A / . / --all",
    fn: warnAllFilesStaged,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-destructive-sql",
    displayTitle: "Ran destructive SQL (DROP / TRUNCATE / DELETE without WHERE)",
    impact: "Easy way to wipe a table by accident.",
    description: "Warn before executing destructive SQL (DROP/TRUNCATE/DELETE without WHERE) via database clients",
    fn: warnDestructiveSql,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Database",
  },
  {
    name: "warn-schema-alteration",
    displayTitle: "Altered a database schema column",
    impact: "ALTER TABLE operations can lock tables and break readers.",
    description: "Warns before SQL schema changes (ALTER TABLE with column or rename operations)",
    fn: warnSchemaAlteration,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Database",
  },
  {
    name: "warn-package-publish",
    displayTitle: "Tried to publish a package",
    impact: "Publishes are irreversible — `npm publish` / `cargo publish` shouldn't happen without intent.",
    description: "Warn before publishing packages to public registries (npm, PyPI, crates.io, RubyGems, etc.)",
    fn: warnPackagePublish,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "warn-global-package-install",
    displayTitle: "Installed a package globally",
    impact: "`npm i -g`, `cargo install`, `pip --user` pollute your machine outside the project.",
    description: "Warns before installing packages globally (npm -g, cargo install, etc.)",
    fn: warnGlobalPackageInstall,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "prefer-package-manager",
    displayTitle: "Used a non-preferred package manager",
    impact: "Mixing package managers creates lockfile churn for your team.",
    description: "Blocks non-preferred package managers and tells Claude to use an allowed one (e.g., uv instead of pip)",
    fn: preferPackageManager,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
    params: {
      allowed: {
        type: "string[]",
        description: "Allowed package manager names (e.g. ['uv', 'bun']). Any detected manager not in this list is blocked.",
        default: [],
      },
      blocked: {
        type: "string[]",
        description: "Additional manager names to block beyond the built-in list (e.g. ['pdm', 'pipx']).",
        default: [],
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "warn-large-file-write",
    displayTitle: "Wrote a file larger than the configured threshold",
    impact: "Catches accidentally large file writes (logs, binaries, model dumps).",
    description: "Warn before writing files larger than 1MB (configurable via thresholdKb param)",
    fn: warnLargeFileWrite,
    match: { events: ["PreToolUse"], toolNames: ["Write"] },
    defaultEnabled: false,
    category: "Packages & System",
    params: {
      thresholdKb: {
        type: "number",
        description: "File size threshold in KB above which a warning is issued",
        default: 1024,
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "warn-background-process",
    displayTitle: "Started a long-lived background process",
    impact: "Catches `nohup` / `&` / `screen` / `tmux` / `disown` patterns that the agent often forgets to clean up.",
    description: "Warns before starting detached or background processes",
    fn: warnBackgroundProcess,
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "warn-repeated-tool-calls",
    displayTitle: "Called the same tool 3+ times with identical arguments",
    impact: "Usually a sign of a stuck loop burning tokens.",
    description: "Warn when the same tool is called 3+ times with identical parameters",
    fn: warnRepeatedToolCalls,
    match: { events: ["PreToolUse"] },
    defaultEnabled: false,
    category: "AI Behavior",
  },
  {
    name: "require-commit-before-stop",
    displayTitle: "Stopped with uncommitted changes",
    impact: "Work not in a commit is invisible to teammates and easy to lose.",
    description: "Require all changes to be committed before Claude stops",
    fn: requireCommitBeforeStop,
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
  },
  {
    name: "require-push-before-stop",
    displayTitle: "Stopped with unpushed commits",
    impact: "Local-only commits won't trigger CI or be reviewable.",
    description: "Require all commits to be pushed to remote before Claude stops",
    fn: requirePushBeforeStop,
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
    params: {
      remote: {
        type: "string",
        description: "Remote name to push to (default: origin)",
        default: "origin",
      },
      baseBranch: {
        type: "string",
        description: "Base branch to compare against (default: main)",
        default: "main",
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "require-pr-before-stop",
    displayTitle: "Stopped without a PR for the branch",
    impact: "Branches without PRs don't get reviewed.",
    description: "Require a pull request to exist for the current branch before Claude stops",
    fn: requirePrBeforeStop,
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
    params: {
      baseBranch: {
        type: "string",
        description: "Base branch to compare against (default: main)",
        default: "main",
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "require-no-conflicts-before-stop",
    displayTitle: "Stopped with a branch that conflicts with main",
    impact: "Conflicting branches can't merge — surface them early.",
    description: "Require the current branch to merge cleanly with the base branch before Claude stops",
    fn: requireNoConflictsBeforeStop,
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
    params: {
      baseBranch: {
        type: "string",
        description: "Base branch to check for conflicts against (default: main)",
        default: "main",
      },
    } satisfies PolicyParamsSchema,
  },
  {
    name: "require-ci-green-before-stop",
    displayTitle: "Stopped with failing CI",
    impact: "Failing CI blocks deploy.",
    description: "Require CI checks to pass on the current HEAD commit before Claude stops (ignores stale runs on prior commits)",
    fn: requireCiGreenBeforeStop,
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
  },
];

export function registerBuiltinPolicies(enabledNames: string[]): void {
  // Tolerate both flat ("sanitize-jwt") and qualified ("failproofai/sanitize-jwt")
  // forms in the user's enabledPolicies config — canonicalize both sides.
  const enabledSet = new Set(enabledNames.map(normalizePolicyName));
  for (const policy of BUILTIN_POLICIES) {
    if (enabledSet.has(normalizePolicyName(policy.name))) {
      registerPolicy(policy.name, policy.description, policy.fn, policy.match);
    }
  }
}

/** Clears the git branch cache. Exposed for test isolation only. */
export function clearGitBranchCache(): void {
  gitBranchCache.clear();
}
