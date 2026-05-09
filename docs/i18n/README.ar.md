> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | **🇸🇦 العربية** | [🇮🇱 עברית](README.he.md)

---
<div dir="rtl">


```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**الترجمات**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

الطريقة الأسهل لإدارة السياسات التي تحافظ على موثوقية وكلائك الذكيين والعاملين بشكل مستقل - لـ **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(تجريبي)_, **Cursor Agent** _(تجريبي)_, **OpenCode** _(تجريبي)_, **Pi** _(تجريبي)_, **Gemini CLI** _(تجريبي)_ و **Agents SDK**.

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

## واجهات برمجة التطبيقات للوكلاء المدعومة

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

> قم بتثبيت الخطافات لواحد أو أي مجموعة: `failproofai policies --install --cli opencode pi gemini` (أو `--cli claude codex copilot cursor opencode pi gemini`). تجاهل `--cli` للكشف التلقائي عن واجهات برمجة التطبيقات المثبتة والمطالبة بها. **دعم GitHub Copilot CLI و Cursor Agent و OpenCode و Pi و Gemini CLI قيد التطوير - الاختبار جار.**

- **39 سياسة مدمجة** - اكتشف أنماط فشل الوكيل الشائعة من الصندوق. احجب الأوامر المدمرة، ومنع تسرب الأسرار، واحفظ الوكلاء داخل حدود المشروع، واكتشف الحلقات، والمزيد.
- **السياسات المخصصة** - اكتب قواعد موثوقيتك الخاصة في JavaScript. استخدم واجهة `allow`/`deny`/`instruct` لفرض الاتفاقيات ومنع الانجراف وبوابة العمليات أو التكامل مع الأنظمة الخارجية.
- **تكوين سهل** - اضبط أي سياسة بدون كتابة أكواد. عيّن قوائم السماح والفروع المحمية والعتبات لكل مشروع أو عام. يتم دمج تكوين النطاق الثلاثي تلقائياً.
- **مراقب الوكيل** - انظر ماذا فعل وكلاؤك بينما كنت بعيداً. استعرض الجلسات وفتش كل استدعاء أداة وراجع بالضبط حيث تم تفعيل السياسات.

كل شيء يعمل محلياً - لا تترك أي بيانات آلتك.

---

## المتطلبات

- Node.js >= 20.9.0
- Bun >= 1.3.0 (اختياري - مطلوب فقط للتطوير / البناء من المصدر)

---

## التثبيت

```bash
npm install -g failproofai
# أو
bun add -g failproofai
```

---

## البدء السريع

### 1. تفعيل السياسات عام

```bash
failproofai policies --install
```

يكتب مدخلات الخطاف في `~/.claude/settings.json`. سيستدعي Claude Code الآن failproofai قبل وبعد كل استدعاء أداة.

### 2. تشغيل لوحة التحكم

```bash
failproofai
```

يفتح `http://localhost:8020` - استعرض الجلسات وفتش السجلات وأدر السياسات.

### 3. تحقق من ما هو نشط

```bash
failproofai policies
```

---

## تثبيت السياسة

### النطاقات

| النطاق | الأمر | حيث يكتب |
|-------|---------|-----------------|
| عام (الافتراضي) | `failproofai policies --install` | `~/.claude/settings.json` |
| المشروع | `failproofai policies --install --scope project` | `.claude/settings.json` |
| محلي | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### تثبيت سياسات محددة

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### إزالة السياسات

```bash
failproofai policies --uninstall
# أو لنطاق معين:
failproofai policies --uninstall --scope project
```

---

## الإعدادات

تعيش تكوين السياسة في `~/.failproofai/policies-config.json` (عام) أو `.failproofai/policies-config.json` في مشروعك (لكل مشروع).

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "استخدم apt-get مباشرة بدون sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "حاول إنشاء فرع جديد بدلاً من ذلك."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "مفتاح API لـ MyCo" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**يتم دمج نطاقات التكوين الثلاثة** تلقائياً (مشروع → محلي → عام). انظر [docs/configuration.mdx](docs/configuration.mdx) لقواعد الدمج الكاملة.

