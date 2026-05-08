> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | **🇷🇺 Русский** | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**Переводы**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

Самый простой способ управлять политиками, которые поддерживают ваши AI-агентов надёжными, сосредоточенными на задачах и работающими автономно — для **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(бета)_, **Cursor Agent** _(бета)_, **OpenCode** _(бета)_, **Pi** _(бета)_, **Gemini CLI** _(бета)_ и **Agents SDK**.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

## Поддерживаемые CLI агентов

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

> Установите хуки для одного или нескольких из них: `failproofai policies --install --cli opencode pi gemini` (или `--cli claude codex copilot cursor opencode pi gemini`). Опустите `--cli` для автоматического обнаружения установленных CLI и подсказок. **Поддержка GitHub Copilot CLI, Cursor Agent, OpenCode, Pi и Gemini CLI находится в бета-версии — тестирование продолжается.**

- **39 встроенных политик** — ловите типичные режимы отказа агентов из коробки. Блокируйте деструктивные команды, предотвращайте утечку секретов, держите агентов внутри границ проекта, обнаруживайте циклы и многое другое.
- **Пользовательские политики** — напишите свои собственные правила надёжности на JavaScript. Используйте API `allow`/`deny`/`instruct` для принятия соглашений, предотвращения дрейфа, контроля операций или интеграции с внешними системами.
- **Простая конфигурация** — настройте любую политику без написания кода. Установите белые списки, защищённые ветви, пороги для отдельных проектов или глобально. Конфигурация с тремя областями объединяется автоматически.
- **Монитор агентов** — смотрите, что делали ваши агенты, пока вас не было. Просматривайте сессии, инспектируйте каждый вызов инструмента и проверяйте ровно то, где срабатывали политики.

Всё работает локально — никакие данные не покидают вашу машину.

---

## Требования

- Node.js >= 20.9.0
- Bun >= 1.3.0 (опционально — требуется только для разработки / сборки из исходного кода)

---

## Установка

```bash
npm install -g failproofai
# или
bun add -g failproofai
```

---

## Быстрый старт

### 1. Включите политики глобально

```bash
failproofai policies --install
```

Записывает записи хуков в `~/.claude/settings.json`. Claude Code теперь будет вызывать failproofai до и после каждого вызова инструмента.

### 2. Запустите панель управления

```bash
failproofai
```

Открывает `http://localhost:8020` — просматривайте сессии, инспектируйте логи, управляйте политиками.

### 3. Проверьте, что активно

```bash
failproofai policies
```

---

## Установка политик

### Области видимости

| Область видимости | Команда | Где записывается |
|-------|---------|-----------------|
| Глобальная (по умолчанию) | `failproofai policies --install` | `~/.claude/settings.json` |
| Проект | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Локальная | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Установите конкретные политики

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Удалите политики

```bash
failproofai policies --uninstall
# или для конкретной области видимости:
failproofai policies --uninstall --scope project
```

---

## Конфигурация

Конфигурация политик находится в `~/.failproofai/policies-config.json` (глобально) или `.failproofai/policies-config.json` в вашем проекте (для каждого проекта).

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "Используйте apt-get напрямую без sudo."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Попробуйте создать свежую ветку вместо этого."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**Три области конфигурации** объединяются автоматически (проект → локальная → глобальная). Полные правила объединения см. в [docs/configuration.mdx](docs/configuration.mdx).

---

## Встроенные политики

| Политика | Описание | Настраивается |
|--------|-------------|:---:|
| `block-sudo` | Предотвратить выполнение привилегированных системных команд агентами | `allowPatterns` |
| `block-rm-rf` | Предотвратить случайное рекурсивное удаление файлов | `allowPaths` |
| `block-curl-pipe-sh` | Предотвратить перенаправление ненадёжных скриптов в shell | |
| `block-failproofai-commands` | Предотвратить самоудаление | |
| `sanitize-jwt` | Остановить утечку JWT-токенов в контекст агента | |
| `sanitize-api-keys` | Остановить утечку API-ключей в контекст агента | `additionalPatterns` |
| `sanitize-connection-strings` | Остановить утечку учётных данных БД в контекст агента | |
| `sanitize-private-key-content` | Скрыть блоки приватных ключей PEM из вывода | |
| `sanitize-bearer-tokens` | Скрыть токены Authorization Bearer из вывода | |
| `block-env-files` | Удерживать агентов от чтения .env-файлов | |
| `protect-env-vars` | Предотвратить печать переменных окружения агентами | |
| `block-read-outside-cwd` | Держать агентов внутри границ проекта | `allowPaths` |
| `block-secrets-write` | Предотвратить запись в файлы приватных ключей и сертификатов | `additionalPatterns` |
| `block-push-master` | Предотвратить случайные отправки в main/master | `protectedBranches` |
| `block-work-on-main` | Удерживать агентов от защищённых ветвей | `protectedBranches` |
| `block-force-push` | Предотвратить `git push --force` | |
| `warn-git-amend` | Напомнить агентам перед переписанием коммитов | |
| `warn-git-stash-drop` | Напомнить агентам перед удалением stash | |
| `warn-all-files-staged` | Перехватить случайный `git add -A` | |
| `warn-destructive-sql` | Перехватить DROP/DELETE SQL перед выполнением | |
| `warn-schema-alteration` | Перехватить ALTER TABLE перед выполнением | |
| `warn-large-file-write` | Перехватить неожиданно большие записи файлов | `thresholdKb` |
| `warn-package-publish` | Перехватить случайный `npm publish` | |
| `warn-background-process` | Перехватить непредвиденные запуски фоновых процессов | |
| `warn-global-package-install` | Перехватить непредвиденные глобальные установки пакетов | |
| …и ещё больше | | |

