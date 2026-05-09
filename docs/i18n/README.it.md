> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | **🇮🇹 Italiano** | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

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

**Traduzioni**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

Il modo più semplice per gestire le policy che mantengono i tuoi agenti AI affidabili, focalizzati e autonomi - per **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ e **Agents SDK**.

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

## CLI degli agenti supportati

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

> Installa i hook per uno o qualsiasi combinazione: `failproofai policies --install --cli opencode pi gemini` (o `--cli claude codex copilot cursor opencode pi gemini`). Ometti `--cli` per il rilevamento automatico dei CLI installati e la richiesta. **Il supporto per GitHub Copilot CLI, Cursor Agent, OpenCode, Pi e Gemini CLI è in beta - i test sono in corso.**

- **39 Policy Integrate** - Cattura le modalità di errore comuni degli agenti fin da subito. Blocca i comandi distruttivi, previeni la perdita di segreti, mantieni gli agenti entro i confini del progetto, rileva i loop e altro ancora.
- **Policy Personalizzate** - Scrivi le tue regole di affidabilità in JavaScript. Usa l'API `allow`/`deny`/`instruct` per applicare convenzioni, prevenire la deriva, controllare le operazioni o integrarsi con sistemi esterni.
- **Configurazione Facile** - Regola qualsiasi policy senza scrivere codice. Imposta allowlist, rami protetti, soglie per progetto o globalmente. Tre livelli di config si uniscono automaticamente.
- **Monitoraggio Agente** - Vedi cosa hanno fatto i tuoi agenti mentre eri assente. Sfoglia le sessioni, ispeziona ogni chiamata di strumento e rivedi esattamente dove le policy sono state applicate.

Tutto viene eseguito localmente - nessun dato esce dalla tua macchina.

---

## Requisiti

- Node.js >= 20.9.0
- Bun >= 1.3.0 (opzionale - necessario solo per lo sviluppo / la compilazione da sorgente)

---

## Installazione

```bash
npm install -g failproofai
# oppure
bun add -g failproofai
```

---

## Inizio rapido

### 1. Abilita le politiche globalmente

```bash
failproofai policies --install
```

Scrive i dati dei hook in `~/.claude/settings.json`. Claude Code ora invocherà failproofai prima e dopo ogni chiamata di strumento.

### 2. Avvia il dashboard

```bash
failproofai
```

Apre `http://localhost:8020` - sfoglia le sessioni, ispeziona i log, gestisci le policy.

### 3. Verifica cosa è attivo

```bash
failproofai policies
```

---

## Installazione delle policy

### Ambiti

| Ambito | Comando | Dove scrive |
|--------|---------|-------------|
| Globale (predefinito) | `failproofai policies --install` | `~/.claude/settings.json` |
| Progetto | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Locale | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Installa politiche specifiche

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Rimuovi policy

```bash
failproofai policies --uninstall
# oppure per un ambito specifico:
failproofai policies --uninstall --scope project
```

---

## Configurazione

La configurazione delle policy si trova in `~/.failproofai/policies-config.json` (globale) o `.failproofai/policies-config.json` nel tuo progetto (per progetto).

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
      "hint": "Use apt-get directly without sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Try creating a fresh branch instead."
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

**Tre ambiti di configurazione** vengono uniti automaticamente (progetto → locale → globale). Vedi [docs/configuration.mdx](docs/configuration.mdx) per le regole di unione complete.

---

## Politiche incorporate

| Policy | Descrizione | Configurabile |
|--------|-------------|:---:|
| `block-sudo` | Previeni che gli agenti eseguano comandi di sistema privilegiati | `allowPatterns` |
| `block-rm-rf` | Previeni l'eliminazione ricorsiva accidentale di file | `allowPaths` |
| `block-curl-pipe-sh` | Previeni che gli agenti inviino script non affidabili alla shell | |
| `block-failproofai-commands` | Previeni l'auto-disinstallazione | |
| `sanitize-jwt` | Ferma i token JWT dal trapelamento nel contesto dell'agente | |
| `sanitize-api-keys` | Ferma le chiavi API dal trapelamento nel contesto dell'agente | `additionalPatterns` |
| `sanitize-connection-strings` | Ferma le credenziali del database dal trapelamento nel contesto dell'agente | |
| `sanitize-private-key-content` | Redigi i blocchi di chiavi private PEM dall'output | |
| `sanitize-bearer-tokens` | Redigi i token Authorization Bearer dall'output | |
| `block-env-files` | Previeni che gli agenti leggano file .env | |
| `protect-env-vars` | Previeni che gli agenti stampino variabili di ambiente | |
| `block-read-outside-cwd` | Mantieni gli agenti entro i confini del progetto | `allowPaths` |
| `block-secrets-write` | Previeni le scritture in file di chiavi private e certificati | `additionalPatterns` |
| `block-push-master` | Previeni i push accidentali a main/master | `protectedBranches` |
| `block-work-on-main` | Mantieni gli agenti lontani dai rami protetti | `protectedBranches` |
| `block-force-push` | Previeni `git push --force` | |
| `warn-git-amend` | Ricorda agli agenti prima di emendare i commit | |
| `warn-git-stash-drop` | Ricorda agli agenti prima di eliminare gli stash | |
| `warn-all-files-staged` | Cattura accidentali `git add -A` | |
| `warn-destructive-sql` | Cattura DROP/DELETE SQL prima dell'esecuzione | |
| `warn-schema-alteration` | Cattura ALTER TABLE prima dell'esecuzione | |
| `warn-large-file-write` | Cattura le scritture di file inaspettatamente grandi | `thresholdKb` |
| `warn-package-publish` | Cattura accidentali `npm publish` | |
| `warn-background-process` | Cattura i lanci di processi di background involontari | |
| `warn-global-package-install` | Cattura gli install di pacchetti globali involontari | |
| …e altri | | |

