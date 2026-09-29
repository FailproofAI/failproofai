> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | **🇪🇸 Español** | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traducciones:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observabilidad y control para cada entorno en el que corren tus agentes.**
Donde sea que corran tus agentes, nosotros lo vemos — y podemos decir que no. Failproof se conecta a 12 entornos de agentes — CLIs de codificación como Claude Code y Codex, pasarelas de chat como Hermes, asistentes autoalojados como OpenClaw — capturando cada ejecución y bloqueando llamadas a herramientas peligrosas antes de que se ejecuten. 39 políticas integradas. Cero latencia. Corre localmente.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Entornos compatibles

Doce entornos en dos clases — diez CLIs de codificación, y dos pasarelas de chat y asistentes (Hermes, OpenClaw). Una única API de políticas e historial de sesiones compartido entre todos. Lo que una política puede *bloquear* depende de cada entorno: detener una llamada a herramienta antes de que se ejecute está verificado en los doce, y las compuertas de fin de turno funcionan en ocho. La [matriz por entorno](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) lista los eventos que cada uno respeta.

Los agentes que no corren en ninguno de ellos reportan a través del [SDK de Python](https://docs.befailproof.ai/reference/custom-agents), que te ofrece trazabilidad, sesiones y auditorías. El control en ese caso requiere un hook en tu propio entorno de ejecución — [contáctanos](mailto:support@befailproof.ai) y lo configuramos juntos.

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

## Instalación

```sh
npm install -g failproofai
failproofai config                             # configura tus agentes y el daemon
failproofai policies add FailproofAI/policies  # elige qué aplicar
failproofai                                    # panel en localhost:8020
```

La configuración conecta los hooks y **no** selecciona ninguna política — el segundo comando es el que añade las salvaguardas a la máquina, y cualquier paquete se escribe de la misma manera (`failproofai policies add <propietario>/<repo>`; `policies show <propietario>/<repo>` lee uno primero). Ejecuta `failproofai config` sin terminal — en CI, en un contenedor, con un agente al mando — y aplica la configuración en lugar de preguntar. En una máquina que nunca se ha configurado, cualquier otro comando ejecuta el mismo asistente primero; desactívalo con `FAILPROOFAI_NO_FIRST_RUN=1`.

Hasta que llegue un paquete, lo único que aplica control es `block-failproofai-commands`, que siempre está activo y no puede desactivarse ni pausarse: un agente que puede pausar el control puede desactivar todas las demás políticas.

---

## Qué detiene

| Política | Qué bloquea |
|---|---|
| `block-env-files` | Lecturas de `.env` y otros archivos de secretos |
| `warn-repeated-tool-calls` | El agente en bucle sobre la misma llamada |
| `block-sudo` | Escalada de privilegios |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sin límites |
| `block-terraform` / `block-kubectl` | Cambios sin revisión en infraestructura en producción |
| `block-rm-rf` | Eliminación recursiva de archivos |
| `block-force-push` / `block-push-master` | `git push --force`, pushes directos a `main` |

Cada una de estas compuertas actúa *antes* de que la llamada se ejecute, por lo que funcionan en los doce entornos. Las primeras cuatro aplican a cualquier agente que pueda invocar una herramienta; las últimas tres son las favoritas de los desarrolladores — los CLIs de codificación son la clase de entorno que cubrimos con mayor profundidad. La familia `sanitize-*` es distinta: se ejecuta después de que una herramienta devuelve su resultado, por lo que reporta un secreto en la salida de la herramienta en lugar de evitar que llegue al contexto.

→ [Las 39 políticas integradas](https://docs.befailproof.ai/policies/packs)

---

## Tus propias políticas

Coloca un archivo en `.failproofai/policies/` — se carga automáticamente, sin necesidad de flags. Confírmalo al repositorio y todo el equipo lo obtiene en el próximo pull.

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

→ [Escribir una política](https://docs.befailproof.ai/policies/editor)

---

## Observabilidad

El control es una mitad. La otra mitad es ver qué hizo realmente el agente.

Ejecuta `failproofai` sin argumentos y sirve un panel en `localhost:8020` que lee el historial de ejecuciones ya almacenado en tu máquina — sin cuenta, sin registro, sin que nada salga del equipo. Obtienes la lista de sesiones, la secuencia de llamadas al modelo, llamadas a herramientas y decisiones de hooks dentro de cada ejecución, qué fue bloqueado y qué le dijo la política al agente, y una auditoría offline (`failproofai audit`) que analiza tu historial en busca de patrones de riesgo y sugiere políticas para detenerlos.

→ [Panel local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Leer una traza](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Auditoría local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** es la versión alojada del mismo modelo de datos, para equipos que ejecutan agentes en una flota: cada ejecución de cada entorno en un solo lugar, un grafo de ejecución con subagentes paralelos en sus propios carriles, latencia p50/p95/p99 para modelos, herramientas y hooks, seguimiento de costos y ventana de contexto por modelo, seguimiento de errores, SQL sobre tus propias trazas con paneles compartibles, evaluaciones puntuadas por tu propio servicio, auditorías programadas que convierten fallos recurrentes en hallazgos respaldados por evidencia, y alertas enrutadas a Slack, correo electrónico o un webhook firmado. El autoalojamiento en tu propio clúster está disponible en el plan Enterprise.

→ [Sesiones](https://docs.befailproof.ai/sessions/overview) ·
[Auditorías](https://docs.befailproof.ai/audits/overview) ·
[Reservar una demo](https://befailproof.ai/get-a-demo)

---

## Documentación

| Inicio | |
|---|---|
| [Inicio rápido](https://docs.befailproof.ai/start/quickstart) | Instala, conecta un entorno, ve la primera ejecución |
| [Conceptos](https://docs.befailproof.ai/start/concepts) | Cómo funciona el sistema de hooks |
| [Entornos compatibles](https://docs.befailproof.ai/reference/harnesses) | Los 12, y qué puede aplicar cada uno |

| Observar | |
|---|---|
| [Sesiones](https://docs.befailproof.ai/sessions/overview) | Sigue una ejecución: modelos, herramientas, errores, latencia |
| [Leer una traza](https://docs.befailproof.ai/sessions/read-a-trace) | Qué te está diciendo el grafo de ejecución |
| [Auditorías](https://docs.befailproof.ai/audits/overview) | Encuentra patrones de fallos en muchas sesiones |
| [Panel local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sin cuenta necesaria |

| Aplicar control | |
|---|---|
| [Paquetes de políticas](https://docs.befailproof.ai/policies/packs) | Las políticas de Failproof AI y paquetes del hub de políticas |
| [Escribir una política](https://docs.befailproof.ai/policies/editor) | Desde una auditoría o en código |
| [Configuración](https://docs.befailproof.ai/policies/local-configuration) | Ámbitos de configuración, reglas de fusión y parámetros de políticas |

| Instrumentar tu propio agente | |
|---|---|
| [SDK de Python](https://docs.befailproof.ai/reference/custom-agents) | Reporta ejecuciones desde un agente sin entorno |
| [SDK de políticas](https://docs.befailproof.ai/reference/policy-sdk) | Referencia de `allow` / `deny` / `instruct` |

---

## Licencia

MIT con [Commons Clause](https://commonsclause.com/) — libre para uso interno y personal; la reventa comercial de failproofai en sí misma requiere un acuerdo separado. Consulta [LICENSE](../../LICENSE) para el texto completo.

---

## Contribuir

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md). Se aceptan nuevas políticas, casos límite y traducciones.

> **Compila antes de empezar.** Ejecuta `bun install && bun run build` primero. Este repositorio ejecuta los propios hooks de failproofai sobre sí mismo, y estos resuelven la importación de `failproofai` contra el bundle compilado en `dist/` — sin una compilación obtendrás errores de hook `Cannot find package 'failproofai'`. Vuelve a compilar después de modificar `src/`. Consulta [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Hecho con ❤️ por [befailproof.ai](https://befailproof.ai) en San Francisco y Bengaluru.
