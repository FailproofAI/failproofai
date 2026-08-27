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

**قابلية الملاحظة والإنفاذ لكل محرك يشغّل وكلاءك.**
حيثما يعمل وكلاؤك، نحن نراهم — ويمكننا الاعتراض. يدعم failproofai 12 محرك وكيل
— واجهات سطر أوامر الترميز مثل Claude Code و Codex، وبوابات الدردشة مثل Hermes،
والمساعدات ذاتية الاستضافة مثل OpenClaw — حيث يعكس كل عملية تشغيل ويحجب استدعاءات الأدوات الخطرة
قبل تنفيذها. 39 سياسة مدمجة. لا توجد تأخيرات زمنية. يعمل محلياً.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

---

## المحركات المدعومة

اثنا عشر محركاً في فئتين — عشر واجهات سطر أوامر للترميز، وبوابتان للدردشة والمساعدات
(Hermes، OpenClaw). نفس الأحداث، نفس السياسات، نفس سجل الجلسات،
أياً كان المحرك الذي يعمل فيه وكيلك.

تقدم الوكلاء الذين لا يعملون في أي منهم تقاريرهم عبر [Python SDK](https://docs.befailproof.ai/reference/custom-agents)،
والذي يوفر لك التتبع والجلسات والمراجعات. يتطلب الإنفاذ هناك ربط في
وقت تشغيلك الخاص — [تحدث إلينا](mailto:support@befailproof.ai) وسنقوم بتعيينه.

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
failproofai policies --install   # أو فقط قم بتشغيل `failproofai` واقبل موجه التشغيل الأول
failproofai
```

39 سياسة مدمجة تُفعَّل فوراً. لوحة المعلومات على `localhost:8020`. عطّل موجه التشغيل الأول باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما الذي يوقفه

| السياسة | ما الذي يحجبه |
|---|---|
| `sanitize-api-keys` | مفاتيح API تتسرب إلى سياق الوكيل |
| `block-env-files` | قراءة ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل يكرر نفس الاستدعاء |
| `block-sudo` | تصعيد الامتيازات |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` غير المحدود |
| `block-terraform` / `block-kubectl` | تغييرات غير مراجعة على البنية التحتية الحية |
| `block-rm-rf` | حذف الملفات بشكل متكرر |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

الخمس الأولى تنطبق على أي وكيل يمكنه استدعاء أداة. الثلاث الأخيرة مفضلة المطورين —
واجهات سطر أوامر الترميز هي فئة المحرك التي نغطيها بعمق أكبر.

→ [جميع السياسات المدمجة الـ 39](https://docs.befailproof.ai/policies/builtin)

---

## سياساتك الخاصة

ضع ملفاً في `.failproofai/policies/` — يحمّل تلقائياً، لا توجد أعلام مطلوبة.
التزمه وستحصل الفريق بالكامل عليه في السحب التالي.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("الكتابة إلى مسارات الإنتاج محجوبة.");
    return allow();
  },
});
```

ثلاثة قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حجبها — الرسالة تعود إلى الوكيل |
| `instruct(message)` | السماح بها، لكن أضف سياق إلى موجه الوكيل التالي |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/policies/custom)

---

## قابلية الملاحظة

الإنفاذ هو نصف واحد. النصف الآخر هو رؤية ما فعله الوكيل فعلاً.

شغّل `failproofai` بدون وسائط وسيخدم لوحة معلومات على `localhost:8020`
قارئاً سجل التشغيل الموجود بالفعل على جهازك — لا حساب، لا اشتراك، لا شيء
يترك الصندوق. تحصل على قائمة الجلسات، وتسلسل استدعاءات النموذج، واستدعاءات الأدوات
وقرارات الربط داخل كل تشغيل، ما تم حجبه وما قالته السياسة للوكيل،
وتدقيق غير متصل (`failproofai audit`) الذي يفحص سجلك بحثاً عن أنماط محفوفة بالمخاطر
ويقترح سياسات لإيقافها.

→ [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[قراءة التتبع](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**قابلية ملاحظة Failproof AI** هي الجانب المستضاف من نفس نموذج البيانات، للفرق
التي تشغّل الوكلاء عبر مجموعة: كل تشغيل من كل محرك في مكان واحد، رسم بياني للتنفيذ
مع وكلاء فرعيين متوازيين على مساراتهم الخاصة، زمن الاستجابة p50/p95/p99
للنماذج والأدوات والربط، التكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL
على تتبعاتك الخاصة مع لوحات معلومات قابلة للمشاركة، التقييمات المسجلة من قبل خدمتك الخاصة،
التدقيقات المجدولة التي تحول الفشل المتكرر إلى نتائج مدعومة بالأدلة، والتنبيهات
الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقع. الاستضافة الذاتية في مجموعتك الخاصة
متاحة في خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيقات](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | التثبيت وربط محرك وشاهد التشغيل الأول |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيفية عمل نظام الربط |
| [المحركات المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع الـ 12 وما يمكن لكل واحد منها إنفاذه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | اتبع تشغيلاً: النماذج والأدوات والأخطاء وزمن الاستجابة |
| [قراءة التتبع](https://docs.befailproof.ai/sessions/read-a-trace) | ما الذي يخبرك به رسم البياني للتنفيذ |
| [التدقيقات](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر عدد من الجلسات |
| [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا يوجد حساب مطلوب |

| أنفذ | |
|---|---|
| [السياسات المدمجة](https://docs.befailproof.ai/policies/builtin) | جميع السياسات الـ 39 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/policies/custom) | اكتب سياساتك الخاصة |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج |

| أدوات وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ابلغ عن التشغيلات من وكيل بدون محرك |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة بيع تجارية من failproofai نفسه يتطلب اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات جميعها مرحب بها.

> **بناء قبل أن تبدأ.** شغّل `bun install && bun run build` أولاً. يشغّل هذا الريبو
> ربطات failproofai الخاصة به على نفسه، ويحل استيراد `failproofai` مقابل
> حزمة `dist/` المترجمة — بدون بناء ستصطدم بأخطاء ربط `Cannot find package 'failproofai'`.
> أعد البناء بعد تغيير `src/`. انظر
> [بناء قبل أن تعمل ربطات dev في المريبو](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

بُني بـ ❤️ من قِبل [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>