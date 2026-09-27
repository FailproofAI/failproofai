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

**תצפיתיות והטלת אכיפה לכל משדר שהסוכנים שלך רצים בו.**
בכל מקום שהסוכנים שלך רצים, אנחנו רואים את זה — ואנחנו יכולים להגיד לא. Failproof hooks 12 משדרי סוכנים — coding CLIs כמו Claude Code ו-Codex, chat gateways כמו Hermes, עוזרים בהתקנה עצמית כמו OpenClaw — לוכדים כל הרצה וחוסמים קריאות כלים מסוכנות לפני הביצוע. 40 מדיניות מובנות. אפס עיכוב. רץ בעלוב.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## משדרים נתמכים

שנים עשר משדרים בשתי קטגוריות — עשרה coding CLIs, ושני chat ו-assistant gateways (Hermes, OpenClaw). API מדיניות אחד והיסטוריית הפעלה אחת בכל אחד מהם. מה שמדיניות יכולה *לחסום* הוא לפי משדר: עצירת קריאת כלי לפני שהיא רצה מאומתת בשנים עשר, דלתות קצה הפעלה בשמונה. ה-[מטריקס per-harness](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) מפרט את האירועים שכל אחד מהם מכבד.

סוכנים שרצים בשום אחד מהם מדווחים דרך ה-[Python SDK](https://docs.befailproof.ai/reference/custom-agents), שנותן לך tracing, הפעלות ובדיקות. אכיפה שם צריכה hook בזמן ריצה שלך — [דברו איתנו](mailto:support@befailproof.ai) ואנחנו נממפה את זה.

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
failproofai config                             # חיבור הסוכנים שלך וה-daemon
failproofai policies add FailproofAI/policies  # בחר מה להטיל אכיפה
failproofai                                    # לוח בקרה ב-localhost:8020
```

ההגדרה מחברת את ה-hooks ובוחרת **אפס** מדיניות — ההוראה השנייה היא מה שמציב שומרי-ערים על המכונה, וכל חבילה יוצרת טיפול באותו אופן
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` קורא קודם לכן). הרץ `failproofai config` ללא טרמינל — CI, מיכל, סוכן שנוהג בזה — ויהא חול או תשאול. במכונה שמעולם לא הוגדרה, כל פקודה אחרת מפעילה את אותו כושר קודם; השבת את זה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

עד שחבילה תגיע, הדבר היחיד שמטיל אכיפה הוא `block-failproofai-commands`, שתמיד פועל ולא ניתן לבטל או להשהות: סוכן שיכול להשהות אכיפה יכול לבטל כל מדיניות אחרת.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `block-env-files` | קריאות של קובצי `.env` וקובצי סוד אחרים |
| `warn-repeated-tool-calls` | הסוכן לולאה בקריאה זהה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | שינויים בלתי סקורים לתשתית חי |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, push ישיר ל-`main` |

כל אחד מהם שער את הקריאה *לפני* שהוא רץ, כך שהם מחזיקים בשנים עשר משדרים. ארבעת הראשונים חלים על כל סוכן שיכול לקרוא כלי; שלוש האחרונות הן המועדפות של המפתח — coding CLIs הן בדיוק קטגורת המשדר שאנחנו מכסים עמוקה ביותר. משפחת `sanitize-*` היא נפרדת: היא רצה אחרי שכלי חוזר, כך שהוא דווח סוד בפלט כלי ולא שמור את זה מהקשר.

→ [כל 40 המדיניות המובנות](https://docs.befailproof.ai/policies/packs)

---

## המדיניויות שלך

זרוק קובץ ל-`.failproofai/policies/` — הוא נטען באופן אוטומטי, לא צריך דגלים.
עשה Commit ותמיד כל הצוות מקבל את זה בעל ההשקה הבא.

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
| `allow()` | הרשה את הפעולה |
| `deny(message)` | חסום את זה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לזה להעבור, אבל הוסף קשר לפרומפט הבא של הסוכן |

→ [כתוב מדיניות](https://docs.befailproof.ai/policies/editor)

---

## תצפיתיות

אכיפה היא חצי אחד. החצי השני הוא לראות מה הסוכן בעצם עשה.

הרץ `failproofai` ללא ארגומנטים והוא משרת לוח בקרה ב-`localhost:8020`
קוראה את היסטוריית ההרצה כבר על המכונה שלך — לא חשבון, לא הרשמה, כלום עוזב את התיבה. אתה מקבל את רשימת ההפעלה, את הרצף של קריאות מודל, קריאות כלים וזתחלטות hook בתוך כל הרצה, מה חוסם ומה המדיניות אמרה לסוכן, ובדיקה לא מקוונת (`failproofai audit`) שסורקת את היסטוריתך לתבניות מסוכנות ומציעה מדיניות להפסיק אותן.

→ [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא Trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[בדיקה מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** הוא הצד המתארח של אותו מודל נתונים, לצוותים
שמפעילים סוכנים על פני צי: כל הרצה מכל משדר במקום אחד, גרף ביצוע עם תת-סוכנים מקבילים בנתיביהם שלהם, p50/p95/p99 עיכוב
למודלים, כלים ו-hooks, עלות לפי מודל וטיפול בחלון הקשר, עיקול שגיאות, SQL על ה-traces שלך עם לוחות בקרה שניתנים לשיתוף, הערכות מוערות על ידי
שירות משלך, בדיקות מתוזמנות שהופכות כשלונות חוזרים להוכחה, והוזהרות בנתיבון לפי Slack, דוא״ל או webhook חתום. Self-hosting בתוך
הקלוסטר שלך זמין בתוכנית Enterprise.

→ [Failproofai](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[הזמן דמו](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחל | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | התקנה, חיבור משדר, ראה את ההרצה הראשונה |
| [Concepts](https://docs.befailproof.ai/start/concepts) | איך מערכת ה-hook עובדת |
| [Supported harnesses](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול להטיל אכיפה |

| התבונן | |
|---|---|
| [Failproofai](https://docs.befailproof.ai/sessions/overview) | עקוב הרצה: מודלים, כלים, שגיאות, עיכוב |
| [קרא Trace](https://docs.befailproof.ai/sessions/read-a-trace) | מה הגרף ביצוע אומר לך |
| [Audits](https://docs.befailproof.ai/audits/overview) | מצא תבניות כשל בהפעלות רבות |
| [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, לא צריך חשבון |

| הטל אכיפה | |
|---|---|
| [חבילות מדיניות](https://docs.befailproof.ai/policies/packs) | המדיניויות של Failproof AI, וחבילות מה-policy hub |
| [כתוב מדיניות](https://docs.befailproof.ai/policies/editor) | מבדיקה, או בקוד |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | ייבוג תצורה, כללי מיזוג וערכי מדיניות |

| חזק את הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דווח הרצות מסוכן בלי משדר |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ופרטי; מכירה מחדש מסחרית של failproofai עצמה דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרים קצה, ותרגומים כלם מתקבלים בברכה.

> **בנה לפני שאתה מתחיל.** הרץ `bun install && bun run build` קודם. ריפו זה מפעיל את ה-hooks שלו בעצמו, והם פותרים את `failproofai` import כנגד ה-`dist/` bundle המהדר — ללא build אתה תפגע בשגיאות hook `Cannot find package 'failproofai'`. בנה מחדש אחרי שינוי `src/`. ראה
> [בנה לפני ה-in-repo dev hooks יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי בעם ❤️ על ידי [befailproof.ai](https://befailproof.ai) בסן פרנסיסקו וBengaluru.


</div>