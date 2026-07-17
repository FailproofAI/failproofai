> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | **🇮🇹 Italiano** | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Traduzioni:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Risoluzione degli errori di runtime per agenti di codifica.**
Si integra in Claude Code e Codex. Rileva cicli, azioni pericolose e fughe di segreti
prima che diventino incidenti. Latenza zero. Funziona localmente.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLI di agenti supportati

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

> Installa hook per uno o una combinazione qualsiasi: `failproofai policies --install --cli opencode pi` (o `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Ometti `--cli` per rilevare automaticamente i CLI installati e ricevere una richiesta.
>
> **Hermes** (hermes-agent, un gateway Slack/Telegram) è supportato sia per l'**esecuzione live-hook** (`--cli hermes` — un'installazione intercetta le chiamate di strumenti da ogni piattaforma e sub-agente) che per l'**audit** offline delle sessioni del gateway dal singolo `~/.hermes/state.db`.
>
> **OpenClaw** (gateway openclaw, un assistente multi-canale self-hosted) è supportato sia per l'**esecuzione live-hook** (`--cli openclaw`, ambito utente) che per l'**audit** offline delle sessioni JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). L'esecuzione utilizza gli **hook plugin in-process** di OpenClaw (un `openclaw-plugin/` fornito che avvia failproofai in modo asincrono — i suoi hook interni basati su file sono solo osservazione e non possono bloccare): `before_tool_call` blocca uno strumento e `before_agent_finalize` è un vero gate di fine turno, quindi i builtin `require-*-before-stop` applicano.
>
> **Factory Droid** (`droid`) è supportato sia per l'**esecuzione live-hook** (`--cli factory`, ambito utente + progetto) che per l'**audit** offline delle sessioni JSONL su disco. droid blocca le chiamate di strumenti tramite **codice di uscita 2** dell'hook (non una decisione JSON) e onora `{decision:"block"}` solo sull'evento `Stop` di fine turno — failproofai emette automaticamente la forma corretta per ogni evento.
>
> **Devin CLI** (`devin`, Cognition) è supportato sia per l'**esecuzione live-hook** (`--cli devin`, ambito utente + progetto) che per l'**audit** offline delle sessioni SQLite (`~/.local/share/devin/cli/sessions.db`). Devin è un **puro clone di Claude** — stessi nomi di eventi, stesso payload snake_case, stessa configurazione wrapper `"hooks"` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — blocco tramite JSON `{decision:"block"}` su ogni evento.
>
> **Antigravity CLI** (`agy`) è supportato sia per l'**esecuzione live-hook** (`--cli antigravity`, ambito utente + progetto) che per l'**audit** offline delle sessioni plain-JSONL (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity ha il suo **proprio** contratto (non un clone di Claude): uno schema `hooks.json` con **hook denominati** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), un payload stdin camelCase che failproofai normalizza e le sue forme di risposta proprie — `{decision:"deny"}` per bloccare uno strumento, `{decision:"continue"}` per forzare un altro turno a `Stop`, `{injectSteps}` per iniettare un promemoria prima che il modello giri.
>
> **Goose** (codename goose, Block) è supportato sia per l'**esecuzione live-hook** (`--cli goose`, ambito utente + progetto) che per l'**audit** offline delle sessioni SQLite (`~/.local/share/goose/sessions/sessions.db`). L'esecuzione utilizza il sistema **hooks** di Goose (la specifica **Open Plugins** cross-agent) — il programma di installazione lascia semplicemente una directory di plugin in `~/.agents/plugins/failproofai/` e Goose la scopre automaticamente. Il blocco è JSON `{"decision":"block"}` sull'evento `PreToolUse` (che si attiva per lo strumento shell e dentro i sub-agenti delegati), verificato live rispetto a goose v1.43.0; Goose non ha un evento `Stop` di fine turno, quindi i builtin `require-*-before-stop` non si applicano (come con Hermes).

---

## Installazione

```sh
npm install -g failproofai
failproofai policies --install   # o esegui semplicemente `failproofai` e accetta il prompt della prima esecuzione
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
| `block-rm-rf` | Eliminazione ricorsiva di file |
| `sanitize-api-keys` | Chiavi API che fuoriescono nel contesto dell'agente |

→ [Tutte le 30 politiche integrate](https://docs.befailproof.ai/built-in-policies)

---

## Le tue politiche personali

Inserisci un file in `.failproofai/policies/` — carica automaticamente, senza flag necessari.
Commitla e l'intero team la riceverà al prossimo pull.

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
| `instruct(message)` | Lasciarla passare, ma aggiungere contesto al prossimo prompt dell'agente |

→ [Guida alle politiche personalizzate](https://docs.befailproof.ai/custom-policies)

---

## Visibilità della sessione

Ogni chiamata di strumento che il tuo agente fa è registrata localmente. Il dashboard mostra cosa è stato eseguito,
cosa è stato bloccato e cosa la politica ha detto all'agente — così non stai indovinando
quando qualcosa va male. → [Guida del dashboard](https://docs.befailproof.ai/dashboard)

---

## Documentazione

| | |
|---|---|
| [Guida introduttiva](https://docs.befailproof.ai/getting-started) | Installazione e primi passi |
| [Politiche integrate](https://docs.befailproof.ai/built-in-policies) | Tutte le 30 politiche con parametri |
| [Politiche personalizzate](https://docs.befailproof.ai/custom-policies) | Scrivi le tue |
| [Configurazione](https://docs.befailproof.ai/configuration) | Ambiti di configurazione e regole di merge |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Monitor di sessione e attività di politica |
| [Architettura](https://docs.befailproof.ai/architecture) | Come funziona il sistema di hook |

---

## Licenza

MIT con [Commons Clause](https://commonsclause.com/) — gratuita per uso interno e personale; la rivendita commerciale di failproofai stesso richiede un accordo separato. Vedi [LICENSE](./LICENSE) per il testo completo.

---

## Contribuire

Vedi [CONTRIBUTING.md](./CONTRIBUTING.md). Nuove politiche, casi limite e traduzioni sono tutti benvenuti.

> **Crea prima di iniziare.** Esegui prima `bun install && bun run build`. Questo repository esegue i propri hook di failproofai su se stesso e risolvono l'importazione `failproofai` rispetto al bundle compilato `dist/` — senza una compilazione otterrai errori hook `Cannot find package 'failproofai'`. Ricompila dopo aver cambiato `src/`. Vedi
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Costruito da [Nivedit Jain](https://github.com/NiveditJain) e [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
