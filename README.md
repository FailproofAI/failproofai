<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Translations:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Runtime failure resolution for coding agents.**
Hooks into Claude Code and Codex. Catches loops, dangerous actions, and secret leaks
before they become incidents. Zero latency. Runs locally.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Supported agent CLIs

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> Install hooks for one or any combination: `failproofai policies --install --cli opencode pi` (or `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Omit `--cli` to auto-detect installed CLIs and prompt.
>
> **Hermes** (hermes-agent, a Slack/Telegram gateway) is supported for both **live-hook enforcement** (`--cli hermes` — one install intercepts tool calls from every platform and subagent) and offline **audit** replay of its gateway sessions from the single `~/.hermes/state.db`.
>
> **OpenClaw** (openclaw gateway, a self-hosted multi-channel assistant) is supported for both **live-hook enforcement** (`--cli openclaw`, user-scope) and offline **audit** replay of its JSONL sessions (`~/.openclaw/agents/<id>/sessions/*.jsonl`). Enforcement uses OpenClaw's **in-process plugin hooks** (a shipped `openclaw-plugin/` that async-spawns failproofai — its file-based internal hooks are observation-only and can't block): `before_tool_call` blocks a tool, and `before_agent_finalize` is a real turn-end gate, so the `require-*-before-stop` builtins enforce.
>
> **Factory Droid** (`droid`) is supported for both **live-hook enforcement** (`--cli factory`, user + project scope) and offline **audit** replay of its on-disk JSONL sessions. droid blocks tool calls off hook **exit code 2** (not a JSON decision) and honors `{decision:"block"}` only on the turn-end `Stop` event — failproofai emits the right shape per event automatically.
>
> **Devin CLI** (`devin`, Cognition) is supported for both **live-hook enforcement** (`--cli devin`, user + project scope) and offline **audit** replay of its SQLite sessions (`~/.local/share/devin/cli/sessions.db`). Devin is a **pure Claude-clone** — same event names, same snake_case payload, same `"hooks"`-wrapper config (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — blocking via `{decision:"block"}` JSON on every event.
>
> **Antigravity CLI** (`agy`) is supported for both **live-hook enforcement** (`--cli antigravity`, user + project scope) and offline **audit** replay of its plain-JSONL sessions (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity has its **own** contract (not a Claude-clone): a **named-hook** `hooks.json` schema (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), a camelCase stdin payload that failproofai normalizes, and its own response shapes — `{decision:"deny"}` to block a tool, `{decision:"continue"}` to force another turn at `Stop`, `{injectSteps}` to inject a reminder before the model runs.
>
> **Goose** (codename goose, Block) is supported for both **live-hook enforcement** (`--cli goose`, user + project scope) and offline **audit** replay of its SQLite sessions (`~/.local/share/goose/sessions/sessions.db`). Enforcement uses Goose's **hooks** system (the cross-agent **Open Plugins** spec) — the installer just drops a plugin dir at `~/.agents/plugins/failproofai/` and Goose auto-discovers it. Blocking is `{"decision":"block"}` JSON on the `PreToolUse` event (which fires for the shell tool and inside delegated subagents), verified live against goose v1.43.0; Goose has no turn-end `Stop` event, so the `require-*-before-stop` builtins don't apply (as with Hermes).

---

## Install

```sh
npm install -g failproofai
failproofai policies --install   # or just run `failproofai` and accept the first-run prompt
failproofai
```

30 built-in policies activate immediately. Dashboard at `localhost:8020`. Disable the first-run prompt with `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## What it stops

| Policy | What it blocks |
|---|---|
| `block-push-master` | Direct pushes to `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases on `main` / `master` |
| `block-rm-rf` | Recursive file deletion |
| `sanitize-api-keys` | API keys leaking into agent context |

→ [All 30 built-in policies](https://docs.befailproof.ai/built-in-policies)

---

## Your own policies

Drop a file into `.failproofai/policies/` — it loads automatically, no flags needed.
Commit it and the whole team gets it on next pull.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Writes to production paths are blocked.");
    return allow();
  },
});
```

Three decisions available to every policy:

| Decision | Effect |
|---|---|
| `allow()` | Permit the operation |
| `deny(message)` | Block it — message goes back to the agent |
| `instruct(message)` | Let it through, but add context to the agent's next prompt |

→ [Custom policies guide](https://docs.befailproof.ai/custom-policies)

---

## Session visibility

Every tool call your agent makes is logged locally. The dashboard shows what ran,
what was blocked, and what the policy told the agent — so you're not guessing
when something goes wrong. → [Dashboard guide](https://docs.befailproof.ai/dashboard)

---

## Documentation

| | |
|---|---|
| [Getting Started](https://docs.befailproof.ai/getting-started) | Installation and first steps |
| [Built-in Policies](https://docs.befailproof.ai/built-in-policies) | All 30 policies with parameters |
| [Custom Policies](https://docs.befailproof.ai/custom-policies) | Write your own |
| [Configuration](https://docs.befailproof.ai/configuration) | Config scopes and merge rules |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Session monitor and policy activity |
| [Architecture](https://docs.befailproof.ai/architecture) | How the hook system works |

---

## License

MIT with [Commons Clause](https://commonsclause.com/) — free for internal and personal use; commercial resale of failproofai itself requires a separate agreement. See [LICENSE](./LICENSE) for the full text.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). New policies, edge cases, and translations all welcome.

> **Build before you start.** Run `bun install && bun run build` first. This repo runs
> failproofai's own hooks on itself, and they resolve the `failproofai` import against the
> compiled `dist/` bundle — without a build you'll hit `Cannot find package 'failproofai'`
> hook errors. Rebuild after changing `src/`. See
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Built by [Nivedit Jain](https://github.com/NiveditJain) and [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
