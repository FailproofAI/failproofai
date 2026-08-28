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

**Sieh, was deine Agenten tun. Stoppe bekannte Fehler, bevor sie sich wiederholen.**
Failproof AI funktioniert überall, wo deine Agenten laufen: Coding-Tools wie Claude Code und
Codex, Chat-Gateways wie Hermes, selbst gehostete Assistenten wie OpenClaw sowie Agenten,
die du selbst instrumentierst. Es zeichnet jeden Lauf auf und kann gefährliche Tool-Aufrufe
blockieren, bevor sie ausgeführt werden.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Unterstützte Harnesses

Zwölf Harnesses in zwei Klassen werden unterstützt: zehn Coding-CLIs sowie zwei
Gateways: Hermes, OpenClaw. Die Policy-API und der Sitzungsverlauf werden gemeinsam genutzt;
welche Ereignisse blockiert werden können, variiert je nach Harness.

Agenten, die in keinem davon laufen, berichten über das [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
das dir Tracing, Sitzungen und Audits bietet. Durchsetzung erfordert dort einen Hook in
deiner eigenen Laufzeitumgebung — [sprich uns an](mailto:support@befailproof.ai) und wir werden es einrichten.

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

Gib einem kompatiblen Agenten die Failproof AI-Skill, damit er die Einrichtung begleitet,
das System inspiziert und Policy-, Audit-, Sitzungs- sowie Cloud-Aufgaben korrekt weiterleitet:

```sh
npx skills add FailproofAI/skills
```

Dies installiert die übergeordnete Skill und ihre spezialisierten Geschwister. Um nur die
übergeordnete Skill zu installieren, füge `--skill failproofai` hinzu. Skills liefern Betriebsanweisungen;
das Produkt selbst installierst und konfigurierst du mit:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

Die Einrichtung verbindet unterstützte Agenten und installiert den Hintergrunddienst. Es wird
kein Policy-Pack ausgewählt: Bevor du eines hinzufügst, läuft nur `block-failproofai-commands`, um
zu verhindern, dass ein Agent Failproof AI deaktiviert.

Verbinde Cloud ohne Rückfragen mit `failproofai config --token <machine-key>`. Auf einem
gemeinsam genutzten Rechner oder in CI setze `FAILPROOFAI_CLOUD_TOKEN` und führe `failproofai config`
aus, damit der Schlüssel nicht im Befehlsverlauf erscheint.

---

## Was es verhindert

| Policy | Was blockiert wird |
|---|---|
| `sanitize-api-keys` | API-Schlüssel, die in den Kontext des Agenten gelangen |
| `block-env-files` | Lesezugriffe auf `.env` und andere Secret-Dateien |
| `warn-repeated-tool-calls` | Der Agent läuft in einer Schleife mit demselben Aufruf |
| `block-sudo` | Privilege-Escalation |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, unbegrenzte `DELETE`-Operationen |
| `block-terraform` / `block-kubectl` | Nicht geprüfte Änderungen an Live-Infrastruktur |
| `block-rm-rf` | Rekursives Löschen von Dateien |
| `block-force-push` / `block-push-master` | `git push --force`, direkte Pushes nach `main` |

Diese Policies schützen Dateien, Anmeldedaten, Infrastruktur, Datenbanken und Agent-Workflows.
Die genaue Durchsetzungsunterstützung variiert je nach Harness und Ereignis.

→ [Alle 39 integrierten Policies](https://docs.befailproof.ai/policies/builtin)

---

## Eigene Policies

Lege eine Datei in `.failproofai/policies/` ab — sie wird automatisch geladen, ohne Flags.
Committe sie und das gesamte Team erhält sie beim nächsten Pull.

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

Drei Entscheidungen stehen jeder Policy zur Verfügung:

| Entscheidung | Wirkung |
|---|---|
| `allow()` | Operation erlauben |
| `deny(message)` | Blockieren — die Nachricht geht zurück an den Agenten |
| `instruct(message)` | Durchlassen, aber dem nächsten Prompt des Agenten Kontext hinzufügen |

→ [Leitfaden für eigene Policies](https://docs.befailproof.ai/policies/custom)

---

## Policy-Packs

Ein Policy-Pack ist ein versionierter Satz von Policies, der aus einem öffentlichen GitHub-
Repository veröffentlicht wird. Prüfe eines, bevor du es installierst:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Alles mit einem Schrägstrich ist eine Pack-Quelle; alles ohne einen ist ein Policy-Name.
Du kannst ausgewählte Kategorien oder Policies installieren und bei Bedarf ein Release pinnen.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Durchsuche veröffentlichte Packs im [Policy Hub](https://befailproof.ai/policy-hub/), oder
führe `failproofai publish --init` aus, um dein eigenes zu starten. Der Beobachtungsmodus lässt ein Pack
aufzeichnen, was es getan hätte, ohne zu blockieren: `failproofai publish --effect observe`.

→ [Policy-Packs](https://docs.befailproof.ai/policies/packs) ·
[Ein Pack veröffentlichen](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Observability

Durchsetzung ist die eine Hälfte. Die andere Hälfte ist zu sehen, was der Agent tatsächlich getan hat.

Führe `failproofai` ohne Argumente aus, und es wird ein Dashboard auf `localhost:8020` bereitgestellt,
das den bereits auf deinem Rechner vorhandenen Ausführungsverlauf liest — kein Konto, keine Registrierung,
nichts verlässt den Rechner. Du erhältst die Sitzungsliste, die Abfolge von Modell-Aufrufen, Tool-Aufrufen
und Hook-Entscheidungen innerhalb jedes Laufs, was blockiert wurde und was die Policy dem Agenten mitgeteilt hat,
sowie ein Offline-Audit (`failproofai audit`), das deinen Verlauf auf riskante Muster scannt und Policies
vorschlägt, um diese zu stoppen.

→ [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[Einen Trace lesen](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Lokales Audit](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** ist die gehostete Seite desselben Datenmodells, für Teams,
die Agenten in einer ganzen Flotte betreiben: jeder Lauf von jedem Harness an einem Ort, ein
Ausführungsgraph mit parallelen Sub-Agenten in eigenen Spuren, p50/p95/p99-Latenz für Modelle,
Tools und Hooks, pro-Modell-Kosten- und Context-Window-Tracking, Fehlerverfolgung, SQL über
deine eigenen Traces mit teilbaren Dashboards, Evaluierungen bewertet durch deinen eigenen Dienst,
geplante Audits, die wiederkehrende Fehler in belegte Befunde verwandeln, sowie Alarme, die an
Slack, E-Mail oder einen signierten Webhook weitergeleitet werden. Self-Hosting in deinem
eigenen Cluster ist im Enterprise-Plan verfügbar.

→ [Sitzungen](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Demo buchen](https://befailproof.ai/get-a-demo)

---

## Dokumentation

| Einstieg | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Installieren, einen Harness verbinden, den ersten Lauf sehen |
| [Konzepte](https://docs.befailproof.ai/start/concepts) | Wie das Hook-System funktioniert |
| [Unterstützte Harnesses](https://docs.befailproof.ai/reference/harnesses) | Alle 12 und was jeder durchsetzen kann |

| Beobachten | |
|---|---|
| [Sitzungen](https://docs.befailproof.ai/sessions/overview) | Einen Lauf verfolgen: Modelle, Tools, Fehler, Latenz |
| [Einen Trace lesen](https://docs.befailproof.ai/sessions/read-a-trace) | Was der Ausführungsgraph dir mitteilt |
| [Audits](https://docs.befailproof.ai/audits/overview) | Fehlermuster über viele Sitzungen hinweg finden |
| [Lokales Dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, kein Konto erforderlich |

| Durchsetzen | |
|---|---|
| [Integrierte Policies](https://docs.befailproof.ai/policies/builtin) | Alle 39 Policies mit Parametern |
| [Eigene Policies](https://docs.befailproof.ai/policies/custom) | Schreibe deine eigenen |
| [Konfiguration](https://docs.befailproof.ai/policies/local-configuration) | Konfigurations-Scopes und Zusammenführungsregeln |

| Eigenen Agenten instrumentieren | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Läufe von einem Agenten ohne Harness melden |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct`-Referenz |

---

## Lizenz

MIT mit [Commons Clause](https://commonsclause.com/) — kostenlos für den internen und persönlichen Gebrauch; der kommerzielle Weiterverkauf von failproofai selbst erfordert eine gesonderte Vereinbarung. Den vollständigen Text findest du in der [LICENSE](../../LICENSE).

---

## Mitwirken

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md). Neue Policies, Edge Cases und Übersetzungen sind willkommen.

> **Vor dem Start bauen.** Führe zuerst `bun install && bun run build` aus. Dieses Repository
> führt failproofai's eigene Hooks auf sich selbst aus, und diese lösen den `failproofai`-Import
> gegen das kompilierte `dist/`-Bundle auf — ohne einen Build erhältst du `Cannot find package 'failproofai'`-
> Hook-Fehler. Nach Änderungen an `src/` neu bauen. Siehe
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Gebaut mit ❤️ von [befailproof.ai](https://befailproof.ai) in SF und Bengaluru.
