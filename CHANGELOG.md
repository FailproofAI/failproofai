# Changelog

## Unreleased

### Fixes
- Activity dashboard: populate the `Transcript:` field across every harness, not just Claude. Only Claude's hook stdin reliably carries `transcript_path`; Codex/Copilot/Cursor don't include one, the OpenCode and Pi shims don't forward one, and Gemini's coverage is uneven across versions, so before this fix the `/policies` activity detail panel rendered `Transcript: —` for nearly every non-Claude row even though every harness *except* OpenCode has the transcript on disk and the repo already shipped per-CLI `find*Transcript(sessionId)` helpers (`lib/codex-sessions.ts`, `lib/copilot-sessions.ts`, `lib/cursor-sessions.ts`, `lib/pi-sessions.ts`, `lib/gemini-sessions.ts`). New `src/hooks/resolve-transcript-path.ts` mirrors the existing `resolve-permission-mode.ts` dispatch pattern: trust `parsed.transcript_path` from stdin first, then fall back to the per-CLI helper when sessionId is known. OpenCode (transcripts in `~/.local/share/opencode/opencode.db`, no on-disk file) gets a synthetic `opencode-db://<sessionId>` marker so the field is non-empty, distinguishable from a genuine miss, and parseable by tooling — both detail panels (`app/components/session-hooks-panel.tsx`, `app/policies/hooks-client.tsx`) render an extra muted "(stored in opencode DB)" suffix when the value carries that scheme. The handler-side fallback covers OpenCode and Pi without touching their shims (no duplicated disk-walk; the Pi shim already discovers session IDs from disk for related reasons in `pi-extension/index.ts:discoverPiSessionId`). New `__tests__/hooks/resolve-transcript-path.test.ts` is a 23-case matrix: stdin-passthrough for all 7 CLIs, missing-sessionId returns undefined for all 7, per-CLI fallback dispatch, and stdin-precedence-beats-fallback (#296).
- Canonicalize tool names across all agent CLIs so builtin Bash/Read/Write/Edit policies fire under Copilot, OpenCode, and Pi (verified for Codex/Cursor/Gemini). Builtin policies match tool names in PascalCase (`["Bash"]`, `["Read","Glob","Grep","Bash"]`, …) via case-sensitive `Array.includes`, but Copilot's tool registry emits lowercase IDs (`bash`, `read`, …) and OpenCode's plugin SDK exposes the same. Without canonicalization every Bash/Read/Write/Edit builtin silently no-ops under those CLIs. Adds `COPILOT_TOOL_MAP` (handler-side) and `OPENCODE_TOOL_MAP` / `PI_TOOL_MAP` (shim-side, embedded inline in the self-contained plugin shims). User-reported regression: under Copilot CLI, `ls -la --almost-all $HOME | sed -n '1,200p'` ran successfully despite an enabled `block-read-outside-cwd` policy. Also fixes the Pi shim's naive `charAt(0).toUpperCase()` heuristic which only worked for single-word tool IDs (`bash` → `Bash`) but would have mis-canonicalized future multi-word tools (`todo_write` → `Todo_write`, not `TodoWrite`). E2e fixture for Copilot now uses the real lowercase shape so the suite catches future regressions in this layer (#293).
- Session log viewer: stop rendering log entries at the wrong y-offset (which exposed the page background and looked like the page "going blue" while scrolling). `app/components/raw-log-viewer.tsx` was capturing the virtualizer's `scrollMargin` once via a callback ref on the list wrapper's `offsetTop`. That ref fires only on mount, so any layout shift above the list — most commonly the async `searchHookActivityAction` resolving and mounting the `<SessionHooksPanel>` panel above the Logs section, but also Subagents-section / per-subagent collapse-expand, and window resizes that re-flow the StatsBar / ToolStatsGrid — left `scrollMargin` stale. The `useWindowVirtualizer` then computed the wrong visible window in list-local coordinates and positioned each item at `transform: translateY(virtualRow.start - staleScrollMargin)`, so items appeared shifted by the layout-delta (typically tens to hundreds of pixels). Replace the callback ref with a stable `useRef<HTMLDivElement>` and a `useLayoutEffect` that reads `getBoundingClientRect().top + window.scrollY` (more robust than `offsetTop` against future positioned ancestors) and re-reads it from a `ResizeObserver` watching `document.body` plus a `window` resize listener. Functional `setScrollMargin(prev => prev === top ? prev : top)` short-circuits same-value updates so the body-resize that the state-update itself causes can't loop. (#292)
- Detect when `failproofai` on the user's PATH is shadowed by a different, older install (classic cause: a leftover `bun link` from a prior dev session, or a previously-installed `bun install -g failproofai` whose `~/.bun/bin` prefix sorts ahead of npm's). New `scripts/install-diagnosis.mjs` helper resolves the PATH-first install via `command -v` (POSIX) / `where` (Win32), compares its package root + version against the running install, and surfaces a copy-pasteable cleanup command (`rm -f ~/.bun/bin/failproofai && rm -rf ~/.bun/install/global/node_modules/failproofai` for bun-side shadows, `npm rm -g failproofai` for npm-side ones). Wired into two places: (1) `scripts/postinstall.mjs` warns at install time when the just-installed copy is being shadowed, before the customer ever sees the runtime error, (2) `scripts/launch.ts` rewrites the existing "Cannot find server.js at" error to point at the actual stale install (with both versions and the cleanup command) when the missing build output is caused by a PATH shadow rather than a genuinely broken build. Replaces the previous misleading recommendation (`npm install -g failproofai@latest`) which doesn't help when the new install is itself being shadowed (#286).

