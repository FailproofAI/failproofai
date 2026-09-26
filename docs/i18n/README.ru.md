> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | **🇷🇺 Русский** | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Переводы:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Наблюдаемость и контроль для каждого окружения, в котором работают ваши агенты.**
Где бы ни работали ваши агенты, мы это видим — и мы можем их остановить. Failproof подключается к 12 окружениям агентов — средам разработки кода, таким как Claude Code и Codex, шлюзам чата, таким как Hermes, самохостируемым ассистентам, таким как OpenClaw — перехватывая каждый запуск и блокируя опасные вызовы инструментов до их выполнения. 39 встроенных политик. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

---

## Поддерживаемые окружения

Двенадцать окружений в двух категориях — десять интерфейсов командной строки для разработки, и два шлюза чата и ассистентов (Hermes, OpenClaw). Один API политик и одна история сеансов для всех. То, что политика может *заблокировать*, зависит от окружения: остановка вызова инструмента до его выполнения проверяется на всех двенадцати, врата конца хода работают на восьми. [Матрица по окружениям](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) перечисляет события, которые признает каждое.

Агенты, работающие в других окружениях, могут отправлять отчеты через [Python SDK](https://docs.befailproof.ai/reference/custom-agents), который предоставляет трассировку, сеансы и аудит. Контроль там требует подключения в вашем собственном окружении выполнения — [свяжитесь с нами](mailto:support@befailproof.ai) и мы это сопоставим.

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
failproofai config                             # подключите ваши агенты и демон
failproofai policies add FailproofAI/policies  # выберите, что нужно контролировать
failproofai                                    # панель на localhost:8020
```

Настройка подключает крючки и не выбирает **никаких** политик — вторая команда это то, что ставит защиту на машину, и любой пакет вводится одинаково (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` сначала читает один). Запустите `failproofai config` без терминала — CI, контейнер, агент его запускающий — и он применит вместо того чтобы спрашивать. На машине, которая никогда не была настроена, любая другая команда сначала запускает тот же мастер; отключите это с `FAILPROOFAI_NO_FIRST_RUN=1`.

Пока пакет не прибыл, единственное что контролирует `block-failproofai-commands`, что всегда включено и не может быть отключено или приостановлено: агент, который может приостановить контроль, может отключить все остальные политики.

---

## Что это блокирует

| Политика | Что она блокирует |
|---|---|
| `block-env-files` | Чтение файлов `.env` и других файлов с секретами |
| `warn-repeated-tool-calls` | Агент повторяющий один и тот же вызов |
| `block-sudo` | Повышение привилегий |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, неограниченный `DELETE` |
| `block-terraform` / `block-kubectl` | Неревьюированные изменения живой инфраструктуры |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `block-force-push` / `block-push-master` | `git push --force`, прямые пуши в `main` |

Каждая из них перехватывает вызов *перед* его выполнением, поэтому они работают на всех двенадцати окружениях. Первые четыре применяются к любому агенту, который может вызвать инструмент; последние три — любимые разработчиками — интерфейсы командной строки для разработки — это класс окружения, который мы покрываем глубже всего. Семейство `sanitize-*` отдельно: оно работает после возврата инструмента, поэтому оно находит секрет в выходных данных инструмента, а не предотвращает его попадание в контекст.

→ [Все 39 встроенных политик](https://docs.befailproof.ai/policies/packs)

---

## Ваши собственные политики

Поместите файл в `.failproofai/policies/` — он автоматически загружается, без флагов. Зафиксируйте это и вся команда получит это при следующем пуле.

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
| `deny(message)` | Заблокировать — сообщение вернется агенту |
| `instruct(message)` | Пропустить, но добавить контекст в следующий промпт агента |

→ [Напишите политику](https://docs.befailproof.ai/policies/editor)

---

## Наблюдаемость

Контроль — это одна половина. Другая половина — видеть то, что агент на самом деле сделал.

Запустите `failproofai` без аргументов и он предоставит панель на `localhost:8020` читая историю запусков, которая уже на вашей машине — без аккаунта, без регистрации, ничего не покидает коробку. Вы получаете список сеансов, последовательность вызовов модели, вызовов инструментов и решений подключений внутри каждого запуска, что было заблокировано и что политика рассказала агенту, и автономный аудит (`failproofai audit`), который сканирует вашу историю на предмет рискованных паттернов и предлагает политики для их остановки.

→ [Локальная панель](https://docs.befailproof.ai/reference/local-dashboard) ·
[Прочитайте трассировку](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Локальный аудит](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** — это размещенная сторона той же модели данных, для команд работающих с агентами по флоту: каждый запуск из каждого окружения в одном месте, граф выполнения с параллельными под-агентами на их собственных полосах, p50/p95/p99 задержки для моделей, инструментов и подключений, затраты по моделям и отслеживание окна контекста, отслеживание ошибок, SQL через ваши собственные трассировки с общими панелями, оценки выставленные вашим собственным сервисом, запланированные аудиты которые превращают повторяющиеся сбои в доказательства, и уведомления маршрутизируемые на Slack, электронную почту или подписанный вебхук. Самохостирование в вашем собственном кластере доступно на плане Enterprise.

→ [Сеансы](https://docs.befailproof.ai/sessions/overview) ·
[Аудиты](https://docs.befailproof.ai/audits/overview) ·
[Заказать демо](https://befailproof.ai/get-a-demo)

---

## Документация

| Начало | |
|---|---|
| [Быстрый старт](https://docs.befailproof.ai/start/quickstart) | Установите, подключите окружение, увидьте первый запуск |
| [Концепции](https://docs.befailproof.ai/start/concepts) | Как работает система подключений |
| [Поддерживаемые окружения](https://docs.befailproof.ai/reference/harnesses) | Все 12 и что каждое может контролировать |

| Наблюдение | |
|---|---|
| [Сеансы](https://docs.befailproof.ai/sessions/overview) | Следите за запуском: модели, инструменты, ошибки, задержка |
| [Прочитайте трассировку](https://docs.befailproof.ai/sessions/read-a-trace) | Что граф выполнения вам говорит |
| [Аудиты](https://docs.befailproof.ai/audits/overview) | Найдите паттерны сбоев на многих сеансах |
| [Локальная панель](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, аккаунт не требуется |

| Контроль | |
|---|---|
| [Пакеты политик](https://docs.befailproof.ai/policies/packs) | Политики Failproof AI и пакеты из хаба политик |
| [Напишите политику](https://docs.befailproof.ai/policies/editor) | Из аудита или в коде |
| [Конфигурация](https://docs.befailproof.ai/policies/local-configuration) | Масштабы конфигурации, правила слияния и параметры политики |

| Инструментируйте ваш собственный агент | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Отправляйте запуски от агента без окружения |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Справка `allow` / `deny` / `instruct` |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — свободно для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. Смотрите [LICENSE](../../LICENSE) для полного текста.

---

## Вклад

Смотрите [CONTRIBUTING.md](../../CONTRIBUTING.md). Новые политики, граничные случаи и переводы приветствуются.

> **Построить перед началом.** Сначала запустите `bun install && bun run build`. Этот репозиторий запускает собственные подключения failproofai на себе, и они разрешают импорт `failproofai` к скомпилированному пакету `dist/` — без построения вы получите ошибки подключений `Cannot find package 'failproofai'`. Пересоберите после изменения `src/`. Смотрите [Построить перед работой встроенных подключений разработки](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Построено с ❤️ [befailproof.ai](https://befailproof.ai) в SF и Bengaluru.
