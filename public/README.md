# public/

Part of **the dashboard** (the Next.js 16 app). Everything here is served verbatim at the site
root by Next's static handler — `public/logo.svg` is reachable as `/logo.svg`. It holds three
files only: the brand mark, the favicon, and the one self-hosted webfont the audit pages need.

Do not confuse it with `assets/`, which is brand/reference material (the audit design lab, the
per-CLI logo SVGs, `readme-arch-hq.gif`) that is **not** served and is explicitly deleted from the
build output by `scripts/prune-standalone.mjs`.

## What this is

| File | Served as | Referenced by |
|------|-----------|---------------|
| `logo.svg` | `/logo.svg` | `app/components/navbar.tsx` (`LOCAL_LOGO_URL`), `app/audit/_components/audit-poster.tsx`, `report-footer.tsx` |
| `icon.svg` | `/icon.svg` | `app/layout.tsx` — the `metadata.icons.icon` favicon |
| `audit/fonts/bitcount-prop-single.woff2` | `/audit/fonts/…` | the `@font-face` `src:` at `app/globals.css:22` |

## Who consumes it

The Next server at runtime, and browsers loading the dashboard. Nothing in the CLI (`src/`,
`bin/`) or the Rust daemon (`crates/`) reads this directory. Gotcha: `logo.svg` and `icon.svg` are
**byte-identical copies** of `assets/logos/company/logo.svg` and `icon.svg` (verified by md5) with
no sync step — edit one and the other silently goes stale. `navbar.tsx` treats `/logo.svg` as the
fallback when its remote logo fetch fails, so a missing file degrades quietly rather than erroring.

## Does it ship

Yes, but indirectly. `public/` is not itself in package.json `files`; `.next/standalone/` is, and
`bun run build` produces `.next/standalone/public/` with these files inside. Renaming a file here
without updating its referencing component gives an installed user a broken favicon, a broken
navbar logo, and an audit page that silently falls back to a system font.

## Where its tests live

No test targets this directory directly. The nearest coverage is the packaging assertions in
`__tests__/ci/release-pipeline.test.ts`, which guard what ends up inside `.next/standalone`; run
them with `bun run test:run`.
