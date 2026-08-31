> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | **🇮🇹 Italiano** | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traduzioni:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Vedi cosa fanno i tuoi agent. Blocca i guasti noti prima che si ripetano.**
Failproof AI funziona ovunque i tuoi agent vengono eseguiti: strumenti di coding
come Claude Code e Codex, gateway di chat come Hermes, assistenti self-hosted
come OpenClaw, e agent che strumenti tu stesso. Registra ogni esecuzione e può
bloccare le chiamate di tool pericolose prima che vengono eseguite.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in azione" width="800" />
</p>

---

## Harness supportati

Sono supportati dodici harness in due classi: dieci CLI per il coding, più due
gateway: Hermes, OpenClaw. L'API delle policy e la cronologia delle sessioni sono
condivise; quali eventi possono bloccare varia a seconda dell'harness.

Gli agent che non vengono eseguiti in nessuno di essi inviano i report tramite
l'[SDK Python](https://docs.befailproof.ai/reference/custom-agents),
che ti offre tracciamento, sessioni e audit. L'enforcement lì richiede un hook nel
tuo runtime — [contattaci](mailto:support@befailproof.ai) e lo mapperemo.

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

## Installa

Dai a un agent compatibile la competenza di Failproof AI se vuoi che ti guidi nella
configurazione, ispeziona la macchina e instrada correttamente le policy, gli audit,
le sessioni e i lavori Cloud:

```sh
npx skills add FailproofAI/skills
```

Questo installa la competenza ombrello e i suoi fratelli specializzati. Per installare
solo l'ombrello, aggiungi `--skill failproofai`. Le competenze forniscono istruzioni
operative; installa e configura il prodotto stesso con:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

La configurazione connette gli agent supportati e installa il servizio in background.
Non sceglie nessun policy pack: prima di aggiungerne uno, solo `block-failproofai-commands`
funziona per impedire a un agent di disabilitare Failproof AI.

Connetti Cloud senza prompt con `failproofai config --token <machine-key>`. Su una
macchina condivisa o in CI, imposta `FAILPROOFAI_CLOUD_TOKEN` e esegui
`failproofai config` in modo che la chiave non appaia nella cronologia dei comandi.

---

## Cosa blocca

