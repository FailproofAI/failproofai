> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | **🇨🇳 简体中文** | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**翻译版本：** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**面向所有 Agent 运行环境的可观测性与执行管控。**
无论你的 Agent 在哪里运行，我们都能看到——并且可以说不。Failproof 接入了 12 个 Agent 运行框架——包括 Claude Code、Codex 等编程 CLI，Hermes 等对话网关，以及 OpenClaw 等自托管助手——捕获每一次运行并在危险工具调用执行前将其拦截。内置 40 条策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的运行框架

共 12 个框架，分为两类——10 个编程 CLI，以及 2 个对话与助手网关（Hermes、OpenClaw）。所有框架共用同一套策略 API 和会话历史记录。每个框架能够*拦截*的内容各有不同：在工具调用执行前将其阻断已在全部 12 个框架上验证可用，轮次结束门控则在其中 8 个框架上可用。[各框架能力矩阵](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)列出了每个框架所支持的事件类型。

如果 Agent 不在上述任何框架中运行，可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得追踪、会话和审计能力。在该场景下的执行管控需要在你自己的运行时中嵌入 hook——[联系我们](mailto:support@befailproof.ai)，我们会协助你完成映射。

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
failproofai config                             # 配置你的 Agent 和守护进程
failproofai policies add FailproofAI/policies  # 选择要启用的策略
failproofai                                    # 在 localhost:8020 打开仪表盘
```

初始化配置会接入 hook，但**不会**默认启用任何策略——第二条命令才是为机器添加防护栏的关键，任何策略包的用法都相同（`failproofai policies add <owner>/<repo>`；`policies show <owner>/<repo>` 可先预览内容）。在无终端环境下运行 `failproofai config`——如 CI、容器或由 Agent 驱动的场景——它会直接应用配置而不会交互式询问。在从未完成初始化的机器上，运行任何其他命令都会先触发同样的引导向导；可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用此行为。

在策略包加载之前，唯一生效的是 `block-failproofai-commands`，该策略始终开启且无法被关闭或暂停：一个能够暂停执行管控的 Agent，也就能关闭所有其他策略。

---

## 能拦截什么

| 策略 | 拦截内容 |
|---|---|
| `block-env-files` | 读取 `.env` 及其他密钥文件 |
| `warn-repeated-tool-calls` | Agent 对同一调用的循环重试 |
| `block-sudo` | 权限提升 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 未经审查的生产基础设施变更 |
| `block-rm-rf` | 递归删除文件 |
| `block-force-push` / `block-push-master` | `git push --force`、直接推送到 `main` |

上述每条策略都在调用*执行前*进行门控拦截，因此在全部 12 个框架上均有效。前四条适用于任何能调用工具的 Agent；后三条是开发者最常用的——编程 CLI 是我们覆盖最深入的框架类别。`sanitize-*` 系列策略独立运作：它在工具返回结果后执行，因此是在工具输出中上报密钥，而非阻止其进入上下文。

→ [全部 40 条内置策略](https://docs.befailproof.ai/policies/packs)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录——自动加载，无需任何标志。
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

每条策略可返回三种决策：

| 决策 | 效果 |
|---|---|
| `allow()` | 允许该操作 |
| `deny(message)` | 拦截该操作——消息会回传给 Agent |
| `instruct(message)` | 放行，但在 Agent 的下一个提示词中附加上下文 |

→ [编写策略](https://docs.befailproof.ai/policies/editor)

---

## 可观测性

执行管控是一半，另一半是查看 Agent 实际执行了什么。

不带参数运行 `failproofai`，它会在 `localhost:8020` 启动一个仪表盘，读取本机已有的运行历史——无需账号、无需注册，数据不离开本机。你可以查看会话列表、每次运行中的模型调用序列、工具调用和 hook 决策、被拦截的内容及策略告知 Agent 的信息，还有离线审计功能（`failproofai audit`），可扫描你的历史记录，发现高风险模式并建议对应的拦截策略。

→ [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) ·
[查看追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管侧，专为在多台机器上运行 Agent 的团队设计：来自所有框架的每次运行集中呈现，带有并行子 Agent 独立泳道的执行图，模型、工具和 hook 的 p50/p95/p99 延迟数据，按模型统计的费用和上下文窗口追踪，错误追踪，支持可分享仪表盘的 SQL 查询，由你自己服务评分的评估，将周期性失败转化为有据可查发现的定期审计，以及路由至 Slack、邮件或签名 Webhook 的告警。企业版计划支持在你自己的集群中自托管。

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[Audits](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装、接入框架、查看第一次运行 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | Hook 系统的工作原理 |
| [支持的框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 个框架及各自的管控能力 |

| 可观测性 | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | 跟踪一次运行：模型、工具、错误、延迟 |
| [查看追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图传递的信息 |
| [Audits](https://docs.befailproof.ai/audits/overview) | 跨多个会话发现失败模式 |
| [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 执行管控 | |
|---|---|
| [策略包](https://docs.befailproof.ai/policies/packs) | Failproof AI 内置策略及策略中心的社区包 |
| [编写策略](https://docs.befailproof.ai/policies/editor) | 从审计出发，或直接用代码编写 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域、合并规则与策略参数 |

| 接入自定义 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从无框架的 Agent 上报运行数据 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 协议附加 [Commons Clause](https://commonsclause.com/)——个人和内部使用免费；将 failproofai 本身用于商业转售需要单独签订协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎提交新策略、边界场景和翻译内容。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山和班加罗尔用 ❤️ 构建。
