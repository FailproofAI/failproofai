> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | **🇻🇳 Tiếng Việt** | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Bản dịch**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

Cách dễ nhất để quản lý các chính sách giữ cho các agent AI của bạn đáng tin cậy, tập trung vào nhiệm vụ và chạy tự động - cho **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ & **Agents SDK**.

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

## Các agent CLI được hỗ trợ

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

> Cài đặt hook cho một hoặc bất kỳ sự kết hợp nào: `failproofai policies --install --cli opencode pi gemini` (hoặc `--cli claude codex copilot cursor opencode pi gemini`). Bỏ qua `--cli` để tự động phát hiện các CLI đã cài đặt và nhắc nhở. **Hỗ trợ GitHub Copilot CLI, Cursor Agent, OpenCode, Pi và Gemini CLI đang ở phiên bản beta — việc kiểm tra đang diễn ra.**

- **39 Chính sách được tích hợp sẵn** - Bắt các chế độ lỗi agent thông thường ngay từ đầu. Chặn các lệnh phá hoại, ngăn chặn rò rỉ bí mật, giữ các agent trong ranh giới dự án, phát hiện vòng lặp, và nhiều hơn nữa.
- **Chính sách tùy chỉnh** - Viết các quy tắc độ tin cậy của riêng bạn bằng JavaScript. Sử dụng API `allow`/`deny`/`instruct` để thực thi các quy ước, ngăn chặn độ lệch, gated operations, hoặc tích hợp với các hệ thống bên ngoài.
- **Cấu hình dễ dàng** - Tinh chỉnh bất kỳ chính sách nào mà không cần viết mã. Đặt danh sách cho phép, nhánh được bảo vệ, ngưỡng cho mỗi dự án hoặc toàn cầu. Ba cấp độ cấu hình tự động hợp nhất.
- **Agent Monitor** - Xem những gì các agent của bạn đã làm khi bạn vắng mặt. Duyệt các phiên, kiểm tra mọi lệnh gọi công cụ, và xem xét chính xác nơi các chính sách được kích hoạt.

Mọi thứ chạy cục bộ - không có dữ liệu nào rời khỏi máy tính của bạn.

---

## Yêu cầu

- Node.js >= 20.9.0
- Bun >= 1.3.0 (tùy chọn - chỉ cần cho phát triển / xây dựng từ nguồn)

---

## Cài đặt

```bash
npm install -g failproofai
# or
bun add -g failproofai
```

---

## Bắt đầu nhanh

### 1. Kích hoạt chính sách toàn cầu

```bash
failproofai policies --install
```

Ghi các mục hook vào `~/.claude/settings.json`. Claude Code bây giờ sẽ gọi failproofai trước và sau mỗi lệnh gọi công cụ.

### 2. Khởi động bảng điều khiển

```bash
failproofai
```

Mở `http://localhost:8020` - duyệt qua các phiên, kiểm tra nhật ký, quản lý chính sách.

### 3. Kiểm tra những gì đang hoạt động

```bash
failproofai policies
```

---

## Cài đặt chính sách

### Phạm vi

| Phạm vi | Lệnh | Nơi ghi |
|--------|---------|-----------------|
| Toàn cầu (mặc định) | `failproofai policies --install` | `~/.claude/settings.json` |
| Dự án | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Cục bộ | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Cài đặt các chính sách cụ thể

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Xóa chính sách

```bash
failproofai policies --uninstall
# or for a specific scope:
failproofai policies --uninstall --scope project
```

---

## Cấu hình

Cấu hình chính sách nằm trong `~/.failproofai/policies-config.json` (toàn cầu) hoặc `.failproofai/policies-config.json` trong dự án của bạn (theo dự án).

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

**Ba phạm vi cấu hình** được tự động hợp nhất (dự án → cục bộ → toàn cầu). Xem [docs/configuration.mdx](docs/configuration.mdx) để biết các quy tắc hợp nhất đầy đủ.

---

## Chính sách được tích hợp sẵn