## 0.0.10-beta.0 — 2026-05-04

### Features
- Add Gemini CLI integration (beta) across hooks, activity dashboard, session viewer, and `/projects` listing. `--cli gemini` writes Claude-shape hook entries into `~/.gemini/settings.json` (user) or `<cwd>/.gemini/settings.json` (project) using Gemini's `{matcher, hooks: [{type, command, timeout}]}` matcher-wrapper schema. Subscribes to all 11 documented events (SessionStart, SessionEnd, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification); BeforeModel / AfterModel / BeforeToolSelection lack a Claude canonical equivalent so no policies match on them today, but the binary still records activity for those events so future policies can opt in. The handler canonicalizes Gemini's snake_case tool names (`run_shell_command`, `read_file`, `read_many_files`, `write_file`, `replace`, `glob`, `grep_search`, `list_directory`, `web_fetch`, `google_web_search`, `write_todos`, `save_memory`, `ask_user`) to Claude PascalCase (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `TodoWrite`, `Memory`, `AskUser`) via `GEMINI_TOOL_MAP` so existing builtin policies (block-sudo, block-rm-rf, sanitize-api-keys, …) fire unchanged on Gemini sessions. MCP tool names (`mcp_<server>_<tool>` pattern) and Skills tool names pass through unchanged. The policy evaluator emits Gemini's flat `{decision: "deny", reason}` deny shape (preferred per Gemini's "Golden Rule" exit-0 contract), `{hookSpecificOutput: {hookEventName, additionalContext}}` for context injection on BeforeAgent / AfterTool / SessionStart, and `{decision: "block", reason}` on AfterAgent for force-retry semantics matching Claude's exit-2-from-Stop "do this before stopping" pattern. Path-protection (`isAgentInternalPath` + `isAgentSettingsFile`) covers `~/.gemini/` and `.gemini/settings.json`. Frontend: `lib/cli-registry.ts` adds a `Gemini CLI` entry with a sky-blue badge; `lib/projects.ts` merges Gemini projects into `/projects`; `app/project/[name]` and `/session/[id]` extend the external-CLI fallback chain. Also ships this repo's own `.gemini/settings.json` so contributors using `gemini` get hooks active automatically — uses `$GEMINI_PROJECT_DIR` for resolver stability (Gemini also sets `$CLAUDE_PROJECT_DIR` as a back-compat alias). Verified against gemini-cli v0.40.1 (#277).
- Add OpenCode (sst/opencode) integration (beta) across hooks, activity dashboard, session viewer, and `/projects` listing. `--cli opencode` writes a generated plugin shim at `.opencode/plugins/failproofai.mjs` plus a registration entry in `opencode.json`'s `plugin: []` array; SQLite-backed dashboard adapters read OpenCode's session store via `opencode db --format json`. Verified against opencode v1.14.33 (#270).
- Add Pi (`@mariozechner/pi-coding-agent`) integration (beta) across hooks, activity dashboard, session viewer, and `/projects` listing. `--cli pi` writes a `packages` entry into `.pi/settings.json` pointing at failproofai's bundled `pi-extension/`. Subscribes to all 7 Pi events (`tool_call`/`user_bash`/`input`/`session_start`/`tool_result`/`agent_end`/`session_shutdown`); the latter three are observation-only on Pi (no veto capability) but still activate the 5 PostToolUse and 5 `require-*-before-stop` builtins for visibility. Verified against pi-coding-agent v0.72.1 (#270).
- Add GitHub Copilot CLI integration (beta) across hooks, activity dashboard, session fallback, and `/projects` listing. Also ships this repo's own `.github/hooks/failproofai.json` so contributors developing failproofai with the GitHub Copilot CLI get hooks active automatically, mirroring the existing `.claude/settings.json` and `.codex/hooks.json` (#236)
- Add Cursor Agent CLI integration (beta) across hooks, activity dashboard, session viewer, and `/projects` listing. New `--cli cursor` flag installs into `~/.cursor/hooks.json` (user) or `<cwd>/.cursor/hooks.json` (project) using Cursor's flat-array schema with camelCase event keys (`preToolUse`, `beforeSubmitPrompt`, …); the handler canonicalizes to PascalCase via `CURSOR_EVENT_MAP` so existing builtin policies fire unchanged. The policy evaluator emits Cursor's `{permission, user_message, agent_message, additional_context, followup_message}` stdout shape. Path-protection (`isAgentInternalPath` + `isAgentSettingsFile`) covers `~/.cursor/` and `.cursor/hooks.json`. Frontend: `lib/cli-registry.ts` adds a `Cursor Agent` entry with an emerald badge; `lib/projects.ts` merges Cursor projects into `/projects`; `app/project/[name]` and `/session/[id]` extend the external-CLI fallback chain. Also ships this repo's own `.cursor/hooks.json` so contributors using Cursor get hooks active automatically (#245).
- Project page (`/project/[name]`): list Copilot and Cursor sessions alongside Claude + Codex, mirroring the existing merge logic on the projects index. Previously the project detail view only enumerated Claude + Codex transcripts (#245).

### Fixes
- Project-local: add `.failproofai/policies/block-version-bumps.mjs` so feature PRs can't bump `package.json`'s `version` field — only release-cut branches (`luv-cut-X.Y.Z`) may. Prevents the drift root-caused in PR #270 where two parallel feature branches each speculatively bumped, stacking 0.0.10-beta.1 → 0.0.10-beta.2 → 0.0.11-beta.1 → 0.0.12-beta.1 → 0.0.13-beta.1, and the over-correction in PR #284 that landed package.json at 0.0.9-beta.3 (older than the published 0.0.9). Blocks `Edit`/`Write` to `package.json` that touches the version field, plus Bash `npm|yarn|pnpm|bun (pm) version` and `sed|awk|jq` mutations of `package.json` mentioning `version` (#285).
- Pi integration: surface `sessionId` on activity records by discovering it from Pi's on-disk transcript filename. Pi (verified empirically against pi-coding-agent v0.71.1) does NOT populate `event.sessionId` on any of its events — `session_start`, `tool_call`, `user_bash`, `input`, `tool_result`, `agent_end`, `session_shutdown` all leave it undefined. The shim now scans `~/.pi/agent/sessions/--<encodedCwd>--/` for the most-recent `<isoTimestamp>_<uuid>.jsonl` file (filtering to files whose mtime ≥ process start so a stale transcript from a prior session in the same cwd can't pin a wrong UUID at cold start) and extracts the sessionId from the filename, then caches it per cwd for subsequent events in the same Pi process and clears the entry on `session_shutdown` reasons `new`/`resume`/`fork` so cross-session misattribution can't happen. With this fix, `PreToolUse` / `PostToolUse` / `Stop` / `SessionEnd` records now carry the sessionId so dashboard rows can deep-link to the session viewer. `SessionStart` and `UserPromptSubmit` remain unsessioned because Pi flushes the transcript file lazily, after those events fire — that's a Pi behavior we can't change client-side. Pi's encoding strips the leading `/` before replacing remaining slashes with `-`, so `/home/u/repo` → `--home-u-repo--` (NOT `---home-u-repo--`). New unit test (`__tests__/hooks/pi-extension-shim.test.ts`) covers happy path, multi-file mtime tie-breaker, missing-cwd fallback, resolution from every event type, and the per-cwd cache reset on session_shutdown (#284).
- Cursor integration: surface sessions stored under cursor-agent's current on-disk layout. As of cursor-agent 2026-04+, transcripts live at `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl` (with the JSONL records using the OpenAI-shape `{role, message: {content: [{type, text}]}}` rather than the legacy `{type, data, timestamp}` form). `lib/cursor-projects.ts` and `lib/cursor-sessions.ts` previously only probed the legacy `~/.cursor/{agent-sessions,conversations,sessions}/` paths so every recent Cursor session 404'd from the dashboard. Both modules now scan the new layout first (and decode the cwd from the encoded project-dir name, prepending `/` since Cursor's encoding drops the leading slash), then fall back to the legacy candidates for older installs. The transcript parser learned a branch for the new shape — strips the synthesized `<timestamp>…</timestamp><user_query>…</user_query>` wrapper Cursor adds to user messages, preserves assistant text blocks, and synthesizes per-record sort timestamps since the new format omits them. Verified live on cursor-agent v2026.04.29 against a real session that the dashboard had been falsely tagging as "Claude Code" with "Session log file not found". `lib/gemini-projects.ts` now uses `encodeFolderName(cwd)` for `ProjectFolder.name` so cross-CLI merge in `mergeProjectFolders` unions on the same key and Gemini-only project links resolve through `getGeminiSessionsByEncodedName`. `policy-evaluator.ts` preserves the raw CLI `--hook` arg via a new `SessionMetadata.rawHookEventName` field captured in `handler.ts` before canonicalization, so Gemini's `hookSpecificOutput.hookEventName` round-trips correctly even when stdin omits `hook_event_name`; deny-message construction now branches on event type so non-tool events (UserPromptSubmit / SessionStart / SessionEnd / Stop) emit "Blocked prompt|session start|…" instead of the misleading "Blocked unknown tool". `lib/gemini-sessions.ts` loosens `SESSION_FILE_RE` to accept any timestamp shape (Gemini docs include seconds; the load-bearing safety check is the first-line `sessionId` validation) and replaces the whole-file `readFileSync` in `findGeminiTranscript` with a bounded 4 KB `readFirstLineSync` helper so large transcripts no longer blow memory just to inspect the metadata header. `__tests__/lib/projects.test.ts` adds three Gemini aggregation tests (Gemini-only inclusion, cross-CLI merge by encoded slug, reject-fallback) mirroring the existing Pi / Cursor / OpenCode patterns (#277).
- `block-read-outside-cwd`: deny message now says "Reading agent settings file blocked" instead of "Reading Claude settings file blocked" — the policy has covered all 6 CLIs' settings files since #270 / #245 / #220 but the deny string was stale (#270).
- `require-ci-green-before-stop`: stop reporting historical CI failures as still-failing after a fix commit lands. The policy now filters `gh run list` results to runs whose `headSha` matches the current local HEAD, and deduplicates by workflow name so GitHub's "Re-run all jobs" doesn't resurface old failed run records. Also bumps the gh-run-list `--limit` from 5 to 20 to avoid truncating the latest run on busy branches with many workflows or recent pushes. Third-party checks (CodeRabbit, SonarCloud, …) and commit statuses already query by SHA and are unchanged. Resolves a wedge where a green PR could not satisfy the Stop policy because an earlier failed run on the same branch was still in the top-5 window. (#266)
- `failproofai policies --uninstall` interactive CLI selector now says "Remove Hooks" / "Choose where to remove from:" instead of "Install Hooks" / "Choose where to install:" (#236)
- README: replace the GitHub Copilot logo with the current canonical mark and add a dark-mode variant (`copilot-light.svg` + `copilot-dark.svg` via `<picture>`); the previous SVG used outdated path data with a hard-coded black fill that rendered invisibly on GitHub's dark theme (#236)
- README: replace the broken Cursor Agent logo (`cursor-light.svg` + `cursor-dark.svg`) with the official 2.5D cube mark from Cursor's brand kit. The previous path was malformed (extended past the 24×24 viewBox to x=24.5 and traced an unrecognizable arrow shape); the first replacement attempt used a flat hexagonal outline from simple-icons that rendered as a single-color silhouette without the characteristic shaded faces and inset cursor (#257)
- Auto-translated MDX: stop the recurring `mintlify validate` parse error in `docs/de/dashboard.mdx` (`<Tab title="Tab „Richtlinien"">`) by adding a `sanitizeJsxAttributes` post-processor to the translation pipeline that strips stray ASCII `"` left after typographic-quote pairs (and any unmatched opening typographic quote) in JSX attribute values, and by tightening the translator system prompt to forbid ASCII `"` inside attribute values. Same regression PR #229 fixed by hand — now it can't recur. Includes the immediate file fix on `docs/de/dashboard.mdx`. (#247)

### Docs
- README: drop the "+ more coming soon" line under the supported-CLIs logo strip; the row of seven logos is the visual itself, the trailing tagline reads as filler (#281).
- README: add Gemini CLI to the supported-CLIs intro line and visual list, with light/dark logo variants (`assets/logos/gemini-light.svg` + `gemini-dark.svg`). Restructure the logo block into two centred `<p>` rows (Claude/Codex/Copilot/Cursor on the first, OpenCode/Pi/Gemini on the second) plus a separate "+ more coming soon" line so the seventh logo doesn't crowd the layout. Update the beta callout to include Gemini CLI alongside Copilot, Cursor, OpenCode, and Pi (#277).
- README: add Pi to the supported-CLIs intro line and visual list, with light/dark logo variants (`assets/logos/pi-light.svg` + `pi-dark.svg`); update beta callout to include Pi alongside Copilot and Cursor (#264).
- README: add Cursor Agent to the supported-CLIs intro line and visual list, with light/dark logo variants (`assets/logos/cursor-light.svg` + `cursor-dark.svg`). Note that GitHub Copilot CLI testing is ongoing in the beta callout (#245).

## 0.0.9 — 2026-04-28

### Features
- Surface the Slack community invite alongside the existing GitHub and docs links: add a `💬 Slack` line to the CLI `--help` banner (`bin/failproofai.mjs`) and the `dev` / `start` launch banner (`scripts/launch.ts`), plus a `Join our Slack` entry in the in-app `Reach Us` dropdown (`components/reach-developers.tsx`). Uses the existing `https://join.slack.com/t/failproofai/...` invite already linked from the README and docs sidebar (#225).
- Activity dashboard now has a CLI filter alongside event-type, policy, and session-id filters; URL is preserved as `?cli=claude|codex`. Codex sessions in the activity feed are also clickable: the session route now falls back to `~/.codex/sessions/<…>.jsonl` when the Claude lookup misses, and the existing log viewer renders Codex transcripts (user prompts, assistant messages, exec_command tool calls with stdout/stderr and durations) by mapping every record type. Transcript discovery (`findCodexTranscript`) lives in a shared `lib/codex-sessions.ts` module reused by the hook hot path (#226).
- Add OpenAI Codex hook integration. Install hooks for Codex via `failproofai policies --install --cli codex` (or `--cli claude codex` for both). Supports all six documented Codex hook events (`SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop`) and writes to `~/.codex/hooks.json` (user) / `<cwd>/.codex/hooks.json` (project). Codex's `PermissionRequest` is wired through `policy-evaluator.ts` to emit the `hookSpecificOutput.decision.behavior` shape per Codex docs; `block-sudo` now also fires for `PermissionRequest` events. Stdin event names arrive snake_case (`pre_tool_use`) and are canonicalized to PascalCase before policy lookup. Permission-mode tracking for Codex reads `approval_policy` from the active session transcript (`~/.codex/sessions/<…>.jsonl`). New `--cli` flag is interactive by default — detects installed agent CLIs and prompts when both are present. Telemetry now tags every hook decision with the originating CLI; activity dashboard rows show a per-CLI badge. `isAgentInternalPath` / `isAgentSettingsFile` generalized to also cover `~/.codex/` and `.codex/hooks.json` so existing path-protection rules apply to Codex out of the box (#220).
- Show OpenAI Codex projects on the `/projects` page alongside Claude Code projects. Codex stores transcripts under `~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl` keyed by date, so we scan each transcript's `session_meta` record for its `cwd` and surface one row per unique cwd. A CLI badge ("Claude Code" / "OpenAI Codex") appears beside each agent root; cwds that exist in both stores render as a single row with both badges. The `/project/[name]` detail page now lists Codex sessions for the project (recovering the canonical cwd from the transcript, since `decodeFolderName` is lossy when paths contain `-`) and tags each session row with its originating CLI; session click-through reuses the existing Codex-aware viewer, which now also renders the CLI badge beside the Session Log header (#232).

### Fixes
- Add a trailing blank line after the `Enabled N policy(ies): …` summary printed by `failproofai policies --install`. With 39+ enabled policies the line wraps to several rows of comma-separated names and previously ran straight into the `Failproof AI hooks installed for …` confirmations, making the install output hard to scan (#224).
- Replace the `[B]oth / [C]laude / [D]codex` text prompt that fires when both agent CLIs are detected during `failproofai policies --install` with an interactive arrow-key single-select. Visual style mirrors the existing policy selector (cursor pointer, dim/bold rows, footer hint line); options are `Both`, `Claude Code only`, `OpenAI Codex only`. Non-TTY behaviour is unchanged (defaults to all detected CLIs) (#223).
- Switch this repo's own `.claude/settings.json` hook commands from a relative `bun ./bin/failproofai.mjs --hook ...` to `bun $CLAUDE_PROJECT_DIR/bin/failproofai.mjs --hook ...`. Claude Code spawns hooks with the live session CWD, which drifts whenever the agent `cd`s into a subdirectory, so the relative form failed with `Module not found "./bin/failproofai.mjs"` after any `cd subdir && …` Bash call. Mirrors the stable-root pattern already used by `block-read-outside-cwd` (`src/hooks/builtin-policies.ts`).
- Fix `mintlify validate` failing on `docs/ar/built-in-policies.mdx` by re-wrapping `origin/<baseBranch>` in backticks. The Arabic translation dropped the surrounding inline-code markers in one paragraph, so MDX parsed `<baseBranch>` as an unclosed JSX tag and the docs CI job errored out.
- Fix `mintlify validate` parse error in `docs/de/dashboard.mdx` caused by inner quotes inside `<Tab title="…">` attributes (#229).
- Fix `block-read-outside-cwd` falsely denying Bash commands with unquoted glob patterns or `-v host:/path` argv tokens (#230).
- Move `formatDate` into `lib/format-date.ts` so the hook handler no longer pulls `clsx`/`tailwind-merge` via `lib/utils.ts` (#231).

### Docs
- Bump built-in policy count from 32 to 39 in `README.md` and the 14 translated `docs/i18n/README.*.md` files to reflect the seven Infra Commands policies added in #202. The reference doc (`docs/built-in-policies.mdx` and its localized counterparts) was already correct (#207).

## 0.0.8 — 2026-04-27

### Fixes
- Fix `require-pr-before-stop` falsely denying after a squash-merge or rebase-merge: GitHub creates a new commit on the base branch with rewritten parentage, so the original branch commit is never an ancestor of `main` and the post-merge `git log` / `git diff` reconciliation never converges. The policy now short-circuits to `allow` when `gh pr view --json state` returns `MERGED`, mirroring the fix shape from #196 for `require-no-conflicts-before-stop`. Also surfaces whenever `main` is auto-modified after merge — e.g. release workflows that auto-bump versions (#204).

## 0.0.7 — 2026-04-27

### Features
- Add `Infra Commands` category with seven opt-in policies: `block-kubectl`, `block-terraform`, `block-aws-cli`, `block-gcloud`, `block-az-cli`, `block-helm`, and `block-gh-pipeline`. Each denies invocations of its CLI by default and supports an `allowPatterns` param so users can carve out read-only subcommands (e.g. `kubectl get *`, `terraform plan`, `aws s3 ls *`). `block-gh-pipeline` only matches mutating subcommands (`workflow run`, `pr merge`, `release create`, etc.) so read-only `gh` calls used by other policies continue to work (#202).

### Fixes
- Skip `require-no-conflicts-before-stop` entirely when no OPEN PR exists for the current branch (or when `gh` CLI is unavailable to check). The policy no longer runs Layer 1's local `git merge-tree` probe in those cases — without a confirmable merge target there is nothing to enforce (#198).
- Resolve project policy config (`.failproofai/`) by walking up from the live CWD to find the nearest project root, instead of looking only at the exact session cwd. Stop-gating policies (`require-pr-before-stop`, `block-read-outside-cwd`, etc.) no longer silently disable when Claude `cd`s into a subdirectory. Also covers `customPoliciesPath` and project convention discovery in `custom-hooks-loader.ts` (#200).

## 0.0.6 — 2026-04-27

### Features
- Add cloud platform client: `login`, `logout`, `whoami`, `relay start|stop|status`, and `sync` subcommands. Hook events are appended to a local queue and streamed to the failproofai cloud server via a background relay daemon that lazy-starts from the hook handler and survives reboots (#132)
- Add `require-no-conflicts-before-stop` builtin workflow policy that denies Stop until the current branch merges cleanly with the base branch. Runs a local `git merge-tree` probe (names the conflicted files) and an optional `gh pr view --json mergeable` probe that catches conflicts a stale local `origin/<base>` would miss (#176)
- Add policy namespace support. Built-in policies now live under the `exospherehost/` namespace; flat names in user configs (e.g. `"sanitize-jwt"`) auto-resolve to the default namespace, so existing configs keep working unchanged. Custom and third-party policies can declare their own namespace (e.g. `myorg/foo`) without colliding with builtins (#196)

### Docs
- Add demo GIF to README (#178)
- Document the policy namespace concept and update built-in policy count from 30 to 32 (#196)

### Fixes
- Fix `require-no-conflicts-before-stop` falsely denying when the PR is already merged or closed: GitHub returns `mergeable=UNKNOWN` for non-OPEN PRs, which the policy was treating as "still computing → wait and retry". The policy now requests `state` and short-circuits to allow when the PR is not OPEN (#196)
- Stop stderr leakage from workflow policies (`require-push-before-stop`, `require-pr-before-stop`, `require-ci-green-before-stop`, etc.): git probes that are expected to sometimes fail no longer leak "fatal: Needed a single revision" or similar messages to the user's terminal (#132)
- `block-read-outside-cwd` now uses `CLAUDE_PROJECT_DIR` (the stable project root) instead of the live hook `cwd`, which drifts when Claude `cd`s into a subdirectory. Reads at the project root are no longer wrongly denied after a `cd`. Falls back to `ctx.session.cwd` when that variable is unset (#134)
- Shrink the npm package by excluding sharp from the Next.js standalone build (unused — image optimization is disabled) and stripping docs, tests, and sourcemaps from the bundled `node_modules`. Tarball drops from ~20 MB to under a few MB (#136)

## 0.0.6-beta.2 — 2026-04-21

### Features
- Add `prefer-package-manager` builtin policy to enforce allowed package managers (e.g., uv instead of pip) (#126)

### Fixes
- Treat cancelled CI runs as non-failing in `require-ci-green-before-stop` policy (#129)

### Docs
- Emphasize convention-based policies as org-wide quality standards in getting-started, custom-policies, examples, and README (#126)

## 0.0.6-beta.1 — 2026-04-20

### Features
- Add `prefer-package-manager` builtin policy to enforce allowed package managers (e.g., uv instead of pip) (#126)

### Docs
- Emphasize convention-based policies as org-wide quality standards in getting-started, custom-policies, examples, and README (#126)

## 0.0.6-beta.0 — 2026-04-20

### Fixes
- Fix `require-pr-before-stop` falsely denying when PR is already merged and `origin/main` is stale (#112)

## 0.0.5 — 2026-04-17

### Fixes
- Strengthen Stop-event deny/instruct instructions with mandatory framing so agents execute required actions instead of asking for confirmation (#109)
- Include legacy commit statuses (CodeRabbit, etc.) in CI green check — previously only Check Runs API was queried (#109)

### Docs
- Remove beta version annotations from convention-based policies and allow(message) documentation (#110)

## 0.0.4 — 2026-04-16

### Features
- Graduate 4 workflow policies from beta to stable: `require-commit-before-stop`, `require-push-before-stop`, `require-pr-before-stop`, `require-ci-green-before-stop` (#105)

## 0.0.3 — 2026-04-15

### Features
- Use portable `npx -y failproofai` command for project-scope hooks, making `.claude/settings.json` committable to git (#96)
- Parallelize translation workflow across 14 languages with concurrent file translation for faster CI (#98)
- Add manual workflow dispatch for translations with `force` (ignore cache) and `languages` filter inputs (#98)
- Tier-based model selection for translations: Sonnet for Tier 1, Haiku for Tier 2/3; add prompt caching on system prompt (#98)

### Fixes
- Fix hooks not working in failproofai's own repo by using local binary instead of npx (#98)
- Fix translation workflow placing files at repo root instead of `docs/` by setting download artifact path (#100)

## 0.0.2-beta.8 — 2026-04-14

### Features
- Add `changelog-check`, `docs-check`, and `pr-description-check` convention policies
- Track `.claude/settings.json` in git
- Add multilingual documentation with 14 languages and automated translation tooling (#93)
- Add GitHub Actions workflow to auto-translate docs when English sources change (#95)
- Add Mintlify docs validation to CI (#95)

### Fixes
- Accumulate all `instruct` messages instead of only delivering the first one
- Rename convention policy prefix from `convention/` to `.failproofai-{scope}/` (e.g. `.failproofai-project/`, `.failproofai-user/`) and add `convention_scope` to telemetry

### Docs
- Document cross-cutting `hint` param in built-in policies reference and add `block-force-push` hint example
- Add `block-force-push` hint to project config suggesting fresh branch as alternative

## 0.0.2-beta.7 — 2026-04-14

### Features
- Check third-party bot statuses (CodeRabbit, SonarCloud, etc.) in `require-ci-green-before-stop` policy (#90)
- Convention-based policy auto-discovery: drop `*policies.{js,mjs,ts}` files into `.failproofai/policies/` at project or user level for automatic loading — no config changes needed (#91)
- Configurable `hint` field in `policyParams` — append custom guidance to deny/instruct messages without modifying policies (#91)
- Auto-bump version after release (#73)

### Fixes
- Write `policies-config.json` to scope-appropriate path (#57)
- Fix custom hooks loader cwd, ESM shim exports, and merged LLM config (#76)

### Docs
- Replace Discord links with Slack community invite (#87)

### Dependencies
- Bump `@types/node` 25.5.2 → 25.6.0 (#86)
- Bump `react-dom` 19.2.4 → 19.2.5 (#85)
- Bump `next` 16.2.2 → 16.2.3 (#84)
- Bump `posthog-node` 5.28.11 → 5.29.2 (#83)
- Bump `lucide-react` 1.7.0 → 1.8.0 (#82)
- Bump `eslint-config-next` 16.2.2 → 16.2.3 (#81)
- Bump `vitest` 4.1.2 → 4.1.4 (#80)
- Bump `react` 19.2.4 → 19.2.5 (#79)
- Bump `actions/checkout` 4 → 6 (#78)

## 0.0.2-beta.6 — 2026-04-09

### Fixes
- `require-push-before-stop` skips when no changes vs base branch (#71)

## 0.0.2-beta.5 — 2026-04-09

### Features
- Display package version in navbar (#66)

### Fixes
- `require-pr-before-stop` skips when no changes vs base branch (#67)
- Show plain Allow badge instead of blue Allow(note) (#68)

## 0.0.2-beta.4 — 2026-04-09

### Features
- Surface allow-with-message in terminal and dashboard (#65)

### Fixes
- Policy bypass gaps in `block-rm-rf`, `block-curl-pipe-sh`, `protect-env-vars` + Stop hook stderr bug (#64)

## 0.0.2-beta.3 — 2026-04-09

### Features
- 4 beta workflow policies + allow-with-message support (#63)

### Fixes
- Disable PostHog telemetry in all CI jobs and test configs (#62)
- README badge fixes — stable npm version, remove broken Discord (#53)

### Docs
- Rewrite README to focus on hooks management (#54)
- Rewrite docs for Mintlify, fix CLI parity, add agent skill page (#55)
- Rename custom-hooks to custom-policies, update Dockerfile for hot reload (#61)

## 0.0.2-beta.2 — 2026-04-08

### Features
- Add Mintlify documentation configuration (#43)

### Fixes
- Bundle CLI for Node.js compatibility, support `npm install -g` (#46)
- Correct CLI commands in README (#45)
- Clean CLI error handling, reject unknown args (#48)

## 0.0.1 — 2026-04-06

Initial open-source release of **Failproof AI** — formerly Claudeye.

Features included in this release:
- **Hooks & Policies**: 35+ built-in security policies for Claude Code hooks (PreToolUse, PostToolUse, etc.), custom policy support, activity logging
- **Projects**: Browse and search Claude Code projects and sessions
- **Session Viewer**: Inspect session logs, tool calls, and per-session hook activity
