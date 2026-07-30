# Collector integration

## Goal

`failproofaid` replaces the standalone AgentEye collector without losing its behavior. The initial Rust integration should preserve proven modules and conformance tests before refactoring them into shared daemon subsystems.

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

Logical queues have separate quotas and priority. A historical transcript backfill cannot consume space reserved for recent enforcement evidence. Quota exhaustion is visible and follows a documented shedding/backpressure rule; undelivered data is never silently removed.

## Delivery behavior

- Successful acknowledgement removes the durable pending record.
- Permanent client rejection moves it to a diagnosable quarantine.
- Network and server errors retry with bounded exponential backoff and jitter.
- Concurrent delivery shares one configured semaphore and in-flight identity set.
- The sweeper revisits eligible failed work and recovers files accumulated during downtime.

Health reports pending count/bytes, oldest age, last acknowledged delivery, retries, quarantined/poison records, and per-source checkpoint progress. Process liveness alone is not collector health.

## State migration

Migration from `~/.agenteye/` is explicit and resumable:

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
- Replay does not create duplicate backend events.
- Every source resumes from a crash-safe checkpoint.
- Backfill load cannot starve enforcement or recent delivery.
- Old and new collectors can never own the same source concurrently.
- Migration rollback restores a functional standalone collector with its undelivered state.
