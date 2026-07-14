ultracode

You are an automated **ultracode** (multi-agent) run inside a fresh clone of the
failproofai repository. Your job is to keep failproofai in sync with the upstream
documentation for **every** agent CLI we integrate with, then open exactly one
pull request with the fix — or, if a sync PR is already open, comment on it instead.

## Run contract (read first)

- You are running **headless and autonomously**. No human is watching; nobody can
  answer a question mid-run. For reversible actions that follow from this task,
  proceed without asking. Do **not** end your turn with a plan or a question —
  finish the work.
- The entrypoint has **already cut a fresh branch** named `auto/sync-cli-harnesses-<UTC>`.
  Do all your work here; do **not** switch branches or work on `main`.
- failproofai's own Stop hooks are active in this checkout. If you make commits, you
  will not be allowed to stop until you have **committed**, **pushed**, and **opened a
  PR** for them. If you make **no** commits (nothing to sync, or you only commented on
  an already-open sync PR), a clean working tree stops fine — so on those paths, do
  **not** edit any files.
- Use ultracode / multi-agent orchestration: in Phase 1, fan out **one subagent per
  CLI** so the seven harnesses are checked in parallel.

failproofai integrates with **seven** agent CLIs. Each has its own hook surface,
tracked in `src/hooks/types.ts` and written to disk by `src/hooks/integrations.ts`:

| CLI            | Event array (`src/hooks/types.ts`) | Event map | Settings file written (`src/hooks/integrations.ts`) |
|----------------|------------------------------------|-----------|------------------------------------------------------|
| Claude Code    | `HOOK_EVENT_TYPES` (canonical)     | — (canonical)          | `.claude/settings.json` |
| OpenAI Codex   | `CODEX_HOOK_EVENT_TYPES`           | `CODEX_EVENT_MAP`      | `.codex/hooks.json` |
| GitHub Copilot | `COPILOT_HOOK_EVENT_TYPES`         | — (already Pascal)     | `.github/hooks/failproofai.json` |
| Cursor Agent   | `CURSOR_HOOK_EVENT_TYPES`          | `CURSOR_EVENT_MAP`     | `.cursor/hooks.json` |
| OpenCode       | `OPENCODE_HOOK_EVENT_TYPES`        | `OPENCODE_EVENT_MAP`   | `.opencode/opencode.json` + `.opencode/plugins/failproofai.mjs` |
| Pi             | `PI_HOOK_EVENT_TYPES`              | `PI_EVENT_MAP`         | `.pi/settings.json` |

## What "drift" means — three scopes

For each verified CLI, compare the upstream docs to this repo across three scopes:

1. **Scope 1 — hook event names.** Events documented upstream but missing from (or
   removed from) the CLI's `*HOOK_EVENT_TYPES` array in `src/hooks/types.ts`.
2. **Scope 2 — tool / payload schema.** Changes to the CLI's tool names or payload
   field shapes, tracked in the `*_TOOL_MAP` / `*_TOOL_INPUT_MAP` tables in
   `src/hooks/types.ts` and in the per-CLI response-shape branches of
   `src/hooks/policy-evaluator.ts`.
3. **Scope 3 — settings-file shape.** Changes to the structure of the config file
   failproofai writes for the CLI: the hard-coded literals in
   `src/hooks/integrations.ts` (matcher-wrapper vs flat-array vs packages-array vs
   plugin registration; field names like `command` vs `bash`/`powershell`;
   `timeout` vs `timeoutSec` and its **unit** seconds-vs-ms; presence of `version`
   / `$schema` / `matcher`; the settings-file path) **and** the committed dogfood
   fixture on disk. The canonical worked example is git history / PR #482, which
   dropped an invalid top-level `version` field and fixed a `60000`ms→`60`s timeout
   unit in `.codex/hooks.json` by editing the writer, the fixture, and the tests
   together.

## Reading rules

- This run relaxed two policies (`require-ci-green-before-stop`,
  `block-read-outside-cwd`) so you can read and edit the settings fixtures. Even so,
  when you only need to **inspect** a committed fixture, prefer
  `git show HEAD:<path>` (e.g. `git show HEAD:.codex/hooks.json`) — it is never
  blocked and is the reliable way to read `.claude/settings.json`, `.codex/hooks.json`,
  `.cursor/hooks.json`, `.github/hooks/failproofai.json`,
  `.pi/settings.json`, and `.opencode/*`.
- Do **NOT** run `failproofai policies --install` (or any `failproofai` subcommand)
  to regenerate a fixture — it is blocked. Edit fixtures by hand.

## Phase 1 — Fan out one subagent per CLI

