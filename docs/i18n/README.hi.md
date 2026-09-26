> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

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
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**हर harness के लिए अवलोकन और प्रवर्तन जो आपके agents चलाते हैं।**
जहां भी आपके agents चलते हैं, हम इसे देखते हैं — और हम नहीं कह सकते। Failproof 12 agent harnesses को हुक करता है — Claude Code और Codex जैसे कोडिंग CLIs, Hermes जैसे chat gateways, OpenClaw जैसे self-hosted assistants — हर run को कैप्चर करता है और execution से पहले खतरनाक tool calls को block करता है। 39 built-in policies। शून्य latency। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित harnesses

दो वर्गों में बारह harnesses — दस कोडिंग CLIs, और दो chat और assistant gateways (Hermes, OpenClaw)। सभी के लिए एक policy API और एक session history। एक policy क्या *block* कर सकती है यह per-harness है: tool call को चलने से पहले रोकना सभी बारह पर सत्यापित है, turn-end gates आठ पर हैं। [per-harness matrix](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) प्रत्येक द्वारा honored events की सूची देता है।

जो Agents किसी में भी नहीं चलते हैं वे [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं, जो आपको tracing, sessions और audits देता है। वहां enforcement के लिए आपके स्वयं के runtime में एक hook की आवश्यकता होती है — [हमसे बात करें](mailto:support@befailproof.ai) और हम इसे map करेंगे।

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

## स्थापित करें

```sh
npm install -g failproofai
failproofai config                             # अपने agents और daemon को wire करें
failproofai policies add FailproofAI/policies  # प्रवर्तन करने के लिए क्या चुनें
failproofai                                    # localhost:8020 पर dashboard
```

Setup hooks को wire करता है और **कोई नहीं** policies चुनता है — वह दूसरी कमांड है जो मशीन पर guardrails रखती है, और कोई भी pack एक ही तरह से typed है (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` पहले एक को पढ़ता है)। बिना terminal के `failproofai config` चलाएं — CI, container, agent इसे चलाते हुए — और यह पूछने के बजाय लागू करता है। एक मशीन पर जो कभी setup नहीं हुई है, कोई भी अन्य कमांड पहले एक ही wizard चलाती है; इसे `FAILPROOFAI_NO_FIRST_RUN=1` से disable करें।

जब तक pack नहीं आता, एकमात्र चीज़ जो प्रवर्तन करती है वह `block-failproofai-commands` है, जो हमेशा चालू रहती है और switch off या paused नहीं हो सकती: एक agent जो enforcement को pause कर सकता है अन्य सभी policies को switch off कर सकता है।

---

## यह क्या रोकता है

| Policy | यह क्या blocks करता है |
|---|---|
| `block-env-files` | `.env` और अन्य secret files की reads |
| `warn-repeated-tool-calls` | Agent एक ही call पर looping कर रहा है |
| `block-sudo` | Privilege escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | Unreviewed changes to live infrastructure |
| `block-rm-rf` | Recursive file deletion |
| `block-force-push` / `block-push-master` | `git push --force`, direct pushes to `main` |

इनमें से हर एक call को चलने से *पहले* gate करता है, इसलिए वे सभी बारह harnesses पर काम करते हैं। पहले चार किसी भी agent पर लागू होते हैं जो tool call कर सकता है; अंतिम तीन developer पसंद हैं — कोडिंग CLIs harness class हैं जिन्हें हम सबसे गहराई से कवर करते हैं। `sanitize-*` family अलग है: यह tool return के बाद चलता है, इसलिए यह context में secret को रखने के बजाय tool output में रिपोर्ट करता है।

→ [सभी 39 built-in policies](https://docs.befailproof.ai/policies/packs)

---

## आपकी स्वयं की policies

`.failproofai/policies/` में एक फाइल छोड़ें — यह स्वचालित रूप से लोड होता है, कोई flags की आवश्यकता नहीं।
इसे commit करें और पूरी team को अगली pull पर यह मिल जाएगा।

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

हर policy के लिए उपलब्ध तीन निर्णय:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | Operation की अनुमति दें |
| `deny(message)` | इसे block करें — message agent को वापस जाता है |
| `instruct(message)` | इसे through होने दें, लेकिन agent के अगले prompt में context जोड़ें |

→ [एक policy लिखें](https://docs.befailproof.ai/policies/editor)

---

## अवलोकन

Enforcement एक आधा है। दूसरा आधा यह देखना है कि agent ने वास्तव में क्या किया।

`failproofai` को कोई arguments के साथ चलाएं और यह `localhost:8020` पर एक dashboard serve करता है जो आपकी मशीन पर पहले से मौजूद run history को पढ़ता है — कोई account नहीं, कोई signup नहीं, कुछ भी box से बाहर नहीं जाता। आप session list, हर run के अंदर model calls, tool calls और hook decisions का sequence, क्या block हुआ और policy ने agent को क्या बताया, और एक offline audit (`failproofai audit`) प्राप्त करते हैं जो आपके history को risky patterns के लिए scan करता है और policies suggest करता है उन्हें रोकने के लिए।

→ [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक trace पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Local audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** उसी data model का hosted side है, teams के लिए जो fleet में agents चलाते हैं: हर harness से हर run एक जगह पर, एक execution graph जिसमें parallel sub-agents अपनी lanes पर हैं, models, tools और hooks के लिए p50/p95/p99 latency, per-model cost और context-window tracking, error tracking, आपके स्वयं के traces पर SQL के साथ shareable dashboards, आपकी स्वयं की service द्वारा scored evaluations, और scheduled audits जो recurring failures को evidence-backed findings में बदलते हैं, और alerts Slack, email या एक signed webhook को route करते हैं। Enterprise plan पर आपके स्वयं के cluster में self-hosting उपलब्ध है।

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[एक demo बुक करें](https://befailproof.ai/get-a-demo)

---

## Documentation

| शुरुआत करें | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Install करें, एक harness connect करें, पहला run देखें |
| [Concepts](https://docs.befailproof.ai/start/concepts) | Hook system कैसे काम करता है |
| [समर्थित harnesses](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और हर एक क्या enforce कर सकता है |

| देखभाल करें | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | एक run को follow करें: models, tools, errors, latency |
| [एक trace पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | Execution graph आपको क्या बता रहा है |
| [Audits](https://docs.befailproof.ai/audits/overview) | कई sessions में failure patterns खोजें |
| [Local dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई account की आवश्यकता नहीं |

| प्रवर्तन करें | |
|---|---|
| [Policy packs](https://docs.befailproof.ai/policies/packs) | Failproof AI policies, और policy hub से packs |
| [एक policy लिखें](https://docs.befailproof.ai/policies/editor) | एक audit से, या code में |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Config scopes, merge rules और policy parameters |

| अपने स्वयं के agent को instrument करें | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | किसी भी harness के बिना एक agent से runs रिपोर्ट करें |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## License

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए मुक्त; failproofai का स्वयं का commercial resale एक अलग समझौते की आवश्यकता है। पूर्ण text के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई policies, edge cases, और अनुवाद सभी स्वागत हैं।

> **शुरू करने से पहले build करें।** पहले `bun install && bun run build` चलाएं। यह repo failproofai के स्वयं के hooks को स्वयं पर चलाता है, और वे compiled `dist/` bundle के विरुद्ध `failproofai` import को resolve करते हैं — build के बिना आप `Cannot find package 'failproofai'` hook errors को hit करेंगे। `src/` बदलने के बाद rebuild करें। देखें [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)।

---

❤️ के साथ [befailproof.ai](https://befailproof.ai) द्वारा SF और Bengaluru में निर्मित।
