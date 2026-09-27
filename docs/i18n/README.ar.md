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

**المراقبة والإنفاذ لكل بيئة تشغيل يعمل فيها وكلاؤك.** أينما يعمل وكلاؤك، نحن نرى ذلك — وبإمكاننا الرفض. يدعم Failproof 12 بيئة تشغيل للعملاء — بما فيها أدوات سطر الأوامر البرمجية مثل Claude Code و Codex، وبوابات الدردشة مثل Hermes، والمساعدين المستضافين ذاتياً مثل OpenClaw — حيث يقوم بالتقاط كل عملية وحجب استدعاءات الأدوات الخطرة قبل تنفيذها. 40 سياسة مدمجة. بدون تأخير. يعمل محلياً.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

---

## البيئات المدعومة

اثنا عشر بيئة تشغيل في فئتين — عشر أدوات سطر أوامر برمجية، وبوابتا دردشة ومساعد (Hermes, OpenClaw). واجهة برمجية للسياسات واحدة وسجل جلسات واحد عبر جميعها. ما يمكن لسياسة أن تحجبه يختلف حسب البيئة: إيقاف استدعاء الأداة قبل تنفيذه يُتحقق منه على الاثني عشر جميعاً، وبوابات نهاية الدورة على ثمانية منها. تحتوي [مصفوفة البيئات لكل نوع](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) على الأحداث التي يشرفها كل واحد.

يرسل الوكلاء الذين يعملون في أي منها عبر [Python SDK](https://docs.befailproof.ai/reference/custom-agents)، والذي يوفر لك التتبع والجلسات والتدقيق. يتطلب الإنفاذ هناك خطاف في بيئة التشغيل الخاصة بك — [تواصل معنا](mailto:support@befailproof.ai) وسنقوم بتعيينها.

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
failproofai config                             # ربط وكلائك والخادم
failproofai policies add FailproofAI/policies  # اختر ما تريد إنفاذه
failproofai                                    # لوحة التحكم على localhost:8020
```

يقوم الإعداد بربط الخطافات واختيار **لا** سياسات — الأمر الثاني هو ما يضع أسوار على الجهاز، وأي حزمة لها نفس النوع
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` اقرأ واحدة أولاً). شغّل `failproofai config` بدون محطة — CI، حاوية، وكيل يقودها — وتطبق بدلاً من السؤال. على جهاز لم تُعده من قبل، أي أمر آخر سيشغل نفس الساحر أولاً؛ عطّله باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

حتى وصول الحزمة، الشيء الوحيد الذي ينفذ هو `block-failproofai-commands`، والذي يكون مفعّلاً دائماً ولا يمكن إيقافه أو إيقافه مؤقتاً: وكيل يمكنه إيقاف الإنفاذ يمكنه إيقاف كل سياسة أخرى.

---

## ما يحجبه

| السياسة | ما يحجبه |
|---|---|
| `block-env-files` | قراءات ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل يكرر نفس الاستدعاء |
| `block-sudo` | صعود الامتيازات |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` غير المحدود |
| `block-terraform` / `block-kubectl` | التغييرات غير المراجعة للبنية التحتية المباشرة |
| `block-rm-rf` | حذف الملفات العودي |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

كل واحدة منها تحجب الاستدعاء *قبل* تنفيذه، لذا تعمل على الاثني عشر بيئة تشغيل جميعها. تنطبق الأربعة الأولى على أي وكيل يمكنه استدعاء أداة؛ الثلاث الأخيرة تفضيلات المطورين — أدوات سطر الأوامر البرمجية هي فئة البيئة التي نغطيها بأعمق. عائلة `sanitize-*` منفصلة: تعمل بعد عودة الأداة، لذا تبلّغ عن سر في إخراج الأداة بدلاً من إبقائه بعيداً عن السياق.

→ [جميع السياسات المدمجة الـ 40](https://docs.befailproof.ai/policies/packs)

---

## سياساتك الخاصة

أسقط ملفاً في `.failproofai/policies/` — يتم تحميله تلقائياً، بدون أعلام مطلوبة.
التزمه والفريق بأكمله يحصل عليه في الجلب التالي.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("الكتابة إلى مسارات الإنتاج مسدودة.");
    return allow();
  },
});
```

