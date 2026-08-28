> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | **🇷🇺 Русский** | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Переводы:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Наблюдаемость и контроль для каждой платформы, на которой работают ваши агенты.**
Где бы ни работали ваши агенты, мы видим это — и мы можем остановить опасные действия. Failproof интегрируется с 12 платформами для запуска агентов — от кодовых CLI, таких как Claude Code и Codex, до шлюзов чатов, таких как Hermes, и самостоятельных ассистентов, таких как OpenClaw — перехватывая каждый запуск и блокируя опасные вызовы инструментов до их выполнения. 39 встроенных политик. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

---

## Поддерживаемые платформы

Двенадцать платформ в двух классах — десять кодовых CLI и два шлюза для чатов и ассистентов (Hermes, OpenClaw). Одни и те же события, одни и те же политики, одна и та же история сеансов, независимо от платформы, на которой работает ваш агент.

Агенты, работающие ни на одной из них, отправляют отчёты через [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
который предоставляет вам трассировку, сеансы и аудиты. Контроль там требует подключения в вашей собственной среде выполнения — [свяжитесь с нами](mailto:support@befailproof.ai) и мы поможем.

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

## Установка

```sh
npm install -g failproofai
failproofai policies --install   # или просто запустите `failproofai` и примите подсказку при первом запуске
failproofai
```

39 встроенных политик активируются немедленно. Панель управления доступна на `localhost:8020`. Отключите подсказку при первом запуске с помощью `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Что блокируется

| Политика | Что блокируется |
|---|---|
| `sanitize-api-keys` | Утечка ключей API в контекст агента |
| `block-env-files` | Чтение файлов `.env` и других файлов с секретами |
| `warn-repeated-tool-calls` | Агент зацикливается на одном и том же вызове |
| `block-sudo` | Повышение привилегий |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, неограниченные `DELETE` |
| `block-terraform` / `block-kubectl` | Непроверенные изменения активной инфраструктуры |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `block-force-push` / `block-push-master` | `git push --force`, прямые толчки в `main` |

Первые пять применяются к любому агенту, который может вызвать инструмент. Последние три — фавориты разработчиков — кодовые CLI — это класс платформ, который мы охватываем наиболее глубоко.

→ [Все 39 встроенных политик](https://docs.befailproof.ai/policies/builtin)

---

## Ваши собственные политики

Добавьте файл в `.failproofai/policies/` — он загружается автоматически без дополнительных флагов.
Закоммитьте его и вся команда получит его при следующем pull.

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

Три решения доступны для каждой политики:

| Решение | Эффект |
|---|---|
| `allow()` | Разрешить операцию |
| `deny(message)` | Заблокировать — сообщение вернётся агенту |
| `instruct(message)` | Пропустить, но добавить контекст в следующий запрос агента |

→ [Руководство по пользовательским политикам](https://docs.befailproof.ai/policies/custom)

---

## Наблюдаемость

Контроль — это одна половина. Другая половина — видеть, что на самом деле сделал агент.

Запустите `failproofai` без аргументов и он будет служить панель управления на `localhost:8020`,
читая историю запусков уже находящуюся на вашей машине — никаких учётных записей, никаких регистраций, ничего не покидает периметр. Вы получаете список сеансов, последовательность вызовов моделей, вызовов инструментов и решений подключений в каждом запуске, что было заблокировано и что политика сообщила агенту, а также автономный аудит (`failproofai audit`), который сканирует вашу историю на предмет рискованных паттернов и предлагает политики для их остановки.

→ [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) ·
[Чтение трассировки](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Локальный аудит](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** — это размещённая сторона той же модели данных, для команд,
запускающих агентов по всему флоту: каждый запуск от каждой платформы в одном месте, граф выполнения с параллельными под-агентами на их собственных линиях, p50/p95/p99 задержка для моделей, инструментов и подключений, стоимость и отслеживание окна контекста для каждой модели, отслеживание ошибок, SQL по вашим собственным трассам с общими панелями управления, оценки, оценённые вашей собственной службой, запланированные аудиты, которые превращают повторяющиеся сбои в подтверждённые выводы, и оповещения, направленные в Slack, электронную почту или подписанный webhook. Собственное хостирование в вашем собственном кластере доступно в плане Enterprise.

→ [Сеансы](https://docs.befailproof.ai/sessions/overview) ·
[Аудиты](https://docs.befailproof.ai/audits/overview) ·
[Запросить демонстрацию](https://befailproof.ai/get-a-demo)

---

## Документация

| Начало | |
|---|---|
| [Быстрый старт](https://docs.befailproof.ai/start/quickstart) | Установка, подключение платформы, первый запуск |
| [Концепции](https://docs.befailproof.ai/start/concepts) | Как работает система подключений |
| [Поддерживаемые платформы](https://docs.befailproof.ai/reference/harnesses) | Все 12 и что может контролировать каждая |

| Наблюдение | |
|---|---|
| [Сеансы](https://docs.befailproof.ai/sessions/overview) | Отследите запуск: модели, инструменты, ошибки, задержка |
| [Чтение трассировки](https://docs.befailproof.ai/sessions/read-a-trace) | Что вам говорит граф выполнения |
| [Аудиты](https://docs.befailproof.ai/audits/overview) | Найдите паттерны сбоев в нескольких сеансах |
| [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, никакой учётной записи не требуется |

| Контроль | |
|---|---|
| [Встроенные политики](https://docs.befailproof.ai/policies/builtin) | Все 39 политик с параметрами |
| [Пользовательские политики](https://docs.befailproof.ai/policies/custom) | Напишите свои |
| [Конфигурация](https://docs.befailproof.ai/policies/local-configuration) | Области конфигурации и правила слияния |

| Инструмент вашего собственного агента | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Отправляйте отчёты от агента без платформы |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Справка `allow` / `deny` / `instruct` |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — свободна для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. См. [LICENSE](../../LICENSE) для полного текста.

---

## Вклад

Смотрите [CONTRIBUTING.md](../../CONTRIBUTING.md). Новые политики, граничные случаи и переводы приветствуются.

> **Постройте перед началом.** Запустите `bun install && bun run build` в первый раз. Этот репозиторий запускает собственные подключения failproofai на себе, и они разрешают импорт `failproofai` для скомпилированного пакета `dist/` — без сборки вы получите ошибки подключения `Cannot find package 'failproofai'`. Перестройте после изменения `src/`. Смотрите
> [Постройте перед тем, как в-репо девелопер подключения будут работать](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Создано с ❤️ командой [befailproof.ai](https://befailproof.ai) в Сан-Франциско и Бангалоре.
