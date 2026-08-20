/**
 * The builtin policy CATALOG: what each policy is, never what it does.
 *
 * Split out of `builtin-policies.ts` so the metadata every consumer actually
 * reads — the setup picker, `failproofai policies`, the presets, the audit
 * report, the dashboard's server action — can be listed, searched and rendered
 * without loading a single policy implementation. That is what lets a machine
 * browse the catalog offline while the executable half moves to a fetched pack.
 *
 * ## Rules this file lives by
 *
 * - **Pure data.** No functions, no RegExp, no computed values. Every entry is
 *   a literal, so this module can be read, serialized, and eventually shipped
 *   as a manifest rather than as code.
 * - **No value import from `builtin-policies.ts`.** Type-only imports are fine.
 *   `policy-evaluator.ts` builds `POLICY_PARAMS_MAP` from `BUILTIN_POLICIES` at
 *   MODULE SCOPE, so an import cycle here is a ReferenceError under ESM and a
 *   `.filter of undefined` under the CJS bundle — thrown at import time, on the
 *   hook critical path.
 * - **Order is load-bearing and must not be sorted or regrouped.** Policy
 *   evaluation short-circuits on the first deny, so this array's order decides
 *   which policy name reaches the agent, the activity log, PostHog and the audit
 *   report. First appearance of each `category` is also what orders the sections
 *   in the TUI picker and the dashboard.
 * - **Absent optionals stay absent.** `beta`, `alwaysOn` and `params` are read
 *   with `in` and `undefined` checks; default-filling them changes behaviour and
 *   fails existing tests.
 *
 * `params.default` values are handed to policies BY REFERENCE, so this must stay
 * one module-level const — never a factory minting fresh defaults per call.
 */
import type { PolicyCatalogEntry, PolicyParamsSchema } from "./policy-types";

