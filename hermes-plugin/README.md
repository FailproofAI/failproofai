# FailproofAI for Hermes

This directory is the native Hermes adapter shipped inside the `failproofai`
npm package. It keeps policy evaluation in FailproofAI's TypeScript worker and
translates structured verdicts into Hermes-native hook behavior.

Validated contract: Hermes 0.21.3 at
`4d55ca91656ac5f83e1506679b7f81e0238e5e16`. The plugin uses only documented
manifest v2 fields, `PluginContext` methods/state, and keyword hook payloads.

## Installation

Run:

```bash
failproofai policies --install --cli hermes --scope user
```

FailproofAI copies this directory to every discovered profile at
`<HERMES_HOME>/plugins/failproofai/` and adds `failproofai` to
`plugins.enabled` in that profile's `config.yaml`. Reinstall replaces only a
directory carrying `.failproofai-managed`; an unrelated plugin with the same
directory name is never overwritten.

Legacy FailproofAI shell hooks are removed during migration. Operator-owned
hooks and unrelated plugin settings are preserved. No dashboard deployment or
backtest is part of installation.

## Runtime path

```text
Hermes pre_tool_call
  -> native Python plugin
  -> owner-only failproofaid Unix socket
  -> warm TypeScript policy worker
  -> structured allow | deny | instruct verdict
  -> Hermes-native return value
```

There is no cloud request and no new CLI process in the tool-call path.

## Decision behavior

- `allow`: return no directive; Hermes runs the tool.
- `deny`: always return `{"action":"block","message":"..."}`.
- `instruct`: persist delivery state, block the first attempt with a
  model-visible `FAILPROOF INSTRUCTION`, keep the same API request blocked, then
  allow a later API iteration for the same instruction scope.

The default instruction scope is profile + session + task + turn + policy
fingerprint + canonical tool. The persistent SQLite ledger lives below Hermes'
profile-scoped plugin data directory. Two distinct instruction interruptions
are allowed per turn by default; after that, advisory instructions fail open so
they cannot create an infinite retry loop. A real deny is never bypassed by the
ledger.

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
disabled, incomplete, or duplicated with a legacy shell hook. Hermes-side load
errors are available through:

```bash
HERMES_PLUGINS_DEBUG=1 hermes plugins list
hermes plugins doctor ~/.hermes/plugins/failproofai --ci
hermes logs --level WARNING
```

Use a temporary `HERMES_HOME` for development and compatibility tests. Remove
the integration with:

```bash
failproofai policies --uninstall --cli hermes --scope user
```

Uninstall removes the config registration and only the plugin directory marked
as FailproofAI-managed.
