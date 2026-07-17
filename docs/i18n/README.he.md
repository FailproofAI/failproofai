> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

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

**תרגומים:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**פתרון כשלי זמן ריצה עבור סוכני קידוד.**
חוטפים Claude Code ו-Codex. תופסים לולאות, פעולות מסוכנות, וניצולי סודות
לפני שהם הופכים לתקריות. זמן השהיה אפס. רץ באופן מקומי.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLI סוכנים נתמכים

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

## התקנה

```sh
npm install -g failproofai
failproofai policies --install   # או פשוט הרץ `failproofai` והסכים להנחיה בהפעלה ראשונה
failproofai
```

30 מדיניות מובנות מופעלות מיד. לוח בקרה ב- `localhost:8020`. השבת את הנחיית ההפעלה הראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה היא חוסמת |
|---|---|
| `block-push-master` | דחיפה ישירה ל- `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | קומיטים, מיזוגים, ריביסים ב- `main` / `master` |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `sanitize-api-keys` | מפתחות API שדולפים להקשר הסוכן |

→ [כל 30 המדיניות המובנות](https://docs.befailproof.ai/built-in-policies)

---

## המדיניות שלך

זרוק קובץ ל- `.failproofai/policies/` — הוא נטען באופן אוטומטי, ללא דגלים.
בצע קומיט ושכל הצוות יקבל אותו בפול הבא.

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
| `deny(message)` | חסום אותה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לה לעבור, אך הוסף הקשר לפרומפט הבא של הסוכן |

→ [מדריך מדיניות מותאמות](https://docs.befailproof.ai/custom-policies)

---

## נראות הפגישה

כל קריאת כלי שהסוכן שלך עושה מוקדשת באופן מקומי. לוח הבקרה מציג מה רץ,
מה נחסם, ומה המדיניות אמרה לסוכן — כך שאתה לא מנחש
כשמשהו השתבש. → [מדריך לוח הבקרה](https://docs.befailproof.ai/dashboard)

---

## תיעוד

| | |
|---|---|
| [שיתוף פעולה](https://docs.befailproof.ai/getting-started) | התקנה וצעדים ראשונים |
| [מדיניות מובנות](https://docs.befailproof.ai/built-in-policies) | כל 30 המדיניות עם פרמטרים |
| [מדיניות מותאמות](https://docs.befailproof.ai/custom-policies) | כתוב שלך |
| [הגדרה](https://docs.befailproof.ai/configuration) | סקופים של הגדרה וכללי מיזוג |
| [לוח בקרה](https://docs.befailproof.ai/dashboard) | מונו ופעילות מדיניות בפגישה |
| [ארכיטקטורה](https://docs.befailproof.ai/architecture) | איך מערכת התוק עובדת |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; מכירה מסחרית מחדש של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](./LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](./CONTRIBUTING.md). מדיניות חדשות, מקרים קצה, ותרגומים בברכה.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` ראשון. ריפוזיטורי זה מריץ את הוקיים שלו על עצמו, והם פותרים את ייבוא ה-`failproofai` נגד הקבוצה `dist/` המקומפלת — בלי בנייה תוכל להיתקל בשגיאות `Cannot find package 'failproofai'` מהוק. בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שההוקים להתפתח בריפוזיטורי יעבדו](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי על ידי [Nivedit Jain](https://github.com/NiveditJain) ו-[Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>