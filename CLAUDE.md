# CLAUDE.md — Agent guidance for this repo

## Environment

- **Runtime:** bun (≥1.3.0) and Node.js (≥20.9.0) are both present.
- **Docker CLI** is available. Use it to spin up clean containers that mimic real user
  installs and validate every non-trivial change end-to-end before pushing.
- **Package manager:** bun (`bun install`, `bun run <script>`). Do not use npm/yarn to
  install deps locally.

## Dev hooks (this repo only)

This repo's `.claude/settings.json` uses `bun $CLAUDE_PROJECT_DIR/bin/failproofai.mjs --hook <EventType>`
instead of the standard `npx -y failproofai` command. This is because `npx -y failproofai`
creates a self-referencing conflict when run inside the failproofai project itself.

The path **must** start with `$CLAUDE_PROJECT_DIR` (not a relative `./bin/...`). Claude
Code spawns hooks with the live session CWD, which drifts whenever the agent `cd`s into a
subdirectory — a relative path then fails with `Module not found "./bin/failproofai.mjs"`.
`$CLAUDE_PROJECT_DIR` is set once per session to the project root and never drifts.

For all other repos, the recommended approach is `npx -y failproofai`, installed via:
```bash
failproofai policies --install --scope project
```

Do **not** run `failproofai policies --install --scope project` from this repo — it will
overwrite the local binary path back to `npx -y failproofai`.

### Codex hooks (`.codex/hooks.json`)

This repo also ships a `.codex/hooks.json` for OpenAI Codex sessions, mirroring the
`.claude/settings.json` setup. Codex does **not** define an equivalent of
`$CLAUDE_PROJECT_DIR` — its stdin payload exposes `cwd` but the hook command string
runs before stdin is read. Codex hook commands are spawned with the project root as
cwd (where `codex` was launched), so we use a relative `bun bin/failproofai.mjs`
path. If Codex ever changes that behavior and the hook fails to find the binary,
switch to an absolute path.

For production users (outside this repo), the recommended Codex install is:
```bash
failproofai policies --install --cli codex --scope project
```
which writes a portable `npx -y failproofai --hook ... --cli codex` command. Same
self-reference caveat applies — do **not** install the standard `npx` form from
inside this repo.

### Copilot hooks (`.github/hooks/failproofai.json`)

This repo also ships a `.github/hooks/failproofai.json` for GitHub Copilot CLI
sessions, mirroring the `.claude/settings.json` and `.codex/hooks.json` setups.
Copilot's project-scope hook config lives under `.github/hooks/`, **not**
`.copilot/` (the latter is the user-scope path). The schema is Copilot's
"VS Code compatible" form: `version: 1`, PascalCase event names, and
`bash` + `powershell` + `timeoutSec` per entry (Copilot uses seconds, not
milliseconds, for its timeout field).

Like Codex, Copilot does not expose a `$COPILOT_PROJECT_DIR` env var, and its
hooks are spawned with the project root as cwd, so we use a relative
`bun bin/failproofai.mjs --hook ... --cli copilot` path. If Copilot ever
changes that behavior and the hook fails to find the binary, switch to an
absolute path.

For production users (outside this repo), the recommended Copilot install is:
```bash
failproofai policies --install --cli copilot --scope project
```
which writes a portable `npx -y failproofai --hook ... --cli copilot` command.
Same self-reference caveat applies — do **not** install the standard `npx`
form from inside this repo.

**Stop block semantics** (verified against Copilot CLI 1.0.41, May 2026, via
`~/.copilot/logs/process-*.log` and `~/.copilot/session-state/<id>/events.jsonl`):

| Channel                                   | Effect                                                          |
|-------------------------------------------|-----------------------------------------------------------------|
| `{decision: "block", reason}` JSON stdout (exit 0) | ✅ Forces another turn — `reason` becomes the next-turn prompt |
| Exit 2 + stderr (Claude convention)       | ❌ Logged as `[WARNING] Hook warning: ...`; agent does NOT retry |

policy-evaluator.ts has a `cli === "copilot"` Stop branch that emits the
JSON-block shape so the 5 `require-*-before-stop` builtins actually enforce
on Copilot. Without this branch, the deny would be a user-visible warning
only — the agent would stop without remediation. Same shape applies to
SubagentStop (Copilot fires `subagentStop` when a subagent finishes; we
subscribe to it for parity with `agentStop`).

Ref: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference>

### Cursor hooks (`.cursor/hooks.json`)

