# Daemon architecture

## Responsibilities

`failproofaid` is the Rust local enforcement plane. It owns:

- local IPC and request admission;
- desired hook registration, settings-file watching, and automatic reconciliation;
- event canonicalization and policy evaluation coordination;
- immutable local policy generations;
- local session-source indexing, checkpoints, and activity evidence;
- health, diagnostics, logs, and resource limits;
- signed harness schema-catalog refresh and atomic activation.

The user-facing `failproofai` CLI is a client of the daemon and service manager. Agent harnesses use the smaller hook client described in [Agent harness integration](./02-harness-integration.md).

## Execution lanes

The daemon separates work into independently bounded lanes:

1. **Enforcement** — reserved workers, strict deadlines, and no network dependency.
2. **Indexing** — local session-source watching, transcript parsing, and checkpointing for activity, audits, and the dashboard.
3. **Maintenance** — configuration reload, health snapshots, cleanup, and harness schema-catalog refresh.

Phase 2 adds delivery and management lanes under the same per-lane bounds. The lane structure exists now so that adding them is a registration rather than a re-architecture, and so nothing in Phase 1 assumes it is the only background work.

Maintenance includes one adapter-aware hook reconciler per enabled harness. Watcher activity and repair work have bounded queues and cannot consume enforcement capacity. The persisted desired registration, not the current mutable harness file, is authoritative until an explicit disable or uninstall commits a new desired state.

Each lane has its own queue, concurrency, memory, and time limits. Background work cannot consume enforcement's reserved capacity. Overload is reported per lane rather than causing unbounded queue growth.

## Local IPC

- The daemon listens on a Unix domain socket reachable by enrolled users, whose parent directory is owned by the service account or root, so no enrolled user can unlink it and bind a substitute; every request is authorized from operating-system peer credentials.
- The daemon does not expose its control protocol over TCP, including loopback.
- Messages are length-prefixed and versioned rather than newline-delimited.
- Peer identity is mandatory, and maps to an isolated per-UID policy, session, activity, quota, and administrative-authorization context.
- Hook, query, and administrative operations are distinct protocol operation classes, each with its own authorization rule.

Windows transport and service integration are deferred beyond Phase 1. The framed protocol remains transport-independent so a later named-pipe implementation does not change request semantics.

Initial operations are `Ping`, `EvaluateHook`, `Status`, `Reload`, and the `Query` set. Administrative calls can gain stronger authorization later without changing the hook request.

| Class | Operations | Authorized for |
|---|---|---|
| Hook | `EvaluateHook` | any enrolled UID, evaluated in its own context |
| Query | activity, sessions, transcript access, policy list with source/tier/revision, health, generation identity | any enrolled UID, **results filtered to that UID by peer credential** |
| Administrative | admit or remove protected revisions, stop, reconfigure, mutate the active protected generation | root peer, or an OS-backed administrator authorization |