Spawn one subagent per CLI (seven, in parallel). Each subagent, for its CLI:

1. `WebFetch` the docs URL(s) below and extract the authoritative lists: the hook
   **event names**, the **tool names / payload field names**, and the
   **settings-file schema** (top-level keys, per-entry shape, command field name,
   timeout field name **and unit**, and whether `matcher` / `version` / `$schema`
   are present). **Use upstream casing exactly** — Codex snake_case, Cursor
   camelCase, OpenCode dot.namespaced, Pi snake_case, Claude/Copilot
   PascalCase. Do **not** normalize.
2. Compare against this repo: the CLI's `*HOOK_EVENT_TYPES` array + paired
   `*EVENT_MAP` (scope 1); its `*_TOOL_MAP` / `*_TOOL_INPUT_MAP` and its branch in
   `src/hooks/policy-evaluator.ts` (scope 2); its literals in
   `src/hooks/integrations.ts` + its dogfood fixture read via `git show` (scope 3).
3. Return a structured report: `{ cli, status: up-to-date | drift | unverified,
   scope1: {added, removed}, scope2: {...}, scope3: {...}, sources: [...] }`.

If a docs URL 404s, redirects to a stub, or has no parseable list, mark that CLI
`unverified` and skip its diff. **Do not invent events, tools, or fields. Do not
guess from prior knowledge.** Pi is the most likely `unverified` candidate (its
surface is documented in the package source, not a clean enumeration).

| CLI       | Docs URL(s) |
|-----------|-------------|
| Claude    | https://code.claude.com/docs/en/hooks (reference) · https://code.claude.com/docs/en/hooks-guide (summary) |
| Codex     | https://developers.openai.com/codex/hooks |
| Copilot   | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks · https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference (tool names) |
| Cursor    | https://cursor.com/docs/hooks |
| OpenCode  | https://opencode.ai/docs/plugins/ |
| Pi        | https://www.npmjs.com/package/@mariozechner/pi-coding-agent |

## Phase 2 — Decide what to do (do this BEFORE editing any files)

Merge the subagent reports into one list of detected drift. Then, **before you edit a
single file**, decide which path you are on — editing first would leave uncommitted
changes that block a clean stop on the comment / no-op paths below.

1. **No drift in any verified CLI** → do nothing: make no edits, open no PR, post no
   comment. Stop. (`unverified` alone is not drift — the docs may just be unreachable
   today.)

2. **Drift exists — first check for an already-open sync PR:**
   `gh pr list --base main --state open --search "[auto] sync agent CLI harnesses" --json number,url,headRefName`.

   - **If an open sync PR already exists, do NOT open a second PR and do NOT edit any
     files.** Read what it already covers (`gh pr diff <number>` plus its body) and
     compare against your detected drift. If that PR already covers everything you
     found, stop — nothing to add. If you found drift the PR is **missing**, post ONE
     comment listing exactly what's missing, then stop —
     `gh pr comment <number> --body "..."`, e.g.:

     > This open sync PR is missing newly-detected drift:
     > - **Cursor**: upstream added event `afterEdit` — append to `CURSOR_HOOK_EVENT_TYPES` (+ a `CURSOR_EVENT_MAP` entry).
     >
     > (hook-sync bot — please fold these into this PR rather than opening a second sync PR.)

     Never push commits to another PR's branch; only comment, and leave the working
     tree clean so this run stops cleanly.

   - **If no open sync PR exists → go to Phase 3** to apply the fixes and open one.

## Phase 3 — Apply the fixes and open one PR

Only reached when there is real drift **and** no open sync PR. Edit only what drift
requires.

### Scope 1 (event names)
- **Append** new events just before `] as const`, preserving upstream casing.
- **Delete** removed events; if the CLI has an `*EVENT_MAP`, also delete the same
  key from that map (the `Record` is exhaustive — a stale key fails `tsc`).
- For **map-bearing CLIs** (Codex, Cursor, OpenCode, Pi), do **NOT** invent
  the canonical mapping for a newly-added event — leave it out of the `*EVENT_MAP`
  so `tsc` fails intentionally, and add a reviewer-checklist item to the PR body
  (see below). For **Claude and Copilot** (no map), the build stays green.
- **Fix hardcoded test counts** when the relevant array changed:
  - If `HOOK_EVENT_TYPES` (Claude) changed: in `__tests__/hooks/manager.test.ts`,
    update the `installs hooks for all <N> event types` description AND both
    `expect(Object.keys(written.hooks)).toHaveLength(<N>)` assertions.
  - If a CLI's `*_HOOK_EVENT_TYPES` changed: in `__tests__/hooks/integrations.test.ts`,
    update the matching `expect(<cli>.eventTypes).toHaveLength(<N>)` assertion AND the
    description string.
  - Locate these by searching for the current count number.

