> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | **🇩🇪 Deutsch** | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

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

**Übersetzungen:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observability und Durchsetzung für jede Umgebung, in der deine Agenten laufen.**
Egal wo deine Agenten aktiv sind – wir sehen es und können eingreifen. Failproof bindet sich in 12 Agent-Harnesses ein – Coding-CLIs wie Claude Code und Codex, Chat-Gateways wie Hermes, selbst gehostete Assistenten wie OpenClaw – erfasst jeden Lauf und blockiert gefährliche Tool-Aufrufe, bevor sie ausgeführt werden. 39 integrierte Richtlinien. Keine Latenz. Läuft lokal.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Unterstützte Harnesses

Zwölf Harnesses in zwei Klassen – zehn Coding-CLIs sowie zwei Chat- und Assistenten-Gateways (Hermes, OpenClaw). Eine einzige Policy-API und ein gemeinsamer Sitzungsverlauf für alle. Was eine Richtlinie *blockieren* kann, hängt vom jeweiligen Harness ab: Das Stoppen eines Tool-Aufrufs vor der Ausführung ist für alle zwölf verifiziert, Turn-End-Gates für acht. Die
[harnessspezifische Matrix](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
listet die von jedem unterstützten Ereignisse auf.

Agenten, die in keinem davon laufen, berichten über das [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
das Tracing, Sitzungen und Audits bietet. Für die Durchsetzung dort ist ein Hook in deiner eigenen Runtime nötig – [sprich uns an](mailto:support@befailproof.ai) und wir finden gemeinsam eine Lösung.

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
failproofai config                             # Agenten und Daemon einrichten
failproofai policies add FailproofAI/policies  # Durchsetzungsregeln auswählen
failproofai                                    # Dashboard auf localhost:8020
```

Die Einrichtung verdrahtet die Hooks und aktiviert **keine** Richtlinien – der zweite Befehl ist es, der die Leitplanken auf der Maschine einrichtet. Jedes Paket wird auf dieselbe Weise hinzugefügt
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` liest es zuerst). Führe `failproofai config` ohne Terminal aus – in CI, einem Container oder einem steuernden Agenten – und es wird angewendet, ohne nachzufragen. Auf einer noch nie eingerichteten Maschine startet jeder andere Befehl zuerst denselben Einrichtungsassistenten; deaktiviere das mit `FAILPROOFAI_NO_FIRST_RUN=1`.

Bis ein Paket bereitsteht, ist einzig `block-failproofai-commands` aktiv – diese Richtlinie ist immer eingeschaltet und kann weder deaktiviert noch pausiert werden: Ein Agent, der die Durchsetzung pausieren kann, könnte damit jede andere Richtlinie abschalten.

---

## Was blockiert wird

| Richtlinie | Was sie blockiert |
|---|---|
| `block-env-files` | Lesezugriffe auf `.env` und andere Secret-Dateien |
| `warn-repeated-tool-calls` | Endlosschleifen des Agenten auf demselben Aufruf |
| `block-sudo` | Privilege Escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbegrenzte `DELETE`-Anweisungen |
| `block-terraform` / `block-kubectl` | Nicht überprüfte Änderungen an Live-Infrastruktur |
| `block-rm-rf` | Rekursives Löschen von Dateien |
| `block-force-push` / `block-push-master` | `git push --force`, direkte Pushes auf `main` |

Jede dieser Richtlinien greift *vor* der Ausführung ein und gilt daher für alle zwölf Harnesses. Die ersten vier gelten für jeden Agenten, der Tools aufrufen kann; die letzten drei sind die Favoriten für Entwickler – Coding-CLIs sind die Harness-Klasse, die wir am tiefsten abdecken. Die `sanitize-*`-Familie ist separat: Sie läuft nach der Rückgabe eines Tools und meldet daher Secrets in der Tool-Ausgabe, anstatt sie aus dem Kontext fernzuhalten.

→ [Alle 39 integrierten Richtlinien](https://docs.befailproof.ai/policies/packs)

---

## Eigene Richtlinien

Lege eine Datei in `.failproofai/policies/` ab – sie wird automatisch geladen, ohne zusätzliche Flags. Commit sie und das gesamte Team erhält sie beim nächsten Pull.

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

Jede Richtlinie hat drei mögliche Entscheidungen:

| Entscheidung | Wirkung |
|---|---|
| `allow()` | Aktion erlauben |
| `deny(message)` | Blockieren – die Nachricht wird an den Agenten zurückgegeben |
| `instruct(message)` | Durchlassen, aber dem nächsten Prompt des Agenten Kontext hinzufügen |

→ [Richtlinie schreiben](https://docs.befailproof.ai/policies/editor)

---

## Observability

Durchsetzung ist die eine Hälfte. Die andere Hälfte ist zu sehen, was der Agent tatsächlich getan hat.

Führe `failproofai` ohne Argumente aus und es startet ein Dashboard auf `localhost:8020`,
das den bereits auf deiner Maschine vorhandenen Ausführungsverlauf liest – kein Konto, keine Anmeldung, nichts verlässt die Maschine. Du erhältst die Sitzungsliste, die Abfolge von Modellaufrufen, Tool-Aufrufen und Hook-Entscheidungen innerhalb jedes Laufs, was blockiert wurde und was die Richtlinie dem Agenten mitgeteilt hat, sowie ein Offline-Audit (`failproofai audit`), das deinen Verlauf auf riskante Muster scannt und Richtlinien zu deren Unterbindung vorschlägt.

→ [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[Trace lesen](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Lokales Audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** ist die gehostete Seite desselben Datenmodells, für Teams, die Agenten flottenweit betreiben: alle Läufe aller Harnesses an einem Ort, ein Ausführungsgraph mit parallelen Sub-Agenten auf eigenen Spuren, p50/p95/p99-Latenz für Modelle, Tools und Hooks, modellbezogene Kosten und Context-Window-Tracking, Fehlerverfolgung, SQL über eigene Traces mit teilbaren Dashboards, Bewertungen durch deinen eigenen Service, geplante Audits, die wiederkehrende Fehler in evidenzgestützte Befunde verwandeln, sowie Alerts über Slack, E-Mail oder einen signierten Webhook. Self-Hosting in deinem eigenen Cluster ist im Enterprise-Plan verfügbar.

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Demo buchen](https://befailproof.ai/get-a-demo)

---

## Dokumentation

| Einstieg | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Installieren, Harness verbinden, ersten Lauf ansehen |
| [Konzepte](https://docs.befailproof.ai/start/concepts) | Wie das Hook-System funktioniert |
| [Unterstützte Harnesses](https://docs.befailproof.ai/reference/harnesses) | Alle 12 und was jeder durchsetzen kann |

| Beobachten | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | Einen Lauf verfolgen: Modelle, Tools, Fehler, Latenz |
| [Trace lesen](https://docs.befailproof.ai/sessions/read-a-trace) | Was der Ausführungsgraph dir sagt |
| [Audits](https://docs.befailproof.ai/audits/overview) | Fehlermuster über viele Sitzungen hinweg finden |
| [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, kein Konto erforderlich |

| Durchsetzen | |
|---|---|
| [Richtlinienpakete](https://docs.befailproof.ai/policies/packs) | Die Failproof AI-Richtlinien und Pakete aus dem Policy Hub |
| [Richtlinie schreiben](https://docs.befailproof.ai/policies/editor) | Aus einem Audit heraus oder im Code |
| [Konfiguration](https://docs.befailproof.ai/policies/local-configuration) | Konfigurationsbereiche, Merge-Regeln und Richtlinienparameter |

| Eigenen Agenten instrumentieren | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Läufe von einem Agenten ohne Harness melden |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct`-Referenz |

---

## Lizenz

MIT mit [Commons Clause](https://commonsclause.com/) – kostenlos für den internen und privaten Einsatz; der kommerzielle Weiterverkauf von failproofai selbst erfordert eine separate Vereinbarung. Den vollständigen Text findest du unter [LICENSE](../../LICENSE).

---

## Mitwirken

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md). Neue Richtlinien, Grenzfälle und Übersetzungen sind herzlich willkommen.

> **Vor dem Start bauen.** Führe zuerst `bun install && bun run build` aus. Dieses Repository verwendet failproofais eigene Hooks auf sich selbst, und sie lösen den `failproofai`-Import gegen das kompilierte `dist/`-Bundle auf – ohne einen Build tritt der Hook-Fehler `Cannot find package 'failproofai'` auf. Nach Änderungen an `src/` neu bauen. Siehe
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Mit ❤️ gebaut von [befailproof.ai](https://befailproof.ai) in SF und Bengaluru.
