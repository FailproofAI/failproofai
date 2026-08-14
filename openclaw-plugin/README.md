# openclaw-plugin/

## What this is

A shipped plugin package — one of the five products in this repo — that bridges the OpenClaw
gateway to failproofai enforcement. OpenClaw's file-based "internal hooks" are observation-only,
so blocking has to happen through its in-process typed plugin hooks: `index.js` calls
`definePluginEntry` and registers `before_tool_call`, `before_agent_run`,
`before_agent_finalize`, and five observation hooks. Each handler async-spawns
`failproofai --hook <rawEvent> --cli openclaw`, writes a Claude-shaped JSON payload to stdin, and
translates the flat `{permission, reason}` verdict into that hook's native return shape
(`{block:true, blockReason}`, `{outcome:"block", reason}`, `{action:"revise", reason}`).

It **fails open** on every spawn error, parse error, empty stdout, or the 30s guard timeout — the
handler resolves `{permission:"allow"}`. That is deliberate: OpenClaw is a long-running
multi-channel gateway, and a failproofai fault must not wedge every channel. For the same reason
the spawn is async, never `spawnSync`.

## Who consumes it

The OpenClaw gateway loads `index.js` in-process at startup. `src/hooks/integrations.ts`
(`getOpenClawPluginPath`, the `openclaw` Integration) registers this directory's absolute path
into `~/.openclaw/openclaw.json` under `plugins.load.paths[]` plus
`plugins.entries.failproofai`. `openclaw.plugin.json` carries the plugin id/name manifest. The
shim ships **no** tool maps — the binary canonicalizes via the `OPENCLAW_*` maps in
`src/hooks/types.ts`, the single source of truth.

## Does it ship

Yes — `openclaw-plugin/` is in package.json's `files` array. The directory name is frozen:
already-installed users have the literal path baked into their `openclaw.json`, and
`isFailproofaiOpenClawPath` matches on the `openclaw-plugin` segment. Renaming or moving it
silently unhooks every installed gateway.

## Where its tests live

`__tests__/hooks/integrations.test.ts` (install/uninstall of the plugin registration),
`__tests__/hooks/openclaw-canonicalize.test.ts`, and
`__tests__/hooks/enforcement-capability.test.ts`. Run with `bun run test:run`.
