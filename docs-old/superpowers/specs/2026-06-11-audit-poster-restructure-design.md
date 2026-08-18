# Audit poster restructure + dashboard restraint

**Date:** 2026-06-11
**Branch:** `luv-434`
**Status:** design — awaiting review

## Goal

Pull the failproofai dashboard's visual treatment back toward the calm aesthetic of the
agenteye demo (dark canvas, sharp 1px borders, no decorative overlays). Concurrently
restructure `/audit` into a single-screen poster + four below-fold sections. The audit
poster is the only quirk-bearing surface; `/policies` and `/projects` become calm, info-
dense surfaces with no brutalist decoration.

## Scope

### In scope

- Strip body-level decoration site-wide (scanlines, dual gridline overlay, noise filter,
  per-page hard-offset shadows, text-shadow stamps).
- Migrate the brand pink from `#e4587d` to `#e4587c` everywhere it appears (one hex digit;
  ~36 references across 4 CSS files).
- Rebuild `/audit` into 5 sections with a new component layout.
- Restyle `/policies` and `/projects` to use only the calm base styles.
- Keep the current top-nav (no sidebar swap).

### Out of scope

- Reminder delivery mechanism (email / push / cron). UI for selecting a cadence ships;
  the dispatch backend ships in a follow-up.
- Perks fulfillment (what "pro features for a month" unlocks, the entitlement system,
  invite tracking). UI for the share-to-unlock card ships; the backend ships in a
  follow-up.
- Rarity data collection. The poster reads `archetypeRarityPct` and `scoreRank` from a
  new (mocked-for-now) field on the audit result; a separate task populates them from
  real aggregate data.
- Mobile layout polish. The current `/audit` desktop-first treatment carries over.
- Top-nav → sidebar migration. Considered and rejected (option C, scope question).
- Animation tuning. Existing sigil reveal animation is dropped; no new animations.

## Visual system change (cross-cutting)

### Body atmosphere — strip

In `app/globals.css`:

- Remove `body::before` (engineering-plate cross-hatch gridlines at 96px and 24px tile
  sizes).
- Remove `body::after` (fractalNoise SVG overlay).
- Replace the body background-image stack with a single soft cyan/teal radial glow at
  top-right plus the existing bottom-left pink glow, attached to `background-attachment:
  fixed`. Net visual: a calm, slightly atmospheric dark canvas — closer to the demo's
  "soft glow around the app frame" feel.

In `app/audit/audit-styles.css`:

- Remove `.scanline-overlay`.
- Remove every `box-shadow: NNpx NNpx 0 0 var(--accent-pink-shadow)` declaration (hard-
  offset pink stamps) — except the share-button hover state, which is the only
  interaction that earns the effect.
- Remove every `repeating-linear-gradient(…)` declaration used as a per-section
  background (the pink+green gridlines on `.archetype-frame`, `.empty-panel`,
  `.score-share-card`, `.showoff-cta`, `.share-card`).
- Remove every `text-shadow: NNpx NNpx 0 var(--accent-pink-shadow)` declaration (the
  hard-stamp shadow on display-font headings).
- Remove every `box-shadow: 6px 6px 0 0 var(--accent-pink-shadow)` style (similar
  treatment on `.sigil-wrap[data-bare="true"]`, `.empty-glyph-grid`, the project list
  empty-state grid).

### Pink color migration

Replace `#e4587d` with `#e4587c` (RGB 228,88,125 → 228,88,124) in:

| File | Refs |
|---|---|
| `app/globals.css` | `--accent-pink` token + a few inline rgbs |
| `app/audit/audit-styles.css` | bulk of refs (~25) |
| `assets/audit/poster-styles.css` | poster-export styles |
| `assets/audit/styles.css` | shared audit assets |

The derived `rgba(228, 88, 125, X)` values also become `rgba(228, 88, 124, X)`. The hex
delta is subliminal but the design system needs the canonical value.

### Surfaces that calm down

Apply this rule globally: `1px solid var(--line-2)` borders, `var(--bg-2)` fill, no
shadows, no inner backgrounds with gridlines. Internal dividers become `1px dashed
var(--line)`. This is the demo's atomic look.

Affected classes (existing): `.archetype-frame`, `.strength-row` container,
`.score-share-card`, `.finding`, `.policy-card`, `.share-card`, `.empty-panel`,
`.running-panel`, `.showoff-cta`, `.panel`.

