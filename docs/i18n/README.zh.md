> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | **🇨🇳 简体中文** | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**翻译：** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**为编程 Agent 提供运行时故障处理能力。**
接入 Claude Code 和 Codex，在死循环、危险操作和密钥泄露演变为事故之前将其拦截。零延迟，本地运行。

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的 Agent CLI

<!-- A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). -->
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

> 可为单个或任意组合的 CLI 安装 Hook：`failproofai policies --install --cli opencode pi`（或 `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`）。省略 `--cli` 则自动检测已安装的 CLI 并提示选择。
>
> **Hermes**（hermes-agent，一个 Slack/Telegram 网关）同时支持**实时 Hook 执行**（`--cli hermes` — 一次安装即可拦截所有平台和子 Agent 的工具调用）和对其网关会话（单一 `~/.hermes/state.db`）的离线**审计**回放。
>
> **OpenClaw**（openclaw gateway，一个自托管的多渠道助手）同时支持**实时 Hook 执行**（`--cli openclaw`，用户级作用域）和对其 JSONL 会话（`~/.openclaw/agents/<id>/sessions/*.jsonl`）的离线**审计**回放。执行依赖 OpenClaw 的**进程内插件 Hook**（随附的 `openclaw-plugin/` 会异步启动 failproofai — 其基于文件的内部 Hook 仅供观测，无法阻断）：`before_tool_call` 可阻断工具调用，`before_agent_finalize` 是真正的轮次结束门控，因此内置的 `require-*-before-stop` 策略生效。
>
> **Factory Droid**（`droid`）同时支持**实时 Hook 执行**（`--cli factory`，用户 + 项目级作用域）和对其磁盘 JSONL 会话的离线**审计**回放。droid 通过 Hook **退出码 2**（而非 JSON 决策）阻断工具调用，且仅在轮次结束的 `Stop` 事件上识别 `{decision:"block"}` — failproofai 会自动根据事件类型输出正确格式。
>
> **Devin CLI**（`devin`，Cognition）同时支持**实时 Hook 执行**（`--cli devin`，用户 + 项目级作用域）和对其 SQLite 会话（`~/.local/share/devin/cli/sessions.db`）的离线**审计**回放。Devin 是 **Claude 的纯克隆** — 事件名称相同，snake_case 负载相同，`"hooks"` 包装配置相同（`~/.config/devin/config.json` / `<cwd>/.devin/config.json`）— 所有事件均通过 `{decision:"block"}` JSON 进行阻断。
>
> **Antigravity CLI**（`agy`）同时支持**实时 Hook 执行**（`--cli antigravity`，用户 + 项目级作用域）和对其纯 JSONL 会话（`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`）的离线**审计**回放。Antigravity 有其**自有**协议（非 Claude 克隆）：采用**命名 Hook** 的 `hooks.json` 模式（`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`），以及 failproofai 会自动规范化的 camelCase stdin 负载和专属响应格式 — `{decision:"deny"}` 阻断工具，`{decision:"continue"}` 在 `Stop` 时强制再次轮转，`{injectSteps}` 在模型运行前注入提示。
>
> **Goose**（代号 goose，Block）同时支持**实时 Hook 执行**（`--cli goose`，用户 + 项目级作用域）和对其 SQLite 会话（`~/.local/share/goose/sessions/sessions.db`）的离线**审计**回放。执行依赖 Goose 的 **hooks** 系统（跨 Agent 的 **Open Plugins** 规范）— 安装程序只需在 `~/.agents/plugins/failproofai/` 下放置一个插件目录，Goose 会自动发现它。阻断方式为在 `PreToolUse` 事件上返回 `{"decision":"block"}` JSON（该事件在 shell 工具调用及委托给子 Agent 时均会触发），已针对 goose v1.43.0 验证；Goose 没有轮次结束的 `Stop` 事件，因此内置的 `require-*-before-stop` 策略不适用（与 Hermes 相同）。

---

## 安装

```sh
npm install -g failproofai
failproofai policies --install   # 或直接运行 `failproofai` 并在首次运行提示时确认
failproofai
```

30 条内置策略立即生效。控制台地址：`localhost:8020`。通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 可禁用首次运行提示。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `block-push-master` | 直接推送到 `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | 在 `main` / `master` 上提交、合并、变基 |
| `block-rm-rf` | 递归删除文件 |
| `sanitize-api-keys` | API 密钥泄露到 Agent 上下文中 |

→ [全部 30 条内置策略](https://docs.befailproof.ai/built-in-policies)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何标志。
提交到代码库后，团队所有成员在下次拉取时即可获得该策略。

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
| `deny(message)` | 阻断操作 — 消息将返回给 Agent |
| `instruct(message)` | 放行操作，但在 Agent 的下一次提示中附加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/custom-policies)

---

## 会话可见性

Agent 发起的每次工具调用均会在本地记录。控制台展示了哪些操作被执行、哪些被拦截，以及策略向 Agent 返回了什么信息 — 出现问题时无需猜测。→ [控制台指南](https://docs.befailproof.ai/dashboard)

---

## 文档

| | |
|---|---|
| [快速上手](https://docs.befailproof.ai/getting-started) | 安装与入门步骤 |
| [内置策略](https://docs.befailproof.ai/built-in-policies) | 全部 30 条策略及其参数 |
| [自定义策略](https://docs.befailproof.ai/custom-policies) | 编写你自己的策略 |
| [配置](https://docs.befailproof.ai/configuration) | 配置作用域与合并规则 |
| [控制台](https://docs.befailproof.ai/dashboard) | 会话监控与策略活动 |
| [架构](https://docs.befailproof.ai/architecture) | Hook 系统的工作原理 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/) — 个人及内部使用免费；以 failproofai 本身进行商业转售需另行签订协议。完整条款请参见 [LICENSE](./LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。欢迎贡献新策略、边界情况处理和翻译。

> **开始前请先构建项目。** 首先运行 `bun install && bun run build`。本仓库在自身上运行 failproofai 的 Hook，它们会将 `failproofai` 导入解析到已编译的 `dist/` 包 — 若未构建，你将遇到 `Cannot find package 'failproofai'` Hook 错误。修改 `src/` 后请重新构建。详见 [构建后才能使用仓库内开发 Hook](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [Nivedit Jain](https://github.com/NiveditJain) 和 [Nikita Agarwal](https://github.com/nk-ag) 构建。
[befailproof.ai](https://befailproof.ai)
