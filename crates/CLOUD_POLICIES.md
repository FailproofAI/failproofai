# Cloud-managed policy generations

This is the local contract between a future Failproof Cloud transport and the
`failproofaid` policy worker. Network authentication and assignment APIs are
deliberately outside this first slice.

## Layout

```text
~/.failproofai/policies/cloud-managed/
├── desired-state.json
├── active.json
├── artifacts/
│   └── <sha256>.mjs
└── generations/
    └── <generation>/
        ├── manifest.json
        └── <policy-id>.mjs
```

- `desired-state.json` is the last complete desired-state snapshot received
  from cloud. A later slice must authenticate it with a publisher signature;
  SHA-256 alone proves byte identity, not publisher identity.
- `artifacts/` is a content-addressed cache.
- `generations/` contains complete materialized policy sets. New generations
  are built without modifying the active one.
- `active.json` is an atomically replaced pointer to one complete generation.
  It is derived state and is reconstructed when it is deleted, malformed, or
  disagrees with `desired-state.json`.

## Desired-state schema

```json
{
  "schemaVersion": 1,
  "generation": 184,
  "policies": [
    {
      "id": "block-secret-exfiltration",
      "revision": 7,
      "sha256": "<64 lowercase hex characters>",
      "artifactUrl": "https://..."
    }
  ]
}
```

The artifact URL is opaque to the store. A cloud client supplies downloaded
bytes through `ArtifactFetcher`; the reconciler trusts none of those bytes
until their SHA-256 matches the desired state.

## Activation transaction

1. Validate schema, policy IDs, unique IDs, digests, and monotonic generation.
2. Reuse a verified cache/generation copy or fetch missing bytes.
3. Verify every artifact digest.
4. Materialize the complete generation and `fsync` its files/directories.
5. Persist `desired-state.json`.
6. Atomically replace `active.json`.

Any failure before step 6 leaves the previous generation active. The worker
loads only paths named by `active.json` and independently verifies every digest
immediately before importing JavaScript.

## Integrity maintenance

`failproofaid` runs a maintenance thread outside the hook path. It hashes the
active generation periodically (30 seconds by default) and repairs either a
modified generation copy or a modified content-addressed artifact from the
other verified copy. If both are gone, it retains the active manifest and
reports that a cloud re-fetch is required.

`FAILPROOFAI_CLOUD_POLICY_DIR` overrides the root for tests and development.
`FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS` overrides the interval, clamped to at
least 100 ms.

## Current security boundary

PR #632 runs the daemon as the same OS user as the governed agent. This layer
provides deterministic deployment, drift detection, and self-healing, but it
does not make policies tamper-proof against that user. The user can stop the
service or delete both verified copies. Publisher signatures, machine
credentials, cloud polling, acknowledgement, and a stronger service identity
are separate follow-up layers.

Downloaded JavaScript executes in the existing TypeScript policy worker with
the user's authority. Cloud authorization must therefore treat assigning an
arbitrary JavaScript policy as remote code execution until a sandboxed policy
runtime exists.
