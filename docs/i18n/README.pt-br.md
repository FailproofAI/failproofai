> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | **🇧🇷 Português** | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traduções:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Veja o que seus agentes fazem. Evite falhas conhecidas antes que se repitam.**
O Failproof AI funciona onde quer que seus agentes rodem: ferramentas de codificação como Claude Code e
Codex, gateways de chat como Hermes, assistentes auto-hospedados como OpenClaw, e agentes
que você mesmo instrumenta. Ele registra cada execução e pode bloquear chamadas de ferramentas perigosas
antes que sejam executadas.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI em ação" width="800" />
</p>

---

## Harnesses suportados

Doze harnesses em duas classes são suportados: dez CLIs de codificação, mais dois
gateways: Hermes e OpenClaw. A API de políticas e o histórico de sessões são compartilhados; quais
eventos podem bloquear varia de acordo com o harness.

Agentes que não rodam em nenhum deles reportam através do [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
que oferece rastreamento, sessões e auditorias. A aplicação de políticas nesses casos requer um hook no
seu próprio runtime — [fale conosco](mailto:support@befailproof.ai) e faremos o mapeamento.

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

## Instalação

Dê ao agente compatível a habilidade do Failproof AI se quiser que ele guie a configuração,
inspecione a máquina e roteie corretamente as políticas, auditorias, sessões e o trabalho na nuvem:

```sh
npx skills add FailproofAI/skills
```

Isso instala a habilidade principal e suas especializações. Para instalar apenas a
habilidade principal, adicione `--skill failproofai`. As habilidades fornecem instruções de operação; instale
e configure o produto em si com:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

A configuração conecta os agentes suportados e instala o serviço em segundo plano. Nenhum
pacote de políticas é selecionado por padrão: antes de adicionar um, apenas `block-failproofai-commands` é executado para impedir
que um agente desative o Failproof AI.

Conecte à nuvem sem prompts com `failproofai config --token <machine-key>`. Em uma
máquina compartilhada ou em CI, defina `FAILPROOFAI_CLOUD_TOKEN` e execute `failproofai config`
para que a chave não apareça no histórico de comandos.

---

## O que ele bloqueia

| Política | O que bloqueia |
|---|---|
| `sanitize-api-keys` | Vazamento de chaves de API no contexto do agente |
| `block-env-files` | Leituras de `.env` e outros arquivos de segredos |
| `warn-repeated-tool-calls` | O agente entrando em loop na mesma chamada |
| `block-sudo` | Escalada de privilégios |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sem restrições |
| `block-terraform` / `block-kubectl` | Alterações não revisadas em infraestrutura em produção |
| `block-rm-rf` | Exclusão recursiva de arquivos |
| `block-force-push` / `block-push-master` | `git push --force`, pushes diretos para `main` |

Essas políticas protegem arquivos, credenciais, infraestrutura, bancos de dados e
fluxos de trabalho de agentes. O suporte exato à aplicação varia por harness e evento.

→ [Todas as 39 políticas integradas](https://docs.befailproof.ai/policies/builtin)

---

## Suas próprias políticas

Adicione um arquivo em `.failproofai/policies/` — ele é carregado automaticamente, sem flags necessárias.
Faça o commit e toda a equipe receberá no próximo pull.

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
| `deny(message)` | Bloqueia — a mensagem é retornada ao agente |
| `instruct(message)` | Deixa passar, mas adiciona contexto ao próximo prompt do agente |

→ [Guia de políticas personalizadas](https://docs.befailproof.ai/policies/custom)

---

## Pacotes de políticas

Um pacote de políticas é um conjunto versionado de políticas publicado a partir de um repositório
público no GitHub. Inspecione um antes de instalá-lo:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Qualquer coisa com uma barra é uma fonte de pacote; qualquer coisa sem barra é um nome de política.
Você pode instalar categorias ou políticas selecionadas e fixar uma versão quando necessário.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Navegue pelos pacotes publicados no [Policy Hub](https://befailproof.ai/policy-hub/), ou
execute `failproofai publish --init` para criar o seu próprio. O modo de observação permite que um pacote registre
o que teria feito sem bloquear: `failproofai publish --effect observe`.

→ [Pacotes de políticas](https://docs.befailproof.ai/policies/packs) ·
[Publicar um pacote](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Observabilidade

A aplicação de políticas é uma metade. A outra é ver o que o agente realmente fez.

Execute `failproofai` sem argumentos e ele servirá um dashboard em `localhost:8020`
lendo o histórico de execuções já presente na sua máquina — sem conta, sem cadastro, nada
saindo do servidor. Você tem a lista de sessões, a sequência de chamadas ao modelo, chamadas de ferramentas
e decisões de hooks dentro de cada execução, o que foi bloqueado e o que a política informou ao
agente, além de uma auditoria offline (`failproofai audit`) que analisa seu histórico em busca de padrões
arriscados e sugere políticas para bloqueá-los.

→ [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Lendo um trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Auditoria local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** é o lado hospedado do mesmo modelo de dados, para equipes
que executam agentes em uma frota: cada execução de cada harness em um único lugar, um
grafo de execução com sub-agentes paralelos em suas próprias faixas, latência p50/p95/p99
para modelos, ferramentas e hooks, rastreamento de custo e janela de contexto por modelo, rastreamento
de erros, SQL sobre seus próprios traces com dashboards compartilháveis, avaliações pontuadas pelo
seu próprio serviço, auditorias agendadas que transformam falhas recorrentes em descobertas baseadas
em evidências, e alertas roteados para Slack, e-mail ou um webhook assinado. Auto-hospedagem no seu
próprio cluster está disponível no plano Enterprise.

→ [Sessões](https://docs.befailproof.ai/sessions/overview) ·
[Auditorias](https://docs.befailproof.ai/audits/overview) ·
[Agendar uma demonstração](https://befailproof.ai/get-a-demo)

---

## Documentação

| Início | |
|---|---|
| [Início rápido](https://docs.befailproof.ai/start/quickstart) | Instale, conecte um harness, veja a primeira execução |
| [Conceitos](https://docs.befailproof.ai/start/concepts) | Como o sistema de hooks funciona |
| [Harnesses suportados](https://docs.befailproof.ai/reference/harnesses) | Todos os 12, e o que cada um pode aplicar |

| Observar | |
|---|---|
| [Sessões](https://docs.befailproof.ai/sessions/overview) | Acompanhe uma execução: modelos, ferramentas, erros, latência |
| [Lendo um trace](https://docs.befailproof.ai/sessions/read-a-trace) | O que o grafo de execução está mostrando |
| [Auditorias](https://docs.befailproof.ai/audits/overview) | Encontre padrões de falha em várias sessões |
| [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sem necessidade de conta |

| Aplicar políticas | |
|---|---|
| [Políticas integradas](https://docs.befailproof.ai/policies/builtin) | Todas as 39 políticas com parâmetros |
| [Políticas personalizadas](https://docs.befailproof.ai/policies/custom) | Escreva as suas próprias |
| [Configuração](https://docs.befailproof.ai/policies/local-configuration) | Escopos de configuração e regras de mesclagem |

| Instrumente seu próprio agente | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Reporte execuções de um agente sem harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Referência de `allow` / `deny` / `instruct` |

---

## Licença

MIT com [Commons Clause](https://commonsclause.com/) — gratuito para uso interno e pessoal; a revenda comercial do failproofai em si requer um contrato separado. Consulte [LICENSE](../../LICENSE) para o texto completo.

---

## Contribuindo

Veja [CONTRIBUTING.md](../../CONTRIBUTING.md). Novas políticas, casos extremos e traduções são bem-vindos.

> **Compile antes de começar.** Execute `bun install && bun run build` primeiro. Este repositório executa
> os próprios hooks do failproofai sobre si mesmo, e eles resolvem o import `failproofai` contra o
> bundle compilado em `dist/` — sem uma compilação você encontrará erros de hook `Cannot find package 'failproofai'`.
> Recompile após alterar `src/`. Veja
> [Build antes que os hooks de desenvolvimento do repositório funcionem](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Desenvolvido com ❤️ por [befailproof.ai](https://befailproof.ai) em SF e Bengaluru.
