> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**תרגומים:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**ניטור והיישום עבור כל מנוע שהסוכנים שלך פועלים בו.**
היכן שהסוכנים שלך פועלים, אנחנו רואים את זה — ואנחנו יכולים להגיד לא. Failproof מתחבר ל-12 מנועי סוכנים
— CLIs של קידוד כמו Claude Code ו-Codex, שערים של צ'אט כמו Hermes,
עוזרים המתארחים בעצמם כמו OpenClaw — ותופסים כל הפעלה וחוסמים קריאות
כלים מסוכנות לפני שהן מתבצעות. 39 מדיניות מובנות. אפס אי-התאמה. פועל מקומית.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## מנועים נתמכים

שנים עשר מנועים בשתי קטגוריות — עשרה CLIs של קידוד, ושני שערים של צ'אט וסוכנים
(Hermes, OpenClaw). API מדיניות אחד והיסטוריית הפעלה אחת בכל אחד מהם. מה שמדיניות יכולה
*לחסום* הוא לפי מנוע: עצירת קריאת כלים לפני שהיא פועלת מוודאת בכל שנים עשר,
שערי סוף סיבוב על שמונה. ה[מטריצה לפי מנוע](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
מפרטת את האירועים שכל אחד מהם כבד.

סוכנים שפועלים בשום אחד מהם מדווחים דרך ה[SDK של Python](https://docs.befailproof.ai/reference/custom-agents),
המספק לך עקיבה, הפעלות ובדיקות. יישום שם זקוק להוק בסביבת הזמן שלך — [דבר איתנו](mailto:support@befailproof.ai)
וניתן למפות את זה.

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
failproofai config                             # חבר את הסוכנים שלך והסדמון
failproofai policies add FailproofAI/policies  # בחר מה להיישם
failproofai                                    # לוח מחוונים ב-localhost:8020
```

הגדרה מחברת את ההוקים ובוחרת **אין** מדיניויות — הפקודה השנייה היא מה
שמעביר מעקות על המכונה, וכל חבילה מוקלדת באותו אופן
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` קורא
אחד תחילה). הרץ `failproofai config` ללא טרמינל — CI, מיכל, סוכן שמניע אותו — וזה חל בקביעות
במקום לשאול. במכונה שלעולם לא הוגדרה, כל פקודה אחרת מריצה את אותו קוסם תחילה; השבת זאת
עם `FAILPROOFAI_NO_FIRST_RUN=1`.

עד שחבילה תגיע, הדבר היחיד שמיישם הוא `block-failproofai-commands`,
שהוא תמיד פועל ולא ניתן להשבית או להשהות: סוכן שיכול להשהות
יישום יכול להשבית כל מדיניות אחרת.

---

## מה זה חוסם

| מדיניות | מה זה חוסם |
|---|---|
| `block-env-files` | קריאות של קובצי `.env` וסודות אחרים |
| `warn-repeated-tool-calls` | הסוכן עוקף על אותה קריאה |
| `block-sudo` | הגברת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` ללא גבול |
| `block-terraform` / `block-kubectl` | שינויים שלא נבדקו לתשתיות חיות |
| `block-rm-rf` | מחיקת קובץ רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, דחיפות ישירות ל-`main` |

כל אחד מאלה שער את הקריאה *לפני* שהיא פועלת, כך שהם מחזיקים בכל שנים עשר
מנועים. הארבעה הראשונים חלים על כל סוכן שיכול לקרוא לכלי; השלוש האחרונים
הם האהובים על המפתחים — CLIs של קידוד הם מחלקת המנוע שאנחנו מכסים הכי עמוק. משפחת `sanitize-*`
נפרדת: היא פועלת לאחר שכלי חוזר, כך שהיא מדווחת על סוד בפלט כלים במקום
להחזיק אותו מתוך ההקשר.

→ [כל 39 מדיניויות מובנות](https://docs.befailproof.ai/policies/packs)

---

## המדיניויות שלך

הנח קובץ ל-`.failproofai/policies/` — הוא נטען באופן אוטומטי, אין צורך בדגלים.
התחייב אותו והצוות כולו מקבל אותו ב-pull הבא.

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
| `allow()` | התר את הפעולה |
| `deny(message)` | חסום אותה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לה לעבור, אך הוסף הקשר להנמק הבא של הסוכן |

→ [כתוב מדיניות](https://docs.befailproof.ai/policies/editor)

---

## ניטור

יישום הוא חצי אחד. החצי השני הוא לראות מה הסוכן בעצם עשה.

הרץ `failproofai` ללא ארגומנטים וזה משרת לוח מחוונים ב-`localhost:8020`
קורא את היסטוריית ההפעלה שכבר על המכונה שלך — אין חשבון, אין הרשמה, שום דבר
עוזב את התיבה. אתה מקבל את רשימת ההפעלות, רצף של קריאות מודל, קריאות כלים
והחלטות הוק בתוך כל הפעלה, מה חוסם ומה המדיניות אמרה לסוכן,
ובדיקת ביקורת במצב אופליין (`failproofai audit`) הסורקת את ההיסטוריה שלך
לחיפוש דפוסים מסוכנים ומציעה מדיניויות לעצור אותם.

→ [לוח מחוונים מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא כמוסגר](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד של המארח של אותו מודל נתונים, עבור צוותים
המפעילים סוכנים על פני צי: כל הפעלה מכל מנוע במקום אחד, גרף ביצוע עם תת-סוכנים מקבילים
על שדרות משלהם, p50/p95/p99 עיכוב עבור מודלים, כלים והוקים, עלות לפי מודל ועקיבה חלון הקשר,
עקיבת שגיאות, SQL על השטח שלך עם לוחות מחוונים שניתן לשתף, הערכות שקיבלו ציון על ידי השירות שלך,
ביקורות מתוכננות שהופכות כישלונות חוזרים לממצאים מבוססי ראיות, ו-alert
מנויי Slack, דואר אלקטרוני או וובהוק חתום. Self-hosting בקלוסטר שלך
זמין בתוכנית Enterprise.

→ [הפעלות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[קבוע דמו](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחלה | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | התקנה, חבר מנוע, ראה את ההפעלה הראשונה |
| [קונספטים](https://docs.befailproof.ai/start/concepts) | איך מערכת ההוק עובדת |
| [מנועים נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול להיישם |

| ניטור | |
|---|---|
| [הפעלות](https://docs.befailproof.ai/sessions/overview) | עקוב אחרי הפעלה: מודלים, כלים, שגיאות, עיכוב |
| [קרא כמוסגר](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף הביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כישלון על פני הפעלות רבות |
| [לוח מחוונים מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אין צורך בחשבון |

| היישם | |
|---|---|
| [חבילות מדיניות](https://docs.befailproof.ai/policies/packs) | מדיניויות Failproof AI וחבילות מחוט מדיניות |
| [כתוב מדיניות](https://docs.befailproof.ai/policies/editor) | מביקורת, או בקוד |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | טווחי תצורה, כללי מיזוג ופרמטרי מדיניות |

| כלי את הסוכן שלך | |
|---|---|
| [SDK של Python](https://docs.befailproof.ai/reference/custom-agents) | דווח על הפעלות מסוכן ללא מנוע |
| [SDK של מדיניות](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` הפניה |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; המכר מחדש מסחרי
של failproofai עצמו דורש הסכמה נפרדת. ראה [LICENSE](../../LICENSE) לנוסח המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרים קצה, ותרגומים כולם ברוכים הבאים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` תחילה. מחסן זה מריץ
> הוקים של failproofai שלו על עצמו, והם פותרים את ייבוא `failproofai` נגד
> צרור `dist/` המהודר — ללא בנייה תפגע בשגיאות הוק `Cannot find package 'failproofai'`.
> בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שההוקים שלך בתוך המחסן יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב-SF ו-Bengaluru.


</div>