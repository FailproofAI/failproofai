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

الطريقة الأسهل لإدارة السياسات التي تحافظ على موثوقية وكلاء الذكاء الاصطناعي والبقاء على المسار الصحيح والتشغيل المستقل - لـ **Claude Code**، **OpenAI Codex**، **GitHub Copilot CLI** _(بيتا)_، **Cursor Agent** _(بيتا)_، **OpenCode** _(بيتا)_، **Pi** _(بيتا)_، **Gemini CLI** _(بيتا)_ و **Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI في العمل" width="800" />
</p>

## واجهات سطر الأوامر المدعومة للوكلاء

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

> تثبيت الخطافات لواحد أو أي مزيج: `failproofai policies --install --cli opencode pi gemini` (أو `--cli claude codex copilot cursor opencode pi gemini`). احذف `--cli` للكشف التلقائي عن واجهات سطر الأوامر المثبتة والمطالبة. **دعم GitHub Copilot CLI و Cursor Agent و OpenCode و Pi و Gemini CLI في مرحلة بيتا — الاختبار جارٍ.**

- **39 سياسة مدمجة** - اكتشف أنماط فشل الوكيل الشائعة خارج الصندوق. احجب الأوامر المدمرة، منع تسرب الأسرار، احتفظ بالوكلاء داخل حدود المشروع، اكتشف الحلقات، والمزيد.
- **سياسات مخصصة** - اكتب قواعد الموثوقية الخاصة بك في JavaScript. استخدم واجهة برمجية `allow`/`deny`/`instruct` لفرض الاتفاقيات، منع الانجراف، تقييد العمليات، أو التكامل مع الأنظمة الخارجية.
- **إعدادات سهلة** - اضبط أي سياسة دون كتابة أكواد. عيّن قوائم السماح والفروع المحمية والحدود القصوى لكل مشروع أو عالمياً. يتم دمج إعدادات ثلاث نطاقات تلقائياً.
- **مراقب الوكيل** - اطلع على ما فعله وكلاؤك أثناء غيابك. تصفح الجلسات، فتش كل استدعاء أداة، وراجع بالضبط حيث تم تشغيل السياسات.

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

### 1. تفعيل السياسات عالمياً

```bash
failproofai policies --install
```

يكتب إدخالات الخطاف في `~/.claude/settings.json`. الآن سيستدعي Claude Code failproofai قبل وبعد كل استدعاء أداة.

### 2. تشغيل لوحة التحكم

```bash
failproofai
```

يفتح `http://localhost:8020` - تصفح الجلسات، فتش السجلات، أدِر السياسات.

### 3. تحقق مما هو نشط

```bash
failproofai policies
```

---

## تثبيت السياسة

### النطاقات

| النطاق | الأمر | حيث يكتب |
|-------|---------|---------|
| عام (افتراضي) | `failproofai policies --install` | `~/.claude/settings.json` |
| المشروع | `failproofai policies --install --scope project` | `.claude/settings.json` |
| محلي | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### تثبيت سياسات محددة

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### إزالة السياسات

```bash
failproofai policies --uninstall
# أو لنطاق محدد:
failproofai policies --uninstall --scope project
```

---

## الإعدادات

تعيش إعدادات السياسة في `~/.failproofai/policies-config.json` (عام) أو `.failproofai/policies-config.json` في مشروعك (لكل مشروع).

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

**ثلاثة نطاقات إعدادات** يتم دمجها تلقائياً (المشروع → محلي → عام). انظر [docs/configuration.mdx](docs/configuration.mdx) للحصول على قواعد الدمج الكاملة.

---

## السياسات المدمجة

| السياسة | الوصف | قابل للتكوين |
|---------|----------|:---:|
| `block-sudo` | منع الوكلاء من تشغيل أوامر النظام المميزة | `allowPatterns` |
| `block-rm-rf` | منع حذف الملفات المتكرر العرضي | `allowPaths` |
| `block-curl-pipe-sh` | منع الوكلاء من نقل البرامج النصية غير الموثوقة إلى shell | |
| `block-failproofai-commands` | منع إلغاء التثبيت الذاتي | |
| `sanitize-jwt` | وقف تسرب رموز JWT إلى سياق الوكيل | |
| `sanitize-api-keys` | وقف تسرب مفاتيح API إلى سياق الوكيل | `additionalPatterns` |
| `sanitize-connection-strings` | وقف تسرب بيانات اعتماد قاعدة البيانات إلى سياق الوكيل | |
| `sanitize-private-key-content` | تحرير كتل مفاتيح PEM الخاصة من الإخراج | |
| `sanitize-bearer-tokens` | تحرير رموز Bearer للتفويض من الإخراج | |
| `block-env-files` | منع الوكلاء من قراءة ملفات .env | |
| `protect-env-vars` | منع الوكلاء من طباعة متغيرات البيئة | |
| `block-read-outside-cwd` | احتفظ بالوكلاء داخل حدود المشروع | `allowPaths` |
| `block-secrets-write` | منع الكتابة إلى ملفات المفاتيح الخاصة والشهادات | `additionalPatterns` |
| `block-push-master` | منع الدفع العرضي إلى main/master | `protectedBranches` |
| `block-work-on-main` | احتفظ بالوكلاء بعيداً عن الفروع المحمية | `protectedBranches` |
| `block-force-push` | منع `git push --force` | |
| `warn-git-amend` | ذكّر الوكلاء قبل تعديل الالتزامات | |
| `warn-git-stash-drop` | ذكّر الوكلاء قبل حذف stashes | |
| `warn-all-files-staged` | اكتشف `git add -A` العرضية | |
| `warn-destructive-sql` | اكتشف DROP/DELETE SQL قبل التنفيذ | |
| `warn-schema-alteration` | اكتشف ALTER TABLE قبل التنفيذ | |
| `warn-large-file-write` | اكتشف عمليات كتابة الملفات الكبيرة غير المتوقعة | `thresholdKb` |
| `warn-package-publish` | اكتشف `npm publish` العرضية | |
| `warn-background-process` | اكتشف عمليات الخلفية غير المقصودة | |
| `warn-global-package-install` | اكتشف تثبيت الحزم العامة غير المقصودة | |
| …والمزيد | | |

