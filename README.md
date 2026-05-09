```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**Translations**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

The easiest way to manage policies that keep your AI agents reliable, on-task, and running autonomously - for **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ & the **Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI in action" width="800" />
</p>

## Supported agent CLIs

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> Install hooks for one or any combination: `failproofai policies --install --cli opencode pi gemini` (or `--cli claude codex copilot cursor opencode pi gemini`). Omit `--cli` to auto-detect installed CLIs and prompt. **GitHub Copilot CLI, Cursor Agent, OpenCode, Pi, and Gemini CLI support are in beta — testing is ongoing.**

- **39 Built-in Policies** - Catch common agent failure modes out of the box. Block destructive commands, prevent secret leakage, keep agents inside project boundaries, detect loops, and more.
- **Custom Policies** - Write your own reliability rules in JavaScript. Use the `allow`/`deny`/`instruct` API to enforce conventions, prevent drift, gate operations, or integrate with external systems.
- **Easy Configuration** - Tune any policy without writing code. Set allowlists, protected branches, thresholds per-project or globally. Three-scope config merges automatically.
- **Agent Monitor** - See what your agents did while you were away. Browse sessions, inspect every tool call, and review exactly where policies fired.

Everything runs locally - no data leaves your machine.

---

## Requirements

- Node.js >= 20.9.0
- Bun >= 1.3.0 (optional - only needed for development / building from source)

---

## Install

```bash
npm install -g failproofai
# or
bun add -g failproofai
```

---

## Quick start

### 1. Enable policies globally

```bash
failproofai policies --install
```

Writes hook entries into `~/.claude/settings.json`. Claude Code will now invoke failproofai before and after each tool call.

### 2. Launch the dashboard

```bash
failproofai
```

Opens `http://localhost:8020` - browse sessions, inspect logs, manage policies.

### 3. Check what's active

```bash
failproofai policies
```

---

## Policy installation

### Scopes

| Scope | Command | Where it writes |
|-------|---------|-----------------|
| Global (default) | `failproofai policies --install` | `~/.claude/settings.json` |
| Project | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Local | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Install specific policies

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Remove policies

```bash
failproofai policies --uninstall
# or for a specific scope:
failproofai policies --uninstall --scope project
```

---

## Configuration

Policy configuration lives in `~/.failproofai/policies-config.json` (global) or `.failproofai/policies-config.json` in your project (per-project).

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "Use apt-get directly without sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Try creating a fresh branch instead."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**Three config scopes** are merged automatically (project → local → global). See [docs/configuration.mdx](docs/configuration.mdx) for full merge rules.

---

## Built-in policies

| Policy | Description | Configurable |
|--------|-------------|:---:|
| `block-sudo` | Prevent agents from running privileged system commands | `allowPatterns` |
| `block-rm-rf` | Prevent accidental recursive file deletion | `allowPaths` |
| `block-curl-pipe-sh` | Prevent agents from piping untrusted scripts to shell | |
| `block-failproofai-commands` | Prevent self-uninstallation | |
| `sanitize-jwt` | Stop JWT tokens from leaking into agent context | |
| `sanitize-api-keys` | Stop API keys from leaking into agent context | `additionalPatterns` |
| `sanitize-connection-strings` | Stop database credentials from leaking into agent context | |
| `sanitize-private-key-content` | Redact PEM private key blocks from output | |
| `sanitize-bearer-tokens` | Redact Authorization Bearer tokens from output | |
| `block-env-files` | Keep agents from reading .env files | |
| `protect-env-vars` | Prevent agents from printing environment variables | |
| `block-read-outside-cwd` | Keep agents inside project boundaries | `allowPaths` |
| `block-secrets-write` | Prevent writes to private key and certificate files | `additionalPatterns` |
| `block-push-master` | Prevent accidental pushes to main/master | `protectedBranches` |
| `block-work-on-main` | Keep agents off protected branches | `protectedBranches` |
| `block-force-push` | Prevent `git push --force` | |
| `warn-git-amend` | Remind agents before amending commits | |
| `warn-git-stash-drop` | Remind agents before dropping stashes | |
| `warn-all-files-staged` | Catch accidental `git add -A` | |
| `warn-destructive-sql` | Catch DROP/DELETE SQL before execution | |
| `warn-schema-alteration` | Catch ALTER TABLE before execution | |
| `warn-large-file-write` | Catch unexpectedly large file writes | `thresholdKb` |
| `warn-package-publish` | Catch accidental `npm publish` | |
| `warn-background-process` | Catch unintended background process launches | |
| `warn-global-package-install` | Catch unintended global package installs | |
| …and more | | |

