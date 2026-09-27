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

**Observabilidad y cumplimiento para cada entorno en el que corren tus agentes.**
Donde sea que ejecuten tus agentes, nosotros lo vemos — y podemos decir que no. Failproof engancha 12 entornos de agentes — CLIs de programación como Claude Code y Codex, pasarelas de chat como Hermes, asistentes autoalojados como OpenClaw — capturando cada ejecución y bloqueando llamadas a herramientas peligrosas antes de que se ejecuten. 40 políticas integradas. Sin latencia. Corre en local.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Entornos compatibles

Doce entornos en dos categorías — diez CLIs de programación, y dos pasarelas de chat y asistentes (Hermes, OpenClaw). Una única API de políticas y un historial de sesiones compartido entre todos ellos. Lo que una política puede *bloquear* depende de cada entorno: detener una llamada a herramienta antes de que se ejecute está verificado en los doce, y las compuertas al final de turno funcionan en ocho. La [matriz por entorno](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) detalla los eventos que cada uno respeta.

Los agentes que no corren en ninguno de ellos pueden reportar a través del [Python SDK](https://docs.befailproof.ai/reference/custom-agents), que ofrece trazado, sesiones y auditorías. El cumplimiento allí requiere un hook en tu propio runtime — [contáctanos](mailto:support@befailproof.ai) y lo mapeamos juntos.

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
failproofai config                             # conecta tus agentes y el daemon
failproofai policies add FailproofAI/policies  # elige qué enforcer
failproofai                                    # dashboard en localhost:8020
```

La configuración conecta los hooks y **no** selecciona ninguna política — ese segundo comando es el que pone las restricciones en la máquina, y cualquier paquete se indica de la misma forma (`failproofai policies add <propietario>/<repo>`; `policies show <propietario>/<repo>` primero lo lee). Ejecuta `failproofai config` sin terminal — en CI, en un contenedor, con un agente manejándolo — y aplica los cambios sin hacer preguntas. En una máquina que nunca se ha configurado, cualquier otro comando ejecuta primero el mismo asistente; desactívalo con `FAILPROOFAI_NO_FIRST_RUN=1`.

Hasta que llegue un paquete, lo único que se aplica es `block-failproofai-commands`, que siempre está activo y no se puede desactivar ni pausar: un agente que pueda pausar el cumplimiento podría desactivar todas las demás políticas.

---

## Qué detiene

| Política | Qué bloquea |
|---|---|
| `block-env-files` | Lecturas de `.env` y otros archivos con secretos |
| `warn-repeated-tool-calls` | El agente en bucle repitiendo la misma llamada |
| `block-sudo` | Escalada de privilegios |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sin condiciones |
| `block-terraform` / `block-kubectl` | Cambios sin revisión en infraestructura en vivo |
| `block-rm-rf` | Eliminación recursiva de archivos |
| `block-force-push` / `block-push-master` | `git push --force`, pushes directos a `main` |

Cada una de estas compuertas actúa *antes* de que la llamada se ejecute, por lo que funcionan en los doce entornos. Las cuatro primeras aplican a cualquier agente que pueda llamar a una herramienta; las últimas tres son las favoritas de los desarrolladores — las CLIs de programación son la categoría de entorno con mayor cobertura. La familia `sanitize-*` es aparte: se ejecuta después de que una herramienta devuelve su resultado, por lo que reporta un secreto en la salida de la herramienta en lugar de evitar que entre en el contexto.

→ [Las 40 políticas integradas](https://docs.befailproof.ai/policies/packs)

---

## Tus propias políticas

Coloca un archivo en `.failproofai/policies/` — se carga automáticamente, sin flags adicionales. Confírmalo en el repositorio y todo el equipo lo obtiene en el próximo pull.

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
| `allow()` | Permitir la operación |
| `deny(message)` | Bloquearla — el mensaje se devuelve al agente |
| `instruct(message)` | Dejarla pasar, pero añadir contexto al siguiente prompt del agente |

→ [Escribe una política](https://docs.befailproof.ai/policies/editor)

---

## Observabilidad

El cumplimiento es una mitad. La otra mitad es ver qué hizo realmente el agente.

Ejecuta `failproofai` sin argumentos y sirve un dashboard en `localhost:8020` que lee el historial de ejecuciones ya guardado en tu máquina — sin cuenta, sin registro, sin que nada salga del equipo. Obtienes la lista de sesiones, la secuencia de llamadas al modelo, llamadas a herramientas y decisiones del hook dentro de cada ejecución, qué fue bloqueado y qué le dijo la política al agente, y una auditoría offline (`failproofai audit`) que analiza tu historial en busca de patrones de riesgo y sugiere políticas para detenerlos.

→ [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Leer un trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Auditoría local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** es la versión alojada del mismo modelo de datos, para equipos que ejecutan agentes en una flota: cada ejecución de cada entorno en un solo lugar, un grafo de ejecución con sub-agentes paralelos en sus propios carriles, latencia p50/p95/p99 para modelos, herramientas y hooks, seguimiento de coste y ventana de contexto por modelo, seguimiento de errores, SQL sobre tus propios traces con dashboards compartibles, evaluaciones puntuadas por tu propio servicio, auditorías programadas que convierten fallos recurrentes en hallazgos respaldados por evidencias, y alertas enrutadas a Slack, correo electrónico o un webhook firmado. El autoalojamiento en tu propio clúster está disponible en el plan Enterprise.

→ [Sesiones](https://docs.befailproof.ai/sessions/overview) ·
[Auditorías](https://docs.befailproof.ai/audits/overview) ·
[Reserva una demo](https://befailproof.ai/get-a-demo)

---

## Documentación

| Comenzar | |
|---|---|
| [Inicio rápido](https://docs.befailproof.ai/start/quickstart) | Instalar, conectar un entorno, ver la primera ejecución |
| [Conceptos](https://docs.befailproof.ai/start/concepts) | Cómo funciona el sistema de hooks |
| [Entornos compatibles](https://docs.befailproof.ai/reference/harnesses) | Los 12, y qué puede enforcer cada uno |

| Observar | |
|---|---|
| [Sesiones](https://docs.befailproof.ai/sessions/overview) | Seguir una ejecución: modelos, herramientas, errores, latencia |
| [Leer un trace](https://docs.befailproof.ai/sessions/read-a-trace) | Qué te dice el grafo de ejecución |
| [Auditorías](https://docs.befailproof.ai/audits/overview) | Encontrar patrones de fallo en muchas sesiones |
| [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sin cuenta necesaria |

| Aplicar políticas | |
|---|---|
| [Paquetes de políticas](https://docs.befailproof.ai/policies/packs) | Las políticas de Failproof AI y paquetes del hub de políticas |
| [Escribir una política](https://docs.befailproof.ai/policies/editor) | Desde una auditoría o en código |
| [Configuración](https://docs.befailproof.ai/policies/local-configuration) | Alcances de configuración, reglas de fusión y parámetros de políticas |

| Instrumentar tu propio agente | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Reportar ejecuciones desde un agente sin entorno propio |
| [Policy SDK](https://docs.befailproof.ai/reference/policy-sdk) | Referencia de `allow` / `deny` / `instruct` |

---

## Licencia

MIT con [Commons Clause](https://commonsclause.com/) — gratuito para uso interno y personal; la reventa comercial de failproofai en sí requiere un acuerdo aparte. Consulta [LICENSE](../../LICENSE) para el texto completo.

---

## Contribuciones

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md). Son bienvenidas nuevas políticas, casos límite y traducciones.

> **Compila antes de empezar.** Ejecuta primero `bun install && bun run build`. Este repositorio ejecuta los propios hooks de failproofai sobre sí mismo, y resuelven la importación de `failproofai` contra el bundle compilado en `dist/` — sin una compilación obtendrás errores de hook `Cannot find package 'failproofai'`. Recompila después de modificar `src/`. Consulta [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Hecho con ❤️ por [befailproof.ai](https://befailproof.ai) en SF y Bengaluru.
