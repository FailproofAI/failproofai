> **⚠️** هذه ترجمة آلية. للاطلاع على أحدث إصدار، راجع [English README](../../README.md).

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | **🇮🇱 עברית**

---
<div dir="rtl">


```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**תרגומים**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

הדרך הקלה ביותר לנהל מדיניות שמשמרות סוכנים AI אמינים, ממוקדים ופעילים באופן עצמאי - עבור **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ ו-**Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI בפעולה" width="800" />
</p>

## CLIs של סוכנים נתמכים

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> התקן hooks לאחד או לכל שילוב: `failproofai policies --install --cli opencode pi gemini` (או `--cli claude codex copilot cursor opencode pi gemini`). השמט `--cli` לגילוי אוטומטי של CLIs מותקנות ודרישה. **תמיכה ב-GitHub Copilot CLI, Cursor Agent, OpenCode, Pi, ו-Gemini CLI נמצאת בגרסת בטא — בדיקות מתמשכות.**

- **39 מדיניות מובנית** - תופס כישלונות נפוצים של סוכנים מחוץ לתיבה. חסום פקודות הרסניות, מנע דליפת סודות, שמור סוכנים בתחומי פרויקט, גלה לולאות ועוד.
- **מדיניות מותאמת אישית** - כתוב את כללי האמינות שלך ב-JavaScript. השתמש ב-API `allow`/`deny`/`instruct` לאכיפת הנהלים, מניעת סטייה, פעולות שער או שילוב עם מערכות חיצוניות.
- **קונפיגורציה קלה** - כוונן כל מדיניות ללא כתיבת קוד. הגדר רשימות מותר, ענפים מוגנים, סף לפי פרויקט או גלובלי. שלוש מיזוג ההיקפים באופן אוטומטי.
- **מוקד סוכנים** - ראה מה סוכניך עשו כשלא היית שם. עיין בהפעלות, בדוק כל קריאת כלים וסקור בדיוק היכן המדיניות פעלה.

הכל פועל באופן מקומי - אף נתון לא משאיר את המכונה שלך.

---

## דרישות

- Node.js >= 20.9.0
- Bun >= 1.3.0 (אופציונלי - נדרש רק לפיתוח / בנייה מקור)

---

## התקן

```bash
npm install -g failproofai
# או
bun add -g failproofai
```

---

## התחלה מהירה

### 1. הפוך מדיניות לפעילה באופן גלובלי

```bash
failproofai policies --install
```

כותב ערכי hook ל-`~/.claude/settings.json`. Claude Code כעת יקרא ל-failproofai לפני ואחרי כל קריאת כלים.

### 2. השק את לוח הבקרה

```bash
failproofai
```

פותח `http://localhost:8020` - עיין בהפעלות, בדוק יומנים, נהל מדיניות.

### 3. בדוק מה פעיל

```bash
failproofai policies
```

---

## התקנת המדיניות

### היקפים

| היקף | פקודה | איפה זה כותב |
|-------|---------|-----------------|
| גלובלי (ברירת מחדל) | `failproofai policies --install` | `~/.claude/settings.json` |
| פרויקט | `failproofai policies --install --scope project` | `.claude/settings.json` |
| מקומי | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### התקן מדיניות ספציפית

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### הסר מדיניות

```bash
failproofai policies --uninstall
# או עבור היקף ספציפי:
failproofai policies --uninstall --scope project
```

---

## קונפיגורציה

קונפיגורציית המדיניות נמצאת ב-`~/.failproofai/policies-config.json` (גלובלי) או `.failproofai/policies-config.json` בפרויקט שלך (לכל פרויקט).

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "השתמש ב-apt-get ישירות ללא sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "נסה ליצור ענף חדש במקום."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**שלוש היקפי קונפיגורציה** מוזגים באופן אוטומטי (פרויקט → מקומי → גלובלי). ראה [docs/configuration.mdx](docs/configuration.mdx) לכללי מיזוג מלאים.

---

## מדיניות מובנית

| מדיניות | תיאור | ניתן להגדרה |
|--------|-------------|:---:|
| `block-sudo` | מנע מסוכנים הרצת פקודות מערכת מוגנות | `allowPatterns` |
| `block-rm-rf` | מנע מחיקה רקורסיבית של קבצים בטעות | `allowPaths` |
| `block-curl-pipe-sh` | מנע מסוכנים להעביר סקריפטים שאינם מהימנים ל-shell | |
| `block-failproofai-commands` | מנע הסרת התקנה עצמית | |
| `sanitize-jwt` | עצור דלפי JWT tokens להקשר של סוכן | |
| `sanitize-api-keys` | עצור דלפי מפתחות API להקשר של סוכן | `additionalPatterns` |
| `sanitize-connection-strings` | עצור דלפי אישורי מסד נתונים להקשר של סוכן | |
| `sanitize-private-key-content` | שחזר חסימות מפתח PEM פרטי מפלט | |
| `sanitize-bearer-tokens` | שחזר אישור Bearer tokens מפלט | |
| `block-env-files` | שמור סוכנים מקריאת קבצי .env | |
| `protect-env-vars` | מנע מסוכנים הדפסת משתנים סביבה | |
| `block-read-outside-cwd` | שמור סוכנים בתוך גבולות פרויקט | `allowPaths` |
| `block-secrets-write` | מנע כתיבה לקבצי מפתח פרטי ותעודות | `additionalPatterns` |
| `block-push-master` | מנע דחיקה בטעות ל-main/master | `protectedBranches` |
| `block-work-on-main` | שמור סוכנים מענפים מוגנים | `protectedBranches` |
| `block-force-push` | מנע `git push --force` | |
| `warn-git-amend` | הזכר לסוכנים לפני תיקון התחייבויות | |
| `warn-git-stash-drop` | הזכר לסוכנים לפני הסרת stashes | |
| `warn-all-files-staged` | תופס בטעות `git add -A` | |
| `warn-destructive-sql` | תופס SQL DROP/DELETE לפני ביצוע | |
| `warn-schema-alteration` | תופס ALTER TABLE לפני ביצוע | |
| `warn-large-file-write` | תופס כתיבות קבצים גדולות בצורה בלתי צפויה | `thresholdKb` |
| `warn-package-publish` | תופס בטעות `npm publish` | |
| `warn-background-process` | תופס הפעלות תהליך רקע שלא במתוכנן | |
| `warn-global-package-install` | תופס התקנות חבילה גלובליות שלא במתוכנן | |
| …ועוד | | |

