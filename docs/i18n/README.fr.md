> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | **🇫🇷 Français** | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traductions :** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Voyez ce que font vos agents. Bloquez les défaillances connues avant qu'elles se reproduisent.**
Failproof AI fonctionne partout où vos agents s'exécutent : les outils de codage comme Claude Code et
Codex, les passerelles de chat comme Hermes, les assistants auto-hébergés comme OpenClaw, et les agents
que vous instrumentez vous-même. Il enregistre chaque exécution et peut bloquer les appels d'outils dangereux
avant qu'ils ne s'exécutent.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Environnements d'exécution pris en charge

Douze environnements d'exécution répartis en deux catégories sont pris en charge : dix CLI de codage, ainsi que deux
passerelles : Hermes et OpenClaw. L'API de politique et l'historique de session sont partagés ; les événements
pouvant être bloqués varient selon l'environnement.

Les agents qui n'en utilisent aucun rapportent via le [SDK Python](https://docs.befailproof.ai/reference/custom-agents),
qui vous offre le traçage, les sessions et les audits. L'application des règles nécessite un hook dans
votre propre runtime — [contactez-nous](mailto:support@befailproof.ai) et nous l'adapterons.

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

Donnez à un agent compatible la compétence Failproof AI si vous souhaitez qu'il guide la configuration,
inspecte la machine et route correctement les politiques, les audits, les sessions et les opérations Cloud :

```sh
npx skills add FailproofAI/skills
```

Cette commande installe la compétence principale ainsi que ses compétences spécialisées associées. Pour installer uniquement la
compétence principale, ajoutez `--skill failproofai`. Les compétences fournissent les instructions d'exploitation ; installez
et configurez le produit lui-même avec :

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

La configuration connecte les agents pris en charge et installe le service en arrière-plan. Aucun pack de politiques n'est sélectionné
par défaut : avant d'en ajouter un, seule la règle `block-failproofai-commands` s'exécute pour empêcher
un agent de désactiver Failproof AI.

Connectez Cloud sans invite de commande avec `failproofai config --token <machine-key>`. Sur une
machine partagée ou en CI, définissez `FAILPROOFAI_CLOUD_TOKEN` et exécutez `failproofai config`
pour que la clé n'apparaisse pas dans l'historique des commandes.

---

## Ce qu'il bloque

| Politique | Ce qu'elle bloque |
|---|---|
| `sanitize-api-keys` | Les clés API qui fuient dans le contexte de l'agent |
| `block-env-files` | La lecture des fichiers `.env` et autres fichiers secrets |
| `warn-repeated-tool-calls` | L'agent qui boucle sur le même appel |
| `block-sudo` | L'escalade de privilèges |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sans condition |
| `block-terraform` / `block-kubectl` | Les modifications non vérifiées de l'infrastructure en production |
| `block-rm-rf` | La suppression récursive de fichiers |
| `block-force-push` / `block-push-master` | `git push --force`, les pushs directs vers `main` |

Ces politiques protègent les fichiers, les credentials, l'infrastructure, les bases de données et les
workflows des agents. La prise en charge exacte de l'application varie selon l'environnement et l'événement.

