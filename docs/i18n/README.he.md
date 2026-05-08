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

הדרך הקלה ביותר לנהל מדיניות שמשמרת את סוכניך בינות מהימנים, ממוקדים וריצים באופן אוטונומי - עבור **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ וה-**Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI בפעולה" width="800" />
</p>

## סוכני CLI נתמכים

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

> התקן hooks לאחד או לשילוב כלשהו: `failproofai policies --install --cli opencode pi gemini` (או `--cli claude codex copilot cursor opencode pi gemini`). השמט `--cli` לגילוי אוטומטי של CLI מותקנים וקבלת הנחיות. **תמיכת GitHub Copilot CLI, Cursor Agent, OpenCode, Pi ו-Gemini CLI נמצאת בגרסת בטא — בדיקות מתמשכות.**

- **39 מדיניות מובנית** - תפס מצבי כשל נפוצים של סוכן תיכף. חסום פקודות הרסניות, מנע דליפת סודות, שמור סוכנים בתוך גבולות הפרוייקט, גלה לולאות ועוד.
- **מדיניות מותאמת אישית** - כתוב חוקי אמינות משלך ב-JavaScript. השתמש ב-API `allow`/`deny`/`instruct` לכפיית קונוונציות, מניעת סטייה, שערי פעולות או אינטגרציה עם מערכות חיצוניות.
- **תצורה קלה** - כוונן כל מדיניות ללא כתיבת קוד. קבע allowlists, ענפים מוגנים, סף לכל פרוייקט או באופן גלובלי. שלוש היקפי תצורה מתמזגים באופן אוטומטי.
- **Agent Monitor** - ראה מה עשו סוכניך בזמן שהיית בחוץ. עיין בהפעלות, בדוק כל קריאת כלי, ובדוק בדיוק איפה מדיניות הופעלה.

הכל יעבוד באופן מקומי - שום מידע לא משאיר את המכונה שלך.

---

## דרישות

- Node.js >= 20.9.0
- Bun >= 1.3.0 (אופציונלי - נדרש רק לפיתוח / בנייה מקוד מקור)

---

## התקן

```bash
npm install -g failproofai
# או
bun add -g failproofai
```

---

## התחלה מהירה

### 1. הפעל מדיניות באופן גלובלי

```bash
failproofai policies --install
```

כותב ערכי hook ל-`~/.claude/settings.json`. Claude Code כעת יגיד ל-failproofai להפעיל לפני ואחרי כל קריאת כלי.

### 2. הפעל את לוח השליטה

```bash
failproofai
```

פותח `http://localhost:8020` - עיין בהפעלות, בדוק יומנים, נהל מדיניות.

### 3. בדוק מה פעיל

```bash
failproofai policies
```

---

## התקנת מדיניות

### היקפים

| היקף | פקודה | איפה זה כותב |
|-------|---------|-----------------|
| גלובלי (ברירת מחדל) | `failproofai policies --install` | `~/.claude/settings.json` |
| פרוייקט | `failproofai policies --install --scope project` | `.claude/settings.json` |
| מקומי | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### התקן מדיניות ספציפיות

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

## תצורה

תצורת מדיניות חיה ב-`~/.failproofai/policies-config.json` (גלובלי) או ב-`.failproofai/policies-config.json` בפרוייקט שלך (לכל פרוייקט).

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
      "hint": "נסה ליצור ענף חדש במקום זאת."
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

**שלוש היקפי תצורה** מתמזגים באופן אוטומטי (פרוייקט → מקומי → גלובלי). ראה [docs/configuration.mdx](docs/configuration.mdx) לכללי מיזוג מלאים.

---

## מדיניות מובנית

| מדיניות | תיאור | ניתן להתאמה אישית |
|--------|-------------|:---:|
| `block-sudo` | מנע סוכנים מהפעלת פקודות מערכת מובחרות | `allowPatterns` |
| `block-rm-rf` | מנע מחיקת קבצים רקורסיבית בשוגג | `allowPaths` |
| `block-curl-pipe-sh` | מנע סוכנים מהעברת סקריפטים לא מהימנים לשל | |
| `block-failproofai-commands` | מנע הסרה עצמית | |
| `sanitize-jwt` | עצור אסימוני JWT מדליפים להקשר הסוכן | |
| `sanitize-api-keys` | עצור מפתחות API מדליפים להקשר הסוכן | `additionalPatterns` |
| `sanitize-connection-strings` | עצור אישורי מסד נתונים מדליפים להקשר הסוכן | |
| `sanitize-private-key-content` | הסתר בלוקים פרטיים PEM מהפלט | |
| `sanitize-bearer-tokens` | הסתר אסימוני Authorization Bearer מהפלט | |
| `block-env-files` | שמור סוכנים מקריאת קבצי .env | |
| `protect-env-vars` | מנע סוכנים מהדפסת משתני סביבה | |
| `block-read-outside-cwd` | שמור סוכנים בתוך גבולות הפרוייקט | `allowPaths` |
| `block-secrets-write` | מנע כתיבות לקבצי מפתח פרטיים ותעודות | `additionalPatterns` |
| `block-push-master` | מנע דחיפות בשוגג ל-main/master | `protectedBranches` |
| `block-work-on-main` | שמור סוכנים מענפים מוגנים | `protectedBranches` |
| `block-force-push` | מנע `git push --force` | |
| `warn-git-amend` | הזכר סוכנים לפני תיקון commits | |
| `warn-git-stash-drop` | הזכר סוכנים לפני זריקת stashes | |
| `warn-all-files-staged` | תופס `git add -A` בשוגג | |
| `warn-destructive-sql` | תופס DROP/DELETE SQL לפני ביצוע | |
| `warn-schema-alteration` | תופס ALTER TABLE לפני ביצוע | |
| `warn-large-file-write` | תופס כתיבות קבצים גדולות בהפתעה | `thresholdKb` |
| `warn-package-publish` | תופס `npm publish` בשוגג | |
| `warn-background-process` | תופס השקות תהליכים רקע לא מכוונות | |
| `warn-global-package-install` | תופס התקנות חבילה גלובליות לא מכוונות | |
| …ועוד | | |

