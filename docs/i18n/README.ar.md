> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | **🇸🇦 العربية** | [🇮🇱 עברית](README.he.md)

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**الترجمات:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**حل فوري لأخطاء وقت التشغيل للعملاء الذين يكتبون الأكواد.**
يتكامل مع Claude Code و Codex. يوقف الحلقات اللانهائية والإجراءات الخطرة وتسريب الأسرار
قبل أن تصبح حوادث. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## واجهات سطر الأوامر للعملاء المدعومة

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

> ثبّت الخطافات لأحد العملاء أو مجموعة منهم: `failproofai policies --install --cli opencode pi` (أو `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). حذف `--cli` للكشف التلقائي عن واجهات سطر الأوامر المثبتة والطلب منك الاختيار.
>
> يتم دعم **Hermes** (hermes-agent، بوابة Slack/Telegram) لكل من **فرض الخطاف المباشر** (`--cli hermes` — يتم اعتراض استدعاءات الأدوات من كل منصة والعملاء الفرعيين) و**تدقيق** لا يتصل بالإنترنت لجلسات البوابة من `~/.hermes/state.db`.
>
> يتم دعم **OpenClaw** (بوابة openclaw، مساعد متعدد القنوات مستضاف ذاتيًا) لكل من **فرض الخطاف المباشر** (`--cli openclaw`، نطاق المستخدم) و**تدقيق** لا يتصل بالإنترنت لجلسات JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). يستخدم الفرض خطافات **المكون الإضافي داخل العملية** الخاصة بـ OpenClaw (مكون إضافي مرسل `openclaw-plugin/` ينفذ failproofai بشكل غير متزامن — خطافاته الداخلية القائمة على الملفات هي للمراقبة فقط ولا يمكنها الحظر): `before_tool_call` يحظر أداة، و `before_agent_finalize` هو بوابة نهاية دور حقيقية، لذا تفرض العناصر المدمجة `require-*-before-stop`.
>
> يتم دعم **Factory Droid** (`droid`) لكل من **فرض الخطاف المباشر** (`--cli factory`، نطاق المستخدم والمشروع) و**تدقيق** لا يتصل بالإنترنت لجلسات JSONL المخزنة على القرص. يحظر droid استدعاءات الأدوات من **رمز الخروج 2** (وليس قرار JSON) ويحترم `{decision:"block"}` فقط في حدث النهاية `Stop` — يصدر failproofai الشكل الصحيح لكل حدث تلقائيًا.
>
> يتم دعم **Devin CLI** (`devin`، Cognition) لكل من **فرض الخطاف المباشر** (`--cli devin`، نطاق المستخدم والمشروع) و**تدقيق** لا يتصل بالإنترنت لجلسات SQLite (`~/.local/share/devin/cli/sessions.db`). Devin هو **استنساخ Claude نقي** — نفس أسماء الأحداث، نفس حمولة snake_case، نفس إعداد `hooks` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — الحظر عبر JSON `{decision:"block"}` في كل حدث.
>
> يتم دعم **Antigravity CLI** (`agy`) لكل من **فرض الخطاف المباشر** (`--cli antigravity`، نطاق المستخدم والمشروع) و**تدقيق** لا يتصل بالإنترنت لجلسات JSONL العادية (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity لديها **عقد خاص بها** (وليس استنساخ Claude): مخطط `hooks.json` بـ **خطاف مسمى** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`)، حمولة stdin بـ camelCase التي يقوم failproofai بتطبيعها، وأشكال استجابة خاصة بها — `{decision:"deny"}` لحظر أداة، `{decision:"continue"}` لفرض دور آخر في `Stop`، `{injectSteps}` لحقن تذكير قبل تشغيل النموذج.
>
> يتم دعم **Goose** (كنية goose، Block) لكل من **فرض الخطاف المباشر** (`--cli goose`، نطاق المستخدم والمشروع) و**تدقيق** لا يتصل بالإنترنت لجلسات SQLite (`~/.local/share/goose/sessions/sessions.db`). يستخدم الفرض نظام **الخطافات** الخاص بـ Goose (مواصفة **Open Plugins** متعددة الوكلاء) — يقوم المثبّت بإسقاط دليل مكون إضافي في `~/.agents/plugins/failproofai/` ويكتشفه Goose تلقائيًا. الحظر هو JSON `{"decision":"block"}` في حدث `PreToolUse` (الذي يتم تشغيله لأداة shell والعملاء الفرعيين المفوضة)، تم التحقق منه مباشرة مقابل goose v1.43.0؛ Goose ليس لديه حدث نهاية `Stop`، لذا فإن العناصر المدمجة `require-*-before-stop` لا تنطبق (كما هو الحال مع Hermes).

