> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | **🇸🇦 العربية** | [🇮🇱 עברית](README.he.md)

---
<div dir="rtl">


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

**الترجمات:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**المراقبة والفرض لكل بيئة تشغيل يعمل فيها الوكلاء الذكيون.** أينما يعمل وكلاؤك، نحن نراها — ويمكننا الرفض. يتصل Failproof بـ 12 بيئة تشغيل لوكلاء — واجهات سطر أوامر لكتابة الأكواد مثل Claude Code و Codex، بوابات الدردشة مثل Hermes، المساعدات المستضافة ذاتياً مثل OpenClaw — حيث نلتقط كل تشغيل ونمنع استدعاءات الأدوات الخطيرة قبل تنفيذها. 39 سياسة مدمجة. لا توجد زمن انتظار. يعمل محلياً.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

---

## بيئات التشغيل المدعومة

اثنتا عشرة بيئة تشغيل في فئتين — عشر واجهات سطر أوامر لكتابة الأكواد، واثنتا بوابات دردشة ومساعدات (Hermes و OpenClaw). واجهة برمجية واحدة للسياسات وسجل جلسة واحد في جميع الأنحاء. ما يمكن لسياسة *منعه* يختلف حسب البيئة: إيقاف استدعاء أداة قبل تشغيله يتم التحقق منه في جميع الاثنتي عشرة، أبواب نهاية المحادثة في ثمانية. تُدرج [مصفوفة البيئات](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) الأحداث التي يحترمها كل منها.