פרטי מדיניות מלאים והפניית פרמטרים: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## מדיניות מותאמת אישית

כתוב מדיניות משלך לשמירה על סוכנים אמינים וממוקדים:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "חסום כתיבות לנתיבים המכילים production",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("כתיבות לנתיבי production חסומות");
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
| `allow()` | אפשר את הפעולה |
| `allow(message)` | אפשר וישלח הקשר מידע ל-Claude |
| `deny(message)` | חסום את הפעולה; הודעה מוצגת ל-Claude |
| `instruct(message)` | הוסף הקשר לפרומפט של Claude; לא חוסם |

### אובייקט הקשר (`ctx`)

| שדה | סוג | תיאור |
|-------|------|-------------|
| `eventType` | `string` | `PreToolUse`, `PostToolUse`, `Notification`, `Stop` |
| `toolName` | `string` | כלי בקריאה (`Bash`, `Write`, `Read`, …) |
| `toolInput` | `object` | פרמטרי קלט של הכלי |
| `payload` | `object` | מטען אירוע גולמי מלא |
| `session.cwd` | `string` | ספריית עבודה של הפעלת Claude Code |
| `session.sessionId` | `string` | מזהה הפעלה |
| `session.transcriptPath` | `string` | נתיב לקובץ תמלול ההפעלה |

hook מותאמים תומכים ייבוא מקומי טרנזיטיבי, async/await וגישה ל-`process.env`. שגיאות נפתחות בנדיבות (רשומות ל-`~/.failproofai/hook.log`, מדיניויות מובנית ממשיכות). ראה [docs/custom-hooks.mdx](docs/custom-hooks.mdx) לגיד המלא.

### מדיניויות מבוססות קונוונציה

זרוק קבצי `*policies.{js,mjs,ts}` ל-`.failproofai/policies/` והם נטענים באופן אוטומטי — אין צורך בדגלים או שינויי תצורה. בצור את הספרייה ל-git וכל חברה בצוות מקבלת את אותם תקנים איכות באופן אוטומטי.

```text
# רמת פרוייקט — מובהקת ל-git, משותפת עם הצוות
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# רמת משתמש — אישית, חלה על כל הפרוייקטים
~/.failproofai/policies/my-policies.mjs
```

שתי הרמות נטענות (איחוד). קבצים נטענים בסדר אלפביתי בכל ספרייה. התחל עם `01-`, `02-` וכו' כדי לשלוט בסדר. כאשר הצוות שלך גילה מצבי כשל חדשים, הוסף מדיניות ודחוף — כולם מקבלים את העדכון ב-pull הבא שלהם. ראה [examples/convention-policies/](examples/convention-policies/) לדוגמאות מוכנות לשימוש.

---

## טלימטריה

Failproof AI אוספת טלימטריה שימוש אנונימית דרך PostHog כדי להבין שימוש בתכונות. שום תוכן הפעלה, שמות קבצים, קלטי כלים או מידע אישי לא נשלחים אי פעם.

השבית זאת:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## דוקומנטציה

| מדריך | תיאור |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | התקנה וצעדים ראשונים |
| [Built-in Policies](docs/built-in-policies.mdx) | כל 39 מדיניויות מובנית עם פרמטרים |
| [Custom Policies](docs/custom-policies.mdx) | כתוב את המדיניויות שלך |
| [Configuration](docs/configuration.mdx) | פורמט קובץ תצורה ומיזוג היקף |
| [Dashboard](docs/dashboard.mdx) | מנטור הפעלות וסקור פעילות מדיניות |
| [Architecture](docs/architecture.mdx) | איך מערכת ה-hook עובדת |
| [Testing](docs/testing.mdx) | הפעל בדיקות וכתוב חדשות |

### הפעל docs באופן מקומי

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

פותח את אתר ה-Mintlify docs ב-`http://localhost:3000`. הקונטיינר מתראה לשינויים אם אתה מעמיד את ספריית ה-docs:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## הערה לתורמי failproofai

ה-`.claude/settings.json` של המאגר הזה משתמש ב-`bun ./bin/failproofai.mjs --hook <EventType>` במקום בפקודה `npx -y failproofai` הסטנדרטית. זה מכיוון שהפעלת `npx -y failproofai` בתוך פרוייקט failproofai עצמו יוצרת קונפליקט עצמי-הפניה.

לכל המאגרים האחרים, הגישה המומלצת היא `npx -y failproofai`, המותקנת דרך:

```bash
failproofai policies --install --scope project
```

## תרומה

ראה [CONTRIBUTING.md](CONTRIBUTING.md).

---

## ראשון

ראה [LICENSE](LICENSE).

---

בנוי ותחזוקה על ידי **ExosphereHost: Reliability Research Lab for Your Agents**. אנחנו עוזרים לארגונים וסטארטאפים לשפר את האמינות של סוכניהם בינות דרך סוכנים, תוכנה ומומחיות משלנו. למד עוד ב-[exosphere.host](https://exosphere.host).
```


</div>