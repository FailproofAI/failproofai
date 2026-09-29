# Cloud-managed policy deployments

This is the contract between the Failproof Cloud HTTP transport and the
`failproofaid` policy worker. Polling and integrity maintenance run outside the
hook path; hooks evaluate only the last verified local deployment.

## Layout

```text
~/.failproofai/policies/cloud-policies/      (FAILPROOFAI_CLOUD_POLICY_DIR overrides)
├── desired-state.json
├── active.json
├── errors.json            written by the CLI: what it could not load
├── daemon-errors.json     written by the daemon: its own reconcile errors
└── artifacts/
    ├── <sha256>.mjs       a JS policy (kind regex / both)
    └── <sha256>.json      a Jev policy's declarations (kind jev / both)
```

- `desired-state.json` is the last complete desired-state snapshot received
  from cloud. A later slice must authenticate it with a publisher signature;
  SHA-256 alone proves byte identity, not publisher identity.
- `artifacts/` is a content-addressed cache and holds the only copy of each
  artifact. The pre-layout-3 `generations/` / `deployments/` trees are removed
  after the first successful flip.
- `active.json` is an atomically replaced pointer to one complete deployment —
  its JS policies AND its Jev policies. It is derived state and is
  reconstructed when it is deleted, malformed, or disagrees with
  `desired-state.json`.

The directory is `cloud-policies`, matching `cloudPoliciesDir()` in
`src/hooks/fp-home.ts`; `paths.rs`' parity test executes that module to keep
the two in step.

## Desired-state schema

```json
{
  "schemaVersion": 2,
  "deployment": 184,
  "policies": [
    {
      "id": "no-prod-db",
      "version": 7,
      "sha256": "<64 lowercase hex characters>",
      "artifactUrl": "/enforcement/v1/artifacts/<sha256>",
      "effect": "enforce",
      "authority": "reviewable",
      "reviewedBy": ["acme-prod-db-write"]
    }
  ],
  "semanticPolicies": [
    {
      "id": "no-prod-db",
      "version": 7,
      "sha256": "<64 lowercase hex characters>",
      "artifactUrl": "/enforcement/v1/artifacts/<sha256>"
    }
  ],
  "jevMode": "observe"
}
```

The schema stays 2: every field after `policies[].effect` is optional and
omitted when empty, so a fleet with no Jev policy receives, and writes back to
disk, byte-identical JSON to what it always did.

- `policies[]` carries the JS half of `regex` and `both` policies. A `both`
  policy's entry adds `authority: "reviewable"` and `reviewedBy` (the names of
  its own Jev checks); the server derives both, the client never supplies them.
  `authority` must be `hard` or `reviewable`, or the whole state is refused.
- `semanticPolicies[]` carries `jev` and `both` policies. Each artifact is a
  JSON array of pack-manifest semantic declarations; the daemon never parses
  it, the CLI parses it with the same function it uses for a pack manifest.
  Ids are unique within this list; the same id may appear in both lists (that
  is what a `both` policy looks like).
- `jevMode` (`off | observe | enforce`), when present, overrides the local
  `jev.json` mode — a local `off` included. Absent means Cloud does not
  override. Any other value refuses the whole state.

The artifact URL is opaque to the store. A cloud client supplies downloaded
bytes through `ArtifactFetcher` — the same same-origin, bearer-authenticated
fetch for both artifact kinds; the reconciler trusts none of those bytes until
their SHA-256 matches the desired state.

## Error report

The poll carries an optional `policyErrors` query parameter: compact JSON
`[{"id": str, "version": int|null, "kind": "regex"|"jev"|"both"|"daemon", "message": str}]`,
URL-encoded, at most 4 KiB encoded (whole entries are dropped from the end;
the JSON is never cut). It merges:

- `daemon-errors.json` — the daemon's own reconcile errors (`kind: "daemon"`):
  a refused payload, a failed fetch, a digest mismatch. Transport failures are
  not reported.
- `errors.json` — written by the CLI, atomically and only when its content
  changes, as `{"errors": [...]}`: a Cloud JS policy that failed to load, a
  semantic artifact that failed its digest or parse, a declaration its parser
  dropped, a `reviewedBy` naming a check that is not present, and
  `jev_unconfigured` (Cloud set a Jev mode and the machine has no provider).

The parameter is sent on every poll once either file exists (`[]` once the
problems are fixed, which clears them on the server) and omitted while neither
side has ever recorded an error state. The server stores the latest report per
machine and shows it on the fleet page.

## Cloud transport

Enrol with the CLI:

```bash
failproofai config --connect https://be.failproof.ai \
  --token <org-scoped policies:pull key> \
  --machine-id prod-runner-01     # defaults to this host's name
```

That verifies the credentials against the server before storing anything, then
writes the `cloud` object of `~/.failproofai/credentials.json` (mode 0600; the
layout-1 `cloud.json` is still read when `credentials.json` is absent).
`--disconnect` removes it together with `active.json` and the two error files,
and `--status` reports the connection with the token masked.

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
FAILPROOFAI_CLOUD_CREDENTIALS=<path>   # a standalone credentials JSON file
```

`FAILPROOFAI_CLOUD_POLICY_POLL_MS` controls the interval (30 seconds by
default, clamped to at least 100 ms). The client sends Bearer authentication
to both desired-state and artifact endpoints. Relative artifact locators are
resolved against the configured base URL; cross-origin locators are rejected
before the token is sent.

An HTTP failure, invalid desired-state response, bad digest, or incomplete
deployment leaves the previous deployment active.

## Activation transaction

1. Validate schema, policy IDs, unique IDs (within each list), digests,
   `authority`, `jevMode`, and monotonic deployment.
2. Reuse a verified cached artifact or fetch missing bytes — JS and semantic.
3. Verify every artifact digest.
4. Write each verified artifact atomically and `fsync` it.
5. Persist `desired-state.json`.
6. Atomically replace `active.json` — both lists and `jevMode` in one write.

Any failure before step 6 leaves the previous deployment active, across both
lists: a `both` policy's JS half never goes live without the Jev checks that
review it. The worker loads only paths named by `active.json` and
independently verifies every digest immediately before importing JavaScript
or parsing a semantic artifact.

## Integrity maintenance

`failproofaid` runs a maintenance thread outside the hook path. It hashes the
active deployment's artifacts — JS and semantic — periodically (30 seconds by
default). A lost or corrupt `active.json` is rebuilt from `desired-state.json`
and the verified cache. There is one copy of each artifact, so a modified one
cannot be repaired offline: the thread keeps the active manifest and reports
that a cloud re-fetch is required, and the next successful poll re-fetches it.

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
