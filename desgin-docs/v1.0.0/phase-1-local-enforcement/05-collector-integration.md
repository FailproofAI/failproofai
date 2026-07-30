# Collector integration

## Goal

**The daemon does capture.** `failproofaid` absorbs the standalone `agenteye-collector`'s work into its collection and delivery lanes, so a machine runs one resident process instead of two. The initial Rust integration should preserve proven modules and conformance tests before refactoring them into shared daemon subsystems.

Everything the collector ships today is Phase 1 scope — capture, backfill, durable spooling, and delivery — because it is shipped behavior, and Phase 1's promise is that nothing a user can do today stops working. Owning capture without delivery would be the worst of both: two processes reading the same transcripts, and data stranded in whichever spool nobody is watching.

Running as the user is what makes this straightforward rather than architectural. Every capture source resolves under a home directory — `~/.codex/sessions`, `~/.factory`, `~/.openclaw`, `~/.gemini/antigravity-cli`, `~/.local/share/{devin,goose}` — where homes are `0700` or `0750` and transcripts are typically `0600`. The daemon opens them, `inotify`s them, and attaches to the SQLite-backed ones in WAL mode (which needs to create `-shm`/`-wal` siblings, and therefore *write* access to the user's directory) with no ACL grants, no delegated agent, and no privilege at all. The design that needed a second process to reach these files needed it only because the daemon was a different account.

Delivery does not pull an account into Phase 1. The collector authenticates to the customer's **own self-hosted** Failproof AI Observability server with an operator-issued API key holding `events:add` — not a FailproofAI cloud login, and not a machine identity. That key is configuration the customer already provides, so it carries over unchanged. Machine enrollment into Failproof Cloud is a different credential for a different purpose and stays in [Phase 2](../phase-2-cloud/01-login-and-enrollment.md).

Capture is off until enabled, and stays that way: the destination server, its key, and each capture source are explicit choices, and a machine with none of them configured spools nothing and delivers nowhere.

## State stays where it already is

Capture state lives in **`~/.agenteye/`**, in the layout the standalone collector already uses: its configuration, the observability destination and its `events:add` key, per-source checkpoints, the durable spool, and failed and quarantined batches. The daemon adopts that tree in place.

This is a compatibility requirement, not a preference. The state is a user's undelivered data and their resume points; relocating it means a migration that can fail, a rollback that has to reverse it, and a window where two layouts both look authoritative — all to satisfy a tidiness argument nobody made. Nothing moves into `~/.failproofai/`, and no path under `/var/lib`, `/opt`, or `/Library` appears.

The exact subpaths are the collector's, not this document's. `agenteye-collector` is a separate repository, so **confirming and vendoring its on-disk layout alongside its conformance corpus is an explicit prerequisite** of the stage that does this work, and the daemon's reader/writer is asserted against the real thing rather than against a description of it.

The delivery key is the only secret Phase 1 handles. It stays where the collector keeps it, readable by the user whose data it delivers, using the operating-system credential store where practical with an owner-only file as the portability fallback. It never appears in the service definition, in a process argument, or in a log, and it is erased unconditionally on uninstall — including an uninstall performed offline, because leaving a working credential on disk is a property of the key rather than of who can read it.

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

## Taking over from a running collector

A machine that already runs `agenteye-collector` has one thing that genuinely must be sequenced: two processes must never watch one source at the same time. The takeover is explicit and resumable:

1. discover the old service, its configuration, credentials, pending/failed files, and checkpoints;
2. acquire an ownership lock so the old collector and the daemon cannot process the same source simultaneously;
3. stop but do not remove the old service;
4. adopt the existing state **in place** — same directory, same stable delivery identity, no copy and no rewrite;
5. start `failproofaid` and verify source progress and delivery health;
6. retain rollback metadata through the rollback window;
7. remove old service artifacts only after successful convergence.

Step 4 is the one that changed shape. Because the daemon reads and writes the collector's own `~/.agenteye/` layout, there is no import step to get wrong and nothing to reconcile between two copies; rollback is putting the old service back in front of state it never stopped understanding. Failure restores old ownership and service state, and no unacknowledged file is deleted because something else read it.

## Collector acceptance criteria

- Existing collector conformance behavior passes against daemon-integrated modules, reading and writing the collector's existing `~/.agenteye/` layout unchanged.
- No capture, spool, checkpoint, or delivery state is relocated, and setup performs no state migration.
- Killing the daemon at every spool/delivery transition loses no acknowledged data.
- Power-loss tests at every pending, acknowledged, tombstone, deletion, and directory-fsync boundary recover by idempotent replay or completed cleanup.
- Replay does not create duplicate backend events.
- Every source resumes from a crash-safe checkpoint.
- Backfill load cannot starve enforcement or recent delivery.
- The old collector and the daemon can never own the same source concurrently.
- Rollback restores a functional standalone collector in front of the same undelivered state.
