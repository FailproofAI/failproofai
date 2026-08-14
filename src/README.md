# src/

## What this is

Of the five products in this package.json, `src/` is **the CLI**. `src/hooks/` (53 flat files,
no subdirectories) is enforcement plus install — it writes hook configs into 12 agent CLIs and
evaluates policies when those hooks fire. `src/audit/` is the separate audit product: 13 per-CLI
12 transcript adapters under `cli-adapters/` feeding detectors, scoring and findings. `src/index.ts`
is the public API (`customPolicies`, `allow`/`deny`/`instruct`) that user policy files import as
`from 'failproofai'`.

The hot path: an agent CLI fires a hook → `bin/failproofai.mjs --hook <event> --cli <name>` → if
`daemon-client.ts`'s `isDaemonConfigured()` is true, `attemptDaemonHook()` and nothing else (an
unreachable daemon or a protocol mismatch becomes a forced **deny**) → otherwise `handler.ts`
`evaluateHookEvent()` canonicalizes event, tool name and payload, and `policy-evaluator.ts` runs
`builtin-policies.ts` plus any custom policies, shaping the verdict into each CLI's own response
contract. Subcommands (`SUBCOMMANDS` in `bin/failproofai.mjs`): `policies`/`p`, `policy`, `audit`,
`config`, `uninstall`, `backfill`, `flush`, `harness`; bare `failproofai` launches the dashboard.

## Who consumes it

`bin/failproofai.mjs` (every subcommand and the hook path), `bin/failproofai-worker.mjs` via
`worker-server.ts` (the warm worker the Rust daemon spawns), and the Next.js dashboard's server
actions — `app/actions/get-hooks-config.ts`, `install-hooks-web.ts`, `get-audit-result.ts` and
others import `src/hooks/*` and `src/audit/*` directly. End users import `src/index.ts` (as the
built `dist/index.js`) from their own policy files.

## Does it ship

Yes — `src/` is in package.json `files`. Installed users get the TypeScript sources, and
`bin/failproofai.mjs` imports them by extensionless specifier (`../src/hooks/handler`), so moving
or renaming a file under `src/hooks/` breaks the hook path for every installed user.
`src/index.ts` is also the bundle entry for `dist/index.js`, which is what resolves
`import ... from 'failproofai'` inside `.failproofai/policies/*.mjs`.

## Where its tests live

`__tests__/hooks/` and `__tests__/audit/` (`bun run test:run`); `__tests__/e2e/hooks/` and
`__tests__/e2e/cli/` (`bun run test:e2e`).
