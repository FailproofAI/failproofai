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
Claude Code 및 Codex에 연동됩니다. 루프, 위험한 동작, 시크릿 유출을
인시던트가 되기 전에 차단합니다. 지연 시간 없음. 로컬에서 실행.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## 지원하는 에이전트 CLI

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> 하나 또는 원하는 조합으로 훅을 설치하세요: `failproofai policies --install --cli opencode pi gemini` (또는 `--cli claude codex copilot cursor opencode pi gemini`). `--cli`를 생략하면 설치된 CLI를 자동으로 감지하고 선택을 묻습니다.

---

## 설치

```sh
npm install -g failproofai
failproofai policies --install   # 또는 그냥 `failproofai`를 실행하고 최초 실행 프롬프트에서 수락
failproofai
```

30개의 내장 정책이 즉시 활성화됩니다. 대시보드는 `localhost:8020`에서 확인할 수 있습니다. 최초 실행 프롬프트를 비활성화하려면 `FAILPROOFAI_NO_FIRST_RUN=1`을 설정하세요.

---

## 차단하는 항목

| 정책 | 차단 내용 |
|---|---|
| `block-push-master` | `main` / `master`로의 직접 푸시 |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master`에서의 커밋, 머지, 리베이스 |
| `block-rm-rf` | 재귀적 파일 삭제 |
| `sanitize-api-keys` | 에이전트 컨텍스트로 유출되는 API 키 |

→ [내장 정책 30개 전체 보기](https://docs.befailproof.ai/built-in-policies)

---

## 나만의 정책

`.failproofai/policies/` 폴더에 파일을 추가하면 별도 설정 없이 자동으로 로드됩니다.
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

| 결정 | 동작 |
|---|---|
| `allow()` | 작업 허용 |
| `deny(message)` | 차단 — 메시지가 에이전트에게 반환됨 |
| `instruct(message)` | 통과 허용, 단 에이전트의 다음 프롬프트에 컨텍스트 추가 |

→ [커스텀 정책 가이드](https://docs.befailproof.ai/custom-policies)

---

## 세션 가시성

에이전트가 실행하는 모든 도구 호출이 로컬에 기록됩니다. 대시보드에서 실행된 내용,
차단된 내용, 정책이 에이전트에게 전달한 내용을 확인할 수 있어 — 문제가 발생했을 때
추측에 의존할 필요가 없습니다. → [대시보드 가이드](https://docs.befailproof.ai/dashboard)

---

## 문서

| | |
|---|---|
| [시작하기](https://docs.befailproof.ai/getting-started) | 설치 및 첫 번째 단계 |
| [내장 정책](https://docs.befailproof.ai/built-in-policies) | 파라미터를 포함한 30개 정책 전체 |
| [커스텀 정책](https://docs.befailproof.ai/custom-policies) | 직접 작성하기 |
| [설정](https://docs.befailproof.ai/configuration) | 설정 범위 및 병합 규칙 |
| [대시보드](https://docs.befailproof.ai/dashboard) | 세션 모니터 및 정책 활동 |
| [아키텍처](https://docs.befailproof.ai/architecture) | 훅 시스템 동작 원리 |

---

## 라이선스

[Commons Clause](https://commonsclause.com/)가 포함된 MIT 라이선스 — 내부 및 개인 사용은 무료이며, failproofai 자체의 상업적 재판매는 별도 계약이 필요합니다. 전문은 [LICENSE](./LICENSE)를 참고하세요.

---

## 기여하기

[CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요. 새로운 정책, 엣지 케이스, 번역 모두 환영합니다.

> **시작하기 전에 빌드하세요.** 먼저 `bun install && bun run build`를 실행하세요. 이 저장소는
> failproofai 자체 훅을 스스로에게 적용하며, `failproofai` 임포트를 컴파일된 `dist/` 번들로
> 해석합니다 — 빌드 없이는 `Cannot find package 'failproofai'` 훅 오류가 발생합니다.
> `src/`를 수정한 후에는 다시 빌드하세요. 자세한 내용은
> [저장소 내 개발 훅이 동작하려면 빌드가 먼저입니다](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)를 참고하세요.

---

[Nivedit Jain](https://github.com/NiveditJain)과 [Nikita Agarwal](https://github.com/nk-ag)이 만들었습니다.
[befailproof.ai](https://befailproof.ai)
