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

**حل فشل وقت التشغيل لوكلاء البرمجة.
يتدخل في Claude Code و Codex. يلتقط الحلقات والإجراءات الخطيرة وتسرب الأسرار
قبل أن تصبح حوادث. بدون زمن انتظار. يعمل محليًا.**

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## واجهات سطر الأوامر المدعومة للوكلاء

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> ثبّت الخطاطيف لواحد أو أي مجموعة: `failproofai policies --install --cli opencode pi` (أو `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). تجاوز `--cli` للكشف التلقائي عن واجهات البرمجة المثبتة والمحادثة.
>
> **Hermes** (hermes-agent، بوابة Slack/Telegram) مدعومة لفرض الخطاطيف الحية (`--cli hermes` — تثبيت واحد يعترض استدعاءات الأدوات من كل منصة ووكيل فرعي) وإعادة تشغيل التدقيق بلا اتصال لجلسات البوابة من `~/.hermes/state.db`.
>
> **OpenClaw** (بوابة openclaw، مساعد متعدد القنوات يستضيف ذاتيًا) مدعومة لفرض الخطاطيف الحية (`--cli openclaw`، نطاق المستخدم) وإعادة تشغيل التدقيق بلا اتصال لجلسات JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). يستخدم الفرض خطاطيف المكون الإضافي داخل العملية من OpenClaw (مكون إضافي شامل `openclaw-plugin/` يولد failproofai بشكل غير متزامن — خطاطيفها الداخلية القائمة على الملفات تراقب فقط ولا يمكنها حظر): `before_tool_call` يحظر أداة، و `before_agent_finalize` هي بوابة حقيقية في نهاية الدور، لذا تفرض builtins `require-*-before-stop`.
>
> **Factory Droid** (`droid`) مدعومة لفرض الخطاطيف الحية (`--cli factory`، نطاق المستخدم والمشروع) وإعادة تشغيل التدقيق بلا اتصال لجلسات JSONL على القرص. يحظر droid استدعاءات الأدوات عند رمز الخروج من الخطاف **2** (ليس قرار JSON) ويشرّف `{decision:"block"}` فقط على حدث نهاية الدور `Stop` — failproofai ينبعث الشكل الصحيح لكل حدث تلقائيًا.
>
> **Devin CLI** (`devin`، Cognition) مدعومة لفرض الخطاطيف الحية (`--cli devin`، نطاق المستخدم والمشروع) وإعادة تشغيل التدقيق بلا اتصال لجلسات SQLite (`~/.local/share/devin/cli/sessions.db`). Devin هو **نسخة مطابقة خالصة لـ Claude** — نفس أسماء الأحداث، نفس حمولة snake_case، نفس تكوين `hooks`-wrapper (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — الحظر عبر JSON `{decision:"block"}` على كل حدث.
>
> **Antigravity CLI** (`agy`) مدعومة لفرض الخطاطيف الحية (`--cli antigravity`، نطاق المستخدم والمشروع) وإعادة تشغيل التدقيق بلا اتصال لجلسات JSONL العادية (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity لديها عقدها **الخاص** (ليست نسخة مطابقة لـ Claude): **خطاطيف مسماة** بـ `hooks.json` schema (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`)، حمولة stdin بـ camelCase تعيد failproofai تطبيعها، وأشكال استجابة خاصة بها — `{decision:"deny"}` لحظر أداة، `{decision:"continue"}` لفرض دور آخر في `Stop`، `{injectSteps}` لحقن تذكير قبل تشغيل النموذج.
>
> **Goose** (codename goose، Block) مدعومة لفرض الخطاطيف الحية (`--cli goose`، نطاق المستخدم والمشروع) وإعادة تشغيل التدقيق بلا اتصال لجلسات SQLite (`~/.local/share/goose/sessions/sessions.db`). يستخدم الفرض نظام **خطاطيف** Goose (مواصفة **Open Plugins** عبر الوكلاء) — يقوم المثبت فقط بإسقاط مجلد مكون إضافي على `~/.agents/plugins/failproofai/` ويكتشف Goose تلقائيًا. الحظر هو JSON `{"decision":"block"}` على حدث `PreToolUse` (الذي ينطلق لأداة shell وداخل الوكلاء الفرعيين المفوضين)، يتم التحقق منه مباشرة مقابل goose v1.43.0؛ Goose ليس لديه حدث نهاية دور `Stop`، لذا فإن builtins `require-*-before-stop` لا تنطبق (كما هو الحال مع Hermes).

---

## التثبيت

```sh
npm install -g failproofai
failproofai policies --install   # أو فقط قم بتشغيل `failproofai` واقبل مطالبة التشغيل الأول
failproofai
```

30 سياسة مدمجة تُفعّل فورًا. لوحة القيادة على `localhost:8020`. تعطيل مطالبة التشغيل الأول باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما يوقفه

| السياسة | ما يحظره |
|---|---|
| `block-push-master` | الدفع المباشر إلى `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | الالتزامات والدمج والإعادة الأساسية على `main` / `master` |
| `block-rm-rf` | حذف الملفات بشكل متكرر |
| `sanitize-api-keys` | مفاتيح API تتسرب إلى سياق الوكيل |

→ [جميع 30 السياسات المدمجة](https://docs.befailproof.ai/built-in-policies)

---

## سياساتك الخاصة

أسقط ملفًا إلى `.failproofai/policies/` — يتم تحميله تلقائيًا، بدون الحاجة إلى أي رايات.
التزم بها وسيحصل الفريق بأكمله عليها في السحب التالي.

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
| `deny(message)` | حظرها — الرسالة تعود إلى الوكيل |
| `instruct(message)` | السماح بها، لكن أضف سياقًا إلى الموجه التالي للوكيل |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/custom-policies)

---

## رؤية الجلسة

كل استدعاء أداة يقوم به وكيلك يتم تسجيله محليًا. تعرض لوحة القيادة ما تم تشغيله،
ما تم حظره، وما أخبرت السياسة الوكيل به — حتى لا تخمن
عندما يسير شيء ما بشكل خاطئ. → [دليل لوحة القيادة](https://docs.befailproof.ai/dashboard)

---

## التوثيق

| | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/getting-started) | التثبيت والخطوات الأولى |
| [السياسات المدمجة](https://docs.befailproof.ai/built-in-policies) | جميع 30 السياسات مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/custom-policies) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/configuration) | نطاقات التكوين وقواعد الدمج |
| [لوحة القيادة](https://docs.befailproof.ai/dashboard) | مراقب الجلسة وأنشطة السياسة |
| [العمارة](https://docs.befailproof.ai/architecture) | كيفية عمل نظام الخطاطيف |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) — مجاني للاستخدام الداخلي والشخصي؛ يتطلب إعادة البيع التجاري لـ failproofai نفسه اتفاقًا منفصلاً. راجع [LICENSE](./LICENSE) للنص الكامل.

---

## المساهمة

راجع [CONTRIBUTING.md](./CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها موضع ترحيب.

> **بناء قبل البدء.** قم بتشغيل `bun install && bun run build` أولاً. يقوم هذا المستودع بتشغيل خطاطيف failproofai الخاصة به على نفسه، ويحلون استيراد `failproofai` مقابل حزمة `dist/` المترجمة — بدون بناء ستواجه أخطاء خطاطيف `Cannot find package 'failproofai'`. أعد البناء بعد تغيير `src/`. راجع
> [بناء قبل أن تعمل خطاطيف dev داخل المستودع](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

مصنوع بواسطة [Nivedit Jain](https://github.com/NiveditJain) و [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>