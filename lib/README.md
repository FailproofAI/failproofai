# lib/

This directory belongs to no single product — it is shared code for **two** of them: the
Next.js dashboard and the published CLI's audit pillar. About 61% of it (6,423 of 10,582
lines) is one repeated block: `lib/<cli>-sessions.ts` (transcript discovery + parsing) and
`lib/<cli>-projects.ts` (grouping sessions by project cwd), cloned per agent CLI. The rest
is genuinely shared plumbing — `paths.ts`, `sqlite-reader.ts`, `log-entries.ts`,
`atomic-write.ts`, `telemetry-*.ts`, `dashboard-host.ts`, `install-check.ts`.

## What this is

Serving two masters is the real cost here. **Classify new code before adding it**: dashboard-only
React/UI helpers (`use-url-params.ts`, `use-filter-state.ts`, `log-format.ts` — the three files
carrying `"use client"`) must never be reachable from the CLI, and Node-only session readers must
never reach a client bundle. `cli-registry.ts` is deliberately client-safe (plain strings only)
and `projects.ts` imports the per-CLI providers lazily precisely so Turbopack does not drag
`node:fs`/`node:os` into the browser.

## Who consumes it

The Next server (42 files under `app/` import `@/lib/…`), plus `proxy.ts` and `scripts/launch.ts`
via `dashboard-host.ts`. The CLI reads it by relative path: `src/audit/cli-adapters/*.ts` import
the matching `lib/<cli>-sessions.ts` / `-projects.ts`, and `src/hooks/` imports `telemetry-id.ts`,
`atomic-write.ts`, and `paths.ts`. Note claude is the one CLI with no `claude-projects.ts` —
`projects.ts` reads its layout directly.

## Does it ship

Yes — `lib/` is in package.json's `files` array and ships raw as TypeScript. `dist/cli.mjs`
inlines what it needs at build time, but the shipped `src/` tree references these files by
relative specifier (`../../lib/paths`) and the standalone dashboard traces them, so renaming or
moving this directory breaks an installed user's audit and dashboard even though the bundled CLI
entrypoint keeps working.

## Where its tests live

`__tests__/lib/` (49 files, roughly one per module, including `__tests__/lib/utils/`). Run with
`bun run test:run`.
