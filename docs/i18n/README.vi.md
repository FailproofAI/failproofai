> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | **🇻🇳 Tiếng Việt** | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Bản dịch:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Quan sát và thực thi mọi công cụ chạy trên agents của bạn.**
Bất cứ nơi nào agents chạy, chúng tôi đều thấy được — và chúng tôi có thể từ chối. Failproof kết nối với 12 công cụ agent
— các CLI lập trình như Claude Code và Codex, các cổng chat như Hermes,
các trợ lý tự lưu trữ như OpenClaw — ghi lại mọi lần chạy và chặn các lệnh gọi công cụ
nguy hiểm trước khi chúng thực thi. 40 chính sách được tích hợp sẵn. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI hoạt động" width="800" />
</p>

---

## Các công cụ được hỗ trợ

Mười hai công cụ trong hai lớp — mười CLI lập trình, và hai cổng chat và trợ lý
(Hermes, OpenClaw). Cùng các sự kiện, cùng chính sách, cùng lịch sử phiên làm việc,
bất kể công cụ nào mà agent chạy trên đó.

Các agents chạy trên không có công cụ nào báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
nó cung cấp cho bạn tracing, phiên làm việc và kiểm toán. Thực thi ở đó cần một hook trong
runtime của riêng bạn — [hãy liên hệ với chúng tôi](mailto:support@befailproof.ai) và chúng tôi sẽ ánh xạ nó.

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
failproofai policies --install   # hoặc chỉ chạy `failproofai` và chấp nhận lời nhắc lần đầu
failproofai
```

40 chính sách được tích hợp sẵn sẽ kích hoạt ngay lập tức. Bảng điều khiển tại `localhost:8020`. Vô hiệu hóa lời nhắc lần đầu bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `sanitize-api-keys` | Các khóa API rò rỉ vào ngữ cảnh của agent |
| `block-env-files` | Đọc các tệp `.env` và các tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại trên cùng một lệnh gọi |
| `block-sudo` | Nâng cao đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Các thay đổi không được xem xét đối với cơ sở hạ tầng trực tiếp |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, các lần đẩy trực tiếp đến `main` |

Năm chính sách đầu tiên áp dụng cho bất kỳ agent nào có thể gọi một công cụ. Ba chính sách cuối cùng là những yêu thích
của nhà phát triển — CLI lập trình là lớp công cụ mà chúng tôi bao phủ sâu nhất.

→ [Tất cả 40 chính sách được tích hợp sẵn](https://docs.befailproof.ai/policies/builtin)

---

## Chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó sẽ tải tự động, không cần bất kỳ cờ nào.
Commit nó và toàn bộ đội sẽ nhận được nó khi kéo xuống tiếp theo.

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

| Quyết định | Hiệu quả |
|---|---|
| `allow()` | Cho phép hoạt động |
| `deny(message)` | Chặn nó — tin nhắn quay lại agent |
| `instruct(message)` | Cho phép nó tiếp tục, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom)

---

## Khả năng quan sát

Thực thi là một nửa. Nửa còn lại là thấy được agent thực sự đã làm gì.

Chạy `failproofai` không có đối số và nó phục vụ một bảng điều khiển trên `localhost:8020`
đọc lịch sử chạy đã có trên máy của bạn — không có tài khoản, không có đăng ký, không có gì
rời khỏi hộp. Bạn nhận được danh sách phiên, trình tự các lệnh gọi mô hình, lệnh gọi công cụ
và quyết định hook bên trong mỗi lần chạy, những gì bị chặn và chính sách nói với agent, và một kiểm toán ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mẫu rủi ro
và gợi ý các chính sách để ngăn chặn chúng.

→ [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm toán cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía lưu trữ của cùng một mô hình dữ liệu, cho các đội
chạy agents trên một đội: mỗi lần chạy từ mỗi công cụ ở một nơi, biểu đồ thực thi
với các sub-agents song song trên các làn riêng của chúng, độ trễ p50/p95/p99
cho mô hình, công cụ và hook, chi phí cho mỗi mô hình và theo dõi cửa sổ ngữ cảnh, theo dõi lỗi, SQL
trên các trace của riêng bạn với bảng điều khiển có thể chia sẻ, các đánh giá được chấm bởi
dịch vụ của riêng bạn, các kiểm toán định kỳ biến các lỗi định kỳ thành những phát hiện được hỗ trợ bằng bằng chứng, và các cảnh báo
được định tuyến đến Slack, email hoặc webhook được ký. Tự lưu trữ trong cluster của riêng bạn
có sẵn trong gói Enterprise.

→ [Phiên làm việc](https://docs.befailproof.ai/sessions/overview) ·
[Kiểm toán](https://docs.befailproof.ai/audits/overview) ·
[Đặt lịch demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Hướng dẫn nhanh](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối một công cụ, xem lần chạy đầu tiên |
| [Khái niệm](https://docs.befailproof.ai/start/concepts) | Cách hệ thống hook hoạt động |
| [Các công cụ được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12, và những gì mỗi công cụ có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên làm việc](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Những gì biểu đồ thực thi đang cho bạn biết |
| [Kiểm toán](https://docs.befailproof.ai/audits/overview) | Tìm các mẫu lỗi trên nhiều phiên |
| [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Chính sách được tích hợp sẵn](https://docs.befailproof.ai/policies/builtin) | Tất cả 40 chính sách với các tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom) | Viết chính sách của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Phạm vi cấu hình và quy tắc hợp nhất |

| Thiết lập agents của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo các lần chạy từ một agent không có công cụ |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham khảo `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí để sử dụng nội bộ và cá nhân; bán lại failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](../../LICENSE) để biết toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, trường hợp cạnh và bản dịch đều được chào đón.

> **Build trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước. Repo này chạy
> các hook của failproofai trên chính nó, và chúng giải quyết import `failproofai` dựa trên
> bundled `dist/` được biên dịch — nếu không có build bạn sẽ gặp lỗi hook `Cannot find package 'failproofai'`.
> Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) tại SF và Bengaluru.