export const POLICY_CATALOG: PolicyCatalogEntry[] = [
  {
    name: "sanitize-jwt",
    description: "Stop Claude from reading JWTs in tool responses",
    displayTitle: "Redacted JWT tokens from tool output",
    impact: "Stops the agent from echoing auth tokens it saw in command output.",
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-api-keys",
    description: "Stop Claude from reading API keys (OpenAI, Anthropic, GitHub, AWS, Stripe, Google) in tool responses",
    displayTitle: "Redacted API keys from tool output",
    impact: "Catches OpenAI / Anthropic / GitHub / AWS / Stripe / Google keys before the model sees them.",
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
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-private-key-content",
    description: "Stop Claude from reading PEM private key content in tool responses",
    displayTitle: "Redacted PEM private keys from tool output",
    impact: "Prevents private key bodies from being echoed into chat context.",
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "sanitize-bearer-tokens",
    displayTitle: "Redacted bearer tokens from tool output",
    impact: "Strips Authorization: Bearer values before they hit the model.",
    description: "Stop Claude from reading Authorization Bearer tokens in tool responses",
    match: { events: ["PostToolUse"] },
    defaultEnabled: true,
    category: "Sanitize",
  },
  {
    name: "protect-env-vars",
    displayTitle: "Tried to dump environment variables to chat",
    impact: "Env vars often contain secrets; blocking `env` / `printenv` keeps them out of the model context.",
    description: "Prevent commands that read environment variables",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Environment",
  },
  {
    name: "block-env-files",
    displayTitle: "Tried to read or write a .env file",
    impact: "`.env` files routinely contain API keys and DB credentials.",
    description: "Block reading/writing .env files",
    match: { events: ["PreToolUse"] },
    defaultEnabled: true,
    category: "Environment",
  },
  {
    name: "block-read-outside-cwd",
    displayTitle: "Tried to read files outside your project directory",
    impact: "Stops the agent from peeking at neighboring repos or your home directory.",
    description: "Block file reads outside the session working directory",
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
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: true,
    category: "Dangerous Commands",
  },
  {
    name: "block-rm-rf",
    displayTitle: "Tried to recursively delete a system path",
    impact: "Catches catastrophic `rm -rf /` and Windows equivalents.",
    description: "Prevent catastrophic deletions",
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
    displayTitle: "Tried to disable, pause or modify failproofai itself",
    impact: "An agent that can pause or remove enforcement can switch off every other policy.",
    description: "Block failproofai CLI commands, self-pause and uninstallation",
    // PermissionRequest is carried over from the merged-in `block-self-pause`.
    // It is a real enforcement point on Copilot and Devin, and dropping it would
    // have left this guard blind on both.
    match: { events: ["PreToolUse", "PermissionRequest"], toolNames: ["Bash"] },
    defaultEnabled: true,
    alwaysOn: true,
    category: "Dangerous Commands",
  },
  {
    name: "block-kubectl",
    displayTitle: "Tried to run a Kubernetes command",
    impact: "kubectl can change live cluster state — gated unless allow-listed.",
    description: "Block kubectl commands (Kubernetes cluster mutations)",
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
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "block-work-on-main",
    displayTitle: "Tried to commit or merge on main/master",
    impact: "Work should land via PR — direct commits skip review.",
    description: "Block git commits and merges on main/master branch",
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
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-git-stash-drop",
    displayTitle: "Tried to drop or clear git stash",
    impact: "Stash deletions are permanent and silent.",
    description: "Warns before permanently deleting stashed changes",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-all-files-staged",
    displayTitle: "Staged all files with git add -A / .",
    impact: "Wide stages routinely catch generated files or secrets you didn't intend to commit.",
    description: "Warns before staging all working tree files with git add -A / . / --all",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Git",
  },
  {
    name: "warn-destructive-sql",
    displayTitle: "Ran destructive SQL (DROP / TRUNCATE / DELETE without WHERE)",
    impact: "Easy way to wipe a table by accident.",
    description: "Warn before executing destructive SQL (DROP/TRUNCATE/DELETE without WHERE) via database clients",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Database",
  },
  {
    name: "warn-schema-alteration",
    displayTitle: "Altered a database schema column",
    impact: "ALTER TABLE operations can lock tables and break readers.",
    description: "Warns before SQL schema changes (ALTER TABLE with column or rename operations)",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Database",
  },
  {
    name: "warn-package-publish",
    displayTitle: "Tried to publish a package",
    impact: "Publishes are irreversible — `npm publish` / `cargo publish` shouldn't happen without intent.",
    description: "Warn before publishing packages to public registries (npm, PyPI, crates.io, RubyGems, etc.)",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "warn-global-package-install",
    displayTitle: "Installed a package globally",
    impact: "`npm i -g`, `cargo install`, `pip --user` pollute your machine outside the project.",
    description: "Warns before installing packages globally (npm -g, cargo install, etc.)",
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "prefer-package-manager",
    displayTitle: "Used a non-preferred package manager",
    impact: "Mixing package managers creates lockfile churn for your team.",
    description: "Blocks non-preferred package managers and tells Claude to use an allowed one (e.g., uv instead of pip)",
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
    match: { events: ["PreToolUse"], toolNames: ["Bash"] },
    defaultEnabled: false,
    category: "Packages & System",
  },
  {
    name: "warn-repeated-tool-calls",
    displayTitle: "Called the same tool 3+ times with identical arguments",
    impact: "Usually a sign of a stuck loop burning tokens.",
    description: "Warn when the same tool is called 3+ times with identical parameters",
    match: { events: ["PreToolUse"] },
    defaultEnabled: false,
    category: "AI Behavior",
  },
  {
    name: "require-commit-before-stop",
    displayTitle: "Stopped with uncommitted changes",
    impact: "Work not in a commit is invisible to teammates and easy to lose.",
    description: "Require all changes to be committed before Claude stops",
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
  },
  {
    name: "require-push-before-stop",
    displayTitle: "Stopped with unpushed commits",
    impact: "Local-only commits won't trigger CI or be reviewable.",
    description: "Require all commits to be pushed to remote before Claude stops",
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
    match: { events: ["Stop"] },
    defaultEnabled: false,
    category: "Workflow",
  },
];
