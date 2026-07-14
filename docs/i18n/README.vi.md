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

**Dịch:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Giải quyết sự cố runtime cho các agents lập trình.**
Kết nối với Claude Code và Codex. Bắt các vòng lặp, hành động nguy hiểm và rò rỉ bí mật
trước khi chúng trở thành sự cố. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Các CLI agent được hỗ trợ

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
  <a href="https://github.com/FailproofAI/failproofai/blob/main/docs/configuration.mdx" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
</p>

> Cài đặt hooks cho một hoặc bất kỳ tổ hợp nào: `failproofai policies --install --cli opencode pi` (hoặc `--cli claude codex copilot cursor opencode pi hermes`). Bỏ qua `--cli` để tự động phát hiện các CLI được cài đặt và nhắc lựa chọn.
>
> **Hermes** (hermes-agent, một gateway Slack/Telegram) được hỗ trợ cho cả **thực thi live-hook** (`--cli hermes` — một cài đặt chặn các lệnh gọi công cụ từ mọi nền tảng và subagent) và **kiểm toán** ngoại tuyến của các phiên gateway của nó từ `~/.hermes/state.db` duy nhất.

---

## Cài đặt

```sh
npm install -g failproofai
failproofai policies --install   # hoặc chỉ chạy `failproofai` và chấp nhận lời nhắc lần đầu
failproofai
```

30 chính sách tích hợp kích hoạt ngay lập tức. Bảng điều khiển tại `localhost:8020`. Tắt lời nhắc lần đầu với `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-push-master` | Đẩy trực tiếp đến `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases trên `main` / `master` |
| `block-rm-rf` | Xóa tệp đệ quy |
| `sanitize-api-keys` | Các khóa API rò rỉ vào ngữ cảnh agent |

→ [Tất cả 30 chính sách tích hợp](https://docs.befailproof.ai/built-in-policies)

---

## Các chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ nào.
Commit nó và toàn bộ nhóm sẽ nhận được nó trong pull tiếp theo.

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
| `deny(message)` | Chặn nó — thông báo quay lại agent |
| `instruct(message)` | Cho phép thực hiện, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies)

---

## Khả năng hiển thị phiên

Mọi lệnh gọi công cụ mà agent của bạn thực hiện đều được ghi nhật ký cục bộ. Bảng điều khiển hiển thị những gì đã chạy,
những gì bị chặn và những gì chính sách đã nói với agent — để bạn không phải đoán
khi có sự cố. → [Hướng dẫn bảng điều khiển](https://docs.befailproof.ai/dashboard)

---

## Tài liệu

| | |
|---|---|
| [Bắt đầu](https://docs.befailproof.ai/getting-started) | Cài đặt và các bước đầu tiên |
| [Chính sách tích hợp](https://docs.befailproof.ai/built-in-policies) | Tất cả 30 chính sách với các tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/custom-policies) | Viết chính sách của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/configuration) | Phạm vi cấu hình và quy tắc hợp nhất |
| [Bảng điều khiển](https://docs.befailproof.ai/dashboard) | Giám sát phiên và hoạt động chính sách |
| [Kiến trúc](https://docs.befailproof.ai/architecture) | Cách hệ thống hook hoạt động |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho việc sử dụng nội bộ và cá nhân; bán lại failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](./LICENSE) để biết toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](./CONTRIBUTING.md). Các chính sách mới, trường hợp đặc biệt và bản dịch đều được chào đón.

> **Xây dựng trước khi bắt đầu.** Chạy `bun install && bun run build` trước. Repository này chạy
> các hook riêng của failproofai trên chính nó, và chúng giải quyết nhập `failproofai` dựa trên
> gói `dist/` được biên dịch — nếu không có bản dựng, bạn sẽ gặp lỗi hook `Cannot find package 'failproofai'`.
> Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng bởi [Nivedit Jain](https://github.com/NiveditJain) và [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