This repo also ships a `.cursor/hooks.json` for Cursor Agent CLI sessions,
mirroring the `.claude/settings.json`, `.codex/hooks.json`, and
`.github/hooks/failproofai.json` setups. Cursor's hook config goes at the
project root under `.cursor/hooks.json` per the
[Cursor docs](https://cursor.com/docs/hooks). The schema is Cursor's flat
form: `version: 1`, camelCase event keys (`preToolUse`, `beforeSubmitPrompt`,
…), and a flat array of `{type, command, timeout}` entries per event (no
Claude-style `{hooks: [...]}` matcher wrapper). The handler canonicalizes
camelCase → PascalCase via `CURSOR_EVENT_MAP` before policy lookup so the
existing builtin policies fire unchanged.

Like Codex and Copilot, Cursor does not expose a `$CURSOR_PROJECT_DIR` env
var to the hook command line (only as a process env var inside the hook
itself), and Cursor hooks are spawned with the project root as cwd, so we
use a relative `bun bin/failproofai.mjs --hook ... --cli cursor` path. If
Cursor ever changes that behavior and the hook fails to find the binary,
switch to an absolute path.

For production users (outside this repo), the recommended Cursor install is:
```bash
failproofai policies --install --cli cursor --scope project
```
which writes a portable `npx -y failproofai --hook ... --cli cursor` command.
Same self-reference caveat applies — do **not** install the standard `npx`
form from inside this repo.

**Stop block semantics** (verified against cursor-agent docs as of 2026-05-08
and live behavior):

| Channel                                              | Effect                                                                                          |
|------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `{followup_message: "<text>"}` JSON stdout (exit 0)  | ✅ Forces another turn — text becomes next user message; capped at `loop_limit` (default 5)     |
| `{permission: "deny", …}` JSON stdout (exit 0)       | ❌ Honored on tool events only — Stop falls through and agent stops cleanly                     |
| Exit 2 + stderr (Claude convention)                  | ❌ Surfaced as warning but does NOT trigger retry                                                |

policy-evaluator.ts has a `cli === "cursor" && eventType in {Stop, SubagentStop}`
branch ahead of the generic Cursor flat-shape deny that emits the
`{followup_message}` shape, so the 5 `require-*-before-stop` builtins
actually enforce on Cursor. Same shape applies to SubagentStop (Cursor's
`subagentStop` is a sibling of `stop`, same payload + response contract);
we subscribe to it for parity with Copilot so custom policies subscribing
to SubagentStop also enforce on Cursor subagent boundaries. The 5
`require-*-before-stop` builtins still match `Stop` only by design —
session-completion gates, not subagent-return gates.

**Cloud Agents caveat:** Cursor Cloud Agent VMs do NOT run `stop` /
`subagentStop` hooks (or `afterAgentResponse`) — confirmed via Cursor
forum: <https://forum.cursor.com/t/cursor-cloud-agents-do-not-run-afteragentresponse-or-stop-hooks/159929>.
This means failproofai cannot enforce Stop policies in Cursor Cloud Agent
runs; the fix above only covers local Cursor sessions.

Ref: <https://cursor.com/docs/hooks>

### OpenCode hooks (`.opencode/`)

This repo also ships a project-scope OpenCode (sst/opencode) plugin
registration: a generated plugin shim at `.opencode/plugins/failproofai.mjs`
and a matching entry in `.opencode/opencode.json`'s `plugin: []` array.

OpenCode's extensibility model is fundamentally different from Claude /
Codex / Copilot / Cursor: it has **no external-command hook system**.
Plugins are in-process JS/TS modules loaded by opencode at startup. The
shim subprocess-calls the failproofai binary (`bun bin/failproofai.mjs
--hook ... --cli opencode` for dev) and translates the binary's existing
Claude-shape JSON response back into plugin semantics — `throw new
Error(reason)` for deny, `client.session.prompt(...)` for instruct,
no-op for allow.

A subtle live-verified gotcha (opencode v1.14.33): plugins are **not**
auto-discovered from `.opencode/plugins/`. They must be explicitly
registered in `opencode.json`'s `plugin` array. The install command
takes care of this, but if you hand-edit either file the other must
agree.

For production users (outside this repo), the recommended OpenCode
install is:
```bash
failproofai policies --install --cli opencode --scope project
```
which writes a portable `npx -y failproofai --hook ... --cli opencode`
command into the shim. Same self-reference caveat applies — do **not**
install the standard `npx` form from inside this repo (it would overwrite
the dev `bun bin/failproofai.mjs` path).

### Pi hooks (`.pi/settings.json`)

This repo also ships a `.pi/settings.json` for Pi (`@mariozechner/pi-coding-agent`)
sessions. Pi's model differs from the other four CLIs in two important ways:

**Direct settings-file write, not subcommand-based.** Pi exposes
`pi install <source> [-l]` and `pi remove <source> [-l]` for managing
extensions, but failproofai writes `.pi/settings.json` directly — same pattern
as `.cursor/hooks.json` and `.codex/hooks.json`. This keeps install/uninstall
fast (no subprocess), works without `pi` on PATH, and stays consistent with
the other four integrations.

**Settings file paths** (verified empirically against pi-coding-agent
v0.72.1):

| Scope   | Path                                |
|---------|-------------------------------------|
| user    | `~/.pi/agent/settings.json`         |
| project | `<cwd>/.pi/settings.json`           |

Note: `~/.pi/settings.json` does NOT exist on a fresh install; user-scope
settings live one level deeper under `~/.pi/agent/`.

**Schema** is a flat string array — `{"packages": ["./relative/path", ...]}`.
Each entry is a path Pi resolves relative to the directory containing
`settings.json` (so `<cwd>/.pi/` for project scope). For dogfood we write
`"../pi-extension"` so each contributor's clone resolves to their own
on-disk `<repo>/pi-extension/`.

**The pi-extension package** ships inside the failproofai npm tarball at
`pi-extension/` (sibling of `bin/`, `dist/`, etc.). Its `index.ts` is loaded
by Pi at startup; the shim spawns `failproofai --hook <Event> --cli pi` per
Pi event and translates Pi's `{toolName, input, ...}` event payload to the
Claude-shape stdin JSON the handler expects. Pi spawns extensions with an
undefined cwd contract, so the shim resolves the failproofai binary
relatively from `import.meta.url`, NOT from `process.cwd()`.

For production users (outside this repo), the recommended Pi install is:
```bash
failproofai policies --install --cli pi --scope project
```
which writes a `.pi/settings.json` referencing failproofai's bundled
pi-extension. Same self-reference caveat applies — do **not** install the
standard `npx` form from inside this repo.

**Pi limitations vs. Claude semantics** (verified against pi-coding-agent
v0.73.1 d.ts; the `pi-extension/` shim subscribes to 8 events but Pi's API
caps what each handler can do):

| Pi event             | → Claude event   | Veto / mutate?  | Notes |
|----------------------|------------------|-----------------|-------|
| `tool_call`          | PreToolUse       | ✅ block        | Full deny support via `{block, reason}`. |
| `user_bash`          | PreToolUse       | ✅ block        | Full deny support. |
| `input`              | UserPromptSubmit | ✅ block        | Full deny support. |
| `session_start`      | SessionStart     | observation     | No return-value effect on Pi. |
| `tool_result`        | PostToolUse      | observation     | `ToolResultEventResult` exposes `{content, details, isError}` for mutation but no `block`. PostToolUse is observation/sanitize anyway, matching Claude semantics. |
| `agent_end`          | Stop             | shifted (next turn) | Pi's `AgentEndEvent` has no Result type — we cannot retry the same loop the way Claude's exit-2-from-Stop can. The shim captures any deny `reason` and stashes it keyed by sessionId for the next `before_agent_start` handler to drain. The 5 `require-*-before-stop` builtins thus enforce by gating the NEXT user turn's system prompt. Bounded by Pi process lifetime — same bound Claude has on exit-2-from-Stop. |
| `before_agent_start` | (Pi-only handoff) | systemPrompt   | Drains any pending Stop deny captured at `agent_end`, returning `{systemPrompt: <event.systemPrompt> + "\n\n" + reason}` so the LLM sees the MANDATORY ACTION directive before its next turn. Multiple extensions chain. No injection when no block is pending. |
| `session_shutdown`   | SessionEnd       | observation     | Symmetry only. Also clears any pending stop-block for the session id (every reason, not just `new`/`resume`/`fork`). |

**Instruct (`additionalContext`) on Pi `tool_call`** — Pi's
`ToolCallEventResult` shape is `{block?, reason?}` only; there's no
first-class additional-context channel back to the agent. `policy-evaluator.ts`
emits the right Pi-flat shape (`{permission: "allow", reason: "Instruction
from failproofai: ..."}`), and the shim logs it to stderr, but Pi does NOT
inject the instruction into the next LLM turn. A `context`-event injection
workaround (queue the instruction in `tool_call`, drain in the next `context`
handler by inserting a system message into `event.messages`) is feasible
but deferred until upstream Pi adds a first-class channel.

### Gemini hooks (`.gemini/settings.json`)

This repo also ships a `.gemini/settings.json` for Gemini CLI sessions, mirroring
the `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/failproofai.json`,
`.cursor/hooks.json`, and `.opencode/` setups. Gemini's hook contract is
intentionally close to Claude Code's: same `{matcher, hooks: [{type, command,
timeout}]}` matcher-wrapper schema, same PascalCase event names, same
snake_case stdin payload field names (`session_id`, `tool_name`, `tool_input`,
`hook_event_name`, `cwd`, `transcript_path`), and a subprocess execution model.

Verified empirically against gemini-cli v0.40.1 — drop a `.gemini/settings.json`
at the repo root and Gemini picks up failproofai hooks on the next session.
Settings file paths:

| Scope   | Path                              |
|---------|-----------------------------------|
| user    | `~/.gemini/settings.json`         |
| project | `<cwd>/.gemini/settings.json`     |
| system  | `/etc/gemini-cli/settings.json` (documented but not exposed by failproofai) |

Gemini exposes both `$GEMINI_PROJECT_DIR` and `$CLAUDE_PROJECT_DIR` (alias
provided for back-compat) in the hook's environment. The dogfood config in this
repo uses `$GEMINI_PROJECT_DIR` for clarity; the existing `bun
$CLAUDE_PROJECT_DIR/...` form would also work because of the alias.

For production users (outside this repo), the recommended Gemini install is:
```bash
failproofai policies --install --cli gemini --scope project
```
which writes a portable `npx -y failproofai --hook ... --cli gemini` command.
Same self-reference caveat applies — do **not** install the standard `npx`
form from inside this repo (it would overwrite the dev `bun bin/failproofai.mjs`
path, re-fetching failproofai on every hook).

**Tool-name canonicalization.** Gemini's tools are snake_case
(`run_shell_command`, `read_file`, `read_many_files`, `write_file`, `replace`,
`glob`, `grep_search`, `list_directory`, `web_fetch`, `google_web_search`,
`write_todos`, `save_memory`, `ask_user`). The handler translates to Claude
PascalCase via `GEMINI_TOOL_MAP` so existing builtin policies (matching
`toolName === "Bash"` etc.) fire unchanged. Unknown tools (MCP `mcp_*`,
extensions, Skills) pass through unchanged.

**Per-event capability matrix** (verified against gemini-cli v0.40.1 / docs as
of 2026-04-13):

| Gemini event           | Canonical                  | Veto / mutate? | Notes |
|------------------------|----------------------------|----------------|-------|
| `BeforeTool`           | `PreToolUse`               | ✅ deny        | `{decision:"deny", reason}` shape; can rewrite via `hookSpecificOutput.tool_input` (not used today). |
| `AfterTool`            | `PostToolUse`              | observation    | `additionalContext` injection supported. |
| `BeforeAgent`          | `UserPromptSubmit`         | ✅ deny        | `{decision:"deny", reason}` + `additionalContext` injection. |
| `AfterAgent`           | `Stop`                     | ✅ force-retry | `{decision:"block", reason}` mirrors Claude's exit-2-from-Stop "do this before stopping" semantics. Gemini's exit-2 is documented as per-action only ("turn continues"), so we use the JSON shape. |
| `SessionStart`         | `SessionStart`             | observation    | `additionalContext` injection supported. |
| `SessionEnd`           | `SessionEnd`               | observation    | No context-injection channel — emitted via stderr only. |
| `PreCompress`          | `PreCompact`               | observation    | Same. |
| `Notification`         | `Notification`             | observation    | Same. |
| `BeforeModel`          | (Gemini-only, no canonical) | observation   | Binary still records activity but no policies match. |
| `AfterModel`           | (Gemini-only, no canonical) | observation   | Same. |
| `BeforeToolSelection`  | (Gemini-only, no canonical) | observation   | Same. |

## Workflow rules

### One PR per branch
Each local branch maps to exactly one PR. Before opening a PR, check with
`gh pr list --head <branch>`. If one exists, push new commits to the same branch — never
open a second PR for the same branch.

### Branch must contain all commits from main
Before pushing, verify your branch is up to date with `main`:

```bash
git fetch origin
git log --oneline origin/main ^HEAD   # should print nothing
```

If it prints commits, rebase before pushing:

```bash
git rebase origin/main
```

Resolve any conflicts, then continue. Never push a branch that is missing commits from
`main` — the PR diff will be polluted and CI may test against a stale base.

### CI must be green after every commit you push
After every `git push`, run `gh run watch` or poll `gh run list --limit 3` until all checks
finish. If any job fails, **stop and fix it before continuing**. Never leave a red CI.

The CI runs four jobs — all must pass:
| Job | Command |
|-----|---------|
| quality | lint + tsc + version-consistency check |
| test | `bun run test:run` (unit, 4 env configs) |
| build | `bun run build` (Next.js + dist/index.js) |
| test-e2e | `bun run test:e2e` |

### Always add unit tests for new behaviour
When you add or change logic, add a corresponding test in `__tests__/`. Never modify
existing tests just to make them pass — if a test breaks, fix the code, not the test.
Exception: updating a test that explicitly tests the value you're changing (e.g. a version
string or an error message you intentionally changed).

## Testing protocol

### After every implementation change

1. **Unit tests first** — fast, in-process:
   ```bash
   bun run test:run
   ```

2. **Local smoke test** — use the dev dist directly:
   ```bash
   bun build --target=node --format=cjs --outfile=dist/index.js src/index.ts
   FAILPROOFAI_DIST_PATH=$(pwd)/dist failproofai p -i -c <policy-file>
   ```

3. **Docker clean-install test** — mimics a real `npm install -g` from scratch.
   Use the `oven/bun:latest` image (bun pre-installed) with `--network=host`:

   ```bash
   # Pack without running the full build
   npm pack --ignore-scripts

   docker run --rm --network=host \
     -v $(pwd)/failproofai-*.tgz:/pkg.tgz \
     oven/bun:latest bash -c "
       apt-get update -qq && apt-get install -y -qq nodejs npm 2>&1 | tail -2
       npm install -g /pkg.tgz --ignore-scripts 2>&1 | tail -3
       cat > /tmp/test-policy.mjs << 'EOF'
   import { customPolicies, allow } from 'failproofai';
   customPolicies.add({
     name: 'smoke-test',
     description: 'Smoke test',
     match: { events: ['PreToolUse'] },
     fn: async (ctx) => allow(),
   });
   EOF
       failproofai --version
       failproofai p -i -c /tmp/test-policy.mjs
     "

   rm failproofai-*.tgz
   ```

   Expected output includes `Validated 1 custom hook(s): smoke-test` and exit 0.

4. **E2E tests** (before pushing):
   ```bash
   bun run test:e2e
   ```

### Regression areas to always check

After any change to `src/hooks/`, verify these scenarios don't regress:

| Scenario | How to check |
|----------|-------------|
| Custom policy with `from 'failproofai'` ESM import | Docker clean-install test above |
| Custom policy with `require('failproofai')` CJS | Write a `.js` test file with `require` and run `p -i -c` |
| Transitive local imports in custom policy | Use `examples/policies-advanced/index.js` |
| Builtin policies still fire (no custom file) | `failproofai p -i` without `-c` |
| `findDistIndex()` fallback when `FAILPROOFAI_DIST_PATH` unset | Unset the var and test |
| `loadCustomHooks` fail-open (bad file path) | Pass a nonexistent file without `--strict` |

## Project structure cheatsheet

```
bin/failproofai.mjs          Entry point (bun shebang); sets FAILPROOFAI_DIST_PATH
src/hooks/
  custom-hooks-loader.ts     Orchestrates temp-file creation + dynamic import
  loader-utils.ts            findDistIndex(), createEsmShim(), rewriteFileTree()
  custom-hooks-registry.ts   globalThis registry shared between loader and handler
  policy-helpers.ts          allow() / deny() / instruct()
  handler.ts                 Called by Claude Code --hook events
  manager.ts                 policies --install / --uninstall / list
src/index.ts                 Public API entry point → compiled to dist/index.js
dist/index.js                CJS bundle (built by `bun run build`; shipped in npm pkg)
__tests__/                   Unit + e2e tests (vitest)
examples/                    Sample custom policy files
```

## Changelog

Every PR **must** include an update to `CHANGELOG.md`. Add your entry under the
current `## <version> — <YYYY-MM-DD>` section at the top, where `<version>` matches
`version` in `package.json` and `<YYYY-MM-DD>` is today's date. If that section
does not exist yet, create it above the previous version's section. There is **no**
`## Unreleased` section — entries always go under a dated, versioned heading, so
each feature PR ships release-ready.

Use the appropriate subsection:

- **Features** for new functionality
- **Fixes** for bug fixes
- **Docs** for documentation-only changes
- **Dependencies** for dependency bumps

Each entry should be a single line: a short description followed by the PR number
(e.g. `- Add foo support (#123)`).

## Version bumps

When bumping the version, update **only** `package.json` (root). The CI version-consistency
check compares `packages/*/package.json` against root — that directory does not currently
exist, so no other files need updating.
