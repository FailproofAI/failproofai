# Daemon architecture

## Responsibilities

`failproofaid` is the Rust local enforcement plane. It owns:

- local IPC and request admission;
- desired hook registration, settings-file watching, and automatic reconciliation;
- event canonicalization and policy evaluation coordination;
- immutable local policy generations;
- collector source workers, checkpoints, spooling, and delivery;
- health, diagnostics, logs, and resource limits;
- signed harness schema-catalog refresh and atomic activation.

The user-facing `failproofai` CLI is a client of the daemon and service manager. Agent harnesses use the smaller hook client described in [Agent harness integration](./02-harness-integration.md).

## Execution lanes

The daemon separates work into independently bounded lanes:

1. **Enforcement** — reserved workers, strict deadlines, and no network dependency.
2. **Collection** — source watching, transcript parsing, checkpointing, and backfill.
3. **Delivery** — batching, upload, retry, and quarantine.
4. **Maintenance** — configuration reload, health snapshots, cleanup, and harness schema-catalog refresh.

Phase 2 adds one more lane — management, for cloud desired-state reconciliation — under the same per-lane bounds. The lane structure exists now so adding it is a registration rather than a re-architecture.

Maintenance includes one adapter-aware hook reconciler per enabled harness. Watcher activity and repair work have bounded queues and cannot consume enforcement capacity. The persisted desired registration, not the current mutable harness file, is authoritative until an explicit disable or uninstall commits a new desired state.

Each lane has its own queue, concurrency, memory, and time limits. Background work cannot consume enforcement's reserved capacity. Overload is reported per lane rather than causing unbounded queue growth.

## Local IPC

- The daemon listens on a Unix domain socket reachable by enrolled users, whose parent directory is owned by the service account or root, so no enrolled user can unlink it and bind a substitute; every request is authorized from operating-system peer credentials.
- The daemon does not expose its control protocol over TCP, including loopback.
- Messages are length-prefixed and versioned rather than newline-delimited.
- Peer identity is mandatory, and maps to an isolated per-UID policy, session, spool, quota, and administrative-authorization context.
- Hook, query, and administrative operations are distinct protocol operation classes, each with its own authorization rule.

Windows transport and service integration are deferred beyond Phase 1. The framed protocol remains transport-independent so a later named-pipe implementation does not change request semantics.

Initial operations are `Ping`, `EvaluateHook`, `Status`, `Reload`, `Flush`, and the `Query` set. `Ping` and `EvaluateHook` are implemented; the rest land with the stages that need them, as new operation variants rather than wire changes. Administrative calls can gain stronger authorization later without changing the hook request. The framing, handshake, and envelope as implemented are specified in [`crates/PROTOCOL.md`](../../../crates/PROTOCOL.md), which the daemon, the `fpai-ipc` crate, and the TypeScript hook client are each written against independently — so anything left ambiguous there becomes a silent interoperability bug rather than a loud one.

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

### Protected enablement

A policy that is admitted but not enabled never runs, so the enabled set is part of the protected surface or none of the rest of it matters. Enablement in the current product lives in the merge of `.failproofai/policies-config.json` across project, local, and user scope — every one of them user-writable. If the protected generation took its enabled set from there, an agent holding its user's authority would delete `block-sudo` from a JSON array and the unforgeable verdict would simply never be computed. No tier boundary is crossed and nothing is forged; the policy is not reached.

The pinned enabled set therefore comes from a root-owned `machine.json` beside machine configuration, read-only to the service account and written only by an elevated CLI operation. Disabling a pinned policy or changing its parameters requires `sudo` and produces an audit record, exactly as removing an admitted revision does.

The user's own configuration survives unchanged and still needs no elevation, but it becomes **additive-only**: it may enable policies `machine.json` does not name, and set parameters for policies it itself enabled; it may not disable, weaken, or reparameterize a pinned entry. That is the same shape as every other user-owned input here — it can tighten and cannot relax — which is what lets convention discovery and unprivileged authoring keep working while the pinned set stays outside the agent's reach.

