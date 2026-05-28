> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**翻訳:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**コーディングエージェントのランタイム障害を解決します。**
Claude Code および Codex にフックし、ループ・危険な操作・シークレットの漏洩を
インシデントになる前に検知します。レイテンシーゼロ。ローカルで動作。

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応エージェント CLI

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
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> 1つまたは複数のCLIにフックをインストールできます: `failproofai policies --install --cli opencode pi gemini`（または `--cli claude codex copilot cursor opencode pi gemini`）。`--cli` を省略すると、インストール済みのCLIを自動検出してプロンプトで確認します。

---

## インストール

```sh
npm install -g failproofai
failproofai policies --install   # または `failproofai` を実行して初回プロンプトに従う
failproofai
```

30個の組み込みポリシーが即座に有効になります。ダッシュボードは `localhost:8020` で確認できます。初回プロンプトを無効にするには `FAILPROOFAI_NO_FIRST_RUN=1` を設定してください。

---

## 防御できること

| ポリシー | ブロック内容 |
|---|---|
| `block-push-master` | `main` / `master` への直接プッシュ |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` へのコミット・マージ・リベース |
| `block-rm-rf` | 再帰的なファイル削除 |
| `sanitize-api-keys` | エージェントコンテキストへのAPIキーの漏洩 |

→ [組み込みポリシー全30件](https://docs.befailproof.ai/built-in-policies)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを配置するだけで、フラグ不要で自動的に読み込まれます。
コミットすればチーム全員が次回のプルで適用されます。

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

すべてのポリシーで使用できる3つの判定:

| 判定 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージはエージェントに返される |
| `instruct(message)` | 通過させつつ、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/custom-policies)

---

## セッションの可視化

エージェントが行うすべてのツール呼び出しはローカルに記録されます。ダッシュボードでは、実行された内容・ブロックされた内容・ポリシーがエージェントに伝えた内容を確認できるため、問題が発生しても推測で判断する必要がありません。→ [ダッシュボードガイド](https://docs.befailproof.ai/dashboard)

---

## ドキュメント

| | |
|---|---|
| [はじめに](https://docs.befailproof.ai/getting-started) | インストールと最初のステップ |
| [組み込みポリシー](https://docs.befailproof.ai/built-in-policies) | パラメータ付き全30ポリシー |
| [カスタムポリシー](https://docs.befailproof.ai/custom-policies) | 独自ポリシーの作成方法 |
| [設定](https://docs.befailproof.ai/configuration) | 設定スコープとマージルール |
| [ダッシュボード](https://docs.befailproof.ai/dashboard) | セッションモニターとポリシーアクティビティ |
| [アーキテクチャ](https://docs.befailproof.ai/architecture) | フックシステムの仕組み |

---

## ライセンス

MIT に [Commons Clause](https://commonsclause.com/) を付加 — 社内利用および個人利用は無料。failproofai 自体の商業的な再販には別途契約が必要です。全文は [LICENSE](./LICENSE) を参照してください。

---

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md) をご覧ください。新しいポリシー、エッジケースの対応、翻訳はいずれも歓迎します。

---

[Nivedit Jain](https://github.com/NiveditJain) と [Nikita Agarwal](https://github.com/nk-ag) によって開発されました。
[befailproof.ai](https://befailproof.ai)
