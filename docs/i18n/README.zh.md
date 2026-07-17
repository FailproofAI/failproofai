> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | **🇨🇳 简体中文** | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**翻译版本：** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**为编码智能体提供运行时故障处理能力。**
深度集成 Claude Code 与 Codex，在循环调用、危险操作和密钥泄漏演变为事故之前将其拦截。零延迟，本地运行。

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的智能体 CLI

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
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

## 安装

```sh
npm install -g failproofai
failproofai policies --install   # 或直接运行 `failproofai` 并接受首次运行提示
failproofai
```

30 条内置策略即刻生效。控制面板地址：`localhost:8020`。可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `block-push-master` | 直接推送至 `main` / `master` 分支 |
| `block-force-push` | `git push --force` 强制推送 |
| `block-work-on-main` | 在 `main` / `master` 上执行提交、合并、变基 |
| `block-rm-rf` | 递归删除文件 |
| `sanitize-api-keys` | API 密钥泄漏至智能体上下文 |

→ [全部 30 条内置策略](https://docs.befailproof.ai/built-in-policies)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何参数。提交到代码库后，团队成员下次拉取时即可同步生效。

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
| `deny(message)` | 阻止操作——消息将返回给智能体 |
| `instruct(message)` | 放行操作，但在智能体的下一个提示中附加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/custom-policies)

---

## 会话可见性

智能体发起的每一次工具调用均会在本地留存日志。控制面板清晰呈现已执行的操作、已拦截的内容，以及策略向智能体返回的信息——让你在出现问题时无需凭空猜测。→ [控制面板指南](https://docs.befailproof.ai/dashboard)

---

## 文档

| | |
|---|---|
| [快速入门](https://docs.befailproof.ai/getting-started) | 安装与初始步骤 |
| [内置策略](https://docs.befailproof.ai/built-in-policies) | 全部 30 条策略及其参数说明 |
| [自定义策略](https://docs.befailproof.ai/custom-policies) | 编写你自己的策略 |
| [配置说明](https://docs.befailproof.ai/configuration) | 配置作用域与合并规则 |
| [控制面板](https://docs.befailproof.ai/dashboard) | 会话监控与策略活动 |
| [架构设计](https://docs.befailproof.ai/architecture) | Hook 系统工作原理 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/) — 可免费用于内部及个人用途；将 failproofai 本身进行商业转售需另行签订协议。完整条款请参阅 [LICENSE](./LICENSE)。

---

## 参与贡献

请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。欢迎提交新策略、边缘案例处理以及翻译内容。

> **开始前请先构建项目。** 请先运行 `bun install && bun run build`。本仓库会对自身运行 failproofai 的 hook，这些 hook 会从编译后的 `dist/` 包中解析 `failproofai` 导入——若未完成构建，将触发 `Cannot find package 'failproofai'` hook 错误。修改 `src/` 后需重新构建。详见
> [构建项目以使仓库内开发 hook 正常工作](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [Nivedit Jain](https://github.com/NiveditJain) 与 [Nikita Agarwal](https://github.com/nk-ag) 共同构建。
[befailproof.ai](https://befailproof.ai)
