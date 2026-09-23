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

**Quan sát và thực thi cho mọi hệ thống agents của bạn.** Dù agents chạy ở đâu, chúng tôi đều nhìn thấy — và có thể từ chối. Failproof kết nối 12 hệ thống agent — các CLI viết code như Claude Code và Codex, các gateway chat như Hermes, các trợ lý tự lưu trữ như OpenClaw — ghi lại mọi lần chạy và chặn các lệnh gọi công cụ nguy hiểm trước khi chúng được thực thi. 43 chính sách tích hợp sẵn. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Hệ thống được hỗ trợ

Mười hai hệ thống trong hai loại — mười CLI viết code và hai gateway chat và trợ lý (Hermes, OpenClaw). Một API chính sách và lịch sử phiên chung trên tất cả chúng. Những gì một chính sách có thể *chặn* là tùy từng hệ thống: dừng lệnh gọi công cụ trước khi chạy được xác minh trên tất cả mười hai, cổng cuối lượt trên tám. [Ma trận tùy từng hệ thống](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) liệt kê các sự kiện mà mỗi hệ thống hỗ trợ.

Các agents chạy trong không có hệ thống nào báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents), cung cấp tracing, phiên và kiểm tra. Thực thi ở đó cần một hook trong runtime của bạn — [liên hệ với chúng tôi](mailto:support@befailproof.ai) và chúng tôi sẽ ánh xạ nó.

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
failproofai config                             # kết nối agents và daemon của bạn
failproofai policies add FailproofAI/policies  # chọn những gì cần thực thi
failproofai                                    # bảng điều khiển trên localhost:8020
```

Thiết lập kết nối các hooks và chọn **không** chính sách — lệnh thứ hai là những gì đặt hàng rào bảo vệ trên máy, và bất kỳ gói nào cũng có cùng kiểu (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` đọc một lần đầu). Chạy `failproofai config` mà không có terminal — CI, một container, một agent điều khiển nó — và nó áp dụng thay vì hỏi. Trên máy chưa bao giờ được thiết lập, bất kỳ lệnh nào khác sẽ chạy cùng một trình hướng dẫn trước; vô hiệu hóa điều đó bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

Cho đến khi gói tới, điều duy nhất thực thi là `block-failproofai-commands`, luôn bật và không thể tắt hoặc tạm dừng: một agent có thể tạm dừng thực thi có thể tắt tất cả các chính sách khác.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-env-files` | Các đọc file `.env` và file bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại cùng một lệnh gọi |
| `block-sudo` | Nâng cao đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Thay đổi cơ sở hạ tầng trực tiếp chưa được xem xét |
| `block-rm-rf` | Xóa file đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, đẩy trực tiếp đến `main` |

Mỗi một cổng gọi *trước* khi nó chạy, vì vậy chúng giữ trên tất cả mười hai hệ thống. Bốn cái đầu tiên áp dụng cho bất kỳ agent nào có thể gọi một công cụ; ba cái cuối cùng là những điều yêu thích của nhà phát triển — CLI viết code là loại hệ thống chúng tôi bao phủ sâu nhất. Họ `sanitize-*` là riêng biệt: nó chạy sau khi một công cụ trả về, vì vậy nó báo cáo một bí mật trong kết quả công cụ thay vì giữ nó ra khỏi ngữ cảnh.

→ [Tất cả 43 chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/packs)

---

## Chính sách của riêng bạn

Thả một file vào `.failproofai/policies/` — nó tải tự động, không cần cờ. Commit và toàn bộ nhóm sẽ nhận được nó lần tiếp theo.

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
| `deny(message)` | Chặn nó — thông báo quay lại agent |
| `instruct(message)` | Cho nó qua, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Viết một chính sách](https://docs.befailproof.ai/policies/editor)

---

## Quan sát

Thực thi là một nửa. Nửa kia là xem agent thực sự làm gì.

Chạy `failproofai` mà không có đối số và nó phục vụ bảng điều khiển trên `localhost:8020` đọc lịch sử chạy đã có trên máy của bạn — không tài khoản, không đăng ký, không có gì rời khỏi hộp. Bạn nhận được danh sách phiên, chuỗi các lệnh gọi mô hình, lệnh gọi công cụ và quyết định hook bên trong mỗi lần chạy, những gì bị chặn và những gì chính sách nói với agent, và kiểm tra ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mẫu rủi ro và gợi ý chính sách để dừng chúng.

→ [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm tra cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng một mô hình dữ liệu, cho các nhóm chạy agents trên một bộ: mỗi lần chạy từ mọi hệ thống ở một nơi, biểu đồ thực thi với các sub-agents song song trên các đường riêng của họ, độ trễ p50/p95/p99 cho mô hình, công cụ và hooks, chi phí theo mô hình và theo dõi cửa sổ ngữ cảnh, theo dõi lỗi, SQL trên traces của riêng bạn với bảng điều khiển có thể chia sẻ, các đánh giá được tính điểm bởi dịch vụ của bạn, kiểm tra theo lịch trình biến các lỗi định kỳ thành phát hiện hỗ trợ bằng bằng chứng, và cảnh báo được định tuyến đến Slack, email hoặc webhook đã ký. Tự lưu trữ trong cụm của riêng bạn có sẵn trong kế hoạch Enterprise.

→ [Phiên](https://docs.befailproof.ai/sessions/overview) ·
[Kiểm tra](https://docs.befailproof.ai/audits/overview) ·
[Đặt lịch demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Hướng dẫn bắt đầu nhanh](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối một hệ thống, xem lần chạy đầu tiên |
| [Các khái niệm](https://docs.befailproof.ai/start/concepts) | Cách hệ thống hook hoạt động |
| [Hệ thống được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12, và những gì mỗi cái có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Biểu đồ thực thi đang nói với bạn điều gì |
| [Kiểm tra](https://docs.befailproof.ai/audits/overview) | Tìm mẫu lỗi trên nhiều phiên |
| [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Gói chính sách](https://docs.befailproof.ai/policies/packs) | Các chính sách Failproof AI và gói từ hub chính sách |
| [Viết một chính sách](https://docs.befailproof.ai/policies/editor) | Từ một kiểm tra hoặc trong code |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Phạm vi cấu hình, quy tắc hợp nhất và tham số chính sách |

| Công cụ agent của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo chạy từ một agent không có hệ thống |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham chiếu `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho sử dụng nội bộ và cá nhân; bán lại thương mại của failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](../../LICENSE) để biết toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, trường hợp đặc biệt và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước. Repo này chạy các hooks của failproofai trên chính nó, và chúng giải quyết import `failproofai` so với gói `dist/` được biên dịch — mà không có bản dựng bạn sẽ gặp các lỗi hook `Cannot find package 'failproofai'`. Xây dựng lại sau khi thay đổi `src/`. Xem [Xây dựng trước khi các dev hooks trong repo sẽ hoạt động](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) tại SF và Bengaluru.
