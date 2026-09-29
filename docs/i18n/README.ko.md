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

**에이전트가 실행되는 모든 하네스를 위한 관측성과 정책 집행.**
에이전트가 어디서 실행되든 우리는 확인하고 — 차단할 수 있습니다. Failproof는 12개의 에이전트
하네스를 후킹합니다 — Claude Code, Codex 같은 코딩 CLI, Hermes 같은 채팅 게이트웨이,
OpenClaw 같은 자체 호스팅 어시스턴트 — 모든 실행을 캡처하고 위험한
툴 호출을 실행 전에 차단합니다. 기본 제공 정책 39개. 레이턴시 없음. 로컬에서 실행.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 지원 하네스

두 가지 클래스로 나뉜 12개의 하네스 — 코딩 CLI 10개, 채팅 및 어시스턴트 게이트웨이 2개(Hermes, OpenClaw). 모든 하네스에 걸쳐 하나의 정책 API와 하나의 세션 히스토리를 공유합니다. 정책이 *차단*할 수 있는 범위는 하네스마다 다릅니다. 툴 호출을 실행 전에 멈추는 기능은 12개 모두에서 검증되었으며, 턴 종료 게이트는 8개에서 작동합니다.
[하네스별 매트릭스](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)에서 각 하네스가 지원하는 이벤트를 확인할 수 있습니다.

12개 하네스 중 어디에도 속하지 않는 에이전트는 [Python SDK](https://docs.befailproof.ai/reference/custom-agents)를 통해 보고하며, 트레이싱, 세션, 감사 기능을 제공합니다. 해당 환경에서의 정책 집행은 자체 런타임에 훅이 필요합니다 — [문의하시면](mailto:support@befailproof.ai) 매핑을 도와드립니다.

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
failproofai                                    # localhost:8020에서 대시보드 실행
```

설정은 훅을 연결하되 정책을 **아무것도** 적용하지 않습니다 — 두 번째 명령이 머신에 가드레일을 설치하는 역할을 하며, 모든 팩은 동일한 방식으로 지정합니다
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>`로 먼저 내용을 확인할 수 있습니다). 터미널 없이 `failproofai config`를 실행하면 — CI, 컨테이너, 에이전트가 직접 구동하는 경우 — 묻지 않고 바로 적용합니다. 한 번도 설정되지 않은 머신에서는 다른 명령을 실행해도 동일한 설정 마법사가 먼저 실행됩니다. `FAILPROOFAI_NO_FIRST_RUN=1`로 이를 비활성화할 수 있습니다.

팩이 추가되기 전까지는 `block-failproofai-commands`만 정책을 집행합니다. 이 정책은 항상 활성화되어 있으며 끄거나 일시 중지할 수 없습니다. 집행을 일시 중지할 수 있는 에이전트는 다른 모든 정책도 끌 수 있기 때문입니다.

---

## 차단 대상

| 정책 | 차단 내용 |
|---|---|
| `block-env-files` | `.env` 및 기타 시크릿 파일 읽기 |
| `warn-repeated-tool-calls` | 동일한 툴 호출을 반복하는 에이전트 루프 |
| `block-sudo` | 권한 상승 |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, 조건 없는 `DELETE` |
| `block-terraform` / `block-kubectl` | 검토되지 않은 라이브 인프라 변경 |
| `block-rm-rf` | 재귀적 파일 삭제 |
| `block-force-push` / `block-push-master` | `git push --force`, `main` 브랜치로의 직접 푸시 |

이 모든 정책은 툴 호출을 실행 *전에* 차단하므로 12개 하네스 모두에서 동작합니다. 처음 네 가지는 툴을 호출할 수 있는 모든 에이전트에 적용되고, 나머지 세 가지는 개발자들이 가장 선호하는 정책입니다 — 코딩 CLI는 우리가 가장 깊이 지원하는 하네스 클래스입니다. `sanitize-*` 계열은 별도로 작동합니다. 툴이 반환된 후 실행되므로, 시크릿이 컨텍스트에 포함되지 않도록 막는 것이 아니라 툴 출력에서 시크릿을 감지해 보고합니다.