פרטי מדיניות מלאים ויחוס פרמטרים: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## מדיניות מותאמת אישית

כתוב מדיניות משלך כדי לשמור על סוכנים אמינים וממוקדים:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "חסום כתיבה לנתיבים המכילים production",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("כתיבה לנתיבי production חסומה");
    return allow();
  },
});
```

התקן עם:

```bash
failproofai policies --install --custom ./my-policies.js
```

### עוזרי החלטה

| פונקציה | השפעה |
|----------|--------|
| `allow()` | אשר את הפעולה |
| `allow(message)` | אשר ושלח הקשר מידע ל-Claude |
| `deny(message)` | חסום את הפעולה; הודעה מוצגת ל-Claude |
| `instruct(message)` | הוסף הקשר להנחיית Claude; לא חוסם |

### אובייקט הקשר (`ctx`)

| שדה | סוג | תיאור |
|-------|------|-------------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | כלי שמקבל קריאה (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | פרמטרי קלט של הכלי |
| `payload` | `object` | עומס אירוע גולמי מלא |
| `session.cwd` | `string` | תיקייה עובדת של הפעלת Claude Code |
| `session.sessionId` | `string` | מזהה הפעלה |
| `session.transcriptPath` | `string` | נתיב לקובץ תלמוד ההפעלה |

hook מותאם אישית תומך בייבוא מקומי חולף, async/await, וגישה ל-`process.env`. שגיאות הן fail-open (מעובדות ל-`~/.failproofai/hook.log`, מדיניות מובנית ממשיכות). ראה [docs/custom-hooks.mdx](docs/custom-hooks.mdx) לגיד מלא.

### מדיניות מבוססות הנוהג

הפל קבצי `*policies.{js,mjs,ts}` ל-`.failproofai/policies/` והם נטענים באופן אוטומטי - אין צורך בדגלים או שינויי קונפיגורציה. עשה commit לתיקייה ל-git וכל חברי צוות מקבלים את אותם סטנדרטים באיכות באופן אוטומטי.

```text
# רמת פרויקט — committed to git, משותף עם הצוות
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# רמת משתמש — אישית, חלה על כל הפרוייקטים
~/.failproofai/policies/my-policies.mjs
```

שתי הרמות נטענות (union). קבצים נטענים בסדר אלפבתי בכל תיקייה. הקדם עם `01-`, `02-`, וכו'. כדי לשלוט בסדר. כשהצוות שלך גוכח כישלונות חדשים, הוסף מדיניות ודחוף — כולם מקבלים את העדכון ב-pull הבא שלהם. ראה [examples/convention-policies/](examples/convention-policies/) לדוגמאות מוכנות לשימוש.

---

## טלימטריה

Failproof AI אוגר טלמטריה שימוש אנונימית דרך PostHog כדי להבין שימוש בתכונות. לא תוכן הפעלה, שמות קבצים, קלטי כלים או מידע אישי נשלחים אי פעם.

השבית זאת:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## דוקומנטציה

| מדריך | תיאור |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | התקנה והצעדים הראשונים |
| [Built-in Policies](docs/built-in-policies.mdx) | כל 39 המדיניות המובנות עם פרמטרים |
| [Custom Policies](docs/custom-policies.mdx) | כתוב את המדיניות שלך |
| [Configuration](docs/configuration.mdx) | פורמט קובץ קונפיגורציה ומיזוג היקף |
| [Dashboard](docs/dashboard.mdx) | עקוב אחר הפעלות וסקור פעילות מדיניות |
| [Architecture](docs/architecture.mdx) | כיצד מערכת ה-hook פועלת |
| [Testing](docs/testing.mdx) | הרץ בדיקות וכתוב חדשות |

### הרץ תיעוד באופן מקומי

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

פותח את אתר Mintlify docs ב-`http://localhost:3000`. המכל צפה בשינויים אם תחבור את תיקייה התיעוד:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## הערה לתורמים של failproofai

`.claude/settings.json` של repo זה משתמש ב-`bun ./bin/failproofai.mjs --hook <EventType>` במקום הפקודה הסטנדרטית `npx -y failproofai`. זה בגלל שהרץ `npx -y failproofai` בתוך פרויקט failproofai עצמו יוצר סכסוך הנוגע לעצמו.

עבור כל ה-repos אחרים, הגישה המומלצת היא `npx -y failproofai`, מותקנת דרך:

```bash
failproofai policies --install --scope project
```

## תרומה

ראה [CONTRIBUTING.md](CONTRIBUTING.md).

---

## ראשון

ראה [LICENSE](LICENSE).

---

בנוי ותחזוקה מ-**ExosphereHost: Reliability Research Lab for Your Agents**. אנחנו עוזרים לחברות וסטארטאפים לשפר את אמינות סוכני AI שלהם דרך הסוכנים שלנו, תוכנה ומומחיות. למידע נוסף ב-[exosphere.host](https://exosphere.host).


</div>