# FailproofAI for Hermes

This directory is the native Hermes adapter shipped inside the `failproofai`
npm package. It keeps policy evaluation in FailproofAI's TypeScript worker and
translates structured verdicts into Hermes-native hook behavior.

Validated contract: Hermes 0.21.3 at
`4d55ca91656ac5f83e1506679b7f81e0238e5e16`. The plugin uses only documented
manifest v2 fields, `PluginContext` methods/state, and keyword hook payloads.
Hermes 0.20.0 is also supported: its `PluginContext` has no `get_config` or
`state` (both arrived in 0.20.1), so the plugin reads the same
`plugins.entries.failproofai` settings through Hermes' config loader and keeps
its ledger in the directory `state.data_dir` would name, which a later Hermes
upgrade reuses.

## Installation

Hermes policy evaluation requires a configured, healthy local `failproofaid`
daemon. If this machine has not been configured yet, run `failproofai config`
first. The standalone installer refuses to enable the fail-closed plugin until
the daemon answers an end-to-end health probe.

Then run:

```bash
failproofai policies --install --cli hermes --scope user
```

The installer symlinks `<HERMES_HOME>/plugins/failproofai` in every discovered
profile to this directory and adds `failproofai` to `plugins.enabled` in that
profile's `config.yaml`. Hermes' plugin scan follows the link, so an npm
upgrade updates the plugin with no reinstall. Where a symlink cannot be
created, the files are copied instead and marked `.failproofai-managed`.
Reinstall replaces only such a marked copy or a link into a FailproofAI
`hermes-plugin/`; an unrelated plugin with the same name is never overwritten.
Python may write `__pycache__/` here when the package directory is writable;
it goes with the package on upgrade and is skipped when it cannot be written.

`failproofai update` moves profiles that already use FailproofAI (legacy shell
hooks or a copied plugin) to the link. Legacy shell hooks never ran for Hermes
cron jobs, so `update` exits non-zero and keeps the shell hooks when the
running daemon cannot serve the plugin.

Legacy FailproofAI shell hooks are removed during migration. Operator-owned
hooks and unrelated plugin settings are preserved. No dashboard deployment or
backtest is part of installation.

## Supported Hermes versions

Hermes 0.20.0 and later. Tested on 0.20.0 (v2026.8.3), 0.20.1 (v2026.8.13),
0.20.6 (v2026.8.27), 0.21.0 (v2026.8.31), 0.21.3 (v2026.9.14), 0.21.5
(v2026.9.24, the latest release) and upstream main (2026-10-05).
Hermes 0.20.0 has no `ctx.get_config` or `ctx.state`; the plugin detects that and
reads the same settings and state directory another way.

## Runtime path

```text
Hermes pre_tool_call
  -> native Python plugin
  -> owner-only failproofaid Unix socket
  -> warm TypeScript policy worker
  -> structured allow | deny | instruct verdict
  -> Hermes-native return value
Hermes tool_execution middleware (wraps the real call)
  -> instruct reminder placed at the start of the call's own result
```

There is no cloud request and no new CLI process in the tool-call path.

## Decision behavior

- `allow`: return no directive; Hermes runs the tool.
- `deny`: always return `{"action":"block","message":"..."}`.
- `instruct`: the call runs, and the reminder is placed at the **start** of its
  result, so it survives the 1,500-character preview Hermes keeps of a large
  result:
  - a JSON object result gets `"failproof_policy_reminder"` as its first key
    (the rest is unchanged, so `json.loads` consumers such as `execute_code`
    scripts keep working). A field of that name the tool returned itself is
    moved to `"tool_failproof_policy_reminder"`, never merged into the
    reminder;
  - other text gets a leading `[FailproofAI policy reminder (<policies>)] ...`
    line (an `Error...` result keeps that prefix and gets the line at its end);
  - a list of content blocks or a multimodal envelope gets a leading text block,
    leaving image blocks intact.

  Tool calls made by an `execute_code` script hand their reminder to the outer
  `execute_code` result, which is the one the model reads, and the script gets
  its own result untouched, so nothing it prints, writes or sends carries the
  reminder. (With no open outer call to carry it, the inner result keeps it.)
  A result Hermes reports as blocked (`{"error": ...}` only) is never
  annotated. This uses Hermes' `tool_execution` middleware
  (`ctx.register_middleware`, present unchanged in 0.20.0, 0.21.x and main).

  A policy's reminder (same policy and reason) is attached once per Hermes
  session + turn; a later turn gets it again. When the full reminder would take
  the result past 7,500 characters it is shortened to the policy names and the
  first 160 characters of the reason, so it never pushes a result over Hermes'
  8,000-character persistence threshold and never fills the 1,500-character
  preview of a result already past it.

  `instruct` therefore no longer stops the action first on Hermes: use `deny`
  when an action must not happen at all.

