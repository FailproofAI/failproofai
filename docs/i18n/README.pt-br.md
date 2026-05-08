> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | **🇧🇷 Português** | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**Traduções**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

A maneira mais fácil de gerenciar políticas que mantêm seus agentes de IA confiáveis, focados nas tarefas e operando de forma autônoma - para **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ e o **Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI em ação" width="800" />
</p>

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

> Instale hooks para um ou qualquer combinação: `failproofai policies --install --cli opencode pi gemini` (ou `--cli claude codex copilot cursor opencode pi gemini`). Omita `--cli` para detectar automaticamente os CLIs instalados e exibir um prompt. **O suporte a GitHub Copilot CLI, Cursor Agent, OpenCode, Pi e Gemini CLI está em beta — os testes estão em andamento.**

- **39 Políticas Integradas** - Detecte os modos de falha mais comuns dos agentes logo de cara. Bloqueie comandos destrutivos, evite vazamento de segredos, mantenha os agentes dentro dos limites do projeto, detecte loops e muito mais.
- **Políticas Personalizadas** - Escreva suas próprias regras de confiabilidade em JavaScript. Use a API `allow`/`deny`/`instruct` para aplicar convenções, prevenir desvios, controlar operações ou integrar com sistemas externos.
- **Configuração Simples** - Ajuste qualquer política sem escrever código. Defina listas de permissão, branches protegidas e limites por projeto ou globalmente. Três escopos de configuração são mesclados automaticamente.
- **Monitor de Agentes** - Veja o que seus agentes fizeram enquanto você estava ausente. Navegue pelas sessões, inspecione cada chamada de ferramenta e revise exatamente onde as políticas foram acionadas.

Tudo é executado localmente — nenhum dado sai da sua máquina.

---

## Requisitos

- Node.js >= 20.9.0
- Bun >= 1.3.0 (opcional - necessário apenas para desenvolvimento / compilação a partir do código-fonte)

---

## Instalação

```bash
npm install -g failproofai
# ou
bun add -g failproofai
```

---

## Início rápido

### 1. Habilitar políticas globalmente

```bash
failproofai policies --install
```

Escreve entradas de hook em `~/.claude/settings.json`. Claude Code passará a invocar failproofai antes e depois de cada chamada de ferramenta.

### 2. Abrir o painel

```bash
failproofai
```

Abre `http://localhost:8020` - navegue pelas sessões, inspecione logs, gerencie políticas.

### 3. Verificar o que está ativo

```bash
failproofai policies
```

---

## Instalação de políticas

### Escopos

| Escopo | Comando | Onde escreve |
|--------|---------|--------------|
| Global (padrão) | `failproofai policies --install` | `~/.claude/settings.json` |
| Projeto | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Local | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Instalar políticas específicas

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Remover políticas

```bash
failproofai policies --uninstall
# ou para um escopo específico:
failproofai policies --uninstall --scope project
```

---

## Configuração

A configuração de políticas fica em `~/.failproofai/policies-config.json` (global) ou `.failproofai/policies-config.json` no seu projeto (por projeto).

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "Use apt-get directly without sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Try creating a fresh branch instead."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**Três escopos de configuração** são mesclados automaticamente (projeto → local → global). Consulte [docs/configuration.mdx](docs/configuration.mdx) para as regras completas de mesclagem.

---

## Políticas integradas

| Política | Descrição | Configurável |
|----------|-----------|:---:|
| `block-sudo` | Impede que agentes executem comandos privilegiados do sistema | `allowPatterns` |
| `block-rm-rf` | Previne exclusão recursiva acidental de arquivos | `allowPaths` |
| `block-curl-pipe-sh` | Impede que agentes redirecionem scripts não confiáveis para o shell | |
| `block-failproofai-commands` | Previne a desinstalação automática | |
| `sanitize-jwt` | Evita que tokens JWT vazem para o contexto do agente | |
| `sanitize-api-keys` | Evita que chaves de API vazem para o contexto do agente | `additionalPatterns` |
| `sanitize-connection-strings` | Evita que credenciais de banco de dados vazem para o contexto do agente | |
| `sanitize-private-key-content` | Remove blocos de chave privada PEM da saída | |
| `sanitize-bearer-tokens` | Remove tokens Bearer de Authorization da saída | |
| `block-env-files` | Impede que agentes leiam arquivos .env | |
| `protect-env-vars` | Impede que agentes imprimam variáveis de ambiente | |
| `block-read-outside-cwd` | Mantém os agentes dentro dos limites do projeto | `allowPaths` |
| `block-secrets-write` | Previne gravações em arquivos de chave privada e certificado | `additionalPatterns` |
| `block-push-master` | Previne pushes acidentais para main/master | `protectedBranches` |
| `block-work-on-main` | Mantém os agentes fora de branches protegidas | `protectedBranches` |
| `block-force-push` | Previne `git push --force` | |
| `warn-git-amend` | Lembra os agentes antes de emendar commits | |
| `warn-git-stash-drop` | Lembra os agentes antes de descartar stashes | |
| `warn-all-files-staged` | Detecta `git add -A` acidental | |
| `warn-destructive-sql` | Detecta DROP/DELETE SQL antes da execução | |
| `warn-schema-alteration` | Detecta ALTER TABLE antes da execução | |
| `warn-large-file-write` | Detecta gravações de arquivos inesperadamente grandes | `thresholdKb` |
| `warn-package-publish` | Detecta `npm publish` acidental | |
| `warn-background-process` | Detecta inicializações não intencionais de processos em segundo plano | |
| `warn-global-package-install` | Detecta instalações não intencionais de pacotes globais | |
| …e mais | | |

