# Builtin policies (39)

**Generated — do not hand-edit.** Regenerate with:

```bash
bun .claude/skills/policy-author/scripts/sync-builtins.mjs
```

This snapshot goes stale whenever a builtin is added, renamed, or has its default
flipped. When it matters, ask the CLI instead — it is always current:

```bash
failproofai policies          # every policy, with enabled status and params
```

## How to use this for triage

Enabling a builtin beats writing a custom policy: nothing to maintain, no naming
trap, no fail-open risk, and it ships with tests.

Before concluding "no builtin covers this", check whether a **parameterized** one
does — several take allowlists or thresholds that widen their scope considerably.
Params go in the `policyParams` map, keyed by short name.

To enable: add the short name to `enabledPolicies` in `.failproofai/policies-config.json`.

---

### Sanitize

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `sanitize-jwt` | **on** | PostToolUse | Stop Claude from reading JWTs in tool responses |
| `sanitize-api-keys` | **on** | PostToolUse | Stop Claude from reading API keys (OpenAI, Anthropic, GitHub, AWS, Stripe, Google) in tool responses _(params: additionalPatterns)_ |
| `sanitize-connection-strings` | **on** | PostToolUse | Stop Claude from reading database connection strings with embedded credentials in tool responses |
| `sanitize-private-key-content` | **on** | PostToolUse | Stop Claude from reading PEM private key content in tool responses |
| `sanitize-bearer-tokens` | **on** | PostToolUse | Stop Claude from reading Authorization Bearer tokens in tool responses |

### Environment

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `protect-env-vars` | **on** | PreToolUse | Prevent commands that read environment variables |
| `block-env-files` | **on** | PreToolUse | Block reading/writing .env files |
| `block-read-outside-cwd` | off | PreToolUse | Block file reads outside the session working directory _(params: allowPaths)_ |

### Dangerous Commands

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `block-sudo` | **on** | PreToolUse, PermissionRequest | Block sudo commands _(params: allowPatterns)_ |
| `block-curl-pipe-sh` | **on** | PreToolUse | Block piping downloads to shell |
| `block-rm-rf` | off | PreToolUse | Prevent catastrophic deletions _(params: allowPaths)_ |
| `block-failproofai-commands` | **on** | PreToolUse | Block failproofai CLI commands and uninstallation |
| `block-secrets-write` | off | PreToolUse | Block writing secret key files _(params: additionalPatterns)_ |

### Infra Commands

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `block-kubectl` | off | PreToolUse | Block kubectl commands (Kubernetes cluster mutations) _(params: allowPatterns)_ |
| `block-terraform` | off | PreToolUse | Block terraform and tofu (OpenTofu) commands _(params: allowPatterns)_ |
| `block-aws-cli` | off | PreToolUse | Block aws CLI commands _(params: allowPatterns)_ |
| `block-gcloud` | off | PreToolUse | Block gcloud (Google Cloud) CLI commands _(params: allowPatterns)_ |
| `block-az-cli` | off | PreToolUse | Block az (Azure) CLI commands _(params: allowPatterns)_ |
| `block-helm` | off | PreToolUse | Block helm commands _(params: allowPatterns)_ |
| `block-gh-pipeline` | off | PreToolUse | Block gh CLI pipeline-trigger subcommands (workflow run, run rerun/cancel, pr merge, release create/delete, cache delete, secret set/delete) _(params: allowPatterns)_ |

### Git

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `block-push-master` | **on** | PreToolUse | Block pushing to main/master _(params: protectedBranches)_ |
| `block-force-push` | off | PreToolUse | Prevent force-pushing to any branch |
| `block-work-on-main` | off | PreToolUse | Block git commits and merges on main/master branch _(params: protectedBranches)_ |
| `warn-git-amend` | off | PreToolUse | Warns before amending git commits, which rewrites history |
| `warn-git-stash-drop` | off | PreToolUse | Warns before permanently deleting stashed changes |
| `warn-all-files-staged` | off | PreToolUse | Warns before staging all working tree files with git add -A / . / --all |

### Database

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `warn-destructive-sql` | off | PreToolUse | Warn before executing destructive SQL (DROP/TRUNCATE/DELETE without WHERE) via database clients |
| `warn-schema-alteration` | off | PreToolUse | Warns before SQL schema changes (ALTER TABLE with column or rename operations) |

### Packages & System

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `warn-package-publish` | off | PreToolUse | Warn before publishing packages to public registries (npm, PyPI, crates.io, RubyGems, etc.) |
| `warn-global-package-install` | off | PreToolUse | Warns before installing packages globally (npm -g, cargo install, etc.) |
| `prefer-package-manager` | off | PreToolUse | Blocks non-preferred package managers and tells Claude to use an allowed one (e.g., uv instead of pip) _(params: allowed, blocked)_ |
| `warn-large-file-write` | off | PreToolUse | Warn before writing files larger than 1MB (configurable via thresholdKb param) _(params: thresholdKb)_ |
| `warn-background-process` | off | PreToolUse | Warns before starting detached or background processes |

### AI Behavior

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `warn-repeated-tool-calls` | off | PreToolUse | Warn when the same tool is called 3+ times with identical parameters |

### Workflow

| Policy | Default | Events | What it catches |
|---|---|---|---|
| `require-commit-before-stop` | off | Stop | Require all changes to be committed before Claude stops |
| `require-push-before-stop` | off | Stop | Require all commits to be pushed to remote before Claude stops _(params: remote, baseBranch)_ |
| `require-pr-before-stop` | off | Stop | Require a pull request to exist for the current branch before Claude stops _(params: baseBranch)_ |
| `require-no-conflicts-before-stop` | off | Stop | Require the current branch to merge cleanly with the base branch before Claude stops _(params: baseBranch)_ |
| `require-ci-green-before-stop` | off | Stop | Require CI checks to pass on the current HEAD commit before Claude stops (ignores stale runs on prior commits) |

> The five `require-*-before-stop` policies gate the end of a turn. A gate whose
> condition cannot be met in the current project loops forever — see `traps.md` §6
> before enabling one.

---

## Audit-only detectors

These have no real-time builtin equivalent, so they are the prime candidates for
custom policies. List them from source with:

```bash
bun -e 'const {AUDIT_DETECTORS}=await import("./src/audit/detectors/index.ts");
for (const d of AUDIT_DETECTORS) console.log(d.name, "|", d.category+"/"+d.severity, "|", d.description)'
```

All but `reread-after-edit` are Bash-command patterns, so a `PreToolUse` policy
filtering on `ctx.toolName === "Bash"` and matching `ctx.toolInput.command` covers
most of them. `reread-after-edit` needs cross-call session state, which hooks cannot
see — that one needs a builtin, not a custom policy.