Where Hermes offers no `tool_execution` middleware, `instruct` falls back to
holding the call once: persist delivery state, return model-visible
`FailproofAI policy guidance (...)` ("apply it, then continue; repeating the
same call is allowed"), keep the same API request held, then allow a later API
iteration. That fallback's scope is profile + session + task + turn + policy
fingerprint — not the tool, so moving the same work to another tool (for
example `execute_code`) is not held again.
The persistent SQLite ledger lives below Hermes' profile-scoped plugin data
directory. Two distinct instruction interruptions are allowed per turn by
default; after that, advisory instructions fail open so they cannot create an
infinite retry loop. A real deny is never bypassed by the ledger.

Every model turn also receives a short protocol note (`pre_llm_call`): a
`failproof_policy_reminder` is an operator rule added by FailproofAI (not tool
data) about a call that ran normally and is never to be quoted, repeated or
mentioned in replies, messages or files, a FailproofAI block means that action
must not run by any route, and `FailproofAI policy guidance` held a call only once.

No hook raises: `pre_tool_call` blocks on any internal error (Hermes 0.20.0 and
0.21.x would treat a raised exception as allow), observer hooks log and return,
and the middleware falls back to the plain result. One evaluation, connect
included, is capped at 25 seconds (`evaluation_timeout_ms`, default 12000):
Hermes 0.21.x abandons a `pre_tool_call` after 30 seconds and then blocks every
call for 60. Observer hooks wait at most 2 seconds, so against a hung daemon a
blocked call costs the evaluation deadline plus 2 seconds, not twice the
deadline.

Tool names are canonicalized in the daemon: Hermes 0.21's `process_manage`,
`cronjob_manage` and `todo_list` match policies written for 0.20's `process`,
`cronjob` and `todo`.

## Configuration

Settings live under `plugins.entries.failproofai.settings`:

```yaml
plugins:
  enabled:
    - failproofai
  entries:
    failproofai:
      settings:
        failure_mode: deny
        connect_timeout_ms: 250
        evaluation_timeout_ms: 12000
        instruction_ttl_seconds: 3600
        max_instruction_rounds: 2
```

`failure_mode` controls evaluator/protocol failures only. `deny` is the safe
default. `allow` favors availability when the local daemon cannot return a
trusted verdict. Ledger failures always allow only the advisory `instruct`
decision, because otherwise corrupted retry state could block a turn forever.

## Local protocol

Requests and responses use the existing length-prefixed failproofaid Unix
socket protocol, version 1.

```json
{
  "type": "policyEvaluation",
  "protocolVersion": 1,
  "integration": "hermes",
  "event": "pre_tool_call",
  "payload": {},
  "cwd": "/workspace/project"
}
```

```json
{
  "type": "policyResult",
  "protocolVersion": 1,
  "decision": "instruct",
  "policyNames": ["custom/approved-write-route"],
  "reason": "Use the approved write route.",
  "matchedPolicies": ["custom/approved-write-route"],
  "durationMs": 3,
  "toolName": "Write"
}
```

Requests are limited to 1 MiB and responses to 16 MiB. Invalid JSON, unknown
message types, version mismatch, timeout, and socket failure are treated as
untrusted evaluation failures.

## Diagnostics and rollback

`failproofai config --status` reports each existing Hermes profile as healthy,
disabled, incomplete, duplicated with a legacy shell hook, or still on legacy
shell hooks alone (Hermes cron jobs are not checked). Hermes-side load
errors are available through:

```bash
HERMES_PLUGINS_DEBUG=1 hermes plugins list
hermes plugins doctor ~/.hermes/plugins/failproofai --ci
hermes logs --level WARNING
```

Each `register()` writes `heartbeat.json` beside `instructions.db` in the
profile's plugin data directory (`plugin-data/agent-plugin-failproofai-5296f299/`):
pid, Hermes version, `HERMES_HOME`, profile, the plugin's real path and version,
the hooks and middleware Hermes accepted, `register_ok` and a timestamp. It is
the proof of what a running Hermes process actually loaded, which
`hermes plugins list` (config only) cannot show; Hermes' log gets one INFO line.

Use a temporary `HERMES_HOME` for development and compatibility tests. Remove
the integration with:

```bash
failproofai policies --uninstall --cli hermes --scope user
```

Uninstall removes the config registration and the profile's link (or marked
copy); it never removes this package directory.
