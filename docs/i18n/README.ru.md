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

**Разрешение ошибок во время выполнения для кодирующих агентов.**
Интегрируется с Claude Code и Codex. Перехватывает бесконечные циклы, опасные действия и утечки секретов
прежде, чем они станут инцидентами. Нулевая задержка. Работает локально.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

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

> Установите hooks для одного или нескольких: `failproofai policies --install --cli opencode pi gemini` (или `--cli claude codex copilot cursor opencode pi gemini`). Пропустите `--cli` для автоматического определения установленных CLI и подтверждения.

---

## Установка

```sh
npm install -g failproofai
failproofai policies --install   # или просто запустите `failproofai` и примите предложение при первом запуске
failproofai
```

30 встроенных политик активируются сразу же. Панель управления доступна на `localhost:8020`. Отключите предложение при первом запуске с помощью `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Что это блокирует

| Политика | Что она блокирует |
|---|---|
| `block-push-master` | Прямые push в `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges, rebases на `main` / `master` |
| `block-rm-rf` | Рекурсивное удаление файлов |
| `sanitize-api-keys` | Утечки API ключей в контекст агента |

→ [Все 30 встроенных политик](https://docs.befailproof.ai/built-in-policies)

---

## Собственные политики

Поместите файл в `.failproofai/policies/` — он загружается автоматически без дополнительных флагов.
Заcommitьте его, и вся команда получит обновление при следующем pull.

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
| `instruct(message)` | Пропустить, но добавить контекст в следующий prompt агента |

→ [Руководство по пользовательским политикам](https://docs.befailproof.ai/custom-policies)

---

## Видимость сеанса

Каждый вызов инструмента, который делает ваш агент, логируется локально. Панель управления показывает, что запустилось,
что было заблокировано и что политика сказала агенту — так что вы не гадаете,
когда что-то идёт не так. → [Руководство по панели управления](https://docs.befailproof.ai/dashboard)

---

## Документация

| | |
|---|---|
| [Начало работы](https://docs.befailproof.ai/getting-started) | Установка и первые шаги |
| [Встроенные политики](https://docs.befailproof.ai/built-in-policies) | Все 30 политик с параметрами |
| [Пользовательские политики](https://docs.befailproof.ai/custom-policies) | Напишите свои собственные |
| [Конфигурация](https://docs.befailproof.ai/configuration) | Области конфигурации и правила объединения |
| [Панель управления](https://docs.befailproof.ai/dashboard) | Мониторинг сеанса и активность политик |
| [Архитектура](https://docs.befailproof.ai/architecture) | Как работает система hooks |

---

## Лицензия

MIT с [Commons Clause](https://commonsclause.com/) — бесплатно для внутреннего и личного использования; коммерческая перепродажа самого failproofai требует отдельного соглашения. Полный текст см. в [LICENSE](./LICENSE).

---

## Вклад

См. [CONTRIBUTING.md](./CONTRIBUTING.md). Новые политики, граничные случаи и переводы приветствуются.

> **Сначала выполните сборку.** Запустите `bun install && bun run build`. Этот репозиторий запускает собственные hooks failproofai на себе, и они разрешают импорт `failproofai` относительно скомпилированного пакета `dist/` — без сборки вы получите ошибки hooks `Cannot find package 'failproofai'`. Пересоберите после изменений в `src/`. See
> [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Создано [Nivedit Jain](https://github.com/NiveditJain) и [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