**This does not ship yet.** The daemon evaluates the enabled set the client resolves from its merged configuration and sends in the request, so today that set is client-asserted, carrying exactly the trust the file the legacy path already reads carries — no more, and no less. It is deliberately the client's set rather than a default list of the daemon's own: a daemon-supplied list silently dropped every custom, convention, and non-default builtin policy the moment the daemon answered, which is a far worse failure than the one `machine.json` fixes. Until `machine.json` lands with the privileged install, the `sealed` tier's claim covers *evaluation* — the verdict cannot be forged — and not yet *selection*, which an agent can still change, and health, `policies explain`, and setup must not present the stronger claim before it is true.

## Policy runtime boundary

Rust is the authoritative implementation language for the daemon and new core subsystems.

Existing local custom policies are JavaScript or TypeScript and may use transitive local and package imports. v1 cannot silently narrow that contract. A supervised, long-lived policy worker behind an internal runtime interface is the migration design. It is shipped, versioned, monitored, and terminated with the daemon; users do not manage it as a separate service.

Locally authored policy is a first-class source, not a compatibility shim. Builtins, explicit custom files, project/user convention directories, and existing configuration scopes produce the active generation without authentication.

The existence of this JavaScript worker is not a general licence to execute policy from any origin. It admits code the machine's own users authored and can already run as themselves. Admitting policy from a remote origin is a separate problem with separate requirements, and it is deliberately not solved by reusing this worker.

Each evaluation has a deadline and resource budget. Repeated timeout, crash, or memory failure trips a circuit breaker for the offending generation or artifact and records structured diagnostics.

**A deadline does not enforce itself.** A policy body is synchronous JavaScript: once the runtime enters it, nothing else on that thread runs, so a deadline checked between microtasks is checked exactly never for the case that matters. The case is neither hypothetical nor exotic — `block-curl-pipe-sh` is default-enabled and sealed, and its regex backtracks quadratically on a repeated `curl ` prefix. Measured against a 200 ms deadline with no out-of-band interrupt, 40 KB of command took 7.1 seconds and 80 KB took 30, each returning a verdict rather than a deadline miss, and a request at the frame cap extrapolates past an hour — one such request wedges the single enforcement lane for every user on the machine, and two other default-enabled policies have the same regex shape. Enforcement therefore requires a watchdog that arms before the runtime is entered and disarms after it returns, setting a flag the runtime polls and unwinds on. Because that unwind arrives as an ordinary exception, the catch sites must tell it apart from a policy that genuinely threw; otherwise a merely slow policy trips the circuit breaker meant for a broken one. The same reasoning applies to the memory ceiling, which is the mechanism the interrupt cannot substitute for: an interrupt cannot stop a single allocation that is too large, and a ceiling cannot stop a tight loop.

### Execution tiers

A verdict computed in a process owned by the requesting user cannot be trusted by a privileged daemon: that user can `ptrace` the process, preload into it, or substitute the interpreter. But a policy that inspects the repository, the diff, or the transcript must run with that user's file access. The two requirements are irreconcilable in one process, so evaluation is split by **declared capability**, not by who authored the policy:

| Tier | Process | Filesystem, subprocess, network | Verdict integrity |
|---|---|---|---|
| `sealed` | the daemon's own sealed runtime, running as the service account | denied | unforgeable |
| `user-context` | a worker running as the requesting UID | granted, bounded by that user's own authority | forgeable by that user |

The tier is derived at admission and cannot be overridden by an author or by configuration. This is a statement about what is physically achievable, not a configuration knob.

It is derived from the policy's **resolved import graph**, not from a manifest the author writes. A self-declared capability set is not a trust boundary, because the party declaring it is the party the boundary exists to constrain. Declaration remains useful as a routing hint and as diagnostic output, and a mismatch between it and the resolved graph is itself an admission finding — but it never grants anything.

Runtime enforcement is the second, independent mechanism. The `sealed` context is deny-by-default: it exposes no filesystem, process, or network bindings, so a policy that under-declares does not escape into a privileged tier, it fails inside the tier it was routed to. Repeated failures trip the circuit breaker for that artifact and surface in health rather than degrading silently to an allow.

`sealed` requires a runtime and policy store outside the requesting user's authority, which the managed install always provides, so the tier is unconditional in Phase 1. The deferred unprivileged scope is the one place it would disappear — see [deferred scopes](./04-service-and-updates.md#deferred-scopes).