Detalhes completos das políticas e referência de parâmetros: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Políticas personalizadas

Escreva suas próprias políticas para manter os agentes confiáveis e focados nas tarefas:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Block writes to paths containing 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Writes to production paths are blocked");
    return allow();
  },
});
```

Instale com:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Funções auxiliares de decisão

| Função | Efeito |
|--------|--------|
| `allow()` | Permite a operação |
| `allow(message)` | Permite e envia contexto informativo para Claude |
| `deny(message)` | Bloqueia a operação; mensagem exibida para Claude |
| `instruct(message)` | Adiciona contexto ao prompt de Claude; não bloqueia |

### Objeto de contexto (`ctx`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | Ferramenta sendo chamada (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | Parâmetros de entrada da ferramenta |
| `payload` | `object` | Payload completo do evento bruto |
| `session.cwd` | `string` | Diretório de trabalho da sessão Claude Code |
| `session.sessionId` | `string` | Identificador da sessão |
| `session.transcriptPath` | `string` | Caminho para o arquivo de transcrição da sessão |

Hooks personalizados suportam importações locais transitivas, async/await e acesso a `process.env`. Erros são fail-open (registrados em `~/.failproofai/hook.log`, as políticas integradas continuam funcionando). Consulte [docs/custom-hooks.mdx](docs/custom-hooks.mdx) para o guia completo.

### Políticas baseadas em convenção

Coloque arquivos `*policies.{js,mjs,ts}` em `.failproofai/policies/` e eles serão carregados automaticamente — sem flags ou alterações de configuração necessárias. Faça o commit do diretório no git e todos os membros da equipe receberão os mesmos padrões de qualidade automaticamente.

```text
# Nível de projeto — commitado no git, compartilhado com a equipe
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Nível de usuário — pessoal, aplica-se a todos os projetos
~/.failproofai/policies/my-policies.mjs
```

Ambos os níveis são carregados (união). Os arquivos são carregados em ordem alfabética dentro de cada diretório. Use o prefixo `01-`, `02-`, etc. para controlar a ordem. À medida que sua equipe descobre novos modos de falha, adicione uma política e faça o push — todos recebem a atualização no próximo pull. Veja [examples/convention-policies/](examples/convention-policies/) para exemplos prontos para uso.

---

## Telemetria

Failproof AI coleta telemetria de uso anônima via PostHog para entender o uso das funcionalidades. Nenhum conteúdo de sessão, nome de arquivo, entrada de ferramenta ou informação pessoal é enviado.

Para desativar:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Documentação

| Guia | Descrição |
|------|-----------|
| [Primeiros Passos](docs/getting-started.mdx) | Instalação e primeiros passos |
| [Políticas Integradas](docs/built-in-policies.mdx) | Todas as 39 políticas integradas com parâmetros |
| [Políticas Personalizadas](docs/custom-policies.mdx) | Escreva suas próprias políticas |
| [Configuração](docs/configuration.mdx) | Formato do arquivo de configuração e mesclagem de escopos |
| [Painel](docs/dashboard.mdx) | Monitore sessões e revise a atividade das políticas |
| [Arquitetura](docs/architecture.mdx) | Como o sistema de hooks funciona |
| [Testes](docs/testing.mdx) | Executando testes e escrevendo novos |

### Executar a documentação localmente

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Abre o site de documentação Mintlify em `http://localhost:3000`. O container observa alterações se você montar o diretório de documentação:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## Nota para contribuidores do failproofai

O arquivo `.claude/settings.json` deste repositório usa `bun ./bin/failproofai.mjs --hook <EventType>` em vez do comando padrão `npx -y failproofai`. Isso ocorre porque executar `npx -y failproofai` dentro do próprio projeto failproofai cria um conflito de auto-referência.

Para todos os outros repositórios, a abordagem recomendada é `npx -y failproofai`, instalado via:

```bash
failproofai policies --install --scope project
```

## Contribuindo

Consulte [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licença

Consulte [LICENSE](LICENSE).

---

Criado e mantido pela **ExosphereHost: Reliability Research Lab for Your Agents**. Ajudamos empresas e startups a melhorar a confiabilidade de seus agentes de IA por meio de nossos próprios agentes, software e expertise. Saiba mais em [exosphere.host](https://exosphere.host).
