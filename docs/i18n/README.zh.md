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

**面向编程智能体的运行时故障修复工具。**
接入 Claude Code 和 Codex，在循环、危险操作和密钥泄露演变成事故之前将其拦截。零延迟，本地运行。

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
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/FailproofAI/failproofai/blob/main/docs/configuration.mdx" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
</p>

> 可为一个或多个 CLI 安装 hooks：`failproofai policies --install --cli opencode pi`（或 `--cli claude codex copilot cursor opencode pi hermes`）。省略 `--cli` 参数将自动检测已安装的 CLI 并提示选择。
>
> **Hermes**（hermes-agent，一个 Slack/Telegram 网关）同时支持**实时 hook 执行**（`--cli hermes` — 一次安装即可拦截所有平台和子智能体的工具调用）以及离线**审计**回放，可从单一的 `~/.hermes/state.db` 文件回放其网关会话。

---

## 安装

```sh
npm install -g failproofai
failproofai policies --install   # 或直接运行 `failproofai` 并接受首次运行提示
failproofai
```

30 条内置策略即时生效。访问 `localhost:8020` 查看控制台。使用 `FAILPROOFAI_NO_FIRST_RUN=1` 禁用首次运行提示。

---

## 拦截范围

| 策略 | 拦截内容 |
|---|---|
| `block-push-master` | 直接推送到 `main` / `master` 分支 |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | 在 `main` / `master` 上提交、合并、变基 |
| `block-rm-rf` | 递归删除文件 |
| `sanitize-api-keys` | API 密钥泄露到智能体上下文 |

→ [全部 30 条内置策略](https://docs.befailproof.ai/built-in-policies)

---

## 自定义策略

将文件放入 `.failproofai/policies/` 目录即可自动加载，无需任何额外参数。提交到代码库后，团队所有成员在下次拉取时即可生效。

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
| `deny(message)` | 阻止该操作——消息将返回给智能体 |
| `instruct(message)` | 放行该操作，但向智能体的下一个提示词中追加上下文信息 |

→ [自定义策略指南](https://docs.befailproof.ai/custom-policies)

---

## 会话可见性

智能体发起的每次工具调用都会在本地记录日志。控制台展示已执行的操作、被拦截的操作以及策略向智能体反馈的内容——让你在出现问题时不再茫然无措。→ [控制台指南](https://docs.befailproof.ai/dashboard)

---

## 文档

| | |
|---|---|
| [快速上手](https://docs.befailproof.ai/getting-started) | 安装与入门步骤 |
| [内置策略](https://docs.befailproof.ai/built-in-policies) | 全部 30 条策略及参数说明 |
| [自定义策略](https://docs.befailproof.ai/custom-policies) | 编写自己的策略 |
| [配置](https://docs.befailproof.ai/configuration) | 配置作用域与合并规则 |
| [控制台](https://docs.befailproof.ai/dashboard) | 会话监控与策略活动 |
| [架构](https://docs.befailproof.ai/architecture) | Hook 系统的工作原理 |

---

## 许可证

MIT 附加 [Commons Clause](https://commonsclause.com/) — 免费用于内部和个人用途；将 failproofai 本身作为商业产品转售需另行签订协议。完整条款请参阅 [LICENSE](./LICENSE)。

---

## 贡献

请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。欢迎贡献新策略、边界用例和翻译内容。

> **开始前请先构建项目。** 首先运行 `bun install && bun run build`。本仓库会对自身运行 failproofai 的 hooks，这些 hooks 从编译后的 `dist/` 包中解析 `failproofai` 导入——如果未执行构建，将会遇到 `Cannot find package 'failproofai'` hook 错误。修改 `src/` 后需重新构建。详见 [构建后才能使用仓库内开发 hooks](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)。

---

由 [Nivedit Jain](https://github.com/NiveditJain) 和 [Nikita Agarwal](https://github.com/nk-ag) 共同打造。
[befailproof.ai](https://befailproof.ai)
