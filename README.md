<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/failproof-dark.png" />
  <img src="assets/logos/failproof-light.png" alt="failproof ai" width="320" />
</picture>

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

## Ship agents that never fail.

Your agent ran `rm -rf` on the wrong directory. It read `.env` into its context. It spent
forty minutes retrying the same broken call, then told you the task was done.
**Failproof lives in your agent's runtime and hears every hook event it fires**: the
session starting, every prompt, every tool call and its result, sub-agents spinning up,
context about to be compacted, the moment it tries to stop. **It can act on any of
them**: block the bad action before it executes, steer the agent mid-run, or send it
back to work when it quits too early. Then it learns from every failure, so your
agent's harness gets better with every run.

**37% → 69%** task success on failures a policy recognised. Same model, no fine-tuning
([FIRE study](https://befailproof.ai/research/runtime-policies/))<br />
**~0.7 ms** p50 per policy check, from a Rust daemon in the hot path<br />
**12 agent harnesses**, one policy API: Claude Code, Codex, Cursor, Hermes, OpenClaw and more

Open source and free to start. Install the CLI, connect Failproof Cloud, and your first
audit runs on your agents' real history.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Supported harnesses

Twelve harnesses in two classes: ten coding CLIs, and two chat and assistant
gateways (Hermes, OpenClaw).

Building your own agent, on any framework or none? Report its runs through the
[Python SDK](https://docs.befailproof.ai/reference/custom-agents) or the
[TypeScript SDK](https://docs.befailproof.ai/reference/custom-agents-typescript),
which give you tracing, sessions, evaluations and audits. Enforcement there needs a hook in
your own runtime. [Talk to us](mailto:support@befailproof.ai) and we'll map it.

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

---

## Get started: find where your agents fail, then stop it

```sh
npm install -g failproofai
failproofai config                # hook your agents, connect to Failproof Cloud (free)
failproofai backfill --since 7d   # bring in the last week of runs already on disk
```

1. **Connect.** `failproofai config` finds every agent on this machine, hooks into each
   one, starts the background daemon, and signs you in to Failproof Cloud in your
   browser. No account yet? Make one right there, on the free plan.
2. **Backfill.** Your agents have been running for weeks, and that history is already on
   this machine. `failproofai backfill --since 7d` sends the last seven days, so you start
   with real evidence instead of an empty dashboard.
3. **Audit.** The moment runs land, Cloud starts your first audit on its own. It reads
   your sessions, clusters what went wrong into named failure modes, and turns each one
   into an **insight**, with the sessions that prove it. The free plan includes audits
   every month.
4. **Plug in policies built for your agents.** Open an insight and hit **prevent this →**.
   Failproof drafts a policy for that exact failure and tests it against your agents' own
   past tool calls. You then roll it out to every machine, watching first or enforcing
   straight away.

Setting up CI, a container, or letting an agent run the install? `failproofai config`
notices there's no one to ask and applies the defaults without prompting.

---

## One policy, every harness

Every harness speaks its own dialect:
- Claude Code reads a JSON verdict, while Factory's droid only stops on exit code 2.
- Cursor forces another turn with a `followup_message`.
- OpenCode and OpenClaw have no shell hooks at all, only in-process plugins, and Hermes
  loads a native Python plugin.
- Even the shell tool has six names: `Bash`, `terminal`, `Execute`, `shell`,
  `run_command`, `exec`.

Failproof translates all of it:
- Every event maps onto one canonical set of 29 (`SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `SubagentStop`, `PreCompact`, `Stop`, …).
- Every tool name and argument maps onto one canonical form.
- Every verdict is translated back into the exact shape that harness obeys.

So a policy written once against `Bash` blocks the same command in Claude Code, Codex,
Hermes and Goose. A "run the tests before you stop" gate sends the agent back to work on
every harness that has a turn-end hook.

Each contract is probed live against the shipping version of that CLI. It's pinned, with
the version it was verified on, in a capability matrix the test suite checks every claim
against. Blocking before a tool runs is verified on all twelve harnesses; turn-end gates
on eight. The [per-harness matrix](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
shows exactly which events each one honours.

---

## Policies, written for your agents

A policy can listen to any of those events. Before a tool call, it can block the command
outright. When a prompt arrives, it can add context. When the agent tries to stop, it
can send it back to finish the job. Whatever it decides, the agent is told why. There
are two kinds of policy, and you can mix them:

- **Code.** Plain JavaScript, for anything you can check exactly: paths, commands,
  arguments, limits. It's just code, so it can call your own model too.
- **Decision model.** Plain-English yes/no questions that Jev, our fast classifier,
  answers about each call against what the user actually asked for. The `rm -rf build/`
  you asked for goes through; the `rm -rf ~` that slipped into a plan doesn't. Use it
  for the judgment calls no regex can make.

**You don't have to write either.** Failproof authors them for you. Open an insight in
Cloud and hit **prevent this →**, or describe the rule in a sentence. Failproof drafts
the policy, tests it against your agents' own past tool calls, and rolls it out to every
machine, observing first or enforcing straight away.

A few examples of what a policy can catch, and what it does about it:

| Example | What it catches | Does |
|---|---|---|
| `block-env-files` | Reads of `.env` and other secret files | **Blocks** |
| `block-kubectl` | Unreviewed changes to live infrastructure | **Blocks** |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, an unbounded `DELETE` | **Warns** the agent and lets it decide |
| `warn-repeated-tool-calls` | The agent looping on the same failing call | **Warns** the agent to change approach |
| `no-refunds-over-limit` *(yours)* | A support agent approving a refund it isn't allowed to | Whatever you decide |
| `no-production-writes` *(yours)* | Writes to production paths (the code below) | **Blocks** |

Prefer to write one yourself? Save it in `.failproofai/policies/` under a name ending in
`policies.js`, `policies.mjs` or `policies.ts` (say, `no-production-writes-policies.mjs`)
and it loads automatically. A file named anything else is skipped. Commit it and the
whole team is protected on the next pull.

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

Every policy returns one of three decisions: `allow()`, `deny(message)`, or
`instruct(message)`. The last is the quiet superpower. Instead of crashing the agent
into a wall, it steers it ("run the tests before you stop", "use the staging database")
and the agent corrects course on its own.

→ [Write a policy](https://docs.befailproof.ai/policies/editor) ·
[Decision-model policies](https://docs.befailproof.ai/policies/jev) ·
[More examples](https://docs.befailproof.ai/policies/packs)

---

## Built for agents that run on their own

A check that costs nothing can run on every event, all the time. That's what lets you
hand an agent more autonomy, not less:

- **Sub-millisecond, on every event.** `failproofaid` is a Rust daemon with a pre-warmed
  policy worker behind an owner-only Unix socket. A check that used to cost ~700 ms now
  takes ~0.7 ms at p50, so policies can watch every event of every session and the agent
  never feels it. [How we got there →](https://befailproof.ai/blog/sub-millisecond-agent-enforcement/)
- **Always on, even when you're not.** It runs as a system service from boot, with no
  login needed. Overnight jobs, cron runs and detached sessions get the same protection
  as the one in your terminal.
- **No agent can switch it off.** The guard that protects Failproof is always on and
  can't be paused, so the rules you set are the rules your agent runs under.
- **One daemon, always in sync.** The same process ships every run to Cloud and keeps
  your policies current, so a policy you approve reaches every machine without a
  redeploy.

---

## Failproof Cloud: a harness that improves itself

Generic guardrails are written for everyone's agent. Failproof Cloud is built for
**yours**, from **your agent's own traces**, whether you run one agent or a hundred.

Every run feeds a loop that makes the harness around your agent better:

1. **Trace.** Every prompt, model call, tool call and result, live and replayable, with
   parallel sub-agents on their own lanes, latency, cost and context windows, and SQL
   over all of it.
2. **Audit.** Audits read your sessions on a schedule and cluster what went wrong into
   named failure modes: the loops, wrong tools and quiet give-ups that are specific to
   your agent. Each one becomes an **insight**, backed by the sessions that prove it.
3. **Check.** Turn an insight into an eval and every new session is scored for it, by
   code, the decision model, an LLM judge or an agent. When the failure comes back,
   alerts reach you on Slack, email or a signed webhook.
4. **Fix.** Hit **prevent this →** and Failproof writes the policy for that exact
   failure. It tests the policy against your agent's past tool calls, then rolls it out,
   observing first or enforcing right away.
5. **Repeat.** The next audit runs on traces where that failure can't happen any more,
   and finds the next one.

The model never changes. The harness around it learns from every failure. It's the idea
behind our [FIRE study](https://befailproof.ai/research/runtime-policies/), where
policies derived from an agent's failures took task success from **37% to 69%** on the
failures they recognised. Same model, no fine-tuning.

> "The audits are the part that changed how we operate. We now have fewer incidents,
> less compute waste, and faster shipping."
> — Pratheep Velicherla, CTO, Testsigma

Ask the **failproof agent** anything about your agent in plain English, or pull the same
data into your own tools through the [MCP server](https://docs.befailproof.ai/reference/mcp),
[Slack](https://docs.befailproof.ai/reference/slack) and the `fp` CLI.

Start with one agent on the free plan: 5,000 runs a month, no card. Self-hosting in your
own cluster is available on the Enterprise plan.

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

| Enforce | |
|---|---|
| [Write a policy](https://docs.befailproof.ai/policies/editor) | From an insight, from a sentence, or in code |
| [Decision-model policies](https://docs.befailproof.ai/policies/jev) | Jev judges calls against what the user asked |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Config scopes, merge rules and policy parameters |

| Instrument your own agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Report runs from an agent with no harness |
| [TypeScript SDK](https://docs.befailproof.ai/reference/custom-agents-typescript) | The same events from a Node agent |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## License

MIT with [Commons Clause](https://commonsclause.com/) — free for internal and personal use; commercial resale of failproofai itself requires a separate agreement. See [LICENSE](./LICENSE) for the full text.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). New policies, edge cases, and translations all welcome.

---

Built with ❤️ by [befailproof.ai](https://befailproof.ai) in SF and Bengaluru.
