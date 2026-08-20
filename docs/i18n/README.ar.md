> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | **🇸🇦 العربية** | [🇮🇱 עברית](README.he.md)

---
<div dir="rtl">


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

**الترجمات:** [简体中文](../../docs-old/i18n/README.zh.md) · [日本語](../../docs-old/i18n/README.ja.md) · [한국어](../../docs-old/i18n/README.ko.md) · [Español](../../docs-old/i18n/README.es.md) · [Português](../../docs-old/i18n/README.pt-br.md) · [Deutsch](../../docs-old/i18n/README.de.md) · [Français](../../docs-old/i18n/README.fr.md) · [Руссий](../../docs-old/i18n/README.ru.md) · [हिन्दी](../../docs-old/i18n/README.hi.md) · [Türkçe](../../docs-old/i18n/README.tr.md) · [Tiếng Việt](../../docs-old/i18n/README.vi.md) · [Italiano](../../docs-old/i18n/README.it.md) · [العربية](../../docs-old/i18n/README.ar.md) · [עברית](../../docs-old/i18n/README.he.md)

**حل فشل التشغيل للوكلاء الكوديين.**
يتصل بـ Claude Code و Codex. يمسك الحلقات والإجراءات الخطيرة وتسريب الأسرار
قبل أن تصبح حوادث. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## واجهات سطر الأوامر المدعومة للوكلاء

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

## التثبيت

```sh
npm install -g failproofai
failproofai policies --install   # أو فقط قم بتشغيل `failproofai` وقبول موجه التشغيل الأول
failproofai
```

30 سياسة مدمجة تتفعل على الفور. لوحة المعلومات في `localhost:8020`. عطّل موجه التشغيل الأول بـ `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما الذي يتم إيقافه

| السياسة | ما يتم حجبه |
|---|---|
| `block-push-master` | الدفع المباشر إلى `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | الالتزامات والدمج والإعادة الأساسية على `main` / `master` |
| `block-rm-rf` | حذف الملفات التكراري |
| `sanitize-api-keys` | مفاتيح واجهة برمجية التطبيقات تتسرب إلى سياق الوكيل |

→ [جميع 30 السياسات المدمجة](https://docs.befailproof.ai/policies/builtin)

---

## سياساتك الخاصة

أفلت ملف في `.failproofai/policies/` — يتم تحميله تلقائيًا، بدون الحاجة إلى أي أعلام.
قم بالالتزام به وستحصل الفريق بأكمله عليه في السحب التالي.

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

ثلاث قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حجبها — تعود الرسالة إلى الوكيل |
| `instruct(message)` | السماح بها، لكن إضافة سياق إلى موجه الوكيل التالي |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/policies/custom)

---

## رؤية الجلسة

كل استدعاء أداة يقوم به وكيلك يتم تسجيله محليًا. تعرض لوحة المعلومات ما تم تشغيله،
ما تم حجبه، وما قالته السياسة للوكيل — حتى لا تكون تخمينًا
عندما يحدث خطأ ما. → [دليل لوحة المعلومات](https://docs.befailproof.ai/sessions/overview)

---

## التوثيق

| | |
|---|---|
| [البدء](https://docs.befailproof.ai/start/quickstart) | التثبيت والخطوات الأولى |
| [السياسات المدمجة](https://docs.befailproof.ai/policies/builtin) | جميع 30 سياسة مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/policies/custom) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج |
| [لوحة المعلومات](https://docs.befailproof.ai/sessions/overview) | مراقب الجلسة ونشاط السياسة |
| [العمارة](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة البيع التجاري لـ failproofai نفسه يتطلب اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة وحالات الحافة والترجمات كلها مرحب بها.

> **قم بالبناء قبل أن تبدأ.** قم بتشغيل `bun install && bun run build` أولاً. يعمل هذا المستودع
> على خطافات failproofai الخاصة به، وهي تحل استيراد `failproofai` مقابل
> حزمة `dist/` المترجمة — بدون بناء ستواجه أخطاء خطاف `Cannot find package 'failproofai'`
> . أعد البناء بعد تغيير `src/`. انظر
> [البناء قبل أن تعمل خطافات dev داخل المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

بُنيت بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في سان فرانسيسكو وبنغالور.


</div>