## `/audit` page — new structure

```
┌──────────────────────────────────────────────┐
│  01  POSTER  (single screen, fits viewport)  │
├──────────────────────────────────────────────┤
│  02  STRENGTHS — what it's great at          │
├──────────────────────────────────────────────┤
│  03  QUIRKS — what to improve                │
├──────────────────────────────────────────────┤
│  04  HOW TO IMPROVE — install/configure      │
├──────────────────────────────────────────────┤
│  05  COME BACK BETTER — reminder + perks     │
└──────────────────────────────────────────────┘
```

Each section sits in a calm shell: header row (small green eyebrow `// label` + a small
section count on the right), then a plain lowercase title, then content. 1px solid
divider between sections.

### Section 01 — Poster

A self-contained PNG-capture region. Anything inside this region must work as a stand-
alone shareable image. Layout (3-column grid: score · persona · sigil):

| Slot | Content |
|---|---|
| Top-left | `▣ failproof_ai · audit` wordmark (small, ink color, brand mark pink) |
| Top-right | `№ 01 of 08 · audited 2026-06-11` (archetype index from data + date) |
| Body left | `87 / 100` (display font, 76px, pink); below: `top 15%` (small caps, green) |
| Body center | `the optimist` (display font, 32px, lowercase); below: 3-keyword strip `pace · conviction · forgetful` (green · ink · pink); below: `// only 12% of agents are this archetype` (rarity) |
| Body right | 8×8 sigil tile (12px cells, 1px border, no plate, no animation, no stacked shadows) |
| Bottom-right | `audit yours → failproof.ai` (small horizontal text, green) |

The capture region uses a `1px dashed var(--accent-pink-soft)` outer border to read as a
poster-like edge. A subtle radial pink glow at top-right gives the poster a hint of
depth without competing with the body.

**Outside the capture region** (UI only, not part of the PNG): a row of three share
buttons — `[ 𝕏 post your archetype ] [ in share on linkedin ] [ ↓ download poster ]` —
plus a scroll hint `scroll for full report ↓`.

Dropped from the current Identity hero: hard-offset shadow, archetype index "corner"
labels (TL/TR/BL/BR positioned text), dashed-frame chrome, sigil plate with crosshair
marks, sigil reveal animation, archetype "tagline" prose line, archetype "common in"
meta grid, archetype closing line, signature receipt block.

### Section 02 — Strengths · "what it's great at"

3 rows; each: `✓` glyph · headline + sub-detail · right-aligned metric with small-caps
unit label. No card chrome, no hover backgrounds, no checkmark backdrop. 1px dashed
divider between rows.

The metric units currently fluctuate (sessions / 18-of-18 / 80k cap). The spec keeps
this — uniform metrics would be a separate spec — but adds a note to the implementation:
prefer `N / M sessions` framing when possible, fall back to absolute counts.

### Section 03 — Quirks · "what to improve"

A 4-column table:

| Col | Width | Content |
|---|---|---|
| `time` | 60px | timestamp like `09:14` (5-sec resolution) |
| `what slipped` | 1fr | tool call + arg; below in dim: `would've been caught by: <policy-slug>` |
| `severity` | 80px | pill (low / medium / high) — color-coded |
| `seen` | 70px | `new` · `2× this wk` · `recurring` |

Section header on the right shows `N slipped through`. The row is a plain grid; no card
chrome, no corner crosshairs, no per-finding numbered card.

The current 4-quadrant `.finding-body` (description · evidence · cost · fix) is
collapsed. Evidence + fix are accessible via an inline expander (chevron on the row), or
deferred to the "how to improve" section below — they're not duplicated on the row
itself.

### Section 04 — How to improve · "install or configure"

A small card per recommended action. Each card:

- Left: title (`install <code>no-sensitive-files</code>` or `configure …`); below:
  `would catch quirk #N · <short description>`; below: `$ failproofai install <slug>`
  (green, monospace, dashed top-divider above it).
- Right: install/configure button (pink outlined, small caps, primary affordance).

Card chrome: `1px solid var(--line-2)`, background `var(--bg-2)`. No shadows. 10px gap
between cards.

The mapping from quirk → fix is explicit in copy (`would catch quirk #1`) — this is the
only cross-reference between sections.

### Section 05 — Come back better · "build the habit"

Two side-by-side cards, equal width:

