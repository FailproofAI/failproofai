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

**شاهد ما يفعله وكلاؤك. توقف الأخطاء المعروفة قبل أن تتكرر.**
يعمل Failproof AI في أي مكان يعمل فيه وكلاؤك: أدوات البرمجة مثل Claude Code و
Codex، بوابات الدردشة مثل Hermes، المساعدون المضيفون ذاتياً مثل OpenClaw، والوكلاء
الذين تزودهم بالأدوات بنفسك. يسجل كل عملية تشغيل ويمكنه حظر استدعاءات الأدوات الخطيرة
قبل تنفيذها.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## الأدوات المدعومة

يتم دعم اثني عشر أداة في فئتين: عشر برامج سطر أوامر برمجة، بالإضافة إلى بوابتين: Hermes وOpenClaw. يتم مشاركة واجهة برنامج السياسة وسجل الجلسة؛ تختلف الأحداث التي يمكن حظرها حسب الأداة.

الوكلاء الذين يعملون في لا أحد منهم يقدمون تقارير من خلال [Python SDK](https://docs.befailproof.ai/reference/custom-agents)،
الذي يعطيك التتبع والجلسات والتدقيق. يحتاج الفرض هناك إلى خطاف في
وقت التشغيل الخاص بك — [تحدث معنا](mailto:support@befailproof.ai) وسنضعه على الخريطة.

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

أعط الوكيل المتوافق مهارة Failproof AI إذا أردت منه أن يوجه الإعداد،
فحص الجهاز، وتوجيه السياسة والتدقيق والجلسة وعمل السحابة بشكل صحيح:

```sh
npx skills add FailproofAI/skills
```

يثبت هذا المهارة الشاملة وأخواتها المتخصصة. لتثبيت المهارة الشاملة فقط،
أضف `--skill failproofai`. توفر المهارات تعليمات التشغيل؛ ثبت وكون المنتج نفسه مع:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

يربط الإعداد الوكلاء المدعومين ويثبت خدمة الخلفية. لا يختار حزمة سياسة: قبل إضافة واحدة، فقط `block-failproofai-commands` يعمل لإيقاف وكيل من تعطيل Failproof AI.

اتصل بالسحابة بدون مطالبات باستخدام `failproofai config --token <machine-key>`. على جهاز مشترك أو في CI، عيّن `FAILPROOFAI_CLOUD_TOKEN` وشغّل `failproofai config`
بحيث لا تظهر المفتاح في سجل الأوامر.

---

## ما يوقفه

| السياسة | ما تحظره |
|---|---|
| `sanitize-api-keys` | مفاتيح API التي تتسرب إلى سياق الوكيل |
| `block-env-files` | قراءات ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل في حلقة على نفس الاستدعاء |
| `block-sudo` | زيادة الامتيازات |
| `warn-destructive-sql` | `DROP`و `TRUNCATE` و `DELETE` غير محدودة |
| `block-terraform` / `block-kubectl` | تغييرات غير مراجعة للبنية التحتية المباشرة |
| `block-rm-rf` | حذف الملفات العودي |
| `block-force-push` / `block-push-master` | `git push --force` والدفع المباشر إلى `main` |

تحمي هذه السياسات الملفات والبيانات الاعتماديّة والبنية التحتية وقواعد البيانات وسير عمل الوكيل. يختلف دعم الفرض الدقيق حسب الأداة والحدث.

→ [جميع السياسات المدمجة الـ 39](https://docs.befailproof.ai/policies/builtin)

---

## سياساتك الخاصة

ضع ملف في `.failproofai/policies/` — يحمل تلقائياً، بدون أعلام مطلوبة.
التزمها وستحصل الفريق كله عليها في السحب التالي.

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
| `deny(message)` | حظرها — الرسالة تعود إلى الوكيل |
| `instruct(message)` | دعها تمر، لكن أضف السياق إلى الفورة التالية للوكيل |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/policies/custom)

---

## حزم السياسات

حزمة السياسة عبارة عن مجموعة مصدرة من السياسات المنشورة من مستودع GitHub العام.
افحص واحدة قبل تثبيتها:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

أي شيء بشرطة مائلة هو مصدر حزمة؛ أي شيء بدونها هو اسم السياسة.
يمكنك تثبيت الفئات أو السياسات المختارة، وتثبيت إصدار عند الحاجة.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

تصفح الحزم المنشورة في [Policy Hub](https://befailproof.ai/policy-hub/)، أو
شغّل `failproofai publish --init` لبدء حزمتك الخاصة. يسمح وضع الملاحظة للحزمة بتسجيل
ما كانت ستفعله بدون حظر: `failproofai publish --effect observe`.

→ [حزم السياسات](https://docs.befailproof.ai/policies/packs) ·
[نشر حزمة](https://docs.befailproof.ai/policies/publish-a-pack)

---

## قابلية المراقبة

الفرض هو نصف. النصف الآخر هو رؤية ما فعله الوكيل بالفعل.

شغّل `failproofai` بدون وسائط وسيخدم لوحة تحكم على `localhost:8020`
يقرأ سجل التشغيل الموجود بالفعل على جهازك — لا حساب، لا اشتراك، لا شيء
يترك الصندوق. تحصل على قائمة الجلسات وتسلسل استدعاءات النموذج واستدعاءات الأدوات
وقرارات الخطاف داخل كل تشغيل، ما تم حظره وما قالته السياسة للوكيل، وتدقيق غير متصل (`failproofai audit`) الذي يمسح سجلك بحثاً عن الأنماط الخطيرة ويقترح السياسات لإيقافها.

→ [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** هو الجانب المستضاف من نفس نموذج البيانات، للفرق
التي تدير الوكلاء عبر حديقة: كل عملية تشغيل من كل أداة في مكان واحد، رسم بياني للتنفيذ مع الوكلاء الفرعيين المتوازيين في مساراتهم الخاصة، كمون p50/p95/p99 للنماذج والأدوات والخطافات، التكلفة لكل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL على ردودك الخاصة مع لوحات معلومات قابلة للمشاركة، التقييمات التي تسجلها خدمتك الخاصة، الفحوصات المجدولة التي تحول الأعطال المتكررة إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقع. يتوفر الاستضافة الذاتية في مجموعتك الخاصة على خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيقات](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | ثبت، اربط أداة، شاهد التشغيل الأول |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |
| [الأدوات المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع الـ 12، وما يمكن لكل منها أن ينفذه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | تتبع تشغيل: النماذج والأدوات والأخطاء والكمون |
| [قراءة تتبع](https://docs.befailproof.ai/sessions/read-a-trace) | ما الذي يخبرك به الرسم البياني للتنفيذ |
| [التدقيقات](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الأعطال عبر جلسات متعددة |
| [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، بدون حساب مطلوب |

| فرض | |
|---|---|
| [السياسات المدمجة](https://docs.befailproof.ai/policies/builtin) | جميع السياسات الـ 39 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/policies/custom) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين وقواعد الدمج |

| جهز وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | قدم التقارير من وكيل بدون أداة |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة بيع تجاري من failproofai نفسه يتطلب اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها موضع ترحيب.

> **بناء قبل أن تبدأ.** شغّل `bun install && bun run build` أولاً. يدير هذا المستودع
> خطافات failproofai الخاصة به على نفسه، وتحل استيراد `failproofai` ضد
> حزمة `dist/` المجمعة — بدون بناء ستواجه أخطاء خطاف `Cannot find package 'failproofai'`.
> أعد البناء بعد تغيير `src/`. انظر
> [بناء قبل أن تعمل خطافات dev داخل المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

مبني بـ ❤️ بواسطة [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>