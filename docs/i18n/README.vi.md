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

**Xem những gì các agent của bạn làm. Ngăn chặn các lỗi đã biết trước khi chúng lặp lại.**
Failproof AI hoạt động ở mọi nơi agent của bạn chạy: công cụ lập mã như Claude Code và
Codex, cổng trò chuyện như Hermes, trợ lý tự host như OpenClaw, và các agent
mà bạn tự mô phỏng. Nó ghi lại mỗi lần chạy và có thể chặn các lệnh gọi công cụ nguy hiểm
trước khi chúng thực thi.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Các harness được hỗ trợ

Mười hai harness trong hai lớp được hỗ trợ: mười CLI lập mã, cộng với hai
cổng: Hermes, OpenClaw. API chính sách và lịch sử phiên được chia sẻ; các sự kiện nào
có thể chặn khác nhau tùy theo harness.

Các agent chạy không có harness nào báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
cung cấp cho bạn tracing, phiên và kiểm toán. Việc thực thi ở đó cần một hook trong
runtime của riêng bạn — [liên hệ với chúng tôi](mailto:support@befailproof.ai) và chúng tôi sẽ ánh xạ nó.

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

Cấp cho một agent tương thích kỹ năng Failproof AI nếu bạn muốn nó hướng dẫn thiết lập,
kiểm tra máy, và định tuyến chính sách, kiểm toán, phiên, và công việc Cloud một cách chính xác:

```sh
npx skills add FailproofAI/skills
```

Điều này cài đặt kỹ năng chung và các kỹ năng chuyên môn của nó. Để cài đặt chỉ kỹ năng
chung, thêm `--skill failproofai`. Kỹ năng cung cấp hướng dẫn hoạt động; cài đặt
và cấu hình sản phẩm với:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

Thiết lập kết nối các agent được hỗ trợ và cài đặt dịch vụ nền. Nó không chọn
gói chính sách nào: trước khi bạn thêm một, chỉ `block-failproofai-commands` chạy để dừng agent vô hiệu hóa Failproof AI.

Kết nối Cloud mà không có lời nhắc với `failproofai config --token <machine-key>`. Trên
máy chia sẻ hoặc trong CI, đặt `FAILPROOFAI_CLOUD_TOKEN` và chạy `failproofai config`
để khóa không xuất hiện trong lịch sử lệnh.

---

## Nó ngăn chặn cái gì

| Chính sách | Những gì nó chặn |
|---|---|
| `sanitize-api-keys` | Các khóa API rò rỉ vào ngữ cảnh của agent |
| `block-env-files` | Đọc các tệp `.env` và các tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại trên cùng một lệnh gọi |
| `block-sudo` | Nâng cao đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Những thay đổi chưa được xem xét đối với hạ tầng trực tiếp |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, những lần push trực tiếp đến `main` |

Những chính sách này bảo vệ tệp, thông tin xác thực, hạ tầng, cơ sở dữ liệu, và
quy trình làm việc của agent. Hỗ trợ thực thi chính xác khác nhau tùy theo harness và sự kiện.

→ [Tất cả 39 chính sách tích hợp](https://docs.befailproof.ai/policies/builtin)

---

## Chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ.
Commit nó và toàn bộ đội sẽ có được nó trên lần pull tiếp theo.

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

| Quyết định | Hiệu ứng |
|---|---|
| `allow()` | Cho phép hoạt động |
| `deny(message)` | Chặn nó — thông báo quay lại agent |
| `instruct(message)` | Cho phép hoạt động, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom)

---

## Gói chính sách

Một gói chính sách là một bộ chính sách được phiên bản xuất bản từ một
kho lưu trữ GitHub công khai. Kiểm tra nó trước khi cài đặt:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Bất cứ thứ gì có dấu gạch chéo đều là nguồn gói; bất cứ thứ gì không có thì là tên chính sách.
Bạn có thể cài đặt các danh mục hoặc chính sách đã chọn, và ghim một bản phát hành khi cần.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Duyệt các gói đã xuất bản trong [Policy Hub](https://befailproof.ai/policy-hub/), hoặc
chạy `failproofai publish --init` để bắt đầu của riêng bạn. Chế độ quan sát cho phép một gói ghi lại
những gì nó sẽ làm mà không chặn: `failproofai publish --effect observe`.

→ [Gói chính sách](https://docs.befailproof.ai/policies/packs) ·
[Xuất bản một gói](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Khả năng quan sát

Thực thi là một nửa. Nửa kia là xem những gì agent thực sự đã làm.

Chạy `failproofai` không có đối số và nó phục vụ một bảng điều khiển trên `localhost:8020`
đọc lịch sử chạy đã có trên máy của bạn — không có tài khoản, không có đăng ký, không có gì
rời khỏi hộp. Bạn nhận được danh sách phiên, chuỗi lệnh gọi mô hình, lệnh gọi công cụ
và quyết định hook bên trong mỗi lần chạy, những gì bị chặn và những gì chính sách nói
với agent, và kiểm toán ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mẫu rủi ro và gợi ý chính sách để dừng chúng.

→ [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm toán cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng mô hình dữ liệu, cho các đội
chạy agent trên toàn bộ fleet: mỗi lần chạy từ mỗi harness ở một nơi, đồ thị thực thi
với các sub-agent song song trên làn đường của riêng chúng, độ trễ p50/p95/p99
cho các mô hình, công cụ và hook, chi phí mỗi mô hình và theo dõi cửa sổ ngữ cảnh, theo dõi lỗi, SQL
trên các trace của riêng bạn với các bảng điều khiển có thể chia sẻ, đánh giá được tính điểm bởi
dịch vụ của riêng bạn, kiểm toán được lên lịch biến những lỗi định kỳ thành những phát hiện
có bằng chứng, và cảnh báo được định tuyến đến Slack, email hoặc webhook đã ký. Tự host trong
cluster của riêng bạn có sẵn trong gói Enterprise.

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
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: các mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Những gì đồ thị thực thi đang nói với bạn |
| [Kiểm toán](https://docs.befailproof.ai/audits/overview) | Tìm các mẫu lỗi trên nhiều phiên |
| [Bảng điều khiển cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Chính sách tích hợp](https://docs.befailproof.ai/policies/builtin) | Tất cả 39 chính sách với các tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom) | Viết của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Phạm vi cấu hình và quy tắc hợp nhất |

| Mô phỏng agent của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo các lần chạy từ một agent không có harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham chiếu `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho sử dụng nội bộ và cá nhân; việc bán lại thương mại failproofai cần một thỏa thuận riêng. Xem [LICENSE](../../LICENSE) cho toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, trường hợp cạnh, và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước. Kho lưu trữ này chạy
> hook của failproofai trên chính nó, và chúng giải quyết nhập `failproofai` theo gói
> biên dịch `dist/` — mà không có bản dựng bạn sẽ gặp lỗi hook `Cannot find package 'failproofai'`.
> Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) tại SF và Bengaluru.
