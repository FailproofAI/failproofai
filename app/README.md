# app/

The Next.js 16 App Router source for **the dashboard** — the local web UI a user gets from
`failproofai` (dev: `bun run dev` on port 8020). It renders four route trees: `/policies`
(policy toggles + hook-activity log), `/projects` and `/project/[name]/session/[sessionId]`
(session browsing), `/audit` (the audit product's report), and `/settings`. `app/page.tsx`
is a deliberate `notFound()` — the real entry redirects live in `proxy.ts` at the repo root.

## Who consumes it

The Next server process, started via `scripts/launch.ts` → `.next/standalone/server.js`.
Server code here reaches straight into the CLI's own modules — `app/actions/*.ts` are
`"use server"` actions importing `@/src/hooks/manager`, `@/src/hooks/hooks-config` and
`@/src/audit`, so the dashboard writes the same config files the CLI does. `app/api/*/route.ts`
are HTTP route handlers for things a server action can't do: streaming a transcript
(`api/download/[project]/[session]`), the fire-and-forget audit run (`api/audit/run` +
`status`, sharing module state in `api/audit/_state.ts`), and OTP auth (`api/auth/*`).
Every request first passes `proxy.ts`, which enforces loopback Host + same-Origin — this UI
has no authentication and can uninstall hooks from every CLI.

## Does it ship

Yes, and more literally than you would expect. `app/` is absent from package.json
`"files"`, but `.next/standalone/` is in it — and Next's file tracer copies the raw App
Router sources into that bundle, so **82 `.ts`/`.tsx` files under `app/` ship verbatim**
alongside the compiled output. `scripts/prune-standalone.mjs` trims the bundle but
deliberately keeps `app`, because the standalone server reads from it.

Practical consequence: renaming a route directory changes the installed dashboard's URLs,
and anything you add under `app/` reaches every npm user. Verify with
`npm pack --dry-run --json | jq -r '.[0].files[].path' | grep standalone/app`.

## Where its tests live

`__tests__/actions/`, `__tests__/api/`, `__tests__/components/`, `__tests__/contexts/`, and
`__tests__/audit/` (the `audit/_components` React tests sit alongside the audit engine's),
run with `bun run test:run`. Browser-level layout checks are shell scripts under
`__tests__/e2e/layout/`, run with `bun run test:e2e`.

Notes: `app/components/` and `app/contexts/` were just moved in from the repo root on this
branch (`components/ui/button.tsx` → `app/components/ui/button.tsx`, both contexts likewise),
so imports are `@/app/components/...` — older code or docs referencing `@/components/...`
are stale. `app/policies/hooks-client.tsx` is by far the largest file here (~1,968 lines);
its `page.tsx` is only a Suspense wrapper. Route access is gated at runtime by
`FAILPROOFAI_DISABLE_PAGES`, checked in `app/layout.tsx` and in each page.
