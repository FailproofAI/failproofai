# pi-extension/

## What this is

A shipped plugin package — one of the five products in this repo — that bridges the CLI's
policy engine into Pi (`@mariozechner/pi-coding-agent`). Pi has no external shell-hook
system: it loads `index.ts` in-process at startup, and the default export subscribes to
eight Pi events (`tool_call`, `user_bash`, `input`, `session_start`, `tool_result`,
`agent_end`, `before_agent_start`, `session_shutdown`). Each handler `spawnSync`s
`failproofai --hook <event> --cli pi`, parses the flat `{permission, reason}` JSON on
stdout, and returns Pi's `{block, reason}` shape. Any spawn or parse error fails open.

## Who consumes it

Pi itself, at startup, via a path entry in `.pi/settings.json` (project) or
`~/.pi/agent/settings.json` (user). The CLI writes that entry: `src/hooks/integrations.ts`
resolves this directory with `getPiExtensionPath()` and writes a relative `../pi-extension`
for project scope, an absolute path for user scope. The shim then calls back into the
package — `dist/cli.mjs` under node when it exists, else `bun bin/failproofai.mjs`.

## Does it ship

Yes — `pi-extension/` is in package.json's `files` array, so the whole directory lands in
the npm tarball. **The directory name is frozen.** Installed users have this absolute path
written into their Pi settings file; renaming or moving it breaks their live enforcement
and orphans `failproofai policies --uninstall --cli pi`, which matches entries on the
literal `pi-extension` path segment (`isFailproofaiPiEntry`). The shim is also self-contained
by rule: it duplicates `PI_TOOL_MAP` from `src/hooks/types.ts` rather than importing it,
because Pi loads it in-process. Change one copy, change both.

## Where its tests live

`__tests__/hooks/pi-extension-shim.test.ts` and `__tests__/hooks/pi-shim-shapes.test.ts`
(`bun run test:run`); live `pi list` roundtrips in
`__tests__/e2e/hooks/pi-integration.e2e.test.ts` (`bun run test:e2e`).
