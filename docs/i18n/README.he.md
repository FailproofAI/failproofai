> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**תרגומים:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**ניהול ותגבור לכל הכלים שהסוכנים שלך פועלים בהם.**
בכל מקום שהסוכנים שלך פועלים, אנחנו רואים זאת — וביכולתנו להגיד לא. Failproof מתחבר ל־12 כלים לסוכנים — ממשקי שורת פקודה לקידוד כמו Claude Code ו־Codex, שערי צ'אט כמו Hermes, עוזרים בעצמם מתארחים כמו OpenClaw — לוכדים כל הרצה וחוסמים קריאות כלים מסוכנות לפני שהן מתבצעות. 40 מדיניויות מובנות. אפס עיכוב. פועל ברמה מקומית.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## כלים נתמכים

שנים עשר כלים בשתי מחלקות — עשרה ממשקי שורת פקודה לקידוד, ושתי שערי צ'אט ועוזרים (Hermes, OpenClaw). אותם אירועים, אותן מדיניויות, אותו היסטוריון הפעלה, בכל אחד מהם שהסוכן פועל בו.

סוכנים שפועלים ללא קשר לאחד מהם מדווחים דרך ה־[Python SDK](https://docs.befailproof.ai/reference/python-sdk), המספק לך עקיבה, הפעלות וביקורות. הגבור שם דורש וו בסביבת הריצה שלך — [דברו אתנו](mailto:support@befailproof.ai) והנו נמפה זאת.

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

## התקנה

```sh
npm install -g failproofai
failproofai policies --install   # או פשוט הריצו `failproofai` וקבלו את ההנחיה בהתחלה הראשונה
failproofai
```

40 מדיניויות מובנות פעילות מיד. לוח תצוגה ב־`localhost:8020`. השבית את הנחיית ההתחלה הראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה היא חוסמת |
|---|---|
| `sanitize-api-keys` | דליפת מפתחות API להקשר של הסוכן |
| `block-env-files` | קריאות של קבצי `.env` וקבצי סודות אחרים |
| `warn-repeated-tool-calls` | הסוכן לולאה על אותה קריאה |
| `block-sudo` | הסלקלציה של הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` ללא גבול |
| `block-terraform` / `block-kubectl` | שינויים לא מעולים לתשתית חי |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, דחפות ישירות ל־`main` |

חמשת הראשונות חלות על כל סוכן שיכול לקרוא כלי. שלוש האחרונות הן המועדפות של המפתחים — ממשקי שורת פקודה לקידוד הם מחלקת הכלים שאנחנו מכסים הכי עמוק.

→ [כל 40 המדיניויות המובנות](https://docs.befailproof.ai/policies/builtin)

---

## המדיניויות שלך

זרוק קובץ ל־`.failproofai/policies/` — הוא נטען באופן אוטומטי, ללא צורך בדגלים.
בצע commit וכל הצוות שלך מקבל זאת בעדכון הבא.

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
| `instruct(message)` | תן לזה להעבור, אבל הוסף הקשר להנחיה הבאה של הסוכן |

→ [מדריך מדיניויות מותאם אישית](https://docs.befailproof.ai/policies/custom)

---

## ניהול

הגבור הוא חצי אחד. החצי השני הוא לראות מה הסוכן בעצם עשה.

הריצו `failproofai` ללא ארגומנטים והוא משרת לוח תצוגה ב־`localhost:8020` קורא את היסטוריית ההרצה שכבר על המכונה שלך — ללא חשבון, ללא הרשמה, שום דבר לא עוזב את התיבה. אתה מקבל את רשימת ההפעלות, את רצף קריאות המודל, קריאות כלים והחלטות וו בתוך כל הרצה, מה היה חסום ומה אמרה המדיניות לסוכן, וביקורת offline (`failproofai audit`) שסורקת את ההיסטוריה שלך לתבניות מסוכנות ומציעה מדיניויות להפסיק אותן.

→ [לוח תצוגה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא עקיבה](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המתארח של אותו דגם נתונים, לצוותים המריצים סוכנים על פני צי: כל הרצה מכל כלי במקום אחד, גרף ביצוע עם תת־סוכנים מקבילים בנתיביהם שלהם, עיכוב p50/p95/p99 לדגמים, כלים ווים, עלות לכל דגם ועקיבה של חלון הקשר, עקיבת שגיאות, SQL על העקיבות שלך עם לוחות תצוגה שניתן לשתף, הערכות שנותרו על ידי השירות שלך, ביקורות מתוזמנות שהופכות כשלים חוזרים להוכחות, והתראות המוטות ל־Slack, דוא״ל או webhook חתום. Self-hosting בקלסטר שלך זמין בתוכנית Enterprise.

→ [הפעלות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמן הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחלה | |
|---|---|
| [התחלה מהירה](https://docs.befailproof.ai/start/quickstart) | התקנה, חיבור כלי, ראה את ההרצה הראשונה |
| [קונספטים](https://docs.befailproof.ai/start/concepts) | איך מערכת הווים פועלת |
| [כלים נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול להטיל |

| ניהול | |
|---|---|
| [הפעלות](https://docs.befailproof.ai/sessions/overview) | עקוב הרצה: דגמים, כלים, שגיאות, עיכוב |
| [קרא עקיבה](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף ההביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | חפש תבניות כשל על פני הרבה הפעלות |
| [לוח תצוגה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, ללא צורך בחשבון |

| הטיל | |
|---|---|
| [מדיניויות מובנות](https://docs.befailproof.ai/policies/builtin) | כל 40 המדיניויות עם פרמטרים |
| [מדיניויות מותאם אישית](https://docs.befailproof.ai/policies/custom) | כתוב שלך |
| [קביעת תצורה](https://docs.befailproof.ai/policies/local-configuration) | ההיקפים ותכניות ההתמזגות |

| תאם את הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/python-sdk) | דוח הרצות מסוכן ללא כלי |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` התייחסות |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי והשכלתי; מכירה מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרי קצה, ותרגומים כולם מדורגים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` ראשית. מאגר זה מריץ את הווים שלו בעצמו עליו, והם פותרים את ה־import של failproofai כנגד ה־bundle של `dist/` המורכב — ללא בנייה תפגע ב־`Cannot find package 'failproofai'` שגיאות וו. בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שהווים הפיתוח בתוך-מאגר יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב־SF וBengaluru.


</div>