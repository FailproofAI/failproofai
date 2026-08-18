# Changelog — `fp` CLI

## Unreleased

### The session moved to `~/.failproofai/fpcli/cli-auth.json`

- **Nothing to do. Nobody is signed out.** The session was at `~/.fp/cli.json`; it is now
  `~/.failproofai/fpcli/cli-auth.json`, still mode `0600`. A session at the old path is
  adopted on the next command, so an upgrade is invisible.
- **Adoption is a COPY.** The old file is left exactly where it is, which keeps a
  downgrade working — an older `fp` still finds its session where it left it — and means
  nothing irreversible happens on a machine mid-rollout. Remove `~/.fp/` yourself once
  you are happy.
- **It is best-effort on purpose.** If the new location cannot be written (read-only
  home, full disk, a symlink we refuse) the session found is still returned, so a machine
  that cannot be migrated keeps working rather than being logged out by our own
  housekeeping.
- **Why:** one product owned three top-level dotfiles — `~/.fp` (this CLI),
  `~/.failproofai` (the Enforcement CLI) and `~/.agenteye` (the SDK/collector spool).
  This collapses the first into the second. `~/.agenteye` stays: it is a wire contract
  with the collector, and renaming it from the SDK's side would write events into a
  directory nothing watches, with no error on either side.
- **`FP_HOME` still works and still wins.** Resolution is `FP_HOME` >
  `$FAILPROOFAI_HOME/fpcli` > `~/.failproofai/fpcli`. `FP_HOME` names the CLI's own
  directory and is used as-is, so an existing export addresses the same place it always
  did; `FAILPROOFAI_HOME` names the shared home root, so `fpcli/` is appended. The
  filename changed too (`cli.json` → `cli-auth.json`), so an `FP_HOME` user's old session
  sits beside the new path and is adopted from there. A redirected config is never
  reached past: with `FP_HOME` set the CLI does not look in `~/.fp` at all, because that
  would adopt a session from a context the user explicitly moved away from.
- **Nothing that authenticates without the config file changed.** `--token` / `FP_TOKEN`
  and `--api-key` / `FP_API_KEY` never touched disk and still do not, so CI that
  authenticates by environment never enters any of this. Read-only commands still create
  no file at all.
- **The CLI only ever creates.** It will bring `~/.failproofai` into existence on a
  machine that has never run the Enforcement CLI, and leaves a populated one untouched.
  The new path is registered in that home's layout (`src/hooks/fp-home.ts`) and
  classified `user-typed`, so a layout migration cannot drop it — `resettablePaths()` is
  a filter over that table, and only `derived` / `refetchable` entries are deleted. No
  `LAYOUT_VERSION` bump: nothing moved, and a bump would mark every existing home stale
  and run a reset on machines that have nothing to migrate.

### Two hardenings the shared directory made necessary

Both are consequences of writing next to another product's secrets rather than
into a directory the CLI owned outright.

- **A symlinked config no longer writes through to whatever it points at.**
  `O_TRUNC` follows symlinks, so a link at `cli-auth.json` pointing at
  `../credentials.json` made `fp login` silently truncate the Enforcement CLI's
  token and write the session over it — no error, nothing in either product's
  logs. The final component is now opened `O_NOFOLLOW` and a link is refused
  with a message naming the file. The link is not deleted: a symlink is
  something a person put there.
- **`fpcli/` is created `0700` rather than inheriting the umask.** A common
  `0002` umask made it `0775`. The session file itself was always `0600`, so it
  was never readable — but a group-writable directory lets anyone in the group
  replace the file, which is a session swap. The shared parent is untouched: if
  the CLI is the first to create `~/.failproofai` it leaves it to the umask, as
  the Enforcement CLI would, and an existing directory is never re-permissioned.
- **The session is written atomically, to a temp file that is renamed into place.**
  `O_NOFOLLOW` closed the symlink hole but says nothing about a **hard link** —
  that is not a link, it is a second name for one inode, so an in-place write
  went straight through it into the neighbour's file exactly as before. `rename`
  swaps the directory entry instead, so the other name keeps the old inode. The
  same change buys three more things: a reader never observes a half-written
  credential, two racing `fp` processes end with one whole session rather than a
  splice, and a FIFO left in the config position can no longer hang the CLI
  forever (`open` on a FIFO blocks for a reader; the previous code sat there
  indefinitely with no output). The temp file is removed on every failure path.