The `sealed` tier covers more than it first appears. Canonical tool name, command string, file path, and old/new content already arrive in the request envelope, so payload-only builtins evaluate there and produce verdicts an agent cannot forge even with full authority over its own user. Resolved against the real import graph, that is 32 of the 39 builtins; the seven that route to `user-context` are `warn-repeated-tool-calls`, `block-work-on-main`, and the five `require-*-before-stop` policies, each of which reads the repository or shells out to `git`. The split is a property of the modules those policies transitively import, which is why they had to be separated into distinct modules before derivation could produce anything but an empty `sealed` tier — a single shared module importing `child_process` routes all 39 to `user-context` and leaves an architecture that looks implemented and delivers no verdict integrity at all. A `user-context` policy remains useful because results combine as `deny` over `instruct` over `allow`: it can only tighten, so a forged `allow` from it changes nothing, and a forged `deny` harms only the user who forged it.

### The per-user agent

`user-context` evaluation is not the only work that must happen at the requesting user's UID. Session capture must too, and for a harder reason: the daemon is not root and cannot `setuid`, and every capture source resolves under a user's home — `~/.codex/sessions`, `~/.factory`, `~/.openclaw`, `~/.gemini/antigravity-cli`, `~/.local/share/{devin,goose}` — where homes are `0700` or `0750` and transcripts are typically `0600`. A service account cannot traverse them, cannot `inotify` them (watching a directory requires read permission on it, so there are no events to miss slowly — there are none at all), and for the SQLite-backed sources cannot attach to a live WAL database, which requires creating `-shm`/`-wal` beside it and therefore *write* access to the user's directory.

Granting that access at enrollment was considered and rejected. It is mechanically possible — setup runs as root and knows the enrolling user, so a POSIX ACL could give the service account traverse on the home and read on each source root, with default ACLs for new subdirectories. It fails on three counts. Any `chmod` by the harness rewrites the ACL mask and silently caps the named-user entry to nothing, which is exactly what a CLI storing prompt content tends to do to its own transcripts. The SQLite sources need write rather than read, inverting the trust direction. And it would make a daemon compromise a read of every enrolled developer's transcripts — pasted credentials, source, internal URLs — which is a richer prize than the policy store the boundary exists to protect, while buying no tamper-resistance, since the user still owns those files and can truncate or falsify them.

Both jobs therefore run in **one per-user agent**: the same shipped binary in a different mode, started by that user's own service manager (a systemd user service or LaunchAgent), connected to the same socket, where peer credentials already establish which UID it speaks for.

One agent rather than two, because both jobs want exactly the same thing — that UID's file access and a connection to the daemon — and because residency is already required. Enforcement runs under a hard deadline, so spawning a policy runtime per hook event would not meet it; once the process is warm for that, the capture watcher is free.

The agent is a delegate, never an authority:

| | Daemon (`_failproofai`) | Per-user agent (requesting UID) |
|---|---|---|
| Protected policy store and admission | ✅ | — |
| `sealed` evaluation | ✅ | — |
| Combining results, returning the verdict | ✅ | — |
| Spool, delivery, the `events:add` key | ✅ | — |
| Hook reconciliation, schema catalog | ✅ | — |
| `user-context` evaluation | — | ✅ |
| Session-source watching and parsing | — | ✅ |

That asymmetry is what makes it safe rather than a second brain. Its verdicts can only tighten and can never relax a `sealed` result; its capture output is observational; it holds no credential, so no user can aim the machine's delivery key anywhere. Fully compromised by the user who owns it, it can weaken nothing — which is why it must be supervised but need not be trusted.

It is **conditional, not mandatory**. A user with only payload-only builtins in `sealed` and no capture enabled needs no agent at all; one appears when that user has a `user-context` policy admitted or a capture source enabled. On a shared machine the count is one daemon plus one agent per enrolled user who needs one, not a fixed pair.

