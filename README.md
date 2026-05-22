<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/logo-wordmark.png" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai)
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

> Install hooks for one or any combination: `failproofai policies --install --cli opencode pi gemini` (or `--cli claude codex copilot cursor opencode pi gemini`). Omit `--cli` to auto-detect installed CLIs and prompt.

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

---

Built by [Nivedit Jain](https://github.com/NiveditJain) and [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