Полные детали политик и справка параметров: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Пользовательские политики

Напишите свои собственные политики для поддержания надёжности и сосредоточенности агентов на задачах:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Блокировать записи в пути, содержащие слово 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Записи в production-пути заблокированы");
    return allow();
  },
});
```

Установите с помощью:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Вспомогательные функции решений

| Функция | Эффект |
|----------|--------|
| `allow()` | Разрешить операцию |
| `allow(message)` | Разрешить и отправить информационный контекст Claude |
| `deny(message)` | Блокировать операцию; сообщение показано Claude |
| `instruct(message)` | Добавить контекст в подсказку Claude; не блокирует |

### Объект контекста (`ctx`)

| Поле | Тип | Описание |
|-------|------|-------------|
| `eventType` | `string` | `PreToolUse`, `PostToolUse`, `Notification`, `Stop` |
| `toolName` | `string` | Вызываемый инструмент (`Bash`, `Write`, `Read`, …) |
| `toolInput` | `object` | Параметры ввода инструмента |
| `payload` | `object` | Полная исходная полезная нагрузка события |
| `session.cwd` | `string` | Рабочий каталог сессии Claude Code |
| `session.sessionId` | `string` | Идентификатор сессии |
| `session.transcriptPath` | `string` | Путь к файлу стенограммы сессии |

Пользовательские хуки поддерживают транзитивные локальные импорты, async/await и доступ к `process.env`. Ошибки работают в режиме открытого отказа (логируются в `~/.failproofai/hook.log`, встроенные политики продолжают работу). Полное руководство см. в [docs/custom-hooks.mdx](docs/custom-hooks.mdx).

### Политики на основе соглашений

Поместите файлы `*policies.{js,mjs,ts}` в `.failproofai/policies/` и они автоматически загружаются — без флагов или изменений конфигурации. Зафиксируйте директорию в git и каждый член команды получит одни и те же стандарты качества автоматически.

```text
# Уровень проекта — зафиксировано в git, поделено с командой
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Уровень пользователя — личные, применяются ко всем проектам
~/.failproofai/policies/my-policies.mjs
```

Оба уровня загружаются (объединение). Файлы загружаются в алфавитном порядке в каждом каталоге. Для управления порядком используйте префиксы `01-`, `02-` и т. д. По мере того как ваша команда обнаруживает новые режимы отказа, добавляйте политику и отправляйте — все получат обновление при следующем pull. Примеры готовых к использованию примеров см. в [examples/convention-policies/](examples/convention-policies/).

---

## Телеметрия

Failproof AI собирает анонимную телеметрию использования через PostHog для понимания использования функций. Содержимое сессии, имена файлов, вводы инструментов или личная информация никогда не отправляются.

Отключить:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Документация

| Руководство | Описание |
|-------|-------------|
| [Быстрый старт](docs/getting-started.mdx) | Установка и первые шаги |
| [Встроенные политики](docs/built-in-policies.mdx) | Все 39 встроенных политик с параметрами |
| [Пользовательские политики](docs/custom-policies.mdx) | Напишите свои политики |
| [Конфигурация](docs/configuration.mdx) | Формат конфигурационного файла и объединение областей |
| [Панель управления](docs/dashboard.mdx) | Мониторинг сессий и анализ активности политик |
| [Архитектура](docs/architecture.mdx) | Как работает система хуков |
| [Тестирование](docs/testing.mdx) | Запуск тестов и написание новых |

### Запустите документацию локально

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Открывает сайт документации Mintlify на `http://localhost:3000`. Контейнер следит за изменениями, если вы смонтируете каталог документов:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## Примечание для соавторов failproofai

`.claude/settings.json` этого репозитория использует `bun ./bin/failproofai.mjs --hook <EventType>` вместо стандартной команды `npx -y failproofai`. Это потому, что запуск `npx -y failproofai` внутри самого проекта failproofai создаёт конфликт саморефернции.

Для всех остальных репозиториев рекомендуемый подход — `npx -y failproofai`, установленный через:

```bash
failproofai policies --install --scope project
```

## Участие в разработке

См. [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Лицензия

См. [LICENSE](LICENSE).

---

Построено и поддерживается **ExosphereHost: Reliability Research Lab for Your Agents**. Мы помогаем предприятиям и стартапам повысить надёжность своих AI-агентов через собственных агентов, программное обеспечение и экспертизу. Узнайте больше на [exosphere.host](https://exosphere.host).
