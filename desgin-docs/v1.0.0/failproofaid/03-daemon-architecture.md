# Daemon architecture

## Responsibilities

`failproofaid` is the Rust local enforcement plane. It owns:

- local IPC and request admission;
- desired hook registration, settings-file watching, and automatic reconciliation;
- event canonicalization and policy evaluation coordination;
- immutable local policy generations and optional connected-tier cloud assignment generations;
- collector source workers, checkpoints, spooling, and delivery;
- optional cloud desired-state reconciliation;
- health, diagnostics, logs, and resource limits;
- signed harness schema-catalog refresh and atomic activation.

The user-facing `failproofai` CLI is a client of the daemon and service manager. Agent harnesses use the smaller hook client described in [Agent harness integration](./02-harness-integration.md).

## Execution lanes

The daemon separates work into independently bounded lanes:

1. **Enforcement** — reserved workers, strict deadlines, and no network dependency.
2. **Collection** — source watching, transcript parsing, checkpointing, and backfill.
3. **Delivery** — batching, upload, retry, and quarantine.
4. **Management** — when connected, cloud authentication, desired-state reconciliation, verification, and acknowledgement; otherwise dormant.
5. **Maintenance** — configuration reload, health snapshots, cleanup, and harness schema-catalog refresh.

Maintenance includes one adapter-aware hook reconciler per enabled harness. Watcher activity and repair work have bounded queues and cannot consume enforcement capacity. The persisted desired registration, not the current mutable harness file, is authoritative until an explicit disable or uninstall commits a new desired state.

Each lane has its own queue, concurrency, memory, and time limits. Background work cannot consume enforcement's reserved capacity. Overload is reported per lane rather than causing unbounded queue growth.

## Local IPC

- User scope uses an owner-only Unix domain socket under the user's runtime directory. Managed and system scope use a socket reachable by enrolled users whose parent directory is owned by the service account or root, so no enrolled user can unlink it and bind a substitute; every request is authorized from operating-system peer credentials.
- The daemon does not expose its control protocol over TCP, including loopback.
- Messages are length-prefixed and versioned rather than newline-delimited.
- Peer identity is mandatory. Managed and system scope map it to an isolated per-UID policy, session, spool, quota, and administrative-authorization context.
- Hook and administrative operations are distinct protocol operations.

Windows transport and service integration are deferred beyond v1.0.0. The framed protocol remains transport-independent so a later named-pipe implementation does not change request semantics.

Initial operations are `Ping`, `EvaluateHook`, `Status`, `Reload`, and `Flush`. Administrative calls can gain stronger authorization later without changing the hook request.

## Policy generations

The daemon evaluates each request against an immutable generation. A generation contains resolved configuration, policy artifacts, assignment metadata, runtime compatibility, and content identity.

A local reload or optional cloud reconciliation constructs a candidate away from the active generation:

1. resolve inputs and immutable artifacts;
2. verify schema, digest, runtime compatibility, and local-policy target/scope for every source;
3. for cloud-provenance inputs only, additionally verify publisher signature, organization/machine binding, assignment validity, and replay protection;
4. load and initialize policies within bounds;
5. reject duplicates and invalid registrations;
6. atomically publish the complete generation.

User-authored local, explicit, and convention policies do not require a cloud signature or organization enrollment. Their content digest identifies the generation for cache invalidation and decision evidence; it is not treated as publisher authentication.

In-flight requests finish on the generation with which they started. A failed candidate never partially replaces active state. The last known-good generation is persisted and loaded before accepting hook traffic after restart.

## Policy runtime boundary

Rust is the authoritative implementation language for the daemon and new core subsystems.

Existing local custom policies are JavaScript or TypeScript and may use transitive local and package imports. v1 cannot silently narrow that contract. A supervised, long-lived policy worker behind an internal runtime interface is the migration design. It is shipped, versioned, monitored, and terminated with the daemon; users do not manage it as a separate service.

