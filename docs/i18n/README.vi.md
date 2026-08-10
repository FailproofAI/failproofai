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
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**Bản dịch:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Giải pháp xử lý sự cố thực thi cho các agent lập trình.**
Tích hợp với Claude Code và Codex. Phát hiện vòng lặp, hành động nguy hiểm và rò rỉ bí mật
trước khi chúng trở thành sự cố. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
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

## Cài đặt

```sh
npm install -g failproofai
failproofai policies --install   # hoặc chạy `failproofai` và chấp nhận lời nhắc lần đầu tiên
failproofai
```

30 chính sách tích hợp sẽ kích hoạt ngay lập tức. Bảng điều khiển tại `localhost:8020`. Vô hiệu hóa lời nhắc lần đầu tiên bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-push-master` | Đẩy trực tiếp đến `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Các commit, merge, rebase trên `main` / `master` |
| `block-rm-rf` | Xóa tệp đệ quy |
| `sanitize-api-keys` | API key rò rỉ vào ngữ cảnh agent |

→ [Tất cả 30 chính sách tích hợp](https://docs.befailproof.ai/built-in-policies)

---

## Chính sách riêng của bạn

Thả một tệp vào `.failproofai/policies/` — nó sẽ tải tự động, không cần cờ nào.
Commit nó và toàn bộ nhóm sẽ nhận được nó khi pull tiếp theo.

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

Ba quyết định có sẵn cho mỗi chính sách:

| Quyết định | Tác dụng |
|---|---|
| `allow()` | Cho phép thao tác |
| `deny(message)` | Chặn nó — tin nhắn được gửi lại cho agent |
| `instruct(message)` | Cho phép nó đi qua, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies)

---

## Khả năng hiển thị phiên

Mỗi lệnh gọi công cụ mà agent của bạn thực hiện đều được ghi nhật ký cục bộ. Bảng điều khiển hiển thị những gì đã chạy,
những gì bị chặn và những gì chính sách đã yêu cầu agent làm — vì vậy bạn không cần đoán
khi có sự cố. → [Hướng dẫn bảng điều khiển](https://docs.befailproof.ai/dashboard)

---

## Tài liệu

| | |
|---|---|
| [Getting Started](https://docs.befailproof.ai/getting-started) | Cài đặt và bước đầu tiên |
| [Built-in Policies](https://docs.befailproof.ai/built-in-policies) | Tất cả 30 chính sách với tham số |
| [Custom Policies](https://docs.befailproof.ai/custom-policies) | Viết chính sách của riêng bạn |
| [Configuration](https://docs.befailproof.ai/configuration) | Phạm vi cấu hình và quy tắc hợp nhất |
| [Dashboard](https://docs.befailproof.ai/dashboard) | Trình giám sát phiên và hoạt động chính sách |
| [Architecture](https://docs.befailproof.ai/architecture) | Cách hệ thống hook hoạt động |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho việc sử dụng nội bộ và cá nhân; bán lại failproofai yêu cầu một thỏa thuận riêng biệt. Xem [LICENSE](../../LICENSE) để xem toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Chính sách mới, trường hợp đặc biệt và bản dịch đều được hoan nghênh.

> **Build trước khi bắt đầu.** Chạy `bun install && bun run build` trước tiên. Repo này chạy
> các hook của failproofai trên chính nó, và chúng phân giải nhập `failproofai` theo
> gói `dist/` đã biên dịch — nếu không build, bạn sẽ gặp lỗi hook `Cannot find package 'failproofai'`.
> Rebuild sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng bởi [Nivedit Jain](https://github.com/NiveditJain) và [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
