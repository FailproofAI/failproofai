# `failproofaid`: unified enforcement and collection daemon

Status: Draft

Target: failproofai v1.0.0

Last updated: 2026-07-30

## Decisions

- `failproofaid` is implemented in Rust.
- It is installed as a per-user operating-system service by default.
- Enforcement remains local and synchronous; collection and delivery remain asynchronous.
- Automatic update activation is performed outside the running daemon so a daemon never replaces or terminates itself mid-update.

## Summary

failproofai v1.0.0 introduces `failproofaid`, a per-user background service that starts at login and remains running. It becomes the local control plane for FailproofAI: agent hooks send enforcement requests to it, it performs expensive policy work from warm state, and it incorporates the full AgentEye collector pipeline for session capture and reliable event delivery.

The existing `failproofai` command remains the user-facing CLI. Agent integrations continue to use the hook mechanisms supported by each agent, but the installed hooks become small clients of `failproofaid` instead of loading policies and doing all work in a new process for every event.

Automatic updates are part of the service installation. The daemon may discover and stage an update, but it must not replace or restart its own executable. A separately invoked updater, controlled by the operating system's service manager, verifies, activates, health-checks, and if necessary rolls back a release.

## Motivation

Today each hook invocation starts the FailproofAI runtime, reads configuration, loads builtin and custom policies, evaluates the event, writes activity, and exits. This keeps no trusted process resident, but repeats setup on every agent event and leaves little room for heavier local capabilities without increasing hook latency.

Separately, the AgentEye collector already runs as a Rust daemon. It watches event spools and agent session sources, derives events, uploads them with bounded concurrency and retry, reports health, performs backfills, installs itself as a service, and supports updates. Running enforcement and collection as unrelated local services duplicates lifecycle, configuration, diagnostics, filesystem watching, release, and update machinery.

`failproofaid` unifies those responsibilities while keeping the enforcement path isolated from asynchronous background load.

## Goals

- Keep policy decisions local and return them within an explicit hook deadline.
- Avoid repeated policy/configuration startup work by maintaining warm, reloadable state.
- Preserve existing builtin and JavaScript/TypeScript custom-policy behavior.
- Support all collector capabilities in one service:
  - watch and sweep SDK event spools;
  - capture supported agent session sources;
  - checkpoint, backfill, batch, upload, retry, quarantine, and flush;
  - expose meaningful delivery health, not merely process liveness.
- Provide one install, status, logs, health, configuration, and uninstall experience.
- Update automatically through signed, atomic, rollback-capable releases.
- Ensure collection, upload, backfill, or update work cannot delay an enforcement decision.
- Preserve a bounded compatibility path when the daemon is unavailable during migration.

## Non-goals for v1.0.0

- Replacing agent vendors' hook protocols with a proxy or gateway.
- Moving enforcement decisions to a remote service.
- Running one system-wide daemon for every operating-system user.
- Allowing arbitrary local users to access another user's daemon or captured sessions.
- Rewriting the public policy authoring API solely to fit the daemon implementation.
- Updating a container in place; container deployments update by replacing the image.

## Proposed architecture

```text
 agent CLI hook
      |
      | framed request over Unix socket / named pipe
      v
 lightweight failproofai hook client
      |
      v
+--------------------------- failproofaid ----------------------------+
|                                                                     |
|  IPC server -> admission/deadline -> enforcement coordinator        |
|                                      |                              |
|                                      v                              |
|                              policy runtime                         |
|                         (warm, cached, reloadable)                   |
|                                      |                              |
|                                      +--> decision + activity spool |
|                                                                     |
|  source watchers --> derivation --> durable event spool --> uploader|
|       ^                                  |                    |      |
|       |                                  +--> retry/quarantine|      |
|  SDK events, Codex, Claude,                                   backend|
|  OpenClaw, Hermes, future sources                                    |
|                                                                     |
|  config watcher | checkpoints | health | metrics | update discovery |
+---------------------------------------------------------------------+
                              |
                     staged release metadata
                              v
              OS-triggered failproofai updater helper
                 verify -> stop -> swap -> start
                          -> probe -> rollback
```

### Process model

