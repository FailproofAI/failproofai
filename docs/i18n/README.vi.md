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

**Quan sát và thực thi cho mọi harness mà agents của bạn chạy.**
Bất kể agents của bạn chạy ở đâu, chúng tôi đều nhìn thấy — và chúng tôi có thể từ chối. Failproof kết nối 12 agent harness — các CLI viết mã như Claude Code và Codex, các gateway chat như Hermes, các trợ lý tự lưu trữ như OpenClaw — ghi lại mọi lần chạy và chặn các lệnh công cụ nguy hiểm trước khi chúng thực thi. 40 chính sách tích hợp sẵn. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Các harness được hỗ trợ

Mười hai harness trong hai lớp — mười CLI viết mã, và hai cổng chat và trợ lý (Hermes, OpenClaw). Cùng các sự kiện, cùng chính sách, cùng lịch sử phiên, bất kể agents của bạn chạy trong cái nào.

Các agents chạy trong cái nào đó khác báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/python-sdk), cung cấp cho bạn theo dõi, phiên và kiểm toán. Thực thi ở đó cần một hook trong runtime của riêng bạn — [liên hệ với chúng tôi](mailto:support@befailproof.ai) và chúng tôi sẽ ánh xạ nó.

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

40 chính sách tích hợp sẵn sẽ kích hoạt ngay lập tức. Dashboard tại `localhost:8020`. Tắt lời nhắc lần đầu với `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `sanitize-api-keys` | Các khóa API bị rò rỉ vào bối cảnh của agent |
| `block-env-files` | Đọc các tệp `.env` và tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại trên cùng một lệnh gọi |
| `block-sudo` | Nâng cao đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không bị giới hạn |
| `block-terraform` / `block-kubectl` | Thay đổi không được xem xét đối với cơ sở hạ tầng trực tiếp |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, đẩy trực tiếp đến `main` |

Năm cái đầu tiên áp dụng cho bất kỳ agent nào có thể gọi một công cụ. Ba cái cuối cùng là những ưa thích của nhà phát triển — các CLI viết mã là lớp harness mà chúng tôi bao quát sâu nhất.

→ [Tất cả 40 chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/builtin)

---

## Chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ. Cam kết nó và toàn bộ nhóm của bạn sẽ nhận được nó khi pull tiếp theo.

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
| `deny(message)` | Chặn nó — thông báo được gửi lại cho agent |
| `instruct(message)` | Cho phép nó thực hiện, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom)

---

## Quan sát

Thực thi là một nửa. Nửa còn lại là xem agent thực sự đã làm gì.

Chạy `failproofai` mà không có đối số và nó sẽ phục vụ một dashboard tại `localhost:8020` đọc lịch sử chạy đã có trên máy của bạn — không tài khoản, không đăng ký, không có gì rời khỏi hộp. Bạn sẽ nhận được danh sách phiên, chuỗi lệnh gọi mô hình, lệnh gọi công cụ và quyết định hook bên trong mỗi lần chạy, những gì bị chặn và chính sách nói với agent điều gì, và kiểm toán ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mẫu rủi ro và gợi ý các chính sách để dừng chúng.

→ [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm toán cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng một mô hình dữ liệu, dành cho các nhóm chạy agents trên một lfleet: mọi lần chạy từ mọi harness ở một nơi, một biểu đồ thực thi với các sub-agents song song trên làn đường riêng của họ, độ trễ p50/p95/p99 cho các mô hình, công cụ và hook, theo dõi chi phí mỗi mô hình và cửa sổ ngữ cảnh, theo dõi lỗi, SQL trên các trace của riêng bạn với các dashboard có thể chia sẻ, các đánh giá được tính điểm bởi dịch vụ của riêng bạn, các kiểm toán được lên lịch biến các lỗi định kỳ thành các phát hiện được hỗ trợ bằng bằng chứng, và cảnh báo được định tuyến đến Slack, email hoặc một webhook đã ký. Tự lưu trữ trong cluster của riêng bạn có sẵn trên gói Enterprise.

→ [Phiên](https://docs.befailproof.ai/sessions/overview) ·
[Kiểm toán](https://docs.befailproof.ai/audits/overview) ·
[Đặt lịch demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối một harness, xem lần chạy đầu tiên |
| [Khái niệm](https://docs.befailproof.ai/start/concepts) | Cách hoạt động của hệ thống hook |
| [Các harness được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12 và những gì mỗi cái có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Những gì biểu đồ thực thi đang cho bạn biết |
| [Kiểm toán](https://docs.befailproof.ai/audits/overview) | Tìm các mẫu lỗi trên nhiều phiên |
| [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/builtin) | Tất cả 40 chính sách với các tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom) | Viết của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Các phạm vi cấu hình và quy tắc hợp nhất |

| Cài đặt agent của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/python-sdk) | Báo cáo các lần chạy từ một agent mà không có harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham chiếu `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho mục đích sử dụng nội bộ và cá nhân; bán lại thương mại của failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](../../LICENSE) để biết toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, trường hợp cạnh và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước tiên. Kho này chạy các hook của failproofai trên chính nó, và chúng giải quyết nhập `failproofai` so với gói `dist/` được biên dịch — mà không cần xây dựng bạn sẽ gặp `Cannot find package 'failproofai'` lỗi hook. Xây dựng lại sau khi thay đổi `src/`. Xem
> [Xây dựng trước khi các hook dev trong repo sẽ hoạt động](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) tại SF và Bengaluru.