→ [39개의 기본 제공 정책 전체 보기](https://docs.befailproof.ai/policies/packs)

---

## 커스텀 정책

`.failproofai/policies/` 디렉터리에 파일을 추가하면 자동으로 로드됩니다 — 별도의 플래그가 필요 없습니다.
커밋하면 팀 전체가 다음 풀 때 적용됩니다.

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

→ [정책 작성하기](https://docs.befailproof.ai/policies/editor)

---

## 관측성

정책 집행은 절반에 불과합니다. 나머지 절반은 에이전트가 실제로 무엇을 했는지 파악하는 것입니다.

인수 없이 `failproofai`를 실행하면 `localhost:8020`에서 대시보드가 시작되며, 이미 머신에 저장된 실행 히스토리를 읽어옵니다 — 계정도, 회원가입도, 외부 전송도 없습니다. 세션 목록, 각 실행 내의 모델 호출 순서, 툴 호출, 훅 결정, 차단된 내용과 정책이 에이전트에 전달한 내용, 그리고 히스토리에서 위험 패턴을 스캔하고 차단할 정책을 제안하는 오프라인 감사(`failproofai audit`)를 제공합니다.

→ [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) ·
[트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) ·
[로컬 감사](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability**는 동일한 데이터 모델의 호스팅 버전으로, 플릿 전체에서 에이전트를 운영하는 팀을 위한 서비스입니다. 모든 하네스의 모든 실행을 한 곳에서 확인하고, 병렬 서브에이전트를 별도 레인으로 표시하는 실행 그래프, 모델·툴·훅의 p50/p95/p99 레이턴시, 모델별 비용 및 컨텍스트 윈도우 추적, 오류 추적, 공유 가능한 대시보드를 갖춘 자체 트레이스 SQL 쿼리, 자체 서비스로 점수를 매기는 평가, 반복적인 실패를 증거 기반 결과로 변환하는 예약 감사, Slack·이메일·서명된 웹훅으로의 알림 라우팅을 제공합니다. Enterprise 플랜에서는 자체 클러스터 셀프 호스팅도 지원합니다.

→ [세션](https://docs.befailproof.ai/sessions/overview) ·
[감사](https://docs.befailproof.ai/audits/overview) ·
[데모 예약](https://befailproof.ai/get-a-demo)

---

## 문서

| 시작하기 | |
|---|---|
| [빠른 시작](https://docs.befailproof.ai/start/quickstart) | 설치, 하네스 연결, 첫 번째 실행 확인 |
| [개념](https://docs.befailproof.ai/start/concepts) | 훅 시스템 작동 방식 |
| [지원 하네스](https://docs.befailproof.ai/reference/harnesses) | 12개 전체 및 각 하네스의 집행 범위 |

| 관측 | |
|---|---|
| [세션](https://docs.befailproof.ai/sessions/overview) | 실행 추적: 모델, 툴, 오류, 레이턴시 |
| [트레이스 읽기](https://docs.befailproof.ai/sessions/read-a-trace) | 실행 그래프가 말해주는 것 |
| [감사](https://docs.befailproof.ai/audits/overview) | 여러 세션에 걸친 실패 패턴 탐지 |
| [로컬 대시보드](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, 계정 불필요 |

| 집행 | |
|---|---|
| [정책 팩](https://docs.befailproof.ai/policies/packs) | Failproof AI 정책 및 정책 허브의 팩 |
| [정책 작성하기](https://docs.befailproof.ai/policies/editor) | 감사 결과 기반 또는 코드로 직접 작성 |
| [설정](https://docs.befailproof.ai/policies/local-configuration) | 설정 스코프, 병합 규칙 및 정책 파라미터 |

| 커스텀 에이전트 연동 | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | 하네스 없이 에이전트 실행을 보고 |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | allow / deny / instruct 레퍼런스 |

---

## 라이선스

[Commons Clause](https://commonsclause.com/)가 포함된 MIT 라이선스 — 내부 및 개인 사용은 무료이며, failproofai 자체의 상업적 재판매는 별도 계약이 필요합니다. 전문은 [LICENSE](../../LICENSE)를 참조하세요.

---

## 기여하기

[CONTRIBUTING.md](../../CONTRIBUTING.md)를 참조하세요. 새로운 정책, 엣지 케이스, 번역 모두 환영합니다.

> **시작 전에 빌드하세요.** 먼저 `bun install && bun run build`를 실행하세요. 이 저장소는
> failproofai 자체 훅을 자기 자신에게 적용하며, 훅은 컴파일된 `dist/` 번들에서 `failproofai` 임포트를 해석합니다 — 빌드 없이는 `Cannot find package 'failproofai'`
> 훅 오류가 발생합니다. `src/` 변경 후에는 다시 빌드하세요. 자세한 내용은
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)를 참조하세요.

---

SF와 벵갈루루에서 ❤️를 담아 [befailproof.ai](https://befailproof.ai)가 만들었습니다.
