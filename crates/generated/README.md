# `crates/generated/` — generated data, not a crate

This directory holds **generated JSON**, consumed by the Rust `fpai-canon`
crate. It is deliberately **not** a crate: there is no `Cargo.toml` here, so the
workspace's `members = ["crates/*"]` glob does not pick it up.

| File | Generated from | Contents |
|---|---|---|
| `canonicalization-tables.json` | `src/hooks/types.ts` (+ the payload-normalization blocks in `src/hooks/handler.ts` and `src/hooks/resolve-cwd.ts`) | Per-CLI event map, tool-name map, tool-input-key map, and payload field normalizations. |
| `enforcement-capability.json` | `src/hooks/enforcement-capability.ts` | Per `(cli, canonical event)`, whether a DENY actually changes the agent's behaviour. |

## Regenerate

```bash
bun scripts/gen-canon-tables.ts
```

**Do not hand-edit either JSON file.** `src/hooks/types.ts` and
`src/hooks/enforcement-capability.ts` are the single source of truth — that is
why these are JSON and not generated `.rs`: the "verified live against
`<cli> vX.Y.Z`" annotations stay where reviewers already look, and there is no
generated Rust in the diff.

`__tests__/parity/canon-tables-drift.test.ts` re-runs the generator and fails
the build on any byte difference, so an edit here is reverted by CI rather than
merged.

## Reading them from Rust

Both documents carry a `schema_version` integer. **Refuse an unexpected
version** rather than best-effort parsing it — the version is bumped only when
the document *shape* changes (a renamed key, a changed value vocabulary), never
for content (a new CLI, a new tool mapping).

Order of application is recorded in the canonicalization document's `pipeline`
field, and it matters:

1. `payload_normalizations` — rewrite vendor payload fields to canonical keys
2. `event_map` — vendor event name → canonical `HookEventType`
3. `tool_map` — vendor tool name → canonical tool name
4. `tool_input_map` — keyed by the **canonical** tool name from step 3

Two fields record gaps in the source of truth rather than hiding them:
`unmapped_event_types` (a vendor event with no canonical `HookEventType`) and
`event_types_source` / `scopes_source` (which exported constant a list came
from; `HOOK_EVENT_TYPES` / `HOOK_SCOPES` mean the CLI declares none of its own).
In `enforcement-capability.json`, an **absent** `(cli, event)` entry means *not
verified* — never assume `"block"`.
