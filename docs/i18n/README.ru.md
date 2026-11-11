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

**Наблюдение и контроль для каждого фреймворка, в котором работают ваши агенты.**
Где бы ни запускались ваши агенты, мы их видим — и можем их остановить. Failproof интегрируется с 12 фреймворками для агентов — кодировочными CLI, такими как Claude Code и Codex, шлюзами чата, такими как Hermes, локально размещёнными ассистентами, такими как OpenClaw — перехватывает каждый запуск и блокирует опасные вызовы инструментов до их выполнения. 40 встроенных политик. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

---

## Поддерживаемые фреймворки

Двенадцать фреймворков в двух категориях — десять кодировочных CLI и два шлюза для чата и ассистентов (Hermes, OpenClaw). Один API политик и одна история сессий для всех них. То, что может *блокировать* политика, зависит от фреймворка: остановка вызова инструмента перед его выполнением проверяется во всех двенадцати, конец хода обрабатывается в восьми. [Матрица возможностей по фреймворкам](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) содержит список событий, которые каждый фреймворк поддерживает.

Агенты, которые не работают ни в одном из них, передают данные через [Python SDK](https://docs.befailproof.ai/reference/custom-agents), который предоставляет трассировку, сессии и аудиты. Контроль там требует подхвата в вашем собственном окружении — [свяжитесь с нами](mailto:support@befailproof.ai) и мы поможем с отображением.

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
failproofai policies add FailproofAI/policies  # выберите, что контролировать
failproofai                                    # панель управления на localhost:8020
```

Настройка подключает подхваты и выбирает **никаких** политик — вторая команда — это то, что устанавливает ограничения на машину, и любой набор вводится так же (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` сначала читает один). Запустите `failproofai config` без терминала — CI, контейнер, агент управляет им — и он применяется вместо вопросов. На машине, которая никогда не была настроена, любая другая команда сначала запускает тот же мастер; отключите это с помощью `FAILPROOFAI_NO_FIRST_RUN=1`.

До прибытия набора единственное, что контролирует, это `block-failproofai-commands`, что всегда активно и не может быть отключено или приостановлено: агент, который может приостановить контроль, может отключить все остальные политики.

---

## Что это блокирует

| Политика | Что она блокирует |
|---|---|
| `block-env-files` | Чтение файлов `.env` и других файлов с секретами |
| `warn-repeated-tool-calls` | Цикл агента на одном и том же вызове |
| `block-sudo` | Повышение привилегий |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, неограниченный `DELETE` |
| `block-terraform` / `block-kubectl` | Непроверенные изменения реальной инфраструктуры |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `block-force-push` / `block-push-master` | `git push --force`, прямые отправки на `main` |

Каждая из них останавливает вызов *перед* его выполнением, поэтому они работают во всех двенадцати фреймворках. Первые четыре применяются к любому агенту, который может вызвать инструмент; последние три — любимые разработчиков — кодировочные CLI — это класс фреймворков, который мы покрываем глубже всего. Семейство `sanitize-*` отдельно: оно запускается после возврата инструмента, поэтому сообщает о секрете в выходе инструмента, а не удерживает его из контекста.

→ [Все 40 встроенных политик](https://docs.befailproof.ai/policies/packs)

---

## Ваши собственные политики

Бросьте файл в `.failproofai/policies/` — он загружается автоматически, никаких флагов не требуется.
Коммитьте его и вся команда получит его при следующем пуле.

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

Три решения, доступные для каждой политики:

| Решение | Эффект |
|---|---|
| `allow()` | Разрешить операцию |
| `deny(message)` | Блокировать её — сообщение возвращается агенту |
| `instruct(message)` | Пропустить, но добавить контекст к следующему приглашению агента |

→ [Написать политику](https://docs.befailproof.ai/policies/editor)

---

## Наблюдение

Контроль — это одна половина. Другая половина — видеть, что агент действительно сделал.

Запустите `failproofai` без аргументов и он будет служить панель управления на `localhost:8020`, читая историю запусков уже на вашей машине — никакого аккаунта, никакой регистрации, ничего, уходящего из коробки. Вы получаете список сессий, последовательность вызовов модели, вызовов инструментов и решений подхватов внутри каждого запуска, что было блокировано и что политика рассказала агенту, и автономный аудит (`failproofai audit`), который сканирует вашу историю на предмет рискованных паттернов и предлагает политики для их остановки.

→ [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) ·
[Прочитать трассировку](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Локальный аудит](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** — это размещённая сторона той же модели данных для команд, запускающих агентов в парке машин: каждый запуск из каждого фреймворка в одном месте, граф выполнения с параллельными под-агентами на своих полосах, задержка p50/p95/p99 для моделей, инструментов и подхватов, стоимость для каждой модели и отслеживание окна контекста, отслеживание ошибок, SQL над вашими собственными трассировками с общедоступными панелями управления, оценки, оцениваемые вашим собственным сервисом, запланированные аудиты, которые превращают повторяющиеся сбои в основанные на доказательствах находки, и оповещения, направленные в Slack, электронную почту или подписанный вебхук. Самостоятельное размещение в вашем собственном кластере доступно на плане Enterprise.

→ [Сессии](https://docs.befailproof.ai/sessions/overview) ·
[Аудиты](https://docs.befailproof.ai/audits/overview) ·
[Забронировать демонстрацию](https://befailproof.ai/get-a-demo)

---

## Документация

| Начало | |
|---|---|
| [Быстрый старт](https://docs.befailproof.ai/start/quickstart) | Установка, подключение фреймворка, просмотр первого запуска |
| [Концепции](https://docs.befailproof.ai/start/concepts) | Как работает система подхватов |
| [Поддерживаемые фреймворки](https://docs.befailproof.ai/reference/harnesses) | Все 12 и что каждый может контролировать |

| Наблюдение | |
|---|---|
| [Сессии](https://docs.befailproof.ai/sessions/overview) | Следуйте запуску: модели, инструменты, ошибки, задержка |
| [Прочитать трассировку](https://docs.befailproof.ai/sessions/read-a-trace) | Что вам говорит граф выполнения |
| [Аудиты](https://docs.befailproof.ai/audits/overview) | Найдите паттерны сбоев во многих сессиях |
| [Локальная панель управления](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, никакого аккаунта не требуется |

| Контроль | |
|---|---|
| [Наборы политик](https://docs.befailproof.ai/policies/packs) | Политики Failproof AI и наборы из хаба политик |
| [Написать политику](https://docs.befailproof.ai/policies/editor) | Из аудита или в коде |
| [Конфигурация](https://docs.befailproof.ai/policies/local-configuration) | Области конфигурации, правила слияния и параметры политик |

| Инструментируйте свой собственный агент | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Передавайте запуски от агента без фреймворка |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Справка по `allow` / `deny` / `instruct` |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — бесплатно для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. Смотрите [LICENSE](../../LICENSE) для полного текста.

---

## Участие в проекте

Смотрите [CONTRIBUTING.md](../../CONTRIBUTING.md). Новые политики, пограничные случаи и переводы приветствуются.

---

Создано с ❤️ командой [befailproof.ai](https://befailproof.ai) в Сан-Франциско и Бангалоре.
