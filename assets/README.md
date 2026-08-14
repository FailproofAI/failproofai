# assets/

## What this is

Brand and reference material, not application source. Nothing here belongs to any of the five
products — no file in `assets/` is imported by the CLI, the Next dashboard, the Rust daemon, or
the docs site. It holds `logos/` (per-CLI logo SVGs plus `logos/company/`, mirrored into
`public/`), `readme-arch-hq.gif` (11 MB, the root README animation), `font-kit/` (the
befailproof.ai Bitcount wordmark packaged for reuse — see its own README), and `audit/`, a
standalone design lab of `.jsx`/`.html` files opened directly in a browser by a human.

## Who consumes it

Humans and GitHub, not code. `README.md` at the repo root embeds `assets/readme-arch-hq.gif` and
the twelve `assets/logos/*.svg` files; `scripts/translate-docs/readme-translator.ts` rewrites
those same paths to absolute `raw.githubusercontent` URLs for the 14 translated copies under
`docs/i18n/`, because a relative `assets/` path resolves nowhere from two directories down and
Mintlify has no `assets/` tree at all. `assets/audit/*.jsx` is a prototype for the audit report —
it is opened by hand, never built or imported. `eslint.config.mjs` ignores `assets/` wholesale.

## Does it ship

No. `assets/` is not in package.json `"files"`. It once reached users anyway: Next's file tracer
swept it into `.next/standalone`, which *is* shipped, so 612 KB of design lab went out in every
tarball — and moving the 11 MB GIF here would have put that in front of every `npm install`.
`scripts/prune-standalone.mjs` now deletes `assets` from the standalone root deliberately.
**Adding a file here does not ship it, and should not.** If a user-facing asset is needed, it
belongs in `public/` (dashboard) or `docs/` (site).

## Where its tests live

`__tests__/ci/tarball-surface.test.ts` — `assets` is the first entry in its
`MUST_NOT_SHIP_UNDER_STANDALONE` list, so the prune is a tripwire, not a convention. Run it with
`bun run test:run`.