## 0.1.7

### Packaging fix: declare `click` and `pygments` explicitly
- **Fixes `ModuleNotFoundError: No module named 'click'` on a fresh install.** The CLI imports
  `click` directly (and `pygments` for SQL highlighting) but only ever got them transitively via
  `typer` / `rich`. Modern `typer` (>=0.13) **no longer installs `click`**, so a clean
  `pipx install fp-cli` left `click` absent and the CLI crashed on startup. Both are now listed
  as direct dependencies (`click>=8.1`, `pygments>=2.13`) so installs are self-contained.
- No behaviour change — same code, correct dependency metadata.

### `keys create` / `keys update`: compact permission format + shared ending
- **New permission input**: the compact `slug:action.action` token format, space-separated and/or
  repeated `-p` (both compose) — `keys create "ci-bot" -p events:read.add keys:read` expands to
  `events:read, events:add, keys:read` (de-duped). A malformed token (`events`, `events:`) or an
  unknown permission → a red `✗ bad permission …` box **before** any mutation (exit 2). Replaces
  the old one-permission-per-`-p` form.
- **`keys update` now takes the unique key NAME** (resolved to the id), not a UUID — consistent
  with `regenerate`/`disable`. Permissions REPLACE the current grants; a calm confirm (`replace
  permissions on key <name>? the key keeps working …`, default no, `--yes` skips); decline → faint
  `cancelled — permissions unchanged` box.
- **Shared ending** (both): a green `✓ created/updated key <name> · {n} permissions` line + the
  **same grouped permissions box** as `whoami` / `orgs perms`. `create` shows a `secret · shown
  once` green box first (piping still captures just the bare secret); name-collision → red box.
- `--json`: create `{id,name,permissions,created_at,key}`, update `{id,name,permissions,created_at,
  revoked_at}` — `permissions` is the expanded flat list.

### `keys`: boxed `list` (active-first), and name-based `regenerate` / `disable` flows
- **`keys list`** → a boxed `api keys · {n} · active first` table (`created · name · permissions ·
  status`) — **active keys sort to the top** (then revoked), each group newest-first. Status is
  colour-coded (`● active` green / `○ revoked` red; filled = live, hollow = dead) with a
  `{total} keys · {n} active · {m} revoked` footer. The raw UUID is hidden by default (`--show-id`
  for a short id, `--json` for the full id); created shows compact `MM-DD HH:MM`. `--json` unchanged.
- **`keys regenerate <name>` / `keys disable <name>`** now take the **unique key name** (resolved
  to the id), not a UUID. Every flow state is a **rounded notice box** (one consistent boxed
  family): an amber `confirm` box (`⚠ … <name>?` + dim consequence) with a `[y/N]` prompt below
  defaulting to **no**; a faint `cancelled` box (`○ nothing changed`) on decline (exit 0, no more
  red "Aborted"); a red `error` box (`✗ no key named <name>` + hint) when not found (exit 6); a
  green `secret rotated` box (regenerate — piping still captures just the bare secret on stdout)
  or `disabled` box (disable); a faint `no change` box when already disabled. `--json`: regenerate
  → `{name, secret}`, disable → `{name, status:"disabled"}`, decline → `{cancelled:true}`.
- Shared helpers `confirm_destructive` + `print_cancelled` + `_notice_box` (reused by the
  destructive key actions). `keys create` / `keys update` are unchanged (separate pass).

### `list <kind>`: one boxed, column-flowing view
All nine `list` subcommands (envs, agents, event_types, score_filters, models, hooks, triggers,
tools, error_types) now render through one shared boxed renderer (`render_value_list`):
- An ACCENT panel titled `{kind} · {count} {description}` with the (sorted) values in
  **column-major flow** — a column fills to 8 rows then overflows to the next; the column count
  is capped to the terminal width (prefers taller over wider-than-screen; never overflows; min
  one column). Empty → `none found`.
- A dim **filter-hint footer** for kinds that map to a real filter flag: `envs`/`agents`/
  `event_types` → `fp events --env/--agent-id/--event-type`, `error_types` →
  `fp errors --error-type`. Kinds with no matching value filter (models/hooks/triggers/
  tools/score_filters) get no footer.
- `--json` is unchanged (`{"kind", "values"}`).