The default installation is one daemon per operating-system user. That matches the ownership of agent configuration, policy files, transcript stores, API credentials, and desktop login sessions. Linux uses a systemd user service, macOS uses a launchd LaunchAgent, and Windows uses a per-user Windows service or scheduled-task wrapper chosen during implementation.

The daemon has independently bounded execution lanes:

1. **Enforcement lane** — reserved capacity, strict deadlines, no network dependency, and priority over all background work.
2. **Collection lane** — file watching, transcript parsing, checkpointing, and backfill.
3. **Delivery lane** — batching, uploads, retry, and quarantine.
4. **Maintenance lane** — configuration reload, health snapshots, cleanup, and update discovery.

Every lane has its own queue and concurrency limits. Background lanes cannot borrow the enforcement lane's reserved workers or exhaust its memory budget.

### Rust implementation and policy runtime boundary

`failproofaid` is a Rust service. It absorbs the collector crates and owns IPC, service lifecycle, durable queues, source capture, delivery, health, and update staging. Rust is the authoritative implementation language for the daemon and all new core subsystems.

Existing custom policies are JavaScript or TypeScript and may use local/transitive imports. v1.0.0 must not silently narrow that contract. Policy execution therefore lives behind an internal policy-runtime interface. The first implementation should use a supervised, long-lived JavaScript worker shipped with the same release, allowing current policy loading and evaluation code to move with minimal semantic change. The daemon communicates with that worker over a private framed channel and restarts it on failure.

This is still one product service from the user's perspective: the worker is a child owned, versioned, monitored, and terminated by `failproofaid`; it is not independently installed or configured. A future embedded runtime is possible only after compatibility tests prove it supports the existing policy contract.

## Enforcement request path

### Hook client

Installed agent hooks invoke a small `failproofai hook` client. The client:

1. reads the vendor payload from stdin with a fixed size limit;
2. attaches the vendor name, raw event name, client version, request ID, and monotonic deadline;
3. connects to the user's local daemon endpoint;
4. sends one framed request and waits for one framed response;
5. translates the canonical response into the vendor's stdout and exit-code contract.

The client performs no network call. It should be a native binary or another startup-bounded artifact; launching the dashboard/Node application for each hook would defeat the daemon's latency goal.

### Local transport

- Linux/macOS: Unix domain socket under the user's runtime directory, mode `0600`.
- Windows: named pipe restricted to the installing user's security identifier.
- The endpoint must never listen on TCP, including loopback.
- Requests and responses use a length-prefixed, versioned protocol rather than newline-delimited JSON, because hook payloads may contain arbitrary newlines and large tool results.
- The daemon validates peer identity where the operating system exposes it and rejects requests from other users.

The initial protocol needs these operations:

- `EvaluateHook`: canonicalize and evaluate one hook event.
- `Ping`: cheap liveness and protocol-version negotiation.
- `Status`: summarized service and subsystem status for the CLI.
- `Reload`: request a configuration/policy reload and return its result.
- `Flush`: request delivery of pending events.

Administrative operations must be distinguishable from hook operations so future authorization can be tightened without changing the enforcement request.

### Evaluation

On `EvaluateHook`, the daemon:

1. validates the envelope and enforces payload limits;
2. canonicalizes the vendor event and tool shape;
3. takes an immutable snapshot of the active configuration and policy generation;
4. dispatches to the warm policy runtime with the remaining deadline;
5. persists the decision asynchronously to a durable local activity spool;
6. returns a canonical `allow`, `deny`, or `instruct` response plus vendor-independent reason metadata.

Requests already in flight finish against the generation they started with. A successful reload atomically swaps the active generation; a failed reload retains the last known-good generation and surfaces the error in health/status.

### Deadlines and daemon failure

Each integration defines a maximum total hook duration. The client reserves part of that budget for response translation and reports the remaining absolute deadline to the daemon. Work that cannot finish before the deadline is cancelled or abandoned; it must not continue consuming the enforcement lane indefinitely.

The daemon-unavailable behavior must remain explicit per policy/integration rather than accidentally allowing or blocking:

- **Migration default:** use the current in-process evaluator as a temporary compatibility fallback and emit a degraded-mode activity record.
- **After migration:** support a configured fail-open or fail-closed response for enforceable events.
- Stop-class events that can create retry loops require integration-specific handling; a generic nonzero exit is unsafe.