| Chính sách | Mô tả | Có thể cấu hình |
|--------|-------------|:---:|
| `block-sudo` | Ngăn chặn agent chạy các lệnh hệ thống có quyền cao | `allowPatterns` |
| `block-rm-rf` | Ngăn chặn xóa tệp đệ quy tình cờ | `allowPaths` |
| `block-curl-pipe-sh` | Ngăn chặn agent đưa các tập lệnh không đáng tin cậy vào shell | |
| `block-failproofai-commands` | Ngăn chặn tự gỡ cài đặt | |
| `sanitize-jwt` | Dừng các mã thông báo JWT khỏi rò rỉ vào bối cảnh agent | |
| `sanitize-api-keys` | Dừng các khóa API khỏi rò rỉ vào bối cảnh agent | `additionalPatterns` |
| `sanitize-connection-strings` | Dừng thông tin xác thực cơ sở dữ liệu khỏi rò rỉ vào bối cảnh agent | |
| `sanitize-private-key-content` | Che đậu các khối khóa riêng tư PEM khỏi đầu ra | |
| `sanitize-bearer-tokens` | Che đậu các mã thông báo Authorization Bearer khỏi đầu ra | |
| `block-env-files` | Giữ agent không đọc tệp .env | |
| `protect-env-vars` | Ngăn chặn agent in các biến môi trường | |
| `block-read-outside-cwd` | Giữ agent trong ranh giới dự án | `allowPaths` |
| `block-secrets-write` | Ngăn chặn ghi vào các tệp khóa riêng tư và chứng chỉ | `additionalPatterns` |
| `block-push-master` | Ngăn chặn đẩy tình cờ vào main/master | `protectedBranches` |
| `block-work-on-main` | Giữ agent ngoài các nhánh được bảo vệ | `protectedBranches` |
| `block-force-push` | Ngăn chặn `git push --force` | |
| `warn-git-amend` | Nhắc nhở agent trước khi sửa đổi commit | |
| `warn-git-stash-drop` | Nhắc nhở agent trước khi bỏ các stash | |
| `warn-all-files-staged` | Bắt `git add -A` tình cờ | |
| `warn-destructive-sql` | Bắt SQL DROP/DELETE trước khi thực thi | |
| `warn-schema-alteration` | Bắt ALTER TABLE trước khi thực thi | |
| `warn-large-file-write` | Bắt ghi tệp lớn bất ngờ | `thresholdKb` |
| `warn-package-publish` | Bắt `npm publish` tình cờ | |
| `warn-background-process` | Bắt khởi chạy quá trình nền không có ý định | |
| `warn-global-package-install` | Bắt cài đặt gói toàn cầu không có ý định | |
| …và nhiều hơn nữa | | |

Chi tiết chính sách đầy đủ và tham khảo tham số: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Chính sách tùy chỉnh

Viết các chính sách của riêng bạn để giữ cho agent đáng tin cậy và tập trung vào nhiệm vụ:

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

Cài đặt với:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Trợ giúp ra quyết định

| Hàm | Hiệu ứng |
|----------|--------|
| `allow()` | Cho phép thao tác |
| `allow(message)` | Cho phép và gửi bối cảnh thông tin tới Claude |
| `deny(message)` | Chặn thao tác; tin nhắn được hiển thị cho Claude |
| `instruct(message)` | Thêm bối cảnh vào lời nhắc của Claude; không chặn |

### Đối tượng ngữ cảnh (`ctx`)

| Trường | Loại | Mô tả |
|-------|------|-------------|
| `eventType` | `string` | `PreToolUse`, `PostToolUse`, `Notification`, `Stop` |
| `toolName` | `string` | Công cụ được gọi (`Bash`, `Write`, `Read`, …) |
| `toolInput` | `object` | Các tham số đầu vào của công cụ |
| `payload` | `object` | Toàn bộ payload sự kiện thô |
| `session.cwd` | `string` | Thư mục làm việc của phiên Claude Code |
| `session.sessionId` | `string` | Mã định danh phiên |
| `session.transcriptPath` | `string` | Đường dẫn tới tệp bản ghi phiên |