### `orgs`: boxed `list`, a `current` identity card, and a new `orgs perms`
- **`orgs list`** now renders the same boxed `your orgs · N` panel as `whoami` (marker / org /
  name / role / perms + a `switch with …` line) instead of a plain table.
- **`orgs current`** is a compact `current org` identity card (slug + name · role + permission
  count · signed-in email) with a footer cross-linking `orgs perms` / `orgs switch`. The
  28-permission comma wall moved out. `--json`: `{slug, name, role, permission_count, user_email}`.
- **New `orgs perms`** — your grants in the active org as the grouped, risk-coloured permissions
  panel (the **same shared renderer** as `whoami`: read=green, create/modify=pink, invoke=amber,
  destructive=red; NO_COLOR `*`). `--json`: `{slug, role, permissions, permission_count}`.
- The permissions panel and the orgs panel are now single shared helpers
  (`render_permissions_panel` / `render_orgs_panel`) used by `whoami`, `orgs perms`, and
  `orgs list` so they can't drift. Resource order aligned (dashboards · keys · queries · users · …).

### `errors` now lists the errored events (with `--aggregate` for the old summary)
`errors` was a summary-only command; it now **fetches and lists the errored events** (the
dashboard `/errors` view), with the rollup moved behind a flag — mirroring `evals`.
- **`errors`** (default) — one row per errored event in an error-themed (muted red-purple)
  boxed table: `time · event · env · agent · session · summary`. The `event` cell is `● {type}`,
  **red only when the type names an error** (`error`/`fail`); the `summary` is derived from the
  payload (tool name, `error_type: message`, hook name, …) and truncates with `…`. Session ids
  truncate (`--full-ids` for whole). Same filter/paging options as `events`/`sessions` plus the
  errors-specific `--error-type`/`--search-exclude`.
- **`errors --aggregate`** — the old summary, redesigned as an errors-themed card: a large red
  hero count + `across N sessions · N agents · last <relative>`; zero errors → a calm green
  `✓ no errors found` in a neutral panel.
- `--json`: list → `{"errors": [...], "next_cursor": …}` (full event rows); aggregate → `{total,
  sessions, agents, last_ts, bins}`. Re-added `errored`/`error_type`/`search_exclude` to the
  `list_events` client. `analytics_cmds.py` renamed → `errors_cmds.py`.

### Score bar → braille + unified colour bands
- The `evals --aggregate` score bar now uses **braille** (`⣿` fill / `⣀` track) on a **zoomed
  `.40–1.0` scale** (so the typical .7–.9 range shows visible variation), with a band-tinted
  track. Falls back to solid blocks (`█`/`░`) under `NO_COLOR` (clearer in mono; failing avgs
  get a trailing `!`).
- **Unified score colour bands** (`.80`/`.50`, was `.85`/`.70`) used **everywhere** a score is
  coloured — the evals score cells, the aggregate avg, and the bar: **≥.80** cyan-green
  `#3ddbb8`, **.50–.80** amber, **<.50** red. So a given score reads the same colour CLI-wide.
- Aggregate gains a one-line legend under the panel: `scale .40–1.0 · ⣿ ≥.80  ⣿ .50–.80  ⣿ <.50`;
  the evals list footer legend updates to the new bands. Presentation only.

### Split scores back out: `sessions` (runs) vs `evals` (scores + `--aggregate`)
Refined the previous merge into a clearer operational-vs-quality split:
- **`sessions`** is now a pure run list — columns `time · env · agent · session · status`
  (the **scores column is gone**, and so are `--score`/`--scores-full`). Footer has no score
  legend. `--json` still includes `scores` per row.
- **`evals`** (renamed from `eval-aggregate`, now a full command) has **two modes, same filters**:
  - bare → the eval **list** with the scores column (`time · env · agent · session · status · scores`).
  - **`--aggregate`** → a redesigned two-panel view: a **totals card** (hero count + colour-coded
    status dots + a derived success-rate line) and a **score-stats table** (per metric: n, avg +
    a 10-cell threshold-coloured bar, min/max/p50), sorted worst-average first, all metrics shown.
  - `--json`: list → `{"evaluations": [...], "next_cursor": …}`; aggregate → `{total,
    status_counts, score_stats[], timeline}`.
- The standalone `eval-aggregate` command is removed (use `evals --aggregate`). Aggregate numbers
  are rounded to 2 decimals for display (full precision stays in `--json`); under `NO_COLOR` a
  failing avg (<.70) gets a trailing `!`. No change to what's computed or fetched.

