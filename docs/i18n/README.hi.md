> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**हर harness के लिए निरीक्षण और प्रवर्तन जहाँ आपके agents चलते हैं।**
जहाँ भी आपके agents चलते हैं, हम देख सकते हैं — और हम मना कर सकते हैं। Failproof 12 agent
harnesses को hook करता है — Claude Code और Codex जैसे coding CLIs, Hermes जैसे chat
gateways, OpenClaw जैसे self-hosted assistants — हर run को capture करता है और
खतरनाक tool calls को execute होने से पहले रोकता है। 40 built-in policies। Zero latency। Locally चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित harnesses

दो classes में बारह harnesses — दस coding CLIs, और दो chat और assistant
gateways (Hermes, OpenClaw)। एक जैसी events, एक जैसी policies, एक जैसी session history,
चाहे आपका agent उनमें से कोई भी हो।

Agents जो इनमें से किसी में भी नहीं चलते वे [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के
माध्यम से report करते हैं, जो आपको tracing, sessions और audits देता है। वहाँ प्रवर्तन के लिए आपके
own runtime में एक hook की जरूरत है — [हमसे बात करें](mailto:support@befailproof.ai) और हम इसे map कर देंगे।

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openai-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/copilot-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/cursor-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/opencode-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/pi-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/hermes-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/factory-dark.png" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/goose-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

## स्थापना

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएँ और पहली बार के प्रॉम्प्ट को स्वीकार करें
failproofai
```

40 built-in policies तुरंत सक्रिय हो जाती हैं। Dashboard `localhost:8020` पर है। पहली बार के प्रॉम्प्ट को `FAILPROOFAI_NO_FIRST_RUN=1` से अक्षम करें।

---

## यह क्या रोकता है

| Policy | क्या यह ब्लॉक करता है |
|---|---|
| `sanitize-api-keys` | API keys का agent के context में leak होना |
| `block-env-files` | `.env` और अन्य secret files का read होना |
| `warn-repeated-tool-calls` | Agent का एक ही call पर loop करना |
| `block-sudo` | Privilege escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | Live infrastructure में unreviewed changes |
| `block-rm-rf` | Recursive file deletion |
| `block-force-push` / `block-push-master` | `git push --force`, `main` को direct pushes |

पहली पाँच किसी भी agent पर लागू होती हैं जो एक tool को call कर सकता है। अंतिम तीन
developer पसंदीदा हैं — coding CLIs वह harness class हैं जिसे हम सबसे गहराई से cover करते हैं।

→ [सभी 40 built-in policies](https://docs.befailproof.ai/policies/builtin)

---

## आपकी अपनी policies

`.failproofai/policies/` में एक फाइल डालें — यह automatically load हो जाती है, कोई flags की जरूरत नहीं।
इसे commit करें और पूरी team को अगले pull पर यह मिल जाएगी।

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

हर policy के लिए तीन निर्णय उपलब्ध हैं:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | Operation को permit करें |
| `deny(message)` | इसे ब्लॉक करें — message agent को वापस जाता है |
| `instruct(message)` | इसे through होने दें, लेकिन agent के अगले prompt में context जोड़ें |

→ [Custom policies guide](https://docs.befailproof.ai/policies/custom)

---

## निरीक्षण

प्रवर्तन एक आधा है। दूसरा आधा यह देखना है कि agent ने वास्तव में क्या किया।

बिना किसी argument के `failproofai` चलाएँ और यह `localhost:8020` पर एक dashboard serve करता है
जो आपकी machine पर पहले से मौजूद run history को read करता है — कोई account नहीं, कोई signup नहीं, कुछ भी
बाहर नहीं जाता। आपको session list, हर run के अंदर model calls, tool calls और hook decisions का sequence,
क्या block किया गया और policy ने agent को क्या बताया, और एक offline audit (`failproofai audit`) जो
आपके history को risky patterns के लिए scan करता है और policies सुझाता है उन्हें रोकने के लिए।

→ [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक trace पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Local audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** एक team के लिए hosted side है जो एक fleet में agents चला रहे हैं:
हर harness से हर run एक ही जगह, parallel sub-agents के अपने lanes के साथ एक execution graph,
models, tools और hooks के लिए p50/p95/p99 latency, per-model cost और context-window tracking, error
tracking, आपके own traces पर SQL shareable dashboards के साथ, आपकी own service द्वारा scored
evaluations, scheduled audits जो recurring failures को evidence-backed findings में turn करते हैं,
और alerts जो Slack, email या एक signed webhook को route करते हैं। आपके own cluster में self-hosting
Enterprise plan पर उपलब्ध है।

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[एक demo बुक करें](https://befailproof.ai/get-a-demo)

---

## Documentation

| शुरुआत करें | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Install करें, एक harness को connect करें, पहला run देखें |
| [Concepts](https://docs.befailproof.ai/start/concepts) | Hook system कैसे काम करता है |
| [समर्थित harnesses](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और हर एक क्या enforce कर सकता है |

| निरीक्षण करें | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | एक run को follow करें: models, tools, errors, latency |
| [एक trace पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | Execution graph आपको क्या बता रहा है |
| [Audits](https://docs.befailproof.ai/audits/overview) | कई sessions में failure patterns खोजें |
| [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई account की जरूरत नहीं |

| प्रवर्तन करें | |
|---|---|
| [Built-in policies](https://docs.befailproof.ai/policies/builtin) | सभी 40 policies parameters के साथ |
| [Custom policies](https://docs.befailproof.ai/policies/custom) | अपनी खुद की policies लिखें |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Config scopes और merge rules |

| अपने agent को instrument करें | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | कोई harness वाले agent से runs report करें |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — internal और personal use के लिए free; failproofai
के commercial resale के लिए एक separate agreement की जरूरत है। पूरे text के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई policies, edge cases, और translations सभी स्वागत हैं।

> **शुरू करने से पहले build करें।** पहले `bun install && bun run build` चलाएँ। यह repo failproofai की अपनी
> hooks को अपने पर चलाता है, और वे `failproofai` import को compiled `dist/` bundle के विरुद्ध resolve करते हैं —
> build के बिना आपको `Cannot find package 'failproofai'` hook errors का सामना करना पड़ेगा। `src/` को
> बदलने के बाद rebuild करें। [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

SF और Bengaluru में [befailproof.ai](https://befailproof.ai) द्वारा ❤️ के साथ built।
