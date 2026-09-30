# Cloud-managed policy deployments

This is the contract between the Failproof Cloud HTTP transport and the
`failproofaid` policy worker. Polling and integrity maintenance run outside the
hook path; hooks evaluate only the last verified local deployment.

## Layout

```text
~/.failproofai/policies/cloud-policies/      (FAILPROOFAI_CLOUD_POLICY_DIR overrides)
├── desired-state.json
├── active.json
├── errors.json            written by the CLI: what it could not load or run
├── daemon-errors.json     written by the daemon: its own reconcile errors
├── jev-budget.json        written by the CLI: pack checks Cloud dropped for the budget
└── artifacts/
    └── <sha256>.mjs       a JS policy (kind regex / both)
```

Nothing Jev-related is written here but the mode: a `jev` policy, and the Jev
half of a `both` policy, live only on FailproofAI Cloud (CONTRACT C10). See
"Cloud Jev" below for how the machine reaches them.

- `desired-state.json` is the last complete desired-state snapshot received
  from cloud. A later slice must authenticate it with a publisher signature;
  SHA-256 alone proves byte identity, not publisher identity.
- `artifacts/` is a content-addressed cache and holds the only copy of each
  artifact. The pre-layout-3 `generations/` / `deployments/` trees are removed
  after the first successful flip.