Các hook tùy chỉnh hỗ trợ nhập cục bộ có chuyển tiếp, async/await, và quyền truy cập vào `process.env`. Các lỗi được mở rộng để tiếp tục (được ghi vào `~/.failproofai/hook.log`, các chính sách được tích hợp sẵn tiếp tục). Xem [docs/custom-hooks.mdx](docs/custom-hooks.mdx) để biết hướng dẫn đầy đủ.

### Chính sách dựa trên quy ước

Thả các tệp `*policies.{js,mjs,ts}` vào `.failproofai/policies/` và chúng sẽ tự động được tải — không cần cờ hay thay đổi cấu hình. Commit thư mục vào git và mọi thành viên nhóm đều nhận được các tiêu chuẩn chất lượng tương tự một cách tự động.

```text
# Mức dự án — được commit vào git, được chia sẻ với nhóm
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Mức người dùng — cá nhân, áp dụng cho tất cả các dự án
~/.failproofai/policies/my-policies.mjs
```

Cả hai mức được tải (hợp nhất). Các tệp được tải theo thứ tự bảng chữ cái trong mỗi thư mục. Đặt tiền tố với `01-`, `02-`, v.v. để kiểm soát thứ tự. Khi nhóm của bạn phát hiện các chế độ lỗi mới, hãy thêm một chính sách và đẩy — mọi người sẽ nhận được bản cập nhật khi họ pull tiếp theo. Xem [examples/convention-policies/](examples/convention-policies/) để có các ví dụ sẵn sàng để sử dụng.

---

## Đo lường từ xa

Failproof AI thu thập dữ liệu đo lường sử dụng ẩn danh thông qua PostHog để hiểu việc sử dụng tính năng. Không bao giờ gửi nội dung phiên, tên tệp, đầu vào công cụ hoặc thông tin cá nhân.

Tắt nó:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Tài liệu

| Hướng dẫn | Mô tả |
|-------|-------------|
| [Getting Started](docs/getting-started.mdx) | Cài đặt và bước đầu tiên |
| [Built-in Policies](docs/built-in-policies.mdx) | Tất cả 39 chính sách được tích hợp sẵn với các tham số |
| [Custom Policies](docs/custom-policies.mdx) | Viết chính sách của riêng bạn |
| [Configuration](docs/configuration.mdx) | Định dạng tệp cấu hình và hợp nhất phạm vi |
| [Dashboard](docs/dashboard.mdx) | Giám sát các phiên và xem xét hoạt động chính sách |
| [Architecture](docs/architecture.mdx) | Cách hệ thống hook hoạt động |
| [Testing](docs/testing.mdx) | Chạy các bài kiểm tra và viết các bài kiểm tra mới |

### Chạy tài liệu cục bộ

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Mở trang web tài liệu Mintlify tại `http://localhost:3000`. Container sẽ theo dõi các thay đổi nếu bạn gắn thư mục tài liệu:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## Lưu ý dành cho những người đóng góp failproofai

`.claude/settings.json` của repo này sử dụng `bun ./bin/failproofai.mjs --hook <EventType>` thay vì lệnh `npx -y failproofai` tiêu chuẩn. Điều này là vì chạy `npx -y failproofai` trong bản thân dự án failproofai tạo ra một xung đột tự tham chiếu.

Đối với tất cả các repo khác, phương pháp được khuyến nghị là `npx -y failproofai`, được cài đặt thông qua:

```bash
failproofai policies --install --scope project
```

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Giấy phép

Xem [LICENSE](LICENSE).

---

Được xây dựng và duy trì bởi **ExosphereHost: Reliability Research Lab for Your Agents**. Chúng tôi giúp các doanh nghiệp và startup cải thiện độ tin cậy của các agent AI của họ thông qua các agent, phần mềm và chuyên môn của riêng chúng tôi. Tìm hiểu thêm tại [exosphere.host](https://exosphere.host).
