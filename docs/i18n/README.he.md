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

**ניטור ואכיפה לכל הרתומה שבה רואים את סוכניך פועלים.**
בכל מקום בו סוכנים פועלים, אנו רואים זאת — ואנו יכולים לומר לא. Failproof מתחברת ל־12 רתומות סוכנים —
CLIs קידוד כמו Claude Code ו־Codex, שערי צ'ט כמו Hermes, עוזרים בעצמאות כמו OpenClaw —
אוספת כל ריצה וחוסמת קריאות כלים מסוכנות לפני שהן מתבצעות. 40 מדיניות מובנות. זמן תגובה אפס. פועלת בנתון.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI בפעולה" width="800" />
</p>

---

## רתומות נתמכות

שתים־עשרה רתומות בשתי קטגוריות — עשר CLIs קידוד, ושני שערי צ'ט ועוזרים (Hermes, OpenClaw).
ממשק API של מדיניות אחד והיסטוריית ישיבות אחת על פניהן. מה שמדיניות יכולה *לחסום* תלוי ברתומה:
עצירת קריאת כלים לפני שהיא מתבצעת מאומתת בשתים־עשרה, שערים בסוף תור בשמונה.
[מטריצת הרתומה](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
מפרטת את האירועים שכל אחת מהן מכבדת.

סוכנים הפועלים בשום אחת מהן מדווחים דרך [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
שנותנת לך ניתוח מעקב, ישיבות וביקורות. אכיפה שם דורשת קרס בריצון שלך —
[דברו איתנו](mailto:support@befailproof.ai) ונמפה זאת.

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
failproofai config                             # חיבור הסוכנים שלך והדיימון
failproofai policies add FailproofAI/policies  # בחירת מה לאכוף
failproofai                                    # לוח בקרה ב־localhost:8020
```

הגדרה חוטה את הקרסים ובוחרת **אפס** מדיניות — הפקודה השנייה היא מה שמעמיד מגנים על המכונה,
וכל חבילה מוקלדת באותו אופן
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` קורא אחד קודם).
הרץ `failproofai config` ללא טרמינל — CI, מיכל, סוכן המנהל אותו — ויחול במקום לשאול.
במכונה שמעולם לא הוגדרה, כל פקודה אחרת מפעילה את אותו אשף קודם; השבת את זה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

עד שחבילה תגיע, הדבר היחיד שמאכוף הוא `block-failproofai-commands`,
שהוא תמיד פועל ולא יכול להיות מושבת או מושהה: סוכן שיכול להשהות אכיפה יכול לכבות כל מדיניות אחרת.

---

## מה זה עוצר

| מדיניות | מה היא חוסמת |
|---|---|
| `block-env-files` | קריאות של `.env` וקבצי סודות אחרים |
| `warn-repeated-tool-calls` | סוכן שלוקע על אותה קריאה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` ללא גבול |
| `block-terraform` / `block-kubectl` | שינויים שלא נבדקו לתשתית חיה |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, דחיפות ישירות ל־`main` |

כל אחת מאלה שוערת את הקריאה *לפני* שהיא מתבצעת, כך שהן מחזיקות בכל שתים־עשרה רתומות.
ארבע הראשונות חלות על כל סוכן שיכול לקרוא כלי; השלוש האחרונות הן המועדפות של המפתחים —
CLIs קידוד הם מחלקת הרתומה שאנו מכסים בעמוק ביותר. משפחת `sanitize-*` היא נפרדת: היא רצה אחרי שכלי חוזר,
כך שהיא מדווחת סוד בפלט כלים במקום להחזיקו מחוץ להקשר.

→ [כל 40 מדיניות מובנות](https://docs.befailproof.ai/policies/packs)

---

## המדיניויות שלך

שחרר קובץ ל־`.failproofai/policies/` — הוא נטען באופן אוטומטי, אין צורך בדגלים.
בצע אותו וכל הצוות יקבל אותו בדחיפת pull הבאה.

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
| `allow()` | אישור הפעולה |
| `deny(message)` | חסימה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לזה להעביר, אך הוסף הקשר להנחיה הבאה של הסוכן |

→ [כתיבת מדיניות](https://docs.befailproof.ai/policies/editor)

---

## ניטור

אכיפה היא חצי אחד. החצי השני הוא לראות מה הסוכן בעצם עשה.

הרץ `failproofai` ללא ארגומנטים וזה משרת לוח בקרה ב־`localhost:8020`
קורא את היסטוריית הריצה כבר במכונה שלך — אפס חשבון, אפס הרשמה, כלום לא משאיר את התיבה.
אתה מקבל את רשימת הישיבות, רצף של קריאות מודל, קריאות כלים והחלטות קרס בתוך כל ריצה,
מה שחסום ומה שהמדיניות אמרה לסוכן, וביקורת לא מחוברת (`failproofai audit`) שסורקת את ההיסטוריה שלך
לאחר דפוסים וממליצה על מדיניויות לעצור אותם.

→ [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קריאת עקבות](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המתארח של אותו מודל נתונים, לצוותים הפעילים סוכנים על פני צי:
כל ריצה מכל רתומה במקום אחד, גרף ביצוע עם סוב־סוכנים מקבילים בנתיבים משלהם,
p50/p95/p99 זמן תגובה למודלים, כלים וקרסים, עלות לכל מודל וניתוח חלון הקשר,
ניתוב שגיאות, SQL על ההיסטוריות שלך עם לוחות בקרה שניתן לשתף, הערכות שדורגו על ידי השירות שלך,
ביקורות מתוכננות הפונות כישלונות חוזרים להוכחה, והתראות המנותבות ל־Slack, דוא״ל או webhook חתום.
אירוח עצמי בצביר שלך זמין בתוכנית Enterprise.

→ [ישיבות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמן הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחל | |
|---|---|
| [תחילה מהירה](https://docs.befailproof.ai/start/quickstart) | התקנה, חיבור רתומה, ראיית הריצה הראשונה |
| [קונספטים](https://docs.befailproof.ai/start/concepts) | איך מערכת הקרס עובדת |
| [רתומות נתמכות](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחת יכולה לאכוף |

| צפו | |
|---|---|
| [ישיבות](https://docs.befailproof.ai/sessions/overview) | עקוב אחרי ריצה: מודלים, כלים, שגיאות, זמן תגובה |
| [קריאת עקבות](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף הביצוע מספר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כישלון על פני ישיבות רבות |
| [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אפס צורך בחשבון |

| אכוף | |
|---|---|
| [חבילות מדיניות](https://docs.befailproof.ai/policies/packs) | מדיניויות Failproof AI וחבילות מהמרכז מדיניות |
| [כתיבת מדיניות](https://docs.befailproof.ai/policies/editor) | מביקורת, או בקוד |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | הוקדש תצורה, כללי מיזוג ופרמטרי מדיניות |

| ארגונית הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דוח ריצות מסוכן ללא רתומה |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | התייחסות `allow` / `deny` / `instruct` |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חופשי לשימוש פנימי וישיר; מכירה מסחרית של failproofai עצמה דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרים קיצוניים ותרגומים כולם מתקבלים.

---

בנוי בלב ❤️ על ידי [befailproof.ai](https://befailproof.ai) בסן פרנסיסקו וגנגלור.


</div>