The compatibility evaluator is transitional and should be removed only after daemon installation and update reliability meet an agreed success threshold.

## Policy lifecycle and isolation

The daemon watches user, project, local, explicit, and convention policy configuration. File notifications are hints; a periodic reconciliation scan remains the correctness backstop.

A reload builds a candidate generation away from the active one:

1. resolve merged configuration and policy paths;
2. load builtin and custom policies with their transitive imports;
3. validate registrations and duplicate identities;
4. run a bounded initialization check;
5. atomically publish the generation.

Custom policy code is untrusted with respect to availability even though it executes with the user's authority. Each evaluation gets a time budget. Repeated timeouts or worker crashes trip a circuit breaker for the offending policy generation, retain diagnostic evidence, and apply the configured failure behavior. Memory and process limits should be applied where supported.

Project policy discovery introduces a cache-cardinality risk because one daemon serves many working directories. The cache must be bounded by entry count and memory, keyed by resolved configuration inputs, and evicted by recency. File changes invalidate every affected entry.

## Collector integration

The AgentEye collector behavior becomes a set of `failproofaid` subsystems rather than a second daemon. The initial port should preserve behavior before refactoring it.

### Capabilities to preserve

- Atomic event-spool watching plus a periodic sweeper for missed notifications and downtime.
- One shared upload concurrency limit and in-flight deduplication.
- Bounded exponential backoff with jitter.
- Response-aware handling: acknowledge/delete successful batches, quarantine permanent client failures, and retry transient failures.
- Retry of eligible quarantined/transient batches and poison-file handling.
- Delivery-aware health, including stale health state and old failed batches.
- One-shot flush and controlled backfill.
- Per-source checkpoints and bounded reads/batches.
- Current Codex, Claude Code, OpenClaw, and Hermes capture semantics, including multi-root/profile discovery where supported.
- Forward-compatible source registration for additional agents.

### Shared durable spool

All asynchronous output—SDK events, captured sessions, hook activity destined for observability, and daemon diagnostics selected for upload—enters a durable spool before network delivery. Enforcement responses never wait for upload.

Spool records carry a schema version, source, stable record/batch ID, creation time, attempt state, and destination. Writes use temp-file-plus-atomic-rename or an equivalently crash-safe transactional store. The delivery subsystem must tolerate replay; backend ingestion should use stable IDs for idempotency.

Separate logical queues and quotas prevent a transcript backfill from consuming all disk space needed for recent enforcement activity. When a quota is reached, the daemon reports degraded health and applies a documented per-queue shedding policy; it never silently deletes unshipped data.

### Source isolation

Each capture source owns its parser, checkpoint, polling/watch schedule, and resource budget. A malformed transcript or locked Hermes database must degrade only that source. The overall daemon and enforcement lane remain healthy.

## Configuration and state

The canonical user state root is `~/.failproofai/` (overridable for tests and managed deployments). A proposed layout is:

```text
~/.failproofai/
  config.json                 # non-secret user configuration
  credentials.json            # owner-only, or references to OS keychain entries
  run/                        # endpoint metadata where no OS runtime dir exists
  policies/                   # user convention policies
  state/
    checkpoints/              # source cursors
    activity/                 # local enforcement history
    spool/                    # pending durable delivery
    failed/                   # quarantined records
    health.json               # last health snapshot
    updates/                  # staged release and update state
  logs/
```

Credentials are never embedded in service-manager unit files or command lines. Prefer the operating-system credential store; an owner-only file is the portability fallback. Existing `~/.agenteye/` state requires an explicit, resumable migration that preserves unshipped files and checkpoints. The migration must not delete the old state until the new daemon has acknowledged ownership and a rollback window has passed.

Configuration changes are transactional and schema-versioned. Unknown fields are rejected for CLI writes but preserved when safe during read/modify/write, allowing newer installations to coexist with older management clients.

## Service and CLI experience

The public executable remains `failproofai`; `failproofaid` is the service binary/process name. Proposed commands:

```text
failproofai service install
failproofai service uninstall
failproofai service start|stop|restart
failproofai service status
failproofai service logs [--follow]
failproofai health [--json]
failproofai config validate
failproofai policies reload
failproofai collector flush
failproofai collector backfill ...
failproofai update [--check] [--channel stable|beta] [--version X]
failproofai update --rollback
```

`status` answers whether the service manager believes the process is running. `health` answers whether enforcement is responsive, the policy generation is valid, sources are advancing, pending data is deliverable, disk usage is within limits, and the installed release is coherent. These are intentionally different questions.

## Automatic updates

### Safety properties

An update must be:

- authentic: the release manifest is signed by a trusted offline/release key;
- complete: every platform asset and policy-worker artifact is covered by the manifest;
- compatible: protocol and state-schema compatibility are declared before activation;
- atomic: users see either the old release or the new release, never a mixture;
- recoverable: the previous release and state migration metadata remain available;
- externally activated: the running daemon never replaces and restarts itself;
- observable: check, download, activation, rollback, and suppression are visible in status/logs.

A SHA-256 file alone detects corruption but does not establish publisher authenticity if the checksum and artifact are served from the same compromised location. The updater verifies both the signed manifest and each artifact digest.

### Update flow

1. The daemon periodically checks a jittered stable or beta channel and records availability. Managed installations may disable automatic checks or pin a version.
2. The daemon downloads the release into a versioned staging directory with strict size/time limits.
3. It verifies the signed manifest, platform/architecture, hashes, minimum updater version, protocol compatibility, and available disk space.
4. It smoke-tests staged executables using side-effect-free version/protocol commands.
5. It asks the service-manager-controlled updater helper to activate the staged release. The helper is not a child whose lifetime depends on the daemon.
6. The helper stops the service, atomically switches a `current` pointer or versioned install directory, and starts the service.
7. It probes IPC readiness and deeper health within bounded deadlines.
8. On failure it restores the previous release, restarts it, records rollback evidence, and suppresses that bad version until manual retry or a newer release.

The updater serializes activation with a lock. Enforcement clients encountering the short restart window use the documented daemon-unavailable behavior. Updates should default to an idle window and may be deferred while enforceable hook requests are active, up to a maximum deferral period.

### Platform behavior

- Linux/macOS native installs use versioned directories plus an atomic symlink/pointer switch where permissions allow.
- Windows uses versioned directories and switches the service command/path because a running executable cannot be replaced in place.
- Containers never self-update; the health/status output reports the available image version and the orchestrator replaces the container.
- Package-manager-owned installations should default to notifying rather than overwriting managed files unless the installation explicitly opts into the standalone updater.

State migrations must be backward-readable by the retained rollback release or use copy-on-write/versioned state. An irreversible migration cannot participate in unattended auto-update.

## Security model

- The daemon and hook clients run as the same user; no privilege elevation is required for the default installation.
- IPC endpoints and state directories are owner-only and resist symlink/path substitution.
- Hook payloads, transcripts, tool results, environment data, and API keys are sensitive. Logs default to metadata and error classes, not payload contents.
- Remote policy execution is out of scope. Policy bundles loaded from disk retain the user's authority and are identified by content hash in activity records.
- All network destinations require TLS. Redirect and proxy behavior must be explicit to avoid credential forwarding to an unexpected host.
- Update keys are separate from backend/API credentials. Key rotation is represented in the signed manifest trust policy.
- The dashboard and CLI receive only the administrative IPC operations they require; exposing a local endpoint does not imply unrestricted filesystem or policy-runtime access.

## Health and observability

Health is a structured snapshot with independent subsystem states:

- service/IPC readiness and daemon uptime;
- enforcement queue depth, latency percentiles, timeouts, and active policy generation;
- policy reload success/failure and last known-good age;
- each capture source's last successful scan, checkpoint progress, and error;
- spool depth/bytes/oldest age by logical queue;
- upload success, retry, quarantine, and last acknowledged delivery;
- disk and memory pressure;
- installed, staged, available, and rolled-back update versions.