ثلاث قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حجبها — الرسالة تعود للوكيل |
| `instruct(message)` | دعها تمر، لكن أضف سياقاً لموجه الوكيل التالي |

→ [اكتب سياسة](https://docs.befailproof.ai/policies/editor)

---

## المراقبة

الإنفاذ هو نصف الموضوع. النصف الآخر هو رؤية ما فعله الوكيل فعلاً.

شغّل `failproofai` بدون معاملات وسيعمل لوحة تحكم على `localhost:8020` تقرأ سجل التشغيل بالفعل على جهازك — لا حساب، لا تسجيل، لا شيء يترك الصندوق. تحصل على قائمة الجلسات، والتسلسل الزمني لاستدعاءات النموذج، واستدعاءات الأدوات وقرارات الخطاف داخل كل تشغيل، ما تم حجبه وما قالته السياسة للوكيل، وتدقيق غير متصل (`failproofai audit`) يمسح سجلك عن أنماط محفوفة بالمخاطر ويقترح السياسات لإيقافها.

→ [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[اقرأ أثراً](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**مراقبة Failproof AI** هي الجانب المستضاف من نفس نموذج البيانات، للفرق التي تشغل الوكلاء عبر أسطول: كل تشغيل من كل بيئة في مكان واحد، رسم بياني للتنفيذ مع وكلاء فرعيين متوازيين على مساراتهم الخاصة، كمون p50/p95/p99 للنماذج والأدوات والخطافات، التكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL على أثرك الخاص مع لوحات تحكم قابلة للمشاركة، التقييمات المسجلة بواسطة خدمتك الخاصة، التدقيق المجدول الذي يحول الأعطال المتكررة إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو ويبهوك موقع. الاستضافة الذاتية في مجموعتك الخاصة متاحة في خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيق](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البداية السريعة](https://docs.befailproof.ai/start/quickstart) | التثبيت، وربط بيئة، ورؤية أول تشغيل |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيفية عمل نظام الخطافات |
| [البيئات المدعومة](https://docs.befailproof.ai/reference/harnesses) | الاثنا عشر جميعاً، وما يمكن لكل واحدة أن تنفذه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | اتبع تشغيلاً: النماذج والأدوات والأخطاء والكمون |
| [اقرأ أثراً](https://docs.befailproof.ai/sessions/read-a-trace) | ما يخبرك به الرسم البياني للتنفيذ |
| [التدقيق](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر جلسات عديدة |
| [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا حاجة لحساب |

| فرض | |
|---|---|
| [حزم السياسات](https://docs.befailproof.ai/policies/packs) | سياسات Failproof AI والحزم من مركز السياسات |
| [اكتب سياسة](https://docs.befailproof.ai/policies/editor) | من تدقيق أو في الكود |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج ومعاملات السياسة |

| جهّز وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | بلغ عن التشغيلات من وكيل بدون بيئة |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ البيع التجاري لإعادة بيع failproofai نفسه يتطلب اتفاقاً منفصلاً. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة وحالات الحدود والترجمات كلها مرحب بها.

> **بنِ قبل أن تبدأ.** شغّل `bun install && bun run build` أولاً. يشغل هذا المستودع خطافات failproofai الخاصة به على نفسه، ويحل استيراد `failproofai` مقابل حزمة `dist/` المترجمة — بدون بناء ستصادف أخطاء خطاف `Cannot find package 'failproofai'`. أعد البناء بعد تغيير `src/`. انظر
> [بنِ قبل أن تعمل خطافات dev في المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

مبني بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>