Standalone OSS policy is a first-class source, not a fallback for a missing cloud connection. Builtins, explicit custom files, project/user convention directories, and existing configuration scopes produce the active local generation without authentication or enrollment.

Cloud-created policy requires a deterministic, capability-limited representation or sandbox. The existence of a legacy JavaScript worker does not authorize the cloud to send arbitrary JavaScript with the user's filesystem, environment, process, or network authority.

Each evaluation has a deadline and resource budget. Repeated timeout, crash, or memory failure trips a circuit breaker for the offending generation or artifact and records structured diagnostics.

### Execution tiers

A verdict computed in a process owned by the requesting user cannot be trusted by a privileged daemon: that user can `ptrace` the process, preload into it, or substitute the interpreter. But a policy that inspects the repository, the diff, or the transcript must run with that user's file access. The two requirements are irreconcilable in one process, so evaluation is split by **declared capability**, not by who authored the policy:

| Tier | Process | Filesystem, subprocess, network | Verdict integrity |
|---|---|---|---|
| `sealed` | the daemon's pinned runtime, running as the service account | denied | unforgeable |
| `user-context` | a worker running as the requesting UID | granted, bounded by that user's own authority | forgeable by that user |

The tier is derived at admission from the capabilities a policy declares and cannot be overridden by its author or by an assignment. This is a statement about what is physically achievable, not a configuration knob.

The `sealed` tier covers more than it first appears. Canonical tool name, command string, file path, and old/new content already arrive in the request envelope, so payload-only builtins evaluate there and produce verdicts an agent cannot forge even with full authority over its own user. A `user-context` policy remains useful because results combine as `deny` over `instruct` over `allow`: it can only tighten, so a forged `allow` from it changes nothing, and a forged `deny` harms only the user who forged it.

Which mechanism launches the `user-context` worker — a per-user service started by that user's own service manager, a helper, or the hook client — is an operational choice, not a security one. Every option terminates in a process the requesting user can already `ptrace`, so the integrity properties are identical and the decision should be made on supervision and cold-start latency.

### Pinned policy runtime

The `sealed` tier must never execute an interpreter the requesting user can write to. Node commonly resolves through nvm, fnm, or volta into a path under the user's home, which is both user-writable and frequently unreadable by a service account; executing it would silently forfeit every guarantee the tier exists to provide.

The daemon therefore uses a runtime shipped with the native release and installed root-owned alongside the binaries, referenced by an absolute path recorded at install time. It resolves nothing through `PATH`. Because promotion into the protected store already compiles policies, a runtime that is also a bundler removes a separate toolchain from the release.

Environment is constructed, never inherited. The hook client's environment originates in the agent's process, which makes `NODE_OPTIONS`, `NODE_PATH`, preload flags, and library-search variables user-controlled injection vectors into anything the daemon spawns. The service definition sets a fixed `PATH`, and worker spawn passes an explicit allowlisted environment.

### Dependencies and admission

Protected policies are compiled, not copied. Admission resolves the full import graph and inlines it into a single content-addressed artifact, so one digest covers the policy and every dependency, nothing is resolved from a mutable path at evaluation time, and the audit record identifies exactly what ran. Native addons cannot be inlined; admission refuses them or stores them alongside with pinned digests.

Authoring is unprivileged and unconstrained — the ordinary package-manager workflow, iterated in the `user-context` tier. Promotion is the privileged step, and it is where the graph is frozen.

### Enforcement performs no unbounded I/O

A policy that needs remote state — pull-request status, CI results, an organization directory — must not fetch it during evaluation. Enforcement runs under a hard monotonic deadline, and a synchronous network call inside a hook makes a third party's availability a precondition for the user running a command.

Remote state is fetched by the collection lane on its own schedule into a local cache with an explicit freshness bound, and the policy reads that cache synchronously. A policy reading stale or absent cached state must be able to distinguish it from a negative result, and the freshness bound is recorded with the decision.

## Evaluation path

For an accepted hook request, the daemon:

