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

**翻译版本：** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**为编码智能体提供运行时故障处理能力。**
接入 Claude Code 和 Codex，在循环、危险操作和密钥泄露演变为生产事故之前将其拦截。零延迟，本地运行。

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的智能体 CLI

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> 可为单个或任意组合的 CLI 安装钩子：`failproofai policies --install --cli opencode pi`（或 `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`）。省略 `--cli` 则自动检测已安装的 CLI 并进行提示。
>
> **Hermes**（hermes-agent，一个 Slack/Telegram 网关）支持**实时钩子强制执行**（`--cli hermes`——单次安装即可拦截来自所有平台和子智能体的工具调用）以及离线**审计**回放其网关会话（来自单一的 `~/.hermes/state.db`）。
>
> **OpenClaw**（openclaw gateway，一个自托管的多渠道助手）支持**实时钩子强制执行**（`--cli openclaw`，用户级作用域）以及离线**审计**回放其 JSONL 会话（`~/.openclaw/agents/<id>/sessions/*.jsonl`）。强制执行使用 OpenClaw 的**进程内插件钩子**（一个随附的 `openclaw-plugin/`，异步派生 failproofai——其基于文件的内部钩子仅供观察，无法拦截）：`before_tool_call` 可阻断工具，`before_agent_finalize` 是真正的轮次结束关卡，因此 `require-*-before-stop` 内置策略可生效。
>
> **Factory Droid**（`droid`）支持**实时钩子强制执行**（`--cli factory`，用户 + 项目作用域）以及离线**审计**回放其磁盘上的 JSONL 会话。droid 通过钩子**退出码 2**（而非 JSON 决策）来阻断工具调用，并且仅在轮次结束的 `Stop` 事件上接受 `{decision:"block"}`——failproofai 会自动为每种事件输出正确的格式。
>
> **Devin CLI**（`devin`，Cognition）支持**实时钩子强制执行**（`--cli devin`，用户 + 项目作用域）以及离线**审计**回放其 SQLite 会话（`~/.local/share/devin/cli/sessions.db`）。Devin 是一个**纯 Claude 克隆**——相同的事件名称、相同的 snake_case 载荷、相同的 `"hooks"` 包装器配置（`~/.config/devin/config.json` / `<cwd>/.devin/config.json`）——通过每个事件上的 `{decision:"block"}` JSON 进行拦截。
>
> **Antigravity CLI**（`agy`）支持**实时钩子强制执行**（`--cli antigravity`，用户 + 项目作用域）以及离线**审计**回放其纯 JSONL 会话（`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`）。Antigravity 有其**自有**协议（并非 Claude 克隆）：一套**命名钩子** `hooks.json` 模式（`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`），一个 failproofai 会规范化的 camelCase stdin 载荷，以及自有的响应格式——`{decision:"deny"}` 拦截工具，`{decision:"continue"}` 在 `Stop` 时强制进入下一轮，`{injectSteps}` 在模型运行前注入提示。
>
> **Goose**（代号 goose，Block 出品）支持**实时钩子强制执行**（`--cli goose`，用户 + 项目作用域）以及离线**审计**回放其 SQLite 会话（`~/.local/share/goose/sessions/sessions.db`）。强制执行使用 Goose 的**钩子**系统（跨智能体的 **Open Plugins** 规范）——安装程序只需将插件目录放置于 `~/.agents/plugins/failproofai/`，Goose 即可自动发现。拦截方式为在 `PreToolUse` 事件上返回 `{"decision":"block"}` JSON（该事件在 shell 工具调用时以及委托子智能体内部均会触发），已针对 goose v1.43.0 进行实测验证；Goose 没有轮次结束的 `Stop` 事件，因此 `require-*-before-stop` 内置策略不适用（与 Hermes 相同）。

---

## 安装

```sh
npm install -g failproofai
failproofai policies --install   # 或直接运行 `failproofai` 并接受首次运行提示
failproofai
```

30 条内置策略立即生效。控制面板地址：`localhost:8020`。设置 `FAILPROOFAI_NO_FIRST_RUN=1` 可禁用首次运行提示。

---

## 能拦截什么

| 策略 | 拦截内容 |
|---|---|
| `block-push-master` | 直接推送到 `main` / `master` 分支 |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | 在 `main` / `master` 上进行提交、合并、变基 |
| `block-rm-rf` | 递归删除文件 |
| `sanitize-api-keys` | API 密钥泄露到智能体上下文中 |

→ [全部 30 条内置策略](https://docs.befailproof.ai/built-in-policies)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录——无需任何参数，自动加载。
提交到版本库后，团队所有成员在下次拉取时即可获得该策略。

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
| `deny(message)` | 拦截——消息返回给智能体 |
| `instruct(message)` | 放行，但在智能体下一个提示中附加上下文 |

→ [自定义策略指南](https://docs.befailproof.ai/custom-policies)

---

## 会话可视化

智能体发出的每一次工具调用均在本地记录。控制面板展示运行了哪些操作、哪些被拦截，以及策略向智能体反馈了什么内容——出现问题时无需凭空猜测。→ [控制面板指南](https://docs.befailproof.ai/dashboard)

---

## 文档

| | |
|---|---|
| [快速上手](https://docs.befailproof.ai/getting-started) | 安装与入门步骤 |
| [内置策略](https://docs.befailproof.ai/built-in-policies) | 全部 30 条策略及其参数 |
| [自定义策略](https://docs.befailproof.ai/custom-policies) | 编写你自己的策略 |
| [配置](https://docs.befailproof.ai/configuration) | 配置作用域与合并规则 |
| [控制面板](https://docs.befailproof.ai/dashboard) | 会话监控与策略活动 |
| [架构](https://docs.befailproof.ai/architecture) | 钩子系统的工作原理 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/)——可免费用于内部及个人用途；将 failproofai 本身进行商业转售需另签协议。完整条款见 [LICENSE](./LICENSE)。

---

## 参与贡献

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。欢迎提交新策略、边界用例和翻译。

> **开始前请先构建。** 先运行 `bun install && bun run build`。本仓库会在自身上运行 failproofai 的钩子，这些钩子将 `failproofai` 的导入解析到编译后的 `dist/` 包——若未构建，将会遇到 `Cannot find package 'failproofai'` 钩子错误。修改 `src/` 后请重新构建。参见 [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [Nivedit Jain](https://github.com/NiveditJain) 和 [Nikita Agarwal](https://github.com/nk-ag) 构建。
[befailproof.ai](https://befailproof.ai)