### Merged `evals` into `sessions` (one command, not two)
`evals` and `sessions` both listed evaluation results from the same endpoint, so they're now
**one command: `sessions`**. The richer `evals` implementation (boxed output, full option set,
width-aware scores) was kept and renamed; the old `sessions` command was removed.
- `sessions` lists evaluation results newest-first with the boxed renderer (status colours,
  threshold-coloured scores, session-id truncation, `--full-ids`/`--scores-full`, score legend).
- `--json` returns `{"sessions": [...], "next_cursor": ...}`.
- The dead `list_sessions` client helper was removed. (`eval-aggregate` is unchanged.)
- Help/schema/README scrubbed of `evals`; top-level examples fixed to put the global `--json`
  before the command.

### Validation hardening (`--score` / `--from` / `--to`)
- **`--score KEY:..` (both bounds empty) is now a clean usage error (exit 2).** It used to pass
  validation and the server silently dropped it → the **unfiltered** set came back.
- **`--from`/`--to` now require a full RFC3339 UTC timestamp** (a `T` separator + a `Z`/offset).
  A timezone-less (`2026-05-01T00:00:00`) or space-separated value used to slip through and hit
  a server 400 (exit 1); it's now caught client-side as a usage error (exit 2).

### Redesigned the `evals` table
- **New default output**: the same accent-bordered rounded panel as `events`, built on a shared
  `render_list_panel` helper. Columns `time · env · agent · session · status · scores` (agent
  bright, the rest contextual-dim). **status** is colour-coded by state (done green / running
  amber / failed-error-timeout red); **scores** render as `metric value` with the value coloured
  by threshold (**≥.85** green / **.70–.85** amber / **<.70** red) and compacted (`.94`, `1.0`).
- **Scores are width-aware**: as many pairs as fit, then `+N`; an eval always stays one row and
  the `time`/`status` columns never get squeezed. `--scores-full` shows every pair (may wrap).
- **Session ids truncate** by default (`sess-…fcf97e01`); `--full-ids` keeps them whole. `--json`
  always has full ids + structured scores.
- **Footer** carries a compact score-colour legend (`score: ≥.85 .70–.85 <.70`), dropped on a
  narrow terminal. Under `NO_COLOR`, failing scores (<.70) get a trailing `!` so they stay visible.

### `evals`: fix docs, reorder options, drop `--latest-per-session`
- **Fixed the broken `--json` examples** in the `evals` help — `--json` is a **global** option and
  goes before the command (`fp --json evals …`), not after it (`fp evals … --json`,
  which exits 2). The docstring examples now show the correct form.
- **Reordered the options** to match the `events -h` layout: limit, since, from, to, session-id,
  env, agent-id, status, score, all, cursor, page-size, fields.
