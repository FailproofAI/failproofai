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

**Resolução de falhas em tempo de execução para agentes de codificação.**
Integra-se ao Claude Code e ao Codex. Detecta loops, ações perigosas e vazamentos de segredos
antes que se tornem incidentes. Latência zero. Executa localmente.

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

> Instale hooks para um ou qualquer combinação: `failproofai policies --install --cli opencode pi` (ou `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Omita `--cli` para detectar automaticamente os CLIs instalados e exibir um prompt.
>
> **Hermes** (hermes-agent, um gateway Slack/Telegram) é suportado tanto para **imposição de hooks ao vivo** (`--cli hermes` — uma única instalação intercepta chamadas de ferramentas de todas as plataformas e subagentes) quanto para **auditoria** offline com replay de suas sessões de gateway a partir do único `~/.hermes/state.db`.
>
> **OpenClaw** (openclaw gateway, um assistente multicanal auto-hospedado) é suportado tanto para **imposição de hooks ao vivo** (`--cli openclaw`, escopo de usuário) quanto para **auditoria** offline com replay de suas sessões JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). A imposição utiliza os **hooks de plugin in-process** do OpenClaw (um `openclaw-plugin/` incluído que invoca failproofai de forma assíncrona — seus hooks internos baseados em arquivo são apenas observação e não podem bloquear): `before_tool_call` bloqueia uma ferramenta, e `before_agent_finalize` é um portão real de fim de turno, portanto os builtins `require-*-before-stop` são aplicados.
>
> **Factory Droid** (`droid`) é suportado tanto para **imposição de hooks ao vivo** (`--cli factory`, escopo de usuário + projeto) quanto para **auditoria** offline com replay de suas sessões JSONL em disco. O droid bloqueia chamadas de ferramentas com **código de saída 2** do hook (não uma decisão JSON) e respeita `{decision:"block"}` apenas no evento `Stop` de fim de turno — failproofai emite o formato correto por evento automaticamente.
>
> **Devin CLI** (`devin`, Cognition) é suportado tanto para **imposição de hooks ao vivo** (`--cli devin`, escopo de usuário + projeto) quanto para **auditoria** offline com replay de suas sessões SQLite (`~/.local/share/devin/cli/sessions.db`). Devin é um **clone puro do Claude** — mesmos nomes de eventos, mesmo payload em snake_case, mesma configuração com wrapper `"hooks"` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — bloqueio via JSON `{decision:"block"}` em todos os eventos.
>
> **Antigravity CLI** (`agy`) é suportado tanto para **imposição de hooks ao vivo** (`--cli antigravity`, escopo de usuário + projeto) quanto para **auditoria** offline com replay de suas sessões em JSONL simples (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). O Antigravity possui seu **próprio** contrato (não é um clone do Claude): um esquema `hooks.json` com **hooks nomeados** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), um payload stdin em camelCase que failproofai normaliza, e seus próprios formatos de resposta — `{decision:"deny"}` para bloquear uma ferramenta, `{decision:"continue"}` para forçar outro turno no `Stop`, `{injectSteps}` para injetar um lembrete antes de o modelo ser executado.
>
> **Goose** (codinome goose, Block) é suportado tanto para **imposição de hooks ao vivo** (`--cli goose`, escopo de usuário + projeto) quanto para **auditoria** offline com replay de suas sessões SQLite (`~/.local/share/goose/sessions/sessions.db`). A imposição utiliza o sistema de **hooks** do Goose (a especificação **Open Plugins** cross-agent) — o instalador apenas cria um diretório de plugin em `~/.agents/plugins/failproofai/` e o Goose o detecta automaticamente. O bloqueio é feito com JSON `{"decision":"block"}` no evento `PreToolUse` (que dispara para a ferramenta shell e dentro de subagentes delegados), verificado ao vivo contra o goose v1.43.0; o Goose não possui evento `Stop` de fim de turno, portanto os builtins `require-*-before-stop` não se aplicam (assim como no Hermes).

---

## Instalação

```sh
npm install -g failproofai
failproofai policies --install   # ou simplesmente execute `failproofai` e aceite o prompt de primeira execução
failproofai
```

30 políticas integradas são ativadas imediatamente. Dashboard em `localhost:8020`. Desative o prompt de primeira execução com `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## O que ele impede

| Política | O que bloqueia |
|---|---|
| `block-push-master` | Pushes diretos para `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges e rebases em `main` / `master` |
| `block-rm-rf` | Exclusão recursiva de arquivos |
| `sanitize-api-keys` | Chaves de API vazando para o contexto do agente |

→ [Todas as 30 políticas integradas](https://docs.befailproof.ai/built-in-policies)

---

## Suas próprias políticas

Adicione um arquivo em `.failproofai/policies/` — ele é carregado automaticamente, sem necessidade de flags.
Faça commit e toda a equipe receberá na próxima atualização.

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

## Visibilidade das sessões

Cada chamada de ferramenta feita pelo seu agente é registrada localmente. O dashboard mostra o que foi executado,
o que foi bloqueado e o que a política informou ao agente — para que você não fique no escuro
quando algo der errado. → [Guia do Dashboard](https://docs.befailproof.ai/dashboard)

---

## Documentação

| | |
|---|---|
| [Primeiros Passos](https://docs.befailproof.ai/getting-started) | Instalação e primeiros passos |
| [Políticas Integradas](https://docs.befailproof.ai/built-in-policies) | Todas as 30 políticas com parâmetros |
| [Políticas Personalizadas](https://docs.befailproof.ai/custom-policies) | Escreva as suas próprias |
| [Configuração](https://docs.befailproof.ai/configuration) | Escopos de configuração e regras de mesclagem |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Monitor de sessões e atividade de políticas |
| [Arquitetura](https://docs.befailproof.ai/architecture) | Como o sistema de hooks funciona |

---

## Licença

MIT com [Commons Clause](https://commonsclause.com/) — gratuito para uso interno e pessoal; a revenda comercial do próprio failproofai requer um acordo separado. Consulte [LICENSE](./LICENSE) para o texto completo.

---

## Contribuindo

Consulte [CONTRIBUTING.md](./CONTRIBUTING.md). Novas políticas, casos extremos e traduções são bem-vindos.

> **Compile antes de começar.** Execute `bun install && bun run build` primeiro. Este repositório executa
> os próprios hooks do failproofai sobre si mesmo, e eles resolvem o import `failproofai` a partir do
> bundle compilado em `dist/` — sem uma compilação você encontrará erros de hook `Cannot find package 'failproofai'`.
> Recompile após alterar `src/`. Consulte
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Desenvolvido por [Nivedit Jain](https://github.com/NiveditJain) e [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