→ [Les 39 politiques intégrées](https://docs.befailproof.ai/policies/builtin)

---

## Vos propres politiques

Déposez un fichier dans `.failproofai/policies/` — il se charge automatiquement, sans aucun paramètre.
Commitez-le et toute l'équipe en bénéficie dès le prochain pull.

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
| `instruct(message)` | La laisser passer, mais ajouter du contexte à la prochaine invite de l'agent |

→ [Guide des politiques personnalisées](https://docs.befailproof.ai/policies/custom)

---

## Packs de politiques

Un pack de politiques est un ensemble versionné de politiques publié depuis un dépôt GitHub
public. Inspectez-en un avant de l'installer :

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Tout ce qui contient un slash est une source de pack ; tout ce qui n'en contient pas est un nom de politique.
Vous pouvez installer des catégories ou des politiques sélectionnées, et épingler une version si nécessaire.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Parcourez les packs publiés dans le [Policy Hub](https://befailproof.ai/policy-hub/), ou
exécutez `failproofai publish --init` pour créer le vôtre. Le mode observation permet à un pack d'enregistrer
ce qu'il aurait fait sans bloquer : `failproofai publish --effect observe`.

→ [Packs de politiques](https://docs.befailproof.ai/policies/packs) ·
[Publier un pack](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Observabilité

L'application des règles n'est qu'une moitié du tableau. L'autre moitié consiste à voir ce que l'agent a réellement fait.

Exécutez `failproofai` sans argument et il sert un tableau de bord sur `localhost:8020`
en lisant l'historique des exécutions déjà présent sur votre machine — sans compte, sans inscription, sans
rien qui quitte la machine. Vous obtenez la liste des sessions, la séquence des appels de modèles, des appels d'outils
et des décisions de hook dans chaque exécution, ce qui a été bloqué et ce que la politique a transmis à
l'agent, ainsi qu'un audit hors ligne (`failproofai audit`) qui analyse votre historique pour détecter des
schémas risqués et suggère des politiques pour les contrer.

→ [Tableau de bord local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Lire une trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Audit local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** est la face hébergée du même modèle de données, pour les équipes
qui exécutent des agents sur une flotte : chaque exécution de chaque environnement en un seul endroit, un
graphe d'exécution avec des sous-agents parallèles sur leurs propres voies, la latence p50/p95/p99
pour les modèles, les outils et les hooks, le suivi des coûts et de la fenêtre de contexte par modèle, le suivi des erreurs, SQL sur vos propres traces avec des tableaux de bord partageables, des évaluations scorées par
votre propre service, des audits planifiés qui transforment les échecs récurrents en conclusions étayées par des preuves, et des alertes acheminées vers Slack, par e-mail ou via un webhook signé. L'auto-hébergement dans votre
propre cluster est disponible avec le plan Enterprise.

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[Demander une démo](https://befailproof.ai/get-a-demo)

---

## Documentation

| Démarrage | |
|---|---|
| [Démarrage rapide](https://docs.befailproof.ai/start/quickstart) | Installer, connecter un environnement, voir la première exécution |
| [Concepts](https://docs.befailproof.ai/start/concepts) | Comment le système de hooks fonctionne |
| [Environnements pris en charge](https://docs.befailproof.ai/reference/harnesses) | Les 12 environnements et ce que chacun peut appliquer |

| Observer | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | Suivre une exécution : modèles, outils, erreurs, latence |
| [Lire une trace](https://docs.befailproof.ai/sessions/read-a-trace) | Ce que le graphe d'exécution vous indique |
| [Audits](https://docs.befailproof.ai/audits/overview) | Identifier les schémas d'échec sur de nombreuses sessions |
| [Tableau de bord local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sans compte requis |

| Appliquer | |
|---|---|
| [Politiques intégrées](https://docs.befailproof.ai/policies/builtin) | Les 39 politiques avec leurs paramètres |
| [Politiques personnalisées](https://docs.befailproof.ai/policies/custom) | Écrire les vôtres |
| [Configuration](https://docs.befailproof.ai/policies/local-configuration) | Portées de configuration et règles de fusion |

| Instrumenter votre propre agent | |
|---|---|
| [SDK Python](https://docs.befailproof.ai/reference/custom-agents) | Rapporter les exécutions depuis un agent sans environnement dédié |
| [SDK de politique](https://docs.befailproof.ai/reference/policy-sdk) | Référence `allow` / `deny` / `instruct` |

---

## Licence

MIT avec [Commons Clause](https://commonsclause.com/) — gratuit pour un usage interne et personnel ; la revente commerciale de failproofai lui-même nécessite un accord distinct. Consultez [LICENSE](../../LICENSE) pour le texte complet.

---

## Contribution

Consultez [CONTRIBUTING.md](../../CONTRIBUTING.md). Les nouvelles politiques, les cas limites et les traductions sont les bienvenus.

> **Compilez avant de commencer.** Exécutez d'abord `bun install && bun run build`. Ce dépôt exécute
> les propres hooks de failproofai sur lui-même, et ils résolvent l'import `failproofai` par rapport au
> bundle `dist/` compilé — sans compilation, vous obtiendrez des erreurs de hook `Cannot find package 'failproofai'`.
> Recompilez après avoir modifié `src/`. Voir
> [Compiler avant que les hooks de développement internes ne fonctionnent](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Fait avec ❤️ par [befailproof.ai](https://befailproof.ai) à San Francisco et Bengaluru.
