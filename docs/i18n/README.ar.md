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

**المراقبة والتطبيق لكل محرّك توليد أكواد يعمل في بيئتك.**
أينما يعمل وكلاء برامجك، نحن نراهم — ويمكننا أن نرفضهم. يتصل failproofai بـ 12 محرّك توليد أكواد — واجهات سطر الأوامر البرمجية مثل Claude Code وCodex، بوابات الدردشة مثل Hermes، والمساعدات المستضافة ذاتياً مثل OpenClaw — حيث نلتقط كل عملية ونمنع استدعاءات الأدوات الخطيرة قبل تنفيذها. 39 سياسة مدمجة. بدون تأخير. يعمل محلياً.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## المحركات المدعومة

اثنا عشر محركاً في فئتين — عشرة واجهات سطر أوامر برمجية، وبوابتا دردشة ومساعدة (Hermes، OpenClaw). واجهة برمجية واحدة للسياسات وسجل جلسة واحد عبر جميعها. ما يمكن لسياسة أن *تمنعه* يختلف حسب المحرك: منع استدعاء أداة قبل تنفيذها يتم التحقق منه على جميع الاثني عشر، وأبواب نهاية الدورة على ثمانية. تُدرج [مصفوفة كل محرك](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) الأحداث التي يحترمها كل واحد.

