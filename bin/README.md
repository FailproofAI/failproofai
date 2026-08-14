# bin/

Part of **the CLI** product. Three entrypoint scripts, no library code: `failproofai.mjs` is the
1,854-line CLI router (`--hook`, `--version`, `policies`, `config`, `audit`, and the dashboard
launcher); `failproofai-worker.mjs` is the warm worker the Rust daemon spawns; `failproofaid-shim.mjs`
is the `failproofaid` npm bin. Each sets `FAILPROOFAI_PACKAGE_ROOT` / `FAILPROOFAI_DIST_PATH` from its
own `import.meta.url` before importing anything else.

## Who consumes it

| File | Consumer |
|------|----------|
| `failproofai.mjs` | Bundled by `bun run build:cli` into `dist/cli.mjs`, which is `package.json`'s `bin.failproofai`. Installed hook configs in the 12 agent CLIs invoke it as `npx -y failproofai --hook <event>`; in this repo `scripts/dev-hook.mjs` invokes it instead. `resolveCliCommand()` in `src/hooks/daemon-service.ts` points scheduled audits at the bundle, never at this file. |
| `failproofai-worker.mjs` | The Rust daemon only (`crates/failproofaid/src/worker.rs`), via `resolveWorkerCommand()` → `dist/worker.mjs`. It has no `bin` entry; it reads `FAILPROOFAI_WORKER_SOCKET` and calls `startWorkerServer` from `src/hooks/worker-server.ts`. |
| `failproofaid-shim.mjs` | End users typing `failproofaid` by hand. Service units point `ExecStart` at `~/.failproofai/bin/failproofaid-<version>` directly, bypassing this shim. |

## Does it ship

Yes — `bin/` is in `package.json` "files". `failproofaid-shim.mjs` ships as a live path: it is
`bin.failproofaid`, so renaming it breaks `failproofaid` for every installed user. The other two ship
as source but are not executed from here in production — node cannot run them (bare
`import { version } from "../package.json"`, extensionless `.ts` specifiers); only their `dist/`
bundles are node-runnable.

**Gotcha:** `build:cli` rewrites the shebang with a literal `.replace('#!/usr/bin/env bun', '#!/usr/bin/env node')`
on the bundle. Line 1 of `failproofai.mjs` must stay exactly `#!/usr/bin/env bun` — no test guards
this, and a changed line 1 silently ships a `bun`-shebanged CLI to machines without bun.

## Where its tests live

`__tests__/e2e/cli/cli-args.e2e.test.ts` (via `__tests__/e2e/helpers/cli-runner.ts`) — `bun run test:e2e`.
Hook-path behaviour is covered by `__tests__/hooks/` — `bun run test:run`.
