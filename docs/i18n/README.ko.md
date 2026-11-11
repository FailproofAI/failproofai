> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | **🇰🇷 한국어** | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**번역:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**에이전트가 실행되는 모든 하네스에 대한 가시성 확보와 정책 집행.**
에이전트가 어디서 실행되든 우리는 감지하고 — 차단할 수 있습니다. Failproof는 12개의 에이전트 하네스를 후킹합니다 — Claude Code, Codex 같은 코딩 CLI, Hermes 같은 채팅 게이트웨이, OpenClaw 같은 셀프 호스팅 어시스턴트 — 모든 실행을 캡처하고 위험한 도구 호출이 실행되기 전에 차단합니다. 내장 정책 40개. 지연 시간 제로. 로컬에서 실행됩니다.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 지원 하네스

두 가지 유형의 하네스 12개 — 코딩 CLI 10개, 채팅 및 어시스턴트 게이트웨이 2개(Hermes, OpenClaw). 모든 하네스에서 하나의 정책 API와 하나의 세션 이력을 공유합니다. 정책이 *차단*할 수 있는 범위는 하네스마다 다릅니다. 도구 호출이 실행되기 전에 중단하는 기능은 12개 모두에서 검증되었으며, 턴 종료 게이트는 8개에서 동작합니다.
[하네스별 지원 매트릭스](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)에서 각 하네스가 처리하는 이벤트를 확인할 수 있습니다.

12개 하네스 중 어디에서도 실행되지 않는 에이전트는 [Python SDK](https://docs.befailproof.ai/reference/custom-agents)를 통해 리포팅할 수 있으며, 트레이싱·세션·감사 기능을 제공합니다. 해당 환경에서 정책 집행을 하려면 자체 런타임에 훅이 필요합니다 — [문의해 주시면](mailto:support@befailproof.ai) 함께 설계해 드립니다.

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
failproofai config                             # 에이전트와 데몬 연결 설정
failproofai policies add FailproofAI/policies  # 적용할 정책 선택
failproofai                                    # localhost:8020 에서 대시보드 실행
```

설정 과정에서 훅이 연결되며 정책은 **아무것도** 선택되지 않습니다 — 머신에 가드레일을 적용하는 것은 두 번째 명령이며, 모든 팩은 같은 방식으로 입력합니다
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>`로 먼저 조회할 수 있습니다). 터미널 없이 `failproofai config`를 실행하면 — CI, 컨테이너, 에이전트가 구동 중인 환경 등에서 — 질문 없이 바로 적용됩니다. 아직 설정된 적 없는 머신에서 다른 명령을 실행하면 동일한 설정 마법사가 먼저 실행됩니다. `FAILPROOFAI_NO_FIRST_RUN=1`로 이를 비활성화할 수 있습니다.

정책 팩이 적용되기 전까지 유일하게 집행 중인 정책은 `block-failproofai-commands`이며, 이는 항상 활성화되어 있고 끄거나 일시 정지할 수 없습니다. 집행을 일시 정지할 수 있는 에이전트는 다른 모든 정책도 끌 수 있기 때문입니다.

---

## 차단 항목

| 정책 | 차단 대상 |
|---|---|
| `block-env-files` | `.env` 및 기타 시크릿 파일 읽기 |
| `warn-repeated-tool-calls` | 동일한 호출을 반복하는 에이전트 루프 |
| `block-sudo` | 권한 상승 |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, 조건 없는 `DELETE` |
| `block-terraform` / `block-kubectl` | 검토되지 않은 라이브 인프라 변경 |
| `block-rm-rf` | 재귀적 파일 삭제 |
| `block-force-push` / `block-push-master` | `git push --force`, `main` 브랜치 직접 푸시 |

이 모든 정책은 호출이 실행되기 *전에* 차단하므로 12개 하네스 모두에서 유효합니다. 앞의 네 가지는 도구를 호출할 수 있는 모든 에이전트에 적용되며, 나머지 세 가지는 개발자들이 가장 선호하는 정책입니다 — 코딩 CLI는 우리가 가장 깊이 커버하는 하네스 유형입니다. `sanitize-*` 계열은 별도로 동작하며, 도구가 결과를 반환한 후에 실행되므로 컨텍스트에 포함되기 전에 차단하는 것이 아니라 도구 출력 내 시크릿을 감지하여 리포팅합니다.