| Policy | Cosa blocca |
|---|---|
| `sanitize-api-keys` | Chiavi API che fuoriescono dal contesto dell'agent |
| `block-env-files` | Letture di `.env` e altri file di secret |
| `warn-repeated-tool-calls` | L'agent che fa loop sulla stessa chiamata |
| `block-sudo` | Escalation dei privilegi |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` senza limiti |
| `block-terraform` / `block-kubectl` | Modifiche non revisionate all'infrastruttura live |
| `block-rm-rf` | Eliminazione ricorsiva di file |
| `block-force-push` / `block-push-master` | `git push --force`, push diretti a `main` |

Queste policy proteggono file, credenziali, infrastruttura, database e flussi di lavoro
degli agent. Il supporto esatto dell'enforcement varia a seconda dell'harness e dell'evento.

→ [Tutte le 39 policy integrate](https://docs.befailproof.ai/policies/builtin)

---

## Tue policy personalizzate

Inserisci un file in `.failproofai/policies/` — viene caricato automaticamente, nessun
flag necessario. Committalo e l'intero team lo avrà al prossimo pull.

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

Tre decisioni disponibili per ogni policy:

| Decisione | Effetto |
|---|---|
| `allow()` | Permetti l'operazione |
| `deny(message)` | Bloccala — il messaggio torna all'agent |
| `instruct(message)` | Lasciala passare, ma aggiungi contesto al prossimo prompt dell'agent |

→ [Guida alle policy personalizzate](https://docs.befailproof.ai/policies/custom)

---

## Policy pack

Un policy pack è un set versionato di policy pubblicato da un repository GitHub
pubblico. Ispezionalo prima di installarlo:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Qualsiasi cosa con uno slash è una fonte di pack; qualsiasi cosa senza è un nome di
policy. Puoi installare categorie o policy selezionate, e fissare un rilascio se
necessario.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Sfoglia i pack pubblicati nel [Policy Hub](https://befailproof.ai/policy-hub/), o
esegui `failproofai publish --init` per iniziare il tuo. La modalità observe consente
a un pack di registrare cosa avrebbe fatto senza bloccare:
`failproofai publish --effect observe`.

→ [Policy pack](https://docs.befailproof.ai/policies/packs) ·
[Pubblica un pack](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Osservabilità

L'enforcement è una metà. L'altra metà è vedere cosa l'agent ha effettivamente fatto.

Esegui `failproofai` senza argomenti e serve un dashboard su `localhost:8020`
leggendo la cronologia delle esecuzioni già presente sulla tua macchina — nessun
account, nessuna registrazione, niente lascia il box. Ottieni l'elenco delle sessioni,
la sequenza di chiamate di modello, chiamate di tool e decisioni di hook all'interno
di ogni esecuzione, cosa è stato bloccato e cosa la policy ha detto all'agent, e un
audit offline (`failproofai audit`) che scansiona la tua cronologia per modelli
rischiosi e suggerisce policy per fermarli.

→ [Dashboard locale](https://docs.befailproof.ai/reference/local-dashboard) ·
[Leggi una traccia](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Audit locale](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** è il lato ospitato dello stesso modello di dati, per
i team che eseguono agent su una flotta: ogni esecuzione da ogni harness in un posto,
un grafo di esecuzione con sub-agent paralleli sulle loro corsie, latenza p50/p95/p99
per modelli, tool e hook, costo per modello e tracciamento della finestra di contesto,
tracciamento degli errori, SQL sulle tue tracce con dashboard condivisibili, valutazioni
puntate dal tuo servizio, audit pianificati che trasformano i guasti ricorrenti in
risultati supportati da prove, e alert instradati a Slack, email o un webhook firmato.
L'auto-hosting nel tuo cluster è disponibile nel piano Enterprise.

→ [Sessioni](https://docs.befailproof.ai/sessions/overview) ·
[Audit](https://docs.befailproof.ai/audits/overview) ·
[Prenota una demo](https://befailproof.ai/get-a-demo)

---

## Documentazione

| Inizia | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Installa, connetti un harness, vedi la prima esecuzione |
| [Concetti](https://docs.befailproof.ai/start/concepts) | Come funziona il sistema di hook |
| [Harness supportati](https://docs.befailproof.ai/reference/harnesses) | Tutti i 12, e cosa ognuno può enforcement |

| Osserva | |
|---|---|
| [Sessioni](https://docs.befailproof.ai/sessions/overview) | Segui un'esecuzione: modelli, tool, errori, latenza |
| [Leggi una traccia](https://docs.befailproof.ai/sessions/read-a-trace) | Cosa ti sta dicendo il grafo di esecuzione |
| [Audit](https://docs.befailproof.ai/audits/overview) | Trova modelli di guasto tra molte sessioni |
| [Dashboard locale](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, nessun account necessario |

| Enforcement | |
|---|---|
| [Policy integrate](https://docs.befailproof.ai/policies/builtin) | Tutte le 39 policy con parametri |
| [Policy personalizzate](https://docs.befailproof.ai/policies/custom) | Scrivi le tue |
| [Configurazione](https://docs.befailproof.ai/policies/local-configuration) | Scope di configurazione e regole di merge |

| Strumenta il tuo agent | |
|---|---|
| [SDK Python](https://docs.befailproof.ai/reference/custom-agents) | Segnala esecuzioni da un agent senza harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Riferimento `allow` / `deny` / `instruct` |

---

## Licenza

MIT con [Commons Clause](https://commonsclause.com/) — gratuito per uso interno e
personale; la rivendita commerciale di failproofai stesso richiede un accordo separato.
Vedi [LICENSE](../../LICENSE) per il testo completo.

---

## Contribuire

Vedi [CONTRIBUTING.md](../../CONTRIBUTING.md). Nuove policy, casi edge e traduzioni sono
tutti benvenuti.

> **Compila prima di iniziare.** Esegui `bun install && bun run build` per primo.
> Questo repo esegue i propri hook di failproofai su se stesso, e risolvono l'import
> di `failproofai` rispetto al bundle compilato `dist/` — senza una build otterrai
> errori di hook `Cannot find package 'failproofai'`. Ricompila dopo aver cambiato
> `src/`. Vedi [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Costruito con ❤️ da [befailproof.ai](https://befailproof.ai) a SF e Bengaluru.
