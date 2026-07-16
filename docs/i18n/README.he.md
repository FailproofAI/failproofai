> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**תרגומים:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**פתרון כשלים בזמן ריצה לסוכני קוד.**
משתלב עם Claude Code ו-Codex. תופס לולאות, פעולות מסוכנות ודליפות סודות
לפני שהם הופכים לתקריות. זמן תגובה אפס. פועל בעמדה המקומית.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## ממשקי CLI של סוכנים נתמכים

<!-- A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). -->
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

> התקן ווים לאחד או לכל שילוב: `failproofai policies --install --cli opencode pi` (או `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). השמט `--cli` לאתראט אוטומטי של CLI-ים מותקנים ובהנחיה.
>
> **Hermes** (hermes-agent, שער Slack/Telegram) נתמך גם ל**אכיפת ווי חי** (`--cli hermes` — התקנה אחת מיירטת קריאות כלים מכל פלטפורמה ותת-סוכן) וגם ל**ביקורת** בלתי מקוונת של הפעלות שער מ-`~/.hermes/state.db` היחיד.
>
> **OpenClaw** (שער openclaw, עוזר רב-ערוץ בארח עצמי) נתמך גם ל**אכיפת ווי חי** (`--cli openclaw`, היקף משתמש) וגם ל**ביקורת** בלתי מקוונת של הפעלות JSONL שלו (`~/.openclaw/agents/<id>/sessions/*.jsonl`). האכיפה משתמשת ב**ווי פלאגין בתהליך** של OpenClaw (openclaw-plugin/ משלוח שמופעל באופן אסינכרוני-failproofai — הווי הפנימיים שלו מבוססי קבצים הם תצפית בלבד ואינם יכולים לחסום): `before_tool_call` חוסם כלי, ו`before_agent_finalize` הוא שער קצה תור אמיתי, כך ש`require-*-before-stop` בנויים כוללים אכיפה.
>
> **Factory Droid** (`droid`) נתמך גם ל**אכיפת ווי חי** (`--cli factory`, היקף משתמש + פרויקט) וגם ל**ביקורת** בלתי מקוונת של הפעלות JSONL שלו בדיסק. droid חוסם קריאות כלים בווי **קוד יציאה 2** (לא החלטה JSON) וכבד `{decision:"block"}` רק באירוע `Stop` בקצה התור — failproofai פולט את הצורה הנכונה לכל אירוע באופן אוטומטי.
>
> **Devin CLI** (`devin`, Cognition) נתמך גם ל**אכיפת ווי חי** (`--cli devin`, היקף משתמש + פרויקט) וגם ל**ביקורת** בלתי מקוונת של הפעלות SQLite שלו (`~/.local/share/devin/cli/sessions.db`). Devin הוא **שיבוט טהור של Claude** — אותם שמות אירועים, אותו payload snake_case, אותו תצורה `hooks`-wrapper (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — חסימה דרך `{decision:"block"}` JSON בכל אירוע.
>
> **Antigravity CLI** (`agy`) נתמך גם ל**אכיפת ווי חי** (`--cli antigravity`, היקף משתמש + פרויקט) וגם ל**ביקורת** בלתי מקוונת של הפעלות JSONL רגילות שלו (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity יש **שלו** חוזה (לא שיבוט Claude): סכימת `hooks.json` **בעלת שם** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), payload stdin camelCase ש-failproofai מתקן, וצורות תגובה משלו — `{decision:"deny"}` לחסום כלי, `{decision:"continue"}` לכפות תור אחר ב-`Stop`, `{injectSteps}` להכניס תזכורת לפני שהמודל פועל.
>
> **Goose** (שם קוד goose, Block) נתמך גם ל**אכיפת ווי חי** (`--cli goose`, היקף משתמש + פרויקט) וגם ל**ביקורת** בלתי מקוונת של הפעלות SQLite שלו (`~/.local/share/goose/sessions/sessions.db`). האכיפה משתמשת ב**מערכת ווי** של Goose (סכימת **Open Plugins** בין-סוכנית) — המתקין פשוט מורידה ספריית פלאגין ל-`~/.agents/plugins/failproofai/` ו-Goose מגלה את זה באופן אוטומטי. חסימה היא `{"decision":"block"}` JSON בחדש `PreToolUse` (שמתעלה עבור כלי הקליפה ובתוך תת-סוכנים משויכים), מאומת חי מול goose v1.43.0; Goose אין אירוע `Stop` בקצה התור, כך ש`require-*-before-stop` בנויים כוללים לא חלים (כמו עם Hermes).

---

## התקנה

```sh
npm install -g failproofai
failproofai policies --install   # או פשוט הרץ `failproofai` וקבל את הנושא ההנחיה הראשונה
failproofai
```

30 מדיניות מובנות מופעלות באופן מיידי. לוח מחוונים ב-`localhost:8020`. השבת את הנושא ההנחיה הראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `block-push-master` | דחיפות ישירות ל-`main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases ב-`main` / `master` |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `sanitize-api-keys` | מפתחות API דוללים להקשר הסוכן |

→ [כל 30 המדיניות המובנות](https://docs.befailproof.ai/built-in-policies)

---

## המדיניויות שלך

זרוק קובץ ל-`.failproofai/policies/` — הוא נטען באופן אוטומטי, ללא צורך בדגלים.
עשה קומיט וכל הצוות שלך יקבל את זה בעיתוי הבא.

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
| `deny(message)` | חסום את זה — ההודעה חוזרת לסוכן |
| `instruct(message)` | תן לה לעבור, אך הוסף הקשר להנחיה הבאה של הסוכן |

→ [מדריך מדיניויות מותאמות](https://docs.befailproof.ai/custom-policies)

---

## גלוי הפעלה

כל קריאת כלים שהסוכן שלך עושה מורשמת באופן מקומי. לוח המחוונים מראה מה רץ,
מה נחסם, ומה המדיניות אמרה לסוכן — כך שאתה לא מנחש
כשמשהו משתבש. → [מדריך לוח המחוונים](https://docs.befailproof.ai/dashboard)

---

## תיעוד

| | |
|---|---|
| [Getting Started](https://docs.befailproof.ai/getting-started) | התקנה והצעדים הראשונים |
| [Built-in Policies](https://docs.befailproof.ai/built-in-policies) | כל 30 המדיניויות עם פרמטרים |
| [Custom Policies](https://docs.befailproof.ai/custom-policies) | כתוב שלך |
| [Configuration](https://docs.befailproof.ai/configuration) | היקפי תצורה וכללי מיזוג |
| [Dashboard](https://docs.befailproof.ai/dashboard) | מוניטור הפעלה ופעילות מדיניות |
| [Architecture](https://docs.befailproof.ai/architecture) | איך מערכת הווי עובדת |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; מכירה מחדש מסחרית של failproofai עצמו דורש הסכם נפרד. ראה [LICENSE](./LICENSE) לטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](./CONTRIBUTING.md). מדיניויות חדשות, מקרי קצה ותרגומים כולם מדורים.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` ראשון. מילוע זה מפעיל את הווי שלו עצמו, והם מפתרים את ה-`failproofai` כשיוצא נגד החבילה המורכבת `dist/` — ללא בנייה תוכל לפגוע בשגיאות `Cannot find package 'failproofai'` ווי. בנה מחדש אחרי שינוי `src/`. ראה
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי על ידי [Nivedit Jain](https://github.com/NiveditJain) ו-[Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>