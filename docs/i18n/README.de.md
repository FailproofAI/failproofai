> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | **🇩🇪 Deutsch** | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Übersetzungen:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Laufzeit-Fehlerbehebung für Coding-Agenten.**
Klinkt sich in Claude Code und Codex ein. Erkennt Schleifen, gefährliche Aktionen und Secret-Leaks,
bevor sie zu Vorfällen werden. Nulllatenz. Läuft lokal.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Unterstützte Agenten-CLIs

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
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

> Hooks für eine oder mehrere Kombinationen installieren: `failproofai policies --install --cli opencode pi` (oder `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). `--cli` weglassen, um installierte CLIs automatisch zu erkennen und eine Auswahl anzuzeigen.
>
> **Hermes** (hermes-agent, ein Slack/Telegram-Gateway) wird sowohl für **Live-Hook-Durchsetzung** (`--cli hermes` — eine Installation fängt Tool-Aufrufe von jeder Plattform und jedem Subagenten ab) als auch für die Offline-**Audit**-Wiedergabe seiner Gateway-Sitzungen aus der einzelnen `~/.hermes/state.db` unterstützt.
>
> **OpenClaw** (openclaw gateway, ein selbst gehosteter Multi-Channel-Assistent) wird sowohl für **Live-Hook-Durchsetzung** (`--cli openclaw`, User-Scope) als auch für die Offline-**Audit**-Wiedergabe seiner JSONL-Sitzungen (`~/.openclaw/agents/<id>/sessions/*.jsonl`) unterstützt. Die Durchsetzung nutzt OpenClaws **In-Process-Plugin-Hooks** (ein mitgeliefertes `openclaw-plugin/`, das failproofai asynchron startet — seine dateibasierten internen Hooks dienen nur zur Beobachtung und können nicht blockieren): `before_tool_call` blockiert ein Tool, und `before_agent_finalize` ist ein echtes Turn-End-Gate, sodass die eingebauten `require-*-before-stop`-Regeln greifen.
>
> **Factory Droid** (`droid`) wird sowohl für **Live-Hook-Durchsetzung** (`--cli factory`, User- und Project-Scope) als auch für die Offline-**Audit**-Wiedergabe seiner JSONL-Sitzungen auf der Festplatte unterstützt. droid blockiert Tool-Aufrufe über Hook-**Exit-Code 2** (kein JSON-Entscheid) und berücksichtigt `{decision:"block"}` nur beim Turn-End-`Stop`-Event — failproofai gibt automatisch die passende Form je nach Event aus.
>
> **Devin CLI** (`devin`, Cognition) wird sowohl für **Live-Hook-Durchsetzung** (`--cli devin`, User- und Project-Scope) als auch für die Offline-**Audit**-Wiedergabe seiner SQLite-Sitzungen (`~/.local/share/devin/cli/sessions.db`) unterstützt. Devin ist ein **reiner Claude-Klon** — gleiche Event-Namen, gleiche snake_case-Payload, gleiche `"hooks"`-Wrapper-Konfiguration (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — Blockierung via `{decision:"block"}` JSON bei jedem Event.
>
> **Antigravity CLI** (`agy`) wird sowohl für **Live-Hook-Durchsetzung** (`--cli antigravity`, User- und Project-Scope) als auch für die Offline-**Audit**-Wiedergabe seiner Plain-JSONL-Sitzungen (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`) unterstützt. Antigravity hat seinen **eigenen** Vertrag (kein Claude-Klon): ein **Named-Hook**-`hooks.json`-Schema (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), eine camelCase-stdin-Payload, die failproofai normalisiert, und eigene Antwortformate — `{decision:"deny"}` zum Blockieren eines Tools, `{decision:"continue"}` um einen weiteren Turn bei `Stop` zu erzwingen, `{injectSteps}` zum Einschleusen einer Erinnerung vor dem Modell-Lauf.
>
> **Goose** (Codename goose, Block) wird sowohl für **Live-Hook-Durchsetzung** (`--cli goose`, User- und Project-Scope) als auch für die Offline-**Audit**-Wiedergabe seiner SQLite-Sitzungen (`~/.local/share/goose/sessions/sessions.db`) unterstützt. Die Durchsetzung nutzt Gooses **Hooks**-System (die agentenübergreifende **Open-Plugins**-Spezifikation) — das Installationsprogramm legt lediglich ein Plugin-Verzeichnis unter `~/.agents/plugins/failproofai/` an, das Goose automatisch erkennt. Die Blockierung erfolgt via `{"decision":"block"}` JSON beim `PreToolUse`-Event (das für das Shell-Tool und innerhalb delegierter Subagenten ausgelöst wird), live verifiziert gegen goose v1.43.0; Goose hat kein Turn-End-`Stop`-Event, daher gelten die eingebauten `require-*-before-stop`-Regeln nicht (wie bei Hermes).

---

## Installation

```sh
npm install -g failproofai
failproofai policies --install   # oder einfach `failproofai` ausführen und den Erststart-Dialog bestätigen
failproofai
```

30 eingebaute Richtlinien werden sofort aktiviert. Dashboard unter `localhost:8020`. Den Erststart-Dialog mit `FAILPROOFAI_NO_FIRST_RUN=1` deaktivieren.

---

## Was es verhindert

| Richtlinie | Was sie blockiert |
|---|---|
| `block-push-master` | Direkte Pushes auf `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, Merges, Rebases auf `main` / `master` |
| `block-rm-rf` | Rekursives Löschen von Dateien |
| `sanitize-api-keys` | API-Keys, die in den Agenten-Kontext gelangen |

→ [Alle 30 eingebauten Richtlinien](https://docs.befailproof.ai/built-in-policies)

---

## Eigene Richtlinien

Eine Datei in `.failproofai/policies/` ablegen — sie wird automatisch geladen, ohne zusätzliche Flags.
Ins Repository committen, und das gesamte Team erhält sie beim nächsten Pull.

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

Drei Entscheidungen stehen jeder Richtlinie zur Verfügung:

| Entscheidung | Wirkung |
|---|---|
| `allow()` | Aktion zulassen |
| `deny(message)` | Blockieren — die Nachricht wird an den Agenten zurückgegeben |
| `instruct(message)` | Durchlassen, aber dem nächsten Prompt des Agenten Kontext hinzufügen |

→ [Leitfaden für benutzerdefinierte Richtlinien](https://docs.befailproof.ai/custom-policies)

---

## Sitzungstransparenz

Jeder Tool-Aufruf des Agenten wird lokal protokolliert. Das Dashboard zeigt, was ausgeführt wurde,
was blockiert wurde und was die Richtlinie dem Agenten mitgeteilt hat — damit man nicht rätseln muss,
wenn etwas schiefgeht. → [Dashboard-Leitfaden](https://docs.befailproof.ai/dashboard)

---

## Dokumentation

| | |
|---|---|
| [Erste Schritte](https://docs.befailproof.ai/getting-started) | Installation und Einstieg |
| [Eingebaute Richtlinien](https://docs.befailproof.ai/built-in-policies) | Alle 30 Richtlinien mit Parametern |
| [Benutzerdefinierte Richtlinien](https://docs.befailproof.ai/custom-policies) | Eigene Richtlinien schreiben |
| [Konfiguration](https://docs.befailproof.ai/configuration) | Konfigurations-Scopes und Zusammenführungsregeln |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Sitzungsmonitor und Richtlinienaktivität |
| [Architektur](https://docs.befailproof.ai/architecture) | Funktionsweise des Hook-Systems |

---

## Lizenz

MIT mit [Commons Clause](https://commonsclause.com/) — kostenlos für den internen und persönlichen Einsatz; der kommerzielle Weiterverkauf von failproofai selbst erfordert eine gesonderte Vereinbarung. Den vollständigen Text unter [LICENSE](./LICENSE) nachlesen.

---

## Mitwirken

Siehe [CONTRIBUTING.md](./CONTRIBUTING.md). Neue Richtlinien, Grenzfälle und Übersetzungen sind jederzeit willkommen.

> **Vor dem Start bauen.** Zunächst `bun install && bun run build` ausführen. Dieses Repository führt
> failproofais eigene Hooks auf sich selbst aus, und diese lösen den `failproofai`-Import gegenüber dem
> kompilierten `dist/`-Bundle auf — ohne einen Build tritt der Hook-Fehler `Cannot find package 'failproofai'` auf.
> Nach Änderungen in `src/` neu bauen. Siehe
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Entwickelt von [Nivedit Jain](https://github.com/NiveditJain) und [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
