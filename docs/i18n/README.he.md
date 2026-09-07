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

**תצפיתיות ואכיפה לכל מנוע שבו רצים הסוכנים שלך.** בכל מקום בו רצים הסוכנים שלך, אנו רואים זאת — ואנו יכולים לסרב. Failproof מתחבר ל-12 מנועי סוכנים — CLIs קידוד כמו Claude Code ו-Codex, שערי צ'אט כמו Hermes, עוזרים מאורחנים עצמיים כמו OpenClaw — תופסים כל הפעלה וחוסמים קריאות כלים מסוכנות לפני ביצוע. 39 מדיניות מובנות. זמן חיתוך אפס. רץ ברמה מקומית.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## מנועים נתמכים

שנים עשר מנועים בשתי מחלקות — עשרה CLIs קידוד, ושני שערי צ'אט ועוזרים (Hermes, OpenClaw). אירועים זהים, מדיניות זהה, היסטוריית סדרה זהה, בכל מנוע בו רץ הסוכן שלך.

סוכנים הרצים בשום אחד מהם מדווחים דרך [Python SDK](https://docs.befailproof.ai/reference/custom-agents), שמעניק לך עקיבה, סדרות וביקורות. אכיפה שם דורשת hook בקרנטיים שלך — [דברו איתנו](mailto:support@befailproof.ai) ותחול אותה.

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
failproofai policies --install   # או פשוט הרץ `failproofai` וקבל את ההנחיה של ההפעלה הראשונה
failproofai
```

39 מדיניות מובנות מופעלות מיד. לוח בקרה ב-`localhost:8020`. השבת את הנחיית ההפעלה הראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה היא חוסמת |
|---|---|
| `sanitize-api-keys` | מפתחות API דולפים להקשר של הסוכן |
| `block-env-files` | קריאות של `.env` וקבצי סודות אחרים |
| `warn-repeated-tool-calls` | הסוכן נתקע בקרא אותה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbounded `DELETE` |
| `block-terraform` / `block-kubectl` | שינויים שלא נבדקו לתשתית חיה |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, push ישיר ל-`main` |

חמשת הראשונים חלים על כל סוכן שיכול להתקשר לכלי. שלוש האחרונות הן המועדפות של מפתחים — CLIs קידוד הם מחלקת ה-harness בה אנו מכסים בעומק הרבה ביותר.

→ [כל 39 המדיניות המובנות](https://docs.befailproof.ai/policies/builtin)

---

## המדיניות שלך

הנח קובץ ל-`.failproofai/policies/` — הוא נטען באופן אוטומטי, ללא דגלים נדרשים. בצע commit אותו והצוות כולו יקבל אותו ב-pull הבא.

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

| החלטה | אפקט |
|---|---|
| `allow()` | אפשר את הפעולה |
| `deny(message)` | חסום זאת — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לזה עבור, אך הוסף הקשר לנושא הבא של הסוכן |

→ [מדריך המדיניות המותאמת](https://docs.befailproof.ai/policies/custom)

---

## תצפיתיות

אכיפה היא חצי אחד. החצי השני הוא ראיית מה הסוכן בעצם עשה.

הרץ את `failproofai` ללא ארגומנטים ויש לו לשרת לוח בקרה ב-`localhost:8020` קורא את היסטוריית הריצה שכבר קיימת במכונה שלך — אין חשבון, אין הרשמה, כלום לא עוזב את הקופסה. אתה מקבל את רשימת הסדרה, את הרצף של קריאות דגם, קריאות כלים וקבלת החלטות hook בתוך כל ריצה, מה שנחסם ומה המדיניות אמרה לסוכן, וביקורת לא מקוונת (`failproofai audit`) שסורקת את היסטוריה שלך לדפוסים מסוכנים וממליצה על מדיניות לעצור אותם.

→ [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא עקבות](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המעונן של אותו מודל נתונים, לצוותים שמפעילים סוכנים על פני צי: כל ריצה מכל harness במקום אחד, גרף הביצוע עם תת-סוכנים מקבילים בנתיביהם שלהם, p50/p95/p99 חביון לדגמים, כלים והוקים, עלות לפי דגם ועקיבת חלון הקשר, עקיבת שגיאות, SQL על עקבותיך שלך עם לוחות בקרה שניתן לשתף, הערכות שדורגו על ידי השירות שלך, ביקורות מתוזמנות שהופכות כשלים חוזרים להוכחות, והתריעות שמקובלות ל-Slack, דוא"ל או webhook חתום. Self-hosting בקלאסטר שלך זמין בתוכנית Enterprise.

→ [סדרות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמן הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחל | |
|---|---|
| [התחלה מהירה](https://docs.befailproof.ai/start/quickstart) | התקנה, חיבור harness, ראה את הריצה הראשונה |
| [קונספטים](https://docs.befailproof.ai/start/concepts) | כיצד מערכת ה-hook עובדת |
| [Harnesses נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, ומה כל אחד יכול לאכוף |

| תצפיתיות | |
|---|---|
| [סדרות](https://docs.befailproof.ai/sessions/overview) | עקוב אחרי ריצה: דגמים, כלים, שגיאות, זמן חביון |
| [קרא עקבות](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף ההביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כשל על פני הרבה סדרות |
| [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אין צורך בחשבון |

| אכיפה | |
|---|---|
| [מדיניות מובנות](https://docs.befailproof.ai/policies/builtin) | כל 39 המדיניות עם פרמטרים |
| [מדיניות מותאמת](https://docs.befailproof.ai/policies/custom) | כתוב שלך שלך |
| [תצורה](https://docs.befailproof.ai/policies/local-configuration) | היקפי תצורה וכללי מיזוג |

| כלים את הסוכן שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דווח על הרצות מסוכן ללא harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` reference |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; מכירה מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניות חדשות, קצוות קיצון, ותרגומים כולם ברוכים הבאים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` תחילה. ריפו זה מריץ את ה-hooks של failproofai שלו בעצמו, והם פותרים את ה-import של `failproofai` לעומת ה-bundle של `dist/` שהורכב — ללא build אתה תפגע בשגיאות hook של `Cannot find package 'failproofai'`. בנה מחדש לאחר שינוי ב-`src/`. ראה [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנויה עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב-SF וב-Bengaluru.


</div>