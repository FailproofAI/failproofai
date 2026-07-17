> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | **🇸🇦 العربية** | [🇮🇱 עברית](README.he.md)

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**الترجمات:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**حل أعطال وقت التشغيل لعوامل الترميز.**
تتصل بـ Claude Code و Codex. تكتشف الحلقات والإجراءات الخطرة وتسرب الأسرار
قبل أن تصبح حوادث. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## واجهات سطر أوامر العوامل المدعومة

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

> تثبيت الخطافات لواحد أو أي مجموعة: `failproofai policies --install --cli opencode pi` (أو `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). حذف `--cli` للكشف التلقائي عن واجهات سطر الأوامر المثبتة والموجهة.
>
> **Hermes** (hermes-agent، بوابة Slack/Telegram) مدعوم لكل من **فرض الخطاف المباشر** (`--cli hermes` — يعترض تثبيت واحد استدعاءات الأدوات من كل منصة ووكيل فرعي) و **التدقيق** دون اتصال لجلسات البوابة الخاصة به من ملف `~/.hermes/state.db` الوحيد.
>
> **OpenClaw** (بوابة openclaw، مساعد متعدد القنوات ذاتي الاستضافة) مدعوم لكل من **فرض الخطاف المباشر** (`--cli openclaw`، نطاق المستخدم) و **التدقيق** دون اتصال لجلسات JSONL الخاصة به (`~/.openclaw/agents/<id>/sessions/*.jsonl`). يستخدم الفرض **خطافات البرنامج المساعد داخل العملية** الخاصة بـ OpenClaw (ملف `openclaw-plugin/` مرسل يستدعي failproofai بشكل غير متزامن — خطافاتها الداخلية القائمة على الملفات للملاحظة فقط ولا يمكنها حجب): `before_tool_call` يحجب أداة، و `before_agent_finalize` بوابة حقيقية لنهاية الدور، لذلك تفرض المدمجات `require-*-before-stop`.
>
> **Factory Droid** (`droid`) مدعوم لكل من **فرض الخطاف المباشر** (`--cli factory`، نطاق المستخدم والمشروع) و **التدقيق** دون اتصال لجلسات JSONL الخاصة به على القرص. يحجب droid استدعاءات الأدوات من خطاف **كود الخروج 2** (ليس قرارًا JSON) ويحترم `{decision:"block"}` فقط على حدث نهاية الدور `Stop` — ينبعث failproofai من الشكل الصحيح لكل حدث تلقائيًا.
>
> **Devin CLI** (`devin`, Cognition) مدعوم لكل من **فرض الخطاف المباشر** (`--cli devin`، نطاق المستخدم والمشروع) و **التدقيق** دون اتصال لجلسات SQLite الخاصة به (`~/.local/share/devin/cli/sessions.db`). Devin هو **نسخة نقية من Claude** — نفس أسماء الأحداث، نفس حمل snake_case، نفس إعدادات `hooks`-wrapper (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — الحجب عبر `{decision:"block"}` JSON على كل حدث.
>
> **Antigravity CLI** (`agy`) مدعوم لكل من **فرض الخطاف المباشر** (`--cli antigravity`، نطاق المستخدم والمشروع) و **التدقيق** دون اتصال لجلسات JSONL البسيطة الخاصة به (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). لدى Antigravity **عقده الخاص** (ليس نسخة من Claude): مخطط خطاف **مسمى** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`)، حمل stdin بصيغة camelCase ينسيّره failproofai، وأشكال الاستجابة الخاصة به — `{decision:"deny"}` لحجب أداة، `{decision:"continue"}` لفرض دور آخر في `Stop`، `{injectSteps}` لحقن تذكير قبل تشغيل النموذج.
>
> **Goose** (codename goose، Block) مدعوم لكل من **فرض الخطاف المباشر** (`--cli goose`، نطاق المستخدم والمشروع) و **التدقيق** دون اتصال لجلسات SQLite الخاصة به (`~/.local/share/goose/sessions/sessions.db`). يستخدم الفرض **نظام الخطافات** الخاص بـ Goose (مواصفة **البرامج المساعدة المفتوحة** بين الوكلاء) — يقوم المثبت بإسقاط مجلد البرنامج المساعد في `~/.agents/plugins/failproofai/` و Goose تكتشفه تلقائيًا. الحجب هو `{"decision":"block"}` JSON على حدث `PreToolUse` (الذي يطلق لأداة الشل وداخل الوكلاء الفرعيين المفوضين)، تم التحقق منه مباشرة ضد goose v1.43.0؛ Goose لا تحتوي على حدث نهاية دور `Stop`، لذا المدمجات `require-*-before-stop` لا تنطبق (كما هو الحال مع Hermes).

---

## التثبيت

```sh
npm install -g failproofai
failproofai policies --install   # أو قم بتشغيل `failproofai` فقط وقبل الموجه الأولى
failproofai
```

يتم تفعيل 30 سياسة مدمجة فورًا. لوحة التحكم على `localhost:8020`. قم بتعطيل الموجه الأولى باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما يحجبه

| السياسة | ما تحجبه |
|---|---|
| `block-push-master` | الدفع المباشر إلى `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | التزام وتجميع وإعادة تأسيس على `main` / `master` |
| `block-rm-rf` | حذف الملفات بشكل متكرر |
| `sanitize-api-keys` | تسريب مفاتيح API إلى سياق الوكيل |

→ [جميع السياسات المدمجة الـ 30](https://docs.befailproof.ai/built-in-policies)

---

## سياساتك الخاصة

اسحب ملفًا إلى `.failproofai/policies/` — يتم تحميله تلقائيًا، لا توجد علامات مطلوبة.
قم بالتزام به وستحصل الفريق بالكامل عليه في الجلب التالي.

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
| `deny(message)` | حجبها — تذهب الرسالة مرة أخرى إلى الوكيل |
| `instruct(message)` | السماح بها، لكن أضف سياقًا إلى الموجه التالي للوكيل |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/custom-policies)

---

## رؤية الجلسة

يتم تسجيل كل استدعاء أداة يجريه وكيلك محليًا. تظهر لوحة التحكم ما تم تشغيله،
ما تم حجبه، وما قالته السياسة للوكيل — لذا أنت لا تخمن
عندما يحدث خطأ ما. → [دليل لوحة التحكم](https://docs.befailproof.ai/dashboard)

---

## التوثيق

| | |
|---|---|
| [البدء](https://docs.befailproof.ai/getting-started) | التثبيت والخطوات الأولى |
| [السياسات المدمجة](https://docs.befailproof.ai/built-in-policies) | جميع السياسات الـ 30 مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/custom-policies) | اكتب الخاص بك |
| [الإعدادات](https://docs.befailproof.ai/configuration) | نطاقات الإعدادات وقواعد الدمج |
| [لوحة التحكم](https://docs.befailproof.ai/dashboard) | مراقب الجلسة ونشاط السياسة |
| [العمارة](https://docs.befailproof.ai/architecture) | كيفية عمل نظام الخطافات |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ إعادة البيع التجاري لـ failproofai نفسه يتطلب اتفاقية منفصلة. انظر [LICENSE](./LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](./CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها موضع ترحيب.

> **قم بالبناء قبل البدء.** قم بتشغيل `bun install && bun run build` أولاً. يقوم هذا المستودع بتشغيل خطافات failproofai الخاصة به على نفسه، ويحل استيراد `failproofai` مقابل الحزمة `dist/` المترجمة — بدون بناء، ستضرب أخطاء خطاف `Cannot find package 'failproofai'`. أعد البناء بعد تغيير `src/`. انظر
> [البناء قبل أن تعمل خطافات الـ dev داخل المستودع](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

تم البناء بواسطة [Nivedit Jain](https://github.com/NiveditJain) و [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>