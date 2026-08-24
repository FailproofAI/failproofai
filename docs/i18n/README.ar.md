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

**قابلية الملاحظة والفرض لكل بيئة تقنية يعمل فيها وكيلك الذكي.** أينما يعمل وكيلك
الذكي، نحن نراه — ويمكننا الرفض. يتصل failproofai بـ 12 بيئة تقنية — واجهات سطر
أوامر البرمجة مثل Claude Code و Codex، بوابات الدردشة مثل Hermes، المساعدات ذاتية
الاستضافة مثل OpenClaw — لالتقاط كل عملية وحجب استدعاءات الأدوات الخطيرة قبل تنفيذها.
40 سياسة مدمجة. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## البيئات التقنية المدعومة

اثنتا عشرة بيئة تقنية في فئتين — عشر واجهات سطر أوامر برمجة، وبوابتا دردشة ومساعد
(Hermes، OpenClaw). نفس الأحداث، نفس السياسات، نفس سجل الجلسة، أيًا كانت البيئة التي
يعمل فيها وكيلك الذكي.

الوكلاء الذين لا يعملون في أي منها يقدمون التقارير من خلال [Python SDK](https://docs.befailproof.ai/reference/custom-agents)،
والذي يوفر لك التتبع والجلسات والتدقيق. يحتاج الفرض هناك إلى خطاف في وقت التشغيل الخاص بك
— [تحدث معنا](mailto:support@befailproof.ai) وسنقوم بتعيينه.

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
failproofai policies --install   # أو قم بتشغيل `failproofai` فقط واقبل رسالة التشغيل الأول
failproofai
```

40 سياسة مدمجة تتفعل فورًا. لوحة التحكم في `localhost:8020`. عطّل رسالة التشغيل الأول باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما يمنعه

| السياسة | ما يحجبه |
|---|---|
| `sanitize-api-keys` | تسرب مفاتيح API إلى سياق الوكيل |
| `block-env-files` | قراءة ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | حلقة الوكيل على نفس الاستدعاء |
| `block-sudo` | تصعيد الامتيازات |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` غير المحدود |
| `block-terraform` / `block-kubectl` | التغييرات غير المراجعة للبنية الأساسية الحية |
| `block-rm-rf` | حذف الملفات بشكل متكرر |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

تنطبق أول خمسة على أي وكيل يمكنه استدعاء أداة. الثلاثة الأخيرة هي المفضلة لدى المطورين —
واجهات سطر أوامر البرمجة هي الفئة من البيئات التقنية التي نغطيها بعمق أكثر.

→ [جميع السياسات المدمجة البالغ عددها 40](https://docs.befailproof.ai/policies/builtin)

---

## سياساتك الخاصة

ضع ملفًا في `.failproofai/policies/` — يتم تحميله تلقائيًا، لا توجد حاجة لعلامات.
قم بارتكابه وستحصل الفريق بأكمله عليه في الجلب التالي.

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

هناك ثلاثة قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حجبها — يعود الرسالة إلى الوكيل |
| `instruct(message)` | السماح بها، لكن أضف سياقًا إلى المحفز التالي للوكيل |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/policies/custom)

---

## قابلية الملاحظة

الفرض نصف واحد. النصف الآخر هو رؤية ما فعله الوكيل فعلاً.

قم بتشغيل `failproofai` بدون مُعاملات وسيخدم لوحة تحكم على `localhost:8020`
تقرأ سجل التشغيل الموجود بالفعل على جهازك — لا حساب، لا تسجيل، لا شيء يترك الصندوق.
تحصل على قائمة الجلسة، وتسلسل استدعاءات النموذج، واستدعاءات الأدوات وقرارات الخطاف داخل كل تشغيل،
وما تم حجبه وما قالته السياسة للوكيل، وتدقيق غير متصل (`failproofai audit`) الذي يمسح سجلك
بحثًا عن أنماط محفوفة بالمخاطر ويقترح السياسات لإيقافها.

→ [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[اقرأ تتبعًا](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** هو الجانب المستضاف من نفس نموذج البيانات، للفرق التي
تدير الوكلاء عبر أسطول: كل تشغيل من كل بيئة تقنية في مكان واحد، رسم بياني للتنفيذ مع
وكلاء فرعيين متوازيين على ممراتهم الخاصة، كمون p50/p95/p99 للنماذج والأدوات والخطافات،
التكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL فوق آثارك مع لوحات تحكم قابلة
للمشاركة، التقييمات التي تسجلها خدمتك الخاصة، المراجعات المجدولة التي تحول الأعطال المتكررة
إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقّع.
الاستضافة الذاتية في مجموعتك الخاصة متاحة في خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيقات](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضًا توضيحيًا](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | التثبيت، والاتصال بالبيئة التقنية، وشاهد التشغيل الأول |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |
| [البيئات التقنية المدعومة](https://docs.befailproof.ai/reference/harnesses) | الكل 12، وما يمكن لكل منها فرضه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | تابع التشغيل: النماذج والأدوات والأخطاء والكمون |
| [اقرأ تتبعًا](https://docs.befailproof.ai/sessions/read-a-trace) | ما يخبرك به الرسم البياني للتنفيذ |
| [التدقيقات](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر جلسات كثيرة |
| [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا حاجة للحساب |

| فرض | |
|---|---|
| [السياسات المدمجة](https://docs.befailproof.ai/policies/builtin) | جميع السياسات الـ 40 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/policies/custom) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج |

| أداة وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | الإبلاغ عن التشغيلات من وكيل بدون بيئة تقنية |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛
يتطلب إعادة بيع تجارية لـ failproofai نفسه اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها مرحب بها.

> **ابنِ قبل أن تبدأ.** قم بتشغيل `bun install && bun run build` أولاً. يعمل هذا المستودع
> خطافات failproofai الخاصة به على نفسه، وهي تحل استيراد `failproofai` مقابل حزمة `dist/`
> المترجمة — بدون بناء ستواجه أخطاء خطاف `Cannot find package 'failproofai'`. أعد البناء
> بعد تغيير `src/`. انظر
> [ابنِ قبل أن تعمل خطافات dev داخل المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

تم البناء بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في SF وBengaluru.


</div>