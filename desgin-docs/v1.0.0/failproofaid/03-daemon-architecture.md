# Daemon architecture

## Responsibilities

`failproofaid` is the Rust local enforcement plane. It owns:

- local IPC and request admission;
- event canonicalization and policy evaluation coordination;
- immutable local and cloud policy generations;
- collector source workers, checkpoints, spooling, and delivery;
- cloud desired-state reconciliation;
- health, diagnostics, logs, and resource limits;
- update discovery and staging, but not activation.

The user-facing `failproofai` CLI is a client of the daemon and service manager. Agent harnesses use the smaller hook client described in [Agent harness integration](./02-harness-integration.md).

## Execution lanes

The daemon separates work into independently bounded lanes:

1. **Enforcement** — reserved workers and strict deadlines across configurable local, cloud, and hybrid evaluators.
2. **Collection** — source watching, transcript parsing, checkpointing, and backfill.
3. **Delivery** — batching, upload, retry, and quarantine.
4. **Management** — cloud authentication, desired-state reconciliation, verification, and acknowledgement.
5. **Maintenance** — configuration reload, health snapshots, cleanup, and update discovery.

Each lane has its own queue, concurrency, memory, and time limits. Background work cannot consume enforcement's reserved capacity. Overload is reported per lane rather than causing unbounded queue growth.

## Local IPC

- Linux and macOS use an owner-only Unix domain socket under the user's runtime directory.
- Windows uses a named pipe restricted to the installing user's security identifier.
- The daemon does not expose its control protocol over TCP, including loopback.
- Messages are length-prefixed and versioned rather than newline-delimited.
- Peer identity is verified where supported.
- Hook and administrative operations are distinct protocol operations.

Initial operations are `Ping`, `EvaluateHook`, `Status`, `Reload`, and `Flush`. Administrative calls can gain stronger authorization later without changing the hook request.

## Policy generations

The daemon evaluates each request against an immutable generation. A generation contains resolved configuration, policy artifacts, assignment metadata, runtime compatibility, and content identity.

A reload or cloud reconciliation constructs a candidate away from the active generation:

1. resolve inputs and immutable artifacts;
2. verify schema, signature, digest, compatibility, and target binding;
3. load and initialize policies within bounds;
4. reject duplicates and invalid registrations;
5. atomically publish the complete generation.

In-flight requests finish on the generation with which they started. A failed candidate never partially replaces active state. The last known-good generation is persisted and loaded before accepting hook traffic after restart.

## Policy runtime boundary

Rust is the authoritative implementation language for the daemon and new core subsystems.

Existing local custom policies are JavaScript or TypeScript and may use transitive local and package imports. v1 cannot silently narrow that contract. A supervised, long-lived policy worker behind an internal runtime interface is the migration design. It is shipped, versioned, monitored, and terminated with the daemon; users do not manage it as a separate service.

Cloud-created policy requires a deterministic, capability-limited representation or sandbox. The existence of a legacy JavaScript worker does not authorize the cloud to send arbitrary JavaScript with the user's filesystem, environment, process, or network authority.

Each evaluation has a deadline and resource budget. Repeated timeout, crash, or memory failure trips a circuit breaker for the offending generation or artifact and records structured diagnostics.

## Evaluation path

For an accepted hook request, the daemon:

1. validates the envelope and remaining deadline;
2. canonicalizes the native harness event;
3. resolves machine, agent, project, session, event, and tool targeting context;
4. selects an immutable active generation;
5. finds all matching policies and assignment effects;
6. routes each assignment to its declared local, cloud, or hybrid evaluator and evaluates it within the remaining deadline;
7. combines results deterministically (`deny` over `instruct` over `allow`, absent an authorized suppression);
8. writes decision evidence asynchronously to the durable activity spool;
9. returns a canonical result and decision ID.

Cloud evaluation may wait for a decision service, but only inside the hook's original absolute deadline. The response never waits for asynchronous policy acknowledgement, event upload, transcript processing, or update work.

### Decision routing evolution

The internal evaluator interface supports three configured locations:

- `local`: evaluate a verified artifact in the daemon policy runtime;
- `cloud`: send canonical, policy-scoped inputs to the decision service and use its authenticated response;
- `hybrid`: evaluate local mandatory/fallback policy and combine it with a cloud result under assignment rules.

Evaluation location is resolved from the active assignment generation. Organization policy defines permitted modes and defaults; a narrower assignment may override the default only when authorized. Location changes create a new immutable assignment revision and are visible in decision evidence.

The cloud client maintains a warm authenticated HTTP/2 or equivalent connection, enforces request/response size limits, sends only fields declared by the policy, and consumes no more than the remaining hook budget. It returns decision ID, policy and assignment revisions, result, explanation, and timing so local activity and AgentEye records retain end-to-end attribution.

Cloud timeout and transport failure are policy states, not generic exceptions. Each cloud/hybrid assignment declares an unavailable-service action: named local fallback, explicitly safe cached result, fail open, or fail closed. Caching is allowed only for policies whose inputs and validity contract make reuse safe; arbitrary prior decisions are never replayed merely because the cloud is unavailable.

## Configuration and state

The canonical user root is `~/.failproofai/`, overridable for tests and managed deployments:

```text
~/.failproofai/
  config.json
  credentials.json
  policies/
  state/
    policy-generations/
    checkpoints/
    activity/
    spool/
    failed/
    health.json
    updates/
  logs/
```

Credentials use the operating-system credential store where practical; an owner-only file is the portability fallback. Secrets never appear in service definitions or routine process arguments.

Configuration is schema-versioned and written transactionally. File notifications prompt reload, while periodic reconciliation is the correctness backstop. Project policy caches are bounded by memory and entry count and invalidated by resolved input changes.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain verified generation data, apply configured event failure behavior, keep collection running. |
| Policy hangs | Enforce deadline, trip its circuit breaker after repeated failures, keep IPC responsive. |
| Cloud management unavailable | Continue last known-good policy assignments; report staleness. |
| Cloud decision service unavailable | Apply the assignment's explicit bounded fallback and record the effective action. |
| Backend unavailable | Continue enforcement; spool delivery data and retry. |
| One source parser fails | Degrade that source without stopping other sources or enforcement. |
| Invalid configuration | Reject candidate and retain active generation. |
| Spool reaches quota | Report degradation and apply explicit queue policy; never wait on network in enforcement. |
| Daemon crashes | Service manager restarts it; persisted generations, checkpoints, and spool recover work. |

## Health

Health is a structured, versioned snapshot covering IPC readiness, enforcement latency and queue depth, policy generation and reload state, cloud freshness, source progress, spool age and size, delivery acknowledgements, quarantined data, resource pressure, and update state.

Logs are structured, correlated by request/batch/update ID, rotated, and size-bounded. Sensitive hook payloads and transcript contents are excluded by default.
