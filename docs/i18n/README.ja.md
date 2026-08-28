> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**翻訳:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**エージェントの行動を可視化し、既知の障害を繰り返させない。**
Failproof AI はエージェントが動くあらゆる環境で機能します。Claude Code や Codex などのコーディングツール、Hermes などのチャットゲートウェイ、OpenClaw などのセルフホスト型アシスタント、そして自分でインストゥルメントしたエージェントにも対応します。各実行を記録し、危険なツール呼び出しを実行前にブロックすることができます。

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 対応ハーネス

2つのクラスで12種類のハーネスをサポートしています。コーディングCLI 10種類と、Hermes・OpenClaw の2つのゲートウェイです。ポリシーAPIとセッション履歴は共通ですが、イベントのブロック可否はハーネスによって異なります。

いずれのハーネスでも動作しないエージェントは [Python SDK](https://docs.befailproof.ai/reference/custom-agents) を通じてレポートできます。トレーシング、セッション、監査機能を利用できます。そちらでのポリシー適用にはご自身のランタイムへのフック実装が必要です。詳しくは[お問い合わせください](mailto:support@befailproof.ai)。

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

対応エージェントに Failproof AI スキルを付与すると、セットアップの案内、マシンの検査、ポリシー・監査・セッション・クラウド作業の適切なルーティングをエージェントが行えるようになります。

```sh
npx skills add FailproofAI/skills
```

これにより傘型スキルとその専門サブスキルがインストールされます。傘型スキルのみをインストールする場合は `--skill failproofai` を追加してください。スキルは操作手順を提供するものです。製品本体のインストールと設定は以下で行います。

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

セットアップは対応エージェントへの接続とバックグラウンドサービスのインストールを行います。ポリシーパックは選択されません。追加するまでは、エージェントが Failproof AI を無効化しないようにする `block-failproofai-commands` のみが動作します。

プロンプトなしでクラウドに接続するには `failproofai config --token <machine-key>` を使用してください。共有マシンやCI環境では、コマンド履歴にキーが残らないよう `FAILPROOFAI_CLOUD_TOKEN` を設定した上で `failproofai config` を実行してください。

---

## ブロック対象のリスク

| ポリシー | ブロック対象 |
|---|---|
| `sanitize-api-keys` | エージェントのコンテキストへのAPIキー漏洩 |
| `block-env-files` | `.env` やその他のシークレットファイルの読み取り |
| `warn-repeated-tool-calls` | エージェントが同じ呼び出しをループする動作 |
| `block-sudo` | 権限昇格 |
| `warn-destructive-sql` | `DROP`、`TRUNCATE`、条件なし `DELETE` |
| `block-terraform` / `block-kubectl` | 本番インフラへのレビューなし変更 |
| `block-rm-rf` | 再帰的なファイル削除 |
| `block-force-push` / `block-push-master` | `git push --force`、`main` への直接プッシュ |

これらのポリシーはファイル、認証情報、インフラ、データベース、エージェントワークフローを保護します。ポリシー適用の詳細なサポート範囲はハーネスとイベントによって異なります。

→ [組み込みポリシー全39件](https://docs.befailproof.ai/policies/builtin)

---

## カスタムポリシー

`.failproofai/policies/` にファイルをドロップするだけで自動的に読み込まれます。フラグは不要です。コミットすれば、次回プル時にチーム全員に適用されます。

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

各ポリシーで使用できる3つの判定：

| 判定 | 効果 |
|---|---|
| `allow()` | 操作を許可する |
| `deny(message)` | ブロックする — メッセージがエージェントに返される |
| `instruct(message)` | 通過させるが、エージェントの次のプロンプトにコンテキストを追加する |

→ [カスタムポリシーガイド](https://docs.befailproof.ai/policies/custom)

---

## ポリシーパック

ポリシーパックは、公開GitHubリポジトリから公開されるバージョン管理されたポリシーのセットです。インストール前に内容を確認できます。

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

スラッシュを含むものはパックソース、含まないものはポリシー名として扱われます。特定のカテゴリやポリシーを選択してインストールしたり、必要に応じてリリースをピン留めしたりすることもできます。

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

公開済みパックは [Policy Hub](https://befailproof.ai/policy-hub/) で閲覧できます。また、`failproofai publish --init` を実行して独自パックを作成することもできます。オブザーブモードでは、実際にブロックせずにパックが行うであろう動作を記録できます。`failproofai publish --effect observe` で有効化できます。

→ [ポリシーパック](https://docs.befailproof.ai/policies/packs) ·
[パックを公開する](https://docs.befailproof.ai/policies/publish-a-pack)

---

## オブザーバビリティ

ポリシー適用は機能の半分です。もう半分は、エージェントが実際に何をしたかを把握することです。

引数なしで `failproofai` を実行すると、マシン上の実行履歴を読み込んで `localhost:8020` でダッシュボードを起動します。アカウント不要、サインアップ不要、データは外部に送信されません。セッション一覧、各実行内のモデル呼び出し・ツール呼び出し・フック判定のシーケンス、ブロックされた内容やポリシーがエージェントに伝えた内容、そしてオフライン監査（`failproofai audit`）で履歴内のリスクパターンをスキャンして対処するポリシーを提案する機能が利用できます。

→ [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) ·
[トレースの読み方](https://docs.befailproof.ai/sessions/read-a-trace) ·
[ローカル監査](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** は同じデータモデルのホスト型サービスで、フリートでエージェントを運用するチーム向けです。すべてのハーネスからのすべての実行を一か所で確認でき、並列サブエージェントを独立したレーンで表示する実行グラフ、モデル・ツール・フックのp50/p95/p99レイテンシ、モデルごとのコストとコンテキストウィンドウの追跡、エラー追跡、共有可能なダッシュボード付きのトレースへのSQLクエリ、独自サービスによるスコアリングの評価、定期的な障害を根拠付きの知見に変換するスケジュール監査、Slack・メール・署名付きWebhookへのアラート配信などの機能を備えています。Enterpriseプランではご自身のクラスタへのセルフホスティングも可能です。

→ [セッション](https://docs.befailproof.ai/sessions/overview) ·
[監査](https://docs.befailproof.ai/audits/overview) ·
[デモを予約する](https://befailproof.ai/get-a-demo)

---

## ドキュメント

| はじめに | |
|---|---|
| [クイックスタート](https://docs.befailproof.ai/start/quickstart) | インストール、ハーネスの接続、最初の実行を確認 |
| [コンセプト](https://docs.befailproof.ai/start/concepts) | フックシステムの仕組み |
| [対応ハーネス](https://docs.befailproof.ai/reference/harnesses) | 全12種類と各ハーネスが適用できる内容 |

| 観察 | |
|---|---|
| [セッション](https://docs.befailproof.ai/sessions/overview) | 実行を追跡する：モデル、ツール、エラー、レイテンシ |
| [トレースの読み方](https://docs.befailproof.ai/sessions/read-a-trace) | 実行グラフが示す情報 |
| [監査](https://docs.befailproof.ai/audits/overview) | 多数のセッションにわたる障害パターンを発見する |
| [ローカルダッシュボード](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`、アカウント不要 |

| 適用 | |
|---|---|
| [組み込みポリシー](https://docs.befailproof.ai/policies/builtin) | パラメータ付き全39ポリシー |
| [カスタムポリシー](https://docs.befailproof.ai/policies/custom) | 独自ポリシーを作成する |
| [設定](https://docs.befailproof.ai/policies/local-configuration) | 設定スコープとマージルール |

| 独自エージェントのインストゥルメント | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | ハーネスのないエージェントから実行をレポートする |
| [ポリシーSDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` リファレンス |

---

## ライセンス

MIT と [Commons Clause](https://commonsclause.com/) の組み合わせ — 社内利用および個人利用は無料です。failproofai 自体の商業的再販には別途契約が必要です。全文は [LICENSE](../../LICENSE) をご参照ください。

---

## コントリビューション

[CONTRIBUTING.md](../../CONTRIBUTING.md) をご覧ください。新しいポリシー、エッジケース、翻訳はいずれも歓迎します。

> **開始前にビルドしてください。** まず `bun install && bun run build` を実行してください。このリポジトリは failproofai 自身のフックを自分自身に対して実行しており、`failproofai` のインポートをコンパイル済みの `dist/` バンドルに対して解決します。ビルドなしでは `Cannot find package 'failproofai'` というフックエラーが発生します。`src/` を変更した後は再ビルドしてください。詳しくは [リポジトリ内の開発フックを動かすための事前ビルド](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) をご参照ください。

---

❤️ を込めて、サンフランシスコとベンガルールの [befailproof.ai](https://befailproof.ai) チームが開発しています。
