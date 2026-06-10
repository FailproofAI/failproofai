> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**תרגומים:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**פתרון כשלים בזמן ריצה עבור סוכני קוד.**
משתלב עם Claude Code ו-Codex. תופס לולאות, פעולות מסוכנות וציפיות סוד
לפני שהם הופכים לתקריות. אפס זמן השהיית. רץ באופן מקומי.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLI של סוכנים נתמכים

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

> התקן hooks לאחד או לכל שילוב: `failproofai policies --install --cli opencode pi gemini` (או `--cli claude codex copilot cursor opencode pi gemini`). השמט את `--cli` כדי לגלות CLI מותקנים באופן אוטומטי ולהיבקש.

---

## התקנה

```sh
npm install -g failproofai
failproofai policies --install   # או פשוט הרץ את `failproofai` והסכים לבקשה בהפעלה הראשונה
failproofai
```

30 מדיניויות מובנות מופעלות מיד. לוח בקרה ב-`localhost:8020`. השבת בקשת הפעלה ראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `block-push-master` | דחיפה ישירה ל-`main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | commits, merges, rebases על `main` / `master` |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `sanitize-api-keys` | מפתחות API שדולפים להקשר הסוכן |

→ [כל 30 המדיניויות המובנות](https://docs.befailproof.ai/built-in-policies)

---

## המדיניויות שלך

שחרר קובץ אל `.failproofai/policies/` — הוא נטען באופן אוטומטי, ללא דגלים נדרשים.
שנה אותו וכל הצוות שלך מקבל אותו בעת ה-pull הבא.

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

שלוש החלטות זמינות לכל מדיניות:

| החלטה | השפעה |
|---|---|
| `allow()` | אפשר את הפעולה |
| `deny(message)` | חסום אותו — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לזה לעבור, אך הוסף הקשר להנחיה הבאה של הסוכן |

→ [מדריך מדיניויות מותאמות](https://docs.befailproof.ai/custom-policies)

---

## נראות הפגישה

כל קריאת כלי שהסוכן שלך מבצע מנויה באופן מקומי. לוח הבקרה מציג מה רץ,
מה היה חסום ומה אמרה המדיניות לסוכן — כך שאתה לא בניחוש
כשמשהו משתבש. → [מדריך לוח בקרה](https://docs.befailproof.ai/dashboard)

---

## תיעוד

| | |
|---|---|
| [התחלת עבודה](https://docs.befailproof.ai/getting-started) | התקנה והצעדים הראשונים |
| [מדיניויות מובנות](https://docs.befailproof.ai/built-in-policies) | כל 30 המדיניויות עם פרמטרים |
| [מדיניויות מותאמות](https://docs.befailproof.ai/custom-policies) | כתוב שלך |
| [הגדרה](https://docs.befailproof.ai/configuration) | היקפי הגדרה וכללי מיזוג |
| [לוח בקרה](https://docs.befailproof.ai/dashboard) | מנטור הפגישה ופעילות מדיניות |
| [ארכיטקטורה](https://docs.befailproof.ai/architecture) | איך מערכת ה-hook עובדת |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חופשי לשימוש פנימי ואישי; מכירה מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](./LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](./CONTRIBUTING.md). מדיניויות חדשות, מקרים קצה ותרגומים כולם מוזמנים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` תחילה. מאגר זה מריץ
> את ה-hooks שלו על עצמו, והם פותרים את ייבוא ה-`failproofai` כנגד ה-bundle
> המהודר `dist/` — ללא בנייה תקבל `Cannot find package 'failproofai'`
> שגיאות hook. בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שה-dev hooks בתוך המאגר יעבדו](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי על ידי [Nivedit Jain](https://github.com/NiveditJain) ו-[Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>