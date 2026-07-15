> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | **🇻🇳 Tiếng Việt** | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Bản dịch:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Giải quyết lỗi runtime cho các agent code.
Kết nối với Claude Code và Codex. Bắt các vòng lặp, hành động nguy hiểm và rò rỉ bí mật
trước khi chúng gây hậu quả. Độ trễ bằng không. Chạy locally.**

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Agent CLI được hỗ trợ

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

> Cài đặt hook cho một hoặc bất kỳ tổ hợp nào: `failproofai policies --install --cli opencode pi` (hoặc `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Bỏ qua `--cli` để tự động phát hiện các CLI được cài đặt và nhắc.
>
> **Hermes** (hermes-agent, một gateway Slack/Telegram) được hỗ trợ cho cả **live-hook enforcement** (`--cli hermes` — một lần cài đặt chặn các lệnh gọi công cụ từ mọi nền tảng và subagent) và **audit** offline của các phiên gateway từ tệp `~/.hermes/state.db` duy nhất.
>
> **OpenClaw** (openclaw gateway, một assistant multi-channel tự lưu trữ) được hỗ trợ cho cả **live-hook enforcement** (`--cli openclaw`, user-scope) và **audit** offline của các phiên JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). Enforcement sử dụng **in-process plugin hooks** của OpenClaw (một `openclaw-plugin/` được gửi kèm mà async-spawns failproofai — các hook dựa trên tệp nội bộ của nó chỉ có thể quan sát và không thể chặn): `before_tool_call` chặn một công cụ, và `before_agent_finalize` là một cổng turn-end thực sự, vì vậy các built-in `require-*-before-stop` thực thi.
>
> **Factory Droid** (`droid`) được hỗ trợ cho cả **live-hook enforcement** (`--cli factory`, user + project scope) và **audit** offline của các phiên JSONL trên đĩa. droid chặn các lệnh gọi công cụ từ **exit code 2** của hook (không phải quyết định JSON) và chỉ tuân theo `{decision:"block"}` trên sự kiện `Stop` turn-end — failproofai tự động phát ra hình dạng phù hợp cho mỗi sự kiện.
>
> **Devin CLI** (`devin`, Cognition) được hỗ trợ cho cả **live-hook enforcement** (`--cli devin`, user + project scope) và **audit** offline của các phiên SQLite (`~/.local/share/devin/cli/sessions.db`). Devin là một **Claude-clone tinh khiết** — cùng tên sự kiện, cùng payload snake_case, cùng cấu hình trình bao (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — chặn qua JSON `{decision:"block"}` trên mọi sự kiện.
>
> **Antigravity CLI** (`agy`) được hỗ trợ cho cả **live-hook enforcement** (`--cli antigravity`, user + project scope) và **audit** offline của các phiên plain-JSONL (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity có hợp đồng **riêng** của nó (không phải Claude-clone): một schema `hooks.json` **named-hook** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), một payload stdin camelCase mà failproofai chuẩn hóa, và các hình dạng phản hồi của nó — `{decision:"deny"}` để chặn một công cụ, `{decision:"continue"}` để buộc một turn khác tại `Stop`, `{injectSteps}` để chèn một nhắc nhở trước khi mô hình chạy.
>
> **Goose** (codename goose, Block) được hỗ trợ cho cả **live-hook enforcement** (`--cli goose`, user + project scope) và **audit** offline của các phiên SQLite (`~/.local/share/goose/sessions/sessions.db`). Enforcement sử dụng hệ thống **hooks** của Goose (spec **Open Plugins** cross-agent) — trình cài đặt chỉ cần thả một thư mục plugin tại `~/.agents/plugins/failproofai/` và Goose tự động khám phá nó. Chặn là JSON `{"decision":"block"}` trên sự kiện `PreToolUse` (được kích hoạt cho shell tool và bên trong các subagent được ủy quyền), xác minh live so với goose v1.43.0; Goose không có sự kiện `Stop` turn-end, vì vậy các built-in `require-*-before-stop` không áp dụng (như với Hermes).

---

## Cài đặt

```sh
npm install -g failproofai
failproofai policies --install   # hoặc chỉ chạy `failproofai` và chấp nhận nhắc first-run
failproofai
```

30 chính sách built-in kích hoạt ngay lập tức. Dashboard tại `localhost:8020`. Vô hiệu hóa nhắc first-run bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-push-master` | Đẩy trực tiếp tới `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases trên `main` / `master` |
| `block-rm-rf` | Xóa tệp đệ quy |
| `sanitize-api-keys` | Các khóa API rò rỉ vào bối cảnh agent |

→ [Tất cả 30 chính sách built-in](https://docs.befailproof.ai/built-in-policies)

---

## Các chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tự động tải, không cần cờ.
Commit nó và toàn bộ nhóm sẽ có nó trên pull tiếp theo.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Ghi vào các đường dẫn production bị chặn.");
    return allow();
  },
});
```

Ba quyết định có sẵn cho mọi chính sách:

| Quyết định | Hiệu ứng |
|---|---|
| `allow()` | Cho phép hoạt động |
| `deny(message)` | Chặn nó — tin nhắn quay lại agent |
| `instruct(message)` | Cho phép nó qua, nhưng thêm bối cảnh vào nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies)

---

## Khả năng hiển thị phiên

Mọi lệnh gọi công cụ mà agent của bạn thực hiện đều được ghi lại cục bộ. Dashboard hiển thị những gì chạy,
những gì bị chặn, và những gì chính sách đã nói với agent — vì vậy bạn không phải đoán
khi có gì đó sai. → [Hướng dẫn Dashboard](https://docs.befailproof.ai/dashboard)

---

## Tài liệu

| | |
|---|---|
| [Bắt đầu](https://docs.befailproof.ai/getting-started) | Cài đặt và các bước đầu tiên |
| [Chính sách Built-in](https://docs.befailproof.ai/built-in-policies) | Tất cả 30 chính sách với các tham số |
| [Chính sách Tùy chỉnh](https://docs.befailproof.ai/custom-policies) | Viết của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/configuration) | Phạm vi cấu hình và quy tắc hợp nhất |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Theo dõi phiên và hoạt động chính sách |
| [Kiến trúc](https://docs.befailproof.ai/architecture) | Cách hệ thống hook hoạt động |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho sử dụng nội bộ và cá nhân; bán lại thương mại của failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](./LICENSE) để biết toàn bộ nội dung.

---

## Đóng góp

Xem [CONTRIBUTING.md](./CONTRIBUTING.md). Các chính sách mới, trường hợp biên và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước. Kho này chạy
> các hook của failproofai trên chính nó, và chúng giải quyết nhập `failproofai` so với
> bundle `dist/` đã biên dịch — mà không cần xây dựng bạn sẽ gặp các lỗi hook `Cannot find package 'failproofai'`
> . Xây dựng lại sau khi thay đổi `src/`. Xem
> [Xây dựng trước khi các hook dev in-repo sẽ hoạt động](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng bởi [Nivedit Jain](https://github.com/NiveditJain) và [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