- **Removed `--latest-per-session`** — use `fp sessions` for the newest evaluation per
  session (it's the same query, deduped). The flag's client param is retained internally (the
  `sessions` command still forces it).

### Redesigned the `events` table + trimmed its filters
- **New default output**: an accent-bordered rounded box whose title carries the row count,
  sort direction and date (`events · 10 · newest first · 2026-06-22`), with columns
  `time · type · env · agent · session` (now sharing the `render_list_panel` helper with `evals`:
  a dim LABEL header + a thin rule). Rows show clock time (the date lives in the title); a
  window spanning more than one UTC day adds the date back into each row. The summary line below
  reads `<n> shown · more available · fp events --all`. `--json` is unchanged; `--fields`
  still prints the plain projected table.
- **Removed filters**: `--tool-name`, `--error-type`, `--errored`, `--search-exclude` (the
  `errors` command keeps the error/exclude filters). The now-orphaned `list_events` client params
  were dropped too.
- **`--environment` dropped in favour of `--env`** (one spelling). `evals`/`sessions`/`errors`
  still accept both.

### Replaced `facets` with `fp list <thing>`
The single `fp facets --kind <kind>` command is now a `list` group with one named
subcommand per dropdown, matching the dashboard's filters:
`list envs | agents | event_types | score_filters | models | hooks | triggers | tools | error_types`.
Each prints a flat list of the distinct values (or `--json {"kind", "values"}`) — the same
per-org cached data behind the dashboard dropdowns. **New: `list score_filters`** surfaces the
evaluation score keys/metrics (needs `evaluations:read`; the others need `events:read`).

### Slimmed the command surface (removed 7 commands)
Trimmed the CLI to a focused, maintainable core — each of these is still available in the
dashboard:
- **`environments`**, **`latency`**, **`score-keys`** — niche analytics one-offs; use `facets`
  (value discovery), `errors`, and `eval-aggregate` instead.
- **`session`** (the singular `session show` / `session export` group) — inspect a single session
  with `sessions`, `events --session-id <id>`, and `evals --session-id <id>`.
- **`re-evaluate`** — redundant; trigger a fresh evaluation from the dashboard.
- **`permission-sets`** (list/show/create/update/delete) — manage sets in the dashboard;
  `users`/`keys` still accept a set by name via `--permission-set`.
- **`dashboards`** (list/show/create/update/delete/tiles) — manage dashboards in the dashboard UI.

The orphaned client/model plumbing and their unit tests were removed alongside the commands.

### Reworked the `agent` command surface (chats + models; `compose-sql` removed)
- Dropped the `conversation-` prefix and renamed the list: **`conversations` → `chats`**,
  `conversation-show` → **`show`**, `conversation-rename` → **`rename`**, `conversation-delete`
  → **`delete`**. (`agent chats --json` now returns `{"chats": [...]}`.)
- **Removed `agent conversation-create`** — `ask` manages the chat lifecycle itself now.
- **`agent ask` is chat-first.** With **`--chat <id>`** it continues that chat (prior thread
  sent for context, new turn appended); **without it** it starts a **new** chat, answers,
  persists, and prints the new `chat_id` (the first question auto-titles it). The chat is created
  only once an answer lands, so a failed/aborted ask leaves no empty chat. (`--conversation` →
  **`--chat`**; `--json` now includes `chat_id`.)
- **New `agent models`** — lists the deployment's model allowlist (default marked), read from the
  agent health endpoint. **`agent ask --model`** is now validated against that allowlist
  client-side (an unknown model exits 2 with the valid choices) instead of silently falling back
  to the default.
- **Removed `agent compose-sql`** from the CLI.

### Fixed: `alerts update` single-field edits (were HTTP 500)
- A flag-only update such as `fp alerts update <id> --disabled` (the documented
  example) used to send a **partial** body to a server endpoint that does a **full
  replace**, which failed with `HTTP 500`. Only a complete `--file` AlertInput worked.
- `alerts update` now does a **read-merge** (like `users update`): with override flags and
  no `--file`, it fetches the current alert and re-sends it with just the named fields
  changed — so `--disabled`, `--severity`, `--name`, etc. work on their own. This path now
  needs `alerts:read` **and** `alerts:write`, and a missing alert returns a clean not-found
  (exit 6) instead of a 500. The `--file` path is unchanged (a straight full replace).

### Single `orgs` group (merged `org` + `orgs`)
- All tenant functionality now lives under one group, **`orgs`** — the separate singular
  `org` group was removed.
- **`orgs list`** — list the orgs you belong to with your role (permission set) and permission
  count in each; the active org is marked. `--json` adds `is_instance_admin` and a per-org
  `active` flag.
- **`orgs switch [slug]`** — switch the active tenant. Pass a slug (`orgs switch acme`) for a
  direct switch, or omit it (`orgs switch`) to choose from a list in a terminal — the current
  org is the Enter-to-keep default, a sole org auto-selects, and a non-interactive run requires
  a slug. Same access validation as `orgs use` (a non-existent/unauthorised slug is rejected).
- **`orgs use <slug>`** — set the default active tenant (unchanged behaviour, now under `orgs`).
- The interactive picker is shared between `login` and `orgs switch` (one implementation).

### Removed the `logs` alias
- Dropped the `logs` command (it was a duplicate alias of `events`). Use `fp events`.

### Consistent visual language across commands
- Unified the icon/colour vocabulary used everywhere: `◆` brand/identity (login header,
  `whoami`, `orgs list`), `›` step, `✓` success (green), `○` neutral status (dim), `✗` error
  (red). `whoami` when signed out is now a neutral `○ not signed in` line (not plain text), and
  when signed in leads with the `◆ <email>` banner + a clean key/value + orgs table.
- Errors render as a clean one-line `✗ <message>` (with a `try '… -h'` nudge for usage errors)
  instead of Typer's heavy red panel, so failures match the success/status lines. A doubled
  "Did you mean …?" suggestion is collapsed.

### Cleaner login output
- The sign-in flow now shows a single line — **`sending a 6-digit OTP to <email> …`** (the
  email highlighted) — and drops the dashboard-URL line and the "code is in your email / dev
  SMTP" hint. It states only that an OTP was sent, never whether the address is valid.

### Logout clears the whole session
- `logout` now clears the **active org**, email, and user id from `~/.fp/cli.json`
  (not just the token) — previously the file kept `org`/`email`/`user_id`, so the CLI
  "remembered" the last tenant after logout. `base_url`, the `insecure` preference, and the
  machine-stable `anonymous_id` are kept. The next `login` therefore starts the org picker
  fresh, with no remembered default.
- `logout` when you are **not** signed in is now a no-op that reports `○ already signed out`
  (and `"already_signed_out": true` in `--json`) instead of falsely confirming a `✓ signed out`.

### Nicer login/logout experience (presentation only)
- Restyled the sign-in flow — a compact `◆ fp · sign in` header, `›` step lines, a
  cleaner numbered org picker, and a `✓ signed in as … · <org>` confirmation (and `✓ signed
  out`). No behaviour change; all of it is stderr chrome, so `--json` stdout is unchanged.

### Org validation at login / `orgs use`
- `login --org <slug>`, `FP_ORG`, and `orgs use <slug>` now **validate the org
  against the server before saving it** — it must exist and be accessible to you. This
  fixes a hole where an instance admin could activate (and persist) a non-existent or
  unauthorised slug (e.g. a typo like `--org fp`), which then broke every later
  command. A member's own orgs are accepted with no extra round-trip; a non-member org is
  verified via a cheap org-scoped probe (HTTP 200 → ok, otherwise rejected with
  "Org '<slug>' does not exist or you do not have access to it").

### Login org picker
- `login` now shows an **interactive org picker** after your email is verified when you
  belong to more than one org, so you choose the active tenant each login instead of
  silently re-entering a previously-saved one. A still-valid saved org is offered as the
  Enter-to-keep default (marked `(current)`). An explicit `--org`/`FP_ORG` still skips
  the picker; single-org users still auto-select. In a non-interactive run (`--json` / piped
  stdin) a still-valid saved org is reused, else login reports `needs_org_selection`.

## 0.1.6

Full parity with the dashboard API, multi-tenant support, and exhaustive telemetry.

### Multi-tenancy (correctness fix)
- The CLI is now org-aware. The active tenant is chosen **at login** (`login --org <slug>`)
  and persisted; override per command with the global `--org` / `FP_ORG`, or change the
  default with `orgs list` / `org use <slug>`.
- Every request now sends the `X-AgentEye-Org` header, so **multi-org accounts work** (previously
  they were rejected). Permissions are resolved per org.
- `whoami` reports the active org, instance-admin status, per-org permissions, and all memberships
  (the session model dropped the old flat `permissions` list).

### New command groups
- **keys** — create/list/update/disable/regenerate API keys (secret shown once).
- **query** — saved SQL + ad-hoc runner (`query run`), schema introspection.
- **users**, **permission-sets**, **settings** — org administration.
- **alerts**, **incidents** — alert definitions and incident triage.
- **dashboards** (+ tiles), **agent** (`ask`, `compose-sql`, conversations) — JSON/streaming.
- **facets**, **errors**, **latency**, **score-keys**, **eval-aggregate** — discovery & analytics.
- `events` gains `--tool-name`, `--error-type`, `--errored`, `--order`, `--search`, `--search-exclude`.
- **schema** — emits the entire CLI surface as JSON for agents/tooling.

### Safety & ergonomics
- Mutations confirm in a terminal but auto-skip under `--json` / non-TTY; `--yes`/`-y` to skip.
- Complex bodies accepted via `--file payload.json` (or `--file -` for stdin).
- One-time API-key secrets print to stdout (capturable) with the warning on stderr.

### Telemetry
- Every command/subcommand and flag is tracked (the catalog is derived from the app, with an
  anti-drift test that fails if anything goes untracked). Per-action events for all mutations.
  Privacy unchanged: only static names/enums/coarse counts — never ids, emails, SQL, or values.

### Notes
- Exit code `6` (resource not found) is now documented.
- New global option `--org`/`FP_ORG`.

## 0.1.5 and earlier

See the repository changelog.