---

## السياسات المدمجة

| السياسة | الوصف | قابلة للتكوين |
|--------|-------------|:---:|
| `block-sudo` | منع الوكلاء من تشغيل أوامر النظام المميزة | `allowPatterns` |
| `block-rm-rf` | منع حذف الملفات العودية العرضية | `allowPaths` |
| `block-curl-pipe-sh` | منع الوكلاء من توجيه النصوص غير الموثوقة إلى shell | |
| `block-failproofai-commands` | منع الإلغاء الذاتي | |
| `sanitize-jwt` | إيقاف تسرب رموز JWT إلى سياق الوكيل | |
| `sanitize-api-keys` | إيقاف تسرب مفاتيح API إلى سياق الوكيل | `additionalPatterns` |
| `sanitize-connection-strings` | إيقاف تسرب بيانات اعتماد قاعدة البيانات إلى سياق الوكيل | |
| `sanitize-private-key-content` | حذف كتل مفاتيح PEM الخاصة من الإخراج | |
| `sanitize-bearer-tokens` | حذف رموز التفويض Bearer من الإخراج | |
| `block-env-files` | منع الوكلاء من قراءة ملفات .env | |
| `protect-env-vars` | منع الوكلاء من طباعة متغيرات البيئة | |
| `block-read-outside-cwd` | احفظ الوكلاء داخل حدود المشروع | `allowPaths` |
| `block-secrets-write` | منع الكتابات إلى ملفات المفاتيح الخاصة والشهادات | `additionalPatterns` |
| `block-push-master` | منع الدفع العرضي إلى main/master | `protectedBranches` |
| `block-work-on-main` | اجعل الوكلاء بعيداً عن الفروع المحمية | `protectedBranches` |
| `block-force-push` | منع `git push --force` | |
| `warn-git-amend` | تذكير الوكلاء قبل تعديل الالتزام | |
| `warn-git-stash-drop` | تذكير الوكلاء قبل حذف المخزن المؤقت | |
| `warn-all-files-staged` | اكتشف `git add -A` العرضي | |
| `warn-destructive-sql` | اكتشف DROP/DELETE SQL قبل التنفيذ | |
| `warn-schema-alteration` | اكتشف ALTER TABLE قبل التنفيذ | |
| `warn-large-file-write` | اكتشف كتابات الملفات الكبيرة بشكل غير متوقع | `thresholdKb` |
| `warn-package-publish` | اكتشف `npm publish` العرضي | |
| `warn-background-process` | اكتشف إطلاقات العمليات الخلفية غير المقصودة | |
| `warn-global-package-install` | اكتشف عمليات تثبيت الحزم العامة غير المقصودة | |
| ...وغيرها | | |

التفاصيل الكاملة للسياسة والمرجع الثابت: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## السياسات المخصصة

