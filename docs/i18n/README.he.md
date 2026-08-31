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

**ראה מה הסוכנים שלך עושים. עצור כישלונות ידועים לפני שהם חוזרים על עצמם.**
Failproof AI עובד בכל מקום שבו הסוכנים שלך רצים: כלים לכתיבת קוד כמו Claude Code ו-Codex,
שערי צ׳אט כמו Hermes, עוזרים עצמאיים כמו OpenClaw, וסוכנים שאתה מכשיר בעצמך. זה מתעד כל הרצה
ויכול לחסום קריאות כלים מסוכנות לפני שהן בוצעות.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## כלים נתמכים

שנים עשר כלים בשתי מחלקות נתמכים: עשרה CLI לכתיבת קוד, בנוסף לשני שערים: Hermes, OpenClaw.
ממשק המדיניות ויומן ההסטוריה של הסדרה משותפים; אילו אירועים יכולים לחסום משתנים לפי כלי.

סוכנים שרצים בשום אחד מהם דיווחים דרך [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
שנותן לך עקיבה, סדרות וביקורות. אכיפה שם צריכה ווי בזמן הריצה שלך — [דבר איתנו](mailto:support@befailproof.ai) ונמפה את זה.

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

תן לסוכן תואם את כישרון Failproof AI אם אתה רוצה שהוא ידריך הגדרה,
בחן את המכונה, וניתוב מדיניות, ביקורת, סדרה, וועבודת עננים בצורה נכונה:

```sh
npx skills add FailproofAI/skills
```

זה מתקין את הכישרון המטרייה וה-siblings המתמחים שלה. כדי להתקין רק את המטרייה,
הוסף `--skill failproofai`. כישרונות מספקים הוראות הפעלה; התקן והגדר את המוצר עצמו עם:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

ההגדרה מחברת סוכנים נתמכים ומתקינה את שירות הרקע. היא לא בוחרת בשום חבילת מדיניות:
לפני שתוסיף אחד, רק `block-failproofai-commands` רץ כדי לעצור סוכן מהשבתת Failproof AI.

התחבר לעננים ללא הנמקות עם `failproofai config --token <machine-key>`. במכונה משותפת או ב-CI,
הגדר `FAILPROOFAI_CLOUD_TOKEN` והרץ `failproofai config` כדי המפתח לא יופיע בהיסטוריית הפקודות.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `sanitize-api-keys` | מפתחות API שדולפים להקשר של הסוכן |
| `block-env-files` | קריאות של `.env` וקבצי סוד אחרים |
| `warn-repeated-tool-calls` | הסוכן לולאה על אותה קריאה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` בלא הגבלה |
| `block-terraform` / `block-kubectl` | שינויים לא בדוקים לתשתית חיה |
| `block-rm-rf` | מחיקה רקורסיבית של קובץ |
| `block-force-push` / `block-push-master` | `git push --force`, דחיפות ישירות ל-`main` |

מדיניויות אלה מגינות על קבצים, כנויות, תשתית, בסיסי נתונים, וזרימות עבודה של סוכן.
תמיכת אכיפה מדויקת משתנה לפי כלי ואירוע.

→ [כל 39 המדיניויות המובנות](https://docs.befailproof.ai/policies/builtin)

---

## המדיניויות שלך

זרוק קובץ ל-`.failproofai/policies/` — הוא נטען באופן אוטומטי, אין צורך בדגלים.
Commit את זה והצוות כולו מקבל את זה בפול הבא.

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
| `instruct(message)` | תן לה להעביר, אך הוסף הקשר לתזכורת הבאה של הסוכן |

→ [מדריך למדיניויות מותאמות אישית](https://docs.befailproof.ai/policies/custom)

---

## חבילות מדיניות

חבילת מדיניות היא קבוצה מעודכנת של מדיניויות המפורסמות ממחסן GitHub ציבורי.
בחן אחד לפני התקנתו:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

כל דבר עם קיצור היא מקור חבילה; כל דבר ללא אחד הוא שם מדיניות.
אתה יכול להתקין קטגוריות או מדיניויות נבחרות, וקבוע הוצאה כאשר נדרש.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

עיון בחבילות פורסמו ב-[Policy Hub](https://befailproof.ai/policy-hub/), או
הרץ `failproofai publish --init` כדי להתחיל את שלך. מצב תצפית מאפשר חבילה להקליט
מה היא הייתה עושה בלי לחסום: `failproofai publish --effect observe`.

→ [חבילות מדיניות](https://docs.befailproof.ai/policies/packs) ·
[פרסם חבילה](https://docs.befailproof.ai/policies/publish-a-pack)

---

## קביעות

אכיפה היא חצי אחד. החצי האחר הוא לראות מה הסוכן בעצם עשה.

הרץ `failproofai` ללא טיעונים והוא משרת לוח מחוונים ב-`localhost:8020`
קריאת יומן ההרצה כבר על המכונה שלך — אין חשבון, אין הרשמה, לא משאיר את התיבה.
אתה מקבל את רשימת ההסדרה, את רצף של שיחות מודל, קריאות כלים
וחלטות ווי בתוך כל הרצה, מה היה חסום ומה המדיניות אמרה לסוכן,
וביקורת אופליין (`failproofai audit`) הסורקת את ההיסטוריה שלך לדפוסים מסוכנים ומציעה מדיניויות לעצור אותם.

→ [לוח מחוונים מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא עקבה](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המתארח של אותו מודל נתונים, לצוותים
המריצים סוכנים על פני צי: כל הרצה מכל כלי במקום אחד, גרף ביצוע עם תת-סוכנים מקבילים בנתיבים משלהם,
p50/p95/p99 טיפול לדגמים, כלים וווים, עלות למודל ועקיבת חלון הקשר, עקיבת שגיאות,
SQL על הסימנים שלך עם לוחות מחוונים שניתן לשתף, הערכות שנוקדו על ידי השירות שלך,
ביקורות מתוזמנות שהופכות כישלונות חוזרים לממצאים מבוססי ראיות, והתרעות
המנותבות ל-Slack, אימייל או webhook חתום. self-hosting בקלוסטר שלך זמין בתוכנית Enterprise.

→ [סדרות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמן הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחלה | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | התקן, חבר כלי, ראה את ההרצה הראשונה |
| [מושגים](https://docs.befailproof.ai/start/concepts) | איך מערכת ווי עובדת |
| [כלים נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול להטיל |

| שים לב | |
|---|---|
| [סדרות](https://docs.befailproof.ai/sessions/overview) | עקוב אחר הרצה: דגמים, כלים, שגיאות, טיפול |
| [קרא עקבה](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף הביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כישלון על פני סדרות רבות |
| [לוח מחוונים מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אין צורך בחשבון |

| הטל | |
|---|---|
| [מדיניויות מובנות](https://docs.befailproof.ai/policies/builtin) | כל 39 מדיניויות עם פרמטרים |
| [מדיניויות מותאמות אישית](https://docs.befailproof.ai/policies/custom) | כתוב שלך |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | סוגי הגדרה וכללי מיזוג |

| הכשר את הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דווח הרצות מסוכן ללא כלי |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חופשי לשימוש פנימי ואישי;
מכירת מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרים קצה, ותרגומים כולם ברוכים הבאים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` תחילה. מאגר זה מריץ
> וויים משלו על עצמו, והם פותרים את ה-import של `failproofai` כנגד
> חבילת `dist/` המהודרת — ללא בנייה תכות שגיאות `Cannot find package 'failproofai'`
> ווי. בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שווי הפיתוח בבחזון יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב-SF וBengaluru.


</div>