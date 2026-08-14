# Bitcount Prop Single — font template

The title / wordmark treatment from **befailproof.ai**, packaged so you can drop
the exact same look into any project.

**Fine-tuned instance:** `font-variation-settings: "wght" 417, "ELSH" 55` (slnt 0),
horizontally squished `scaleX(0.9)`, `letter-spacing: 0.08em`, lowercase. All four
are exposed as knobs in `bitcount.css`.

## Files
- `bitcount.css` — the reusable `.bitcount-title` class + tunable `:root` knobs, plus a self-host `@font-face`. Framework-agnostic.
- `bitcount-prop-single.woff2` — self-hosted static instance with `wght 417` + `ELSH 55` baked in (no runtime variable-axis dependency, renders correctly on every device including phones).
- `fonts.ts.example` — Next.js `next/font/google` loader (rename to `fonts.ts`). Matches how befailproof.ai loads it.

## Use it

### Next.js
1. Rename `fonts.ts.example` → `fonts.ts`, import `bitcount` in your root layout, add `bitcount.variable` to `<html>`.
2. Import `bitcount.css` and **delete its `@font-face` block** (next/font already provides `--font-bitcount`).
3. Add `class="bitcount-title"` to headings / wordmarks.

### Anywhere else
1. Copy `bitcount.css` + the bundled `bitcount-prop-single.woff2` into your project (keep them in the same folder so the relative `url(...)` in `@font-face` resolves).
2. Import `bitcount.css`, add `class="bitcount-title"` to your headings / wordmarks.

> **Why a bundled static woff2?** Google Fonts' CDN serves a static default-instance of Bitcount Prop Single to many mobile user-agents, so `font-variation-settings: "ELSH" 55` silently no-ops on phones and the title renders as round dots instead of rounded squares. Self-hosting an already-instanced woff2 avoids that.

## Tuning knobs (`:root` in `bitcount.css`)
| Variable | Default | Effect |
|---|---|---|
| `--title-scale` | `0.9` | title size multiplier |
| `--title-squish` | `0.9` | horizontal `scaleX` squish |
| `--title-tracking` | `0.08em` | letter-spacing |

To re-tune the glyph shape itself, change `"wght"` / `"ELSH"` in the
`font-variation-settings` of `.bitcount-title`.

## Provenance
Recovered from the befailproof.ai web platform (PR #374). Axis values verified
against the final iteration of that work (earlier passes used wght 413/414 and
ELSH 51.4 before settling on **417 / 55**). The exact `--title-scale` application
and the fallback stack are reconstructed from the session — adapt to your project.
