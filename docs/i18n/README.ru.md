> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | **🇷🇺 Русский** | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Переводы:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Разрешение проблем во время выполнения для кодирующих агентов.**
Интегрируется с Claude Code и Codex. Перехватывает зацикливания, опасные действия и утечки секретов
до того, как они станут инцидентами. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Поддерживаемые CLI агентов

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

## Установка

```sh
npm install -g failproofai
failproofai policies --install   # или просто запустите `failproofai` и примите запрос при первом запуске
failproofai
```

30 встроенных политик активируются немедленно. Панель управления доступна по адресу `localhost:8020`. Отключите запрос при первом запуске с помощью `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Что оно блокирует

| Политика | Что она блокирует |
|---|---|
| `block-push-master` | Прямые push в `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Коммиты, слияния, перебазирования на `main` / `master` |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `sanitize-api-keys` | Утечки API-ключей в контекст агента |

→ [Все 30 встроенных политик](https://docs.befailproof.ai/built-in-policies)

---

## Ваши собственные политики

Поместите файл в `.failproofai/policies/` — он загружается автоматически, никаких флагов не требуется.
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

Три решения доступны для каждой политики:

| Решение | Эффект |
|---|---|
| `allow()` | Разрешить операцию |
| `deny(message)` | Заблокировать — сообщение вернется агенту |
| `instruct(message)` | Позволить пройти, но добавить контекст в следующий запрос агента |

→ [Руководство по пользовательским политикам](https://docs.befailproof.ai/custom-policies)

---

## Видимость сессии

Каждый вызов инструмента, который делает ваш агент, регистрируется локально. Панель управления показывает, что было выполнено,
что было заблокировано и что политика сказала агенту — поэтому вы не гадаете,
когда что-то идет не так. → [Руководство панели управления](https://docs.befailproof.ai/dashboard)

---

## Документация

| | |
|---|---|
| [Начало работы](https://docs.befailproof.ai/getting-started) | Установка и первые шаги |
| [Встроенные политики](https://docs.befailproof.ai/built-in-policies) | Все 30 политик с параметрами |
| [Пользовательские политики](https://docs.befailproof.ai/custom-policies) | Напишите свои собственные |
| [Конфигурация](https://docs.befailproof.ai/configuration) | Области конфигурации и правила слияния |
| [Панель управления](https://docs.befailproof.ai/dashboard) | Монитор сеансов и активность политик |
| [Архитектура](https://docs.befailproof.ai/architecture) | Как работает система перехватов |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — бесплатно для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. Полный текст см. в [LICENSE](./LICENSE).

---

## Внесение вклада

См. [CONTRIBUTING.md](./CONTRIBUTING.md). Новые политики, граничные случаи и переводы приветствуются.

> **Собирайте перед началом.** Сначала запустите `bun install && bun run build`. Этот репозиторий запускает собственные перехватчики failproofai на себе, и они разрешают импорт `failproofai` для скомпилированного пакета `dist/` — без сборки вы столкнетесь с ошибками перехватчиков `Cannot find package 'failproofai'`. Пересобирайте после изменения `src/`. См.
> [Сборка перед работой встроенных перехватчиков в репозитории](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Создано [Nivedit Jain](https://github.com/NiveditJain) и [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
