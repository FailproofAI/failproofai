> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | **🇫🇷 Français** | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traductions :** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observabilité et application des règles pour chaque environnement d'exécution de vos agents.**
Partout où vos agents s'exécutent, nous le voyons — et nous pouvons dire non. Failproof s'intègre à 12 environnements d'agents — des CLI de codage comme Claude Code et Codex, des passerelles de chat comme Hermes, des assistants auto-hébergés comme OpenClaw — en capturant chaque exécution et en bloquant les appels d'outils dangereux avant qu'ils ne s'exécutent. 40 politiques intégrées. Zéro latence. Fonctionne en local.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Environnements pris en charge

Douze environnements en deux catégories — dix CLI de codage, et deux passerelles de chat et d'assistant (Hermes, OpenClaw). Une seule API de politiques et un historique de sessions unique pour tous. Ce qu'une politique peut *bloquer* dépend de l'environnement : l'interception d'un appel d'outil avant son exécution est vérifiée sur les douze, les points de contrôle en fin de tour sur huit. La
[matrice par environnement](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
liste les événements que chacun prend en charge.

Les agents qui ne s'exécutent dans aucun d'eux peuvent reporter via le [SDK Python](https://docs.befailproof.ai/reference/custom-agents),
qui offre le traçage, les sessions et les audits. L'application des règles nécessite alors un hook dans votre propre runtime — [contactez-nous](mailto:support@befailproof.ai) et nous l'adapterons.

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
failproofai config                             # connectez vos agents et le daemon
failproofai policies add FailproofAI/policies  # choisissez ce qu'il faut appliquer
failproofai                                    # tableau de bord sur localhost:8020
```

La configuration installe les hooks et ne sélectionne **aucune** politique — c'est la deuxième commande qui met en place les garde-fous sur la machine, et n'importe quel pack s'ajoute de la même façon
(`failproofai policies add <owner>/<repo>` ; `policies show <owner>/<repo>` permet d'en lire un d'abord). Lancez `failproofai config` sans terminal — en CI, dans un conteneur, ou piloté par un agent — et il s'applique sans poser de questions. Sur une machine qui n'a jamais été configurée, toute autre commande lance d'abord le même assistant ; désactivez ce comportement avec `FAILPROOFAI_NO_FIRST_RUN=1`.

Jusqu'à ce qu'un pack soit installé, la seule règle en vigueur est `block-failproofai-commands`,
qui est toujours active et ne peut pas être désactivée ni mise en pause : un agent capable de mettre en pause l'application des règles pourrait désactiver toutes les autres politiques.

---

## Ce que ça bloque

| Politique | Ce qu'elle bloque |
|---|---|
| `block-env-files` | Lecture des fichiers `.env` et autres fichiers de secrets |
| `warn-repeated-tool-calls` | La boucle de l'agent sur le même appel |
| `block-sudo` | Élévation de privilèges |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sans condition |
| `block-terraform` / `block-kubectl` | Modifications non revues sur l'infrastructure en production |
| `block-rm-rf` | Suppression récursive de fichiers |
| `block-force-push` / `block-push-master` | `git push --force`, pushs directs sur `main` |

Chacun de ces points de contrôle intercepte l'appel *avant* son exécution, ce qui les rend efficaces sur les douze environnements. Les quatre premiers s'appliquent à tout agent capable d'appeler un outil ; les trois derniers sont les favoris des développeurs — les CLI de codage sont la catégorie d'environnements que nous couvrons le plus en profondeur. La famille `sanitize-*` est distincte : elle s'exécute après le retour d'un outil et signale donc un secret dans la sortie d'outil plutôt que de l'empêcher d'entrer dans le contexte.

→ [Les 40 politiques intégrées](https://docs.befailproof.ai/policies/packs)

---

## Vos propres politiques

Déposez un fichier dans `.failproofai/policies/` — il se charge automatiquement, sans aucun flag.
Commitez-le et toute l'équipe en bénéficiera au prochain pull.

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
| `allow()` | Autoriser l'opération |
| `deny(message)` | La bloquer — le message est renvoyé à l'agent |
| `instruct(message)` | La laisser passer, mais ajouter du contexte au prochain prompt de l'agent |

→ [Écrire une politique](https://docs.befailproof.ai/policies/editor)

---

## Observabilité

L'application des règles n'est que la moitié du travail. L'autre moitié consiste à voir ce que l'agent a réellement fait.

Lancez `failproofai` sans arguments et il sert un tableau de bord sur `localhost:8020`
en lisant l'historique d'exécution déjà présent sur votre machine — sans compte, sans inscription, sans que rien ne quitte la machine. Vous obtenez la liste des sessions, la séquence des appels de modèles, les appels d'outils et les décisions des hooks dans chaque exécution, ce qui a été bloqué et ce que la politique a indiqué à l'agent, ainsi qu'un audit hors ligne (`failproofai audit`) qui analyse votre historique pour détecter des patterns risqués et suggère des politiques pour les stopper.

→ [Tableau de bord local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Lire une trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Audit local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** est la face hébergée du même modèle de données, destinée aux équipes qui font tourner des agents sur une flotte de machines : chaque exécution de chaque environnement au même endroit, un graphe d'exécution avec des sous-agents parallèles sur leurs propres voies, la latence p50/p95/p99 pour les modèles, les outils et les hooks, le suivi des coûts et des fenêtres de contexte par modèle, le suivi des erreurs, du SQL sur vos propres traces avec des tableaux de bord partageables, des évaluations scorées par votre propre service, des audits planifiés qui transforment les échecs récurrents en constats étayés par des preuves, et des alertes routées vers Slack, par e-mail ou via un webhook signé. L'auto-hébergement dans votre propre cluster est disponible avec le plan Enterprise.

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Réserver une démo](https://befailproof.ai/get-a-demo)

---

## Documentation

| Démarrage | |
|---|---|
| [Démarrage rapide](https://docs.befailproof.ai/start/quickstart) | Installer, connecter un environnement, voir la première exécution |
| [Concepts](https://docs.befailproof.ai/start/concepts) | Comment fonctionne le système de hooks |
| [Environnements pris en charge](https://docs.befailproof.ai/reference/harnesses) | Les 12 environnements et ce que chacun peut appliquer |

| Observer | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | Suivre une exécution : modèles, outils, erreurs, latence |
| [Lire une trace](https://docs.befailproof.ai/sessions/read-a-trace) | Ce que le graphe d'exécution vous indique |
| [Audits](https://docs.befailproof.ai/audits/overview) | Identifier les patterns d'échec sur de nombreuses sessions |
| [Tableau de bord local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, aucun compte requis |

| Appliquer | |
|---|---|
| [Packs de politiques](https://docs.befailproof.ai/policies/packs) | Les politiques Failproof AI et les packs du hub de politiques |
| [Écrire une politique](https://docs.befailproof.ai/policies/editor) | À partir d'un audit, ou en code |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Portées de configuration, règles de fusion et paramètres de politique |

| Instrumenter votre propre agent | |
|---|---|
| [SDK Python](https://docs.befailproof.ai/reference/custom-agents) | Reporter des exécutions depuis un agent sans environnement dédié |
| [SDK de politiques](https://docs.befailproof.ai/reference/policy-sdk) | Référence `allow` / `deny` / `instruct` |

---

## Licence

MIT avec [Commons Clause](https://commonsclause.com/) — gratuit pour un usage interne et personnel ; la revente commerciale de failproofai lui-même nécessite un accord distinct. Voir [LICENSE](../../LICENSE) pour le texte complet.

---

## Contribuer

Voir [CONTRIBUTING.md](../../CONTRIBUTING.md). Nouvelles politiques, cas limites et traductions sont les bienvenus.

> **Compilez avant de commencer.** Lancez d'abord `bun install && bun run build`. Ce dépôt exécute ses propres hooks failproofai sur lui-même, et ils résolvent l'import `failproofai` par rapport au bundle compilé `dist/` — sans compilation, vous obtiendrez des erreurs de hook `Cannot find package 'failproofai'`. Recompilez après toute modification dans `src/`. Voir
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Fait avec ❤️ par [befailproof.ai](https://befailproof.ai) à SF et Bengaluru.
