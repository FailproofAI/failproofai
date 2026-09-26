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

**ניטור והטלת אכיפה על כל מנוף שבו מריצים Agents.** בכל מקום שבו מריצים את Agents שלך, אנחנו רואים את זה — ואנחנו יכולים להגיד לא. Failproof מתחבר ל-12 מנופי agents — CLIs קוד כמו Claude Code ו-Codex, שערי צ'אט כמו Hermes, assistants בעצמאות עצמית כמו OpenClaw — לוכדים כל הרצה וחוסמים קריאות כלים מסוכנות לפני ביצוע. 39 מדיניות מובנות. זליגה אפס. פועל ברמה מקומית.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## מנופים נתמכים

שנים עשר מנופים בשתי מחלקות — עשרה CLIs קוד, ושני שערי צ'אט ו-assistant (Hermes, OpenClaw). API מדיניות אחד והיסטוריית הפעלה אחת על כולם. מה שמדיניות יכולה לחסום הוא לפי מנוף: עצירת קריאת כלים לפני ביצוע מתוודאת בכל שנים עשר, שערי קצה הרצה בשמונה. ה[מטריצה לפי מנוף](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) רשמת את האירועים שכל אחד מהם מכבד.

Agents שפועלים בשום אחד מהם דיווח דרך [ה-Python SDK](https://docs.befailproof.ai/reference/custom-agents), שנותן לך ניתוח, הפעלות וביקורות. אכיפה שם צריכה ווי בסביבת ההרצה שלך — [דברו איתנו](mailto:support@befailproof.ai) ואנחנו נמפה אותה.

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
failproofai config                             # חוט את ה-agents שלך ו-daemon
failproofai policies add FailproofAI/policies  # בחר מה להטיל
failproofai                                    # לוח בקרה ב-localhost:8020
```

ההגדרה מתחברת את ההוקים ובוחרת אפס מדיניות — הפקודה השנייה הזו היא מה שמוציא מגבלות על המכונה, וכל חבילה מוקלדת באותו אופן (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` קורא אחת ראשונה). הרץ `failproofai config` ללא טרמינל — CI, קונטיינר, agent שמנהל אותה — וזה מיישם במקום לשאול. על מכונה שלא הוגדרה מעולם, כל פקודה אחרת מריץ את אותה אשף קודם; השבת את זה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

