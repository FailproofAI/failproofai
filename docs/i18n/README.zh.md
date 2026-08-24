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

**为每一个 Agent 运行环境提供可观测性与执行管控。**
无论你的 Agent 在哪里运行，我们都能看到——并且可以说不。Failproof 接入了 12 个 Agent 运行框架——包括 Claude Code、Codex 等编程 CLI，Hermes 等聊天网关，以及 OpenClaw 等自托管助手——捕获每一次运行，并在危险工具调用执行前将其拦截。40 条内置策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的运行框架

共十二个框架，分为两类——十个编程 CLI，以及两个聊天与助手网关（Hermes、OpenClaw）。无论你的 Agent 运行在哪个框架中，事件、策略和会话历史完全一致。

对于未接入上述框架的 Agent，可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得追踪、会话和审计能力。在该场景下的执行管控需要在你自己的运行时中植入 hook——[联系我们](mailto:support@befailproof.ai)，我们来帮你完成映射。

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
failproofai policies --install   # 或直接运行 `failproofai` 并在首次运行提示时确认
failproofai
```

40 条内置策略立即生效。Dashboard 地址：`localhost:8020`。可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `sanitize-api-keys` | API 密钥泄露到 Agent 上下文 |
| `block-env-files` | 读取 `.env` 及其他密钥文件 |
| `warn-repeated-tool-calls` | Agent 在同一调用上循环执行 |
| `block-sudo` | 权限提升 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 未经审查的生产基础设施变更 |
| `block-rm-rf` | 递归删除文件 |
| `block-force-push` / `block-push-master` | `git push --force`、直接推送到 `main` |

前五条适用于任何可以调用工具的 Agent，后三条是开发者最爱——编程 CLI 是我们覆盖最深入的框架类型。

→ [全部 40 条内置策略](https://docs.befailproof.ai/policies/builtin)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何参数。提交到代码仓库后，全团队在下次拉取时即可生效。

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

每条策略可使用三种决策：

| 决策 | 效果 |
|---|---|
| `allow()` | 允许该操作 |
| `deny(message)` | 拦截操作——消息返回给 Agent |
| `instruct(message)` | 放行操作，但在 Agent 的下一次提示中附加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/policies/custom)

---

## 可观测性

执行管控是一半，另一半是看清 Agent 实际做了什么。

不带任何参数运行 `failproofai`，它会在 `localhost:8020` 启动一个 Dashboard，读取已存储在本机的运行历史——无需账户，无需注册，数据不离开本机。你可以查看会话列表、每次运行中模型调用和工具调用的序列、hook 决策记录、哪些操作被拦截、策略向 Agent 传达了什么，以及离线审计（`failproofai audit`）——它会扫描你的历史记录，发现风险模式并推荐相应策略。

→ [本地 Dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI 可观测性**是同一数据模型的托管端，面向在集群中跨多个框架运行 Agent 的团队：所有框架的每次运行集中呈现，带有并行子 Agent 独立泳道的执行图，模型、工具和 hook 的 p50/p95/p99 延迟，按模型的费用和上下文窗口跟踪，错误追踪，基于自有 trace 数据的 SQL 查询与可分享 Dashboard，由你自己的服务评分的评估结果，将重复失败转化为有据可查发现的定时审计，以及路由到 Slack、邮件或签名 Webhook 的告警。在企业版计划中支持在你自己的集群中自托管部署。

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装、接入框架、查看首次运行结果 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | Hook 系统的工作原理 |
| [支持的框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 个框架及各自的执行管控能力 |

| 可观测性 | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | 跟踪运行过程：模型、工具、错误、延迟 |
| [读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图所反映的信息 |
| [Audits](https://docs.befailproof.ai/audits/overview) | 跨多个会话发现失败模式 |
| [本地 Dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账户 |

| 执行管控 | |
|---|---|
| [内置策略](https://docs.befailproof.ai/policies/builtin) | 全部 40 条策略及参数说明 |
| [自定义策略](https://docs.befailproof.ai/policies/custom) | 编写你自己的策略 |
| [配置说明](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域与合并规则 |

| 接入自定义 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 为无框架的 Agent 上报运行数据 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——个人和企业内部使用免费；将 failproofai 本身作为商业产品转售需要单独签署协议。完整条款请见 [LICENSE](../../LICENSE)。

---

## 参与贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界案例和翻译内容。

> **开始前请先构建项目。** 请先运行 `bun install && bun run build`。本仓库会将 failproofai 自身的 hook 应用于自己，这些 hook 会从编译后的 `dist/` 包中解析 `failproofai` 模块导入——未执行构建将导致出现 `Cannot find package 'failproofai'` 的 hook 错误。修改 `src/` 后需重新构建。详见 [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山和班加罗尔倾心打造 ❤️。
