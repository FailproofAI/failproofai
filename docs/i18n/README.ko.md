> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | **🇰🇷 한국어** | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**번역:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**코딩 에이전트를 위한 런타임 장애 해결 도구.**
Claude Code 및 Codex에 훅으로 연결됩니다. 루프, 위험한 작업, 시크릿 누출을
인시던트가 되기 전에 차단합니다. 지연 없음. 로컬에서 실행.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 지원되는 에이전트 CLI

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

> 하나 또는 여러 CLI를 조합하여 훅을 설치하세요: `failproofai policies --install --cli opencode pi` (또는 `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). `--cli`를 생략하면 설치된 CLI를 자동으로 감지하고 선택 프롬프트를 표시합니다.
>
> **Hermes** (hermes-agent, Slack/Telegram 게이트웨이)는 **실시간 훅 적용** (`--cli hermes` — 한 번의 설치로 모든 플랫폼과 서브에이전트의 도구 호출을 차단) 및 단일 `~/.hermes/state.db`의 게이트웨이 세션에 대한 오프라인 **감사** 재생 모두를 지원합니다.
>
> **OpenClaw** (openclaw gateway, 셀프호스팅 멀티채널 어시스턴트)는 **실시간 훅 적용** (`--cli openclaw`, 사용자 범위) 및 JSONL 세션(`~/.openclaw/agents/<id>/sessions/*.jsonl`)에 대한 오프라인 **감사** 재생 모두를 지원합니다. 적용은 OpenClaw의 **인프로세스 플러그인 훅**(비동기로 failproofai를 생성하는 `openclaw-plugin/`이 포함되어 있으며, 파일 기반 내부 훅은 관찰 전용으로 차단 불가)을 사용합니다: `before_tool_call`은 도구를 차단하고, `before_agent_finalize`는 실제 턴 종료 게이트로서 `require-*-before-stop` 내장 정책이 적용됩니다.
>
> **Factory Droid** (`droid`)는 **실시간 훅 적용** (`--cli factory`, 사용자 + 프로젝트 범위) 및 온디스크 JSONL 세션에 대한 오프라인 **감사** 재생 모두를 지원합니다. droid는 훅 **종료 코드 2**(JSON 결정이 아님)로 도구 호출을 차단하며, 턴 종료 `Stop` 이벤트에서만 `{decision:"block"}`을 지원합니다 — failproofai는 이벤트별로 올바른 형식을 자동으로 내보냅니다.
>
> **Devin CLI** (`devin`, Cognition)는 **실시간 훅 적용** (`--cli devin`, 사용자 + 프로젝트 범위) 및 SQLite 세션(`~/.local/share/devin/cli/sessions.db`)에 대한 오프라인 **감사** 재생 모두를 지원합니다. Devin은 **순수 Claude 클론**으로, 동일한 이벤트 이름, 동일한 snake_case 페이로드, 동일한 `"hooks"` 래퍼 설정(`~/.config/devin/config.json` / `<cwd>/.devin/config.json`)을 사용하며, 모든 이벤트에서 `{decision:"block"}` JSON으로 차단합니다.
>
> **Antigravity CLI** (`agy`)는 **실시간 훅 적용** (`--cli antigravity`, 사용자 + 프로젝트 범위) 및 플레인 JSONL 세션(`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`)에 대한 오프라인 **감사** 재생 모두를 지원합니다. Antigravity는 **자체** 계약 방식(Claude 클론이 아님)을 사용합니다: **named-hook** `hooks.json` 스키마(`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), failproofai가 정규화하는 camelCase stdin 페이로드, 그리고 고유한 응답 형식 — 도구 차단 시 `{decision:"deny"}`, `Stop`에서 다음 턴 강제 진행 시 `{decision:"continue"}`, 모델 실행 전 리마인더 주입 시 `{injectSteps}`.
>
> **Goose** (코드명 goose, Block)는 **실시간 훅 적용** (`--cli goose`, 사용자 + 프로젝트 범위) 및 SQLite 세션(`~/.local/share/goose/sessions/sessions.db`)에 대한 오프라인 **감사** 재생 모두를 지원합니다. 적용은 Goose의 **훅** 시스템(크로스 에이전트 **Open Plugins** 스펙)을 사용하며 — 설치 시 `~/.agents/plugins/failproofai/`에 플러그인 디렉터리를 생성하면 Goose가 자동으로 감지합니다. 차단은 `PreToolUse` 이벤트에서 `{"decision":"block"}` JSON을 사용하며(셸 도구 및 위임된 서브에이전트 내부에서 발생), goose v1.43.0에서 실제 검증되었습니다; Goose에는 턴 종료 `Stop` 이벤트가 없으므로 `require-*-before-stop` 내장 정책은 적용되지 않습니다(Hermes와 동일).

---

## 설치

```sh
npm install -g failproofai
failproofai policies --install   # 또는 `failproofai`를 실행하고 첫 실행 프롬프트에서 수락
failproofai
```

30개의 내장 정책이 즉시 활성화됩니다. 대시보드는 `localhost:8020`에서 확인할 수 있습니다. `FAILPROOFAI_NO_FIRST_RUN=1`로 첫 실행 프롬프트를 비활성화할 수 있습니다.

---

## 차단하는 항목

| 정책 | 차단 내용 |
|---|---|
| `block-push-master` | `main` / `master` 브랜치로의 직접 푸시 |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master`에서의 커밋, 머지, 리베이스 |
| `block-rm-rf` | 재귀적 파일 삭제 |
| `sanitize-api-keys` | 에이전트 컨텍스트로 누출되는 API 키 |

→ [30개 내장 정책 전체 보기](https://docs.befailproof.ai/built-in-policies)

---

## 커스텀 정책

`.failproofai/policies/` 디렉터리에 파일을 추가하면 — 별도의 플래그 없이 자동으로 로드됩니다.
커밋하면 팀 전체가 다음 풀 시 적용받습니다.

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

| 결정 | 효과 |
|---|---|
| `allow()` | 작업 허용 |
| `deny(message)` | 차단 — 메시지가 에이전트에게 반환됨 |
| `instruct(message)` | 통과 허용, 하지만 에이전트의 다음 프롬프트에 컨텍스트 추가 |

→ [커스텀 정책 가이드](https://docs.befailproof.ai/custom-policies)

---

## 세션 가시성

에이전트가 실행하는 모든 도구 호출은 로컬에 기록됩니다. 대시보드에서 무엇이 실행되었는지,
무엇이 차단되었는지, 정책이 에이전트에게 무엇을 알렸는지 확인할 수 있어 — 문제가 발생했을 때
추측할 필요가 없습니다. → [대시보드 가이드](https://docs.befailproof.ai/dashboard)

---

## 문서

| | |
|---|---|
| [시작하기](https://docs.befailproof.ai/getting-started) | 설치 및 첫 번째 단계 |
| [내장 정책](https://docs.befailproof.ai/built-in-policies) | 파라미터가 포함된 30개 정책 전체 |
| [커스텀 정책](https://docs.befailproof.ai/custom-policies) | 직접 작성하기 |
| [설정](https://docs.befailproof.ai/configuration) | 설정 범위 및 병합 규칙 |
| [대시보드](https://docs.befailproof.ai/dashboard) | 세션 모니터 및 정책 활동 |
| [아키텍처](https://docs.befailproof.ai/architecture) | 훅 시스템 작동 방식 |

---

## 라이선스

[Commons Clause](https://commonsclause.com/)가 포함된 MIT — 내부 및 개인 사용은 무료이며, failproofai 자체의 상업적 재판매는 별도 계약이 필요합니다. 전문은 [LICENSE](./LICENSE)를 참조하세요.

---

## 기여

[CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요. 새로운 정책, 엣지 케이스, 번역 모두 환영합니다.

> **시작 전에 빌드하세요.** 먼저 `bun install && bun run build`를 실행하세요. 이 저장소는
> failproofai의 자체 훅을 스스로에게 적용하며, `failproofai` 임포트를 컴파일된 `dist/` 번들로 해석합니다 —
> 빌드 없이는 `Cannot find package 'failproofai'` 훅 오류가 발생합니다. `src/`를 변경한 후에는 다시 빌드하세요.
> [저장소 내 개발 훅이 동작하려면 빌드가 필요합니다](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)를 참고하세요.

---

[Nivedit Jain](https://github.com/NiveditJain)과 [Nikita Agarwal](https://github.com/nk-ag)이 만들었습니다.
[befailproof.ai](https://befailproof.ai)
