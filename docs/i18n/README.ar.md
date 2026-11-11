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

**المراقبة والإنفاذ لكل إطار عمل تشغل فيه وكلاءك.** أينما يعمل وكلاءك، نحن نراه — ويمكننا الرفض. يتصل Failproof بـ 12 إطار عمل للوكيل — واجهات سطر أوامر ترميز مثل Claude Code و Codex، بوابات الدردشة مثل Hermes، والمساعدات ذاتية الاستضافة مثل OpenClaw — التقاط كل عملية وحظر استدعاءات الأدوات الخطيرة قبل تنفيذها. 40 سياسة مدمجة. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

---

## أطر العمل المدعومة

اثنا عشر إطار عمل في فئتين — عشر واجهات سطر أوامر للترميز، وبوابتان للدردشة والمساعد (Hermes، OpenClaw). واجهة برمجة تطبيقات سياسة واحدة وسجل جلسة واحد عبر جميعها. ما يمكن لسياسة أن تحظره محدد لكل إطار عمل: إيقاف استدعاء الأداة قبل تشغيله يتم التحقق منه على الاثني عشر جميعًا، بوابات نهاية الدور على ثمانية منها. تسرد [مصفوفة لكل إطار عمل](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) الأحداث التي يقبلها كل منها.

الوكلاء الذين يعملون بدون أي منها يقدمون تقارير من خلال [Python SDK](https://docs.befailproof.ai/reference/custom-agents)، الذي يوفر لك التتبع والجلسات والتدقيق. يحتاج الإنفاذ هناك إلى خطاف في وقت التشغيل الخاص بك — [تواصل معنا](mailto:support@befailproof.ai) وسنرسمها.

{/* جدول بـ 6 أعمدة بدلاً من <img> مضمنة: أعمدة الجدول لا تعاد أبدًا،
     لذلك تبقى الشبكة 2×6 بأي عرض نافذة (التمرير على الشاشات الضيقة جدًا
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
failproofai config                             # قم بتوصيل وكلاءك والخادم الخلفي
failproofai policies add FailproofAI/policies  # اختر ما تريد فرضه
failproofai                                    # لوحة التحكم على localhost:8020
```

يقوم الإعداد بتوصيل الخطافات واختيار **لا شيء** من السياسات — الأمر الثاني هو ما يضع حواجز حماية على الجهاز، وأي حزمة من نفس النوع
(`failproofai policies add <owner>/<repo>`؛ `policies show <owner>/<repo>` تقرأ واحدة أولاً). قم بتشغيل `failproofai config` بدون محطة طرفية — CI، حاوية، وكيل يقودها — وستطبق بدلاً من السؤال. على جهاز لم يتم إعداده مطلقًا، يقوم أي أمر آخر بتشغيل نفس المعالج أولاً؛ عطل ذلك مع `FAILPROOFAI_NO_FIRST_RUN=1`.

حتى تصل حزمة، الشيء الوحيد الذي يفرضه هو `block-failproofai-commands`، وهو دائمًا قيد التشغيل ولا يمكن إيقاف تشغيله أو إيقافه مؤقتًا: وكيل يمكنه إيقاف الإنفاذ مؤقتًا يمكنه إيقاف تشغيل كل سياسة أخرى.

---

## ما يوقفه

| السياسة | ما يحظره |
|---|---|
| `block-env-files` | قراءات ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل يلوب على نفس الاستدعاء |
| `block-sudo` | تصعيد الامتيازات |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` بدون حدود |
| `block-terraform` / `block-kubectl` | تغييرات غير مراجعة للبنية التحتية المباشرة |
| `block-rm-rf` | حذف الملفات العودي |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

كل واحدة منها تسد الاستدعاء *قبل* تشغيله، لذا فإنها تعمل على جميع الاثني عشر إطار عمل. الأربعة الأولى تنطبق على أي وكيل يمكنه استدعاء أداة؛ الثلاثة الأخيرة هي المفضلة للمطورين — واجهات سطر أوامر الترميز هي فئة إطار العمل التي نغطيها بعمق. عائلة `sanitize-*` منفصلة: تعمل بعد عودة الأداة، لذا تقدم تقارير بسر في مخرجات الأداة بدلاً من إبقاؤها خارج السياق.

→ [جميع السياسات المدمجة 40](https://docs.befailproof.ai/policies/packs)

---

## سياساتك الخاصة

قم بإسقاط ملف في `.failproofai/policies/` — يتم تحميله تلقائيًا، بدون الحاجة لأي علامات.
قم بالالتزام بها وستحصل الفريق بأكمله عليها في السحب التالي.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("حظر الكتابة إلى مسارات الإنتاج.");
    return allow();
  },
});
```

ثلاثة قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حظرها — تعود الرسالة إلى الوكيل |
| `instruct(message)` | اسمح بها، لكن أضف السياق إلى موجه الوكيل التالي |

→ [اكتب سياسة](https://docs.befailproof.ai/policies/editor)

---

## المراقبة

الإنفاذ هو النصف. النصف الآخر هو رؤية ما فعله الوكيل فعلاً.

قم بتشغيل `failproofai` بدون وسائط وستخدم لوحة تحكم على `localhost:8020` تقرأ سجل التشغيل الموجود بالفعل على جهازك — بدون حساب، بدون تسجيل، بلا شيء يغادر الصندوق. تحصل على قائمة الجلسات، وتسلسل استدعاءات النموذج، واستدعاءات الأدوات وقرارات الخطاف داخل كل عملية، وما تم حظره والرسالة التي تخبر الوكيل بها السياسة، وتدقيق غير متصل (`failproofai audit`) الذي يمسح سجلك بحثًا عن أنماط محفوفة بالمخاطر ويقترح السياسات لإيقافها.

→ [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[اقرأ أثراً](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**مراقبة Failproof AI** هي الجانب المستضاف من نفس نموذج البيانات، للفرق التي تشغل الوكلاء عبر مجموعة: كل عملية من كل إطار عمل في مكان واحد، رسم بياني تنفيذي مع وكلاء فرعيين متوازيين على ممرات منفصلة، p50/p95/p99 كمون للنماذج والأدوات والخطافات، تتبع التكلفة والنافذة السياقية لكل نموذج، تتبع الأخطاء، SQL على آثارك الخاصة مع لوحات تحكم قابلة للمشاركة، تقييمات يسجلها خدمتك الخاصة، عمليات تدقيق مجدولة تحول الأخطاء المتكررة إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو خطاف موقع. الاستضافة الذاتية في مجموعتك الخاصة متاحة على خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيقات](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | التثبيت، اتصل بإطار عمل، شاهد أول عملية |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |
| [أطر العمل المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع الـ 12، وما يمكن لكل منها أن تفرضه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | اتبع عملية: النماذج، الأدوات، الأخطاء، الكمون |
| [اقرأ أثراً](https://docs.befailproof.ai/sessions/read-a-trace) | ما يخبرك به الرسم البياني التنفيذي |
| [التدقيقات](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر جلسات كثيرة |
| [لوحة التحكم المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا توجد حاجة لحساب |

| فرض | |
|---|---|
| [حزم السياسات](https://docs.befailproof.ai/policies/packs) | سياسات Failproof AI، والحزم من مركز السياسات |
| [اكتب سياسة](https://docs.befailproof.ai/policies/editor) | من تدقيق، أو في الكود |
| [الإعدادات](https://docs.befailproof.ai/policies/local-configuration) | نطاقات الإعدادات، قواعد الدمج وبارامترات السياسة |

| أدوات وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | قدم تقارير بالعمليات من وكيل بدون إطار عمل |
| [سياسة SDK](https://docs.befailproof.ai/reference/policy-sdk) | مرجع `allow` / `deny` / `instruct` |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة البيع التجاري لـ failproofai نفسه يتطلب اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها مرحب بها.

---

تم بناؤه بـ ❤️ من قبل [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>