> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | **🇻🇳 Tiếng Việt** | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Bản dịch:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Giải quyết lỗi thời gian chạy cho các agent mã hóa.**
Kết nối với Claude Code và Codex. Bắt các vòng lặp, hành động nguy hiểm và rò rỉ bí mật
trước khi chúng trở thành sự cố. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Agent CLI được hỗ trợ

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

> Cài đặt hooks cho một hoặc nhiều kết hợp: `failproofai policies --install --cli opencode pi` (hoặc `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Bỏ qua `--cli` để tự động phát hiện các CLI đã cài đặt và nhắc.
>
> **Hermes** (hermes-agent, một cổng Slack/Telegram) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli hermes` — một bản cài đặt chặn các lệnh công cụ từ mọi nền tảng và agent con) và **kiểm toán** ngoại tuyến của các phiên cổng từ `~/.hermes/state.db` duy nhất.
>
> **OpenClaw** (cổng openclaw, trợ lý tự lưu trữ đa kênh) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli openclaw`, phạm vi người dùng) và **kiểm toán** ngoại tuyến của các phiên JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). Thực thi sử dụng **hook plugin trong quá trình** của OpenClaw (một `openclaw-plugin/` được gửi kèm mà tạo failproofai không đồng bộ — các hook nội bộ dựa trên tệp của nó chỉ có thể quan sát và không thể chặn): `before_tool_call` chặn một công cụ, và `before_agent_finalize` là cổng kết thúc lượt thực sự, vì vậy các builtins `require-*-before-stop` thực thi.
>
> **Factory Droid** (`droid`) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli factory`, phạm vi người dùng + dự án) và **kiểm toán** ngoại tuyến của các phiên JSONL trên đĩa. droid chặn các lệnh công cụ tắt hook **mã thoát 2** (không phải quyết định JSON) và chỉ tôn trọng `{decision:"block"}` trên sự kiện kết thúc lượt `Stop` — failproofai tự động phát ra hình dạng đúng cho mỗi sự kiện.
>
> **Devin CLI** (`devin`, Cognition) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli devin`, phạm vi người dùng + dự án) và **kiểm toán** ngoại tuyến của các phiên SQLite (`~/.local/share/devin/cli/sessions.db`). Devin là một **Claude-clone thuần túy** — các tên sự kiện giống nhau, payload snake_case giống nhau, cấu hình bao bọc `hooks` giống nhau (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — chặn qua JSON `{decision:"block"}` trên mọi sự kiện.
>
> **Antigravity CLI** (`agy`) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli antigravity`, phạm vi người dùng + dự án) và **kiểm toán** ngoại tuyến của các phiên JSONL thuần (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity có **hợp đồng riêng của nó** (không phải Claude-clone): một lược đồ `hooks.json` **hook được đặt tên** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), payload stdin camelCase mà failproofai chuẩn hóa, và hình dạng phản hồi riêng của nó — `{decision:"deny"}` để chặn một công cụ, `{decision:"continue"}` để buộc một lượt khác ở `Stop`, `{injectSteps}` để tiêm nhắc nhở trước khi mô hình chạy.
>
> **Goose** (codename goose, Block) được hỗ trợ cho cả **thực thi hook trực tiếp** (`--cli goose`, phạm vi người dùng + dự án) và **kiểm toán** ngoại tuyến của các phiên SQLite (`~/.local/share/goose/sessions/sessions.db`). Thực thi sử dụng hệ thống **hooks** của Goose (lệnh **Open Plugins** đa agent) — trình cài đặt chỉ cần thả thư mục plugin tại `~/.agents/plugins/failproofai/` và Goose sẽ tự động khám phá nó. Chặn là JSON `{"decision":"block"}` trên sự kiện `PreToolUse` (kích hoạt cho công cụ shell và bên trong các agent con được ủy thác), xác minh trực tiếp trên goose v1.43.0; Goose không có sự kiện kết thúc lượt `Stop`, vì vậy các builtins `require-*-before-stop` không áp dụng (như Hermes).

---

## Cài đặt

```sh
npm install -g failproofai
failproofai policies --install   # hoặc chạy `failproofai` và chấp nhận lời nhắc lần đầu
failproofai
```

30 chính sách tích hợp sẽ kích hoạt ngay lập tức. Bảng điều khiển tại `localhost:8020`. Tắt lời nhắc lần đầu với `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-push-master` | Đẩy trực tiếp tới `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases trên `main` / `master` |
| `block-rm-rf` | Xóa tệp đệ quy |
| `sanitize-api-keys` | Khóa API rò rỉ vào ngữ cảnh agent |

→ [Tất cả 30 chính sách tích hợp](https://docs.befailproof.ai/built-in-policies)

---

## Chính sách của riêng bạn

Thả tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ nào.
Commit nó và toàn bộ nhóm sẽ có được nó trên lần pull tiếp theo.

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

Ba quyết định có sẵn cho mọi chính sách:

| Quyết định | Hiệu ứng |
|---|---|
| `allow()` | Cho phép hoạt động |
| `deny(message)` | Chặn nó — thông báo trở về agent |
| `instruct(message)` | Cho phép nó, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies)

---

## Khả năng hiển thị phiên

Mọi lệnh công cụ mà agent của bạn thực hiện đều được ghi lại cục bộ. Bảng điều khiển hiển thị những gì đã chạy,
những gì đã bị chặn và những gì chính sách cho agent biết — vì vậy bạn không phải đoán
khi có điều gì đó trục trặc. → [Hướng dẫn bảng điều khiển](https://docs.befailproof.ai/dashboard)

---

## Tài liệu

| | |
|---|---|
| [Bắt đầu](https://docs.befailproof.ai/getting-started) | Cài đặt và các bước đầu tiên |
| [Chính sách tích hợp](https://docs.befailproof.ai/built-in-policies) | Tất cả 30 chính sách với tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies) | Viết của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/configuration) | Phạm vi cấu hình và quy tắc hợp nhất |
| [Bảng điều khiển](https://docs.befailproof.ai/dashboard) | Giám sát phiên và hoạt động chính sách |
| [Kiến trúc](https://docs.befailproof.ai/architecture) | Cách hệ thống hook hoạt động |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho mục đích nội bộ và cá nhân; bán lại thương mại failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](./LICENSE) để biết toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](./CONTRIBUTING.md). Các chính sách mới, trường hợp cạnh, và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước tiên. Kho lưu trữ này chạy
> các hook của failproofai trên chính nó, và chúng giải quyết nhập `failproofai` so với
> gói được biên dịch `dist/` — không có bản dựng bạn sẽ gặp lỗi `Cannot find package 'failproofai'`
> hook. Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng bởi [Nivedit Jain](https://github.com/NiveditJain) và [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
