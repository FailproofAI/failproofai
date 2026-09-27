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

**Quan sát và thực thi cho mọi harness mà agent của bạn chạy.**
Dù agent chạy ở đâu, chúng tôi đều thấy — và có thể từ chối. Failproof kết nối 12 agent
harness — coding CLI như Claude Code và Codex, chat gateway như Hermes,
trợ lý tự lưu trữ như OpenClaw — ghi lại mọi lần chạy và chặn các lệnh gọi công cụ
nguy hiểm trước khi thực thi. 40 chính sách tích hợp sẵn. Không có độ trễ. Chạy cục bộ.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Hỗ trợ harness

Mười hai harness trong hai lớp — mười coding CLI và hai chat gateway cùng gateway
trợ lý (Hermes, OpenClaw). Một API chính sách và lịch sử phiên trên toàn bộ chúng.
Những gì một chính sách có thể *chặn* là tùy theo harness: dừng một lệnh gọi công cụ
trước khi chạy được xác minh trên tất cả mười hai, cổng cuối lượt trên tám.
[ma trận từng harness](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
liệt kê các sự kiện mà mỗi cái tuân thủ.

Agent chạy mà không có bất kỳ cái nào báo cáo qua [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
cung cấp tracing, phiên và audit cho bạn. Thực thi ở đó cần một hook trong
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
failproofai config                             # kết nối agent và daemon của bạn
failproofai policies add FailproofAI/policies  # chọn cái gì để thực thi
failproofai                                    # dashboard trên localhost:8020
```

Thiết lập sẽ kết nối các hook và chọn **không** chính sách — lệnh thứ hai là cái
đặt guardrail trên máy, và bất kỳ pack nào cũng được nhập theo cách tương tự
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` đọc
một trước tiên). Chạy `failproofai config` mà không có terminal — CI, container,
agent điều khiển nó — và nó áp dụng thay vì hỏi. Trên máy chưa bao giờ được thiết lập,
bất kỳ lệnh nào khác cũng chạy cùng một trình hướng dẫn trước; vô hiệu hóa điều đó
bằng `FAILPROOFAI_NO_FIRST_RUN=1`.

Cho đến khi pack tới, điều duy nhất thực thi là `block-failproofai-commands`,
luôn bật và không thể tắt hoặc tạm dừng: một agent có thể tạm dừng thực thi
có thể tắt từng chính sách khác.

---

## Cái nó chặn

| Chính sách | Cái nó chặn |
|---|---|
| `block-env-files` | Đọc `.env` và các tệp bí mật khác |
| `warn-repeated-tool-calls` | Agent lặp lại cùng một lệnh gọi |
| `block-sudo` | Nâng cao đặc quyền |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` không giới hạn |
| `block-terraform` / `block-kubectl` | Thay đổi cơ sở hạ tầng trực tiếp không được xem xét |
| `block-rm-rf` | Xóa tệp đệ quy |
| `block-force-push` / `block-push-master` | `git push --force`, push trực tiếp tới `main` |

Mỗi cái gating lệnh gọi *trước* khi chạy, vì vậy chúng giữ trên tất cả mười hai
harness. Bốn cái đầu tiên áp dụng cho bất kỳ agent nào có thể gọi công cụ; ba cái cuối
là yêu thích của nhà phát triển — coding CLI là lớp harness chúng tôi bao phủ sâu nhất.
Gia đình `sanitize-*` là riêng biệt: nó chạy sau khi công cụ trả về, vì vậy nó báo cáo
một bí mật trong đầu ra công cụ thay vì giữ nó ra khỏi bối cảnh.

→ [Tất cả 40 chính sách tích hợp sẵn](https://docs.befailproof.ai/policies/packs)

---

## Chính sách của riêng bạn

Thả một tệp vào `.failproofai/policies/` — nó tải tự động, không cần cờ.
Commit nó và toàn bộ đội sẽ có nó vào lần kéo tiếp theo.

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
| `deny(message)` | Chặn nó — thông báo quay trở lại agent |
| `instruct(message)` | Cho phép nó qua, nhưng thêm bối cảnh vào prompt tiếp theo của agent |

→ [Viết một chính sách](https://docs.befailproof.ai/policies/editor)

---

## Quan sát

Thực thi là một nửa. Nửa kia là thấy agent thực sự làm gì.

Chạy `failproofai` không có đối số và nó phục vụ dashboard trên `localhost:8020`
đọc lịch sử chạy đã có trên máy của bạn — không có tài khoản, không có đăng ký, không có gì
rời khỏi hộp. Bạn nhận được danh sách phiên, trình tự các lệnh gọi mô hình, lệnh gọi công cụ
và quyết định hook bên trong mỗi lần chạy, cái gì bị chặn và cái chính sách nói với agent,
và audit ngoại tuyến (`failproofai audit`) quét lịch sử của bạn để tìm các mẫu rủi ro
và gợi ý chính sách để dừng chúng.

→ [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) ·
[Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Audit cục bộ](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** là phía được lưu trữ của cùng một mô hình dữ liệu, dành cho các đội
chạy agent trên một đội hình: mỗi lần chạy từ mỗi harness ở một nơi, một biểu đồ thực thi
với sub-agent song song trên các làn riêng của họ, độ trễ p50/p95/p99 cho mô hình, công cụ
và hook, chi phí mỗi mô hình và theo dõi cửa sổ bối cảnh, theo dõi lỗi, SQL trên các trace
của bạn với dashboard có thể chia sẻ, đánh giá được điểm bởi dịch vụ của bạn, audit được lên lịch
biến những thất bại định kỳ thành những phát hiện dựa trên bằng chứng, và cảnh báo được định tuyến
tới Slack, email hoặc webhook được ký. Tự lưu trữ trong cluster của riêng bạn có sẵn trên
kế hoạch Enterprise.

→ [Phiên](https://docs.befailproof.ai/sessions/overview) ·
[Audit](https://docs.befailproof.ai/audits/overview) ·
[Đặt demo](https://befailproof.ai/get-a-demo)

---

## Tài liệu

| Bắt đầu | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Cài đặt, kết nối harness, xem lần chạy đầu tiên |
| [Khái niệm](https://docs.befailproof.ai/start/concepts) | Cách hệ thống hook hoạt động |
| [Harness được hỗ trợ](https://docs.befailproof.ai/reference/harnesses) | Tất cả 12, và cái gì mỗi cái có thể thực thi |

| Quan sát | |
|---|---|
| [Phiên](https://docs.befailproof.ai/sessions/overview) | Theo dõi một lần chạy: mô hình, công cụ, lỗi, độ trễ |
| [Đọc một trace](https://docs.befailproof.ai/sessions/read-a-trace) | Cái gì biểu đồ thực thi nói với bạn |
| [Audit](https://docs.befailproof.ai/audits/overview) | Tìm các mẫu thất bại trên nhiều phiên |
| [Dashboard cục bộ](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, không cần tài khoản |

| Thực thi | |
|---|---|
| [Gói chính sách](https://docs.befailproof.ai/policies/packs) | Các chính sách Failproof AI, và gói từ hub chính sách |
| [Viết một chính sách](https://docs.befailproof.ai/policies/editor) | Từ một audit, hoặc trong code |
| [Cấu hình](https://docs.befailproof.ai/policies/local-configuration) | Phạm vi cấu hình, quy tắc hợp nhất và tham số chính sách |

| Công cụ cho agent của riêng bạn | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Báo cáo chạy từ agent không có harness |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` tham chiếu |

---

## Giấy phép

MIT với [Commons Clause](https://commonsclause.com/) — miễn phí cho sử dụng nội bộ và cá nhân; bán lại thương mại của failproofai yêu cầu một thỏa thuận riêng. Xem [LICENSE](../../LICENSE) để có toàn bộ văn bản.

---

## Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Chính sách mới, trường hợp biên và bản dịch đều được chào đón.

> **Xây dựng trước khi bạn bắt đầu.** Chạy `bun install && bun run build` trước tiên. Repo này chạy
> hook của failproofai trên chính nó, và chúng giải quyết import `failproofai` dựa trên
> gói `dist/` được biên dịch — mà không có bản dựng bạn sẽ gặp lỗi `Cannot find package 'failproofai'`
> hook. Xây dựng lại sau khi thay đổi `src/`. Xem
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Xây dựng với ❤️ bởi [befailproof.ai](https://befailproof.ai) ở SF và Bengaluru.
