> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**翻訳:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**エージェントが動くあらゆるハーネスに、オブザーバビリティと強制力を。**
エージェントがどこで動いていても、Failproof は把握しています――そして「ノー」と言えます。Failproof は 12 のエージェントハーネスにフックします。Claude Code や Codex のようなコーディング CLI、Hermes のようなチャットゲートウェイ、OpenClaw のようなセルフホスト型アシスタントに対応し、すべての実行をキャプチャして、危険なツール呼び出しが実行される前にブロックします。組み込みポリシーは 39 個。レイテンシゼロ。ローカルで動作。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応ハーネス

2 つのクラスで合計 12 のハーネスに対応しています――コーディング CLI が 10 種、チャット・アシスタントゲートウェイ（Hermes、OpenClaw）が 2 種です。すべてに共通の 1 つのポリシー API と、統合されたセッション履歴を提供します。ポリシーで*ブロック*できる内容はハーネスごとに異なります。ツール呼び出しの事前停止は全 12 ハーネスで検証済み、ターン終了ゲートは 8 ハーネスで対応しています。各ハーネスがどのイベントに対応しているかは[ハーネスごとのマトリクス](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)をご覧ください。

上記のいずれのハーネスでも動かないエージェントは、[Python SDK](https://docs.befailproof.ai/reference/custom-agents) 経由でレポートできます。トレーシング、セッション、監査機能を提供します。その場合の強制適用には自前のランタイムへのフック追加が必要です――[お問い合わせ](mailto:support@befailproof.ai)いただければ対応方法をご案内します。

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
failproofai config                             # エージェントとデーモンを接続する
failproofai policies add FailproofAI/policies  # 適用するポリシーを選ぶ
failproofai                                    # localhost:8020 でダッシュボードを表示
```

セットアップはフックを接続しますが、ポリシーは**何も**有効にしません――2 番目のコマンドがマシンにガードレールを設定します。パックの指定方法はどれも同じです（`failproofai policies add <owner>/<repo>`；`policies show <owner>/<repo>` で内容を確認できます）。ターミナルなしで `failproofai config` を実行すると――CI、コンテナ、エージェントから呼び出す場合など――質問ダイアログではなく直接適用されます。未セットアップのマシンでは、他のコマンドを実行すると同じウィザードが先に起動します。`FAILPROOFAI_NO_FIRST_RUN=1` でこの動作を無効にできます。

パックが導入されるまでの間、強制適用されるのは `block-failproofai-commands` のみです。これは常時有効で、無効化や一時停止ができません。強制適用を一時停止できるエージェントは、他のすべてのポリシーも無効にできてしまうためです。

---

## 防止できること

| ポリシー | ブロック内容 |
|---|---|
| `block-env-files` | `.env` などのシークレットファイルの読み取り |
| `warn-repeated-tool-calls` | エージェントが同じ呼び出しをループし続ける動作 |
| `block-sudo` | 権限昇格 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、条件なしの `DELETE` |
| `block-terraform` / `block-kubectl` | レビューなしの本番インフラへの変更 |
| `block-rm-rf` | 再帰的なファイル削除 |
| `block-force-push` / `block-push-master` | `git push --force`、`main` への直接プッシュ |

これらはすべてツール呼び出しが*実行される前*にゲートするため、全 12 ハーネスで有効です。最初の 4 つはツールを呼び出せるあらゆるエージェントに適用されます。残りの 3 つは開発者に特に人気のポリシーで、コーディング CLI は最も手厚くカバーしているハーネスクラスです。`sanitize-*` ファミリーは別枠です。ツールが返却した後に実行されるため、シークレットをコンテキストに入れないのではなく、ツール出力に含まれるシークレットを検出・報告します。

→ [全 39 の組み込みポリシー](https://docs.befailproof.ai/policies/packs)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます。フラグ不要。コミットすれば、次回プル時にチーム全員に適用されます。

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

各ポリシーで使える判定は 3 種類です。

| 判定 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする――メッセージはエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [ポリシーを書く](https://docs.befailproof.ai/policies/editor)

---

## オブザーバビリティ

強制適用は機能の半分に過ぎません。もう半分は、エージェントが実際に何をしたかを把握することです。

引数なしで `failproofai` を実行すると、`localhost:8020` でダッシュボードが起動し、マシン上の実行履歴を読み込みます。アカウント不要、サインアップ不要、データがマシン外に出ることもありません。セッション一覧、各実行内のモデル呼び出し・ツール呼び出し・フック判定のシーケンス、ブロックされた内容とポリシーがエージェントに伝えた内容、そしてオフライン監査（`failproofai audit`）で履歴内のリスクパターンを検出してそれを防ぐポリシーを提案します。

→ [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) ·
[トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ローカル監査](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** は同じデータモデルのホスト型サービスで、フリート全体でエージェントを運用するチーム向けです。全ハーネスのすべての実行を一元管理し、並列サブエージェントを個別レーンで表示する実行グラフ、モデル・ツール・フックの p50/p95/p99 レイテンシ、モデルごとのコストとコンテキストウィンドウ追跡、エラートラッキング、共有可能なダッシュボード付きのトレースへの SQL クエリ、独自サービスによるスコアリング評価、繰り返す障害をエビデンスに基づく知見に変える定期監査、Slack・メール・署名付き Webhook へのアラートルーティングを提供します。Enterprise プランではお客様自身のクラスターへのセルフホスティングも可能です。

→ [セッション](https://docs.befailproof.ai/sessions/overview) ·
[監査](https://docs.befailproof.ai/audits/overview) ·
[デモを予約する](https://befailproof.ai/get-a-demo)

---

## ドキュメント

| スタート | |
|---|---|
| [クイックスタート](https://docs.befailproof.ai/start/quickstart) | インストール、ハーネスの接続、最初の実行を確認する |
| [コンセプト](https://docs.befailproof.ai/start/concepts) | フックシステムの仕組み |
| [対応ハーネス](https://docs.befailproof.ai/reference/harnesses) | 全 12 種と各ハーネスで強制適用できること |

| オブザーブ | |
|---|---|
| [セッション](https://docs.befailproof.ai/sessions/overview) | 実行を追う：モデル、ツール、エラー、レイテンシ |
| [トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) | 実行グラフが示す内容 |
| [監査](https://docs.befailproof.ai/audits/overview) | 多数のセッションにまたがる障害パターンを発見する |
| [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`、アカウント不要 |

| エンフォース | |
|---|---|
| [ポリシーパック](https://docs.befailproof.ai/policies/packs) | Failproof AI のポリシーと、ポリシーハブのパック |
| [ポリシーを書く](https://docs.befailproof.ai/policies/editor) | 監査から、またはコードで |
| [設定](https://docs.befailproof.ai/policies/local-configuration) | 設定スコープ、マージルール、ポリシーパラメータ |

| 独自エージェントの計装 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ハーネスなしのエージェントから実行をレポートする |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` リファレンス |

---

## ライセンス

MIT with [Commons Clause](https://commonsclause.com/) ――社内利用および個人利用は無料。failproofai 自体の商用再販には別途契約が必要です。全文は [LICENSE](../../LICENSE) をご覧ください。

---

## コントリビュート

[CONTRIBUTING.md](../../CONTRIBUTING.md) をご覧ください。新しいポリシー、エッジケースへの対応、翻訳はいずれも歓迎します。

> **作業前にビルドしてください。** まず `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自分自身に対して実行しており、`failproofai` のインポートをコンパイル済みの `dist/` バンドルに対して解決します。ビルドなしに実行すると、`Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳細は [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) を参照してください。

---

❤️ を込めて [befailproof.ai](https://befailproof.ai) が SF とベンガルールで開発しています。
