> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | **🇮🇹 Italiano** | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Traduzioni:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Risoluzione dei guasti runtime per agenti di codifica.**
Si integra con Claude Code e Codex. Cattura cicli infiniti, azioni pericolose e fughe di segreti
prima che diventino incidenti. Latenza zero. Funziona localmente.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLI di agenti supportati

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> Installa gli hook per uno o una combinazione di questi: `failproofai policies --install --cli opencode pi` (oppure `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Ometti `--cli` per il rilevamento automatico dei CLI installati e un prompt.
>
> **Hermes** (hermes-agent, un gateway Slack/Telegram) è supportato per l'applicazione live degli hook (`--cli hermes` — una sola installazione intercetta le chiamate di strumenti da tutte le piattaforme e subagenti) e per il replay offline di audit dalle sessioni del gateway nel file `~/.hermes/state.db`.
>
> **OpenClaw** (openclaw gateway, un assistente multi-canale self-hosted) è supportato per l'applicazione live degli hook (`--cli openclaw`, scope utente) e per il replay offline di audit delle sessioni JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). L'applicazione utilizza i plugin hook in-process di OpenClaw (un `openclaw-plugin/` fornito che spawn in modo asincrono failproofai — i suoi hook interni basati su file sono solo osservativi e non possono bloccare): `before_tool_call` blocca uno strumento, e `before_agent_finalize` è una porta di fine turno vera, quindi i builtin `require-*-before-stop` garantiscono l'applicazione.
>
> **Factory Droid** (`droid`) è supportato per l'applicazione live degli hook (`--cli factory`, scope utente + progetto) e per il replay offline di audit delle sessioni JSONL su disco. droid blocca le chiamate di strumenti dal codice di uscita hook **2** (non una decisione JSON) e onora `{decision:"block"}` solo sull'evento di fine turno `Stop` — failproofai emette automaticamente la forma corretta per ogni evento.
>
> **Devin CLI** (`devin`, Cognition) è supportato per l'applicazione live degli hook (`--cli devin`, scope utente + progetto) e per il replay offline di audit dalle sessioni SQLite (`~/.local/share/devin/cli/sessions.db`). Devin è un clone puro di Claude — stessi nomi di evento, stesso payload snake_case, stessa configurazione del wrapper `"hooks"` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — il blocco avviene tramite JSON `{decision:"block"}` su ogni evento.
>
> **Antigravity CLI** (`agy`) è supportato per l'applicazione live degli hook (`--cli antigravity`, scope utente + progetto) e per il replay offline di audit dalle sessioni plain-JSONL (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity ha il suo proprio contratto (non un clone di Claude): uno schema hook denominato `hooks.json` (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), un payload stdin camelCase che failproofai normalizza, e le sue proprie forme di risposta — `{decision:"deny"}` per bloccare uno strumento, `{decision:"continue"}` per forzare un altro turno a `Stop`, `{injectSteps}` per iniettare un promemoria prima che il modello sia eseguito.
>
> **Goose** (codename goose, Block) è supportato per l'applicazione live degli hook (`--cli goose`, scope utente + progetto) e per il replay offline di audit dalle sessioni SQLite (`~/.local/share/goose/sessions/sessions.db`). L'applicazione utilizza il sistema di hook di Goose (la specifica **Open Plugins** multi-agente) — l'installer semplicemente deposita una directory di plugin in `~/.agents/plugins/failproofai/` e Goose la scopre automaticamente. Il blocco è JSON `{"decision":"block"}` sull'evento `PreToolUse` (che si attiva per lo strumento shell e all'interno di subagenti delegati), verificato dal vivo rispetto a goose v1.43.0; Goose non ha un evento di fine turno `Stop`, quindi i builtin `require-*-before-stop` non si applicano (come con Hermes).

---

## Installazione

```sh
npm install -g failproofai
failproofai policies --install   # oppure esegui semplicemente `failproofai` e accetta il prompt della prima esecuzione
failproofai
```

30 politiche integrate si attivano immediatamente. Dashboard su `localhost:8020`. Disabilita il prompt della prima esecuzione con `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Cosa blocca

| Politica | Cosa blocca |
|---|---|
| `block-push-master` | Push diretti a `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commit, merge, rebase su `main` / `master` |
| `block-rm-rf` | Cancellazione ricorsiva di file |
| `sanitize-api-keys` | Chiavi API che fuggono nel contesto dell'agente |

→ [Tutte le 30 politiche integrate](https://docs.befailproof.ai/built-in-policies)

---

## Tue proprie politiche

Deposita un file in `.failproofai/policies/` — si carica automaticamente, nessun flag necessario.
Eseguine il commit e l'intero team lo avrà al prossimo pull.

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
| `allow()` | Permetti l'operazione |
| `deny(message)` | Blocca — il messaggio torna all'agente |
| `instruct(message)` | Lascia passare, ma aggiungi contesto al prossimo prompt dell'agente |

→ [Guida alle politiche personalizzate](https://docs.befailproof.ai/custom-policies)

---

## Visibilità della sessione

Ogni chiamata di strumento che il tuo agente effettua viene registrata localmente. La dashboard mostra cosa è stato eseguito,
cosa è stato bloccato e cosa la politica ha detto all'agente — quindi non stai indovinando
quando qualcosa va male. → [Guida della dashboard](https://docs.befailproof.ai/dashboard)

---

## Documentazione

| | |
|---|---|
| [Getting Started](https://docs.befailproof.ai/getting-started) | Installazione e primi passi |
| [Built-in Policies](https://docs.befailproof.ai/built-in-policies) | Tutte le 30 politiche con parametri |
| [Custom Policies](https://docs.befailproof.ai/custom-policies) | Scrivi le tue |
| [Configuration](https://docs.befailproof.ai/configuration) | Scope di configurazione e regole di merge |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Monitor di sessione e attività della politica |
| [Architecture](https://docs.befailproof.ai/architecture) | Come funziona il sistema di hook |

---

## Licenza

MIT con [Commons Clause](https://commonsclause.com/) — gratuito per uso interno e personale; la rivendita commerciale di failproofai stesso richiede un accordo separato. Vedi [LICENSE](./LICENSE) per il testo completo.

---

## Contribuire

Vedi [CONTRIBUTING.md](./CONTRIBUTING.md). Nuove politiche, casi limite e traduzioni sono tutti benvenuti.

> **Compila prima di iniziare.** Esegui `bun install && bun run build` per primo. Questo repository esegue
> i propri hook di failproofai su se stesso, e risolvono l'import `failproofai` rispetto al
> bundle compilato `dist/` — senza una compilazione otterrai errori hook `Cannot find package 'failproofai'`.
> Ricompila dopo aver modificato `src/`. Vedi
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Creato da [Nivedit Jain](https://github.com/NiveditJain) e [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
