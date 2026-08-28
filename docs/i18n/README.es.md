> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | **🇪🇸 Español** | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Traducciones:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Observa lo que hacen tus agentes. Evita que los errores conocidos se repitan.**
Failproof AI funciona donde sea que corran tus agentes: herramientas de programación como Claude Code y
Codex, pasarelas de chat como Hermes, asistentes autoalojados como OpenClaw, y agentes
que tú mismo instrumentes. Registra cada ejecución y puede bloquear llamadas de herramientas peligrosas
antes de que se ejecuten.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Entornos compatibles

Se admiten doce entornos en dos categorías: diez CLIs de programación, más dos
pasarelas: Hermes y OpenClaw. La API de políticas y el historial de sesiones son compartidos; los
eventos que pueden bloquear varían según el entorno.

Los agentes que no se ejecutan en ninguno de ellos reportan a través del [SDK de Python](https://docs.befailproof.ai/reference/custom-agents),
que ofrece trazado, sesiones y auditorías. Para aplicar restricciones en ese contexto se necesita un hook en
tu propio entorno de ejecución — [contáctanos](mailto:support@befailproof.ai) y lo configuramos juntos.

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

Dale a un agente compatible la habilidad de Failproof AI si quieres que guíe la configuración,
inspeccione la máquina y gestione correctamente el trabajo de políticas, auditorías, sesiones y Cloud:

```sh
npx skills add FailproofAI/skills
```

Esto instala la habilidad paraguas y sus especializaciones. Para instalar solo la
habilidad paraguas, agrega `--skill failproofai`. Las habilidades proporcionan instrucciones de operación; instala
y configura el producto en sí con:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard en localhost:8020
```

La configuración conecta los agentes compatibles e instala el servicio en segundo plano. No selecciona ningún
paquete de políticas: antes de agregar uno, solo se ejecuta `block-failproofai-commands` para evitar que
un agente deshabilite Failproof AI.

Conecta Cloud sin prompts con `failproofai config --token <machine-key>`. En una
máquina compartida o en CI, establece `FAILPROOFAI_CLOUD_TOKEN` y ejecuta `failproofai config`
para que la clave no aparezca en el historial de comandos.

---

## Qué bloquea

| Política | Qué bloquea |
|---|---|
| `sanitize-api-keys` | Claves de API que se filtran al contexto del agente |
| `block-env-files` | Lecturas de `.env` y otros archivos con secretos |
| `warn-repeated-tool-calls` | El agente repitiendo la misma llamada en bucle |
| `block-sudo` | Escalada de privilegios |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` sin condiciones |
| `block-terraform` / `block-kubectl` | Cambios no revisados en infraestructura en producción |
| `block-rm-rf` | Eliminación recursiva de archivos |
| `block-force-push` / `block-push-master` | `git push --force`, pushes directos a `main` |

Estas políticas protegen archivos, credenciales, infraestructura, bases de datos y flujos de trabajo
de agentes. El soporte exacto de aplicación varía según el entorno y el evento.

→ [Las 39 políticas integradas](https://docs.befailproof.ai/policies/builtin)

---

## Tus propias políticas

Coloca un archivo en `.failproofai/policies/` — se carga automáticamente, sin flags necesarios.
Confírmalo en el repositorio y todo el equipo lo obtendrá en el próximo pull.

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
| `instruct(message)` | Dejarla pasar, pero agregar contexto al siguiente prompt del agente |

→ [Guía de políticas personalizadas](https://docs.befailproof.ai/policies/custom)

---

## Paquetes de políticas

Un paquete de políticas es un conjunto versionado de políticas publicado desde un repositorio público de GitHub.
Inspecciona uno antes de instalarlo:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Cualquier cosa con una barra oblicua es una fuente de paquete; cualquier cosa sin ella es un nombre de política.
Puedes instalar categorías o políticas seleccionadas, y fijar una versión cuando sea necesario.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

Explora los paquetes publicados en el [Policy Hub](https://befailproof.ai/policy-hub/), o
ejecuta `failproofai publish --init` para crear el tuyo. El modo de observación permite que un paquete registre
lo que habría hecho sin bloquear nada: `failproofai publish --effect observe`.

→ [Paquetes de políticas](https://docs.befailproof.ai/policies/packs) ·
[Publicar un paquete](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Observabilidad

La aplicación de políticas es una mitad. La otra mitad es ver lo que el agente realmente hizo.

Ejecuta `failproofai` sin argumentos y sirve un dashboard en `localhost:8020`
que lee el historial de ejecuciones ya almacenado en tu máquina — sin cuenta, sin registro, sin que
nada salga del equipo. Obtienes la lista de sesiones, la secuencia de llamadas al modelo, llamadas de herramientas
y decisiones de hooks dentro de cada ejecución, lo que fue bloqueado y lo que la política le indicó al
agente, y una auditoría sin conexión (`failproofai audit`) que analiza tu historial en busca de
patrones riesgosos y sugiere políticas para detenerlos.

→ [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) ·
[Leer un trace](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Auditoría local](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** es la cara alojada del mismo modelo de datos, para equipos que
ejecutan agentes en una flota: cada ejecución de cada entorno en un solo lugar, un
grafo de ejecución con subagentes paralelos en sus propios carriles, latencia p50/p95/p99
para modelos, herramientas y hooks, seguimiento de costos por modelo y de ventana de contexto, seguimiento de
errores, SQL sobre tus propios traces con dashboards compartibles, evaluaciones puntuadas por
tu propio servicio, auditorías programadas que convierten fallos recurrentes en hallazgos respaldados por evidencia,
y alertas enrutadas a Slack, correo electrónico o un webhook firmado. El autoalojamiento en tu
propio clúster está disponible en el plan Enterprise.

→ [Sesiones](https://docs.befailproof.ai/sessions/overview) ·
[Auditorías](https://docs.befailproof.ai/audits/overview) ·
[Solicitar una demo](https://befailproof.ai/get-a-demo)

---

## Documentación

| Inicio | |
|---|---|
| [Quickstart](https://docs.befailproof.ai/start/quickstart) | Instalar, conectar un entorno, ver la primera ejecución |
| [Conceptos](https://docs.befailproof.ai/start/concepts) | Cómo funciona el sistema de hooks |
| [Entornos compatibles](https://docs.befailproof.ai/reference/harnesses) | Los 12 entornos y lo que cada uno puede aplicar |

| Observar | |
|---|---|
| [Sesiones](https://docs.befailproof.ai/sessions/overview) | Seguir una ejecución: modelos, herramientas, errores, latencia |
| [Leer un trace](https://docs.befailproof.ai/sessions/read-a-trace) | Lo que el grafo de ejecución te está diciendo |
| [Auditorías](https://docs.befailproof.ai/audits/overview) | Encontrar patrones de fallos en muchas sesiones |
| [Dashboard local](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, sin cuenta necesaria |

| Aplicar políticas | |
|---|---|
| [Políticas integradas](https://docs.befailproof.ai/policies/builtin) | Las 39 políticas con sus parámetros |
| [Políticas personalizadas](https://docs.befailproof.ai/policies/custom) | Escribe las tuyas |
| [Configuración](https://docs.befailproof.ai/policies/local-configuration) | Alcances de configuración y reglas de fusión |

| Instrumentar tu propio agente | |
|---|---|
| [SDK de Python](https://docs.befailproof.ai/reference/custom-agents) | Reportar ejecuciones desde un agente sin entorno compatible |
| [SDK de políticas](https://docs.befailproof.ai/reference/policy-sdk) | Referencia de `allow` / `deny` / `instruct` |

---

## Licencia

MIT con [Commons Clause](https://commonsclause.com/) — de uso gratuito para proyectos internos y personales; la reventa comercial de failproofai en sí requiere un acuerdo aparte. Consulta [LICENSE](../../LICENSE) para el texto completo.

---

## Contribuir

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md). Son bienvenidas nuevas políticas, casos borde y traducciones.

> **Compila antes de empezar.** Ejecuta primero `bun install && bun run build`. Este repositorio ejecuta
> los propios hooks de failproofai sobre sí mismo, y resuelven la importación de `failproofai` contra el
> bundle compilado en `dist/` — sin una compilación verás errores de hook `Cannot find package 'failproofai'`.
> Recompila después de modificar `src/`. Consulta
> [Build before the in-repo dev hooks will work](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Construido con ❤️ por [befailproof.ai](https://befailproof.ai) en SF y Bengaluru.
