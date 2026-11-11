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

**あらゆるハーネスで動くエージェントのオブザーバビリティと制御。**
エージェントがどこで動いても、私たちには見えています — そして拒否することもできます。Failproof は 12 のエージェントハーネスにフックします。Claude Code や Codex のようなコーディング CLI、Hermes のようなチャットゲートウェイ、OpenClaw のようなセルフホスト型アシスタント — すべての実行をキャプチャし、危険なツール呼び出しを実行前にブロックします。組み込みポリシー 40 種類。レイテンシーゼロ。ローカル動作。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## サポートしているハーネス

12 のハーネスが 2 つのクラスに分かれています — コーディング CLI が 10 種類、チャット・アシスタントゲートウェイが 2 種類（Hermes、OpenClaw）です。ポリシー API とセッション履歴はすべてのハーネスで共通です。ポリシーで*ブロック*できる内容はハーネスごとに異なります。ツール呼び出しを実行前に停止する機能は全 12 で検証済みで、ターン終了時のゲートは 8 つで対応しています。[ハーネスごとのマトリクス](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)に各ハーネスが対応するイベントの一覧があります。

対応ハーネスのいずれでも動かないエージェントは [Python SDK](https://docs.befailproof.ai/reference/custom-agents) を通じてレポートできます。トレーシング、セッション、監査機能が利用できます。そこでの制御にはご自身のランタイムへのフックが必要です — [お問い合わせ](mailto:support@befailproof.ai)いただければ対応方法をご案内します。

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

セットアップはフックを接続しますが、ポリシーは**何も**適用しません — 2 番目のコマンドがマシンにガードレールを設置します。パックはすべて同じ形式で指定できます（`failproofai policies add <owner>/<repo>`；`policies show <owner>/<repo>` で内容を先に確認できます）。ターミナルなしで `failproofai config` を実行すると（CI、コンテナ、エージェントによる操作など）、対話形式ではなく自動的に適用されます。一度もセットアップされていないマシンでは、他のコマンドを実行するとまず同じウィザードが起動します。`FAILPROOFAI_NO_FIRST_RUN=1` でこの動作を無効にできます。

パックが導入されるまでの間、唯一適用されているのは `block-failproofai-commands` です。これは常時有効で、無効化や一時停止はできません。制御を一時停止できるエージェントは、他のすべてのポリシーも無効にできてしまうためです。

---

## ブロックできる内容

| ポリシー | ブロック対象 |
|---|---|
| `block-env-files` | `.env` およびその他のシークレットファイルの読み取り |
| `warn-repeated-tool-calls` | 同じ呼び出しをループするエージェント |
| `block-sudo` | 権限昇格 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、条件なしの `DELETE` |
| `block-terraform` / `block-kubectl` | レビューなしの本番インフラへの変更 |
| `block-rm-rf` | 再帰的なファイル削除 |
| `block-force-push` / `block-push-master` | `git push --force`、`main` への直接プッシュ |

これらはすべて呼び出しが実行される*前*にゲートするため、全 12 ハーネスで有効です。最初の 4 つはツールを呼び出せるあらゆるエージェントに適用されます。残りの 3 つは開発者に人気のポリシーで、コーディング CLI は最も手厚くカバーしているハーネスクラスです。`sanitize-*` ファミリーは別扱いで、ツールが返した後に実行されます。そのため、シークレットをコンテキストに含めないのではなく、ツールの出力にシークレットが含まれていることを報告します。

→ [組み込みポリシー全 40 種類](https://docs.befailproof.ai/policies/packs)

---

## 独自ポリシーの作成

`.failproofai/policies/` にファイルを置くだけで自動的に読み込まれます。フラグは不要です。コミットすれば、チーム全員が次回の pull 時に適用されます。

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

すべてのポリシーで使用できる 3 種類の判断:

| 判断 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [ポリシーを書く](https://docs.befailproof.ai/policies/editor)

---

## オブザーバビリティ

制御は機能の半分です。もう半分は、エージェントが実際に何をしたかを把握することです。

引数なしで `failproofai` を実行すると、マシン上にすである実行履歴を読み取り、`localhost:8020` でダッシュボードが起動します — アカウント不要、サインアップ不要、データは外部に送信されません。セッション一覧、モデル呼び出しのシーケンス、各実行内のツール呼び出しとフック判断、ブロックされた内容とポリシーがエージェントに伝えた内容、そして危険なパターンを履歴からスキャンして対策ポリシーを提案するオフライン監査（`failproofai audit`）が利用できます。

→ [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) ·
[トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ローカル監査](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** は同じデータモデルのホスト型サービスで、複数マシンにまたがってエージェントを運用するチーム向けです。あらゆるハーネスからのすべての実行を一か所で確認、並列サブエージェントを専用レーンで表示する実行グラフ、モデル・ツール・フックの p50/p95/p99 レイテンシー、モデルごとのコストとコンテキストウィンドウのトラッキング、エラートラッキング、共有可能なダッシュボード付きの独自トレース SQL クエリ、独自サービスによるスコアリング評価、繰り返す失敗をエビデンスに基づく知見に変えるスケジュール監査、Slack・メール・署名付き Webhook へのアラート送信などの機能が揃っています。自社クラスターへのセルフホスティングは Enterprise プランで利用できます。

→ [セッション](https://docs.befailproof.ai/sessions/overview) ·
[監査](https://docs.befailproof.ai/audits/overview) ·
[デモを予約する](https://befailproof.ai/get-a-demo)

---

## ドキュメント

| はじめに | |
|---|---|
| [クイックスタート](https://docs.befailproof.ai/start/quickstart) | インストール、ハーネスの接続、最初の実行を確認する |
| [概念](https://docs.befailproof.ai/start/concepts) | フックシステムの仕組み |
| [サポートしているハーネス](https://docs.befailproof.ai/reference/harnesses) | 全 12 種類と各ハーネスで適用できる内容 |

| 観測する | |
|---|---|
| [セッション](https://docs.befailproof.ai/sessions/overview) | 実行を追う：モデル、ツール、エラー、レイテンシー |
| [トレースを読む](https://docs.befailproof.ai/sessions/read-a-trace) | 実行グラフが示す内容 |
| [監査](https://docs.befailproof.ai/audits/overview) | 複数セッションにわたる失敗パターンを発見する |
| [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`、アカウント不要 |

| 制御する | |
|---|---|
| [ポリシーパック](https://docs.befailproof.ai/policies/packs) | Failproof AI のポリシーとポリシーハブのパック |
| [ポリシーを書く](https://docs.befailproof.ai/policies/editor) | 監査から、またはコードで |
| [設定](https://docs.befailproof.ai/policies/local-configuration) | 設定スコープ、マージルール、ポリシーパラメーター |

| 独自エージェントの計装 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ハーネスのないエージェントから実行をレポートする |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` リファレンス |

---

## ライセンス

[Commons Clause](https://commonsclause.com/) 付き MIT — 社内利用および個人利用は無料。failproofai 自体の商用再販には別途契約が必要です。全文は [LICENSE](../../LICENSE) をご覧ください。

---

## コントリビュート

[CONTRIBUTING.md](../../CONTRIBUTING.md) をご覧ください。新しいポリシー、エッジケース、翻訳はいずれも歓迎します。

---

SF とベンガルールで [befailproof.ai](https://befailproof.ai) が ❤️ を込めて開発しています。
