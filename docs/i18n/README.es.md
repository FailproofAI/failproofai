> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | **🇪🇸 Español** | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Traducciones:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Resolución de fallos en tiempo de ejecución para agentes de código.**
Se integra con Claude Code y Codex. Detecta bucles, acciones peligrosas y filtraciones de secretos
antes de que se conviertan en incidentes. Latencia cero. Se ejecuta localmente.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI en acción" width="800" />
</p>

---

## CLIs de agentes compatibles

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> Instala hooks para uno o cualquier combinación: `failproofai policies --install --cli opencode pi` (o `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Omite `--cli` para detectar automáticamente los CLIs instalados y recibir un aviso.
>
> **Hermes** (hermes-agent, una pasarela de Slack/Telegram) es compatible tanto con la **aplicación de hooks en vivo** (`--cli hermes` — una sola instalación intercepta las llamadas de herramientas de cada plataforma y subagente) como con la **auditoría** offline mediante la reproducción de sus sesiones de pasarela desde el único `~/.hermes/state.db`.
>
> **OpenClaw** (openclaw gateway, un asistente multicanal autohospedado) es compatible tanto con la **aplicación de hooks en vivo** (`--cli openclaw`, ámbito de usuario) como con la **auditoría** offline mediante la reproducción de sus sesiones JSONL (`~/.openclaw/agents/<id>/sessions/*.jsonl`). La aplicación utiliza los **hooks de plugin en proceso** de OpenClaw (un `openclaw-plugin/` incluido que lanza failproofai de forma asíncrona — sus hooks internos basados en archivos son solo de observación y no pueden bloquear): `before_tool_call` bloquea una herramienta, y `before_agent_finalize` es una barrera real de fin de turno, por lo que los builtins `require-*-before-stop` se aplican.
>
> **Factory Droid** (`droid`) es compatible tanto con la **aplicación de hooks en vivo** (`--cli factory`, ámbito de usuario y proyecto) como con la **auditoría** offline mediante la reproducción de sus sesiones JSONL en disco. droid bloquea llamadas de herramientas a través del **código de salida 2** del hook (no mediante una decisión JSON) y solo respeta `{decision:"block"}` en el evento de fin de turno `Stop` — failproofai emite la forma correcta por evento de manera automática.
>
> **Devin CLI** (`devin`, Cognition) es compatible tanto con la **aplicación de hooks en vivo** (`--cli devin`, ámbito de usuario y proyecto) como con la **auditoría** offline mediante la reproducción de sus sesiones SQLite (`~/.local/share/devin/cli/sessions.db`). Devin es un **clon puro de Claude** — mismos nombres de eventos, mismo payload en snake_case, misma configuración con wrapper `"hooks"` (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — bloqueo mediante JSON `{decision:"block"}` en cada evento.
>
> **Antigravity CLI** (`agy`) es compatible tanto con la **aplicación de hooks en vivo** (`--cli antigravity`, ámbito de usuario y proyecto) como con la **auditoría** offline mediante la reproducción de sus sesiones JSONL simples (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity tiene su **propio** contrato (no es un clon de Claude): un esquema `hooks.json` con **hooks nombrados** (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), un payload stdin en camelCase que failproofai normaliza, y sus propias formas de respuesta — `{decision:"deny"}` para bloquear una herramienta, `{decision:"continue"}` para forzar otro turno en `Stop`, `{injectSteps}` para inyectar un recordatorio antes de que el modelo se ejecute.
>
> **Goose** (nombre en clave goose, Block) es compatible tanto con la **aplicación de hooks en vivo** (`--cli goose`, ámbito de usuario y proyecto) como con la **auditoría** offline mediante la reproducción de sus sesiones SQLite (`~/.local/share/goose/sessions/sessions.db`). La aplicación utiliza el sistema de **hooks** de Goose (la especificación **Open Plugins** multi-agente) — el instalador simplemente coloca un directorio de plugin en `~/.agents/plugins/failproofai/` y Goose lo detecta automáticamente. El bloqueo se realiza con JSON `{"decision":"block"}` en el evento `PreToolUse` (que se activa para la herramienta shell y dentro de subagentes delegados), verificado en vivo contra goose v1.43.0; Goose no tiene un evento `Stop` de fin de turno, por lo que los builtins `require-*-before-stop` no se aplican (igual que con Hermes).

---

## Instalación

```sh
npm install -g failproofai
failproofai policies --install   # o simplemente ejecuta `failproofai` y acepta el aviso de primera ejecución
failproofai
```

30 políticas integradas se activan de inmediato. Panel de control en `localhost:8020`. Desactiva el aviso de primera ejecución con `FAILPROOFAI_NO_FIRST_RUN=1`.

---

## Qué detiene

| Política | Qué bloquea |
|---|---|
| `block-push-master` | Envíos directos a `main` / `master` |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | Commits, merges y rebases en `main` / `master` |
| `block-rm-rf` | Eliminación recursiva de archivos |
| `sanitize-api-keys` | Claves de API que se filtran al contexto del agente |

→ [Las 30 políticas integradas](https://docs.befailproof.ai/built-in-policies)

---

## Tus propias políticas

Coloca un archivo en `.failproofai/policies/` — se carga automáticamente, sin necesidad de flags.
Súbelo al repositorio y todo el equipo lo tendrá en el próximo pull.

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

Tres decisiones disponibles para cada política:

| Decisión | Efecto |
|---|---|
| `allow()` | Permite la operación |
| `deny(message)` | La bloquea — el mensaje se devuelve al agente |
| `instruct(message)` | La deja pasar, pero añade contexto al siguiente prompt del agente |

→ [Guía de políticas personalizadas](https://docs.befailproof.ai/custom-policies)

---

## Visibilidad de sesiones

Cada llamada de herramienta que realiza tu agente se registra localmente. El panel de control muestra qué se ejecutó,
qué fue bloqueado y qué le indicó la política al agente — así no tendrás que adivinar
qué salió mal. → [Guía del panel de control](https://docs.befailproof.ai/dashboard)

---

## Documentación

| | |
|---|---|
| [Primeros pasos](https://docs.befailproof.ai/getting-started) | Instalación y primeros pasos |
| [Políticas integradas](https://docs.befailproof.ai/built-in-policies) | Las 30 políticas con parámetros |
| [Políticas personalizadas](https://docs.befailproof.ai/custom-policies) | Escribe las tuyas propias |
| [Configuración](https://docs.befailproof.ai/configuration) | Ámbitos de configuración y reglas de fusión |
| [Panel de control](https://docs.befailproof.ai/dashboard) | Monitor de sesiones y actividad de políticas |
| [Arquitectura](https://docs.befailproof.ai/architecture) | Cómo funciona el sistema de hooks |

---

## Licencia

MIT con [Commons Clause](https://commonsclause.com/) — de uso gratuito para uso interno y personal; la reventa comercial de failproofai en sí requiere un acuerdo aparte. Consulta [LICENSE](./LICENSE) para el texto completo.

---

## Contribuir

Consulta [CONTRIBUTING.md](./CONTRIBUTING.md). Se aceptan nuevas políticas, casos límite y traducciones.

> **Compila antes de empezar.** Ejecuta primero `bun install && bun run build`. Este repositorio ejecuta sus propios hooks de failproofai sobre sí mismo, y resuelven la importación de `failproofai` contra el bundle compilado en `dist/` — sin una compilación obtendrás errores de hook `Cannot find package 'failproofai'`. Vuelve a compilar después de modificar `src/`. Consulta
> [Compila antes de que funcionen los hooks de desarrollo internos del repositorio](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Desarrollado por [Nivedit Jain](https://github.com/NiveditJain) y [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
