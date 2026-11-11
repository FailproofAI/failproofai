> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | **🇧🇷 Português** | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traduções:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observabilidade e aplicação de políticas para cada ambiente onde seus agentes rodam.**
Onde quer que seus agentes estejam, nós enxergamos — e podemos dizer não. O Failproof hooks em 12 ambientes de agentes — CLIs de codificação como Claude Code e Codex, gateways de chat como Hermes, assistentes auto-hospedados como OpenClaw — capturando cada execução e bloqueando chamadas de ferramentas perigosas antes que sejam executadas. 40 políticas integradas. Zero latência. Roda localmente.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Ambientes suportados

Doze ambientes em duas categorias — dez CLIs de codificação e dois gateways de chat e assistentes (Hermes, OpenClaw). Uma única API de políticas e um histórico de sessões unificado entre todos eles. O que uma política pode *bloquear* varia por ambiente: impedir uma chamada de ferramenta antes de executar está verificado nos doze, portões de fim de turno em oito. A [matriz por ambiente](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) lista os eventos que cada um suporta.

Agentes que não rodam em nenhum deles reportam pelo [Python SDK](https://docs.befailproof.ai/reference/custom-agents), que oferece rastreamento, sessões e auditorias. A aplicação de políticas nesses casos requer um hook no seu próprio runtime — [fale conosco](mailto:support@befailproof.ai) e mapeamos juntos.

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

```sh
npm install -g failproofai
failproofai config                             # configure seus agentes e o daemon
failproofai policies add FailproofAI/policies  # escolha o que aplicar
failproofai                                    # dashboard em localhost:8020
```

A configuração registra os hooks e não seleciona **nenhuma** política — o segundo comando é o que coloca as barreiras na máquina, e qualquer pacote é adicionado da mesma forma (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` lê um primeiro). Execute `failproofai config` sem terminal — em CI, num container, com um agente controlando — e ele aplica as configurações em vez de perguntar. Em uma máquina que nunca foi configurada, qualquer outro comando executa o mesmo assistente de configuração primeiro; desative isso com `FAILPROOFAI_NO_FIRST_RUN=1`.

Até que um pacote seja instalado, a única coisa aplicada é `block-failproofai-commands`, que está sempre ativa e não pode ser desligada ou pausada: um agente capaz de pausar a aplicação de políticas poderia desativar todas as outras.

---

## O que é bloqueado

| Política | O que bloqueia |
|---|---|
| `block-env-files` | Leitura de `.env` e outros arquivos de segredos |
| `warn-repeated-tool-calls` | O agente entrando em loop na mesma chamada |
| `block-sudo` | Escalada de privilégios |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sem condição |
| `block-terraform` / `block-kubectl` | Alterações sem revisão em infraestrutura em produção |
| `block-rm-rf` | Deleção recursiva de arquivos |
| `block-force-push` / `block-push-master` | `git push --force`, pushes diretos para `main` |

Cada uma dessas políticas intercepta a chamada *antes* de ela executar, portanto funcionam nos doze ambientes. As quatro primeiras se aplicam a qualquer agente que possa chamar uma ferramenta; as três últimas são as favoritas dos desenvolvedores — CLIs de codificação são a categoria de ambiente que cobrimos com mais profundidade. A família `sanitize-*` é separada: ela roda após o retorno de uma ferramenta, relatando segredos na saída em vez de impedi-los de entrar no contexto.

→ [Todas as 40 políticas integradas](https://docs.befailproof.ai/policies/packs)

---

## Suas próprias políticas

Adicione um arquivo em `.failproofai/policies/` — ele é carregado automaticamente, sem flags necessárias. Faça commit e toda a equipe recebe na próxima atualização.

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
| `instruct(message)` | Permite a passagem, mas adiciona contexto ao próximo prompt do agente |

→ [Escrever uma política](https://docs.befailproof.ai/policies/editor)

---

## Observabilidade

A aplicação de políticas é uma metade. A outra metade é enxergar o que o agente realmente fez.

Execute `failproofai` sem argumentos e ele serve um dashboard em `localhost:8020` lendo o histórico de execuções já na sua máquina — sem conta, sem cadastro, sem nada saindo da máquina. Você tem a lista de sessões, a sequência de chamadas de modelo, chamadas de ferramentas e decisões de hook dentro de cada execução, o que foi bloqueado e o que a política disse ao agente, além de uma auditoria offline (`failproofai audit`) que escaneia seu histórico em busca de padrões arriscados e sugere políticas para bloqueá-los.

→ [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Ler um trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Auditoria local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** é o lado hospedado do mesmo modelo de dados, para equipes que rodam agentes em múltiplas máquinas: todas as execuções de todos os ambientes em um só lugar, um grafo de execução com sub-agentes paralelos em suas próprias trilhas, latência p50/p95/p99 para modelos, ferramentas e hooks, rastreamento de custo e janela de contexto por modelo, rastreamento de erros, SQL sobre seus próprios traces com dashboards compartilháveis, avaliações pontuadas pelo seu próprio serviço, auditorias programadas que transformam falhas recorrentes em descobertas embasadas em evidências, e alertas roteados para Slack, e-mail ou webhook assinado. Auto-hospedagem no seu próprio cluster está disponível no plano Enterprise.

→ [Sessões](https://docs.befailproof.ai/sessions/overview) ·
[Auditorias](https://docs.befailproof.ai/audits/overview) ·
[Agendar uma demo](https://befailproof.ai/get-a-demo)

---

## Documentação

| Início | |
|---|---|
| [Início rápido](https://docs.befailproof.ai/start/quickstart) | Instalar, conectar um ambiente, ver a primeira execução |
| [Conceitos](https://docs.befailproof.ai/start/concepts) | Como o sistema de hooks funciona |
| [Ambientes suportados](https://docs.befailproof.ai/reference/harnesses) | Todos os 12 e o que cada um pode aplicar |

| Observar | |
|---|---|
| [Sessões](https://docs.befailproof.ai/sessions/overview) | Acompanhar uma execução: modelos, ferramentas, erros, latência |
| [Ler um trace](https://docs.befailproof.ai/sessions/read-a-trace) | O que o grafo de execução está mostrando |
| [Auditorias](https://docs.befailproof.ai/audits/overview) | Encontrar padrões de falha em muitas sessões |
| [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sem conta necessária |

| Aplicar | |
|---|---|
| [Pacotes de políticas](https://docs.befailproof.ai/policies/packs) | As políticas do Failproof AI e pacotes do hub de políticas |
| [Escrever uma política](https://docs.befailproof.ai/policies/editor) | A partir de uma auditoria ou em código |
| [Configuração](https://docs.befailproof.ai/policies/local-configuration) | Escopos de configuração, regras de mesclagem e parâmetros de política |

| Instrumentar seu próprio agente | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Reportar execuções de um agente sem ambiente |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Referência de `allow` / `deny` / `instruct` |

---

## Licença

MIT com [Commons Clause](https://commonsclause.com/) — gratuito para uso interno e pessoal; revenda comercial do failproofai em si requer um acordo separado. Veja [LICENSE](../../LICENSE) para o texto completo.

---

## Contribuindo

Veja [CONTRIBUTING.md](../../CONTRIBUTING.md). Novas políticas, casos de borda e traduções são bem-vindos.

---

Desenvolvido com ❤️ por [befailproof.ai](https://befailproof.ai) em SF e Bengaluru.
