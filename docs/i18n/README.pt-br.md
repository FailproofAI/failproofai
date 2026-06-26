> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | **🇧🇷 Português** | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Traduções:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Resolução de falhas em tempo de execução para agentes de código.**
Integra-se ao Claude Code e ao Codex. Detecta loops, ações perigosas e vazamentos de segredos
antes que se tornem incidentes. Latência zero. Roda localmente.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## CLIs de agentes suportados

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

> Instale hooks para um ou qualquer combinação: `failproofai policies --install --cli opencode pi gemini` (ou `--cli claude codex copilot cursor opencode pi gemini`). Omita `--cli` para detectar automaticamente as CLIs instaladas e ser guiado por um prompt.

---

## Instalação

```sh
npm install -g failproofai
failproofai policies --install   # ou simplesmente execute `failproofai` e aceite o prompt da primeira execução
failproofai
```

30 políticas integradas são ativadas imediatamente. Dashboard em `localhost:8020`. Desative o prompt da primeira execução com `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## O que é bloqueado

| Política | O que bloqueia |
|---|---|
| `block-push-master` | Pushes diretos para `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges e rebases em `main` / `master` |
| `block-rm-rf` | Exclusão recursiva de arquivos |
| `sanitize-api-keys` | Vazamento de chaves de API para o contexto do agente |

→ [Todas as 30 políticas integradas](https://docs.befailproof.ai/built-in-policies)

---

## Suas próprias políticas

Coloque um arquivo em `.failproofai/policies/` — ele é carregado automaticamente, sem necessidade de flags.
Faça o commit e toda a equipe receberá a política no próximo pull.

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

Três decisões disponíveis para cada política:

| Decisão | Efeito |
|---|---|
| `allow()` | Permite a operação |
| `deny(message)` | Bloqueia — a mensagem é enviada de volta ao agente |
| `instruct(message)` | Deixa passar, mas adiciona contexto ao próximo prompt do agente |

→ [Guia de políticas personalizadas](https://docs.befailproof.ai/custom-policies)

---

## Visibilidade da sessão

Cada chamada de ferramenta feita pelo seu agente é registrada localmente. O dashboard mostra o que foi executado,
o que foi bloqueado e o que a política comunicou ao agente — para que você não fique no escuro
quando algo der errado. → [Guia do Dashboard](https://docs.befailproof.ai/dashboard)

---

## Documentação

| | |
|---|---|
| [Primeiros Passos](https://docs.befailproof.ai/getting-started) | Instalação e primeiros passos |
| [Políticas Integradas](https://docs.befailproof.ai/built-in-policies) | Todas as 30 políticas com parâmetros |
| [Políticas Personalizadas](https://docs.befailproof.ai/custom-policies) | Escreva as suas próprias |
| [Configuração](https://docs.befailproof.ai/configuration) | Escopos de configuração e regras de mesclagem |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Monitor de sessão e atividade de políticas |
| [Arquitetura](https://docs.befailproof.ai/architecture) | Como o sistema de hooks funciona |

---

## Licença

MIT com [Commons Clause](https://commonsclause.com/) — gratuito para uso interno e pessoal; a revenda comercial do próprio failproofai requer um acordo separado. Veja [LICENSE](./LICENSE) para o texto completo.

---

## Contribuindo

Consulte [CONTRIBUTING.md](./CONTRIBUTING.md). Novas políticas, casos extremos e traduções são bem-vindos.

> **Faça o build antes de começar.** Execute `bun install && bun run build` primeiro. Este repositório roda
> os próprios hooks do failproofai sobre si mesmo, e eles resolvem o import `failproofai` em relação ao
> bundle compilado em `dist/` — sem um build, você receberá erros de hook como `Cannot find package 'failproofai'`.
> Refaça o build após alterar `src/`. Veja
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Desenvolvido por [Nivedit Jain](https://github.com/NiveditJain) e [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