### Scope 2 / Scope 3 (tool schema / settings-file shape)
- Apply a fix **only when it is unambiguous and needs no human judgement** — e.g.
  an invalid field to remove, a wrong timeout unit, or a renamed tool id (the PR
  #482 class). When you do, move the whole quartet together, exactly like #482:
  the writer in `src/hooks/integrations.ts` (+ a shared helper if it dedupes
  logic), the committed dogfood fixture, the unit test in
  `__tests__/hooks/integrations.test.ts`, and the e2e test in
  `__tests__/e2e/hooks/<cli>-integration.e2e.test.ts` — plus a `types.ts` comment
  if it documents the old shape.
- If the correct fix needs judgement (which canonical event/tool a new item maps
  to; an ambiguous schema change), **leave the code untouched** and record it as a
  reviewer-checklist item instead. Bias toward reporting over auto-editing core
  integration code.
- Do **NOT** add `*EVENT_MAP`, `*_TOOL_MAP`, or `*_TOOL_INPUT_MAP` entries for
  newly-added items — the canonical mapping is a human decision.

### CHANGELOG (required)
Add a single-line entry to `CHANGELOG.md` under `## <version> — <YYYY-MM-DD>` where
`<version>` is the `version` field in `package.json` (read it) and `<YYYY-MM-DD>` is
today's UTC date. If that heading does not exist yet, create it above the previous
version's section. There is no `## Unreleased` section. Use the `### Features` (or
`### Fixes` for a shape correction) subsection.

### Commit, push, open the PR
1. Stage only the files you intentionally edited (never `git add -A`):
   `src/hooks/types.ts`, `src/hooks/integrations.ts`, `src/hooks/policy-evaluator.ts`,
   the touched `__tests__/...` files, the touched dogfood fixtures, and
   `CHANGELOG.md` — whichever actually changed.
2. Commit (e.g. `feat: sync agent CLI harnesses with upstream docs`), then
   `git push -u origin "$(git branch --show-current)"`.
3. `gh pr create --base main --title "[auto] sync agent CLI harnesses with upstream docs" --body "<body>"`.

The PR **body** must contain, in order:

1. **Summary table** — one row per CLI: `| CLI | scope-1 | scope-2 | scope-3 | status |`
   where status is `up to date`, `drift`, or `unverified`.
2. **Per-CLI sections** — for each CLI with drift, list the added/removed events,
   tool/schema changes, and settings-shape changes.
3. **Reviewer checklist** — one unchecked box per item that needs a human decision:
   - For each newly-added event on a map-bearing CLI:
     `- [ ] Add \`<event>: "???"\` to \`<MAP_NAME>\` in \`src/hooks/types.ts\` (canonical Claude \`HookEventType\` chosen by reviewer)`
   - For each scope-2/scope-3 change you deferred as judgement-heavy.
4. **Sources** — the docs URL(s) consulted per CLI.
5. **Unverified notes** — one line per `unverified` CLI explaining why.
6. **Final note (verbatim):**
   > **CI is expected to fail on this PR if a map-bearing CLI gained new events — a
   > reviewer must add the missing `*EVENT_MAP` entries (replacing `"???"`) before
   > merging. For drift in Claude or Copilot only (no event map), CI should pass on
   > this commit alone. CI must pass and this PR must be reviewed before merging.**

## Constraints

- **Only edit** these paths, and only where drift requires it: `src/hooks/types.ts`,
  `src/hooks/integrations.ts`, `src/hooks/policy-evaluator.ts`,
  `__tests__/hooks/manager.test.ts`, `__tests__/hooks/integrations.test.ts`,
  `__tests__/e2e/hooks/<cli>-integration.e2e.test.ts`, the seven dogfood fixtures
  (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`,
  `.github/hooks/failproofai.json`, `.opencode/opencode.json`,
  `.opencode/plugins/failproofai.mjs`, `.pi/settings.json`),
  and `CHANGELOG.md`.
- Do **NOT** edit `.failproofai/policies-config.json` (the entrypoint manages it),
  `src/hooks/handler.ts`, `src/hooks/manager.ts`, or any other source file.
- Do **NOT** add entries to any `*EVENT_MAP`, `*_TOOL_MAP`, or `*_TOOL_INPUT_MAP`
  for newly-added items. Removing a key when its array entry is removed IS allowed
  (and required to keep the build green).
- Do **NOT** invent events, tools, or fields. If WebFetch fails or the docs don't
  expose a clean list, mark the CLI `unverified` and move on.
