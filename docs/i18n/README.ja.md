> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**翻訳:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**エージェントが動作するあらゆるハーネスに対応したオブザーバビリティと制御。**
エージェントがどこで動いていても、私たちはすべてを把握し、必要なら止めることができます。Failproof は 12 種類のエージェントハーネスにフックし — Claude Code や Codex のようなコーディング CLI、Hermes のようなチャットゲートウェイ、OpenClaw のようなセルフホスト型アシスタント — すべての実行をキャプチャし、危険なツール呼び出しを実行前にブロックします。39 個の組み込みポリシー。ゼロレイテンシー。ローカル実行。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応ハーネス

12 種類のハーネスを 2 つのカテゴリに分類しています — コーディング CLI が 10 種類、チャット・アシスタントゲートウェイ（Hermes、OpenClaw）が 2 種類です。すべてのハーネスで共通のポリシー API とセッション履歴を使用します。ポリシーで*ブロック*できる内容はハーネスごとに異なります。ツール呼び出しを実行前に停止する機能は 12 種類すべてで検証済み、ターン終了ゲートは 8 種類で対応しています。[ハーネス別対応表](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)には各ハーネスが処理するイベントの一覧が掲載されています。

いずれのハーネスでも動作しないエージェントは [Python SDK](https://docs.befailproof.ai/reference/custom-agents) を通じてレポートでき、トレーシング、セッション管理、監査機能が利用できます。その場合の制御には独自ランタイムへのフック実装が必要です — [お問い合わせ](mailto:support@befailproof.ai)いただければ対応方法をご案内します。

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
failproofai policies add FailproofAI/policies  # 適用するポリシーを選択する
failproofai                                    # localhost:8020 でダッシュボードを起動
```

セットアップはフックを接続しますが、ポリシーは**何も**適用しません — 2 番目のコマンドがマシンにガードレールを設定します。パックはすべて同じ形式で指定できます（`failproofai policies add <owner>/<repo>`。`policies show <owner>/<repo>` で内容を先に確認できます）。ターミナルなしで `failproofai config` を実行すると — CI 環境、コンテナ、それを操作するエージェントからでも — 対話形式ではなく自動的に設定が適用されます。まだセットアップされていないマシンでは、他のコマンドを実行すると最初に同じウィザードが起動します。`FAILPROOFAI_NO_FIRST_RUN=1` で無効にできます。

パックが導入されるまでの間、`block-failproofai-commands` のみが有効な制御として機能します。これは常時オンで、無効化や一時停止はできません。制御を一時停止できるエージェントは、他のすべてのポリシーも無効にできてしまうためです。

---

## ブロックできること

| ポリシー | ブロック対象 |
|---|---|
| `block-env-files` | `.env` などのシークレットファイルの読み取り |
| `warn-repeated-tool-calls` | 同じ呼び出しをループするエージェント |
| `block-sudo` | 権限昇格 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、条件なし `DELETE` |
| `block-terraform` / `block-kubectl` | レビューなしの本番インフラへの変更 |
| `block-rm-rf` | 再帰的なファイル削除 |
| `block-force-push` / `block-push-master` | `git push --force`、`main` への直接プッシュ |

これらはすべて呼び出しが実行される*前*にゲートするため、12 種類すべてのハーネスで機能します。最初の 4 つはツールを呼び出せる任意のエージェントに適用されます。残りの 3 つは開発者に特に人気のポリシーで、コーディング CLI は私たちが最も深くカバーするハーネスクラスです。`sanitize-*` ファミリーは別扱いで、ツールの戻り値の後に実行されるため、コンテキストへの混入を防ぐのではなく、ツール出力にシークレットが含まれていることを報告します。

→ [39 個の組み込みポリシー一覧](https://docs.befailproof.ai/policies/packs)

---

## カスタムポリシー

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます — フラグの指定は不要です。コミットすれば、チーム全員が次回のプルで同じポリシーを受け取ります。

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

各ポリシーで使用できる 3 種類の判定:

| 判定 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [ポリシーを書く](https://docs.befailproof.ai/policies/editor)

---

## オブザーバビリティ

制御は機能の半分に過ぎません。もう半分は、エージェントが実際に何をしたかを把握することです。

引数なしで `failproofai` を実行すると、マシン上にすである実行履歴を読み込んで `localhost:8020` でダッシュボードを提供します — アカウント不要、サインアップ不要、データがマシンの外に出ることもありません。セッション一覧、モデル呼び出しのシーケンス、各実行内のツール呼び出しとフックの判定、ブロックされた内容とポリシーがエージェントに伝えた内容、そしてオフライン監査（`failproofai audit`）として履歴をスキャンしてリスクのあるパターンを検出し、対処するポリシーを提案します。

→ [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) ·
[トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ローカル監査](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** は同じデータモデルのホスト型サービスで、複数マシンでエージェントを運用するチーム向けです。すべてのハーネスからのすべての実行を一か所で管理、並列サブエージェントを個別レーンで表示する実行グラフ、モデル・ツール・フックの p50/p95/p99 レイテンシー、モデルごとのコストとコンテキストウィンドウのトラッキング、エラートラッキング、共有可能なダッシュボード付きの独自トレースへの SQL クエリ、独自サービスでスコアリングする評価機能、繰り返し発生する障害をエビデンスに基づく知見として記録するスケジュール監査、Slack・メール・署名付き Webhook へのアラート通知が利用できます。Enterprise プランでは独自クラスターへのセルフホスティングも対応しています。

→ [セッション](https://docs.befailproof.ai/sessions/overview) ·
[監査](https://docs.befailproof.ai/audits/overview) ·
[デモを予約する](https://befailproof.ai/get-a-demo)

---

## ドキュメント

| はじめに | |
|---|---|
| [クイックスタート](https://docs.befailproof.ai/start/quickstart) | インストール、ハーネスの接続、初回実行の確認 |
| [コンセプト](https://docs.befailproof.ai/start/concepts) | フックシステムの仕組み |
| [対応ハーネス](https://docs.befailproof.ai/reference/harnesses) | 12 種類すべてと各ハーネスで制御できること |

| 監視 | |
|---|---|
| [セッション](https://docs.befailproof.ai/sessions/overview) | 実行を追う：モデル、ツール、エラー、レイテンシー |
| [トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) | 実行グラフが示していること |
| [監査](https://docs.befailproof.ai/audits/overview) | 多くのセッションにまたがる障害パターンを見つける |
| [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`、アカウント不要 |

| 制御 | |
|---|---|
| [ポリシーパック](https://docs.befailproof.ai/policies/packs) | Failproof AI のポリシーとポリシーハブのパック |
| [ポリシーを書く](https://docs.befailproof.ai/policies/editor) | 監査結果から、またはコードで作成 |
| [設定](https://docs.befailproof.ai/policies/local-configuration) | 設定スコープ、マージルール、ポリシーパラメーター |

| 独自エージェントの計測 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ハーネスなしのエージェントから実行をレポートする |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` リファレンス |

---

## ライセンス

MIT に [Commons Clause](https://commonsclause.com/) を付加したライセンス — 社内利用および個人利用は無料。failproofai 自体の商業的な再販には別途契約が必要です。全文は [LICENSE](../../LICENSE) をご覧ください。

---

## コントリビューション

[CONTRIBUTING.md](../../CONTRIBUTING.md) をご覧ください。新しいポリシー、エッジケースの対応、翻訳はいずれも歓迎します。

> **開始前にビルドしてください。** 最初に `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自分自身に適用しており、フックは `failproofai` のインポートをコンパイル済みの `dist/` バンドルに対して解決します — ビルドなしでは `Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳細は [リポジトリ内の開発用フックを動かすにはビルドが必要](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) をご覧ください。

---

SF とベンガルールの [befailproof.ai](https://befailproof.ai) チームが ❤️ を込めて開発しています。
