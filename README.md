<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Translations:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**The reliability layer for autonomous agents: see every failure, stop it in realtime.**
Observe every run, find where your agents fail, write a policy, and enforce it before
the bad action runs. Failproof hooks 12 agent harnesses — coding CLIs like Claude Code
and Codex, chat gateways like Hermes, self-hosted assistants like OpenClaw — capturing
every run and blocking dangerous tool calls before they execute. Policies come as packs.
Zero latency. Runs locally, free; connect to Failproof Cloud when you want the whole fleet.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Supported harnesses

Twelve harnesses in two classes — ten coding CLIs, and two chat and assistant
gateways (Hermes, OpenClaw). One policy API and one session history across all
of them. What a policy can *block* is per-harness: stopping a tool call before
it runs is verified on all twelve, turn-end gates on eight. The
[per-harness matrix](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
lists the events each one honours.

Agents that run in none of them — your own agent, on any framework or none — report
through the [Python SDK](https://docs.befailproof.ai/reference/custom-agents)
or the [TypeScript SDK](https://docs.befailproof.ai/reference/custom-agents-typescript),
which give you tracing, sessions, evaluations and audits. Enforcement there needs a hook in
your own runtime — [talk to us](mailto:support@befailproof.ai) and we'll map it.

<!-- A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). -->
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
  </tr>
</table>

## Install

```sh
npm install -g failproofai
failproofai config                             # hooks + daemon; connect to Cloud or stay open source
failproofai policies add FailproofAI/policies  # choose what to enforce
failproofai                                    # dashboard on localhost:8020
```

Setup wires the hooks and picks **no** policies — that second command is what
puts guardrails on the machine, and any pack is typed the same way
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` reads
one first). Run `failproofai config` with no terminal — CI, a container, an
agent driving it — and it applies rather than asking. On a machine that has
never been set up, any other command runs the same wizard first; disable that
with `FAILPROOFAI_NO_FIRST_RUN=1`.

Until a pack arrives, the only thing enforcing is `block-failproofai-commands`,
which is always on and cannot be switched off or paused: an agent that can pause
enforcement can switch off every other policy.

---

## What it stops

| Policy | What it blocks |
|---|---|
| `block-env-files` | Reads of `.env` and other secret files |
| `warn-repeated-tool-calls` | The agent looping on the same call |
| `block-sudo` | Privilege escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | Unreviewed changes to live infrastructure |
| `block-rm-rf` | Recursive file deletion |
| `block-force-push` / `block-push-master` | `git push --force`, direct pushes to `main` |

Every one of these gates the call *before* it runs, so they hold on all twelve
harnesses. The first four apply to any agent that can call a tool; the last
three are the developer favourites — coding CLIs are the harness class we cover
deepest. The `sanitize-*` family is separate: it runs after a tool returns, so
it reports a secret in tool output rather than keeping it out of the context.

→ [Every policy in the Failproof AI pack](https://docs.befailproof.ai/policies/packs)

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

→ [Write a policy](https://docs.befailproof.ai/policies/editor)

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

## Failproof Cloud

**Failproof Cloud** is the hosted side of the same data model, for running agents
across a fleet. `failproofai config` connects a machine in one browser sign-in, and
the free plan covers 5,000 runs a month with no card. The dashboard follows the loop:

- **trace** — every run from every harness in one place: live events, an execution
  graph with parallel sub-agents on their own lanes, snapshots of p50/p95/p99 latency,
  cost and context windows for models, tools and hooks, error groups, user sentiment,
  and SQL over your own traces with shareable dashboards.
- **analyse** — failures cluster into **insights** on their own. **Checks** find them:
  audits that look for a pattern across sessions, and evals that score each one, judged
  by code, the decision model, an LLM judge or an agent. **Alerts** go to Slack, email or
  a signed webhook.
- **fix** — describe a policy in a sentence, test it against your past tool calls,
  observe first or enforce, and deploy it to every machine.

The **failproof agent** answers questions about all of it in plain English, and the
same data reaches your own tools through the [MCP server](https://docs.befailproof.ai/reference/mcp),
[Slack](https://docs.befailproof.ai/reference/slack) and the `fp` CLI. Self-hosting in
your own cluster is available on the Enterprise plan.

→ [Start free](https://app.befailproof.ai) ·
[Pricing](https://befailproof.ai/pricing) ·
[Quickstart](https://docs.befailproof.ai/start/quickstart) ·
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
| [Evaluations](https://docs.befailproof.ai/evaluations/overview) | Score every session with code, the decision model or an LLM judge |
| [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, no account needed |

| Enforce | |
|---|---|
| [Policy packs](https://docs.befailproof.ai/policies/packs) | The Failproof AI policies, and packs from the policy hub |
| [Write a policy](https://docs.befailproof.ai/policies/editor) | From an audit, or in code |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Config scopes, merge rules and policy parameters |

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

---

Built with ❤️ by [befailproof.ai](https://befailproof.ai) in SF and Bengaluru.
