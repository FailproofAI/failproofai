> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | **🇨🇳 简体中文** | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**翻译版本：** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**洞察 Agent 的每一步操作，在已知故障重演前将其拦截。**
Failproof AI 可在各类 Agent 运行环境中工作：编码工具（如 Claude Code 和 Codex）、
聊天网关（如 Hermes）、自托管助手（如 OpenClaw），以及你自行接入的 Agent。
它会记录每次运行，并能在危险的工具调用执行前将其阻止。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的运行框架

目前支持两类共十二种框架：十种编码 CLI，加上两种网关：Hermes 和 OpenClaw。策略 API 与会话历史记录共享；各框架支持的可拦截事件有所不同。

对于不在上述框架中运行的 Agent，可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，从而获得追踪、会话和审计能力。在该场景下的执行拦截需要在你自己的运行时中挂载 hook —— 欢迎[联系我们](mailto:support@befailproof.ai)，我们将协助完成映射配置。

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

## 安装

如需让兼容的 Agent 具备 Failproof AI 技能（以便引导配置、检测环境，并正确路由策略、审计、会话及云端任务），请运行：

```sh
npx skills add FailproofAI/skills
```

该命令将安装总体技能包及其子技能包。若只需安装总体技能包，请添加 `--skill failproofai`。技能包提供操作指引；通过以下命令安装并配置产品本体：

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # 在 localhost:8020 打开仪表盘
```

安装程序会自动连接受支持的 Agent 并安装后台服务。默认不启用任何策略包：在添加策略包之前，仅运行 `block-failproofai-commands` 策略，以防止 Agent 禁用 Failproof AI。

使用 `failproofai config --token <machine-key>` 可无交互地连接云端。在共享机器或 CI 环境中，建议设置 `FAILPROOFAI_CLOUD_TOKEN` 环境变量后再运行 `failproofai config`，避免密钥出现在命令历史记录中。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `sanitize-api-keys` | 防止 API 密钥泄漏至 Agent 上下文 |
| `block-env-files` | 阻止读取 `.env` 及其他敏感配置文件 |
| `warn-repeated-tool-calls` | 检测 Agent 在同一调用上陷入循环 |
| `block-sudo` | 阻止权限提升 |
| `warn-destructive-sql` | 拦截 `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 阻止未经审查的生产基础设施变更 |
| `block-rm-rf` | 阻止递归文件删除 |
| `block-force-push` / `block-push-master` | 阻止 `git push --force` 及直接推送到 `main` 分支 |

这些策略保护文件、凭证、基础设施、数据库和 Agent 工作流。各框架和事件类型的具体执行支持情况有所不同。

→ [全部 39 条内置策略](https://docs.befailproof.ai/policies/builtin)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何额外参数。提交到代码库后，团队成员在下次拉取时即可同步生效。

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

每条策略可返回三种决策：

| 决策 | 效果 |
|---|---|
| `allow()` | 允许该操作 |
| `deny(message)` | 拦截操作——消息将返回给 Agent |
| `instruct(message)` | 放行操作，但在 Agent 的下一次提示中附加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/policies/custom)

---

## 策略包

策略包是从公开 GitHub 仓库发布的一组带版本号的策略集合。安装前可先预览：

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

带斜杠的标识符为包来源，不带斜杠的为策略名称。你可以按分类或指定策略进行安装，也可以在需要时固定到某个发布版本。

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

在 [Policy Hub](https://befailproof.ai/policy-hub/) 浏览已发布的策略包，或运行 `failproofai publish --init` 创建自己的策略包。观察模式允许策略包在不实际拦截的情况下记录其本应执行的操作：`failproofai publish --effect observe`。

→ [策略包](https://docs.befailproof.ai/policies/packs) ·
[发布策略包](https://docs.befailproof.ai/policies/publish-a-pack)

---

## 可观测性

执行拦截是一半，另一半是了解 Agent 实际做了什么。

不带任何参数运行 `failproofai`，它将在 `localhost:8020` 启动仪表盘，读取本机上已有的运行历史——无需账号、无需注册，数据不会离开本机。你可以查看会话列表、每次运行中的模型调用序列、工具调用及 hook 决策、被拦截的内容以及策略对 Agent 的指示，还可以使用离线审计功能（`failproofai audit`），扫描历史记录中的风险模式并推荐相应策略。

→ [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) ·
[解读追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管版本，专为跨机群运行 Agent 的团队设计：来自所有框架的全部运行记录汇聚一处，带有并行子 Agent 独立泳道的执行图，模型、工具和 hook 的 p50/p95/p99 延迟统计，按模型细分的成本和上下文窗口追踪，错误追踪，可在自有追踪数据上执行 SQL 查询并生成可分享的仪表盘，支持由自有服务评分的评估功能，定期审计可将反复出现的故障转化为有据可查的发现，并支持将告警路由至 Slack、邮件或签名 webhook。Enterprise 计划支持在自有集群中自托管部署。

→ [会话](https://docs.befailproof.ai/sessions/overview) ·
[审计](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速上手](https://docs.befailproof.ai/start/quickstart) | 安装、连接框架、查看首次运行结果 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | hook 系统的工作原理 |
| [支持的框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 种框架及各自的执行能力 |

| 观测 | |
|---|---|
| [会话](https://docs.befailproof.ai/sessions/overview) | 追踪运行过程：模型、工具、错误、延迟 |
| [解读追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 读懂执行图的含义 |
| [审计](https://docs.befailproof.ai/audits/overview) | 跨多个会话发现故障模式 |
| [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 执行拦截 | |
|---|---|
| [内置策略](https://docs.befailproof.ai/policies/builtin) | 全部 39 条策略及参数说明 |
| [自定义策略](https://docs.befailproof.ai/policies/custom) | 编写自己的策略 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域与合并规则 |

| 接入自定义 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从无框架的 Agent 上报运行数据 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/) —— 可免费用于内部和个人用途；将 failproofai 本身进行商业转售需另行签订协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界用例和翻译内容。

> **请先构建再开始开发。** 首先运行 `bun install && bun run build`。本仓库会在自身上运行 failproofai 的 hook，这些 hook 需要从编译后的 `dist/` 包中解析 `failproofai` 导入——若未先构建，将遇到 `Cannot find package 'failproofai'` 的 hook 报错。修改 `src/` 后请重新构建。详见 [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 在旧金山和班加罗尔用 ❤️ 构建。
