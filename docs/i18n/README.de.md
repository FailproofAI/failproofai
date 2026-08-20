> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | **🇩🇪 Deutsch** | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**Übersetzungen:** [简体中文](../../docs-old/i18n/README.zh.md) · [日本語](../../docs-old/i18n/README.ja.md) · [한국어](../../docs-old/i18n/README.ko.md) · [Español](../../docs-old/i18n/README.es.md) · [Português](../../docs-old/i18n/README.pt-br.md) · [Deutsch](../../docs-old/i18n/README.de.md) · [Français](../../docs-old/i18n/README.fr.md) · [Руссий](../../docs-old/i18n/README.ru.md) · [हिन्दी](../../docs-old/i18n/README.hi.md) · [Türkçe](../../docs-old/i18n/README.tr.md) · [Tiếng Việt](../../docs-old/i18n/README.vi.md) · [Italiano](../../docs-old/i18n/README.it.md) · [العربية](../../docs-old/i18n/README.ar.md) · [עברית](../../docs-old/i18n/README.he.md)

**Laufzeit-Fehlerbehebung für Coding-Agenten.**
Klinkt sich in Claude Code und Codex ein. Erkennt Endlosschleifen, gefährliche Aktionen und geheime Datenlecks,
bevor sie zum Vorfall werden. Null Latenz. Läuft lokal.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
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

## Installation

```sh
npm install -g failproofai
failproofai policies --install   # oder einfach `failproofai` ausführen und die Erststart-Abfrage bestätigen
failproofai
```

30 integrierte Richtlinien werden sofort aktiviert. Dashboard unter `localhost:8020`. Den Erststart-Hinweis mit `FAILPROOFAI_NO_FIRST_RUN=1` deaktivieren.

---

## Was blockiert wird

| Richtlinie | Was sie blockiert |
|---|---|
| `block-push-master` | Direkte Pushes auf `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, Merges und Rebases auf `main` / `master` |
| `block-rm-rf` | Rekursives Löschen von Dateien |
| `sanitize-api-keys` | API-Schlüssel, die in den Agenten-Kontext gelangen |

→ [Alle 30 integrierten Richtlinien](https://docs.befailproof.ai/policies/builtin)

---

## Eigene Richtlinien

Eine Datei in `.failproofai/policies/` ablegen — sie wird automatisch geladen, ohne zusätzliche Flags.
Ins Repository committen und das gesamte Team erhält sie beim nächsten Pull.

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
| `allow()` | Aktion erlauben |
| `deny(message)` | Blockieren — die Nachricht wird an den Agenten zurückgegeben |
| `instruct(message)` | Durchlassen, aber dem nächsten Prompt des Agenten Kontext hinzufügen |

→ [Anleitung für eigene Richtlinien](https://docs.befailproof.ai/policies/custom)

---

## Sitzungstransparenz

Jeder Tool-Aufruf des Agenten wird lokal protokolliert. Das Dashboard zeigt, was ausgeführt wurde,
was blockiert wurde und was die Richtlinie dem Agenten mitgeteilt hat — damit man nicht rätseln muss,
wenn etwas schiefläuft. → [Dashboard-Anleitung](https://docs.befailproof.ai/sessions/overview)

---

## Dokumentation

| | |
|---|---|
| [Erste Schritte](https://docs.befailproof.ai/start/quickstart) | Installation und Einstieg |
| [Integrierte Richtlinien](https://docs.befailproof.ai/policies/builtin) | Alle 30 Richtlinien mit Parametern |
| [Eigene Richtlinien](https://docs.befailproof.ai/policies/custom) | Eigene Richtlinien schreiben |
| [Konfiguration](https://docs.befailproof.ai/policies/local-configuration) | Konfigurationsbereiche und Zusammenführungsregeln |
| [Dashboard](https://docs.befailproof.ai/sessions/overview) | Sitzungsmonitor und Richtlinienaktivität |
| [Architektur](https://docs.befailproof.ai/start/concepts) | Funktionsweise des Hook-Systems |

---

## Lizenz

MIT mit [Commons Clause](https://commonsclause.com/) — kostenlos für den internen und persönlichen Einsatz; der kommerzielle Weiterverkauf von failproofai selbst erfordert eine gesonderte Vereinbarung. Den vollständigen Text findet man unter [LICENSE](../../LICENSE).

---

## Mitwirken

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md). Neue Richtlinien, Randfälle und Übersetzungen sind herzlich willkommen.

> **Vor dem Start bauen.** Zunächst `bun install && bun run build` ausführen. Dieses Repository verwendet
> failproofais eigene Hooks auf sich selbst, und diese lösen den `failproofai`-Import gegen das
> kompilierte `dist/`-Bundle auf — ohne einen Build kommt es zu `Cannot find package 'failproofai'`-
> Hook-Fehlern. Nach Änderungen an `src/` neu bauen. Siehe
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Gebaut mit ❤️ von [befailproof.ai](https://befailproof.ai) in SF und Bengaluru.
