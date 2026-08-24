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

**الترجمات:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**المراقبة والفرض لكل محاولة يشغلها وكلاؤك.**
أينما يعمل وكلاؤك، نحن نراهم — ويمكننا أن نرفضهم. يتصل failproofai بـ 12 محاولة وكيل — واجهات برمجة الترميز مثل Claude Code و Codex، بوابات الدردشة مثل Hermes، المساعدين المستضافين ذاتيًا مثل OpenClaw — ويلتقط كل عملية ويحجب استدعاءات الأدوات الخطرة قبل تنفيذها. 40 سياسة مدمجة. بدون كمون. يعمل محليًا.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## المحاولات المدعومة

اثنا عشر محاولة في فئتين — عشرة واجهات برمجة ترميز، وبوابتين للدردشة والمساعدين (Hermes و OpenClaw). نفس الأحداث، نفس السياسات، نفس سجل الجلسة، أيًا كانت المحاولة التي يعمل فيها وكيلك.

الوكلاء الذين لا يعملون في أي منها يبلغون من خلال [Python SDK](https://docs.befailproof.ai/reference/python-sdk)، والذي يوفر لك التتبع والجلسات والتدقيق. يتطلب الفرض هناك دخل في وقتك — [تحدث إلينا](mailto:support@befailproof.ai) وسنقوم بتعيينه.

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
failproofai policies --install   # أو ما عليك سوى تشغيل `failproofai` وقبول موجه التشغيل الأول
failproofai
```

تنشط 40 سياسة مدمجة فورًا. لوحة معلومات في `localhost:8020`. عطّل موجه التشغيل الأول باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما يوقفه

| السياسة | ما يحجبه |
|---|---|
| `sanitize-api-keys` | مفاتيح API التي تتسرب إلى سياق الوكيل |
| `block-env-files` | قراءة ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل الذي يحلق في نفس الاستدعاء |
| `block-sudo` | تصعيد الامتيازات |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` غير محدود |
| `block-terraform` / `block-kubectl` | تغييرات غير مراجعة للبنية التحتية المباشرة |
| `block-rm-rf` | حذف الملفات العودي |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

ينطبق الخمسة الأولى على أي وكيل يمكنه استدعاء أداة. الثلاثة الأخيرة هي المفضلة لدى المطورين — واجهات برمجة الترميز هي فئة المحاولة التي نغطيها بعمق.

→ [جميع السياسات المدمجة 40](https://docs.befailproof.ai/policies/builtin)

---

## سياساتك الخاصة

أفلت ملف إلى `.failproofai/policies/` — يتم تحميله تلقائيًا، بدون حاجة لأعلام.
تأكد منه والفريق بأكمله يحصل عليه في السحب التالي.

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

ثلاثة قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حجبها — تعود الرسالة إلى الوكيل |
| `instruct(message)` | دعها تمر، لكن أضف سياقًا إلى موجه الوكيل التالي |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/policies/custom)

---

## المراقبة

الفرض نصف واحد. النصف الآخر هو رؤية ما فعله الوكيل بالفعل.

قم بتشغيل `failproofai` بدون حجج وسيعمل لوحة معلومات على `localhost:8020` قراءة سجل التشغيل الموجود بالفعل على جهازك — بدون حساب، بدون تسجيل، لا شيء يغادر الصندوق. تحصل على قائمة الجلسة، والتسلسل من استدعاءات النموذج، واستدعاءات الأدوات وقرارات الخطاف داخل كل عملية، ما تم حجبه وما قالته السياسة للوكيل، وتدقيق غير متصل (`failproofai audit`) الذي يفحص سجلك عن الأنماط الخطرة ويقترح السياسات لإيقافها.

→ [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** هي الجانب المستضاف لنفس نموذج البيانات، للفرق التي تدير الوكلاء عبر أسطول: كل عملية من كل محاولة في مكان واحد، رسم بياني للتنفيذ مع وكلاء فرعيين متوازيين على مساراتهم الخاصة، مدة الكمون p50/p95/p99 للنماذج والأدوات والخطافات، التكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL على تتبعاتك الخاصة مع لوحات معلومات قابلة للمشاركة، التقييمات المسجلة بواسطة خدمتك الخاصة، التدقيقات المجدولة التي تحول الفشل المتكرر إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقع. يتوفر الاستضافة الذاتية في مجموعتك الخاصة في خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيقات](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضًا توضيحيًا](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | التثبيت، واتصل بمحاولة، واعرض التشغيل الأول |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |
| [المحاولات المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع الـ 12، وما يمكن لكل منها فرضه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | اتبع التشغيل: النماذج، الأدوات، الأخطاء، الكمون |
| [قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) | ما يخبرك به الرسم البياني للتنفيذ |
| [التدقيقات](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر العديد من الجلسات |
| [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، بدون حاجة لحساب |

| فرض | |
|---|---|
| [السياسات المدمجة](https://docs.befailproof.ai/policies/builtin) | جميع السياسات 40 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/policies/custom) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج |

| أداتك الخاصة بوكيل | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/python-sdk) | التقرير يعمل من وكيل بدون محاولة |
| [سياسة SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` مرجع |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ يتطلب إعادة البيع التجاري لـ failproofai نفسه اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات موضع الترحيب.

> **ابن قبل أن تبدأ.** قم بتشغيل `bun install && bun run build` أولاً. يشغل هذا المستودع خطافات failproofai الخاصة به على نفسه، وهم يحلون استيراد `failproofai` مقابل حزمة `dist/` المترجمة — بدون بناء ستضرب `Cannot find package 'failproofai'` أخطاء الخطاف. أعد البناء بعد تغيير `src/`. انظر
> [البناء قبل أن تعمل خطافات المطورين داخل المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

مبني بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>