اكتب سياساتك الخاصة لإبقاء الوكلاء موثوقين وركزوا على المهمة:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "حجب الكتابة إلى المسارات التي تحتوي على 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("الكتابة إلى مسارات الإنتاج محظورة");
    return allow();
  },
});
```

قم بالتثبيت باستخدام:

```bash
failproofai policies --install --custom ./my-policies.js
```

### مساعدات القرار

| الدالة | التأثير |
|----------|--------|
| `allow()` | السماح بالعملية |
| `allow(message)` | السماح وإرسال سياق إعلامي إلى Claude |
| `deny(message)` | حجب العملية؛ الرسالة معروضة لـ Claude |
| `instruct(message)` | إضافة سياق إلى موجه Claude؛ لا تحجب |

### كائن السياق (`ctx`)

| الحقل | النوع | الوصف |
|-------|------|-------------|
| `eventType` | `string` | `PreToolUse`, `PostToolUse`, `Notification`, `Stop` |
| `toolName` | `string` | الأداة التي يتم استدعاؤها (`Bash`, `Write`, `Read`, …) |
| `toolInput` | `object` | معاملات إدخال الأداة |
| `payload` | `object` | حمولة الحدث الخام الكاملة |
| `session.cwd` | `string` | دليل العمل لجلسة Claude Code |
| `session.sessionId` | `string` | معرّف الجلسة |
| `session.transcriptPath` | `string` | المسار إلى ملف نسخ جلسة الجلسة |

تدعم الخطافات المخصصة الاستيراد المحلي المتكرر وasync/await والوصول إلى `process.env`. الأخطاء تفشل مفتوحة (مسجلة في `~/.failproofai/hook.log`، السياسات المدمجة تستمر). انظر [docs/custom-hooks.mdx](docs/custom-hooks.mdx) للدليل الكامل.

### السياسات القائمة على الاتفاقيات

أسقط ملفات `*policies.{js,mjs,ts}` في `.failproofai/policies/` وسيتم تحميلها تلقائياً - لا حاجة لأعلام أو تغييرات التكوين. التزم بالمجلد في git وكل عضو في الفريق يحصل على معايير الجودة نفسها تلقائياً.

```text
# مستوى المشروع - ملتزم بـ git، مشاركة مع الفريق
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# مستوى المستخدم - شخصي، ينطبق على جميع المشاريع
~/.failproofai/policies/my-policies.mjs
```

يتم تحميل كلا المستويين (اتحاد). يتم تحميل الملفات أبجدياً داخل كل دليل. استخدم البادئة `01-`, `02-`, إلخ للتحكم في الترتيب. كلما اكتشف فريقك أنماط فشل جديدة، أضف سياسة واضغط - يحصل الجميع على التحديث في عملية السحب التالية. انظر [examples/convention-policies/](examples/convention-policies/) للأمثلة الجاهزة للاستخدام.

---

## قياس الاستخدام

يجمع Failproof AI قياس الاستخدام المجهول عبر PostHog لفهم استخدام الميزات. لا يتم أبداً إرسال محتوى الجلسة أو أسماء الملفات أو مدخلات الأداة أو المعلومات الشخصية.

عطله:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## التوثيق

| الدليل | الوصف |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | التثبيت والخطوات الأولى |
| [Built-in Policies](docs/built-in-policies.mdx) | جميع 39 سياسة مدمجة مع المعاملات |
| [Custom Policies](docs/custom-policies.mdx) | اكتب سياساتك الخاصة |
| [Configuration](docs/configuration.mdx) | تنسيق ملف التكوين ودمج النطاق |
| [Dashboard](docs/dashboard.mdx) | مراقبة الجلسات ومراجعة نشاط السياسة |
| [Architecture](docs/architecture.mdx) | كيفية عمل نظام الخطاف |
| [Testing](docs/testing.mdx) | تشغيل الاختبارات وكتابة اختبارات جديدة |

### تشغيل التوثيق محلياً

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

يفتح موقع Mintlify للتوثيق في `http://localhost:3000`. الحاوية تراقب التغييرات إذا قمت بتثبيت دليل التوثيق:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## ملاحظة لمساهمي failproofai

يستخدم `.claude/settings.json` في هذا الريبو `bun ./bin/failproofai.mjs --hook <EventType>` بدلاً من أمر `npx -y failproofai` القياسي. هذا لأن تشغيل `npx -y failproofai` داخل مشروع failproofai نفسه يخلق تضاربًا متبادل المرجعية.

بالنسبة لجميع المستودعات الأخرى، الطريقة الموصى بها هي `npx -y failproofai`، مثبتة عبر:

```bash
failproofai policies --install --scope project
```

## المساهمة

انظر [CONTRIBUTING.md](CONTRIBUTING.md).

---

## الترخيص

انظر [LICENSE](LICENSE).

---

تم بناؤها والحفاظ عليها بواسطة **ExosphereHost: مختبر أبحاث الموثوقية لوكلائك**. نحن نساعد الشركات والشركات الناشئة على تحسين موثوقية وكلائهم الذكيين من خلال وكلائنا والبرمجيات والخبرة. تعرف على المزيد في [exosphere.host](https://exosphere.host).


</div>