- `active.json` is an atomically replaced pointer to one complete deployment —
  its JS policies and its Jev mode. It is derived state and is reconstructed
  when it is deleted, malformed, or disagrees with `desired-state.json`.

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
  "jevMode": "observe"
}
```

The schema stays 2: every field after `policies[].effect` is optional and
omitted when empty, so a fleet with no Jev mode and no `both` policy receives,
and writes back to disk, byte-identical JSON to what it always did.

- `policies[]` carries the JS half of `regex` and `both` policies. A `both`
  policy's entry adds `authority: "reviewable"` and `reviewedBy` (the names of
  its own Jev checks, which run on FailproofAI Cloud); the server derives both,
  the client never supplies them. `authority` must be `hard` or `reviewable`,
  or the whole state is refused.
- `jevMode` (`off | observe | enforce`), when present, is FailproofAI Cloud's
  Jev mode for this machine; see "Cloud Jev". Absent means Cloud does not set
  one. Any other value refuses the whole state.
- A `semanticPolicies` list (sent by a pre-release server) is ignored and never
  fetched. An `active.json` a pre-release daemon wrote with that key still
  parses: the key is dropped on read and never written again.

The artifact URL is opaque to the store. A cloud client supplies downloaded
bytes through `ArtifactFetcher`, same-origin and bearer-authenticated; the
reconciler trusts none of those bytes until their SHA-256 matches the desired
state.

## Cloud Jev

Cloud's `jevMode` decides whether this machine uses Jev, and where:

| `jevMode` | what the CLI does on a gated tool call |
|---|---|
| absent | today's local behaviour: `jev.json` (BYOK) and installed packs' checks; no Cloud checks |
| `off` | no Jev at all, whatever `jev.json` says |
| `observe` / `enforce` | sends the call to FailproofAI Cloud (`POST /enforcement/v1/jev/systemone`) on the Cloud Jev credential — `jev.json` is not used — and applies the answer in that mode |

With a mode of `observe`/`enforce` EVERY gated tool call is sent, with the
global intent questions even when no installed pack has a check for it, plus
a `cloud` block of tool-call metadata (`machineId`, the computed facts, the
target scan, the human's recent turns, `intentMode`, and the names of the
machine's own pack checks). FailproofAI Cloud adds this machine's deployed Jev
checks, asks TypeSafe once, decides its own checks, and returns every answer
plus its verdict. The CLI decides its pack checks from the answers as always,
merges the two verdicts (Cloud first, most severe wins), and a `both`
policy's `reviewedBy` is satisfied only by that policy's own Cloud outcomes.
Cloud gets 5 s (`CLOUD_JEV_TIMEOUT_MS`); a Cloud failure or timeout is today's
fallback: the regex decides alone and a `both` policy stays hard. A session
pause does not stop Cloud's checks (Cloud JS assignments are exempt from a
pause too): a paused session's calls still go to Cloud, without the installed
packs' checks, which the pause does switch off.

No call is made, and `errors.json` says why under id `jevMode`, when the mode
asks but the machine cannot: `transcripts_disabled` on a machine connected for
decisions only (`--no-transcripts`), `jev_unconfigured` with no Cloud Jev
credential (`jev_unconfigured: <detail>` when one exists and cannot be used).

## Error report

The poll carries an optional `policyErrors` query parameter: compact JSON
`[{"id": str, "version": int|null, "kind": "regex"|"jev"|"both"|"daemon", "message": str}]`,
URL-encoded, at most 4 KiB encoded (whole entries are dropped from the end;
the JSON is never cut). It merges:

- `daemon-errors.json` — the daemon's own reconcile errors (`kind: "daemon"`):
  a refused payload, a fetch the server answered with an error, a digest
  mismatch. Transport failures — of the poll or of an artifact fetch that never
  got an HTTP answer — are not reported.
- `errors.json` — written by the CLI, atomically and only when its content
  changes, as `{"errors": [...]}`: a Cloud JS policy that failed to load,
  `jev_unconfigured` / `transcripts_disabled` (Cloud set a Jev mode this
  machine cannot act on, see "Cloud Jev"), and an installed pack's check
  FailproofAI Cloud dropped from a request for the question budget
  (`{"id": "pack:<packId>", "kind": "daemon", "message": "jev_budget: dropped <name>"}`,
  kept in `jev-budget.json` for as long as the deployment and mode last).

The CLI rewrites `errors.json` only when a hook runs, so the daemon sends only
the entries of it that still describe the deployment in `active.json`: one
policy's entry only while that policy is deployed at the version it names, and
a `jev_unconfigured`, a `transcripts_disabled` or a pack check's `jev_budget`
drop only while Cloud's Jev mode is `observe` or `enforce`. A fix made in
FailproofAI Cloud therefore clears at the next poll, not the next tool call.
When `active.json` cannot be read, nothing is left out.

Messages carry no local paths: the home directory becomes `~` and any other
absolute path its last segment. The CLI applies that before writing
`errors.json` and the daemon again on the way out, so a report never names a
user whichever side wrote it.

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
`--disconnect` removes it together with `desired-state.json` (first, so nothing
can rebuild the pointer from it), `active.json`, the two error files and
`jev-budget.json`, and
`--status` reports the connection with the token masked.

A disconnect sticks. The daemon never rebuilds `active.json` on a machine that
is not enrolled; a poll that was in flight when the disconnect landed is
abandoned before it writes anything; and on a machine put back on OSS
(`mode: "oss"` in `config.json`) the daemon removes any Cloud deployment it
still finds, so none of the old organisation's policies or its Jev mode
return. That cleanup deletes four fixed filenames, so it runs only in the default
directory, never in one `FAILPROOFAI_CLOUD_POLICY_DIR` names.

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

1. Validate schema, policy IDs, unique IDs, digests, `authority`, `jevMode`,
   and monotonic deployment.
2. Reuse a verified cached artifact or fetch missing bytes.
3. Verify every artifact digest.
4. Write each verified artifact atomically and `fsync` it.
5. Persist `desired-state.json`.
6. Atomically replace `active.json` — the policies and `jevMode` in one write.

Any failure before step 6 leaves the previous deployment active. The worker
loads only paths named by `active.json` and independently verifies every
digest immediately before importing JavaScript.

## Integrity maintenance

`failproofaid` runs a maintenance thread outside the hook path. It hashes the
active deployment's artifacts periodically (30 seconds by default). On an enrolled machine — reachable or not, and with a readable
credential or not — a lost or corrupt `active.json` is rebuilt from
`desired-state.json` and the verified cache. On a machine that is not enrolled
nothing is rebuilt. There is one copy of each artifact, so a modified one
cannot be repaired offline: the thread keeps the active manifest and reports
that a cloud re-fetch is required, and the next successful poll re-fetches it.

`FAILPROOFAI_CLOUD_POLICY_DIR` overrides the root for tests and development
(the daemon then never runs the OSS cleanup above in it).
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