**Its service definition lives in the user's home, and that is a documented exception** to the rule that nothing enforcement depends on sits beneath a user-owned root. A systemd user service is read from `~/.config/systemd/user/`; a LaunchAgent from `~/Library/LaunchAgents/`. Both are user-writable by construction — being user-writable is what makes them a *user* service manager — so the definition of the process that runs on the user's behalf is a file that user can edit, redirect, or delete, and setup must drop privileges to write it in the first place, since a root-owned file there breaks every subsequent `systemctl --user` they run.

The exception is safe, for the same three reasons the agent itself is a delegate: its verdicts can only tighten and can never relax a `sealed` result, its capture output is observational, and it holds no credential, so substituting its binary buys the user nothing they could not already do with their own authority. What is not acceptable is presenting it as tamper-resistant. Setup states it during boundary disclosure, an absent or stopped agent is a degradation health reports rather than a quiet loss of `user-context` enforcement, and the enforcement path is designed so that a missing agent falls back to a one-shot evaluation at the user's UID instead of skipping those policies — the failure this product exists to prevent is enforcement disappearing without anyone noticing.

Its failure is bounded in both directions. If the agent is absent, stopped, or unresponsive, `sealed` enforcement continues unaffected, `user-context` policies apply the configured per-integration failure mode within the same deadline, and capture resumes from its checkpoint when the agent returns. If it misbehaves, per-UID queues and quotas keep it from consuming another user's capacity or the enforcement lane's.

The hook client remains a third process at the user's UID and is unchanged: transient, spawned per event by the harness, holding no state.

**An alternative that removes the resident process** is worth recording, because it suits deployments that forbid per-user services. The hook client already runs as the user and already connects to the socket, so it could pass an open file descriptor for the session transcript via `SCM_RIGHTS`: authority is resolved at `open()` by the user's own process, and the daemon never needs a path it can traverse. It covers the JSONL sources and needs nothing resident, but it cannot backfill historical sessions, cannot serve the four SQLite-backed sources (the shared-memory problem survives fd passing), misses any harness running with hooks disabled, and does nothing for `user-context` evaluation. It is a supplement, not a replacement.

### Pinned policy runtime

The `sealed` tier must never execute an interpreter the requesting user can write to. Node commonly resolves through nvm, fnm, or volta into a path under the user's home, which is both user-writable and frequently unreadable by a service account; executing it would silently forfeit every guarantee the tier exists to provide.

The daemon therefore uses a runtime shipped with the native release and installed root-owned — read-only to the service account it runs as — alongside the binaries, referenced by an absolute path recorded at install time. It resolves nothing through `PATH`. Because promotion into the protected store already compiles policies, a runtime that is also a bundler removes a separate toolchain from the release.

This guarantee is a property of the privileged install layout, not of the daemon or of the shipped artifact.

The `sealed` tier goes one level further than an absolute path, and does so as shipped: its engine is QuickJS-ng linked into the daemon binary, evaluating a bundle embedded at compile time in a context created with **no bindings registered at all** — no `require`, no module loader, no `process`, no `fetch`, no filesystem. Not blocked: absent. A policy reaching for one gets a `ReferenceError`, which is an evaluation failure that trips a circuit breaker rather than a silent allow, and that is what makes the deny-by-default boundary structural instead of a syscall filter someone has to keep current. Embedding the bundle rather than reading it from disk is the same argument as the absolute path applied one level deeper — a bundle loaded at startup is a bundle that write access to the state directory could replace with one that allows everything — and it makes the evaluator part of the signed artifact. The runtime installed on disk is what the `user-context` tier runs, where real imports and the requesting user's own authority are the entire point; [open decision #3](./06-delivery-plan.md#open-decisions) is about that one.

Environment is constructed, never inherited. The hook client's environment originates in the agent's process, which makes `NODE_OPTIONS`, `NODE_PATH`, preload flags, and library-search variables user-controlled injection vectors into anything the daemon spawns. The service definition sets a fixed `PATH`, and worker spawn passes an explicit allowlisted environment.

### Dependencies and admission

Protected policies are compiled, not copied. Admission resolves the full import graph and inlines it into a single content-addressed artifact, so one digest covers the policy and every dependency, nothing is resolved from a mutable path at evaluation time, and the audit record identifies exactly what ran. That same resolved graph is what determines the execution tier.

