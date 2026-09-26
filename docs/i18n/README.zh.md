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

**为你的 Agent 所运行的每一个框架提供可观测性与策略执行。**
无论你的 Agent 在哪里运行，我们都能感知——并且可以说不。Failproof 接入了 12 个 Agent
框架——包括 Claude Code 和 Codex 等编码 CLI，Hermes 等聊天网关，以及 OpenClaw 等自托管助手——捕获每一次运行，并在危险工具调用执行之前将其拦截。内置 39 条策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的框架

共支持两类十二个框架——十个编码 CLI，以及两个聊天与助手网关（Hermes、OpenClaw）。所有框架共享同一套策略 API 和会话历史记录。策略的*拦截*能力因框架而异：在工具调用执行前拦截已在全部十二个框架上验证，轮次结束门控在八个框架上可用。[各框架能力矩阵](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)列出了每个框架所支持的事件。

不在上述框架中运行的 Agent 可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得追踪、会话和审计能力。在该场景下实施执行策略需要在你自己的运行时中添加 hook——[联系我们](mailto:support@befailproof.ai)，我们会协助你完成接入。

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
failproofai policies add FailproofAI/policies  # 选择要执行的策略
failproofai                                    # 在 localhost:8020 启动仪表盘
```

配置向导会自动连接 hook，但**不会**默认启用任何策略——第二条命令才是真正为机器添加防护栏的操作。所有策略包的添加方式相同（`failproofai policies add <owner>/<repo>`；`policies show <owner>/<repo>` 可预览某个包的内容）。在无终端环境（CI、容器、由 Agent 驱动的环境）下运行 `failproofai config` 时，它会直接应用配置而不会弹出交互问答。对于从未配置过的机器，运行其他任何命令都会先触发配置向导；可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 来禁用此行为。

在策略包加载之前，唯一生效的策略是 `block-failproofai-commands`，该策略始终开启且无法关闭或暂停：若 Agent 能够暂停策略执行，则它就能关闭其他所有策略。

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
| `block-force-push` / `block-push-master` | `git push --force`，直接推送到 `main` |

以上所有策略均在调用*执行前*进行拦截，因此对全部十二个框架均有效。前四条适用于任何能调用工具的 Agent；后三条是开发者最常用的——编码 CLI 是我们覆盖最深入的框架类别。`sanitize-*` 系列策略有所不同：它在工具返回结果后运行，用于报告工具输出中的密钥，而非阻止其进入上下文。

→ [全部 39 条内置策略](https://docs.befailproof.ai/policies/packs)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录——无需任何参数，自动加载。提交到代码仓库后，团队所有成员在下次拉取时即可生效。

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

每条策略可做出三种决策：

| 决策 | 效果 |
|---|---|
| `allow()` | 允许该操作 |
| `deny(message)` | 拦截操作——消息会返回给 Agent |
| `instruct(message)` | 放行操作，但向 Agent 的下一条提示中追加上下文 |

→ [编写策略](https://docs.befailproof.ai/policies/editor)

---

## 可观测性

策略执行只是其中一半。另一半是了解 Agent 实际做了什么。

不带参数运行 `failproofai`，它会在 `localhost:8020` 启动一个仪表盘，读取已存储在本机的运行历史——无需账号，无需注册，数据不会离开本机。你可以查看会话列表、每次运行中的模型调用序列、工具调用和 hook 决策、哪些操作被拦截以及策略向 Agent 反馈了什么内容，还有离线审计功能（`failproofai audit`），可扫描你的历史记录以发现风险模式并建议相应的防护策略。

→ [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) ·
[读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管版本，适用于在集群中跨多台机器运行 Agent 的团队：所有框架的所有运行记录汇聚一处；支持并行子 Agent 各自独立泳道的执行图；模型、工具和 hook 的 p50/p95/p99 延迟统计；按模型统计的成本与上下文窗口追踪；错误追踪；可对你自己的追踪数据执行 SQL 查询并生成可分享的仪表盘；支持由你自己的服务评分的评估功能；可将反复出现的失败转化为有据可查的发现的定期审计；以及路由到 Slack、邮件或签名 Webhook 的告警。企业版计划支持在你自己的集群中自托管。

→ [会话](https://docs.befailproof.ai/sessions/overview) ·
[审计](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装、连接框架、查看首次运行 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | hook 系统的工作原理 |
| [支持的框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 个框架及各自的执行能力 |

| 观测 | |
|---|---|
| [会话](https://docs.befailproof.ai/sessions/overview) | 追踪运行过程：模型、工具、错误、延迟 |
| [读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图所传达的信息 |
| [审计](https://docs.befailproof.ai/audits/overview) | 在大量会话中发现失败模式 |
| [本地仪表盘](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 执行 | |
|---|---|
| [策略包](https://docs.befailproof.ai/policies/packs) | Failproof AI 内置策略及策略中心的第三方包 |
| [编写策略](https://docs.befailproof.ai/policies/editor) | 从审计结果出发，或直接在代码中编写 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域、合并规则与策略参数 |

| 接入自定义 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从无框架的 Agent 上报运行数据 |
| [策略 SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——个人及内部使用免费；将 failproofai 本身作为商业产品转售需签订单独协议。完整条款请参见 [LICENSE](../../LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界情况修复以及翻译。

> **开始前请先构建项目。** 首先运行 `bun install && bun run build`。本仓库会对自身运行 failproofai 的 hook，而这些 hook 需要从编译后的 `dist/` 包中解析 `failproofai` 导入——如果未构建，你会遇到 `Cannot find package 'failproofai'` 的 hook 错误。修改 `src/` 后请重新构建。详见 [构建后才能使用仓库内开发 hook](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山和班加罗尔用 ❤️ 打造。
