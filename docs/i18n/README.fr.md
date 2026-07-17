> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | **🇫🇷 Français** | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Traductions :** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Résolution des pannes d'exécution pour les agents de codage.**
S'intègre à Claude Code et Codex. Détecte les boucles, les actions dangereuses et les fuites de secrets
avant qu'elles ne deviennent des incidents. Zéro latence. Fonctionne en local.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLI d'agents pris en charge

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

> Installez les hooks pour l'un ou une combinaison quelconque : `failproofai policies --install --cli opencode pi` (ou `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Omettez `--cli` pour détecter automatiquement les CLI installés et afficher une invite.
>
> **Hermes** (hermes-agent, une passerelle Slack/Telegram) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli hermes` — une seule installation intercepte les appels d'outils de chaque plateforme et sous-agent) que pour la **relecture d'audit** hors ligne de ses sessions de passerelle depuis l'unique `~/.hermes/state.db`.
>
> **OpenClaw** (openclaw gateway, un assistant multi-canal auto-hébergé) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli openclaw`, portée utilisateur) que pour la **relecture d'audit** hors ligne de ses sessions JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). L'application utilise les **hooks de plugin in-process** d'OpenClaw (un `openclaw-plugin/` livré qui lance failproofai de façon asynchrone — ses hooks internes basés sur des fichiers sont en observation uniquement et ne peuvent pas bloquer) : `before_tool_call` bloque un outil, et `before_agent_finalize` est une vraie porte de fin de tour, ce qui permet aux fonctions intégrées `require-*-before-stop` de s'appliquer.
>
> **Factory Droid** (`droid`) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli factory`, portée utilisateur + projet) que pour la **relecture d'audit** hors ligne de ses sessions JSONL sur disque. droid bloque les appels d'outils via le **code de sortie 2** du hook (et non une décision JSON) et respecte `{decision:"block"}` uniquement sur l'événement `Stop` de fin de tour — failproofai émet automatiquement la bonne structure selon l'événement.
>
> **Devin CLI** (`devin`, Cognition) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli devin`, portée utilisateur + projet) que pour la **relecture d'audit** hors ligne de ses sessions SQLite (`~/.local/share/devin/cli/sessions.db`). Devin est un **clone pur de Claude** — mêmes noms d'événements, même payload en snake_case, même configuration avec wrapper `"hooks"` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — blocage via `{decision:"block"}` JSON sur chaque événement.
>
> **Antigravity CLI** (`agy`) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli antigravity`, portée utilisateur + projet) que pour la **relecture d'audit** hors ligne de ses sessions JSONL brutes (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity possède son **propre** contrat (pas un clone de Claude) : un schéma `hooks.json` avec **hooks nommés** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), un payload stdin en camelCase que failproofai normalise, et ses propres formes de réponse — `{decision:"deny"}` pour bloquer un outil, `{decision:"continue"}` pour forcer un nouveau tour au `Stop`, `{injectSteps}` pour injecter un rappel avant l'exécution du modèle.
>
> **Goose** (nom de code goose, Block) est pris en charge aussi bien pour l'**application de hooks en direct** (`--cli goose`, portée utilisateur + projet) que pour la **relecture d'audit** hors ligne de ses sessions SQLite (`~/.local/share/goose/sessions/sessions.db`). L'application utilise le système de **hooks** de Goose (la spécification **Open Plugins** inter-agents) — l'installateur dépose simplement un répertoire de plugin dans `~/.agents/plugins/failproofai/` et Goose le détecte automatiquement. Le blocage s'effectue via `{"decision":"block"}` JSON sur l'événement `PreToolUse` (qui se déclenche pour l'outil shell et à l'intérieur des sous-agents délégués), vérifié en direct contre goose v1.43.0 ; Goose ne possède pas d'événement `Stop` de fin de tour, donc les fonctions intégrées `require-*-before-stop` ne s'appliquent pas (comme avec Hermes).

---

## Installation

```sh
npm install -g failproofai
failproofai policies --install   # ou lancez simplement `failproofai` et acceptez l'invite au premier démarrage
failproofai
```

30 politiques intégrées s'activent immédiatement. Tableau de bord disponible sur `localhost:8020`. Désactivez l'invite au premier démarrage avec `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Ce que ça bloque

| Politique | Ce qu'elle bloque |
|---|---|
| `block-push-master` | Les pushes directs vers `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Les commits, merges et rebases sur `main` / `master` |
| `block-rm-rf` | La suppression récursive de fichiers |
| `sanitize-api-keys` | Les clés API qui fuient dans le contexte de l'agent |

→ [Les 30 politiques intégrées](https://docs.befailproof.ai/built-in-policies)

---

## Vos propres politiques

Déposez un fichier dans `.failproofai/policies/` — il se charge automatiquement, aucun flag nécessaire.
Commitez-le et toute l'équipe l'obtiendra au prochain pull.

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

Trois décisions disponibles pour chaque politique :

| Décision | Effet |
|---|---|
| `allow()` | Autorise l'opération |
| `deny(message)` | La bloque — le message est renvoyé à l'agent |
| `instruct(message)` | La laisse passer, mais ajoute du contexte au prochain prompt de l'agent |

→ [Guide des politiques personnalisées](https://docs.befailproof.ai/custom-policies)

---

## Visibilité des sessions

Chaque appel d'outil effectué par votre agent est journalisé localement. Le tableau de bord montre ce qui s'est exécuté,
ce qui a été bloqué, et ce que la politique a transmis à l'agent — plus besoin de deviner
quand quelque chose tourne mal. → [Guide du tableau de bord](https://docs.befailproof.ai/dashboard)

---

## Documentation

| | |
|---|---|
| [Démarrage rapide](https://docs.befailproof.ai/getting-started) | Installation et premiers pas |
| [Politiques intégrées](https://docs.befailproof.ai/built-in-policies) | Les 30 politiques avec leurs paramètres |
| [Politiques personnalisées](https://docs.befailproof.ai/custom-policies) | Écrivez les vôtres |
| [Configuration](https://docs.befailproof.ai/configuration) | Portées de configuration et règles de fusion |
| [Tableau de bord](https://docs.befailproof.ai/dashboard) | Moniteur de session et activité des politiques |
| [Architecture](https://docs.befailproof.ai/architecture) | Fonctionnement du système de hooks |

---

## Licence

MIT avec [Commons Clause](https://commonsclause.com/) — gratuit pour usage interne et personnel ; la revente commerciale de failproofai lui-même nécessite un accord séparé. Voir [LICENSE](./LICENSE) pour le texte complet.

---

## Contribuer

Consultez [CONTRIBUTING.md](./CONTRIBUTING.md). Les nouvelles politiques, cas limites et traductions sont les bienvenus.

> **Compilez avant de commencer.** Exécutez d'abord `bun install && bun run build`. Ce dépôt utilise
> ses propres hooks failproofai sur lui-même, et ils résolvent l'import `failproofai` depuis le
> bundle compilé `dist/` — sans compilation, vous obtiendrez des erreurs de hook `Cannot find package 'failproofai'`.
> Recompilez après avoir modifié `src/`. Voir
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Créé par [Nivedit Jain](https://github.com/NiveditJain) et [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
