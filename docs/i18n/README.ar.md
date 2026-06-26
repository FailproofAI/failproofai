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

**حل فشل وقت التشغيل لعوامل الترميز.**
تندمج مع Claude Code و Codex. تقبض على الحلقات والإجراءات الخطرة ويسريب الأسرار
قبل أن تصبح حوادث. بدون تأخير. يعمل محليًا.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

---

## واجهات سطر الأوامر المدعومة للعوامل

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> تثبيت الخطافات لواحد أو أي مزيج: `failproofai policies --install --cli opencode pi gemini` (أو `--cli claude codex copilot cursor opencode pi gemini`). حذف `--cli` للكشف التلقائي عن واجهات سطر الأوامر المثبتة والمطالبة.

---

## التثبيت

```sh
npm install -g failproofai
failproofai policies --install   # أو فقط قم بتشغيل `failproofai` وقبول سؤال التشغيل الأول
failproofai
```

30 سياسة مدمجة تنشط فورًا. لوحة معلومات في `localhost:8020`. تعطيل سؤال التشغيل الأول باستخدام `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## ما الذي يوقفه

| السياسة | ما يتم حجبه |
|---|---|
| `block-push-master` | الدفع المباشر إلى `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | الالتزامات والدمج وإعادة الأساس على `main` / `master` |
| `block-rm-rf` | حذف الملفات العودي |
| `sanitize-api-keys` | تسريب مفاتيح API إلى سياق العامل |

→ [جميع 30 سياسة مدمجة](https://docs.befailproof.ai/built-in-policies)

---

## سياساتك الخاصة

أسقط ملفًا في `.failproofai/policies/` - يتم تحميله تلقائيًا، بدون حاجة إلى أعلام.
التزم به وسيحصل الفريق بأكمله عليه في السحب التالي.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("عمليات الكتابة إلى مسارات الإنتاج محظورة.");
    return allow();
  },
});
```

ثلاثة قرارات متاحة لكل سياسة:

| القرار | التأثير |
|---|---|
| `allow()` | السماح بالعملية |
| `deny(message)` | حظرها - الرسالة تعود إلى العامل |
| `instruct(message)` | دعها تمر، لكن أضف سياقًا إلى موجه العامل التالي |

→ [دليل السياسات المخصصة](https://docs.befailproof.ai/custom-policies)

---

## رؤية الجلسة

كل استدعاء أداة يقوم به العامل يتم تسجيله محليًا. لوحة المعلومات توضح ما يعمل،
وما تم حجبه، وما قالته السياسة للعامل - لذا أنت لا تخمن
عندما يحدث خطأ ما. → [دليل لوحة المعلومات](https://docs.befailproof.ai/dashboard)

---

## التوثيق

| | |
|---|---|
| [البدء السريع](https://docs.befailproof.ai/getting-started) | التثبيت والخطوات الأولى |
| [السياسات المدمجة](https://docs.befailproof.ai/built-in-policies) | جميع 30 سياسة مع المعاملات |
| [السياسات المخصصة](https://docs.befailproof.ai/custom-policies) | اكتب الخاصة بك |
| [التكوين](https://docs.befailproof.ai/configuration) | نطاقات التكوين وقواعد الدمج |
| [لوحة المعلومات](https://docs.befailproof.ai/dashboard) | مراقب الجلسة ونشاط السياسة |
| [العمارة](https://docs.befailproof.ai/architecture) | كيفية عمل نظام الخطافات |

---

## الترخيص

MIT مع [Commons Clause](https://commonsclause.com/) - مجاني للاستخدام الداخلي والشخصي؛ إعادة بيع failproofai نفسه تجاريًا يتطلب اتفاقية منفصلة. انظر [LICENSE](./LICENSE) للنص الكامل.

---

## المساهمة

انظر [CONTRIBUTING.md](./CONTRIBUTING.md). السياسات الجديدة والحالات الحدية والترجمات كلها مرحب بها.

> **بناء قبل أن تبدأ.** قم بتشغيل `bun install && bun run build` أولاً. يقوم هذا المستودع بتشغيل
> خطافات failproofai الخاصة به على نفسه، وتحل فهرس failproofai ضد
> حزمة `dist/` المترجمة - بدون بناء ستصطدم بـ `Cannot find package 'failproofai'`
> أخطاء الخطافات. أعد البناء بعد تغيير `src/`. انظر
> [بناء قبل أن تعمل خطافات dev في المستودع](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

تم بناؤه بواسطة [Nivedit Jain](https://github.com/NiveditJain) و [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>