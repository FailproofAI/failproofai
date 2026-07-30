# Collector integration

## Goal

`failproofaid` replaces the standalone `agenteye-collector` without losing its behavior. The initial Rust integration should preserve proven modules and conformance tests before refactoring them into shared daemon subsystems.

Everything the collector ships today is Phase 1 scope — capture, backfill, durable spooling, and delivery — because it is shipped behavior, and Phase 1's promise is that nothing a user can do today stops working. Owning capture without delivery would be the worst of both: two processes reading the same transcripts, and data stranded in whichever spool nobody is watching.

Delivery does not pull an account into Phase 1. The collector authenticates to the customer's **own self-hosted** Failproof AI Observability server with an operator-issued API key holding `events:add` — not a FailproofAI cloud login, and not a machine identity. That key is configuration the customer already provides, so it carries over unchanged. Machine enrollment into Failproof Cloud is a different credential for a different purpose and stays in [Phase 2](../phase-2-cloud/01-login-and-enrollment.md).

Capture is off until enabled, and stays that way: the destination server, its key, and each capture source are explicit choices, and a machine with none of them configured spools nothing and delivers nowhere.

## Capabilities to preserve

- atomic SDK event-spool watching;
- periodic sweeping for missed notifications and downtime;
- bounded upload concurrency and in-flight deduplication;
- exponential backoff with jitter;
- response-aware success, retry, and permanent-failure handling;
- retryable quarantine and poison-file handling;
- delivery-aware health and failed-batch age;
- controlled flush and backfill;
- per-source checkpoints and bounded reads/batches;
- Codex, Claude Code, OpenClaw, and Hermes capture semantics;
- multi-root/profile discovery where currently supported.

## Source workers

Each source owns its parser, discovery, checkpoint, polling/watch cadence, and resource budget. One malformed transcript, locked database, or inaccessible root degrades only that source.

Source identity must align with enforcement identity. Captured sessions and hook decisions for the same agent run need stable machine, harness, agent, session, and parent-session identifiers.

## Durable spool

SDK events, captured sessions, enforcement activity selected for upload, and delivery diagnostics enter a durable spool before network delivery. Enforcement never waits for upload.

Records carry schema version, source, stable ID, creation time, destination, and attempt state. Writes use temp-file plus atomic rename or a crash-safe transactional store. Backend ingestion uses stable IDs for idempotent replay.

Delivery follows a crash-durable state machine:

1. write the pending record and `fsync` its contents and containing directory before it becomes eligible for upload;
2. send the stable record/batch ID and require a durable backend acknowledgement for that ID;
3. after acknowledgement, write and `fsync` a local acknowledged tombstone/state transition and `fsync` its containing directory (or commit an equivalent durable transaction) before removing pending payload bytes;
4. remove the pending payload, then `fsync` its containing directory;
5. compact acknowledged tombstones only after their retention/reconciliation rule proves they are no longer needed.

A crash before the durable local acknowledgement is ambiguous even if the backend already committed the record. Recovery therefore replays the pending record with the same stable ID; backend idempotency returns the same durable acknowledgement. A crash after the tombstone but before payload deletion resumes cleanup without reclassifying the record as unsent. No transition relies on atomic rename alone for power-loss durability.

Logical queues have separate quotas and priority. A historical transcript backfill cannot consume space reserved for recent enforcement evidence. Quota exhaustion is visible and follows a documented shedding/backpressure rule; undelivered data is never silently removed.

## Delivery behavior

- Durable backend acknowledgement moves the record through the fsynced acknowledged/tombstone state before payload removal.
- Permanent client rejection moves it to a diagnosable quarantine.
- Network and server errors retry with bounded exponential backoff and jitter.
- Concurrent delivery shares one configured semaphore and in-flight identity set.
- The sweeper revisits eligible failed work and recovers files accumulated during downtime.

Health reports pending count/bytes, oldest age, last acknowledged delivery, retries, quarantined/poison records, and per-source checkpoint progress. Process liveness alone is not collector health.

## State migration

Migration from the legacy collector state directory is explicit and resumable:

1. discover the old service, configuration, credentials, pending/failed files, and checkpoints;
2. acquire an ownership lock so old and new collectors cannot process the same source simultaneously;
3. stop but do not remove the old service;
4. import or reference pending state without changing stable delivery identity;
5. start `failproofaid` and verify source progress and delivery health;
6. retain rollback metadata and old state through the rollback window;
7. remove old service artifacts only after successful convergence.

Failure restores old ownership and service state. Migration never deletes unacknowledged files merely because they were copied.

## Collector acceptance criteria

- Existing collector conformance behavior passes against daemon-integrated modules.
- Killing the daemon at every spool/delivery transition loses no acknowledged data.
- Power-loss tests at every pending, acknowledged, tombstone, deletion, and directory-fsync boundary recover by idempotent replay or completed cleanup.
- Replay does not create duplicate backend events.
- Every source resumes from a crash-safe checkpoint.
- Backfill load cannot starve enforcement or recent delivery.
- Old and new collectors can never own the same source concurrently.
- Migration rollback restores a functional standalone collector with its undelivered state.
