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

**Quan sát và thực thi cho mỗi công cụ chạy các agents của bạn.**
Cho dù agents chạy ở đâu, chúng tôi đều nhìn thấy — và chúng tôi có thể từ chối. failproofai kết nối 12 công cụ agent
— các CLI mã hóa như Claude Code và Codex, các cổng chat như Hermes,
trợ lý tự lưu trữ như OpenClaw — ghi lại mọi lần chạy và chặn các lệnh gọi công cụ nguy hiểm
trước khi chúng thực thi. 39 chính sách tích hợp sẵn. Độ trễ bằng không. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Các công cụ được hỗ trợ

Mười hai công cụ trong hai lớp — mười CLI mã hóa và hai cổng chat và trợ lý
(Hermes, OpenClaw). Các sự kiện giống nhau, các chính sách giống nhau, lịch sử phiên giống nhau,
bất kể agent của bạn chạy trong công cụ nào.

Các agents chạy trong không có công cụ nào báo cáo thông qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
cung cấp cho bạn tracing, phiên và kiểm toán. Thực thi ở đó cần một hook trong
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

```sh
npm install -g failproofai
failproofai policies --install   # hoặc chỉ chạy `failproofai` và chấp nhận lời nhắc lần đầu
failproofai
```

39 chính sách tích hợp sẵn được kích hoạt ngay lập tức. Dashboard tại `localhost:8020`. Vô hiệu hóa lời nhắc lần đầu với `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Những gì nó chặn

| Chính sách | Những gì nó chặn |
|---|---|
| `sanitize-api-keys` | Các khóa API rò rỉ vào ngữ cảnh của agent |
| `block-env-files` | Đọc các tệp `.env` và tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại cùng một lệnh gọi |
| `block-sudo` | Nâng cao quyền hạn |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Các thay đổi không được xem xét đối với cơ sở hạ tầng trực tiếp |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, đẩy trực tiếp đến `main` |

Năm cái đầu tiên áp dụng cho bất kỳ agent nào có thể gọi một công cụ. Ba cái cuối cùng là
những yêu thích của nhà phát triển — CLI mã hóa là lớp công cụ chúng tôi bao phủ sâu nhất.

→ [Tất cả 39 chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/builtin)

---

## Các chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ nào.
Cam kết nó và toàn bộ nhóm của bạn sẽ nhận được nó vào lần kéo tiếp theo.

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
| `deny(message)` | Chặn nó — tin nhắn quay trở lại agent |
| `instruct(message)` | Cho phép nó, nhưng thêm ngữ cảnh vào lời nhắc tiếp theo của agent |

→ [Hướng dẫn chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom)

---

## Quan sát

Thực thi là một nửa. Nửa còn lại là nhìn thấy những gì agent thực sự đã làm.

Chạy `failproofai` mà không có đối số và nó phục vụ một dashboard trên `localhost:8020`
đọc lịch sử chạy đã có trên máy của bạn — không có tài khoản, không có đăng ký, không có gì
rời khỏi hộp. Bạn nhận được danh sách phiên, chuỗi các lệnh gọi mô hình, các lệnh gọi công cụ
và quyết định hook bên trong mỗi lần chạy, những gì bị chặn và những gì chính sách đã nói với agent,
và kiểm toán ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mô hình rủi ro
và đề xuất các chính sách để ngăn chặn chúng.

→ [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Kiểm toán cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng một mô hình dữ liệu, cho các nhóm
chạy agents trên một loạt: mỗi lần chạy từ mỗi công cụ ở một nơi, một biểu đồ thực thi
với các agents phụ song song trên các làn của riêng chúng, độ trễ p50/p95/p99 cho các mô hình, công cụ và hooks,
chi phí trên mỗi mô hình và theo dõi cửa sổ ngữ cảnh, theo dõi lỗi, SQL trên các traces của riêng bạn
với các dashboard có thể chia sẻ, các đánh giá được tính điểm bởi dịch vụ của riêng bạn,
các kiểm toán theo lịch trình biến các lỗi định kỳ thành các kết quả được hỗ trợ bằng bằng chứng,
và các cảnh báo được định tuyến đến Slack, email hoặc một webhook đã ký. Tự lưu trữ trong
cụm của riêng bạn có sẵn trong gói Enterprise.

→ [Phiên](https://docs.befailproof.ai/sessions/overview) ·
[Kiểm toán](https://docs.befailproof.ai/audits/overview) ·
[Đặt một buổi demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối một công cụ, xem lần chạy đầu tiên |
| [Khái niệm](https://docs.befailproof.ai/start/concepts) | Hệ thống hook hoạt động như thế nào |
| [Các công cụ được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12, và những gì mỗi cái có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Biểu đồ thực thi đang nói với bạn điều gì |
| [Kiểm toán](https://docs.befailproof.ai/audits/overview) | Tìm các mô hình lỗi trên nhiều phiên |
| [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/builtin) | Tất cả 39 chính sách với các tham số |
| [Chính sách tùy chỉnh](https://docs.befailproof.ai/policies/custom) | Viết của riêng bạn |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Các phạm vi cấu hình và quy tắc hợp nhất |

| Công cụ các agent của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo các lần chạy từ một agent không có công cụ |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Tham chiếu `allow` / `deny` / `instruct` |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho mục đích sử dụng nội bộ và cá nhân; bán lại thương mại của failproofai yêu cầu một thỏa thuận riêng biệt. Xem [LICENSE](../../LICENSE) để xem toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Các chính sách mới, trường hợp cạnh và bản dịch đều được hoan nghênh.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước tiên. Repo này chạy
> các hook của failproofai trên chính nó, và chúng phân giải import `failproofai` dựa trên
> gói đã biên dịch `dist/` — mà không có bản dựng bạn sẽ gặp lỗi hook
> `Cannot find package 'failproofai'`. Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Được xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) ở SF và Bengaluru.
