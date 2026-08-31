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

**为你的 Agent 在每个执行环境中提供可观测性与执行控制。**
无论 Agent 在哪里运行，我们都能看见——并且可以说不。Failproof 接入了 12 个 Agent 执行框架——包括 Claude Code、Codex 等编程 CLI，Hermes 等对话网关，以及 OpenClaw 等自托管助手——捕获每一次运行，并在危险工具调用执行前将其拦截。39 条内置策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的执行框架

共十二个执行框架，分为两类——十个编程 CLI，以及两个对话与助手网关（Hermes、OpenClaw）。无论你的 Agent 运行在哪一个框架中，事件、策略和会话历史完全一致。

若 Agent 不在上述任何框架中运行，可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得追踪、会话和审计能力。执行控制则需要在你自己的运行时中集成 hook——[联系我们](mailto:support@befailproof.ai)，我们会协助完成映射。

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

```sh
npm install -g failproofai
failproofai policies --install   # 或直接运行 `failproofai` 并接受首次运行提示
failproofai
```

39 条内置策略立即生效。仪表板地址为 `localhost:8020`。可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 它能拦截什么

| 策略 | 拦截内容 |
|---|---|
| `sanitize-api-keys` | API 密钥泄漏到 Agent 上下文中 |
| `block-env-files` | 读取 `.env` 及其他密钥文件 |
| `warn-repeated-tool-calls` | Agent 在同一调用上陷入循环 |
| `block-sudo` | 权限提升 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 未经审查的生产基础设施变更 |
| `block-rm-rf` | 递归删除文件 |
| `block-force-push` / `block-push-master` | `git push --force`、直接推送到 `main` |

前五条适用于任何能调用工具的 Agent，后三条是开发者最常用的——编程 CLI 是我们覆盖最深的执行框架类别。

→ [全部 39 条内置策略](https://docs.befailproof.ai/policies/builtin)

---

## 自定义策略

在 `.failproofai/policies/` 目录中放入一个文件——它会自动加载，无需任何标志。
提交到代码仓库后，团队所有成员在下次拉取时即可生效。

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

每条策略可做出以下三种决策：

| 决策 | 效果 |
|---|---|
| `allow()` | 允许该操作 |
| `deny(message)` | 拦截它——消息会回传给 Agent |
| `instruct(message)` | 放行，但在 Agent 的下一个提示中附加上下文 |

→ [自定义策略指南](https://docs.befailproof.ai/policies/custom)

---

## 可观测性

执行控制是一半，另一半是看清 Agent 究竟做了什么。

不带参数运行 `failproofai`，它会在 `localhost:8020` 启动一个仪表板，读取已存储在本机上的运行历史——无需账号、无需注册、数据不离机。你可以查看会话列表、每次运行中模型调用的序列、工具调用和 hook 决策、被拦截的内容以及策略告知 Agent 的信息，还可以进行离线审计（`failproofai audit`），扫描历史记录中的风险模式并推荐相应策略加以防范。

→ [本地仪表板](https://docs.befailproof.ai/reference/local-dashboard) ·
[解读追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管版本，专为在集群中运行 Agent 的团队而设计：来自所有框架的每次运行都汇聚在一处，执行图以独立泳道展示并行子 Agent，提供模型、工具和 hook 的 p50/p95/p99 延迟数据，按模型统计成本与上下文窗口用量，错误追踪，基于自有追踪数据的 SQL 查询与可分享仪表板，由你自己的服务评分的评估功能，将重复性故障转化为有据可查发现的定期审计，以及路由到 Slack、邮件或签名 Webhook 的告警。Enterprise 计划支持在你自己的集群中自托管。

→ [会话](https://docs.befailproof.ai/sessions/overview) ·
[审计](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装、连接执行框架、查看第一次运行 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | hook 系统的工作原理 |
| [支持的执行框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 个，以及每个可执行的控制能力 |

| 观测 | |
|---|---|
| [会话](https://docs.befailproof.ai/sessions/overview) | 跟踪一次运行：模型、工具、错误、延迟 |
| [解读追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图在告诉你什么 |
| [审计](https://docs.befailproof.ai/audits/overview) | 在多个会话中发现故障模式 |
| [本地仪表板](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 执行控制 | |
|---|---|
| [内置策略](https://docs.befailproof.ai/policies/builtin) | 全部 39 条策略及其参数 |
| [自定义策略](https://docs.befailproof.ai/policies/custom) | 编写你自己的策略 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域与合并规则 |

| 接入你自己的 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从没有执行框架的 Agent 上报运行数据 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——个人和内部使用免费；将 failproofai 本身用于商业转售需另行签订协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界情况处理和翻译。

> **开始前请先构建。** 首先运行 `bun install && bun run build`。本仓库会在自身上运行 failproofai 的 hook，这些 hook 会将 `failproofai` 的导入解析到编译后的 `dist/` 包——如果没有构建，你会遇到 `Cannot find package 'failproofai'` 的 hook 错误。修改 `src/` 后需重新构建。详见 [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山和班加罗尔用 ❤️ 打造。