Native addons are refused from the `sealed` tier outright. They cannot be inlined, and pinning a digest only prevents substitution — it places no constraint on what the loaded native code then does with the service account's file, process, and network access, which would contradict the tier's denied capabilities and void its verdict claim. A policy requiring a native addon is admitted to `user-context`, where it runs with the requesting user's authority and its verdict carries no integrity claim to begin with.

Authoring is unprivileged and unconstrained — the ordinary package-manager workflow, iterated in the `user-context` tier. Promotion is the privileged step, and it is where the graph is frozen.

### Enforcement performs no unbounded I/O

A policy that needs remote state — pull-request status, CI results, an organization directory — must not fetch it during evaluation. Enforcement runs under a hard monotonic deadline, and a synchronous network call inside a hook makes a third party's availability a precondition for the user running a command.

Remote state is fetched by the collection lane on its own schedule into a local cache with an explicit freshness bound, and the policy reads that cache synchronously. A policy reading stale or absent cached state must be able to distinguish it from a negative result, and the freshness bound is recorded with the decision. The rule is a property of the enforcement deadline, not of where the data comes from, so it holds identically for any lane added later.

## Evaluation path

For an accepted hook request, the daemon:

1. validates the envelope and remaining deadline;
2. canonicalizes the native harness event;
3. resolves machine, agent, project, session, event, and tool targeting context;
4. selects an immutable active generation;
5. finds all matching policies and their effects;
6. evaluates matching policy locally within the remaining deadline, routing each one to its admitted execution tier;
7. combines results deterministically (`deny` over `instruct` over `allow`, absent an authorized suppression), so a `user-context` result can tighten the outcome but never relax a `sealed` one;
8. writes decision evidence asynchronously to the durable activity spool;
9. returns a canonical result and decision ID.

The response never waits for event upload, transcript processing, or catalog refresh.

### Derived and asserted context

Request context is not uniform, and treating it as though it were is how a forged input relaxes an unforgeable verdict. Step 3 above resolves fields with two different provenances, and the difference is load-bearing enough to be part of the protocol rather than a convention.

`home` is **derived by the daemon** from the peer credential, with `getpwuid_r(peer_uid)`, and a client that asserts one is rejected as a protocol error rather than corrected. The daemon evaluates on behalf of another UID, so its own home is the service account's and useless; more importantly, `isAgentInternalPath` and `block-read-outside-cwd` both use the home to *widen* the set of paths they allow, so a client asserting `home: "/"` would make every path agent-internal — a forged input relaxing a sealed verdict, which is the one direction that does not announce itself. Silently overwriting the field would make the attack a no-op while leaving the protocol looking as though it accepted the field; rejecting makes a client that tries it fail loudly. A `getpwuid_r` miss is an error, never a fallback to a default home. This is implemented and enforced.

`cwd`, the project directory, and environment facts genuinely cannot be derived: `/proc/<pid>/cwd` is TOCTOU-prone and, on macOS, unreadable for a non-matching UID. They therefore travel as **client-asserted** values with explicit provenance. Environment facts are a closed set — `CLAUDE_PROJECT_DIR` alone today — and an unknown key is rejected by name rather than passed through, because the hook client's environment originates in the agent's own process and would otherwise be an injection channel straight into evaluation.

The consequence is a third attestation rather than a weakened claim. A decision every one of whose deciding policies ran `sealed` and read none of these is `sealed`; one that ran `sealed` but read a client-asserted field is `sealed_unattested`; one a `user-context` policy contributed to is `user_context`. Attestations combine as a maximum under `sealed < sealed_unattested < user_context`, so a combined result can never be reported as more attested than its weakest input — the inverse would launder a `user-context` contribution into a `sealed` claim, which is the exact property the two-tier split exists to provide. The attestation is carried in decision evidence and reported by `policies explain`. It is the honest version of "unforgeable", and it is better than a claim that quietly is not true.

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
    spool/
    failed/
    health.json
    harness-schemas/
  logs/