الوكلاء الذين يعملون في لا أحد منها يبلغون من خلال [Python SDK](https://docs.befailproof.ai/reference/custom-agents)، والذي يعطيك التتبع والجلسات والتدقيق. يتطلب الفرض هناك خطاف في وقت التشغيل الخاص بك — [تحدث معنا](mailto:support@befailproof.ai) وسنقوم بتعيينه.

{/* جدول بـ 6 أعمدة بدلاً من <img> مضمنة: أعمدة الجدول لا تعاد التفاف أبداً،
     لذا تبقى الشبكة 2×6 بأي عرض نافذة (التمرير على الشاشات الضيقة جداً
     بدلاً من الانهيار إلى صفوف يتيمة غير منتظمة). */}
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
failproofai config                             # قم بتوصيل وكلاؤك والقسم
failproofai policies add FailproofAI/policies  # اختر ما يجب فرضه
failproofai                                    # لوحة التحكم على localhost:8020
```

يقوم الإعداد بتوصيل الخطافات واختيار **لا أحد** من السياسات — هذا الأمر الثاني هو ما يضع حراسات على الجهاز، وأي مجموعة يتم كتابتها بنفس الطريقة (`failproofai policies add <owner>/<repo>`؛ `policies show <owner>/<repo>` يقرأ واحدة أولاً). قم بتشغيل `failproofai config` بدون محطة — CI، حاوية، وكيل يقودها — وتطبق بدلاً من السؤال. على جهاز لم يتم إعداده أبداً، أي أمر آخر يقوم بتشغيل نفس المعالج أولاً؛ عطّله باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

حتى تصل مجموعة، الشيء الوحيد الذي يفرضه هو `block-failproofai-commands`، وهو يعمل دائماً ولا يمكن إيقافه أو إيقافه مؤقتاً: وكيل يمكنه إيقاف الفرض يمكنه إيقاف كل سياسة أخرى.

---

## ما يتم إيقافه

| السياسة | ما يتم منعه |
|---|---|
| `block-env-files` | قراءة ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل الذي ينقر على نفس الاستدعاء |
| `block-sudo` | تصعيد الامتيازات |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` غير محدود |
| `block-terraform` / `block-kubectl` | التغييرات غير المراجعة على البنية التحتية المباشرة |
| `block-rm-rf` | حذف ملفات متكرر |
| `block-force-push` / `block-push-master` | `git push --force`، دفع مباشر إلى `main` |

كل واحد منها يوقف الاستدعاء *قبل* تشغيله، لذا فهو يعمل في جميع الاثنتي عشرة بيئات تشغيل. الأربعة الأولى تنطبق على أي وكيل يمكنه استدعاء أداة؛ الثلاثة الأخيرة هي المفضلة للمطورين — واجهات سطر أوامر الكتابة هي فئة البيئات التي نغطيها بعمق. أسرة `sanitize-*` منفصلة: فهي تعمل بعد عودة الأداة، لذا تبلغ عن سر في إخراج الأداة بدلاً من إبقاؤه بعيداً عن السياق.

→ [جميع 39 سياسة مدمجة](https://docs.befailproof.ai/policies/packs)

---

## سياساتك الخاصة

أسقط ملف في `.failproofai/policies/` — يتم تحميله تلقائياً، بدون أعلام مطلوبة.
تعهد بها والفريق بأكمله يحصل عليها في السحب التالي.

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
| `deny(message)` | منعها — الرسالة تعود إلى الوكيل |
| `instruct(message)` | السماح بها، لكن أضف سياقاً إلى طلب الوكيل التالي |

→ [اكتب سياسة](https://docs.befailproof.ai/policies/editor)

---

## المراقبة

الفرض هو نصف. النصف الآخر هو معرفة ما فعله الوكيل فعلاً.

قم بتشغيل `failproofai` بدون وسائط وسيخدم لوحة تحكم على `localhost:8020` يقرأ سجل التشغيل الموجود بالفعل على جهازك — بدون حساب، بدون التسجيل، لا شيء يترك الصندوق. تحصل على قائمة الجلسات، وتسلسل استدعاءات النموذج، واستدعاءات الأدوات وقرارات الخطاف داخل كل تشغيل، ما تم منعه وما قالت السياسة للوكيل، وتدقيق غير متصل (`failproofai audit`) الذي يمسح السجل الخاص بك بحثاً عن أنماط محفوفة بالمخاطر ويقترح سياسات لإيقافها.

→ [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** هي الجانب المستضاف من نفس نموذج البيانات، للفرق التي تشغل وكلاء عبر أسطول: كل تشغيل من كل بيئة تشغيل في مكان واحد، رسم بياني للتنفيذ مع وكلاء فرعيين متوازيين على مسارات خاصة بهم، زمن انتظار p50/p95/p99 للنماذج والأدوات والخطافات، تكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL على أثارك الخاصة مع لوحات تحكم قابلة للمشاركة، التقييمات المسجلة من قبل خدمتك الخاصة، التدقيق المجدول الذي يحول الإخفاقات المتكررة إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقعة. الاستضافة الذاتية في مجموعتك الخاصة متاحة على خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيق](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## الوثائق

| ابدأ | |
|---|---|
| [البداية السريعة](https://docs.befailproof.ai/start/quickstart) | قم بالتثبيت، وقم بتوصيل بيئة تشغيل، وشاهد أول تشغيل |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيفية عمل نظام الخطاف |
| [بيئات التشغيل المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع 12، وما يمكن لكل واحدة أن تفرضه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | اتبع التشغيل: النماذج والأدوات والأخطاء وزمن الانتظار |
| [قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) | ما يخبرك به رسم البياني التنفيذي |
| [التدقيق](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر جلسات عديدة |
| [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا يتطلب حساباً |

| فرض | |
|---|---|
| [مجموعات السياسات](https://docs.befailproof.ai/policies/packs) | سياسات Failproof AI، والمجموعات من مركز السياسات |
| [اكتب سياسة](https://docs.befailproof.ai/policies/editor) | من التدقيق، أو في الكود |
| [الإعدادات](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج ومعاملات السياسة |

| أدخل وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | الإبلاغ عن عمليات من وكيل بدون بيئة تشغيل |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة البيع التجاري لـ failproofai نفسه تتطلب اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدودية والترجمات جميعها موضع ترحيب.

> **قم بالبناء قبل أن تبدأ.** قم بتشغيل `bun install && bun run build` أولاً. يقوم هذا الريبو بتشغيل خطافات failproofai الخاصة به على نفسه، ويحل `failproofai` المستورد مقابل `dist/` المترجم — بدون بناء ستصل إلى أخطاء خطاف `Cannot find package 'failproofai'`. أعد البناء بعد تغيير `src/`. انظر [البناء قبل أن تعمل خطافات dev في الريبو](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

تم البناء بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>