Full policy details and parameter reference: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Custom policies

Write your own policies to keep agents reliable and on-task:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Block writes to paths containing 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Writes to production paths are blocked");
    return allow();
  },
});
```

Install with:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Decision helpers

| Function | Effect |
|----------|--------|
| `allow()` | Permit the operation |
| `allow(message)` | Permit and send informational context to Claude |
| `deny(message)` | Block the operation; message shown to Claude |
| `instruct(message)` | Add context to Claude's prompt; does not block |

### Context object (`ctx`)

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | Tool being called (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | Tool's input parameters |
| `payload` | `object` | Full raw event payload |
| `session.cwd` | `string` | Working directory of the Claude Code session |
| `session.sessionId` | `string` | Session identifier |
| `session.transcriptPath` | `string` | Path to the session transcript file |

Custom hooks support transitive local imports, async/await, and access to `process.env`. Errors are fail-open (logged to `~/.failproofai/hook.log`, built-in policies continue). See [docs/custom-hooks.mdx](docs/custom-hooks.mdx) for the full guide.

### Convention-based policies

Drop `*policies.{js,mjs,ts}` files into `.failproofai/policies/` and they're automatically loaded — no flags or config changes needed. Commit the directory to git and every team member gets the same quality standards automatically.

```text
# Project level — committed to git, shared with the team
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# User level — personal, applies to all projects
~/.failproofai/policies/my-policies.mjs
```

Both levels load (union). Files are loaded alphabetically within each directory. Prefix with `01-`, `02-`, etc. to control order. As your team discovers new failure modes, add a policy and push — everyone gets the update on their next pull. See [examples/convention-policies/](examples/convention-policies/) for ready-to-use examples.

---

## Telemetry

Failproof AI collects anonymous usage telemetry via PostHog to understand feature usage. No session content, file names, tool inputs, or personal information is ever sent.

Disable it:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | Installation and first steps |
| [Built-in Policies](docs/built-in-policies.mdx) | All 39 built-in policies with parameters |
| [Custom Policies](docs/custom-policies.mdx) | Write your own policies |
| [Configuration](docs/configuration.mdx) | Config file format and scope merging |
| [Dashboard](docs/dashboard.mdx) | Monitor sessions and review policy activity |
| [Architecture](docs/architecture.mdx) | How the hook system works |
| [Testing](docs/testing.mdx) | Running tests and writing new ones |

### Run docs locally

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Opens the Mintlify docs site at `http://localhost:3000`. The container watches for changes if you mount the docs directory:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## Note for failproofai contributors

This repo's `.claude/settings.json` uses `bun ./bin/failproofai.mjs --hook <EventType>` instead of the standard `npx -y failproofai` command. This is because running `npx -y failproofai` inside the failproofai project itself creates a self-referencing conflict.

For all other repos, the recommended approach is `npx -y failproofai`, installed via:

```bash
failproofai policies --install --scope project
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

See [LICENSE](LICENSE).

---

Built and Maintained by **ExosphereHost: Reliability Research Lab for Your Agents**. We help enterprises and startups improve the reliability of their AI agents through our own agents, software, and expertise. Learn more at [exosphere.host](https://exosphere.host).
