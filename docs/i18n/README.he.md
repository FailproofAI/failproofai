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

**ניטור והטלת אכיפה לכל קוסם שהסוכנים שלך רצים בו.**
איפה שהסוכנים שלך רצים, אנחנו רואים את זה — ואנחנו יכולים להגיד לא. Failproof מתחבר ל-12 קוסמים של סוכנים — ממשקי שורת פקודה לקידוד כמו Claude Code ו-Codex, שערי צ'אט כמו Hermes, עוזרים ממוחזקים עצמאיים כמו OpenClaw — תופסים כל הרצה וחוסמים קריאות כלים מסוכנות לפני שהן מתבצעות. 40 מדיניות מובנות. זמן אפס. רץ בעמדה מקומית.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## קוסמים נתמכים

שנים עשר קוסמים בשתי מחלקות — עשרה ממשקי שורת פקודה לקידוד, ושני שערי צ'אט ועוזרים (Hermes, OpenClaw). אותם האירועים, אותן המדיניויות, אותו ההיסטוריה של הפגישה, בכל אחד מהקוסמים שהסוכן שלך רץ בו.

סוכנים שרצים בשום אחד מהם מדווחים דרך [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
שנותן לך עקבוב, פגישות וביקורות. אכיפה שם דורשת קרס בזמן ריצה שלך — [שדברו אלינו](mailto:support@befailproof.ai) והנו נמפה את זה.

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
failproofai policies --install
failproofai
```

40 מדיניויות מובנות מופעלות מיידית. לוח בקרה ב-`localhost:8020`. השבת את הנושא בהרצה ראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה היא חוסמת |
|---|---|
| `sanitize-api-keys` | מפתחות API שדולפים להקשר של הסוכן |
| `block-env-files` | קריאות של קבצי `.env` וקבצי סודות אחרים |
| `warn-repeated-tool-calls` | הסוכן עוקף את אותה הקריאה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` ללא גבול |
| `block-terraform` / `block-kubectl` | שינויים ללא ביקורת לתשתית חיה |
| `block-rm-rf` | מחיקה רקורסיבית של קבצים |
| `block-force-push` / `block-push-master` | `git push --force`, דחיפה ישירה ל-`main` |

חמשת הראשונים חלים על כל סוכן שיכול לקרוא לכלי. השלוש אחרונות הן אהובות על המפתחים — ממשקי שורת פקודה לקידוד הם מחלקת הקוסם שאנחנו מכסים את העומק ביותר.

→ [כל 40 המדיניויות המובנות](https://docs.befailproof.ai/policies/builtin)

---

## המדיניויות שלך

שחרר קובץ ל-`.failproofai/policies/` — הוא טוען באופן אוטומטי, אין צורך בדגלים.
העלו את זה והצוות כולו מקבל את זה בשלימת הבא.

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
| `deny(message)` | חסום את זה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן את זה דרך, אבל הוסף הקשר להנמקה הבאה של הסוכן |

→ [מדריך מדיניויות מותאמות](https://docs.befailproof.ai/policies/custom)

---

## ניטור

אכיפה היא חצי אחד. החצי השני הוא לראות מה הסוכן בעצם עשה.

הרץ `failproofai` ללא ארגומנטים והוא משרת לוח בקרה ב-`localhost:8020`
קורא את היסטוריית הריצה כבר במכונה שלך — אין חשבון, אין הרשמה, שום דבר
עוזב את הקופסה. אתה מקבל את רשימת הפגישות, את הרצף של קריאות דגם, קריאות כלים
והחלטות קרס בתוך כל הרצה, מה חוסם ומה המדיניות אמרה לסוכן,
וביקורת בעבודה קשה (`failproofai audit`) שסורקת את ההיסטוריה שלך לדפוסים מסוכנים
ומציעה מדיניויות לעצירתם.

→ [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קראו עקבוב](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המארח של אותו מודל נתונים, לצוותים
המריצים סוכנים על פני צי: כל ריצה מכל קוסם במקום אחד, גרף ביצוע עם תת-סוכנים מקבילים
בנתיבים שלהם, זמן פעולה p50/p95/p99 לדגמים, כלים וקרסים,
עלות לכל דגם ועקבוב חלון הקשר, עקבוב שגיאות, SQL על העקבות שלך
עם לוחות בקרה ניתנים לשיתוף, הערכות המדורגות על ידי השירות שלך,
ביקורות מתוזמנות המהפכות כשלים חוזרים לממצאים המבוססים על עדויות,
והתנעות המנותבות ל-Slack, דוא"ל או webhook חתום. אירוח עצמי בקבוצה שלך
זמין בתוכנית Enterprise.

→ [פגישות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמנת הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחל | |
|---|---|
| [התחלה מהירה](https://docs.befailproof.ai/start/quickstart) | התקנה, חיבור קוסם, ראה את ההרצה הראשונה |
| [קונספטים](https://docs.befailproof.ai/start/concepts) | איך מערכת הקרס עובדת |
| [קוסמים נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול להטיל |

| לראות | |
|---|---|
| [פגישות](https://docs.befailproof.ai/sessions/overview) | עקוב אחר הרצה: דגמים, כלים, שגיאות, זמן פעולה |
| [קראו עקבוב](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף הביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כשל על פני הרבה פגישות |
| [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אין צורך בחשבון |

| הטל | |
|---|---|
| [מדיניויות מובנות](https://docs.befailproof.ai/policies/builtin) | כל 40 המדיניויות עם פרמטרים |
| [מדיניויות מותאמות](https://docs.befailproof.ai/policies/custom) | כתוב שלך |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | טווחי תצורה וכללי מיזוג |

| הנתק את הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דוח הריצות מסוכן ללא קוסם |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | התייחסות `allow` / `deny` / `instruct` |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חופשי לשימוש פנימי והשימוש אישי; מכירה מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרי קצה, ותרגומים כולם מרוחקים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` תחילה. ריפו זה מריץ
> את הקרסים שלו על עצמו, והם פותרים את ה-`failproofai` import מול
> ה-`dist/` bundle המורכב — ללא בנייה תפגע בשגיאות קרס `Cannot find package 'failproofai'`. 
> בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שקרסי dev בתוך הריפו יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב-SF ו-Bengaluru.


</div>