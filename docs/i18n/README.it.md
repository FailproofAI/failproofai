> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | **🇮🇹 Italiano** | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traduzioni:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Osservabilità e controllo per ogni ambiente in cui i tuoi agenti vengono eseguiti.**
Ovunque i tuoi agenti vengono eseguiti, noi lo vediamo — e possiamo dire di no. Failproof si aggancia a 12 ambienti di esecuzione per agenti — CLI di codifica come Claude Code e Codex, gateway di chat come Hermes, assistenti self-hosted come OpenClaw — catturando ogni esecuzione e bloccando le chiamate di strumenti pericolose prima che vengano eseguite. 39 politiche integrate. Zero latenza. Eseguito localmente.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Ambienti supportati

Dodici ambienti in due classi — dieci CLI di codifica e due gateway di chat e assistenti (Hermes, OpenClaw). Un'API di politica unica e una cronologia delle sessioni su tutti. Ciò che una politica può *bloccare* è specifico dell'ambiente: bloccare una chiamata di strumento prima che venga eseguita è verificato su tutti e dodici, i gate di fine turno su otto. La [matrice per ambiente](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) elenca gli eventi che ognuno rispetta.

Gli agenti che vengono eseguiti senza nessuno di essi generano un rapporto tramite [Python SDK](https://docs.befailproof.ai/reference/custom-agents), che ti dà tracciamento, sessioni e audit. L'enforcement lì richiede un hook nel tuo runtime — [contattaci](mailto:support@befailproof.ai) e lo mapperemo.

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

## Installazione

```sh
npm install -g failproofai
failproofai config                             # connetti i tuoi agenti e il daemon
failproofai policies add FailproofAI/policies  # scegli cosa applicare
failproofai                                    # dashboard su localhost:8020
```

L'installazione configura i hook e non seleziona **nessuna** politica — il secondo comando è quello che mette i guardrail sulla macchina, e qualsiasi pacchetto si digita nello stesso modo (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` legge prima uno). Esegui `failproofai config` senza terminale — CI, contenitore, agente che lo guida — e applica invece di chiedere. Su una macchina che non è mai stata configurata, qualsiasi altro comando esegue prima la stessa procedura guidata; disabilitalo con `FAILPROOFAI_NO_FIRST_RUN=1`.

Finché un pacchetto non arriva, l'unica cosa che applica è `block-failproofai-commands`, che è sempre attiva e non può essere spenta o messa in pausa: un agente che può mettere in pausa l'enforcement può disattivare ogni altra politica.

---

## Cosa blocca

| Politica | Cosa blocca |
|---|---|
| `block-env-files` | Letture di `.env` e altri file di segreti |
| `warn-repeated-tool-calls` | L'agente che fa un loop sulla stessa chiamata |
| `block-sudo` | Escalation di privilegi |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` senza limiti |
| `block-terraform` / `block-kubectl` | Modifiche non revisionate all'infrastruttura live |
| `block-rm-rf` | Eliminazione ricorsiva di file |
| `block-force-push` / `block-push-master` | `git push --force`, push diretti a `main` |

Ognuna di queste blocca la chiamata *prima* che venga eseguita, quindi funzionano su tutti e dodici gli ambienti. Le prime quattro si applicano a qualsiasi agente che possa chiamare uno strumento; le ultime tre sono i preferiti degli sviluppatori — i CLI di codifica sono la classe di ambiente che copriamo più in profondità. La famiglia `sanitize-*` è separata: viene eseguita dopo che uno strumento ritorna, quindi segnala un segreto nell'output dello strumento anziché mantenerlo fuori dal contesto.

→ [Tutte le 39 politiche integrate](https://docs.befailproof.ai/policies/packs)

---

## Le tue politiche personali

Rilascia un file in `.failproofai/policies/` — carica automaticamente, nessun flag necessario. Esegui il commit e l'intero team lo ottiene al prossimo pull.

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

Tre decisioni disponibili per ogni politica:

| Decisione | Effetto |
|---|---|
| `allow()` | Consenti l'operazione |
| `deny(message)` | Bloccala — il messaggio torna all'agente |
| `instruct(message)` | Lasciala passare, ma aggiungi contesto al prossimo prompt dell'agente |

→ [Scrivi una politica](https://docs.befailproof.ai/policies/editor)

---

## Osservabilità

L'enforcement è metà. L'altra metà è vedere cosa ha effettivamente fatto l'agente.

Esegui `failproofai` senza argomenti e serve una dashboard su `localhost:8020` leggendo la cronologia delle esecuzioni già sulla tua macchina — nessun account, nessuna registrazione, nulla che esce dal sistema. Ottieni l'elenco delle sessioni, la sequenza di chiamate al modello, chiamate di strumenti e decisioni di hook all'interno di ogni esecuzione, cosa è stato bloccato e cosa la politica ha detto all'agente, e un audit offline (`failproofai audit`) che analizza la tua cronologia alla ricerca di pattern rischiosi e suggerisce politiche per fermarli.

→ [Dashboard locale](https://docs.befailproof.ai/reference/local-dashboard) ·
[Leggi una traccia](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Audit locale](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** è il lato ospitato dello stesso modello di dati, per i team che eseguono agenti su una flotta: ogni esecuzione da ogni ambiente in un unico posto, un grafico di esecuzione con sotto-agenti paralleli su corsie proprie, latenza p50/p95/p99 per modelli, strumenti e hook, costi per modello e tracciamento della finestra di contesto, tracciamento degli errori, SQL sulle tue tracce con dashboard condivisibili, valutazioni puntate dal tuo servizio, audit pianificati che trasformano i guasti ricorrenti in risultati supportati da prove, e avvisi instradati a Slack, email o un webhook firmato. L'auto-hosting nel tuo cluster è disponibile nel piano Enterprise.

→ [Sessioni](https://docs.befailproof.ai/sessions/overview) ·
[Audit](https://docs.befailproof.ai/audits/overview) ·
[Prenota una demo](https://befailproof.ai/get-a-demo)

---

## Documentazione

| Inizia | |
|---|---|
| [Guida rapida](https://docs.befailproof.ai/start/quickstart) | Installa, connetti un ambiente, vedi la prima esecuzione |
| [Concetti](https://docs.befailproof.ai/start/concepts) | Come funziona il sistema di hook |
| [Ambienti supportati](https://docs.befailproof.ai/reference/harnesses) | Tutti i 12, e cosa può applicare ognuno |

| Osserva | |
|---|---|
| [Sessioni](https://docs.befailproof.ai/sessions/overview) | Segui un'esecuzione: modelli, strumenti, errori, latenza |
| [Leggi una traccia](https://docs.befailproof.ai/sessions/read-a-trace) | Cosa ti sta dicendo il grafico di esecuzione |
| [Audit](https://docs.befailproof.ai/audits/overview) | Trova pattern di guasto su molte sessioni |
| [Dashboard locale](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, nessun account necessario |

| Applica | |
|---|---|
| [Pacchetti di politiche](https://docs.befailproof.ai/policies/packs) | Le politiche Failproof AI e pacchetti dall'hub di politiche |
| [Scrivi una politica](https://docs.befailproof.ai/policies/editor) | Da un audit, o nel codice |
| [Configurazione](https://docs.befailproof.ai/policies/local-configuration) | Ambiti di configurazione, regole di merge e parametri di politica |

| Strumenti il tuo agente personalizzato | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Segnala esecuzioni da un agente senza ambiente |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Riferimento `allow` / `deny` / `instruct` |

---

## Licenza

MIT con [Commons Clause](https://commonsclause.com/) — gratuito per uso interno e personale; la rivendita commerciale di failproofai stesso richiede un accordo separato. Vedi [LICENSE](../../LICENSE) per il testo completo.

---

## Contribuire

Vedi [CONTRIBUTING.md](../../CONTRIBUTING.md). Nuove politiche, casi limite e traduzioni sono tutti benvenuti.

> **Costruisci prima di iniziare.** Esegui `bun install && bun run build` innanzitutto. Questo repository esegue i suoi hook su se stesso, e risolvono l'importazione `failproofai` rispetto al bundle compilato `dist/` — senza una build otterrai errori di hook `Cannot find package 'failproofai'`. Riconstruisci dopo aver modificato `src/`. Vedi [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Costruito con ❤️ da [befailproof.ai](https://befailproof.ai) a SF e Bengaluru.
