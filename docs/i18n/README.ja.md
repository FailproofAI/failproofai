> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | **🇯🇵 日本語** | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**翻訳**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

AIエージェントを信頼性高く、タスクに集中させ、自律的に動作させ続けるためのポリシー管理ツール。**Claude Code**、**OpenAI Codex**、**GitHub Copilot CLI** _(ベータ)_、**Cursor Agent** _(ベータ)_、**OpenCode** _(ベータ)_、**Pi** _(ベータ)_、**Gemini CLI** _(ベータ)_、そして **Agents SDK** に対応しています。

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

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

> 1つまたは複数の組み合わせでフックをインストールできます: `failproofai policies --install --cli opencode pi gemini`（または `--cli claude codex copilot cursor opencode pi gemini`）。`--cli` を省略すると、インストール済みの CLI を自動検出してプロンプトを表示します。**GitHub Copilot CLI、Cursor Agent、OpenCode、Pi、Gemini CLI のサポートはベータ版であり、テストを継続中です。**

- **39種類の組み込みポリシー** - よくあるエージェントの障害パターンをすぐに検出。破壊的なコマンドのブロック、シークレット漏洩の防止、エージェントのプロジェクト境界内への制限、ループ検出など。
- **カスタムポリシー** - JavaScript で独自の信頼性ルールを記述。`allow`/`deny`/`instruct` API を使って規約の強制、ドリフトの防止、操作のゲート制御、外部システムとの連携が可能。
- **シンプルな設定** - コードを書かずにポリシーを細かく調整。プロジェクト単位またはグローバルで許可リスト、保護ブランチ、しきい値を設定。3スコープの設定が自動的にマージされます。
- **エージェントモニター** - 不在中にエージェントが何をしたかを確認。セッションを閲覧し、すべてのツール呼び出しを検査して、ポリシーが発動した箇所を正確にレビュー。

すべてローカルで動作し、データがマシン外に出ることはありません。

---

## 必要条件

- Node.js >= 20.9.0
- Bun >= 1.3.0（オプション - 開発時またはソースからのビルドにのみ必要）

---

## インストール

```bash
npm install -g failproofai
# または
bun add -g failproofai
```

---

## クイックスタート

### 1. ポリシーをグローバルに有効化

```bash
failproofai policies --install
```

`~/.claude/settings.json` にフックエントリを書き込みます。これにより Claude Code は各ツール呼び出しの前後に failproofai を実行するようになります。

### 2. ダッシュボードを起動

```bash
failproofai
```

`http://localhost:8020` を開き、セッションの閲覧、ログの検査、ポリシーの管理が行えます。

### 3. 有効なポリシーを確認

```bash
failproofai policies
```

---

## ポリシーのインストール

### スコープ

| スコープ | コマンド | 書き込み先 |
|---------|---------|-----------|
| グローバル（デフォルト） | `failproofai policies --install` | `~/.claude/settings.json` |
| プロジェクト | `failproofai policies --install --scope project` | `.claude/settings.json` |
| ローカル | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### 特定のポリシーをインストール

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### ポリシーを削除

```bash
failproofai policies --uninstall
# または特定のスコープを指定する場合:
failproofai policies --uninstall --scope project
```

---

## 設定

ポリシー設定は `~/.failproofai/policies-config.json`（グローバル）またはプロジェクト内の `.failproofai/policies-config.json`（プロジェクト単位）に保存されます。

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "Use apt-get directly without sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Try creating a fresh branch instead."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**3つの設定スコープ**は自動的にマージされます（プロジェクト → ローカル → グローバル）。マージルールの詳細は [docs/configuration.mdx](docs/configuration.mdx) を参照してください。

---

## 組み込みポリシー

| ポリシー | 説明 | 設定可能なパラメータ |
|---------|------|:-----------:|
| `block-sudo` | エージェントが特権システムコマンドを実行するのを防止 | `allowPatterns` |
| `block-rm-rf` | 再帰的なファイル削除の誤操作を防止 | `allowPaths` |
| `block-curl-pipe-sh` | エージェントが信頼されていないスクリプトをシェルにパイプするのを防止 | |
| `block-failproofai-commands` | 自己アンインストールを防止 | |
| `sanitize-jwt` | JWT トークンがエージェントのコンテキストに漏洩するのを防止 | |
| `sanitize-api-keys` | API キーがエージェントのコンテキストに漏洩するのを防止 | `additionalPatterns` |
| `sanitize-connection-strings` | データベース認証情報がエージェントのコンテキストに漏洩するのを防止 | |
| `sanitize-private-key-content` | 出力から PEM 秘密鍵ブロックを削除 | |
| `sanitize-bearer-tokens` | 出力から Authorization Bearer トークンを削除 | |
| `block-env-files` | エージェントが .env ファイルを読み取るのを防止 | |
| `protect-env-vars` | エージェントが環境変数を出力するのを防止 | |
| `block-read-outside-cwd` | エージェントをプロジェクト境界内に制限 | `allowPaths` |
| `block-secrets-write` | 秘密鍵や証明書ファイルへの書き込みを防止 | `additionalPatterns` |
| `block-push-master` | main/master への誤ったプッシュを防止 | `protectedBranches` |
| `block-work-on-main` | エージェントが保護ブランチで作業するのを防止 | `protectedBranches` |
| `block-force-push` | `git push --force` を防止 | |
| `warn-git-amend` | コミット修正前にエージェントに警告 | |
| `warn-git-stash-drop` | スタッシュ削除前にエージェントに警告 | |
| `warn-all-files-staged` | `git add -A` の誤操作を検出 | |
| `warn-destructive-sql` | 実行前に DROP/DELETE SQL を検出 | |
| `warn-schema-alteration` | 実行前に ALTER TABLE を検出 | |
| `warn-large-file-write` | 予期せず大きなファイル書き込みを検出 | `thresholdKb` |
| `warn-package-publish` | 誤った `npm publish` を検出 | |
| `warn-background-process` | 意図しないバックグラウンドプロセスの起動を検出 | |
| `warn-global-package-install` | 意図しないグローバルパッケージのインストールを検出 | |
| …その他多数 | | |

