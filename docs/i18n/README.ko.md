> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | **🇰🇷 한국어** | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**번역:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**에이전트가 실행되는 모든 하네스에 대한 가시성 확보 및 정책 집행.**
에이전트가 어디서 실행되든 우리는 모든 것을 보고, 필요하면 차단합니다. Failproof는 12개의 에이전트
하네스에 훅을 걸어 — Claude Code, Codex 같은 코딩 CLI, Hermes 같은 채팅 게이트웨이,
OpenClaw 같은 자체 호스팅 어시스턴트 — 모든 실행을 캡처하고 위험한 툴 호출이
실행되기 전에 차단합니다. 내장 정책 40개. 레이턴시 제로. 로컬 실행.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 지원 하네스

두 가지 분류의 12개 하네스 — 코딩 CLI 10개, 채팅·어시스턴트 게이트웨이 2개(Hermes, OpenClaw). 어떤 하네스에서 에이전트가 실행되든 동일한 이벤트, 동일한 정책, 동일한 세션 기록이 적용됩니다.

이 중 어느 하네스도 사용하지 않는 에이전트는 [Python SDK](https://docs.befailproof.ai/reference/python-sdk)를 통해 보고할 수 있으며, 트레이싱·세션·감사 기능을 제공합니다. 해당 환경에서의 정책 집행은 런타임에 훅을 직접 추가해야 합니다 — [문의하시면](mailto:support@befailproof.ai) 함께 방법을 찾아드립니다.

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

## 설치

```sh
npm install -g failproofai
failproofai policies --install   # 또는 `failproofai`를 실행하고 첫 실행 프롬프트에서 수락
failproofai
```

내장 정책 40개가 즉시 활성화됩니다. 대시보드는 `localhost:8020`에서 확인하세요. `FAILPROOFAI_NO_FIRST_RUN=1`로 첫 실행 프롬프트를 비활성화할 수 있습니다.

---

## 차단 목록

| 정책 | 차단 대상 |
|---|---|
| `sanitize-api-keys` | 에이전트 컨텍스트로 유출되는 API 키 |
| `block-env-files` | `.env` 및 기타 시크릿 파일 읽기 |
| `warn-repeated-tool-calls` | 동일한 호출을 반복하는 에이전트 루프 |
| `block-sudo` | 권한 상승 |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, 조건 없는 `DELETE` |
| `block-terraform` / `block-kubectl` | 검토되지 않은 운영 인프라 변경 |
| `block-rm-rf` | 재귀적 파일 삭제 |
| `block-force-push` / `block-push-master` | `git push --force`, `main` 브랜치 직접 푸시 |

처음 다섯 가지는 툴을 호출할 수 있는 모든 에이전트에 적용됩니다. 나머지 세 가지는
개발자들이 가장 선호하는 정책으로, 코딩 CLI는 우리가 가장 깊이 지원하는 하네스 분류입니다.

→ [내장 정책 40개 전체 목록](https://docs.befailproof.ai/policies/builtin)

---

## 커스텀 정책

`.failproofai/policies/` 디렉터리에 파일을 넣으면 별도 플래그 없이 자동으로 로드됩니다.
커밋하면 팀 전체가 다음 pull 시 적용받습니다.

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

모든 정책에서 사용할 수 있는 세 가지 결정:

| 결정 | 효과 |
|---|---|
| `allow()` | 작업 허용 |
| `deny(message)` | 차단 — 메시지가 에이전트에게 반환됨 |
| `instruct(message)` | 통과시키되, 에이전트의 다음 프롬프트에 컨텍스트 추가 |

→ [커스텀 정책 가이드](https://docs.befailproof.ai/policies/custom)

---

## 가시성

정책 집행은 절반입니다. 나머지 절반은 에이전트가 실제로 무엇을 했는지 확인하는 것입니다.

인수 없이 `failproofai`를 실행하면 `localhost:8020`에 대시보드가 열리며,
이미 머신에 저장된 실행 기록을 불러옵니다 — 계정 불필요, 회원가입 불필요, 데이터가 외부로 나가지 않습니다.
세션 목록, 각 실행 내의 모델 호출·툴 호출·훅 결정 순서, 차단된 내용과 정책이 에이전트에 전달한 내용,
그리고 히스토리에서 위험 패턴을 스캔하고 해당 패턴을 막을 정책을 제안하는 오프라인 감사(`failproofai audit`)를 제공합니다.

→ [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) ·
[트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) ·
[로컬 감사](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability**는 동일한 데이터 모델의 호스팅 버전으로, 플릿 전체에서 에이전트를 운영하는 팀을 위한 서비스입니다: 모든 하네스의 모든 실행을 한 곳에서 확인, 독립 레인에서 병렬 서브에이전트를 보여주는 실행 그래프, 모델·툴·훅의 p50/p95/p99 레이턴시, 모델별 비용 및 컨텍스트 윈도우 트래킹, 에러 트래킹, 공유 가능한 대시보드와 함께 자체 트레이스에 대한 SQL 쿼리, 자체 서비스로 평가하는 이밸류에이션, 반복적인 실패를 근거 기반 발견으로 전환하는 정기 감사, Slack·이메일·서명된 웹훅으로 라우팅되는 알림. 자체 클러스터에서의 셀프호스팅은 Enterprise 플랜에서 이용 가능합니다.

→ [세션](https://docs.befailproof.ai/sessions/overview) ·
[감사](https://docs.befailproof.ai/audits/overview) ·
[데모 예약](https://befailproof.ai/get-a-demo)

---

## 문서

| 시작하기 | |
|---|---|
| [빠른 시작](https://docs.befailproof.ai/start/quickstart) | 설치, 하네스 연결, 첫 번째 실행 확인 |
| [개념](https://docs.befailproof.ai/start/concepts) | 훅 시스템의 동작 방식 |
| [지원 하네스](https://docs.befailproof.ai/reference/harnesses) | 12개 전체 목록 및 각각의 집행 가능 범위 |

| 관찰 | |
|---|---|
| [세션](https://docs.befailproof.ai/sessions/overview) | 실행 추적: 모델, 툴, 에러, 레이턴시 |
| [트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) | 실행 그래프가 전달하는 정보 |
| [감사](https://docs.befailproof.ai/audits/overview) | 여러 세션에 걸친 실패 패턴 탐지 |
| [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, 계정 불필요 |

| 집행 | |
|---|---|
| [내장 정책](https://docs.befailproof.ai/policies/builtin) | 파라미터 포함 40개 정책 전체 |
| [커스텀 정책](https://docs.befailproof.ai/policies/custom) | 직접 작성하기 |
| [설정](https://docs.befailproof.ai/policies/local-configuration) | 설정 범위 및 병합 규칙 |

| 직접 에이전트 계측 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/python-sdk) | 하네스 없이 에이전트에서 실행 보고 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 레퍼런스 |

---

## 라이선스

[Commons Clause](https://commonsclause.com/)가 포함된 MIT — 내부 및 개인 사용은 무료이며, failproofai 자체의 상업적 재판매는 별도 계약이 필요합니다. 전문은 [LICENSE](../../LICENSE)를 참고하세요.

---

## 기여

[CONTRIBUTING.md](../../CONTRIBUTING.md)를 참고하세요. 새로운 정책, 엣지 케이스, 번역 모두 환영합니다.

> **시작 전에 먼저 빌드하세요.** `bun install && bun run build`를 먼저 실행하세요. 이 저장소는
> failproofai의 훅을 자신에게 적용하며, 컴파일된 `dist/` 번들을 기준으로 `failproofai` 임포트를
> 해석합니다 — 빌드 없이는 `Cannot find package 'failproofai'` 훅 에러가 발생합니다.
> `src/`를 수정한 후에는 다시 빌드하세요. 자세한 내용은
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)를 참고하세요.

---

SF와 벵갈루루에서 ❤️를 담아 [befailproof.ai](https://befailproof.ai)가 만들었습니다.
