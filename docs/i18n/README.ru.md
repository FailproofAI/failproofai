> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | **🇷🇺 Русский** | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Переводы:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Разрешение ошибок времени выполнения для кодирующих агентов.**
Встраивается в Claude Code и Codex. Перехватывает циклы, опасные действия и утечки секретов
прежде чем они станут инцидентами. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI в действии" width="800" />
</p>

---

## Поддерживаемые CLI агентов

<!-- A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). -->
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

> Установите хуки для одного или любой комбинации: `failproofai policies --install --cli opencode pi` (или `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Опустите `--cli` для автоматического обнаружения установленных CLI и получения подсказок.
>
> **Hermes** (hermes-agent, шлюз Slack/Telegram) поддерживается как для **активной реализации хуков** (`--cli hermes` — одна установка перехватывает вызовы инструментов со всех платформ и вложенных агентов), так и для автономного **аудита** повторного воспроизведения его сеансов шлюза из `~/.hermes/state.db`.
>
> **OpenClaw** (шлюз openclaw, многоканальный ассистент с собственным размещением) поддерживается как для **активной реализации хуков** (`--cli openclaw`, область пользователя), так и для автономного **аудита** повторного воспроизведения его JSONL-сеансов (`~/.openclaw/agents/<id>/sessions/*.jsonl`). Реализация использует **встроенные плагины хуков** OpenClaw (поставляемый `openclaw-plugin/`, который асинхронно запускает failproofai — его встроенные хуки на основе файлов только для наблюдения и не могут блокировать): `before_tool_call` блокирует инструмент, а `before_agent_finalize` — это реальные ворота конца хода, поэтому встроенные `require-*-before-stop` реализуют принуждение.
>
> **Factory Droid** (`droid`) поддерживается как для **активной реализации хуков** (`--cli factory`, область пользователя + проект), так и для автономного **аудита** повторного воспроизведения его JSONL-сеансов на диске. droid блокирует вызовы инструментов по коду выхода хука **2** (не решение JSON) и соответствует `{decision:"block"}` только на события конца хода `Stop` — failproofai автоматически выдает правильную форму для каждого события.
>
> **Devin CLI** (`devin`, Cognition) поддерживается как для **активной реализации хуков** (`--cli devin`, область пользователя + проект), так и для автономного **аудита** повторного воспроизведения его SQLite-сеансов (`~/.local/share/devin/cli/sessions.db`). Devin — это **чистый клон Claude** — те же имена событий, тот же snake_case-полезные нагрузки, та же конфигурация `"hooks"`-обертки (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — блокирование через JSON `{decision:"block"}` на каждом событии.
>
> **Antigravity CLI** (`agy`) поддерживается как для **активной реализации хуков** (`--cli antigravity`, область пользователя + проект), так и для автономного **аудита** повторного воспроизведения его JSONL-сеансов (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity имеет **свой** контракт (не клон Claude): схему **именованного хука** `hooks.json` (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), полезные нагрузки stdin в camelCase, которые failproofai нормализует, и свои формы ответов — `{decision:"deny"}` для блокирования инструмента, `{decision:"continue"}` для принудительного следующего хода на `Stop`, `{injectSteps}` для внедрения напоминания перед запуском модели.
>
> **Goose** (кодовое имя goose, Block) поддерживается как для **активной реализации хуков** (`--cli goose`, область пользователя + проект), так и для автономного **аудита** повторного воспроизведения его SQLite-сеансов (`~/.local/share/goose/sessions/sessions.db`). Реализация использует систему **хуков** Goose (кроссагентная спецификация **Open Plugins**) — установщик просто размещает каталог плагина в `~/.agents/plugins/failproofai/` и Goose автоматически обнаруживает его. Блокирование — это JSON `{"decision":"block"}` на событии `PreToolUse` (которое срабатывает для инструмента shell и внутри делегированных подагентов), подтверждено в реальном времени для goose v1.43.0; Goose не имеет события конца хода `Stop`, поэтому встроенные `require-*-before-stop` не применяются (как и в случае Hermes).

---

## Установка

```sh
npm install -g failproofai
failproofai policies --install   # или просто запустите `failproofai` и примите первую подсказку
failproofai
```

30 встроенных политик активируются немедленно. Панель инструментов в `localhost:8020`. Отключите первую подсказку с помощью `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Что это останавливает

| Политика | Что она блокирует |
|---|---|
| `block-push-master` | Прямые отправки в `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Коммиты, слияния, перебазирование на `main` / `master` |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `sanitize-api-keys` | Утечки ключей API в контекст агента |

→ [Все 30 встроенных политик](https://docs.befailproof.ai/built-in-policies)

---

## Ваши собственные политики

Поместите файл в `.failproofai/policies/` — он загружается автоматически, флаги не требуются.
Зафиксируйте его, и вся команда получит его при следующем запросе.

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
| `deny(message)` | Блокировать её — сообщение возвращается агенту |
| `instruct(message)` | Пропустить, но добавить контекст к следующей подсказке агента |

→ [Руководство по пользовательским политикам](https://docs.befailproof.ai/custom-policies)

---

## Видимость сеансов

Каждый вызов инструмента, который делает ваш агент, регистрируется локально. На панели инструментов показано, что было запущено,
что было заблокировано и что политика сказала агенту — поэтому вы не гадаете,
когда что-то идет не так. → [Руководство по панели инструментов](https://docs.befailproof.ai/dashboard)

---

## Документация

| | |
|---|---|
| [Начало работы](https://docs.befailproof.ai/getting-started) | Установка и первые шаги |
| [Встроенные политики](https://docs.befailproof.ai/built-in-policies) | Все 30 политик с параметрами |
| [Пользовательские политики](https://docs.befailproof.ai/custom-policies) | Напишите свои |
| [Конфигурация](https://docs.befailproof.ai/configuration) | Области конфигурации и правила слияния |
| [Панель инструментов](https://docs.befailproof.ai/dashboard) | Монитор сеансов и активность политик |
| [Архитектура](https://docs.befailproof.ai/architecture) | Как работает система хуков |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — бесплатно для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. Полный текст см. в [LICENSE](./LICENSE).

---

## Участие в разработке

См. [CONTRIBUTING.md](./CONTRIBUTING.md). Новые политики, граничные случаи и переводы приветствуются.

> **Соберите перед началом.** Запустите `bun install && bun run build` сначала. Это репозиторий запускает собственные хуки failproofai на себе, и они разрешают импорт `failproofai` в отношении скомпилированного пакета `dist/` — без сборки вы получите ошибки `Cannot find package 'failproofai'`. Перестройте после изменения `src/`. См.
> [Собрать перед тем, как встроенные хуки разработки будут работать](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Создано [Nivedit Jain](https://github.com/NiveditJain) и [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
