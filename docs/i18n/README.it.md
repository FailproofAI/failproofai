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

**Risoluzione dei guasti in tempo reale per agenti di codifica.**
Si integra con Claude Code e Codex. Cattura loop, azioni pericolose e perdite di segreti
prima che diventino incidenti. Zero latenza. Esecuzione locale.

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

> Installa gli hook per uno o una qualsiasi combinazione: `failproofai policies --install --cli opencode pi gemini` (oppure `--cli claude codex copilot cursor opencode pi gemini`). Ometti `--cli` per rilevare automaticamente i CLI installati e ricevere un prompt.

---

## Installazione

```sh
npm install -g failproofai
failproofai policies --install   # oppure esegui semplicemente `failproofai` e accetta il prompt al primo avvio
failproofai
```

30 policy predefinite si attivano immediatamente. Dashboard disponibile su `localhost:8020`. Disabilita il prompt al primo avvio con `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Cosa blocca

| Policy | Cosa blocca |
|---|---|
| `block-push-master` | Push diretti a `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commit, merge, rebase su `main` / `master` |
| `block-rm-rf` | Eliminazione ricorsiva di file |
| `sanitize-api-keys` | API key che si perdono nel contesto dell'agente |

→ [Tutte le 30 policy predefinite](https://docs.befailproof.ai/built-in-policies)

---

## Le tue policy personalizzate

Rilascia un file in `.failproofai/policies/` — viene caricato automaticamente, senza flag necessari.
Eseguine il commit e l'intero team la riceverà al prossimo pull.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Le scritture su percorsi di produzione sono bloccate.");
    return allow();
  },
});
```

Tre decisioni disponibili per ogni policy:

| Decisione | Effetto |
|---|---|
| `allow()` | Consenti l'operazione |
| `deny(message)` | Bloccala — il messaggio torna all'agente |
| `instruct(message)` | Lasciala passare, ma aggiungi contesto al prossimo prompt dell'agente |

→ [Guida alle policy personalizzate](https://docs.befailproof.ai/custom-policies)

---

## Visibilità della sessione

Ogni chiamata di tool che il tuo agente fa viene registrata localmente. Il dashboard mostra cosa è stato eseguito,
cosa è stato bloccato e cosa la policy ha comunicato all'agente — così non devi indovinare
quando qualcosa va storto. → [Guida al dashboard](https://docs.befailproof.ai/dashboard)

---

## Documentazione

| | |
|---|---|
| [Iniziare](https://docs.befailproof.ai/getting-started) | Installazione e primi passi |
| [Policy predefinite](https://docs.befailproof.ai/built-in-policies) | Tutte le 30 policy con parametri |
| [Policy personalizzate](https://docs.befailproof.ai/custom-policies) | Scrivi le tue |
| [Configurazione](https://docs.befailproof.ai/configuration) | Ambiti di configurazione e regole di merge |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Monitor di sessione e attività delle policy |
| [Architettura](https://docs.befailproof.ai/architecture) | Come funziona il sistema di hook |

---

## Licenza

MIT con [Commons Clause](https://commonsclause.com/) — gratuito per uso interno e personale; la rivendita commerciale di failproofai stesso richiede un accordo separato. Consulta [LICENSE](./LICENSE) per il testo completo.

---

## Contribuire

Consulta [CONTRIBUTING.md](./CONTRIBUTING.md). Nuove policy, casi limite e traduzioni sono tutti benvenuti.

> **Compila prima di iniziare.** Esegui `bun install && bun run build` per primo. Questo repository esegue
> gli hook di failproofai su se stesso e risolvono l'import di `failproofai` rispetto al
> bundle compilato `dist/` — senza una compilazione riceverai errori di hook `Cannot find package 'failproofai'`.
> Ricompila dopo aver modificato `src/`. Consulta
> [Compilare prima che gli hook di sviluppo in-repo funzionino](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Costruito da [Nivedit Jain](https://github.com/NiveditJain) e [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
