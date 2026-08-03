# Cloud-managed policy generations

This is the contract between the Failproof Cloud HTTP transport and the
`failproofaid` policy worker. Polling and integrity maintenance run outside the
hook path; hooks evaluate only the last verified local generation.

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

## Cloud transport

Enrol with the CLI:

```bash
failproofai config --connect https://be.failproof.ai \
  --token <org-scoped policies:pull key> \
  --machine-id prod-runner-01     # defaults to this host's name
```

That verifies the credentials against the server before storing anything, then
writes `~/.failproofai/cloud.json` (mode 0600). `--disconnect` removes it,
`--status` reports the connection with the token masked.

**The credential must not go in the service unit.** `daemon-service.ts` installs
`/etc/systemd/system/failproofaid@<user>.service` at mode 0644 — root-owned and
world-readable — and the launchd plist likewise. An
`Environment="FAILPROOFAI_CLOUD_TOKEN=…"` line there hands an organization-scoped
key to every local user, and `systemctl show` prints it back with no privilege
at all. Keeping it in a file also means enrolment, rotation and disconnect need
no root, and an already-installed daemon can be connected without reinstalling.

The daemon re-resolves enrolment on **every poll**, not at startup, so all three
take effect within one interval with nothing to restart — which matters because
restarting a system unit needs root, the very thing this avoids.

Environment variables still take precedence over the file, for CI, containers
and tests:

```text
FAILPROOFAI_CLOUD_URL=https://be.failproof.ai
FAILPROOFAI_CLOUD_TOKEN=<org-scoped policies:pull key>
FAILPROOFAI_MACHINE_ID=<deployment machine id>
FAILPROOFAI_CLOUD_CREDENTIALS=<path>   # overrides ~/.failproofai/cloud.json
```

`FAILPROOFAI_CLOUD_POLICY_POLL_MS` controls the interval (30 seconds by
default, clamped to at least 100 ms). The client sends Bearer authentication
to both desired-state and artifact endpoints. Relative artifact locators are
resolved against the configured base URL; cross-origin locators are rejected
before the token is sent.

An HTTP failure, invalid desired-state response, bad digest, or incomplete
generation leaves the previous generation active.

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
When cloud polling is disabled, `FAILPROOFAI_CLOUD_POLICY_RECONCILE_MS`
overrides the standalone integrity interval, clamped to at least 100 ms. With
cloud polling enabled, integrity repair runs on each poll.

## Current security boundary

PR #632 runs the daemon as the same OS user as the governed agent. This layer
provides deterministic deployment, drift detection, and self-healing, but it
does not make policies tamper-proof against that user. The user can stop the
service or delete both verified copies. Publisher signatures, deployment
acknowledgement, and a stronger service identity are separate follow-up layers.
The current machine credential is an org-scoped Bearer key transported over
HTTPS.

Downloaded JavaScript executes in the existing TypeScript policy worker with
the user's authority. Cloud authorization must therefore treat assigning an
arbitrary JavaScript policy as remote code execution until a sandboxed policy
runtime exists.
