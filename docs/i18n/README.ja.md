> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**翻訳:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**コーディングエージェントのランタイム障害をその場で解決。**
Claude Code と Codex にフックして、ループ・危険な操作・シークレットの漏洩を
インシデントになる前にキャッチします。レイテンシーゼロ。ローカルで動作。

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

> 1つまたは複数の組み合わせでフックをインストールできます: `failproofai policies --install --cli opencode pi`（または `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`）。`--cli` を省略すると、インストール済みの CLI を自動検出してプロンプトが表示されます。
>
> **Hermes**（hermes-agent、Slack/Telegram ゲートウェイ）は、**ライブフック適用**（`--cli hermes` — 1回のインストールですべてのプラットフォームとサブエージェントのツール呼び出しをインターセプト）とゲートウェイセッションのオフライン**監査**リプレイ（単一の `~/.hermes/state.db` から）の両方に対応しています。
>
> **OpenClaw**（openclaw gateway、セルフホスト型マルチチャネルアシスタント）は、**ライブフック適用**（`--cli openclaw`、ユーザースコープ）と JSONL セッションのオフライン**監査**リプレイ（`~/.openclaw/agents/<id>/sessions/*.jsonl`）の両方に対応しています。適用には OpenClaw の**インプロセスプラグインフック**を使用します（同梱の `openclaw-plugin/` が failproofai を非同期でスポーン — ファイルベースの内部フックは観察のみで、ブロックはできません）: `before_tool_call` でツールをブロックし、`before_agent_finalize` は実際のターン終了ゲートとして機能するため、`require-*-before-stop` ビルトインが有効です。
>
> **Factory Droid**（`droid`）は、**ライブフック適用**（`--cli factory`、ユーザー + プロジェクトスコープ）とオンディスク JSONL セッションのオフライン**監査**リプレイの両方に対応しています。droid はフックの**終了コード 2**でツール呼び出しをブロックし（JSON による判定ではない）、ターン終了の `Stop` イベントでのみ `{decision:"block"}` を受け付けます — failproofai はイベントごとに自動的に適切な形式を出力します。
>
> **Devin CLI**（`devin`、Cognition）は、**ライブフック適用**（`--cli devin`、ユーザー + プロジェクトスコープ）と SQLite セッションのオフライン**監査**リプレイ（`~/.local/share/devin/cli/sessions.db`）の両方に対応しています。Devin は **Claude の完全なクローン** — 同じイベント名、同じ snake_case ペイロード、同じ `"hooks"` ラッパー設定（`~/.config/devin/config.json` / `<cwd>/.devin/config.json`）— すべてのイベントで `{decision:"block"}` JSON によるブロックに対応しています。
>
> **Antigravity CLI**（`agy`）は、**ライブフック適用**（`--cli antigravity`、ユーザー + プロジェクトスコープ）とプレーン JSONL セッションのオフライン**監査**リプレイ（`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`）の両方に対応しています。Antigravity は**独自の**コントラクトを持ちます（Claude クローンではありません）: **名前付きフック** `hooks.json` スキーマ（`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`）、failproofai が正規化する camelCase の stdin ペイロード、および独自のレスポンス形式 — ツールのブロックには `{decision:"deny"}`、`Stop` 時に別のターンを強制するには `{decision:"continue"}`、モデル実行前にリマインダーを挿入するには `{injectSteps}` を使用します。
>
> **Goose**（コードネーム goose、Block 社）は、**ライブフック適用**（`--cli goose`、ユーザー + プロジェクトスコープ）と SQLite セッションのオフライン**監査**リプレイ（`~/.local/share/goose/sessions/sessions.db`）の両方に対応しています。適用には Goose の**フック**システム（クロスエージェントの **Open Plugins** 仕様）を使用します — インストーラーが `~/.agents/plugins/failproofai/` にプラグインディレクトリを配置するだけで、Goose が自動検出します。ブロックは `PreToolUse` イベントで `{"decision":"block"}` JSON を使用します（シェルツールおよび委譲されたサブエージェント内でも発火します）。goose v1.43.0 で実際に確認済みです。Goose にはターン終了の `Stop` イベントがないため、`require-*-before-stop` ビルトインは適用されません（Hermes と同様）。

---

## インストール

```sh
npm install -g failproofai
failproofai policies --install   # または `failproofai` を実行して初回起動プロンプトに従う
failproofai
```

30 個のビルトインポリシーが即座に有効になります。ダッシュボードは `localhost:8020` で確認できます。`FAILPROOFAI_NO_FIRST_RUN=1` を設定すると初回起動プロンプトを無効化できます。

---

## 防止できること

| ポリシー | ブロックする操作 |
|---|---|
| `block-push-master` | `main` / `master` への直接プッシュ |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` へのコミット・マージ・リベース |
| `block-rm-rf` | 再帰的なファイル削除 |
| `sanitize-api-keys` | エージェントコンテキストへの API キー漏洩 |

→ [全 30 件のビルトインポリシー](https://docs.befailproof.ai/built-in-policies)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを配置するだけで自動的に読み込まれます。フラグは不要です。
コミットすれば、次回プル時にチーム全員に反映されます。

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

すべてのポリシーで利用できる3つの判定:

| 判定 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/custom-policies)

---

## セッションの可視化

エージェントが行ったすべてのツール呼び出しはローカルに記録されます。ダッシュボードでは、実行された内容・ブロックされた内容・ポリシーがエージェントに伝えた内容を確認できるため、問題発生時に推測に頼る必要がありません。→ [ダッシュボードガイド](https://docs.befailproof.ai/dashboard)

---

## ドキュメント

| | |
|---|---|
| [はじめに](https://docs.befailproof.ai/getting-started) | インストールと最初のステップ |
| [ビルトインポリシー](https://docs.befailproof.ai/built-in-policies) | パラメータ付き全 30 ポリシー |
| [カスタムポリシー](https://docs.befailproof.ai/custom-policies) | 独自ポリシーの作成方法 |
| [設定](https://docs.befailproof.ai/configuration) | 設定スコープとマージルール |
| [ダッシュボード](https://docs.befailproof.ai/dashboard) | セッションモニターとポリシーアクティビティ |
| [アーキテクチャ](https://docs.befailproof.ai/architecture) | フックシステムの仕組み |

---

## ライセンス

MIT に [Commons Clause](https://commonsclause.com/) を付加したライセンス — 社内利用および個人利用は無料。failproofai 自体の商用再販には別途契約が必要です。全文は [LICENSE](./LICENSE) を参照してください。

---

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。新しいポリシー、エッジケース、翻訳のご貢献を歓迎します。

> **開始前にビルドを実行してください。** まず `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自分自身に対して実行しており、`failproofai` のインポートをコンパイル済みの `dist/` バンドルに解決します。ビルドなしで実行すると `Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳細は [リポジトリ内開発フックを動作させるためのビルド手順](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) を参照してください。

---

[Nivedit Jain](https://github.com/NiveditJain) と [Nikita Agarwal](https://github.com/nk-ag) によって開発されました。
[befailproof.ai](https://befailproof.ai)