The CLI renders a concise diagnosis and remediation. `--json` exposes a stable, versioned shape for fleet tooling. Local logs are structured, rotated, size-bounded, and correlated by request/batch/update ID.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain last known-good configuration, apply configured event failure behavior, keep collection running. |
| Custom policy hangs | Enforce deadline, trip policy-generation circuit breaker after repeated failures, keep daemon responsive. |
| Backend unavailable | Continue local enforcement; durably spool and retry uploads with jitter. |
| Transcript parser fails | Quarantine or checkpoint safely for that source; other sources and enforcement continue. |
| Spool reaches quota | Report degraded health and apply explicit per-queue shedding/backpressure rules; never block enforcement on the network. |
| Configuration reload invalid | Reject candidate generation and keep last known-good generation active. |
| Daemon restarts/crashes | Service manager restarts it; sweeper and checkpoints recover missed work. |
| Update activation fails | External updater rolls back and suppresses the failed release. |
| IPC protocol mismatch | Negotiate supported version; client uses migration fallback or emits an actionable error. |

## Migration and rollout

### Phase 0: contracts and measurements

- Freeze golden compatibility fixtures for every supported agent hook and policy result.
- Record current hook latency distributions and startup cost.
- Turn collector source and delivery behavior into reusable conformance tests.
- Define the IPC schema, failure matrix, state schema, and signed release manifest.

### Phase 1: daemon-assisted enforcement

- Ship the service and hook IPC client behind an opt-in flag.
- Keep the current in-process evaluator as fallback.
- Compare decisions in shadow mode without allowing the shadow result to affect agents.
- Gate broader rollout on decision parity, deadline success, restart recovery, and resource use.

### Phase 2: collector convergence

- Move collector modules into the daemon and run the collector conformance suite unchanged where possible.
- Import `~/.agenteye/` pending data and checkpoints with a resumable migration.
- Prevent both old collector and new daemon from owning the same source/spool simultaneously using an ownership lock.
- Stop and disable the old collector only after the new daemon proves healthy.

### Phase 3: managed updates

- Start with manual `update --check` and explicit activation.
- Enable staged automatic downloads, then opt-in automatic activation.
- Promote unattended stable updates only after rollback drills succeed on every supported platform.

### Phase 4: v1 default

- Install `failproofaid` during setup and route hooks to it by default.
- Retain compatibility fallback for a defined deprecation window.
- Remove old collector service artifacts after migration and rollback windows expire.

## Acceptance criteria

- A warm builtin-policy hook request meets the agreed p95/p99 local latency budget under simultaneous backfill and upload load.
- Every current supported integration produces the same canonical decision and vendor response as the pre-daemon implementation for golden fixtures.
- JavaScript/TypeScript custom policies, including transitive local imports and package imports supported today, retain behavior.
- Killing the daemon, policy worker, uploader, or network independently demonstrates the failure behavior in this document.
- Collector conformance tests cover every migrated source, checkpoint, backfill, retry, quarantine, and health behavior.
- No acknowledged spool record is lost across process crash or machine reboot; replay is idempotent.
- Invalid policy reloads do not replace the last known-good generation.
- A deliberately broken update automatically returns to the prior healthy release on Linux, macOS, and Windows.
- The updater rejects tampered manifests, tampered artifacts, incompatible architectures, and irreversible state migrations.
- `failproofai health --json` can distinguish process liveness, enforcement readiness, source degradation, delivery backlog, and update failure.

## Open decisions

1. What are the p95/p99 enforcement latency targets and maximum vendor-specific deadlines?
2. After the migration window, should daemon unavailability default to fail-open globally, fail-closed globally, or remain a per-policy/integration setting?
3. Should the Rust daemon supervise Node.js, Bun, or an embedded JavaScript runtime for legacy JavaScript/TypeScript policies, and how will exact current import behavior be certified?
4. Which collector sources are required on the first v1.0.0 release day versus allowed to follow during the beta?
5. Is observability upload enabled by default after setup, or only after explicit AgentEye authentication/consent?
6. What spool quotas and queue priorities protect recent enforcement activity from large transcript backfills?
7. Which signing system and trust-root rotation process will protect the release manifest?
8. What idle-window and maximum-deferral policy should automatic activation use?
9. How long must the old evaluator, old collector state, and previous release remain available for rollback?
10. Does Windows v1.0.0 require a native Windows service, or is a scheduled task acceptable for the first release?