עד שחבילה תגיע, הדבר היחיד שמטיל אכיפה הוא `block-failproofai-commands`, שתמיד פועל ולא ניתן להשבתה או השהיה: agent שיכול להשהות אכיפה יכול להשבית כל מדיניות אחרת.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `block-env-files` | קריאות של קבצי `.env` וקבצי סוד אחרים |
| `warn-repeated-tool-calls` | ה-agent לולאה בקריאה זהה |
| `block-sudo` | הסלמת הרשאות |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` ללא גבול |
| `block-terraform` / `block-kubectl` | שינויים שלא זוקפו לתשומת לב לתשתיות חיות |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `block-force-push` / `block-push-master` | `git push --force`, דחיפות ישירות ל-`main` |

כל אחת מהן משער את הקריאה *לפני* ביצוע, כך שהן מחזיקות בכל שנים עשר מנופים. ארבע הראשונות חלות על כל agent שיכול לקרוא לכלי; שלושת האחרונים הם המועדפים של המפתחים — CLIs קוד הם מחלקת המנוף שאנו מכסים בעומק. משפחת `sanitize-*` נפרדת: היא רצה לאחר שכלי חוזר, כך שהיא מדווחת על סוד בפלט כלים ולא שומרת אותה מהקשר.

→ [כל 39 מדיניות מובנות](https://docs.befailproof.ai/policies/packs)

---

## המדיניויות שלך

השלך קובץ לתוך `.failproofai/policies/` — הוא טוען באופן אוטומטי, לא צריך דגלים. התחייב אותו והצוות כולו מקבל אותו בדחיפה הבאה.

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
| `deny(message)` | חסום אותה — ההודעה חוזרת ל-agent |
| `instruct(message)` | תן לזה לעבור, אבל הוסף הקשר להנחיה הבאה של ה-agent |

→ [כתוב מדיניות](https://docs.befailproof.ai/policies/editor)

---

## ניטור

אכיפה היא חצי אחד. החצי השני הוא לראות מה ה-agent בעצם עשה.

הרץ `failproofai` ללא טיעונים וזה משרת לוח בקרה ב-`localhost:8020` קורא את היסטוריית ההרצה כבר על המכונה שלך — אין חשבון, אין הרשמה, כלום עוזב את הקופסה. אתה מקבל רשימת הפעלות, סדר קריאות מודל, קריאות כלים והחלטות ווי בתוך כל הרצה, מה שנחסם ומה המדיניות אמרה ל-agent, וביקורת במצב לא מקוון (`failproofai audit`) שסורקת את ההיסטוריה שלך לדפוסים מסוכנים ומציעה מדיניויות לעצור אותם.

→ [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) ·
[קרא עקבול](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ביקורת מקומית](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** היא הצד המארח של אותו מודל נתונים, לצוותים שמריצים agents על פני צי: כל הרצה מכל מנוף במקום אחד, גרף ביצוע עם תת-agents מקביל בנתיבים שלהם, p50/p95/p99 latency עבור מודלים, כלים וווי, עלות לכל מודל וניתוח חלון הקשר, ניתוח שגיאות, SQL על העקבול שלך עם לוחות משתפים, הערכות הניקוד על ידי השירות שלך, ביקורות מתוזמנות שהופכות כשלים חוזרים להוכחות מרוכזות, והתראות שנמשלחו ל-Slack, דוא״ל או webhook חתום. Self-hosting בקלסטר שלך זמין בתוכנית Enterprise.

→ [הפעלות](https://docs.befailproof.ai/sessions/overview) ·
[ביקורות](https://docs.befailproof.ai/audits/overview) ·
[הזמן הדגמה](https://befailproof.ai/get-a-demo)

---

## תיעוד

| התחל | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | התקן, חבר מנוף, ראה את ההרצה הראשונה |
| [מושגים](https://docs.befailproof.ai/start/concepts) | איך מערכת הווי עובדת |
| [מנופים נתמכים](https://docs.befailproof.ai/reference/harnesses) | כל 12, וכל אחד יכול להטיל |

| שקוף | |
|---|---|
| [הפעלות](https://docs.befailproof.ai/sessions/overview) | עקוב אחרי הרצה: מודלים, כלים, שגיאות, latency |
| [קרא עקבול](https://docs.befailproof.ai/sessions/read-a-trace) | מה גרף הביצוע אומר לך |
| [ביקורות](https://docs.befailproof.ai/audits/overview) | מצא דפוסי כשל על פני הפעלות רבות |
| [לוח בקרה מקומי](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, אין צורך בחשבון |

| הטל | |
|---|---|
| [חבילות מדיניות](https://docs.befailproof.ai/policies/packs) | מדיניויות Failproof AI, וחבילות מחוב המדיניות |
| [כתוב מדיניות](https://docs.befailproof.ai/policies/editor) | מביקורת, או בקוד |
| [הגדרה](https://docs.befailproof.ai/policies/local-configuration) | היקפי הגדרה, כללי מיזוג ופרמטרים של מדיניות |

| כלי את ה-agent שלך | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | דווח על הרצות מ-agent ללא מנוף |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | הפניית `allow` / `deny` / `instruct` |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; מכירת הטלות מחדש של failproofai עצמה דורשת הסכם נפרד. ראה [LICENSE](../../LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](../../CONTRIBUTING.md). מדיניויות חדשות, מקרי קצה, ותרגומים כולם מוזמנים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` קודם. מחסן זה מריץ את הווי שלו failproofai על עצמו, והם פותרים את `failproofai` import כנגד ה-bundle המתורגל `dist/` — ללא בנייה תיפגע `Cannot find package 'failproofai'` שגיאות ווי. בנייה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שהווי התוך-מחסן יעבדו](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי עם ❤️ על ידי [befailproof.ai](https://befailproof.ai) ב-SF ובנגלור.


</div>