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

**翻译版本：** [简体中文](../../docs-old/i18n/README.zh.md) · [日本語](../../docs-old/i18n/README.ja.md) · [한국어](../../docs-old/i18n/README.ko.md) · [Español](../../docs-old/i18n/README.es.md) · [Português](../../docs-old/i18n/README.pt-br.md) · [Deutsch](../../docs-old/i18n/README.de.md) · [Français](../../docs-old/i18n/README.fr.md) · [Руссий](../../docs-old/i18n/README.ru.md) · [हिन्दी](../../docs-old/i18n/README.hi.md) · [Türkçe](../../docs-old/i18n/README.tr.md) · [Tiếng Việt](../../docs-old/i18n/README.vi.md) · [Italiano](../../docs-old/i18n/README.it.md) · [العربية](../../docs-old/i18n/README.ar.md) · [עברית](../../docs-old/i18n/README.he.md)

**为编码 Agent 提供运行时故障解决方案。**
接入 Claude Code 和 Codex。在循环、危险操作和密钥泄露演变成事故之前将其拦截。零延迟，本地运行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 支持的 Agent CLI

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

30 条内置策略即时生效。控制台地址：`localhost:8020`。可通过设置 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `block-push-master` | 直接推送到 `main` / `master` 分支 |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | 在 `main` / `master` 上进行提交、合并、变基 |
| `block-rm-rf` | 递归删除文件 |
| `sanitize-api-keys` | API 密钥泄露到 Agent 上下文中 |

→ [全部 30 条内置策略](https://docs.befailproof.ai/policies/builtin)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何额外参数。提交后，团队所有成员在下次拉取时即可同步生效。

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
| `deny(message)` | 阻止操作——消息将返回给 Agent |
| `instruct(message)` | 放行操作，但向 Agent 的下一个提示词中追加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/policies/custom)

---

## 会话可视化

Agent 的每次工具调用都会在本地记录日志。控制台展示了哪些操作已执行、哪些被拦截，以及策略告知 Agent 的内容——让你在出现问题时不再一头雾水。→ [控制台指南](https://docs.befailproof.ai/sessions/overview)

---

## 文档

| | |
|---|---|
| [快速开始](https://docs.befailproof.ai/start/quickstart) | 安装与初步使用 |
| [内置策略](https://docs.befailproof.ai/policies/builtin) | 全部 30 条策略及参数说明 |
| [自定义策略](https://docs.befailproof.ai/policies/custom) | 编写你自己的策略 |
| [配置](https://docs.befailproof.ai/policies/local-configuration) | 配置作用域与合并规则 |
| [控制台](https://docs.befailproof.ai/sessions/overview) | 会话监控与策略活动 |
| [架构](https://docs.befailproof.ai/start/concepts) | Hook 系统工作原理 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/) ——内部及个人使用免费；将 failproofai 本身进行商业转售需要单独签署协议。完整条款请参阅 [LICENSE](../../LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。欢迎贡献新策略、边界用例及翻译内容。

> **开始前请先构建项目。** 首先运行 `bun install && bun run build`。本仓库会在自身上运行 failproofai 的 Hook，这些 Hook 会从编译后的 `dist/` 包中解析 `failproofai` 导入——若未构建，则会触发 `Cannot find package 'failproofai'` 的 Hook 错误。修改 `src/` 后请重新构建。详见 [构建后才能使用仓库内开发 Hook](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [befailproof.ai](https://befailproof.ai) 团队在旧金山与班加罗尔倾心打造 ❤️。