**Left card — Set a reminder.** Title + one-sentence sub. A row of 4 cadence buttons:
`3d` · `7d` · `14d` · `30d`. The current selection (`7d` default) has a pink filled
outline; the others are plain 1px ink-color outlines. Clicking a cadence persists the
choice (UI-only in this spec; backend dispatch is out of scope).

**Right card — Unlock failproof perks.** Title + sub: `share with 3 friends → unlock
pro features for a month.` Progress bar (6px tall, pink fill on dark track), `1 of 3
invited · 2 to go` text, `invite a friend` button (pink outlined). Footer: `// invites
are tracked by signup — they have to run an audit too.`

Both card backgrounds are `var(--bg-2)` with `1px solid var(--line-2)` borders. No
shadows.

The perks card UI is real; the backend that tracks invites + grants entitlement is
out of scope. The component should accept `inviteCount` and `inviteTarget` as props
and render proportionally — the placeholder values (1/3) come from a mock for now.

## `/policies` and `/projects` — calm-down

The structure does not change. Styles calm down AND headings revert to the plain
title-case wording that existed prior to the brutalist redesign (reference: commit
[`a0a18415`](https://github.com/FailproofAI/failproofai/commit/a0a18415c5ee93d13bfb64985616b0bbb1346b4d)).

These two pages are utility surfaces, not brand artifacts — they get sharp English
headings, not the lowercase + `// comment` style we kept for the audit poster. The
visual languages diverge by purpose: the audit page is a poster, `/policies` and
`/projects` are dashboards.

### `/policies` headings (revert wording, drop chrome)

| Element | Current | Revert to |
|---|---|---|
| Page heading (activity tab) | `Policies` (lowercase via `textTransform: none` + `section-h` chrome) | **`Policies`** plain title case, no chrome |
| Page heading (configure tab) | `what to stop them doing.` | **`Configure Policies`** |
| Subheading prose | `{evaluationsHeading}.toLowerCase()` + `enabled policies N/M` | **`{evaluationsHeading}`** in its original title case (`Policy evaluations across …`) |
| Tab labels | `Activity` / `Configure` (already correct in `TabBar`) | unchanged |

Drop the `section-h-dot` ping animation next to the activity heading — the
`evaluationsHeading` prose carries the "live" signal already.

### `/projects` headings (revert wording, drop chrome)

| Element | Current | Revert to |
|---|---|---|
| Section eyebrow | `━━ projects` glyph + `● N folders` meta | **drop entirely** |
| Page heading | `your agent footprint.` (lowercase, period) | **`Projects`** plain title case |
| Empty-state copy | `no projects found in the .claude/projects directory.` (with pink `<code>` highlight) | **`No projects found in the .claude/projects directory.`** plain sentence case |
| Empty-state pixel grid | renders with `boxShadow: 4px 4px 0 0 var(--accent-pink-shadow)` | drop the shadow; keep the grid |

### Inner components — auto-calm via tokens

- `ProjectList` uses Tailwind utilities that resolve to the audit palette through
  shadcn aliases (`bg-card`, `border-border`, `text-muted-foreground`, …). It calms
  automatically once the underlying tokens lose their decorative treatments. No
  component changes expected.
- `HooksClient` uses `Button`, `lucide` icons, and a table-style activity list. Same
  auto-calm via tokens. No restructure.

### Style scope

- Wrap-up containers (`.report`, `.section`) stay — they're the calm shell that the
  demo also uses (max-width + horizontal padding).
- All instances of `section-h` styling that previously rendered the `━━` glyph + green
  eyebrow on `/policies` and `/projects` are replaced with plain `<h1>` / `<h2>` tags
  using `text-2xl font-semibold tracking-tight text-foreground` (or equivalent).
- The `section-mast` row that held the eyebrow + count meta is dropped on these two
  pages.
- `section-h-dot` is dropped on `/policies`.

## Component map (old → new)

| Old file | Action | Notes |
|---|---|---|
| `_components/identity-section.tsx` | renamed → `audit-poster.tsx` | rebuilt to the 3-column poster layout above |
| `_components/sigil.tsx` | simplified | drop `.sigil-plate`, `.sigil-mark` corner crosshairs, `.sigil-strip` header/footer, animation; keep just the 8×8 grid. Reused by the new `audit-poster.tsx`. |
| `_components/strengths-section.tsx` | restyled in place | drop hard borders + hover backgrounds; rows become demo-style |
| `_components/findings-section.tsx` | renamed → `quirks-section.tsx` | restructured as a 4-column table; per-finding card chrome dropped |
| `_components/score-section.tsx` | **deleted** | score + tier + share moved into the poster |
| `_components/show-off-cta.tsx` | **deleted** | poster owns sharing now |
| `_components/share-dock.tsx` | **deleted** | floating dock redundant given poster share buttons |
| `_components/share-templates.ts` | kept | template copy still drives the X / LinkedIn intent URLs |
| `_components/policies-section.tsx` | renamed → `how-to-improve-section.tsx` | restyled to fix-card layout; copy reframed around "would catch quirk #N" |
| `_components/return-section.tsx` | renamed → `come-back-better-section.tsx` | restructured as 2 side-by-side cards (reminder + perks) |
| `_components/report-footer.tsx` | kept | already calm |
| `_components/empty-state.tsx` | restyled | drop hard-offset shadow, drop gridline background |
| `_components/run-progress.tsx`, `audit-progress-strip.tsx`, `rerun-button.tsx`, `auth-dialog.tsx` | restyled | drop the loud bits, no structural changes |

The audit dashboard's outer shell (`audit-dashboard.tsx`) wires up the new component
list. The `Sigil` component continues to be reused by the share template / poster export.

## Data dependencies

| Field | Source | Status |
|---|---|---|
| `score` (0-100) | existing `scoring.ts` | ready |
| `archetype.name` (e.g., `"the optimist"`) | existing `archetypes.ts` | ready |
| `archetype.index` (e.g., `"01"`) | existing `archetypes.ts` | ready |
| `archetype.keywords` (3 strings) | existing `archetypes.ts` | ready |
| `archetype.signature` (3-line trace) | existing `archetypes.ts` | not used on poster (preserved for future use) |
| `archetypeRarityPct` (e.g., `12`) | **NEW** — seed value | seeded from snapshot data |
| `scoreRank` (e.g., `top 15%`) | **NEW** — derived from aggregate distribution | seeded from snapshot data |
| `auditDate` (ISO date) | existing `cachedAt` | ready, reformatted |
| `reminderCadence` (3 / 7 / 14 / 30 days) | **NEW** — user setting | UI ships; dispatch is a follow-up |
| `inviteCount`, `inviteTarget` | **NEW** — mock for now | UI ships; tracking backend is a follow-up |

The 5 NEW fields land on the audit result shape as an additive change. None block UI
shipping — they default to placeholder values until the backing data is wired up. The
poster's rarity line falls back to nothing (no fake numbers) when the field is missing.

## Out-of-scope follow-ups (worth tracking)

1. Reminder dispatch backend (cron + email/push)
2. Perks fulfillment + invite tracking (entitlements, share-link tracking, audit-run
   verification)
3. Aggregate rarity data pipeline (population of `archetypeRarityPct`, `scoreRank`)
4. Mobile layout audit + responsive polish
5. Poster PNG export quality at 1080×1080 / 1200×630 ratios
6. Brand wordmark / logo asset for the poster (current `▣ failproof_ai · audit` is a
   text mark — designers may want a proper monogram)

## Testing

- Visual regression: snapshot the new audit page, policies page, projects page in CI
  (Playwright + screenshot diff). Re-baseline once the design lands.
- Unit: pink hex check — grep for any remaining `#e4587d` in CSS/TS, fail CI.
- Unit: poster PNG capture — exercise the `html2canvas` flow against the new poster
  HTML, assert all 8 required elements are present in the captured DOM.
- Manual: each archetype renders the poster correctly (run the page for each of the 8
  archetypes — sigil + keywords + name + rarity).
- Manual: rarity field missing → rarity line is omitted, not zeroed.

## Open questions

These are not blockers for the design doc, but the implementation plan should resolve
each before code is shipped:

1. The "audited 2026-06-11" date on the poster — does it use the local browser timezone
   or UTC? The poster might be shared across timezones — UTC is safer, browser-local is
   more meaningful to the original viewer. Recommend UTC + ISO date format.
2. Score rank ("top 15%") — calculated against what cohort? Global all-time? Last 30
   days? Same-archetype users? The framing changes whether "top 15%" is impressive.
3. Perks card copy — "pro features for a month" promises something we haven't built.
   Acceptable to ship as aspirational, or rephrase to a softer hook ("share to support
   the project") until perks are real?