→ [내장 정책 40개 전체 보기](https://docs.befailproof.ai/policies/packs)

---

## 커스텀 정책

`.failproofai/policies/` 디렉토리에 파일을 추가하면 — 별도 플래그 없이 자동으로 로드됩니다.
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

모든 정책에서 사용 가능한 세 가지 결정:

| 결정 | 동작 |
|---|---|
| `allow()` | 작업 허용 |
| `deny(message)` | 차단 — 메시지가 에이전트에게 전달됨 |
| `instruct(message)` | 통과 허용, 단 에이전트의 다음 프롬프트에 컨텍스트 추가 |

→ [정책 작성하기](https://docs.befailproof.ai/policies/editor)

---

## 가시성

정책 집행은 절반에 불과합니다. 나머지 절반은 에이전트가 실제로 무엇을 했는지 파악하는 것입니다.

인자 없이 `failproofai`를 실행하면 `localhost:8020`에 대시보드가 서빙되어 머신에 이미 저장된 실행 이력을 보여줍니다 — 계정도, 회원가입도, 외부로 나가는 데이터도 없습니다. 세션 목록, 모델 호출 순서, 각 실행 내의 도구 호출 및 훅 결정, 차단된 항목과 정책이 에이전트에게 전달한 내용, 그리고 오프라인 감사(`failproofai audit`) — 이력에서 위험 패턴을 스캔하고 이를 차단할 정책을 제안합니다.

→ [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) ·
[트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) ·
[로컬 감사](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability**는 동일한 데이터 모델의 호스팅 버전으로, 여러 머신에서 에이전트를 운영하는 팀을 위한 것입니다. 모든 하네스의 모든 실행을 한 곳에서, 병렬 서브 에이전트가 각자의 레인으로 표시되는 실행 그래프, 모델·도구·훅의 p50/p95/p99 레이턴시, 모델별 비용 및 컨텍스트 윈도우 추적, 에러 추적, 공유 가능한 대시보드와 함께 자체 트레이스에 대한 SQL 쿼리, 자체 서비스로 채점되는 평가, 반복되는 실패를 근거 기반 발견으로 변환하는 정기 감사, Slack·이메일·서명된 웹훅으로 라우팅되는 알림. 엔터프라이즈 플랜에서는 자체 클러스터 셀프 호스팅도 지원합니다.

→ [세션](https://docs.befailproof.ai/sessions/overview) ·
[감사](https://docs.befailproof.ai/audits/overview) ·
[데모 예약](https://befailproof.ai/get-a-demo)

---

## 문서

| 시작하기 | |
|---|---|
| [빠른 시작](https://docs.befailproof.ai/start/quickstart) | 설치, 하네스 연결, 첫 실행 확인 |
| [개념](https://docs.befailproof.ai/start/concepts) | 훅 시스템의 동작 원리 |
| [지원 하네스](https://docs.befailproof.ai/reference/harnesses) | 12개 전체와 각각의 정책 집행 범위 |

| 가시성 | |
|---|---|
| [세션](https://docs.befailproof.ai/sessions/overview) | 실행 추적: 모델, 도구, 에러, 레이턴시 |
| [트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) | 실행 그래프가 말해주는 것 |
| [감사](https://docs.befailproof.ai/audits/overview) | 여러 세션에 걸친 실패 패턴 탐지 |
| [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, 계정 불필요 |

| 정책 집행 | |
|---|---|
| [정책 팩](https://docs.befailproof.ai/policies/packs) | Failproof AI 기본 정책과 정책 허브의 팩 |
| [정책 작성](https://docs.befailproof.ai/policies/editor) | 감사 결과 기반 또는 코드로 직접 작성 |
| [설정](https://docs.befailproof.ai/policies/local-configuration) | 설정 범위, 병합 규칙 및 정책 파라미터 |

| 커스텀 에이전트 연동 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 하네스 없는 에이전트에서 실행 리포팅 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` 레퍼런스 |

---

## 라이선스

[Commons Clause](https://commonsclause.com/)가 포함된 MIT — 내부 및 개인 사용은 무료이며, failproofai 자체의 상업적 재판매는 별도 계약이 필요합니다. 전문은 [LICENSE](../../LICENSE)를 참고하세요.

---

## 기여

[CONTRIBUTING.md](../../CONTRIBUTING.md)를 참고해 주세요. 새로운 정책, 엣지 케이스, 번역 모두 환영합니다.

---

❤️를 담아 SF와 벵갈루루의 [befailproof.ai](https://befailproof.ai) 팀이 만들었습니다.
