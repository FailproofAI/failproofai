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

**1.0.71 contract re-verification** (2026-07-16, live recorder-hook captures —
Copilot's schema drifted since the 1.0.41 verification above):

- **Config**: `hooks` must be an **object** keyed by event. Older installed
  files were rejected wholesale (`[ERROR] Invalid hook configuration …: hooks
  must be an object`) and the session ran **unhooked** — silently, no user-visible
  warning. Reinstalling with the current `writeHookEntries` schema fixes it.
- **Payloads**: the snake_case events (PreToolUse/PostToolUse/Stop/…) are
  Claude-shaped and deliver `tool_name` **already canonical** (`Bash`, `Read`,
  `Write`, `Edit`, `Grep`) — but the file tools use Copilot's own input keys:
  Read `{path}`, Write `{path, file_text}`, Edit `{path, old_str, new_str}`.
  `COPILOT_TOOL_INPUT_MAP` (keyed by canonical name) maps them to
  `file_path`/`content`/`old_string`/`new_string`; without it a live `.env`
  read passed block-env-files. Bash `{command}` and Grep `{pattern}` are canonical.
- **`permissionRequest` is the camelCase exception**: `{hookName, sessionId,
  timestamp:number, cwd, toolName:"bash" (lowercase), toolInput,
  permissionSuggestions}`. `handler.ts` has a `cli === "copilot"` branch
  normalizing `toolName`/`toolInput`/`sessionId`; the lowercase names go
  through `COPILOT_TOOL_MAP` as before.
- **Deny still works**: the Claude `{hookSpecificOutput:{permissionDecision:
  "deny"}}` shape is honored on PreToolUse — verified live (`success:false,
  code:"denied"` in session events; the sudo never ran). Stop gates
  (`require-*-before-stop`) also verified firing + forcing retries on 1.0.71.
- **Caveat**: in headless `copilot -p` runs from a fresh directory, the
  project-scope `.github/hooks/*.json` file was NOT loaded (git repo or not);
  the user-scope `~/.copilot/hooks/*.json` always loaded. Likely a
  trusted-folder gate — treat user scope as the reliable enforcement point for
  headless/CI usage until verified otherwise.

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

**Project-local trust (pi ≥0.80).** Newer Pi (verified against pi-coding-agent
v0.80.3) no longer trusts a **project-local** `.pi/settings.json` by default:
`pi list` gained a `--approve`/`-a` flag ("Trust project-local files for this
command"), and without it project packages are silently ignored (`pi list`
prints `No packages installed.`). User-scope packages
(`~/.pi/agent/settings.json`) are always trusted. The live `pi list` roundtrip
tests in `__tests__/e2e/hooks/pi-integration.e2e.test.ts` detect the installed
Pi version and pass `--approve` only on ≥0.80 (older Pi trusts project files
unconditionally and rejects the unknown flag), so they see the project-scope
package failproofai's installer writes on either side of the cutoff.

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

### Hermes hooks (`~/.hermes/config.yaml`)

Unlike the six CLIs above, this repo does **not** ship a dogfood Hermes config —
Hermes (hermes-agent) is a downstream client's Slack/Telegram gateway, not something
we run in-repo. Hermes is a **dual-pillar** integration: an **audit** adapter
(`src/audit/cli-adapters/hermes.ts`, reads `~/.hermes/state.db` directly) **and** a
**live-hook** integration (`hermes` in `INTEGRATIONS`).

Hermes uses a **Claude/Codex-style external shell-hook system**, but its config is
**YAML** (`~/.hermes/config.yaml`) under a `hooks:` map — the only integration whose
settings file is YAML, so `integrations.ts` has a comment-preserving `readYamlDoc`/
`writeYamlDoc` layer (the `yaml` package's `Document` API) that rewrites only the
`hooks:` key, preserving the operator's other settings and any comments **outside**
that block. (Comments *inside* the `hooks:` map are not preserved — we rebuild the
key from `doc.toJS()` — but failproofai owns that block, so there's nothing to keep.)

Settings file paths:

| Scope   | Path                        |
|---------|-----------------------------|
| user    | `~/.hermes/config.yaml`     |

Hermes is **user-scope only** — there is no project config, so `getSettingsPath`
ignores scope/cwd. Hermes exposes no `$HERMES_PROJECT_DIR`; the installed command uses
the resolved binary path (`"${binaryPath}" --hook <event> --cli hermes`) — since
Hermes is user-scope only, no `npx` project form applies. `timeout` is in **seconds** (30).

**Consent (headless gateway).** Hermes prompts once per unique `(event, command)` hook
before running it. The gateway has no TTY, so install also writes
`hooks_auto_accept: true` into config.yaml (uninstall removes it). Tradeoff: this
auto-accepts *any* hook the operator adds — a deliberate choice for headless operation.
A more targeted alternative is to pre-seed `~/.hermes/shell-hooks-allowlist.json` with
just our `(event, command)` pairs; deferred as a future refinement.

**Block contract** (verified live): Hermes reads a `{"decision":"block","reason"}` JSON
object on **stdout** and **ignores exit codes**. So `policy-evaluator.ts` has a
`cli === "hermes"` deny branch (ahead of the Stop block) that emits that shape
unconditionally for every event — one branch covers PreToolUse/PostToolUse/SubagentStop.

**Platform independence & subagents.** The gateway is one Hermes process and
`pre_tool_call` fires on the *tool event*, not the source — so a single install
intercepts tool calls from **every platform (Slack/Telegram/cli/cron)** and Hermes's
**internal subagents** uniformly, with no per-platform config. The payload's
`source`/`chat_type`/`user_id` remain available for per-platform *rules*. Blind spot:
processes Hermes spawns via the `terminal` tool run in a separate process, so their
internal tool calls don't fire Hermes hooks — gate the *spawn* at `pre_tool_call`.

**Per-event capability matrix:**

| Hermes event       | Canonical (`HERMES_EVENT_MAP`) | Veto / mutate? | Notes |
|--------------------|--------------------------------|----------------|-------|
| `pre_tool_call`    | `PreToolUse`                   | ✅ block       | The core deny point — stops the tool before it runs. |
| `post_tool_call`   | `PostToolUse`                  | observation    | Observe / sanitize. |
| `on_session_start` | `SessionStart`                 | observation    | — |
| `on_session_end`   | `SessionEnd`                   | observation    | — |
| `subagent_stop`    | `SubagentStop`                 | ✅ block       | Subagent-return gate. |

**Limitations vs. Claude semantics.** Hermes has **no turn-end `Stop` event** — its
lifecycle is session-oriented and it can't force another turn into a session that's
ending — so `HERMES_EVENT_MAP` never emits `Stop` and the 5 `require-*-before-stop`
builtins never fire for it (inapplicable, not broken). It also lacks `UserPromptSubmit`
(only per-LLM-call `pre_llm_call`), `PreCompact`/`Notification`, etc. `instruct()`
degrades to **allow + logged note** — Hermes has no additional-context channel, so the
evaluator emits a non-blocking `{"decision":"allow", reason}` and surfaces the note on
stderr. In exchange Hermes has capabilities others lack (`transform_tool_result`,
`pre_gateway_dispatch`, `pre_llm_call`) — out of scope for now.

**Tool-input canonicalization.** `HERMES_TOOL_MAP` canonicalizes tool *names* and
`HERMES_TOOL_INPUT_MAP` the *argument keys*. Verified against a live `~/.hermes/state.db`:
`read_file`/`write_file`/`patch` deliver the file path as `path`, which we map to
`file_path` so path/content builtins (`block-env-files`, `block-secrets-write`,
`block-read-outside-cwd`) fire; `write_file`'s `content`, `patch`'s `old_string`/`new_string`,
and `search_files`' `pattern`/`path` are already canonical (so Grep needs no entry), and
`terminal`'s `command` is canonical too (Bash policies like `block-sudo` are live-verified).

For production users the recommended Hermes install is:
```bash
failproofai policies --install --cli hermes --scope user
```

### OpenClaw hooks (`~/.openclaw/openclaw.json`)

Like Hermes, this repo does **not** ship a dogfood OpenClaw config — OpenClaw
(openclaw gateway) is a downstream self-hosted assistant, not something we run
in-repo. OpenClaw is a **dual-pillar** integration: an **audit** adapter
(`src/audit/cli-adapters/openclaw.ts`, reads `~/.openclaw/agents/<id>/sessions/*.jsonl`)
**and** a **live-hook** integration (`openclaw` in `INTEGRATIONS`).

**OpenClaw's enforcement surface is its IN-PROCESS PLUGIN hooks, not shell hooks.**
OpenClaw has two extension surfaces: file-based **internal hooks**
(`~/.openclaw/hooks/`) which are **observation-only and cannot block**, and typed
**plugin hooks** (`api.on(name, handler, {priority, timeoutMs})`) which have
block/cancel semantics. So — like OpenCode — failproofai ships a **plugin**
(`openclaw-plugin/`, a static package like `pi-extension/`, shipped in the npm
tarball via `package.json` "files") that async-spawns the binary and translates
the verdict. The install registers it in `~/.openclaw/openclaw.json` (JSON):

- `plugins.load.paths[]` ← the shipped `openclaw-plugin/` dir (absolute path)
- `plugins.entries.failproofai = { enabled: true, hooks: { allowConversationAccess: true } }`
  (`allowConversationAccess` is required for the raw-conversation hooks
  `before_agent_run` / `before_agent_finalize`; verified live)

**User-scope only** — OpenClaw has no project config (workspace plugins are
disabled by default), so `getSettingsPath` ignores scope/cwd. Uninstall only
edits `openclaw.json`; it **never deletes the shipped plugin dir**.

**Async spawn, never `spawnSync`.** OpenClaw is a long-running multi-channel
gateway; a sync spawn on every hook would stall every channel. The shim
(`openclaw-plugin/index.js`) uses async `spawn` + a 30s guard and **fails open**
(any spawn/parse/timeout error → allow). It carries **no inline tool maps**
(unlike the OpenCode/Pi shims) — it forwards raw event/tool names and a
Claude-shaped stdin (`params→tool_input`, `toolName→tool_name`,
`transcriptPath→transcript_path`, `stopHookActive→stop_hook_active`,
`sessionKey→session_id`), and the binary canonicalizes via the `OPENCLAW_*`
maps in `types.ts` (single source of truth).

**Verdict mapping** (`policy-evaluator.ts` emits a flat Pi-style
`{permission, reason}`; the shim maps per-hook):

| OpenClaw plugin hook | Canonical (`OPENCLAW_EVENT_MAP`) | Veto / mutate? | Shim return on deny |
|----------------------|----------------------------------|----------------|---------------------|
| `before_tool_call`   | `PreToolUse`      | ✅ block  | `{block: true, blockReason}` |
| `after_tool_call`    | `PostToolUse`     | observation | — |
| `before_agent_run`   | `UserPromptSubmit`| ✅ block  | `{outcome: "block", reason}` |
| `before_agent_finalize` | `Stop`         | ✅ revise | `{action: "revise", reason}` |
| `session_start` / `session_end` | `SessionStart` / `SessionEnd` | observation | — |
| `subagent_ended`     | `SubagentStop`    | observation only | — (cannot veto) |
| `before_compaction`  | `PreCompact`      | observation | — |

**`before_agent_finalize` is a real turn-end gate** (carries `transcriptPath` +
`stopHookActive`, ≈ Claude's Stop payload), so the 5 `require-*-before-stop`
builtins **enforce** on OpenClaw — a deny becomes a `{action:"revise"}` that
re-runs the turn (unlike Hermes, which has no Stop event at all). **Instruct**
degrades to allow + stderr note on non-Stop events (no additional-context
channel); on Stop it emits the MANDATORY-ACTION deny so the revise loop carries
the directive. **Omitted hooks:** `agent_end` (would double-fire Stop) and
`message_sending` (outbound-message cancel gate — an OpenClaw-only capability,
deferred).

**No headless consent prompt** (unlike Hermes, which needed `hooks_auto_accept`)
— verified live: registering plugin hooks does not prompt on a headless gateway.

**Setup gotcha worth knowing** (hit during live verification): a config
`env.<PROVIDER>_API_KEY` is **not enough** to make a provider usable — the agent
runtime only registers a provider once an **auth profile** exists
(`openclaw models auth paste-api-key --provider <p>`); until then you get a
misleading `Unknown model: <p>/<model>`. Also, a restrictive `plugins.allow`
gates **bundled provider discovery** (`openclaw doctor --fix` sets
`plugins.bundledDiscovery: "compat"`).

**Audit pillar.** Sessions are real JSONL at
`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` (UUID-named) + a
`sessions.json` index keyed by sessionKey. Siblings `<uuid>.trajectory.jsonl`
(OTel trace) and `.trajectory-path.json` are **ignored**. `OPENCLAW_HOME`
overrides the home dir for tests. Transcript downloads stream the real file
(no synthesis, unlike Hermes).

For production users the recommended OpenClaw install is:
```bash
failproofai policies --install --cli openclaw --scope user
```

### Factory droid hooks (`~/.factory/hooks.json`)

Factory's **droid** CLI is a **dual-pillar** integration (live hooks + audit),
supporting **user + project** scope. Unlike Hermes/OpenClaw it uses a
Claude/Codex-style **external shell-hook system** — the installed command is
`bun bin/failproofai.mjs --hook <event> --cli factory` (dev) /
`npx -y failproofai --hook <event> --cli factory` (production project scope).
The entire contract below was **verified live against droid v0.171.0**.

**Schema: event names at the TOP LEVEL — NO `"hooks"` wrapper.** The published
docs are **wrong**: droid rejects a `{"hooks":{…}}` wrapper with
`WARN Ignoring unknown hook event keys keys:["hooks"]`. The `hooks.json` file
**is** the events object:

```json
{ "PreToolUse":  [ { "matcher": "*", "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ],
  "PostToolUse": [ { "matcher": "*", "hooks": [ … ] } ],
  "Stop":        [ { "hooks": [ … ] } ] }
```

Tool events (`PreToolUse`, `PostToolUse`) MUST include `"matcher": "*"` (matches
all tools per the docs). Non-tool events use `{ "hooks": [ … ] }` with **no**
matcher. `writeHookEntries` in `integrations.ts` branches on this; the file has
**no** top-level wrapper key, so `removeHooksFromFile` / `hooksInstalledInSettings`
iterate the top-level event keys directly.

**Events** (`FACTORY_HOOK_EVENT_TYPES`, all PascalCase): `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`,
`SubagentStop`, `PreCompact`, `SessionEnd`. Because they're already canonical
there is **no `FACTORY_EVENT_MAP` and no `handler.ts` branch**. The stdin
payload is Claude snake_case (`session_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, `tool_name`, `tool_input:{command,…}`), so
**no payload normalization** is needed.

**Tool-name canonicalization** (`FACTORY_TOOL_MAP`): `Execute→Bash`, `Read→Read`,
`Edit→Edit`, `Create→Write`, `Grep→Grep`, `Glob→Glob`, `LS→LS`,
`FetchUrl→WebFetch`, `WebSearch→WebSearch`, `TodoWrite→TodoWrite`, `Task→Task`.
`tool_input.command` is already the canonical Bash key, so there is **no**
`FACTORY_TOOL_INPUT_MAP`.

**Deny contract = EXIT CODE 2 + reason on stderr** (NOT a JSON decision — droid
ignores a `{decision:…}` object on tool events and drives blocking purely off
exit code 2; verified live: `Hook returned exit code 2, throwing
ToolExecutionControlError`). The **`Stop`** event is the exception — droid does
**not** support exit-2 force-retry there, so we emit `{decision:"block",
reason}` JSON on **stdout at exit 0** (docs: "if decision is block, Droid does
not stop"). So `policy-evaluator.ts`'s `cli === "factory"` branch: Stop →
exit 0 + `{decision:"block", reason: <MANDATORY ACTION text>}`; every other
event (PreToolUse, PostToolUse, …) → exit 2 + the blocked message on stderr.
`instruct()` degrades to allow + stderr note on non-Stop events (no
additional-context channel), and to the Stop `{decision:"block"}` shape on Stop.

**Audit pillar.** Sessions are real JSONL at
`~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl` (Claude-style encoded-cwd
folders, e.g. `-home-chetan`), one per session alongside a
`<sessionId>.settings.json` sibling we **ignore**. JSONL lines:
`{type:"session_start", id, cwd, …}` (carries cwd),
`{type:"message", message:{role, content:[…], visibility}, timestamp, …}`,
`{type:"compaction_state", …}`. `lib/factory-sessions.ts` (pure parser, cloned
from the Claude/OpenClaw pattern) + `lib/factory-projects.ts` enumerate and
parse them; `FACTORY_HOME` overrides the home dir for tests. Transcript
downloads stream the real file (no synthesis).

For production users the recommended Factory install is:
```bash
failproofai policies --install --cli factory --scope project
```

### Devin CLI hooks (`~/.config/devin/config.json` / `.devin/config.json`)

Devin's CLI (Cognition) is a **dual-pillar** integration (live hooks + audit),
supporting **user + project** scope. It is a **pure Claude-clone** — the entire
contract below was **verified live against devin v3000.1.27** — so the
Integration in `integrations.ts` mirrors `claudeCode` verbatim, changing only
`getSettingsPath` and the `--cli devin` command flag.

**Config lives under a Claude-style `"hooks"` key** (the file also holds
`org_id`, `theme_mode`, etc., so `readSettings`/`writeSettings` use the
merge-preserving `readJsonFile`/`writeJsonFile` helpers like Claude/Copilot):

| Scope   | Path                              |
|---------|-----------------------------------|
| user    | `~/.config/devin/config.json`     |
| project | `<cwd>/.devin/config.json`        |

There is **no `local` scope**. Devin does not expose a `$DEVIN_PROJECT_DIR`; the
installed command uses `"<binaryPath>" --hook <event> --cli devin` (user) /
`npx -y failproofai --hook <event> --cli devin` (project). `buildHookEntry`
emits `{type:"command", command, timeout:60, [FAILPROOFAI_HOOK_MARKER]:true}`
— Devin reads Claude's seconds-based `timeout`.

**Events** (`DEVIN_HOOK_EVENT_TYPES`, all PascalCase → **no `DEVIN_EVENT_MAP`,
no `handler.ts` branch**): `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`. The stdin payload is
**pure Claude snake_case → no normalization**: PreToolUse `{hook_event_name,
tool_name:"exec", tool_input:{command}, tool_use_id}`; PostToolUse adds
`tool_response:{success, output, error}`; Stop `{stop_hook_active}`.

**Tool-name canonicalization** (`DEVIN_TOOL_MAP`): `exec→Bash` only (the shell
tool; `tool_input.command` is already the canonical Bash key, so there is **no**
`DEVIN_TOOL_INPUT_MAP`). All other Devin tool names pass through unchanged.

**Deny contract = `{"decision":"block","reason"}` JSON on stdout at exit 0**
(VERIFIED live — the block overrode `--permission-mode dangerous`).
`policy-evaluator.ts`'s `cli === "devin"` deny branch emits this shape for
**every** event: non-Stop → `{decision:"block", reason: blockedMessage}`;
Stop → `{decision:"block", reason: <MANDATORY ACTION text>}` (force-retry for the
5 `require-*-before-stop` builtins). **Instruct**: Devin is Claude-compatible, so
on Stop it emits the `{decision:"block"}` MANDATORY text, and every
context-injection event falls through to the generic Claude
`{hookSpecificOutput:{hookEventName, additionalContext}}` path.

**Audit pillar** (VERIFIED): sessions live in SQLite at
`~/.local/share/devin/cli/sessions.db`. The `sessions` table has one row per
session **with a real `working_directory`** (so sessions group by project cwd
like Claude, unlike cwd-less Hermes); `message_nodes.chat_message` is
OpenAI-style JSON (`{role, content, tool_calls?:[{id, name, arguments}],
tool_call_id?}`). `lib/devin-sessions.ts` (pure, unit-tested parser, cloned from
the Hermes SQLite pattern) + `lib/devin-projects.ts` enumerate and parse them via
the shared WAL-aware `lib/sqlite-reader.ts`; `resolve-transcript-path.ts` returns
a `devin-db://<id>` virtual path (like opencode) and `download-session.ts`
synthesizes a JSONL export. `DEVIN_HOME` (data dir) / `DEVIN_DB_PATH` (db file)
override for tests.

For production users the recommended Devin install is:
```bash
failproofai policies --install --cli devin --scope project
```

### Antigravity CLI hooks (`~/.gemini/config/hooks.json` / `.agents/hooks.json`)

Antigravity (`agy`) is the 11th CLI — a **dual-pillar** integration (live-hook
enforcement **and** audit) that, unlike Factory/Devin, has its **OWN** hook
contract (NOT a Claude-clone). Verified **live against agy v1.1.2** (shipped
docs at `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`).
Binary probe: `agy`.

**NAMED-hook schema.** `hooks.json`'s top-level key is a hook *name*
(`"failproofai"`), whose value is an event→handlers map. Tool events
(`PreToolUse`/`PostToolUse`) wrap handlers in a `{matcher, hooks:[…]}` group;
non-tool events (`PreInvocation`/`Stop`) are **flat** arrays of handler objects:

```json
{ "failproofai": {
    "PreToolUse":  [ { "matcher": "*", "hooks": [ { "type":"command", "command":"…", "timeout":30 } ] } ],
    "PostToolUse": [ { "matcher": "*", "hooks": [ { "type":"command", "command":"…", "timeout":30 } ] } ],
    "PreInvocation": [ { "type":"command", "command":"…", "timeout":30 } ],
    "Stop":          [ { "type":"command", "command":"…", "timeout":30 } ] } }
```

`writeHookEntries`/`removeHooksFromFile`/`hooksInstalledInSettings` operate under
`settings.failproofai`, handling both the wrapper (`{matcher,hooks:[]}`) and flat
(`[{…}]`) shapes, and preserve any other named-hook keys (e.g. a user's
`"lint-checker"`). Multiple named hooks merge; `"enabled": false` disables one.
Settings paths:

| Scope   | Path                          |
|---------|-------------------------------|
| user    | `~/.gemini/config/hooks.json` |
| project | `<cwd>/.agents/hooks.json`    |

No `local` scope. `timeout` is in **seconds** (30). Command: project
`npx -y failproofai --hook <event> --cli antigravity`; user
`"<binaryPath>" --hook <event> --cli antigravity`. `ANTIGRAVITY_HOOK_EVENT_TYPES`
= `["PreToolUse","PostToolUse","PreInvocation","Stop"]`.

**Event map.** `ANTIGRAVITY_EVENT_MAP`: `PreToolUse→PreToolUse`,
`PostToolUse→PostToolUse`, `PreInvocation→UserPromptSubmit`, `Stop→Stop`. The
`canonicalizeEventType` branch in `handler.ts` maps the `--hook` arg.

**camelCase → snake_case normalization.** Antigravity pipes camelCase protojson.
`handler.ts` normalizes it right after `JSON.parse` (before any canonicalization):
`toolCall.{name,args}` → `tool_name`/`tool_input`, `conversationId` →
`session_id`, `workspacePaths[0]` → `cwd`, `transcriptPath` → `transcript_path`.
After that the existing extraction works. `run_command`'s args are PascalCase
(`CommandLine`/`Cwd`) → `ANTIGRAVITY_TOOL_INPUT_MAP` (keyed by canonical `Bash`)
maps them to `command`/`cwd`. Tool names via `ANTIGRAVITY_TOOL_MAP`
(`run_command→Bash` VERIFIED; `view_file→Read`, `edit_file→Edit`, … best-effort;
unknown tools pass through).

**Response shapes (Antigravity's OWN — `policy-evaluator.ts` `cli === "antigravity"`):**

| Case | Shape (exit 0) |
|------|----------------|
| Deny (tool/prompt events) | `{decision:"deny", reason}` |
| Deny on `Stop` | `{decision:"continue", reason}` — `"continue"` re-enters the loop (how `require-*-before-stop` enforces) |
| Instruct on `UserPromptSubmit` (canonical for `PreInvocation`) | `{injectSteps:[{ephemeralMessage:"Instruction from failproofai: …"}]}` |
| Instruct on `Stop` | `{decision:"continue", reason}` |
| Instruct on other events | stderr note only (degrade like Hermes) |

**Audit pillar.** Plain-JSONL transcripts at
`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
(one step per line: `{step_index, source, type, status, created_at, content?,
tool_calls?}`). `type` enum (uppercase): `USER_INPUT` → user message,
`PLANNER_RESPONSE` (text and/or `tool_calls:[{name, args}]`) → assistant turn,
`<TOOL>` (e.g. `RUN_COMMAND`, the uppercased tool name) → the result step paired
back onto the matching `tool_use`, `CONVERSATION_HISTORY`/`CHECKPOINT` → skipped.
The conversation index is SQLite at `conversation_summaries.db`
(`conversation_summaries` table: `conversation_id, title, step_count,
workspace_uris, last_modified_time, …`) — read via `lib/sqlite-reader.ts` for
title/cwd enrichment, but the `brain/` transcripts are the source of truth for
existence (the DB can be checkpointed empty). `workspace_uris` gives cwd →
per-project grouping; when absent we recover cwd from the first `run_command`
`Cwd` arg, else a synthetic `antigravity` project. `lib/antigravity-sessions.ts`
(pure parser + `findAntigravityTranscript`) + `lib/antigravity-projects.ts` +
`src/audit/cli-adapters/antigravity.ts`. `ANTIGRAVITY_HOME` overrides the home
dir for tests.

For production users the recommended Antigravity install is:
```bash
failproofai policies --install --cli antigravity --scope project
```

### VS Code agent hooks (covered by the `copilot` / `claude` integrations — no dedicated id)

VS Code's built-in **Copilot Chat agent mode** (Preview, `github.copilot-chat`)
ships its own lifecycle-hooks engine, but it is NOT a separate failproofai
integration — it reuses hook-config paths failproofai already writes, so it's
covered for free. Verified live against VS Code 1.127 (`github.copilot-chat`
v0.55.0): the agent discovers and loads hook configs from **`.github/hooks/*.json`**,
**`~/.copilot/hooks/*.json`**, and **`~/.claude/settings.json`** (governed by the
`chat.hookFilesLocations` setting, whose default includes all three), using the
Claude-shaped `{hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason}}`
contract over a snake_case stdin payload.

Those are exactly the paths the **`copilot`** integration
(`.github/hooks/failproofai.json` project, `~/.copilot/hooks/failproofai.json`
user) and the **`claude`** integration (`~/.claude/settings.json`) already write.
So **`failproofai policies --install --cli copilot`** (or `--cli claude`) already
enforces inside VS Code agent-mode sessions — no `vscode` id, no new code. (VS
Code's logs were observed loading `failproofai.json` from both `[local] .github/hooks/`
and `[user] ~/.copilot/hooks/` during a live probe.)

**Caveat:** the hooks feature is a **Preview** and requires an active GitHub
Copilot subscription + agent mode; the OpenAI ChatGPT / Claude Code VS Code
extensions are separate runtimes (the Claude Code extension routes through
failproofai's `claude` hooks in `~/.claude/settings.json` — also already covered).

### Goose hooks (`~/.agents/plugins/failproofai/hooks/hooks.json`)

Goose (codename goose, Block) is a **local, MCP-based** dev-agent — a
**dual-pillar** integration (live hooks + audit) supporting **user + project**
scope. The entire contract below was **verified live against goose v1.43.0**.

**Enforcement uses Goose's "hooks" system — the cross-agent Open Plugins spec.**
A plugin is a directory whose `hooks/hooks.json` wires shell commands into agent
events; Goose **auto-discovers** any dir under `~/.agents/plugins/<name>/` (user)
or `<cwd>/.agents/plugins/<name>/` (project) at startup and **self-registers** it
into `~/.config/goose/config.yaml`. So the installer just **drops the plugin dir**
(no config edit — simpler than OpenCode). The installed command is
`bun bin/failproofai.mjs --hook <event> --cli goose` (dev) /
`npx -y failproofai --hook <event> --cli goose` (production).

**Schema: an Open Plugins `hooks.json` WITH a top-level `"hooks"` wrapper** (unlike
Factory, which has none), and **the matcher is OMITTED on every event** — a bare
`"*"` is an **invalid regex that matches nothing** (verified live; omitted = match
all). failproofai owns the entire `failproofai` plugin dir, so entries stay the
clean `{type, command}` shape (**no `__failproofai_hook__` marker** — Goose parses
this file); our hooks are identified by the `--cli goose` command substring.

```json
{ "hooks": {
    "PreToolUse":  [ { "hooks": [ { "type": "command", "command": "…" } ] } ],
    "PostToolUse": [ { "hooks": [ … ] } ],
    "SessionStart":[ { "hooks": [ … ] } ] } }
```

**Events** (`GOOSE_HOOK_EVENT_TYPES`, all PascalCase → **no `GOOSE_EVENT_MAP`, no
handler event branch**): `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SessionEnd`. The stdin payload uses `event` (not
`hook_event_name`) and `working_dir` (not `cwd`), so `handler.ts` normalizes
`working_dir`→`cwd` for goose (a small block, like Antigravity); `tool_name` /
`tool_input` are already canonical field names.

**Deny contract = `{"decision":"block","reason"}` JSON on stdout at exit 0**, honored
on **`PreToolUse` ONLY** (shipped goose ≥ **v1.37.0**, PR block/goose#9304; exit 2
also blocks). Any other error/timeout → **fail-open** (allow). `PreToolUse` fires
for the shell tool **and inside delegated subagents**, so it is the single
sufficient deny point. Goose has **NO `Stop` event** (the 5
`require-*-before-stop` builtins never fire for it — inapplicable, like Hermes) and
does **not** honor deny on `UserPromptSubmit`/`PostToolUse` (observation only). So
`policy-evaluator.ts`'s `cli === "goose"` deny branch emits the block JSON for
every event (Goose honors it on PreToolUse, ignores it elsewhere — no Stop
special-case). `instruct()` degrades to **allow + stderr note** (no
additional-context channel — a non-block decision injects nothing).

**Tool-name canonicalization** (`GOOSE_TOOL_MAP`): tool names arrive **both** bare
(`shell→Bash`, `write→Write`, `edit→Edit`, `view→Read`, `read_image→Read`,
`glob→Glob`, `grep→Grep`, `tree→LS`, `delegate→Task`) **and** `<ext>__<tool>`
namespaced (`todo__todo_write→TodoWrite`); the map covers both, unknown tools pass
through. **`GOOSE_TOOL_INPUT_MAP`** maps path-bearing tools' `path` (and
read_image's `source`) → `file_path` so path builtins fire; shell's `command` is
already canonical.

**Audit pillar.** Sessions are SQLite at
`~/.local/share/goose/sessions/sessions.db` (schema_version 15). `sessions` rows
carry a real `working_dir`, so audit groups by project cwd like **Devin** (not
grouped-by-source like Hermes); `messages.content_json` is a **Claude-style
typed-block array** (`toolRequest`/`toolResponse`) parsed by `lib/goose-sessions.ts`
(pure, unit-tested) + `lib/goose-projects.ts`. `session_type='hidden'`
(`--no-session`) scratch runs are filtered. `GOOSE_HOME` / `GOOSE_DB_PATH` override
the data dir for tests. Transcript downloads synthesize JSONL from the rows.

**Provider gotcha** (not failproofai's concern, but hit during live verification):
with the OS keyring disabled, goose reads the provider API key from the
**environment** (`OPENAI_API_KEY`), **not** from `config.yaml` — the YAML key is
ignored (`401 No api key passed in`).

For production users the recommended Goose install is:
```bash
failproofai policies --install --cli goose --scope project
```

### Dogfood configs for Factory / Devin / Antigravity / Goose

Like the Codex / Cursor / OpenCode / Pi setups above, this repo ships
**project-scope dogfood configs** for the four newest CLIs so failproofai
enforces on itself when you drive this repo with them. Each uses the dev
`bun bin/failproofai.mjs --hook <event> --cli <cli>` command (never the `npx`
production form — same self-reference caveat as the others):

| CLI | Dogfood path | Schema |
|-----|--------------|--------|
| Factory (`droid`) | `.factory/hooks.json` | top-level event keys, `matcher:"*"` on tool events (no `"hooks"` wrapper) |
| Devin | `.devin/config.json` | Claude `"hooks"` wrapper |
| Antigravity (`agy`) | `.agents/hooks.json` | named-hook schema under the `failproofai` key |
| Goose | `.agents/plugins/failproofai/hooks/hooks.json` | Open Plugins (auto-discovered; matcher omitted — a bare `*` matches nothing) |

These were generated from each integration's own `writeHookEntries`, so they
track the live schema. See each CLI's architecture section above for the full
contract. As with the other CLIs, do **not** run
`failproofai policies --install --cli <cli>` from inside this repo — it would
overwrite the dev `bun bin/failproofai.mjs` path with the production `npx` form.

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