الوكلاء الذين يعملون في لا أحد منهم يُبلّغون من خلال [Python SDK](https://docs.befailproof.ai/reference/custom-agents)، الذي يعطيك التتبع والجلسات والتدقيق. يحتاج التطبيق هناك إلى خطاف في بيئتك الخاصة — [تحدث معنا](mailto:support@befailproof.ai) وسنرسمها.

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
failproofai config                             # wire up your agents and the daemon
failproofai policies add FailproofAI/policies  # choose what to enforce
failproofai                                    # dashboard on localhost:8020
```

يربط الإعداد الخطافات ولا يختار أي سياسات — الأمر الثاني هو ما يضع القيود على الآلة، وأي حزمة مكتوبة بنفس الطريقة
(`failproofai policies add <owner>/<repo>`؛ `policies show <owner>/<repo>` تقرأ واحدة أولاً). قم بتشغيل `failproofai config` بدون طرفية — CI، حاوية، وكيل يقودها — وتطبق بدلاً من السؤال. على آلة لم يتم إعدادها أبداً، يقوم أي أمر آخر بتشغيل نفس المعالج أولاً؛ عطّله باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

حتى وصول الحزمة، الشيء الوحيد الذي يفرضه هو `block-failproofai-commands`، وهو دائماً مُفعّل ولا يمكن إيقافه أو إيقافه مؤقتاً: يمكن لوكيل يمكنه إيقاف التطبيق أن يعطّل كل سياسة أخرى.

---

## ما الذي يوقفه

| السياسة | ما الذي يمنعه |
|---|---|
| `block-env-files` | قراءة ملفات `.env` والملفات السرية الأخرى |
| `warn-repeated-tool-calls` | الوكيل يحلقة على نفس الاستدعاء |
| `block-sudo` | تصعيد الامتياز |
| `warn-destructive-sql` | `DROP`، `TRUNCATE`، `DELETE` غير المحدودة |
| `block-terraform` / `block-kubectl` | التغييرات غير المراجعة للبنية التحتية المباشرة |
| `block-rm-rf` | حذف الملفات العودي |
| `block-force-push` / `block-push-master` | `git push --force`، الدفع المباشر إلى `main` |

كل واحد منهم يوقف الاستدعاء *قبل* تنفيذه، لذا فهي تعمل على جميع الاثني عشر محركاً. الأربعة الأولى تنطبق على أي وكيل يمكنه استدعاء أداة؛ الثلاثة الأخيرة هي المفضلة لدى المطورين — واجهات سطر الأوامر البرمجية هي فئة المحرك التي نغطيها بعمق. عائلة `sanitize-*` منفصلة: تعمل بعد عودة الأداة، لذا تبلغ عن سر في مخرجات الأداة بدلاً من الاحتفاظ بها من السياق.

→ [جميع السياسات المدمجة الـ 39](https://docs.befailproof.ai/policies/packs)

---

## سياساتك الخاصة

أسقط ملفاً في `.failproofai/policies/` — يتم تحميله تلقائياً، بدون علامات مطلوبة.
التزمه والفريق بأكمله يحصل عليه في الجلب التالي.

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
| `deny(message)` | منعها — الرسالة تعود إلى الوكيل |
| `instruct(message)` | اتركها تمر، لكن أضف السياق للموجه التالي للوكيل |

→ [اكتب سياسة](https://docs.befailproof.ai/policies/editor)

---

## المراقبة

التطبيق هو نصف واحد. النصف الآخر هو معرفة ما فعله الوكيل بالفعل.

قم بتشغيل `failproofai` بدون وسائط وستخدم لوحة معلومات على `localhost:8020`
تقرأ سجل التشغيل الموجود بالفعل على جهازك — بدون حساب، بدون التسجيل، لا شيء يترك الصندوق. تحصل على قائمة الجلسة، تسلسل استدعاءات النموذج، استدعاءات الأدوات وقرارات الخطاف داخل كل تشغيل، ما الذي تم حظره وما قالته السياسة للوكيل، والتدقيق غير المتصل (`failproofai audit`) الذي يفحص السجل الخاص بك عن الأنماط المحفوفة بالمخاطر ويقترح السياسات لإيقافها.

→ [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) ·
[اقرأ تتبعاً](https://docs.befailproof.ai/sessions/read-a-trace) ·
[التدقيق المحلي](https://docs.befailproof.ai/audits/local-audit)

**مراقبة Failproof AI** هي الجانب المستضاف من نفس نموذج البيانات، للفريق الذي يعمل بوكلاء عبر أسطول: كل تشغيل من كل محرك في مكان واحد، رسم بياني للتنفيذ مع الوكلاء الفرعيين المتوازية على حاراتهم الخاصة، زمن الوصول p50/p95/p99 للنماذج والأدوات والخطافات، تكلفة كل نموذج وتتبع نافذة السياق، تتبع الأخطاء، SQL على آثارك الخاصة مع لوحات معلومات قابلة للمشاركة، التقييمات المسجلة من قبل خدمتك الخاصة، الحسابات المجدولة التي تتحول الفشل المتكرر إلى نتائج مدعومة بالأدلة، والتنبيهات الموجهة إلى Slack أو البريد الإلكتروني أو webhook موقع. الاستضافة الذاتية في الحزمة الخاصة بك متاحة في خطة Enterprise.

→ [الجلسات](https://docs.befailproof.ai/sessions/overview) ·
[التدقيق](https://docs.befailproof.ai/audits/overview) ·
[احجز عرضاً توضيحياً](https://befailproof.ai/get-a-demo)

---

## التوثيق

| ابدأ | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/start/quickstart) | التثبيت، توصيل محرك، عرض التشغيل الأول |
| [المفاهيم](https://docs.befailproof.ai/start/concepts) | كيف يعمل نظام الخطاف |
| [المحركات المدعومة](https://docs.befailproof.ai/reference/harnesses) | جميع الـ 12، وما يمكن لكل واحد منهم فرضه |

| لاحظ | |
|---|---|
| [الجلسات](https://docs.befailproof.ai/sessions/overview) | متابعة التشغيل: النماذج، الأدوات، الأخطاء، الكمون |
| [اقرأ تتبعاً](https://docs.befailproof.ai/sessions/read-a-trace) | ما الذي يخبرك به الرسم البياني للتنفيذ |
| [التدقيق](https://docs.befailproof.ai/audits/overview) | ابحث عن أنماط الفشل عبر جلسات عديدة |
| [لوحة المعلومات المحلية](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`، لا يلزم حساب |

| فرض | |
|---|---|
| [حزم السياسات](https://docs.befailproof.ai/policies/packs) | سياسات Failproof AI، والحزم من مركز السياسات |
| [اكتب سياسة](https://docs.befailproof.ai/policies/editor) | من تدقيق، أو في الكود |
| [التكوين](https://docs.befailproof.ai/policies/local-configuration) | نطاقات التكوين، قواعد الدمج ومعاملات السياسة |

| جهز وكيلك الخاص | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | بلغ عن التشغيل من وكيل بدون محرك |
| [سياسة SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` مرجع |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ يتطلب إعادة البيع التجاري لـ failproofai نفسه اتفاقية منفصلة. انظر [LICENSE](../../LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها مرحب بها.

> **بنِ قبل البدء.** قم بتشغيل `bun install && bun run build` أولاً. يعمل هذا المستودع خطافات failproofai الخاصة به على نفسه، ويحل استيراد `failproofai` مقابل حزمة `dist/` المترجمة — بدون بناء ستواجه أخطاء خطاف `Cannot find package 'failproofai'`. أعد البناء بعد تغيير `src/`. انظر
[بناء قبل عمل الخطافات داخل المستودع](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

بُنيت بـ ❤️ من قِبل [befailproof.ai](https://befailproof.ai) في SF و Bengaluru.


</div>