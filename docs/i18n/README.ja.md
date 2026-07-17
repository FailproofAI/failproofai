> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**翻訳:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**コーディングエージェントのランタイム障害解決ツール。**
Claude Code および Codex にフックし、ループ・危険な操作・シークレットの漏洩を
インシデントになる前に検出・阻止します。レイテンシーゼロ。ローカル動作。

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応エージェント CLI

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

## インストール

```sh
npm install -g failproofai
failproofai policies --install   # または `failproofai` を実行して初回起動時のプロンプトを承認
failproofai
```

30 個の組み込みポリシーが即座に有効になります。ダッシュボードは `localhost:8020` で確認できます。初回起動プロンプトを無効にするには `FAILPROOFAI_NO_FIRST_RUN=1` を設定してください。

---

## 防止できること

| ポリシー | ブロック対象 |
|---|---|
| `block-push-master` | `main` / `master` への直接プッシュ |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` へのコミット・マージ・リベース |
| `block-rm-rf` | 再帰的なファイル削除 |
| `sanitize-api-keys` | エージェントのコンテキストへの API キー漏洩 |

→ [30 個すべての組み込みポリシー](https://docs.befailproof.ai/built-in-policies)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます。フラグは不要です。
コミットすれば、次回プル時にチーム全員へ反映されます。

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

各ポリシーで使用できる 3 つの判定:

| 判定 | 動作 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させつつ、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/custom-policies)

---

## セッションの可視化

エージェントが行ったすべてのツール呼び出しはローカルに記録されます。ダッシュボードでは、実行された内容・ブロックされた内容・ポリシーがエージェントに伝えた内容を確認できるため、問題が発生した際に推測する必要がありません。→ [ダッシュボードガイド](https://docs.befailproof.ai/dashboard)

---

## ドキュメント

| | |
|---|---|
| [Getting Started](https://docs.befailproof.ai/getting-started) | インストールと最初のステップ |
| [Built-in Policies](https://docs.befailproof.ai/built-in-policies) | パラメーター付き全 30 ポリシー |
| [Custom Policies](https://docs.befailproof.ai/custom-policies) | 独自ポリシーの作成方法 |
| [Configuration](https://docs.befailproof.ai/configuration) | 設定スコープとマージルール |
| [Dashboard](https://docs.befailproof.ai/dashboard) | セッションモニターとポリシーアクティビティ |
| [Architecture](https://docs.befailproof.ai/architecture) | フックシステムの仕組み |

---

## ライセンス

MIT に [Commons Clause](https://commonsclause.com/) を追加 — 社内利用および個人利用は無償。failproofai 自体の商業的な再販には別途契約が必要です。全文は [LICENSE](./LICENSE) を参照してください。

---

## コントリビュート

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。新しいポリシー、エッジケース、翻訳はいずれも歓迎します。

> **開始前にビルドしてください。** まず `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自分自身に適用しており、`failproofai` のインポートはコンパイル済みの `dist/` バンドルに対して解決されます。ビルドなしで実行すると `Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は必ず再ビルドしてください。詳細は [リポジトリ内の開発用フックを動作させるためのビルド](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) を参照してください。

---

[Nivedit Jain](https://github.com/NiveditJain) と [Nikita Agarwal](https://github.com/nk-ag) が開発。
[befailproof.ai](https://befailproof.ai)
