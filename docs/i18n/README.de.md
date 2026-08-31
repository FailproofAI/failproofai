> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | **🇩🇪 Deutsch** | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

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

**Übersetzungen:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observability und Durchsetzung für jede Umgebung, in der Ihre Agents laufen.**
Egal wo Ihre Agents laufen – wir sehen es und können eingreifen. Failproof unterstützt 12 Agent-Umgebungen (Harnesses) — Coding-CLIs wie Claude Code und Codex, Chat-Gateways wie Hermes, selbst gehostete Assistenten wie OpenClaw — erfasst jeden Lauf und blockiert gefährliche Tool-Aufrufe, bevor sie ausgeführt werden. 39 eingebaute Richtlinien. Null Latenz. Läuft lokal.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Unterstützte Harnesses

Zwölf Harnesses in zwei Klassen — zehn Coding-CLIs und zwei Chat- und Assistenten-Gateways (Hermes, OpenClaw). Gleiche Events, gleiche Richtlinien, gleiche Sitzungshistorie — unabhängig davon, in welcher Umgebung Ihr Agent läuft.

Agents, die in keiner dieser Umgebungen laufen, berichten über das [Python SDK](https://docs.befailproof.ai/reference/custom-agents), das Tracing, Sitzungen und Audits bietet. Für die Durchsetzung dort benötigen Sie einen Hook in Ihrer eigenen Laufzeitumgebung — [sprechen Sie uns an](mailto:support@befailproof.ai) und wir helfen Ihnen dabei.

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
failproofai policies --install   # oder einfach `failproofai` ausführen und die Erststart-Eingabeaufforderung bestätigen
failproofai
```

39 eingebaute Richtlinien werden sofort aktiviert. Dashboard unter `localhost:8020`. Den Erststart-Dialog deaktivieren Sie mit `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Was es verhindert

| Richtlinie | Was wird blockiert |
|---|---|
| `sanitize-api-keys` | API-Schlüssel, die in den Kontext des Agents gelangen |
| `block-env-files` | Lesezugriffe auf `.env` und andere Secret-Dateien |
| `warn-repeated-tool-calls` | Agent-Schleifen beim selben Aufruf |
| `block-sudo` | Privilege Escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbegrenzte `DELETE`-Anweisungen |
| `block-terraform` / `block-kubectl` | Nicht geprüfte Änderungen an produktiver Infrastruktur |
| `block-rm-rf` | Rekursives Löschen von Dateien |
| `block-force-push` / `block-push-master` | `git push --force`, direkte Pushes auf `main` |

Die ersten fünf gelten für jeden Agent, der Tools aufrufen kann. Die letzten drei sind die Favoriten unter Entwicklern — Coding-CLIs sind die Harness-Klasse, die wir am tiefsten abdecken.

→ [Alle 39 eingebauten Richtlinien](https://docs.befailproof.ai/policies/builtin)

---

## Eigene Richtlinien

Legen Sie eine Datei in `.failproofai/policies/` ab — sie wird automatisch geladen, ohne Flags. Committen Sie sie, und das gesamte Team erhält sie beim nächsten Pull.

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

Jede Richtlinie kann eine von drei Entscheidungen treffen:

| Entscheidung | Wirkung |
|---|---|
| `allow()` | Operation erlauben |
| `deny(message)` | Blockieren — die Nachricht wird an den Agent zurückgegeben |
| `instruct(message)` | Durchlassen, aber dem nächsten Prompt des Agents Kontext hinzufügen |

→ [Leitfaden für eigene Richtlinien](https://docs.befailproof.ai/policies/custom)

---

## Observability

Durchsetzung ist die eine Hälfte. Die andere Hälfte ist zu sehen, was der Agent tatsächlich getan hat.

Führen Sie `failproofai` ohne Argumente aus, und es startet ein Dashboard auf `localhost:8020`, das die bereits auf Ihrem Rechner vorhandene Verlaufshistorie ausliest — kein Konto, keine Registrierung, nichts verlässt Ihren Rechner. Sie erhalten die Sitzungsliste, die Abfolge von Modell-Aufrufen, Tool-Aufrufen und Hook-Entscheidungen innerhalb jedes Laufs, was blockiert wurde und was die Richtlinie dem Agent mitgeteilt hat, sowie ein Offline-Audit (`failproofai audit`), das Ihre Historie nach riskanten Mustern durchsucht und Richtlinien vorschlägt, um diese zu unterbinden.

→ [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[Eine Ablaufverfolgung lesen](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Lokales Audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** ist die gehostete Seite desselben Datenmodells, für Teams, die Agents in einer ganzen Flotte betreiben: jeder Lauf aus jeder Harness an einem Ort, ein Ausführungsgraph mit parallelen Sub-Agents auf eigenen Spuren, p50/p95/p99-Latenz für Modelle, Tools und Hooks, modellbezogenes Kosten- und Kontextfenster-Tracking, Fehlerverfolgung, SQL über Ihre eigenen Traces mit teilbaren Dashboards, Evaluierungen bewertet durch Ihren eigenen Dienst, geplante Audits, die wiederkehrende Fehler in evidenzbasierte Befunde umwandeln, sowie Benachrichtigungen an Slack, E-Mail oder einen signierten Webhook. Self-Hosting im eigenen Cluster ist im Enterprise-Plan verfügbar.

→ [Sitzungen](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Demo buchen](https://befailproof.ai/get-a-demo)

---

## Dokumentation

| Einstieg | |
|---|---|
| [Schnellstart](https://docs.befailproof.ai/start/quickstart) | Installieren, eine Harness verbinden, den ersten Lauf ansehen |
| [Konzepte](https://docs.befailproof.ai/start/concepts) | Wie das Hook-System funktioniert |
| [Unterstützte Harnesses](https://docs.befailproof.ai/reference/harnesses) | Alle 12 und was jede davon durchsetzen kann |

| Beobachten | |
|---|---|
| [Sitzungen](https://docs.befailproof.ai/sessions/overview) | Einem Lauf folgen: Modelle, Tools, Fehler, Latenz |
| [Eine Ablaufverfolgung lesen](https://docs.befailproof.ai/sessions/read-a-trace) | Was der Ausführungsgraph Ihnen mitteilt |
| [Audits](https://docs.befailproof.ai/audits/overview) | Fehlermuster über viele Sitzungen hinweg finden |
| [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, kein Konto erforderlich |

| Durchsetzen | |
|---|---|
| [Eingebaute Richtlinien](https://docs.befailproof.ai/policies/builtin) | Alle 39 Richtlinien mit Parametern |
| [Eigene Richtlinien](https://docs.befailproof.ai/policies/custom) | Schreiben Sie Ihre eigenen |
| [Konfiguration](https://docs.befailproof.ai/policies/local-configuration) | Konfigurations-Scopes und Zusammenführungsregeln |

| Eigenen Agent instrumentieren | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Läufe von einem Agent ohne Harness melden |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` Referenz |

---

## Lizenz

MIT mit [Commons Clause](https://commonsclause.com/) — kostenlos für den internen und privaten Einsatz; der kommerzielle Weiterverkauf von failproofai selbst erfordert eine gesonderte Vereinbarung. Den vollständigen Text finden Sie unter [LICENSE](../../LICENSE).

---

## Mitwirken

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md). Neue Richtlinien, Randfälle und Übersetzungen sind herzlich willkommen.

> **Vor dem Start bauen.** Führen Sie zuerst `bun install && bun run build` aus. Dieses Repository verwendet failproofai's eigene Hooks auf sich selbst, und diese lösen den `failproofai`-Import gegen das kompilierte `dist/`-Bundle auf — ohne einen Build erhalten Sie `Cannot find package 'failproofai'`-Hook-Fehler. Nach Änderungen in `src/` neu bauen. Siehe
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Gebaut mit ❤️ von [befailproof.ai](https://befailproof.ai) in SF und Bengaluru.
