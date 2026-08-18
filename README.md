<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Translations:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**See what your agents do. Stop known failures before they repeat.**
Failproof AI works wherever your agents run: coding tools like Claude Code and
Codex, chat gateways like Hermes, self-hosted assistants like OpenClaw, and agents
you instrument yourself. It records each run and can block dangerous tool calls
before they execute.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Supported harnesses

Twelve harnesses in two classes are supported: ten coding CLIs, plus two
gateways: Hermes, OpenClaw. The policy API and session history are shared; which
events can block varies by harness.

Agents that run in none of them report through the [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
which gives you tracing, sessions and audits. Enforcement there needs a hook in
your own runtime — [talk to us](mailto:support@befailproof.ai) and we'll map it.

<!-- A 7-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×7 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). Kept at exactly two full
     rows — 14 CLIs is 7×2, where 6 columns would leave a two-cell orphan row. -->
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://grok.com" title="grok CLI (xAI)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/grok-dark.svg" />
          <img src="assets/logos/grok-light.svg" alt="grok CLI" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/QwenLM/qwen-code" title="Qwen Code (qwen)">
        <img src="assets/logos/qwen.svg" alt="Qwen Code" width="56" height="56" />
      </a>
    </td>
  </tr>
</table>

## Install

Give a compatible agent the Failproof AI skill if you want it to guide setup,
inspect the machine, and route policy, audit, session, and Cloud work correctly:

```sh
npx skills add FailproofAI/skills
```

This installs the umbrella skill and its specialist siblings. To install only the
umbrella, add `--skill failproofai`. Skills supply operating instructions; install
and configure the product itself with:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

Setup connects supported agents and installs the background service. It chooses no
policy pack: before you add one, only `block-failproofai-commands` runs to stop an
agent disabling Failproof AI.

Connect Cloud without prompts with `failproofai config --token <machine-key>`. On a
shared machine or in CI, set `FAILPROOFAI_CLOUD_TOKEN` and run `failproofai config`
so the key does not appear in command history.

---

## What it stops

| Policy | What it blocks |
|---|---|
| `sanitize-api-keys` | API keys leaking into the agent's context |
| `block-env-files` | Reads of `.env` and other secret files |
| `warn-repeated-tool-calls` | The agent looping on the same call |
| `block-sudo` | Privilege escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | Unreviewed changes to live infrastructure |
| `block-rm-rf` | Recursive file deletion |
| `block-force-push` / `block-push-master` | `git push --force`, direct pushes to `main` |

These policies protect files, credentials, infrastructure, databases, and agent
workflows. Exact enforcement support varies by harness and event.

→ [All 39 built-in policies](https://docs.befailproof.ai/policies/builtin)

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

→ [Custom policies guide](https://docs.befailproof.ai/policies/custom)

---

## Policy packs

A policy pack is a versioned set of policies published from a public GitHub
repository. Inspect one before installing it:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Anything with a slash is a pack source; anything without one is a policy name.
You can install selected categories or policies, and pin a release when needed.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Browse published packs in the [Policy Hub](https://befailproof.ai/policy-hub/), or
run `failproofai publish --init` to start your own. Observe mode lets a pack record
what it would have done without blocking: `failproofai publish --effect observe`.

→ [Policy packs](https://docs.befailproof.ai/policies/packs) ·
[Publish a pack](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Observability

Enforcement is one half. The other half is seeing what the agent actually did.

Run `failproofai` with no arguments and it serves a dashboard on `localhost:8020`
reading the run history already on your machine — no account, no signup, nothing
leaving the box. You get the session list, the sequence of model calls, tool calls
and hook decisions inside each run, what was blocked and what the policy told the
agent, and an offline audit (`failproofai audit`) that scans your history for risky
patterns and suggests policies to stop them.

→ [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[Read a trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Local audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** is the hosted side of the same data model, for teams
running agents across a fleet: every run from every harness in one place, an
execution graph with parallel sub-agents on their own lanes, p50/p95/p99 latency
for models, tools and hooks, per-model cost and context-window tracking, error
tracking, SQL over your own traces with shareable dashboards, evaluations scored by
your own service, scheduled audits that turn recurring failures into evidence-backed
findings, and alerts routed to Slack, email or a signed webhook. Self-hosting in your
own cluster is available on the Enterprise plan.

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Book a demo](https://befailproof.ai/get-a-demo)

---

## Documentation

| Start | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Install, connect a harness, see the first run |
| [Concepts](https://docs.befailproof.ai/start/concepts) | How the hook system works |
| [Supported harnesses](https://docs.befailproof.ai/reference/harnesses) | All 12, and what each one can enforce |

| Observe | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | Follow a run: models, tools, errors, latency |
| [Read a trace](https://docs.befailproof.ai/sessions/read-a-trace) | What the execution graph is telling you |
| [Audits](https://docs.befailproof.ai/audits/overview) | Find failure patterns across many sessions |
| [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, no account needed |

| Enforce | |
|---|---|
| [Built-in policies](https://docs.befailproof.ai/policies/builtin) | All 39 policies with parameters |
| [Custom policies](https://docs.befailproof.ai/policies/custom) | Write your own |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Config scopes and merge rules |

| Instrument your own agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Report runs from an agent with no harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

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

Built with ❤️ by [befailproof.ai](https://befailproof.ai) in SF and Bengaluru.
