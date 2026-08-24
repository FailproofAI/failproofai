> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**翻訳版:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**あらゆるハーネスで動くエージェントに、オブザーバビリティと制御を。**
エージェントがどこで動いていても、Failproofはすべてを把握し、必要なときに「ノー」と言えます。Failproofは12のエージェントハーネスにフックし — Claude Code や Codex などのコーディングCLI、Hermes などのチャットゲートウェイ、OpenClaw などのセルフホスト型アシスタント — すべての実行を記録し、危険なツール呼び出しを実行前にブロックします。40の組み込みポリシー。レイテンシゼロ。ローカル動作。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応ハーネス

2つのクラスに分かれた12のハーネス — 10のコーディングCLIと、2つのチャット・アシスタントゲートウェイ（Hermes、OpenClaw）。どのハーネスを使っても、同じイベント、同じポリシー、同じセッション履歴が利用できます。

いずれのハーネスにも属さないエージェントは [Python SDK](https://docs.befailproof.ai/reference/custom-agents) を通じてレポートできます。トレース、セッション、監査機能が利用可能です。その環境でのエンフォースメントにはご自身のランタイムへのフック実装が必要です — [お問い合わせください](mailto:support@befailproof.ai)。対応方法をご案内します。

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

## インストール

```sh
npm install -g failproofai
failproofai policies --install   # または `failproofai` を実行して初回プロンプトに従うだけでもOK
failproofai
```

40の組み込みポリシーが即座に有効化されます。ダッシュボードは `localhost:8020` で確認できます。初回プロンプトを無効にするには `FAILPROOFAI_NO_FIRST_RUN=1` を設定してください。

---

## ブロックできる操作

| ポリシー | ブロック対象 |
|---|---|
| `sanitize-api-keys` | エージェントのコンテキストへのAPIキー漏洩 |
| `block-env-files` | `.env` などのシークレットファイルの読み取り |
| `warn-repeated-tool-calls` | 同じ呼び出しをループし続けるエージェント |
| `block-sudo` | 権限昇格 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、条件なし `DELETE` |
| `block-terraform` / `block-kubectl` | 本番インフラへの未レビュー変更 |
| `block-rm-rf` | 再帰的なファイル削除 |
| `block-force-push` / `block-push-master` | `git push --force`、`main` への直接プッシュ |

最初の5つはツールを呼び出せるあらゆるエージェントに適用されます。残りの3つは開発者に特に人気のポリシーで、コーディングCLIはもっとも深くカバーしているハーネスクラスです。

→ [組み込みポリシー一覧（40件）](https://docs.befailproof.ai/policies/builtin)

---

## カスタムポリシー

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます。フラグ不要。コミットすればチーム全員が次のプルで使えます。

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

各ポリシーで使用できる3つの判断：

| 判断 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージはエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/policies/custom)

---

## オブザーバビリティ

エンフォースメントは半分にすぎません。もう半分は、エージェントが実際に何をしたかを把握することです。

`failproofai` を引数なしで実行すると、`localhost:8020` にダッシュボードが起動し、マシン上の実行履歴を読み込みます — アカウント不要、サインアップ不要、データは外部に出ません。セッション一覧、モデル呼び出しのシーケンス、各実行内のツール呼び出しとフック判断、ブロックされた内容とポリシーがエージェントに伝えた内容、そしてオフライン監査（`failproofai audit`）で履歴からリスクのあるパターンを検出してポリシーの提案を行います。

→ [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) ·
[トレースの読み方](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ローカル監査](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** は同じデータモデルのホスト型サービスで、フリートでエージェントを運用するチーム向けです。全ハーネスのすべての実行を一か所に集約し、並列サブエージェントを独立レーンで表示する実行グラフ、モデル・ツール・フックのp50/p95/p99レイテンシ、モデルごとのコストとコンテキストウィンドウのトラッキング、エラートラッキング、共有可能なダッシュボード付きSQLクエリ、独自サービスによるスコアリング評価、繰り返す失敗をエビデンスに基づく知見に変える定期監査、そしてSlack・メール・署名付きWebhookへのアラートルーティングを提供します。自社クラスターへのセルフホスティングはEnterpriseプランで利用可能です。

→ [セッション](https://docs.befailproof.ai/sessions/overview) ·
[監査](https://docs.befailproof.ai/audits/overview) ·
[デモを予約する](https://befailproof.ai/get-a-demo)

---

## ドキュメント

| はじめに | |
|---|---|
| [クイックスタート](https://docs.befailproof.ai/start/quickstart) | インストール、ハーネスの接続、最初の実行を確認する |
| [コンセプト](https://docs.befailproof.ai/start/concepts) | フックシステムの仕組み |
| [対応ハーネス](https://docs.befailproof.ai/reference/harnesses) | 全12件と各ハーネスで適用できるポリシー |

| 観測する | |
|---|---|
| [セッション](https://docs.befailproof.ai/sessions/overview) | 実行を追う：モデル、ツール、エラー、レイテンシ |
| [トレースの読み方](https://docs.befailproof.ai/sessions/read-a-trace) | 実行グラフが示していること |
| [監査](https://docs.befailproof.ai/audits/overview) | 多数のセッションにまたがる失敗パターンを発見する |
| [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`、アカウント不要 |

| 制御する | |
|---|---|
| [組み込みポリシー](https://docs.befailproof.ai/policies/builtin) | パラメータ付き全40ポリシー |
| [カスタムポリシー](https://docs.befailproof.ai/policies/custom) | 独自ポリシーを作成する |
| [設定](https://docs.befailproof.ai/policies/local-configuration) | 設定スコープとマージルール |

| 独自エージェントを計測する | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ハーネスなしのエージェントから実行をレポートする |
| [ポリシーSDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` リファレンス |

---

## ライセンス

MIT with [Commons Clause](https://commonsclause.com/) — 社内利用・個人利用は無料。failproofai 自体の商業的な再販には別途契約が必要です。全文は [LICENSE](../../LICENSE) をご覧ください。

---

## コントリビューション

[CONTRIBUTING.md](../../CONTRIBUTING.md) をご参照ください。新しいポリシー、エッジケースの対応、翻訳の追加はいずれも歓迎します。

> **作業前にビルドしてください。** まず `bun install && bun run build` を実行してください。このリポジトリはfailproofai自身のフックを自分自身に適用しており、フックはコンパイル済みの `dist/` バンドルに対して `failproofai` インポートを解決します。ビルドなしで実行すると `Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳細は [リポジトリ内の開発用フックを動作させるためのビルド手順](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) をご覧ください。

---

SFとベンガルールのチームが ❤️ を込めて開発。[befailproof.ai](https://befailproof.ai)