1. validates the envelope and remaining deadline;
2. canonicalizes the native harness event;
3. resolves machine, agent, project, session, event, and tool targeting context;
4. selects an immutable active generation;
5. finds all matching policies and assignment effects;
6. evaluates matching policy locally within the remaining deadline, routing each one to its admitted execution tier;
7. combines results deterministically (`deny` over `instruct` over `allow`, absent an authorized suppression), so a `user-context` result can tighten the outcome but never relax a `sealed` one;
8. writes decision evidence asynchronously to the durable activity spool;
9. returns a canonical result and decision ID.

The response never waits for cloud acknowledgement, event upload, transcript processing, or catalog refresh.

### Future cloud evaluation compatibility

Cloud evaluation is not implemented or user-configurable in v1.0.0. A later version is expected to move some or all policy evaluation into the FailproofAI cloud.

To keep that migration possible, the harness contract terminates at `failproofaid`, policy decisions use a location-independent canonical request/result model, deadlines are end-to-end, and decision evidence carries stable request, policy, assignment, and session identity. No v1.0.0 configuration, cloud-decision client, fallback mode, or user interface is added for the future design.

## Configuration and state

The canonical user root is `~/.failproofai/`, overridable for tests:

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
    harness-schemas/
  logs/
```

Credentials use the operating-system credential store where practical; an owner-only file is the portability fallback. Secrets never appear in service definitions or routine process arguments.

Managed and system scope use platform system locations. On Linux, executables and the pinned runtime install root-owned under `/opt/failproofai/versions/<version>/`; configuration, the content-addressed policy store, and mutable state live under `/var/lib/failproofai/`; the runtime socket directory is `/run/failproofai/`. System scope additionally places root-owned configuration under `/etc/failproofai`. macOS uses platform-appropriate `/Library` locations with the same logical layout. Everything except the executables is owned by the service account in managed scope and by root in system scope; the executables are root-owned in both, so a compromised daemon cannot rewrite the binary it will be restarted from.

Per-user material beneath managed or system state is keyed by numeric UID, never an untrusted username, and remains inaccessible to other users. Exact paths are part of the platform packaging contract.

The canonical `~/.failproofai/` root above is the user-scope layout and the location of user-authored source policies in every scope. It is deliberately **not** where managed or system scope keeps anything enforcement depends on. Delete and rename permission derive from the parent directory, so a user who owns their home can rename an unwritable `~/.failproofai` aside and supply a replacement they own — ownership and mode on the directory itself prevent nothing, and a sticky bit on the home directory is removable by the same user. Protected artifacts are therefore reachable only through paths whose every component is owned by the service account or root.

Configuration is schema-versioned and written transactionally. File notifications prompt reload, while periodic reconciliation is the correctness backstop. Project policy caches are bounded by memory and entry count and invalidated by resolved input changes.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain verified generation data, apply configured event failure behavior, keep collection running. |
| Policy hangs | Enforce deadline, trip its circuit breaker after repeated failures, keep IPC responsive. |
| Cloud management unavailable | Continue last known-good policy assignments; report staleness. |
| Backend unavailable | Continue enforcement; spool delivery data and retry. |
| One source parser fails | Degrade that source without stopping other sources or enforcement. |
| Invalid configuration | Reject candidate and retain active generation. |
| Spool reaches quota | Report degradation and apply explicit queue policy; never wait on network in enforcement. |
| Daemon crashes | Service manager restarts it; persisted generations, checkpoints, and spool recover work. |

## Health

Health is a structured, versioned snapshot covering IPC readiness, enforcement latency and queue depth, local policy generation and reload state, optional cloud freshness, source progress, spool age and size, delivery acknowledgements, quarantined data, resource pressure, and harness/schema compatibility state. Cloud health is `not_configured` for standalone OSS installs.

Logs are structured, correlated by request/batch/catalog-generation ID, rotated, and size-bounded. Sensitive hook payloads and transcript contents are excluded by default.
