/**
 * Built-in security policies for Claude Code hooks.
 *
 * This module is the registry: it names, describes, categorises, orders, and
 * registers all 39 builtins, and it is still the only module the rest of the
 * codebase imports. The *implementations* live one directory down, split by
 * capability (Stage 0 / P1):
 *
 *   • `./builtin/payload-only.ts` — 32 policies that decide from the hook
 *     payload alone. Sealed-tier eligible; its import graph reaches no host
 *     module.
 *   • `./builtin/host-access.ts`  — 7 policies that spawn `git` / `gh` or read
 *     and write a transcript sidecar. `user-context` tier.
 *
 * The split is load-bearing, not cosmetic. Execution tiers are derived from a
 * policy's resolved import graph, so while all 39 shared one module importing
 * `node:child_process`, derivation would have routed every one of them to
 * `user-context` and left the sealed tier empty — an architecture that looks
 * implemented and delivers no verdict integrity.
 * `__tests__/hooks/builtin-tier-split.test.ts` asserts both the registry
 * snapshot and the real transitive import graph.
 *
 * This file itself is deliberately NOT import-pure: it wires the host-side
 * logger and home-directory fallback into the two pure seams the sealed half
 * depends on (`./builtin/warn`, `./builtin/host-context`), so the legacy
 * in-process path behaves exactly as it did before the split.
 */
import { homedir } from "node:os";
import type { BuiltinPolicyDefinition, PolicyParamsSchema } from "./policy-types";
import { normalizePolicyName, registerPolicy } from "./policy-registry";
import { hookLogWarn } from "./hook-logger";
import { setPolicyWarnSink } from "./builtin/warn";
import { setHostContextFallback } from "./builtin/host-context";
import {
  sanitizeJwt,
  sanitizeApiKeys,
  sanitizeConnectionStrings,
  sanitizePrivateKeyContent,
  sanitizeBearerTokens,
  protectEnvVars,
  blockEnvFiles,
  blockReadOutsideCwd,
  blockSudo,
  blockCurlPipeSh,
  blockRmRf,
  blockFailproofaiCommands,
  blockKubectl,
  blockTerraform,
  blockAwsCli,
  blockGcloud,
  blockAzCli,
  blockHelm,
  blockGhPipeline,
  blockSecretsWrite,
  blockPushMaster,
  blockForcePush,
  warnGitAmend,
  warnGitStashDrop,
  warnAllFilesStaged,
  warnDestructiveSql,
  warnSchemaAlteration,
  warnPackagePublish,
  warnGlobalPackageInstall,
  preferPackageManager,
  warnLargeFileWrite,
  warnBackgroundProcess,
} from "./builtin/payload-only";
import {
  blockWorkOnMain,
  warnRepeatedToolCalls,
  requireCommitBeforeStop,
  requirePushBeforeStop,
  requirePrBeforeStop,
  requireNoConflictsBeforeStop,
  requireCiGreenBeforeStop,
  clearGitBranchCache,
} from "./builtin/host-access";

/**
 * Wire the host into the sealed half's two injectable seams.
 *
 * Both defaults are inert, so this is what preserves current behaviour on the
 * legacy in-process path: policy warnings reach the rotating log file, and
 * `~` / `$CLAUDE_PROJECT_DIR` resolve from this process's own environment when
 * the request envelope did not carry them.
 *
 * In the daemon neither fallback is installed — `home` is derived from
 * `getpwuid_r(peer_uid)` at the socket boundary and travels as request data,
 * because the daemon's own `homedir()` belongs to the service account, not to
 * the user being enforced. See ./builtin/host-context.
 */
setPolicyWarnSink(hookLogWarn);
setHostContextFallback({
  home: () => homedir(),
  projectDir: () => process.env.CLAUDE_PROJECT_DIR,
});

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

/**
 * Clears the git branch cache. Exposed for test isolation only.
 * Re-exported from ./builtin/host-access, which now owns the cache.
 */
export { clearGitBranchCache };
