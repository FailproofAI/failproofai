> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | **🇻🇳 Tiếng Việt** | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Bản dịch:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Khả năng quan sát và thực thi cho mọi harness mà agents của bạn chạy.**
Dù agents chạy ở đâu, chúng tôi đều nhìn thấy — và chúng tôi có thể nói không. Failproof hooks vào 12 agent harness — các CLI mã hóa như Claude Code và Codex, các cổng chat như Hermes, các trợ lý tự lưu trữ như OpenClaw — nắm bắt mọi lần chạy và chặn các lệnh gọi công cụ nguy hiểm trước khi chúng thực thi. 40 chính sách tích hợp. Không có độ trễ. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Các harness được hỗ trợ

Mười hai harness trong hai lớp — mười CLI mã hóa, và hai cổng chat cũng như assistant (Hermes, OpenClaw). Một API chính sách và một lịch sử phiên trên tất cả chúng. Những gì mà một chính sách có thể *chặn* là dành riêng cho từng harness: dừng một lệnh gọi công cụ trước khi nó chạy được xác minh trên cả mười hai, cổng cuối lượt trên tám. [Ma trận dành riêng cho từng harness](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) liệt kê các sự kiện mà mỗi cái danh dự.

Các agents chạy trong không có chúng báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents), cung cấp cho bạn tracing, phiên và kiểm toán. Thực thi ở đó cần một hook trong runtime riêng của bạn — [hãy liên hệ với chúng tôi](mailto:support@befailproof.ai) và chúng tôi sẽ ánh xạ nó.

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
failproofai config                             # kết nối agents của bạn và daemon
failproofai policies add FailproofAI/policies  # chọn những gì cần thực thi
failproofai                                    # bảng điều khiển trên localhost:8020
```

Thiết lập dây các hooks và chọn **không** có chính sách — lệnh thứ hai là những gì đưa các ray chắn lên máy, và bất kỳ gói nào cũng được nhập kiểu tương tự
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` đọc một cái trước tiên). Chạy `failproofai config` mà không có terminal — CI, container, một agent điều khiển nó — và nó áp dụng thay vì hỏi. Trên máy chưa bao giờ được thiết lập, bất kỳ lệnh nào khác sẽ chạy cùng một trình hướng dẫn trước tiên; tắt nó bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

Cho đến khi một gói đến, điều duy nhất thực thi là `block-failproofai-commands`, luôn bật và không thể tắt hoặc tạm dừng: một agent có thể tạm dừng thực thi có thể tắt mọi chính sách khác.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `block-env-files` | Đọc tệp `.env` và các tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại cùng một lệnh gọi |
| `block-sudo` | Leo thang đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Các thay đổi chưa được xem xét đối với cơ sở hạ tầng trực tiếp |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, đẩy trực tiếp tới `main` |

Mỗi một cái cổng gọi *trước khi* nó chạy, vì vậy chúng giữ trên tất cả mười hai harness. Bốn cái đầu tiên áp dụng cho bất kỳ agent nào có thể gọi một công cụ; ba cái cuối cùng là những yêu thích của nhà phát triển — các CLI mã hóa là lớp harness mà chúng tôi bao phủ sâu nhất. Họ `sanitize-*` riêng biệt: nó chạy sau khi một công cụ trả lại, vì vậy nó báo cáo một bí mật trong đầu ra công cụ thay vì giữ nó ra khỏi bối cảnh.

→ [Tất cả 40 chính sách tích hợp](https://docs.befailproof.ai/policies/packs)

---

## Chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ. Commit nó và cả nhóm sẽ nhận được nó khi pull tiếp theo.

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
| `instruct(message)` | Để nó thông qua, nhưng thêm bối cảnh vào lời nhắc tiếp theo của agent |

→ [Viết một chính sách](https://docs.befailproof.ai/policies/editor)

---

## Khả năng quan sát

Thực thi là một nửa. Nửa kia là nhìn thấy những gì agent thực sự đã làm.

Chạy `failproofai` mà không có đối số và nó phục vụ một bảng điều khiển trên `localhost:8020` đọc lịch sử chạy đã có trên máy của bạn — không có tài khoản, không cần đăng ký, không có gì rời khỏi hộp. Bạn nhận được danh sách phiên, chuỗi lệnh gọi mô hình, lệnh gọi công cụ và quyết định hook bên trong mỗi lần chạy, những gì đã bị chặn và những gì chính sách đã nói với agent, và một kiểm toán ngoại tuyến (`failproofai audit`) quét lịch sử của bạn tìm kiếm các mẫu rủi ro và đề xuất chính sách để dừng chúng.

→ [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm toán cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng một mô hình dữ liệu, dành cho các nhóm chạy agents trên toàn bộ hệ thống: mọi lần chạy từ mọi harness ở một nơi, biểu đồ thực thi với các sub-agent song song trên các làn riêng của họ, độ trễ p50/p95/p99 cho các mô hình, công cụ và hooks, chi phí trên mỗi mô hình và theo dõi cửa sổ bối cảnh, theo dõi lỗi, SQL trên các traces riêng của bạn với các bảng điều khiển có thể chia sẻ, đánh giá được chấm điểm bởi dịch vụ riêng của bạn, kiểm toán được lên lịch biến các lỗi định kỳ thành các phát hiện dựa trên bằng chứng, và cảnh báo được định tuyến đến Slack, email hoặc một webhook được ký. Tự lưu trữ trong cluster riêng của bạn có sẵn trong gói Enterprise.

→ [Phiên](https://docs.befailproof.ai/sessions/overview) ·
[Kiểm toán](https://docs.befailproof.ai/audits/overview) ·
[Đặt lịch demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối một harness, xem lần chạy đầu tiên |
| [Khái niệm](https://docs.befailproof.ai/start/concepts) | Cách hệ thống hook hoạt động |
| [Các harness được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12, và những gì mỗi cái có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Biểu đồ thực thi đang nói gì với bạn |
| [Kiểm toán](https://docs.befailproof.ai/audits/overview) | Tìm các mẫu lỗi trên nhiều phiên |
| [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Gói chính sách](https://docs.befailproof.ai/policies/packs) | Các chính sách Failproof AI, và các gói từ hub chính sách |
| [Viết một chính sách](https://docs.befailproof.ai/policies/editor) | Từ một kiểm toán, hoặc trong mã |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Phạm vi cấu hình, quy tắc hợp nhất và thông số chính sách |

| Công cụ agent riêng của bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo chạy từ một agent không có harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham khảo `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho mục đích sử dụng nội bộ và cá nhân; bán lại thương mại failproofai chính nó yêu cầu thỏa thuận riêng. Xem [LICENSE](../../LICENSE) để xem toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, các trường hợp cạnh, và bản dịch đều được chào đón.

---

Được xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) ở SF và Bengaluru.