Dettagli completi delle policy e riferimento dei parametri: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Politiche personalizzate

Scrivi le tue politiche per mantenere gli agenti affidabili e concentrati:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Block writes to paths containing 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Writes to production paths are blocked");
    return allow();
  },
});
```

Installa con:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Funzioni di supporto decisionale

| Funzione | Effetto |
|----------|---------|
| `allow()` | Consenti l'operazione |
| `allow(message)` | Consenti e invia il contesto informativo a Claude |
| `deny(message)` | Blocca l'operazione; il messaggio viene mostrato a Claude |
| `instruct(message)` | Aggiungi il contesto al prompt di Claude; non bloccare |

### Oggetto contesto (`ctx`)

| Campo | Tipo | Descrizione |
|-------|------|-------------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | Strumento in corso di chiamata (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | Parametri di input dello strumento |
| `payload` | `object` | Payload evento grezzo completo |
| `session.cwd` | `string` | Directory di lavoro della sessione Claude Code |
| `session.sessionId` | `string` | Identificatore di sessione |
| `session.transcriptPath` | `string` | Percorso al file transcript della sessione |

I hook personalizzati supportano importazioni locali transitive, async/await e accesso a `process.env`. Gli errori sono fail-open (registrati in `~/.failproofai/hook.log`, le politiche incorporate continuano). Vedi [docs/custom-hooks.mdx](docs/custom-hooks.mdx) per la guida completa.

### Policy basate su convenzioni

Rilascia file `*policies.{js,mjs,ts}` in `.failproofai/policies/` e vengono caricati automaticamente - nessun flag o modifica di configurazione necessaria. Effettua il commit della directory su git e ogni membro del team ottiene gli stessi standard di qualità automaticamente.

```text
# Livello di progetto — committato su git, condiviso con il team
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Livello utente — personale, si applica a tutti i progetti
~/.failproofai/policies/my-policies.mjs
```

Entrambi i livelli si caricano (unione). I file vengono caricati alfabeticamente all'interno di ogni directory. Anteponi con `01-`, `02-`, ecc. per controllare l'ordine. Man mano che il tuo team scopre nuove modalità di errore, aggiungi una policy e effettua il push - tutti ricevono l'aggiornamento al prossimo pull. Vedi [examples/convention-policies/](examples/convention-policies/) per esempi pronti all'uso.

---

## Telemetria

Failproof AI raccoglie telemetria di utilizzo anonima tramite PostHog per comprendere l'utilizzo delle funzionalità. Il contenuto della sessione, i nomi dei file, gli input degli strumenti o le informazioni personali non vengono mai inviati.

Disabilitala:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Documentazione

| Guida | Descrizione |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | Installazione e primi passi |
| [Built-in Policies](docs/built-in-policies.mdx) | Tutte le 39 policy integrate con parametri |
| [Custom Policies](docs/custom-policies.mdx) | Scrivi le tue policy |
| [Configuration](docs/configuration.mdx) | Formato del file di configurazione e unione degli ambiti |
| [Dashboard](docs/dashboard.mdx) | Monitora le sessioni e rivedi l'attività delle policy |
| [Architecture](docs/architecture.mdx) | Come funziona il sistema di hook |
| [Testing](docs/testing.mdx) | Esecuzione di test e scrittura di nuovi test |

### Esegui la documentazione localmente

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Apre il sito della documentazione Mintlify su `http://localhost:3000`. Il contenitore osserva i cambiamenti se monti la directory docs:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## Nota per i collaboratori di failproofai

Il `.claude/settings.json` di questo repository utilizza `bun ./bin/failproofai.mjs --hook <EventType>` invece del comando standard `npx -y failproofai`. Questo perché l'esecuzione di `npx -y failproofai` all'interno del progetto failproofai stesso crea un conflitto auto-referenziato.

Per tutti gli altri repository, l'approccio consigliato è `npx -y failproofai`, installato tramite:

```bash
failproofai policies --install --scope project
```

## Contribuire

Vedi [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licenza

Vedi [LICENSE](LICENSE).

---

Creato e mantenuto da **ExosphereHost: Reliability Research Lab per i tuoi agenti**. Aiutiamo le imprese e le startup a migliorare l'affidabilità dei loro agenti AI attraverso i nostri agenti, software e competenze. Scopri di più su [exosphere.host](https://exosphere.host).
