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

**为 Agent 运行的每一个执行环境提供可观测性与管控能力。**
无论你的 Agent 在哪里运行，我们都能看到——并且可以说"不"。Failproof 接入了 12 种 Agent 执行框架（harness）——包括 Claude Code、Codex 等编码 CLI，Hermes 等对话网关，以及 OpenClaw 等自托管助手——捕获每次运行，并在危险工具调用执行前将其拦截。39 条内置策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的执行框架

共 12 种执行框架，分为两类——10 种编码 CLI，以及 2 种对话与助手网关（Hermes、OpenClaw）。无论你的 Agent 运行在哪一种框架中，事件、策略、会话历史均保持一致。

若 Agent 不在上述任何框架中运行，可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得链路追踪、会话管理和审计能力。在该场景下的管控功能需要在你自己的运行时中挂载 hook——[联系我们](mailto:support@befailproof.ai)，我们会协助你完成适配。

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

39 条内置策略立即生效。控制台地址：`localhost:8020`。可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 能拦截哪些风险

| 策略 | 拦截内容 |
|---|---|
| `sanitize-api-keys` | API 密钥泄露到 Agent 上下文中 |
| `block-env-files` | 读取 `.env` 及其他机密文件 |
| `warn-repeated-tool-calls` | Agent 对同一调用陷入循环 |
| `block-sudo` | 权限提升操作 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 未经审查的生产基础设施变更 |
| `block-rm-rf` | 递归删除文件 |
| `block-force-push` / `block-push-master` | `git push --force`、直接推送至 `main` 分支 |

前五条适用于任何能调用工具的 Agent，后三条是开发者最常用的——编码 CLI 是我们覆盖最深入的执行框架类别。

→ [全部 39 条内置策略](https://docs.befailproof.ai/policies/builtin)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何额外参数。提交到代码仓库后，团队所有成员在下次拉取时即可生效。

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
| `deny(message)` | 阻止该操作——消息会返回给 Agent |
| `instruct(message)` | 放行，但在 Agent 的下一个提示词中附加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/policies/custom)

---

## 可观测性

管控是一半，另一半是洞察 Agent 的实际行为。

不带任何参数运行 `failproofai`，它会在 `localhost:8020` 提供一个控制台，读取本机已有的运行历史——无需账号、无需注册、数据不离开本机。你可以查看会话列表、每次运行中模型调用和工具调用的完整序列及 hook 决策、被拦截的内容以及策略向 Agent 传达的信息，还可以进行离线审计（`failproofai audit`），扫描历史记录中的风险模式并给出策略建议。

→ [本地控制台](https://docs.befailproof.ai/reference/local-dashboard) ·
[解读链路追踪](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管版本，面向在集群中大规模运行 Agent 的团队：所有执行框架的每次运行都汇聚在同一个地方，执行图支持并行子 Agent 独立泳道展示，提供模型、工具和 hook 的 p50/p95/p99 延迟数据，按模型统计的费用和上下文窗口追踪、错误追踪，支持通过 SQL 查询你自己的链路数据并生成可分享的仪表盘，可使用自有服务对评估结果打分，定期审计将反复出现的故障转化为有据可查的发现，以及通过 Slack、邮件或签名 Webhook 发送告警。企业版支持在你自己的集群中自托管部署。

→ [会话](https://docs.befailproof.ai/sessions/overview) ·
[审计](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装、接入执行框架、查看首次运行结果 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | Hook 系统的工作原理 |
| [支持的执行框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 种及各自的管控能力 |

| 可观测性 | |
|---|---|
| [会话](https://docs.befailproof.ai/sessions/overview) | 追踪一次运行：模型、工具、错误、延迟 |
| [解读链路追踪](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图所传达的信息 |
| [审计](https://docs.befailproof.ai/audits/overview) | 跨多个会话发现故障模式 |
| [本地控制台](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 管控 | |
|---|---|
| [内置策略](https://docs.befailproof.ai/policies/builtin) | 全部 39 条策略及其参数说明 |
| [自定义策略](https://docs.befailproof.ai/policies/custom) | 编写你自己的策略 |
| [配置说明](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域与合并规则 |

| 接入你自己的 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从无执行框架的 Agent 上报运行数据 |
| [策略 SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——个人和内部使用免费；将 failproofai 本身作为商业产品转售需签订单独协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 参与贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界用例和翻译内容。

> **开始前请先构建项目。** 首先运行 `bun install && bun run build`。本仓库会对自身运行 failproofai 的 hook，这些 hook 会从编译后的 `dist/` 包中解析 `failproofai` 的导入——如果未执行构建，你会遇到 `Cannot find package 'failproofai'` hook 错误。修改 `src/` 后请重新构建。详见 [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山与班加罗尔用 ❤️ 打造。