تفاصيل السياسة الكاملة ومرجع المعاملات: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## السياسات المخصصة

اكتب سياساتك الخاصة للحفاظ على موثوقية الوكلاء والبقاء على المسار الصحيح:

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

التثبيت مع:

```bash
failproofai policies --install --custom ./my-policies.js
```

### مساعدات القرار

| الدالة | التأثير |
|--------|---------|
| `allow()` | السماح بالعملية |
| `allow(message)` | السماح بإرسال السياق المعلوماتي إلى Claude |
| `deny(message)` | حجب العملية؛ الرسالة تظهر لـ Claude |
| `instruct(message)` | إضافة سياق إلى موجه Claude؛ لا تحجب |

### كائن السياق (`ctx`)

| الحقل | النوع | الوصف |
|-------|-------|----------|
| `eventType` | `string` | `PreToolUse`, `PostToolUse`, `Notification`, `Stop` |
| `toolName` | `string` | الأداة المستدعاة (`Bash`, `Write`, `Read`, …) |
| `toolInput` | `object` | معاملات إدخال الأداة |
| `payload` | `object` | حمولة الحدث الخام الكاملة |
| `session.cwd` | `string` | دليل العمل لجلسة Claude Code |
| `session.sessionId` | `string` | معرّف الجلسة |
| `session.transcriptPath` | `string` | المسار إلى ملف نسخ جلسة الجلسة |

الخطافات المخصصة تدعم الواردات المحلية الانتقالية، async/await، والوصول إلى `process.env`. الأخطاء آمنة مفتوحة (مسجلة في `~/.failproofai/hook.log`، تستمر السياسات المدمجة). انظر [docs/custom-hooks.mdx](docs/custom-hooks.mdx) للحصول على الدليل الكامل.

### السياسات القائمة على الاتفاقية

قم بإسقاط ملفات `*policies.{js,mjs,ts}` في `.failproofai/policies/` ويتم تحميلها تلقائياً — بدون أعلام أو تغييرات إعدادات. التزم الدليل بـ git وكل عضو في الفريق يحصل على معايير الجودة نفسها تلقائياً.

```text
# مستوى المشروع — مُلتزم بـ git، مشترك مع الفريق
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# مستوى المستخدم — شخصي، ينطبق على جميع المشاريع
~/.failproofai/policies/my-policies.mjs
```

كلا المستويين يحملان (اتحاد). يتم تحميل الملفات أبجدياً داخل كل دليل. البادئة مع `01-`, `02-`, إلخ. للتحكم في الترتيب. عندما يكتشف فريقك أنماط فشل جديدة، أضف سياسة وادفع — يحصل الجميع على التحديث في سحب الطلب التالي. انظر [examples/convention-policies/](examples/convention-policies/) للحصول على أمثلة جاهزة للاستخدام.

---

## قياس الاستخدام

يجمع Failproof AI بيانات قياس الاستخدام المجهولة عبر PostHog لفهم استخدام الميزات. لا يتم أبداً إرسال محتوى الجلسة أو أسماء الملفات أو مدخلات الأداة أو المعلومات الشخصية.

تعطيله:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## التوثيق

| الدليل | الوصف |
|--------|----------|
| [Getting Started](docs/getting-started.mdx) | التثبيت والخطوات الأولى |
| [Built-in Policies](docs/built-in-policies.mdx) | جميع السياسات المدمجة الـ 39 مع المعاملات |
| [Custom Policies](docs/custom-policies.mdx) | اكتب سياساتك الخاصة |
| [Configuration](docs/configuration.mdx) | صيغة ملف الإعدادات ودمج النطاقات |
| [Dashboard](docs/dashboard.mdx) | مراقبة الجلسات ومراجعة نشاط السياسة |
| [Architecture](docs/architecture.mdx) | كيف يعمل نظام الخطافات |
| [Testing](docs/testing.mdx) | تشغيل الاختبارات وكتابة اختبارات جديدة |

### تشغيل التوثيق محلياً

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

يفتح موقع Mintlify للتوثيق في `http://localhost:3000`. ستراقب الحاوية التغييرات إذا قمت بتركيب دليل التوثيق:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## ملاحظة لمساهمي failproofai

يستخدم `.claude/settings.json` في هذا الريبو `bun ./bin/failproofai.mjs --hook <EventType>` بدلاً من أمر `npx -y failproofai` القياسي. وذلك لأن تشغيل `npx -y failproofai` داخل مشروع failproofai نفسه ينشئ تضاربة الإحالة الذاتية.

بالنسبة لجميع المستودعات الأخرى، الطريقة الموصى بها هي `npx -y failproofai`، المثبتة عبر:

```bash
failproofai policies --install --scope project
```

## المساهمة

انظر [CONTRIBUTING.md](CONTRIBUTING.md).

---

## الترخيص

انظر [LICENSE](LICENSE).

---

مبني وتم الحفاظ عليه بواسطة **ExosphereHost: Reliability Research Lab for Your Agents**. نساعد المؤسسات والشركات الناشئة على تحسين موثوقية وكلاء الذكاء الاصطناعي لديهم من خلال وكلائنا والبرامج والخبرات الخاصة بنا. تعرف على المزيد في [exosphere.host](https://exosphere.host).


</div>