`Query` exists because the local dashboard and CLI need read access that is scoped without inventing a second identity mechanism. Filtering happens in the daemon from the peer credential, never from a field the caller supplies, so a client cannot widen its own view by asking differently. The daemon does not distinguish a dashboard client from any other — see [Local dashboard](./01-user-experience.md#local-dashboard) for why the dashboard is spawned by the CLI as the requesting user rather than by the daemon.

## Policy generations

The daemon evaluates each request against an immutable generation. A generation contains resolved configuration, policy artifacts, policy metadata, runtime compatibility, and content identity.

A local reload constructs a candidate away from the active generation:

1. resolve inputs and immutable artifacts;
2. verify schema, digest, runtime compatibility, and policy target/scope for every source;
3. load and initialize policies within bounds;
4. reject duplicates and invalid registrations;
5. atomically publish the complete generation.

Every Phase 1 input is locally authored — builtin, explicit, or convention — and requires no signature or enrollment. A source's content digest identifies the generation for cache invalidation and decision evidence; it is not treated as publisher authentication. The candidate-construction sequence has a deliberate seam at step 2 so that a source needing publisher, binding, or replay verification can be added without changing how a generation is published.

In-flight requests finish on the generation with which they started. A failed candidate never partially replaces active state. The last known-good generation is persisted and loaded before accepting hook traffic after restart.

## Policy runtime boundary

Rust is the authoritative implementation language for the daemon and new core subsystems.

Existing local custom policies are JavaScript or TypeScript and may use transitive local and package imports. v1 cannot silently narrow that contract. A supervised, long-lived policy worker behind an internal runtime interface is the migration design. It is shipped, versioned, monitored, and terminated with the daemon; users do not manage it as a separate service.

Locally authored policy is a first-class source, not a compatibility shim. Builtins, explicit custom files, project/user convention directories, and existing configuration scopes produce the active generation without authentication.

The existence of this JavaScript worker is not a general licence to execute policy from any origin. It admits code the machine's own users authored and can already run as themselves. Admitting policy from a remote origin is a separate problem with separate requirements, and it is deliberately not solved by reusing this worker.

Each evaluation has a deadline and resource budget. Repeated timeout, crash, or memory failure trips a circuit breaker for the offending generation or artifact and records structured diagnostics.

### Execution tiers

A verdict computed in a process owned by the requesting user cannot be trusted by a privileged daemon: that user can `ptrace` the process, preload into it, or substitute the interpreter. But a policy that inspects the repository, the diff, or the transcript must run with that user's file access. The two requirements are irreconcilable in one process, so evaluation is split by **declared capability**, not by who authored the policy:

| Tier | Process | Filesystem, subprocess, network | Verdict integrity |
|---|---|---|---|
| `sealed` | the daemon's pinned runtime, running as the service account | denied | unforgeable |
| `user-context` | a worker running as the requesting UID | granted, bounded by that user's own authority | forgeable by that user |

The tier is derived at admission and cannot be overridden by an author or by configuration. This is a statement about what is physically achievable, not a configuration knob.

It is derived from the policy's **resolved import graph**, not from a manifest the author writes. A self-declared capability set is not a trust boundary, because the party declaring it is the party the boundary exists to constrain. Declaration remains useful as a routing hint and as diagnostic output, and a mismatch between it and the resolved graph is itself an admission finding — but it never grants anything.

Runtime enforcement is the second, independent mechanism. The `sealed` context is deny-by-default: it exposes no filesystem, process, or network bindings, so a policy that under-declares does not escape into a privileged tier, it fails inside the tier it was routed to. Repeated failures trip the circuit breaker for that artifact and surface in health rather than degrading silently to an allow.

`sealed` requires a runtime and policy store outside the requesting user's authority, which the managed install always provides, so the tier is unconditional in Phase 1. The deferred unprivileged scope is the one place it would disappear — see [deferred scopes](./04-service-and-updates.md#deferred-scopes).

The `sealed` tier covers more than it first appears. Canonical tool name, command string, file path, and old/new content already arrive in the request envelope, so payload-only builtins evaluate there and produce verdicts an agent cannot forge even with full authority over its own user. A `user-context` policy remains useful because results combine as `deny` over `instruct` over `allow`: it can only tighten, so a forged `allow` from it changes nothing, and a forged `deny` harms only the user who forged it.

Which mechanism launches the `user-context` worker — a per-user service started by that user's own service manager, a helper, or the hook client — is an operational choice, not a security one. Every option terminates in a process the requesting user can already `ptrace`, so the integrity properties are identical and the decision should be made on supervision and cold-start latency.

### Pinned policy runtime

The `sealed` tier must never execute an interpreter the requesting user can write to. Node commonly resolves through nvm, fnm, or volta into a path under the user's home, which is both user-writable and frequently unreadable by a service account; executing it would silently forfeit every guarantee the tier exists to provide.

The daemon therefore uses a runtime shipped with the native release and installed root-owned — read-only to the service account it runs as — alongside the binaries, referenced by an absolute path recorded at install time. It resolves nothing through `PATH`. Because promotion into the protected store already compiles policies, a runtime that is also a bundler removes a separate toolchain from the release.

This guarantee is a property of the privileged install layout, not of the daemon or of the shipped artifact.

Environment is constructed, never inherited. The hook client's environment originates in the agent's process, which makes `NODE_OPTIONS`, `NODE_PATH`, preload flags, and library-search variables user-controlled injection vectors into anything the daemon spawns. The service definition sets a fixed `PATH`, and worker spawn passes an explicit allowlisted environment.

### Dependencies and admission

Protected policies are compiled, not copied. Admission resolves the full import graph and inlines it into a single content-addressed artifact, so one digest covers the policy and every dependency, nothing is resolved from a mutable path at evaluation time, and the audit record identifies exactly what ran. That same resolved graph is what determines the execution tier.

Native addons are refused from the `sealed` tier outright. They cannot be inlined, and pinning a digest only prevents substitution — it places no constraint on what the loaded native code then does with the service account's file, process, and network access, which would contradict the tier's denied capabilities and void its verdict claim. A policy requiring a native addon is admitted to `user-context`, where it runs with the requesting user's authority and its verdict carries no integrity claim to begin with.

Authoring is unprivileged and unconstrained — the ordinary package-manager workflow, iterated in the `user-context` tier. Promotion is the privileged step, and it is where the graph is frozen.

### Enforcement performs no unbounded I/O

A policy that needs remote state — pull-request status, CI results, an organization directory — must not fetch it during evaluation. Enforcement runs under a hard monotonic deadline, and a synchronous network call inside a hook makes a third party's availability a precondition for the user running a command.

Remote state is fetched by the maintenance lane on its own schedule into a local cache with an explicit freshness bound, and the policy reads that cache synchronously. A policy reading stale or absent cached state must be able to distinguish it from a negative result, and the freshness bound is recorded with the decision. The rule is a property of the enforcement deadline, not of where the data comes from, so it holds identically for any lane added later.

## Evaluation path

For an accepted hook request, the daemon:

1. validates the envelope and remaining deadline;
2. canonicalizes the native harness event;
3. resolves machine, agent, project, session, event, and tool targeting context;
4. selects an immutable active generation;
5. finds all matching policies and their effects;
6. evaluates matching policy locally within the remaining deadline, routing each one to its admitted execution tier;
7. combines results deterministically (`deny` over `instruct` over `allow`, absent an authorized suppression), so a `user-context` result can tighten the outcome but never relax a `sealed` one;
8. writes decision evidence asynchronously to the durable local activity store;
9. returns a canonical result and decision ID.

The response never waits for evidence persistence, transcript indexing, or catalog refresh.

### Forward compatibility

Two later changes are anticipated and neither may require harnesses to be reintegrated: Phase 2 adds centrally assigned policy evaluated locally, and a version after it may move some or all evaluation off the machine.

What Phase 1 does to keep both open is limited to contract shape, not mechanism. The harness contract terminates at `failproofaid`. Policy decisions use a location-independent canonical request/result model, so the same request is answerable by a local worker or by something further away. Deadlines are end-to-end rather than per-hop. Decision evidence carries stable request, policy, generation, and session identity, so a decision remains attributable to what produced it once more than one source exists.

No Phase 1 configuration key, remote-decision client, fallback mode, or user-visible setting is added for either. A seam is a shape the contract already has; it is not a dormant feature.

## Configuration and state

The canonical user root is `~/.failproofai/`, overridable for tests:

```text
~/.failproofai/
  config.json
  policies/
  state/
    policy-generations/
    checkpoints/
    activity/
    health.json
    harness-schemas/
  logs/
```

Phase 1 stores no secret anywhere in this tree, because nothing in it authenticates to a remote service.

Machine state uses platform system locations. On Linux, executables and the pinned runtime install root-owned under `/opt/failproofai/versions/<version>/`; configuration, the content-addressed policy store, and mutable state live under `/var/lib/failproofai/`; the runtime socket directory is `/run/failproofai/`. macOS uses platform-appropriate `/Library` locations with the same logical layout.

Ownership within that layout is split by writer. Anything whose integrity a decision depends on — executables, the pinned runtime, the protected policy store, the active schema catalog, and machine configuration — is root-owned and read-only to the service account, written only by the privileged installer during an elevated operation. The service account owns only what the daemon must write at runtime: checkpoints, activity, per-user state, health, logs, and the socket directory. The daemon consequently cannot rewrite the binary it restarts from, the runtime it evaluates in, or the policy revision it evaluates — a compromised daemon can corrupt its own telemetry and nothing above it.

Per-user material beneath machine state is keyed by numeric UID, never an untrusted username, and remains inaccessible to other users. Exact paths are part of the platform packaging contract.

The `~/.failproofai/` root above is where a user authors and discovers their own policies. Those sources are **additive, non-authoritative inputs**: they never enter the protected generation, always route to the `user-context` tier, and can only tighten a result. Replacing the directory therefore changes only that user's own additional restrictions — it cannot alter, disable, or weaken a protected revision, and the protected generation loads identically whether the directory is present, absent, or substituted.

That is why the installation keeps nothing it *depends* on beneath a user-owned root. Delete and rename permission derive from the parent directory, so a user who owns their home can rename an unwritable `~/.failproofai` aside and supply a replacement they own — ownership and mode on the directory itself prevent nothing, and a sticky bit on the home directory is removable by the same user. Protected artifacts are therefore reachable only through paths whose every component is owned by the service account or root.

Configuration is schema-versioned and written transactionally. File notifications prompt reload, while periodic reconciliation is the correctness backstop. Project policy caches are bounded by memory and entry count and invalidated by resolved input changes.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain verified generation data, apply configured event failure behavior, keep indexing running. |
| Policy hangs | Enforce deadline, trip its circuit breaker after repeated failures, keep IPC responsive. |
| One source parser fails | Degrade that source without stopping other sources or enforcement. |
| Invalid configuration | Reject candidate and retain active generation. |
| Activity store reaches quota | Report degradation and apply an explicit retention rule; never block a decision on it. |
| Daemon crashes | Service manager restarts it; persisted generations, checkpoints, and activity records recover work. |

## Health

Health is a structured, versioned snapshot covering IPC readiness, enforcement latency and queue depth, local policy generation and reload state, session-source progress, activity-store age and size, resource pressure, and harness/schema compatibility state. The snapshot is versioned so Phase 2 adds subsystems to it rather than reshaping it.

Logs are structured, correlated by request/catalog-generation ID, rotated, and size-bounded. Sensitive hook payloads and transcript contents are excluded by default.
