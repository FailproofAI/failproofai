> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


<div align="center">

<img src="https://d2wq11aou0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**תרגומים:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**פתרון כשלי זמן ריצה לסוכני קוד.**
מתחבר ל-Claude Code ו-Codex. תופס לולאות, פעולות מסוכנות ודליפות סודות
לפני שהם הופכים לתקריות. אפס עיכוב. פועל בעל.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI בפעולה" width="800" />
</p>

---

## CLIs של סוכנים נתמכים

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> התקן hooks עבור אחד או כל שילוב: `failproofai policies --install --cli opencode pi` (או `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). השמט `--cli` לגילוי אוטומטי של CLIs מותקנים והנחיה.
>
> **Hermes** (hermes-agent, שער Slack/Telegram) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli hermes` — התקנה אחת מיירטת קריאות כלים מכל פלטפורמה וסוכן משנה) ו**ביקורת** לא מקוונת של הפעלות השער שלו מ-`~/.hermes/state.db`.
>
> **OpenClaw** (שער openclaw, עוזר פתוח לכל ערוצים) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli openclaw`, תחום משתמש) ו**ביקורת** לא מקוונת של הפעלות JSONL שלו (`~/.openclaw/agents/<id>/sessions/*.jsonl`). אכיפה משתמשת ב**hooks hook לתוך-תהליך** של OpenClaw (plugin משלח שמזווג failproofai באופן אסינכרוני — hooks קבועים קבועים שלו הם תצפית בלבד ולא יכולים לחסום): `before_tool_call` חוסם כלי, ו-`before_agent_finalize` הוא שער תיאום אמיתי, כך שה-builtins `require-*-before-stop` אוכפים.
>
> **Factory Droid** (`droid`) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli factory`, תחום משתמש + פרויקט) ו**ביקורת** לא מקוונת של הפעלות JSONL שלו על הדיסק. droid חוסם קריאות כלים מ-exit code 2 של hook (לא החלטה JSON) וכבד `{decision:"block"}` רק באירוע התיאום `Stop` בסוף - failproofai פולט את הצורה הנכונה לפי אירוע באופן אוטומטי.
>
> **Devin CLI** (`devin`, Cognition) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli devin`, תחום משתמש + פרויקט) ו**ביקורת** לא מקוונת של הפעלות SQLite שלו (`~/.local/share/devin/cli/sessions.db`). Devin הוא **שיבוט Claude טהור** — אותו שמות אירועים, אותו payload snake_case, אותה תצורה `hooks`-wrapper (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — חסימה דרך `{decision:"block"}` JSON בכל אירוע.
>
> **Antigravity CLI** (`agy`) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli antigravity`, תחום משתמש + פרויקט) ו**ביקורת** לא מקוונת של הפעלות plain-JSONL שלו (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity יש **שלו** ערך (לא שיבוט Claude): סכימה `hooks.json` **מקבל-hook** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), payload stdin camelCase שה-failproofai מנרמל, וצורות תגובה שלו - `{decision:"deny"}` לחסום כלי, `{decision:"continue"}` לכפות סיבוב נוסף ב-`Stop`, `{injectSteps}` להזריק תזכורת לפני שהמודל פועל.
>
> **Goose** (קוד קוד קוד, Block) נתמך לשתי האפשרויות: **אכיפת hook בזמן אמת** (`--cli goose`, תחום משתמש + פרויקט) ו**ביקורת** לא מקוונת של הפעלות SQLite שלו (`~/.local/share/goose/sessions/sessions.db`). אכיפה משתמשת במערכת **hooks** של Goose (ספק Open Plugins **חוצה-סוכן**) — המתקין פשוט משמיע ספריית plugin ב-`~/.agents/plugins/failproofai/` ו-Goose מגלה אותה באופן אוטומטי. חסימה היא `{"decision":"block"}` JSON באירוע `PreToolUse` (אשר יורה עבור כלי הקליפה ובתוך סוכנים משנים שנדלגו), מאומת בעיתוי אמת מול goose v1.43.0; Goose אין אירוע סוף תיאום `Stop`, כך ה-builtins `require-*-before-stop` לא חלים (כמו ב-Hermes).

---

## התקנה

```sh
npm install -g failproofai
failproofai policies --install   # או פשוט הרץ `failproofai` והסכם ללחץ הראשון
failproofai
```

30 מדיניות מובנות מופעלות מיד. לוח בקרה ב-`localhost:8020`. השבת את הנחיה הריצה הראשונה עם `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## מה זה עוצר

| מדיניות | מה זה חוסם |
|---|---|
| `block-push-master` | דחיפות ישירות ל-`main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | commits, merges, rebases ב-`main` / `master` |
| `block-rm-rf` | מחיקת קבצים רקורסיבית |
| `sanitize-api-keys` | מפתחות API דולפים לשיבוט context |

→ [כל 30 מדיניות מובנות](https://docs.befailproof.ai/built-in-policies)

---

## המדיניויות שלך

הנח קובץ ל-`.failproofai/policies/` — זה טוען באופן אוטומטי, אין צורך בדגלים.
Commit זה והצוות כולו מקבל את זה בפול הבא.

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
| `instruct(message)` | תן לזה לעבור, אך הוסף context להנחיה הבאה של הסוכן |

→ [מדריך מדיניויות מותאם אישית](https://docs.befailproof.ai/custom-policies)

---

## יכולת צפייה בהפעלה

כל קריאת כלי שהסוכן שלך עושה מתורגלת בעל. לוח הבקרה מראה מה הריץ,
מה חוסם, ומה המדיניות אמרה לסוכן — כך שאתה לא מנחש
כאשר משהו משתבש. → [מדריך לוח בקרה](https://docs.befailproof.ai/dashboard)

---

## תיעוד

| | |
|---|---|
| [התחלה בעבודה](https://docs.befailproof.ai/getting-started) | התקנה וצעדים ראשונים |
| [מדיניויות מובנות](https://docs.befailproof.ai/built-in-policies) | כל 30 מדיניויות עם פרמטרים |
| [מדיניויות מותאם אישית](https://docs.befailproof.ai/custom-policies) | כתוב שלך |
| [תצורה](https://docs.befailproof.ai/configuration) | תחומים ותצורה וכללי מיזוג |
| [לוח בקרה](https://docs.befailproof.ai/dashboard) | צג הפעלה ופעילות מדיניות |
| [ארכיטקטורה](https://docs.befailproof.ai/architecture) | כיצד מערכת ה-hook פועלת |

---

## רישיון

MIT עם [Commons Clause](https://commonsclause.com/) — חינם לשימוש פנימי ואישי; מכירה מחדש מסחרית של failproofai עצמו דורשת הסכם נפרד. ראה [LICENSE](./LICENSE) עבור הטקסט המלא.

---

## תרומה

ראה [CONTRIBUTING.md](./CONTRIBUTING.md). מדיניויות חדשות, מקרים שיוצאים דופן, וכל התרגומים מתקבלים בברכה.

> **בנה לפני שתתחיל.** הרץ `bun install && bun run build` קודם. repo זה מפעיל
> hooks של failproofai בעצמו, והם פותרים את הייבוא failproofai כנגד
> הצרור `dist/` שהורכב — ללא בנייה תפגע ב-`Cannot find package 'failproofai'`
> שגיאות hook. בנה מחדש לאחר שינוי `src/`. ראה
> [בנה לפני שה-hooks של הפיתוח בתוך-repo יעבדו](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

בנוי על ידי [Nivedit Jain](https://github.com/NiveditJain) ו-[Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)


</div>