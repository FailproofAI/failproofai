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

**Видьте, что делают ваши агенты. Остановите известные ошибки, прежде чем они повторятся.**
Failproof AI работает везде, где запускаются ваши агенты: инструменты кодирования вроде Claude Code и
Codex, шлюзы чатов вроде Hermes, самостоятельно размещённые ассистенты вроде OpenClaw и агенты,
которые вы инструментируете сами. Он записывает каждый запуск и может блокировать опасные вызовы инструментов
перед их выполнением.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

---

## Поддерживаемые платформы

Поддерживаются двенадцать платформ в двух классах: десять CLI для кодирования плюс два
шлюза: Hermes, OpenClaw. API политик и история сеансов являются общими; какие
события могут блокировать, зависит от платформы.

Агенты, которые не работают ни на одной из них, отправляют данные через [Python SDK](https://docs.befailproof.ai/reference/custom-agents),
который предоставляет вам трассировку, сеансы и аудиты. Обеспечение там требует хука в
вашем собственном runtime — [свяжитесь с нами](mailto:support@befailproof.ai) и мы его настроим.

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

Дайте совместимому агенту навык Failproof AI, если вы хотите, чтобы он направлял установку,
проверял машину и маршрутизировал политики, аудиты, сеансы и облачную работу правильно:

```sh
npx skills add FailproofAI/skills
```

Это устанавливает главный навык и его специализированные партнёры. Чтобы установить только
главный, добавьте `--skill failproofai`. Навыки предоставляют операционные инструкции; установите
и настройте сам продукт с помощью:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # панель управления на localhost:8020
```

Установка подключает поддерживаемых агентов и устанавливает фоновый сервис. Она не выбирает
пакет политик: прежде чем вы добавите один, только `block-failproofai-commands` запускается, чтобы
остановить агента, отключающего Failproof AI.

Подключитесь к облаку без подсказок с помощью `failproofai config --token <machine-key>`. На
общей машине или в CI установите `FAILPROOFAI_CLOUD_TOKEN` и запустите `failproofai config`,
чтобы ключ не появился в истории команд.

---

## Что он блокирует

| Политика | Что она блокирует |
|---|---|
| `sanitize-api-keys` | Утечки ключей API в контекст агента |
| `block-env-files` | Чтение файлов `.env` и других файлов секретов |
| `warn-repeated-tool-calls` | Агент зацикливается на одном и том же вызове |
| `block-sudo` | Повышение привилегий |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, неограниченный `DELETE` |
| `block-terraform` / `block-kubectl` | Непроверенные изменения инфраструктуры в продакшене |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `block-force-push` / `block-push-master` | `git push --force`, прямые push в `main` |

Эти политики защищают файлы, учётные данные, инфраструктуру, базы данных и рабочие процессы
агентов. Точная поддержка обеспечения варьируется в зависимости от платформы и события.

→ [Все 39 встроенных политик](https://docs.befailproof.ai/policies/builtin)

---

## Ваши собственные политики

Поместите файл в `.failproofai/policies/` — он загружается автоматически, флаги не требуются.
Зафиксируйте его, и вся команда получит его при следующем pull.

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

Три решения, доступные каждой политике:

| Решение | Эффект |
|---|---|
| `allow()` | Разрешить операцию |
| `deny(message)` | Заблокировать её — сообщение вернётся агенту |
| `instruct(message)` | Пропустить, но добавить контекст в следующий prompt агента |

→ [Руководство по пользовательским политикам](https://docs.befailproof.ai/policies/custom)

---

## Пакеты политик

Пакет политик — это версионированный набор политик, опубликованный из публичного репозитория GitHub.
Проверьте его перед установкой:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Что-либо со слэшем — это источник пакета; что-либо без него — имя политики.
Вы можете установить выбранные категории или политики и закрепить релиз при необходимости.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Посмотрите опубликованные пакеты в [Policy Hub](https://befailproof.ai/policy-hub/) или
запустите `failproofai publish --init`, чтобы начать свой собственный. Режим наблюдения позволяет
пакету записывать, что он бы сделал без блокирования: `failproofai publish --effect observe`.

→ [Пакеты политик](https://docs.befailproof.ai/policies/packs) ·
[Опубликовать пакет](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Наблюдаемость

Обеспечение — это одна сторона. Другая сторона — видеть, что действительно сделал агент.

Запустите `failproofai` без аргументов и он будет обслуживать панель управления на `localhost:8020`,
читая историю запусков, которая уже находится на вашей машине — никаких аккаунтов, никакой регистрации,
ничего не покидает ящик. Вы получаете список сеансов, последовательность вызовов модели, вызовы инструментов
и решения хука в каждом запуске, что было заблокировано и что политика сказала агенту, и офлайн-аудит
(`failproofai audit`), который сканирует вашу историю на предмет рискованных паттернов и предлагает
политики для их остановки.

→ [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) ·
[Прочитать трассировку](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Локальный аудит](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** — это размещённая часть той же модели данных для команд,
запускающих агентов на всём парке: каждый запуск от каждой платформы в одном месте, граф исполнения
с параллельными субагентами на их собственных дорожках, p50/p95/p99 задержка для моделей, инструментов
и хуков, затраты на модель и отслеживание окна контекста, отслеживание ошибок, SQL поверх ваших
собственных трассировок с общими панелями управления, оценки, оценённые вашим сервисом, планомерные
аудиты, которые превращают повторяющиеся ошибки в подтвержденные фактами выводы, и оповещения,
маршрутизируемые в Slack, по электронной почте или подписанному вебхуку. Самостоятельное размещение
в вашем собственном кластере доступно в плане Enterprise.

→ [Сеансы](https://docs.befailproof.ai/sessions/overview) ·
[Аудиты](https://docs.befailproof.ai/audits/overview) ·
[Запросить демо](https://befailproof.ai/get-a-demo)

---

## Документация

| Начало | |
|---|---|
| [Быстрый старт](https://docs.befailproof.ai/start/quickstart) | Установка, подключение платформы, первый запуск |
| [Концепции](https://docs.befailproof.ai/start/concepts) | Как работает система хуков |
| [Поддерживаемые платформы](https://docs.befailproof.ai/reference/harnesses) | Все 12, и что каждая может обеспечивать |

| Наблюдение | |
|---|---|
| [Сеансы](https://docs.befailproof.ai/sessions/overview) | Следите за запуском: модели, инструменты, ошибки, задержка |
| [Прочитать трассировку](https://docs.befailproof.ai/sessions/read-a-trace) | Что вам говорит граф исполнения |
| [Аудиты](https://docs.befailproof.ai/audits/overview) | Найти паттерны ошибок во многих сеансах |
| [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, аккаунт не требуется |

| Обеспечение | |
|---|---|
| [Встроенные политики](https://docs.befailproof.ai/policies/builtin) | Все 39 политик с параметрами |
| [Пользовательские политики](https://docs.befailproof.ai/policies/custom) | Напишите свои собственные |
| [Конфигурация](https://docs.befailproof.ai/policies/local-configuration) | Области конфигурации и правила слияния |

| Инструментируйте свой собственный агент | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Отправляйте запуски от агента без платформы |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Справка `allow` / `deny` / `instruct` |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — свободно для внутреннего и личного использования;
коммерческая перепродажа самого failproofai требует отдельного соглашения. Полный текст см. в [LICENSE](../../LICENSE).

---

## Участие в разработке

См. [CONTRIBUTING.md](../../CONTRIBUTING.md). Новые политики, граничные случаи и переводы всегда приветствуются.

> **Постройте перед началом.** Сначала запустите `bun install && bun run build`. Этот репозиторий запускает
> собственные хуки failproofai на себе, и они разрешают импорт `failproofai` против
> скомпилированного пакета `dist/` — без сборки вы получите ошибки хука `Cannot find package 'failproofai'`.
> Пересоберите после изменения `src/`. См.
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Создано с ❤️ командой [befailproof.ai](https://befailproof.ai) в Сан-Франциско и Бангалоре.
