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

**为所有 Agent 运行环境提供可观测性与执行控制。**
无论你的 Agent 在哪里运行，我们都能看到——并且能够说"不"。Failproof 接入了 12 种 Agent 运行框架，涵盖 Claude Code、Codex 等编码 CLI，Hermes 等聊天网关，以及 OpenClaw 等自托管助手，捕获每一次运行记录，并在危险工具调用执行前将其拦截。内置 39 条策略，零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的运行框架

共 12 种框架，分为两类——10 种编码 CLI，以及 2 种聊天与助手网关（Hermes、OpenClaw）。所有框架共用同一套策略 API 和同一份会话历史记录。各框架能够*拦截*的内容有所不同：在工具调用执行前进行拦截已在全部 12 种框架上得到验证，轮次结束时的门控则在其中 8 种上得到支持。[各框架能力矩阵](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)列出了每种框架所支持的事件类型。

不在上述框架中运行的 Agent 可通过 [Python SDK](https://docs.befailproof.ai/reference/custom-agents) 上报数据，获得追踪、会话和审计能力。该场景下的执行控制需要在你自己的运行时中接入 hook——[联系我们](mailto:support@befailproof.ai)，我们来帮你完成对接。

{/* 使用 6 列表格而非内联 <img> 排列方式：表格列不会自动换行，
     因此无论窗口宽度如何，网格始终保持 2×6 布局（极窄屏幕下横向滚动，
     而不是折叠成参差不齐的孤行）。 */}
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
failproofai                                    # 在 localhost:8020 打开控制台
```

初始化配置会连接 hook，但**不**启用任何策略——第二条命令才是为机器添加防护栏的步骤，任何策略包的添加方式相同（`failproofai policies add <owner>/<repo>`；`policies show <owner>/<repo>` 可先查看内容）。在无终端环境下运行 `failproofai config`——如 CI、容器或由 Agent 驱动的场景——它会直接应用配置而不弹出交互式向导。对于从未配置过的机器，运行其他任何命令都会先触发同样的向导；可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用此行为。

在引入策略包之前，唯一生效的策略是 `block-failproofai-commands`，该策略始终开启且无法关闭或暂停：如果 Agent 能暂停执行控制，就能关闭所有其他策略。

---

## 能拦截什么

| 策略 | 拦截内容 |
|---|---|
| `block-env-files` | 读取 `.env` 及其他密钥文件 |
| `warn-repeated-tool-calls` | Agent 对同一调用的循环重试 |
| `block-sudo` | 权限提升操作 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、无条件 `DELETE` |
| `block-terraform` / `block-kubectl` | 未经审查的生产基础设施变更 |
| `block-rm-rf` | 递归删除文件 |
| `block-force-push` / `block-push-master` | `git push --force`，直接推送到 `main` 分支 |

以上每条策略都在调用*执行前*进行拦截，因此对全部 12 种框架均有效。前四条适用于任何能够调用工具的 Agent；后三条是开发者最常用的——编码 CLI 是我们覆盖最深入的框架类型。`sanitize-*` 系列策略有所不同：它在工具返回结果后运行，因此是对工具输出中的密钥进行上报，而不是阻止其进入上下文。

→ [全部 39 条内置策略](https://docs.befailproof.ai/policies/packs)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录——会自动加载，无需任何额外参数。提交到代码仓库后，整个团队在下次拉取时即可生效。

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
| `deny(message)` | 拦截该操作——消息会返回给 Agent |
| `instruct(message)` | 放行，但在 Agent 的下一个提示中附加上下文信息 |

→ [编写策略](https://docs.befailproof.ai/policies/editor)

---

## 可观测性

执行控制是其中一半，另一半是了解 Agent 实际做了什么。

不带参数运行 `failproofai`，它会在 `localhost:8020` 启动一个控制台，读取已保存在本机的运行历史——无需账号，无需注册，数据不会离开本机。你可以查看会话列表、每次运行中的模型调用序列、工具调用和 hook 决策、被拦截的内容及策略告知 Agent 的信息，还可以运行离线审计（`failproofai audit`），扫描历史记录中的风险模式并推荐相应策略加以阻止。

→ [本地控制台](https://docs.befailproof.ai/reference/local-dashboard) ·
[读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) ·
[本地审计](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** 是同一数据模型的托管版本，面向在多台机器上运行 Agent 的团队：所有框架的每次运行记录汇聚一处，执行图支持并行子 Agent 独立泳道显示，模型、工具和 hook 的 p50/p95/p99 延迟统计，按模型的成本与上下文窗口追踪，错误追踪，基于自有 traces 的 SQL 查询与可分享的仪表板，由自有服务评分的评测，将反复出现的失败转化为有据可查的发现的定期审计，以及路由到 Slack、邮件或签名 Webhook 的告警。企业版计划支持在自有集群中自托管部署。

→ [Sessions](https://docs.befailproof.ai/sessions/overview) ·
[审计](https://docs.befailproof.ai/audits/overview) ·
[预约演示](https://befailproof.ai/get-a-demo)

---

## 文档

| 入门 | |
|---|---|
| [快速上手](https://docs.befailproof.ai/start/quickstart) | 安装、连接框架、查看第一次运行结果 |
| [核心概念](https://docs.befailproof.ai/start/concepts) | Hook 系统的工作原理 |
| [支持的运行框架](https://docs.befailproof.ai/reference/harnesses) | 全部 12 种框架及各自的执行控制能力 |

| 可观测性 | |
|---|---|
| [Sessions](https://docs.befailproof.ai/sessions/overview) | 跟踪一次运行：模型、工具、错误、延迟 |
| [读取追踪记录](https://docs.befailproof.ai/sessions/read-a-trace) | 执行图所呈现的信息解读 |
| [审计](https://docs.befailproof.ai/audits/overview) | 跨多个会话发现失败规律 |
| [本地控制台](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`，无需账号 |

| 执行控制 | |
|---|---|
| [策略包](https://docs.befailproof.ai/policies/packs) | Failproof AI 内置策略及策略中心的社区包 |
| [编写策略](https://docs.befailproof.ai/policies/editor) | 基于审计结果或直接编写代码 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域、合并规则与策略参数 |

| 接入自有 Agent | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 从无框架的 Agent 上报运行数据 |
| [策略 SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 参考文档 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——个人及内部使用免费；将 failproofai 本身作为商业产品转售需签订单独协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 贡献指南

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎提交新策略、边界用例和翻译。

> **开始前请先构建项目。** 请先运行 `bun install && bun run build`。本仓库会对自身运行 failproofai 的 hook，这些 hook 从编译后的 `dist/` 包中解析 `failproofai` 导入——如果未执行构建，你会遇到 `Cannot find package 'failproofai'` 的 hook 错误。修改 `src/` 后请重新构建。详见 [构建前仓库内开发 hook 无法工作](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山和班加罗尔用 ❤️ 打造。