ポリシーの詳細とパラメータリファレンス: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## カスタムポリシー

エージェントを信頼性高くタスクに集中させるための独自ポリシーを作成できます:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Block writes to paths containing 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Writes to production paths are blocked");
    return allow();
  },
});
```

以下のコマンドでインストール:

```bash
failproofai policies --install --custom ./my-policies.js
```

### 判定ヘルパー

| 関数 | 効果 |
|------|------|
| `allow()` | 操作を許可 |
| `allow(message)` | 操作を許可し、情報コンテキストを Claude に送信 |
| `deny(message)` | 操作をブロック。メッセージが Claude に表示される |
| `instruct(message)` | Claude のプロンプトにコンテキストを追加。ブロックしない |

### コンテキストオブジェクト (`ctx`)

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `eventType` | `string` | `"PreToolUse"`、`"PostToolUse"`、`"Notification"`、`"Stop"` |
| `toolName` | `string` | 呼び出されるツール（`"Bash"`、`"Write"`、`"Read"` など） |
| `toolInput` | `object` | ツールの入力パラメータ |
| `payload` | `object` | 生のイベントペイロード全体 |
| `session.cwd` | `string` | Claude Code セッションの作業ディレクトリ |
| `session.sessionId` | `string` | セッション識別子 |
| `session.transcriptPath` | `string` | セッションのトランスクリプトファイルへのパス |

カスタムフックはローカルインポートの推移的な解決、async/await、`process.env` へのアクセスをサポートしています。エラーはフェイルオープン方式で処理されます（`~/.failproofai/hook.log` にログが記録され、組み込みポリシーは継続して動作します）。詳細なガイドは [docs/custom-hooks.mdx](docs/custom-hooks.mdx) を参照してください。

### 規約ベースのポリシー

`.failproofai/policies/` ディレクトリに `*policies.{js,mjs,ts}` ファイルを置くだけで自動的に読み込まれます。フラグや設定変更は不要です。このディレクトリを git にコミットすれば、チームメンバー全員が同じ品質基準を自動的に共有できます。

```text
# プロジェクトレベル — git にコミットされ、チームで共有
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# ユーザーレベル — 個人設定、すべてのプロジェクトに適用
~/.failproofai/policies/my-policies.mjs
```

両方のレベルが読み込まれます（和集合）。ファイルは各ディレクトリ内でアルファベット順に読み込まれます。`01-`、`02-` などのプレフィックスを付けて読み込み順序を制御できます。チームが新たな障害パターンを発見したら、ポリシーを追加してプッシュするだけで、次回のプルで全員が更新を受け取れます。すぐに使えるサンプルは [examples/convention-policies/](examples/convention-policies/) を参照してください。

---

## テレメトリ

Failproof AI は、機能の利用状況を把握するために PostHog を通じて匿名の使用テレメトリを収集します。セッションの内容、ファイル名、ツールの入力、個人情報は一切送信されません。

無効にする方法:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## ドキュメント

| ガイド | 説明 |
|-------|------|
| [はじめに](docs/getting-started.mdx) | インストールと最初のステップ |
| [組み込みポリシー](docs/built-in-policies.mdx) | パラメータ付き39種類の組み込みポリシー |
| [カスタムポリシー](docs/custom-policies.mdx) | 独自ポリシーの作成方法 |
| [設定](docs/configuration.mdx) | 設定ファイルの形式とスコープのマージ |
| [ダッシュボード](docs/dashboard.mdx) | セッションの監視とポリシーアクティビティのレビュー |
| [アーキテクチャ](docs/architecture.mdx) | フックシステムの仕組み |
| [テスト](docs/testing.mdx) | テストの実行と新規テストの作成 |

### ドキュメントをローカルで実行

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

`http://localhost:3000` で Mintlify ドキュメントサイトが開きます。docs ディレクトリをマウントすると、コンテナは変更を監視します:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## failproofai コントリビューターへの注意事項

このリポジトリの `.claude/settings.json` では、標準の `npx -y failproofai` コマンドの代わりに `bun ./bin/failproofai.mjs --hook <EventType>` を使用しています。これは、failproofai プロジェクト自体の中で `npx -y failproofai` を実行すると自己参照の競合が発生するためです。

他のすべてのリポジトリでは、推奨されるアプローチは `npx -y failproofai` であり、以下のコマンドでインストールできます:

```bash
failproofai policies --install --scope project
```

## コントリビューション

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

---

## ライセンス

[LICENSE](LICENSE) を参照してください。

---

**ExosphereHost: Reliability Research Lab for Your Agents** によって構築・メンテナンスされています。私たちは、独自のエージェント、ソフトウェア、および専門知識を通じて、企業やスタートアップが AI エージェントの信頼性を向上させるのを支援しています。詳細は [exosphere.host](https://exosphere.host) をご覧ください。
