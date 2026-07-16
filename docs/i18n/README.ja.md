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

**コーディングエージェントのランタイム障害解決ツール。**
Claude Code および Codex にフックし、ループ・危険な操作・シークレット漏洩を
インシデントになる前に検知・阻止します。レイテンシーゼロ。ローカル実行。

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

> 1つまたは任意の組み合わせでフックをインストールできます: `failproofai policies --install --cli opencode pi`（または `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`）。`--cli` を省略すると、インストール済みの CLI を自動検出してプロンプトを表示します。
>
> **Hermes**（hermes-agent、Slack/Telegram ゲートウェイ）は、**ライブフック適用**（`--cli hermes` — 1回のインストールで全プラットフォームおよびサブエージェントのツール呼び出しをインターセプト）と、単一の `~/.hermes/state.db` からゲートウェイセッションをオフライン**監査**リプレイする両方に対応しています。
>
> **OpenClaw**（openclaw gateway、セルフホスト型マルチチャンネルアシスタント）は、**ライブフック適用**（`--cli openclaw`、ユーザースコープ）と、JSONL セッション（`~/.openclaw/agents/<id>/sessions/*.jsonl`）のオフライン**監査**リプレイの両方に対応しています。適用には OpenClaw の**インプロセスプラグインフック**（failproofai を非同期起動する同梱の `openclaw-plugin/` — ファイルベースの内部フックは観測専用でブロック不可）を使用します: `before_tool_call` でツールをブロックし、`before_agent_finalize` はターン終了のゲートとして機能するため、`require-*-before-stop` ビルトインが有効になります。
>
> **Factory Droid**（`droid`）は、**ライブフック適用**（`--cli factory`、ユーザー＋プロジェクトスコープ）と、ディスク上の JSONL セッションのオフライン**監査**リプレイの両方に対応しています。droid はフックの**終了コード 2**でツール呼び出しをブロックし（JSON による判断ではなく）、`{decision:"block"}` はターン終了の `Stop` イベントのみ有効です — failproofai はイベントごとに適切な形式を自動的に出力します。
>
> **Devin CLI**（`devin`、Cognition）は、**ライブフック適用**（`--cli devin`、ユーザー＋プロジェクトスコープ）と、SQLite セッション（`~/.local/share/devin/cli/sessions.db`）のオフライン**監査**リプレイの両方に対応しています。Devin は**純粋な Claude クローン**です — 同じイベント名、同じ snake_case ペイロード、同じ `"hooks"` ラッパー設定（`~/.config/devin/config.json` / `<cwd>/.devin/config.json`）— すべてのイベントで `{decision:"block"}` JSON によってブロックします。
>
> **Antigravity CLI**（`agy`）は、**ライブフック適用**（`--cli antigravity`、ユーザー＋プロジェクトスコープ）と、プレーン JSONL セッション（`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`）のオフライン**監査**リプレイの両方に対応しています。Antigravity は**独自の**契約を持ちます（Claude クローンではありません）: **名前付きフック**の `hooks.json` スキーマ（`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`）、failproofai が正規化する camelCase の stdin ペイロード、および独自のレスポンス形式 — ツールをブロックする `{decision:"deny"}`、`Stop` 時に次のターンを強制する `{decision:"continue"}`、モデル実行前にリマインダーを挿入する `{injectSteps}`。
>
> **Goose**（コードネーム goose、Block）は、**ライブフック適用**（`--cli goose`、ユーザー＋プロジェクトスコープ）と、SQLite セッション（`~/.local/share/goose/sessions/sessions.db`）のオフライン**監査**リプレイの両方に対応しています。適用には Goose の**フック**システム（クロスエージェントの **Open Plugins** 仕様）を使用します — インストーラーは `~/.agents/plugins/failproofai/` にプラグインディレクトリを配置するだけで、Goose が自動検出します。ブロックは PreToolUse イベントの `{"decision":"block"}` JSON（シェルツールおよび委譲されたサブエージェント内で発火）で行われ、goose v1.43.0 に対してライブ検証済みです。Goose にはターン終了の `Stop` イベントがないため、`require-*-before-stop` ビルトインは適用されません（Hermes と同様）。

---

## インストール

```sh
npm install -g failproofai
failproofai policies --install   # または `failproofai` を実行して初回起動プロンプトに従う
failproofai
```

30 個のビルトインポリシーが即座に有効化されます。ダッシュボードは `localhost:8020` で確認できます。初回起動プロンプトを無効化するには `FAILPROOFAI_NO_FIRST_RUN=1` を設定してください。

---

## 何を防ぐか

| ポリシー | ブロック対象 |
|---|---|
| `block-push-master` | `main` / `master` への直接プッシュ |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` へのコミット・マージ・リベース |
| `block-rm-rf` | 再帰的なファイル削除 |
| `sanitize-api-keys` | エージェントコンテキストへの API キー漏洩 |

→ [30 個のビルトインポリシー一覧](https://docs.befailproof.ai/built-in-policies)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます。フラグは不要です。
コミットすれば、次回プル時にチーム全員に適用されます。

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

各ポリシーで使用できる判断は3種類です:

| 判断 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させつつ、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/custom-policies)

---

## セッションの可視化

エージェントが行ったすべてのツール呼び出しはローカルにログとして記録されます。ダッシュボードでは、実行されたもの・ブロックされたもの・ポリシーがエージェントに伝えた内容を確認できます — 問題が発生したときに推測で対処する必要はありません。→ [ダッシュボードガイド](https://docs.befailproof.ai/dashboard)

---

## ドキュメント

| | |
|---|---|
| [はじめに](https://docs.befailproof.ai/getting-started) | インストールと最初のステップ |
| [ビルトインポリシー](https://docs.befailproof.ai/built-in-policies) | パラメーター付き 30 ポリシー全覧 |
| [カスタムポリシー](https://docs.befailproof.ai/custom-policies) | 独自ポリシーの作成方法 |
| [設定](https://docs.befailproof.ai/configuration) | 設定スコープとマージルール |
| [ダッシュボード](https://docs.befailproof.ai/dashboard) | セッションモニターとポリシーアクティビティ |
| [アーキテクチャ](https://docs.befailproof.ai/architecture) | フックシステムの仕組み |

---

## ライセンス

MIT + [Commons Clause](https://commonsclause.com/) — 社内利用・個人利用は無償。failproofai 自体の商用再販には別途契約が必要です。全文は [LICENSE](./LICENSE) をご覧ください。

---

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md) をご参照ください。新しいポリシー、エッジケース、翻訳はいずれも歓迎します。

> **開始前にビルドしてください。** 最初に `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自身に対して実行しており、`failproofai` のインポートをコンパイル済みの `dist/` バンドルに対して解決します — ビルドなしで実行すると `Cannot find package 'failproofai'` フックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳細は [リポジトリ内開発フックを動かすためのビルド手順](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) をご覧ください。

---

[Nivedit Jain](https://github.com/NiveditJain) と [Nikita Agarwal](https://github.com/nk-ag) が開発。
[befailproof.ai](https://befailproof.ai)