```

The one secret Phase 1 handles is the observability server's `events:add` key. It belongs to the machine's delivery lane rather than to a user, so it lives in privileged machine configuration where the service account can read it and enrolled users cannot — never in this tree, never in the service definition, and never in a process argument. It uses the operating-system credential store where practical, with an owner-only file as the portability fallback.

Machine state uses platform system locations. On Linux, executables and the pinned runtime install root-owned under `/opt/failproofai/versions/<version>/`; configuration, the pinned enabled set, the installation record, the content-addressed policy store, and mutable state live under `/var/lib/failproofai/`; the runtime socket directory is `/run/failproofai/`. macOS uses platform-appropriate `/Library` locations with the same logical layout.

The socket directory is the one path whose *logical* layout is identical and whose *creation* is not, so it is worth naming rather than folding into "the same layout". On Linux systemd's `RuntimeDirectory=` recreates it with the correct owner and mode on every start, which it must, because `/run` is a tmpfs that does not survive a boot. launchd has no equivalent, so on macOS it is created by the privileged installer and persists. The daemon consequently asserts the directory's existence, ownership, and mode before binding on both platforms and creates it when it is missing, rather than assuming the service manager produced it — one check satisfied by a different mechanism on each side. [The service model](./04-service-and-updates.md#service-model) records the difference from the service manager's end.

Ownership within that layout is split by writer. Anything whose integrity a decision depends on — executables, the pinned runtime, the protected policy store, the active schema catalog, and machine configuration, including the pinned enabled set and the installation record whose `service_uid` a client verifies the socket's owner against — is root-owned and read-only to the service account, written only by the privileged installer during an elevated operation. The service account owns only what the daemon must write at runtime: spool, checkpoints, activity, per-user state, health, logs, and the socket directory. The daemon consequently cannot rewrite the binary it restarts from, the runtime it evaluates in, or the policy revision it evaluates — a compromised daemon can corrupt its own telemetry and nothing above it.

Per-user material beneath machine state is keyed by numeric UID, never an untrusted username, and remains inaccessible to other users. Exact paths are part of the platform packaging contract.

The `~/.failproofai/` root above is where a user authors and discovers their own policies. Those sources are **additive, non-authoritative inputs**: they never enter the protected generation, always route to the `user-context` tier, and can only tighten a result. Replacing the directory therefore changes only that user's own additional restrictions — it cannot alter, disable, or weaken a protected revision, and the protected generation loads identically whether the directory is present, absent, or substituted. The enablement this tree records is bounded the same way: it can add to the pinned enabled set and never subtract from it, which is what [protected enablement](#protected-enablement) requires and what does not ship yet.

That is why the installation keeps nothing it *depends* on beneath a user-owned root. Delete and rename permission derive from the parent directory, so a user who owns their home can rename an unwritable `~/.failproofai` aside and supply a replacement they own — ownership and mode on the directory itself prevent nothing, and a sticky bit on the home directory is removable by the same user. Protected artifacts are therefore reachable only through paths whose every component is owned by the service account or root.

Configuration is schema-versioned and written transactionally. File notifications prompt reload, while periodic reconciliation is the correctness backstop. Project policy caches are bounded by memory and entry count and invalidated by resolved input changes.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain verified generation data, apply configured event failure behavior, keep collection running. |
| Policy hangs | Interrupt it out of band — the deadline is not self-enforcing — report the miss distinctly from an evaluation failure, trip its circuit breaker after repeated failures, and keep IPC responsive. |
| One source parser fails | Degrade that source without stopping other sources or enforcement. |
| Invalid configuration | Reject candidate and retain active generation. |
| Observability server unavailable | Continue enforcement and capture; spool delivery data and retry with bounded backoff. |
| Spool reaches quota | Report degradation and apply explicit queue policy; never wait on network in enforcement. |
| Daemon crashes | Service manager restarts it; persisted generations, checkpoints, and spool recover work. |

## Health

Health is a structured, versioned snapshot covering IPC readiness, enforcement latency and queue depth, local policy generation and reload state, source progress, spool age and size, delivery acknowledgements, quarantined data, resource pressure, and harness/schema compatibility state. Delivery health is `not_configured` when no destination is set. The snapshot is versioned so Phase 2 adds subsystems to it rather than reshaping it.

Logs are structured, correlated by request/batch/catalog-generation ID, rotated, and size-bounded. Sensitive hook payloads and transcript contents are excluded by default.