---

## التثبيت

```sh
npm install -g failproofai
failproofai policies --install   # أو فقط شغّل `failproofai` واقبل موجه التشغيل الأول
failproofai
```

30 سياسة مدمجة تُفعّل فورًا. لوحة التحكم على `localhost:8020`. عطّل موجه التشغيل الأول مع `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما يوقفه

| السياسة | ما يحظره |
|---|---|
| `block-push-master` | الدفع المباشر إلى `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | الالتزامات والدمج والإعادة على `main` / `master` |
| `block-rm-rf` | حذف الملفات بشكل متكرر |
| `sanitize-api-keys` | تسريب مفاتيح API إلى سياق الوكيل |

→ [جميع السياسات المدمجة الـ 30](https://docs.befailproof.ai/built-in-policies)

---

## سياساتك الخاصة

ألقِ ملفًا في `.failproofai/policies/` — يتم تحميله تلقائيًا، لا توجد أعلام مطلوبة.
قم بإرساله والفريق بأكمله سيحصل عليه في السحب التالي.

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
| `allow()` | اسمح بالعملية |
| `deny(message)` | حظرها — تُرسل الرسالة مرة أخرى إلى الوكيل |
| `instruct(message)` | اسمح بها، لكن أضف سياقًا إلى الموجه التالي للوكيل |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/custom-policies)

---

## رؤية الجلسة

يتم تسجيل كل استدعاء أداة يقوم به وكيلك محليًا. تظهر لوحة التحكم ما الذي تم تشغيله،
ما تم حظره، وما قالته السياسة للوكيل — لذلك لن تتخمن
عند حدوث خطأ ما. → [دليل لوحة التحكم](https://docs.befailproof.ai/dashboard)

---

## التوثيق

| | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/getting-started) | التثبيت والخطوات الأولى |
| [السياسات المدمجة](https://docs.befailproof.ai/built-in-policies) | جميع السياسات الـ 30 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/custom-policies) | اكتب سياساتك الخاصة |
| [التكوين](https://docs.befailproof.ai/configuration) | نطاقات التكوين وقواعد الدمج |
| [لوحة التحكم](https://docs.befailproof.ai/dashboard) | مراقب الجلسة وأنشطة السياسة |
| [الهندسة المعمارية](https://docs.befailproof.ai/architecture) | كيفية عمل نظام الخطاف |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة بيع failproofai نفسه بشكل تجاري تتطلب اتفاقية منفصلة. اطّلع على [LICENSE](./LICENSE) للحصول على النص الكامل.

---

## المساهمة

اطّلع على [CONTRIBUTING.md](./CONTRIBUTING.md). السياسات الجديدة والحالات الخاصة والترجمات كلها مرحب بها.

> **أنشئ قبل أن تبدأ.** شغّل `bun install && bun run build` أولاً. يقوم هذا المستودع
> بتشغيل خطافات failproofai الخاصة به على نفسه، وهي تحل استيراد `failproofai` مقابل
> حزمة `dist/` المترجمة — بدون build ستصطدم برسائل خطأ خطاف `Cannot find package 'failproofai'`.
> أعد البناء بعد تغيير `src/`. اطّلع على
> [بناء قبل أن تعمل خطافات dev داخل المستودع](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

بُني بواسطة [Nivedit Jain](https://github.com/NiveditJain) و [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>