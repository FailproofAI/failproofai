# Daemon architecture

## Responsibilities

`failproofaid` is the Rust local enforcement plane. It runs as the user whose agents it governs, and it owns:

- local IPC and request admission;
- desired hook registration, settings-file watching, and automatic reconciliation;
- event canonicalization and policy evaluation coordination;
- immutable local policy generations;
- collector source workers, checkpoints, spooling, and delivery;
- health, diagnostics, logs, and resource limits;
- signed harness schema-catalog refresh and atomic activation.

One daemon serves one user. There is no per-user agent, no privileged helper, and nothing the daemon delegates to a second resident process — running as the user is what removes the need for any of them, because every file the daemon must read is a file it can already open.

The user-facing `failproofai` CLI is a client of the daemon and service manager. Agent harnesses invoke the same CLI as the smaller hook client described in [Agent harness integration](./02-harness-integration.md).

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

- The daemon listens on a Unix domain socket in the user's own runtime directory, and every request is authorized from operating-system peer credentials.
- The daemon does not expose its control protocol over TCP, including loopback.
- Messages are length-prefixed and versioned rather than newline-delimited.
- Peer identity is mandatory. The daemon serves exactly one UID — its owner — and closes a connection from any other peer.
- Hook, query, and administrative operations remain distinct protocol operation classes, so a later scope can attach different authorization to each without a wire change.

The peer check is not a privilege boundary; the owner is the only party who could gain anything by connecting, and they already own the daemon. It is an isolation rule for a shared machine, where several users may each be running their own daemon and one user's socket must never answer another user's events. It also rejects the ordinary misconfiguration — a stale `FAILPROOFAI_DAEMON_SOCKET` pointing at somebody else's endpoint — as an error rather than as somebody else's policy set.

Windows transport and service integration are deferred beyond Phase 1. The framed protocol remains transport-independent so a later named-pipe implementation does not change request semantics.

Initial operations are `Ping`, `EvaluateHook`, `Status`, `Reload`, `Flush`, and the `Query` set. `Ping` and `EvaluateHook` are implemented; the rest land with the stages that need them, as new operation variants rather than wire changes. The framing, handshake, and envelope as implemented are specified in [`crates/PROTOCOL.md`](../../../crates/PROTOCOL.md), which the daemon, the `fpai-ipc` crate, and the TypeScript hook client are each written against independently — so anything left ambiguous there becomes a silent interoperability bug rather than a loud one.

| Class | Operations | Authorized for |
|---|---|---|
| Hook | `EvaluateHook` | the owning UID |
| Query | activity, sessions, transcript access, policy list with source/tier/revision, health, generation identity | the owning UID |
| Administrative | admit or remove artifacts, stop, reconfigure, mutate the active generation | the owning UID |

The three classes stay separate even though one identity satisfies all of them today. Collapsing them would make adding a [deferred scope](./04-service-and-updates.md#deferred-scopes) — where the administrative class is exactly what needs different authorization — a protocol change rather than an authorization change.

`Query` exists because the local dashboard and CLI need read access without inventing a second identity mechanism. The daemon does not distinguish a dashboard client from any other — see [Local dashboard](./01-user-experience.md#local-dashboard) for why the dashboard is the CLI in a mode rather than a process the daemon spawns.

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

### The enabled set is the user's configuration

Which policies run comes from `.failproofai/policies-config.json`, merged across project, local, and user scope exactly as the current product merges it. That merge is authoritative, and it belongs to the user.

The client resolves it and sends it in the request; the daemon evaluates that set and never a set of its own. This is deliberate and was learned the hard way. When the daemon supplied its own default list, a user with 30 policies enabled got the 11 builtin defaults — 19 builtins plus every custom and convention policy silently stopped enforcing the moment the daemon answered. A client-resolved set makes the daemon's answer equal to the answer the same configuration produces in process, which is the property the parity corpus asserts and the only one that matters when both ends are the same user.

An empty set is a protocol error rather than "evaluate nothing" or "use the defaults". The first turns a client bug into a silent allow; the second reinstates the defect above.

## Policy runtime boundary

Rust is the authoritative implementation language for the daemon and new core subsystems.

Existing local custom policies are JavaScript or TypeScript and may use transitive local and package imports. v1 cannot silently narrow that contract. A supervised, long-lived policy worker behind an internal runtime interface is the migration design. It is shipped, versioned, monitored, and terminated with the daemon; users do not manage it as a separate service.

Locally authored policy is a first-class source, not a compatibility shim. Builtins, explicit custom files, project/user convention directories, and existing configuration scopes produce the active generation without authentication.

The existence of this JavaScript worker is not a general licence to execute policy from any origin. It admits code the machine's own users authored and can already run as themselves. Admitting policy from a remote origin is a separate problem with separate requirements, and it is deliberately not solved by reusing this worker.

Each evaluation has a deadline and resource budget. Repeated timeout, crash, or memory failure trips a circuit breaker for the offending generation or artifact and records structured diagnostics.

**A deadline does not enforce itself.** A policy body is synchronous JavaScript: once the runtime enters it, nothing else on that thread runs, so a deadline checked between microtasks is checked exactly never for the case that matters. The case is neither hypothetical nor exotic — `block-curl-pipe-sh` is default-enabled and sealed, and its regex backtracks quadratically on a repeated `curl ` prefix. Measured against a 200 ms deadline with no out-of-band interrupt, 40 KB of command took 7.1 seconds and 80 KB took 30, each returning a verdict rather than a deadline miss, and a request at the frame cap extrapolates past an hour — one such request wedges the single enforcement lane, and two other default-enabled policies have the same regex shape. Enforcement therefore requires a watchdog that arms before the runtime is entered and disarms after it returns, setting a flag the runtime polls and unwinds on. Because that unwind arrives as an ordinary exception, the catch sites must tell it apart from a policy that genuinely threw; otherwise a merely slow policy trips the circuit breaker meant for a broken one. The same reasoning applies to the memory ceiling, which is the mechanism the interrupt cannot substitute for: an interrupt cannot stop a single allocation that is too large, and a ceiling cannot stop a tight loop.

This is the clearest example of what the resident architecture buys. In the per-event process model the same regex hangs one hook until the harness's own timeout fires, with no diagnosis and no record. Here it is interrupted, reported as a deadline miss distinct from an evaluation failure, and attributed to a named policy.

### Execution tiers

A policy that inspects the repository, the diff, or the transcript must be able to open files and run `git`. A policy that only reads the tool payload needs none of that, and is better off unable to reach it at all. Evaluation is therefore split by **resolved capability**:

| Tier | Where it runs | Filesystem, subprocess, network |
|---|---|---|
| `sealed` | the daemon's own embedded engine | absent — no bindings registered |
| `user-context` | a worker the daemon spawns | granted, with the user's own authority |

The names describe capability, not identity. Both tiers run as the user, in a process tree the user owns, and the daemon never needs to change UID for either.

**The split makes no verdict-integrity claim, and this release does not have one to make.** The governed agent and the daemon are the same user: it can `ptrace` the daemon, preload into it, replace `failproofaid` on disk, rewrite `policies-config.json`, or `systemctl --user stop failproofaid`. Nothing built out of processes owned by a single user changes that, and no document, health field, or CLI string in this release may suggest otherwise. What would change it is a daemon running as a different account, which is exactly what [deferred scopes](./04-service-and-updates.md#deferred-scopes) describes and exactly what it would buy.

What the `sealed` tier does buy is the difference between a resident sandbox and a per-event dynamic import:

- **Residency.** The engine and the compiled builtins are loaded before the event arrives, instead of a fresh interpreter re-importing every policy file per tool call.
- **No side effects on the user's tree.** The current loader writes a `.__failproofai_tmp__.mjs` beside the policy source on *every* evaluation. The sealed loader is a lookup into a compiled module map and touches no path at all.
- **An enforceable deadline.** The watchdog above is only possible because evaluation happens inside a runtime the daemon controls and can interrupt.
- **Containment of mistakes.** A payload-only policy that unexpectedly reaches for `node:fs` gets a `ReferenceError` and trips its circuit breaker, rather than reading or writing something its author did not intend on a developer's machine. This bounds *errors and over-reach*, not an adversary — an author who wants host access simply writes a `user-context` policy and gets it.

The tier is derived at admission from the policy's **resolved import graph**, never from a manifest the author writes, and cannot be overridden by configuration. That is not a trust argument here; it is an accuracy one. A declaration is the author's belief about their own dependencies, and the resolved graph is the fact — routing on the belief would put a policy in a context where it fails at evaluation time rather than at install time. The declaration remains useful as a diagnostic, and a mismatch between it and the resolved graph is an admission finding.

Runtime behavior is the second, independent mechanism. The `sealed` context is deny-by-default: it exposes no filesystem, process, or network bindings, so a policy that under-declares does not silently acquire them, it fails inside the tier it was routed to. Repeated failures trip the circuit breaker for that artifact and surface in health rather than degrading silently to an allow.

The `sealed` tier covers more than it first appears. Canonical tool name, command string, file path, and old/new content already arrive in the request envelope, so payload-only builtins evaluate there. Resolved against the real import graph, that is 32 of the 39 builtins; the seven that route to `user-context` are `warn-repeated-tool-calls`, `block-work-on-main`, and the five `require-*-before-stop` policies, each of which reads the repository or shells out to `git`. The split is a property of the modules those policies transitively import, which is why they had to be separated into distinct modules first — a single shared module importing `child_process` routes all 39 to `user-context`, and the resident sandbox then contains nothing at all.

Results combine as `deny` over `instruct` over `allow`, so a `user-context` policy can tighten a `sealed` result and never relax it. That is the product's decision semantics, and it holds independently of who owns which process.

### Pinned policy runtime

The daemon evaluates against a runtime shipped with the native release rather than whichever interpreter `PATH` happens to expose. Node commonly resolves through nvm, fnm, or volta into a path that changes when the user switches versions, and a policy runtime that changes underneath an installation produces decisions that differ between two machines with identical configuration.

The runtime therefore installs alongside the binaries in the versioned release directory, is referenced by an absolute path recorded at install time, and resolves nothing through `PATH`. Its version and digest are release-manifest and SBOM entries, so "which runtime decided this" is answerable. Because admission already compiles policies, a runtime that is also a bundler removes a separate toolchain from the release.

The `sealed` tier goes one level further, and does so as shipped: its engine is QuickJS-ng linked into the daemon binary, evaluating a bundle embedded at compile time in a context created with **no bindings registered at all** — no `require`, no module loader, no `process`, no `fetch`, no filesystem. Not blocked: absent. A policy reaching for one gets a `ReferenceError`, which is an evaluation failure that trips a circuit breaker rather than a silent allow, and that is what makes the deny-by-default boundary structural instead of a syscall filter someone has to keep current. Embedding the bundle rather than reading it from disk also makes the evaluator part of the signed artifact, so a corrupted or partially written state directory cannot produce a subtly different evaluator. The runtime installed on disk is what the `user-context` tier runs, where real imports are the entire point; [open decision #3](./06-delivery-plan.md#open-decisions) is about that one.

Environment is constructed, never inherited. The hook client's environment originates in the agent's process, which makes `NODE_OPTIONS`, `NODE_PATH`, preload flags, and library-search variables inputs that reach anything the daemon spawns. Inheriting them would make evaluation depend on whatever the agent's shell happened to export — a policy behaving differently under one harness than another for reasons nobody can see. The service definition sets a fixed `PATH`, and worker spawn passes an explicit allowlisted environment.

### Dependencies and admission

Policies are compiled, not copied. Admission resolves the full import graph and inlines it into a single content-addressed artifact, so one digest covers the policy and every dependency, nothing is resolved from a mutable path at evaluation time, and the decision record identifies exactly what ran. That same resolved graph is what determines the execution tier.

Three things follow, and none of them require privilege. Evaluation stops depending on `node_modules` being in the state the author last left it. A decision names a digest instead of a path. And the sealed loader becomes a map lookup rather than a resolver, which is what lets the sealed context have no filesystem binding at all.

Native addons cannot be inlined, so a policy requiring one is admitted to `user-context`, where imports resolve normally. Its `.node` files are copied alongside the artifact with their digests pinned, so the artifact still identifies what ran.

Admission runs in the CLI, as the user, with no elevation — like everything else in this release.

### Enforcement performs no unbounded I/O

A policy that needs remote state — pull-request status, CI results, an organization directory — must not fetch it during evaluation. Enforcement runs under a hard monotonic deadline, and a synchronous network call inside a hook makes a third party's availability a precondition for the user running a command.

Remote state is fetched by the collection lane on its own schedule into a local cache with an explicit freshness bound, and the policy reads that cache synchronously. A policy reading stale or absent cached state must be able to distinguish it from a negative result, and the freshness bound is recorded with the decision. The rule is a property of the enforcement deadline, not of where the data comes from, so it holds identically for any lane added later.

Because the daemon runs as the user, a `user-context` policy that needs a credential for that fetch can use the user's own — `~/.config/gh`, `~/.netrc`, an environment token — rather than needing one issued to a service. That removes a whole credential-brokering problem this design previously had to carry.

## Evaluation path

For an accepted hook request, the daemon:

1. validates the envelope and remaining deadline;
2. canonicalizes the native harness event;
3. resolves machine, agent, project, session, event, and tool targeting context;
4. selects an immutable active generation;
5. finds all matching policies and their effects;
6. evaluates matching policy locally within the remaining deadline, routing each one to its admitted execution tier;
7. combines results deterministically (`deny` over `instruct` over `allow`), so a `user-context` result can tighten the outcome but never relax a `sealed` one;
8. writes decision evidence asynchronously to the durable activity spool;
9. returns a canonical result and decision ID.

The response never waits for event upload, transcript processing, or catalog refresh.

### Derived and asserted context

Request context is not uniform, and treating it as though it were produces wrong verdicts that look like right ones. Step 3 above resolves fields with two different provenances, and the difference is load-bearing enough to be part of the protocol rather than a convention.

`home` is **derived by the daemon** from the peer credential, with `getpwuid_r(peer_uid)`, and a client that asserts one is rejected as a protocol error rather than corrected. Two reasons, and neither depends on an adversary. The daemon can compute this field correctly from the connection itself, so accepting it from the client adds a way to be wrong and no way to be right. And `isAgentInternalPath` and `block-read-outside-cwd` both use the home to *widen* the set of paths they allow, so a wrong value does not fail — it quietly permits more, which is the one direction that does not announce itself. Silently overwriting the field would leave the protocol looking as though it accepted it; rejecting makes a client that sends one fail loudly and get fixed. A `getpwuid_r` miss is an error, never a fallback to a default home. This is implemented and enforced.

`cwd`, the project directory, and environment facts genuinely cannot be derived: `/proc/<pid>/cwd` is TOCTOU-prone and, on macOS, unreadable for a non-matching UID. They therefore travel as **client-asserted** values with explicit provenance. Environment facts are a closed set — `CLAUDE_PROJECT_DIR` alone today — and an unknown key is rejected by name rather than passed through, so the set of environment variables that can reach evaluation stays something a reader of this document can enumerate.

The consequence is a third attestation rather than a weakened claim. A decision every one of whose deciding policies ran `sealed` and read none of these is `sealed`; one that ran `sealed` but read a client-asserted field is `sealed_unattested`; one a `user-context` policy contributed to is `user_context`. Attestations combine as a maximum under `sealed < sealed_unattested < user_context`, so a combined result is never reported as more attested than its weakest input.

In this release the attestation is **provenance, not integrity**: it answers "what did this decision depend on, and where was it computed", which is what makes an unexpected verdict diagnosable and what tells an author their payload-only policy is quietly reading an asserted `cwd`. Under a [deferred scope](./04-service-and-updates.md#deferred-scopes) the same three values become an integrity claim without a protocol change, which is why they are carried and computed now.

### Forward compatibility

Three later changes are anticipated and none may require harnesses to be reintegrated: a deferred scope may move the daemon to another account, Phase 2 adds centrally assigned policy evaluated locally, and a version after it may move some or all evaluation off the machine.

What Phase 1 does to keep them open is limited to contract shape, not mechanism. The harness contract terminates at `failproofaid`. Policy decisions use a location-independent canonical request/result model, so the same request is answerable by a local worker or by something further away. Deadlines are end-to-end rather than per-hop. Decision evidence carries stable request, policy, generation, and session identity, plus the attestation that becomes meaningful the moment the daemon stops being the same user as the agent.

No Phase 1 configuration key, remote-decision client, fallback mode, or user-visible setting is added for any of them. A seam is a shape the contract already has; it is not a dormant feature.

## Configuration and state

Everything lives under two user-owned roots, and neither is new. `~/.failproofai/` is where the product already keeps configuration and policies; `~/.agenteye/` is where the collector already keeps capture state. Nothing is relocated between them, and nothing is written outside them apart from the service definition and the harness settings files the user asked to change.

```text
~/.failproofai/
  config.json
  policies-config.json
  policies/
  versions/<version>/            executables, pinned policy runtime, baseline catalog
  current -> versions/<version>
  install.json
  artifacts/                     content-addressed admitted policy artifacts
  state/
    policy-generations/
    activity/
    health.json
    harness-schemas/
  logs/
  run/                           socket directory, when XDG_RUNTIME_DIR is unset

~/.agenteye/
  <the standalone collector's existing layout>
    configuration, including the observability destination and its events:add key
    per-source checkpoints
    the durable spool, failed and quarantined batches
```

The `~/.agenteye/` tree is deliberately described by reference rather than redefined. It is the collector's own layout, the daemon adopts it in place, and [collector integration](./05-collector-integration.md) is where that is stated as a compatibility requirement. A layout redesign is exactly the kind of migration nobody asked for.

The one secret Phase 1 handles is the observability server's `events:add` key. It lives in the collector's configuration under `~/.agenteye/`, readable by the user, which is what the standalone collector already does. It uses the operating-system credential store where practical, with an owner-only file as the portability fallback, and it is never in the service definition, never in a process argument, and never in a log. It is erased unconditionally on uninstall, including offline, because that is a property of credentials rather than of who can read them.

### The socket directory

The socket is the one path whose location depends on the platform and the session rather than on a choice:

| Condition | Socket directory |
|---|---|
| Linux with `XDG_RUNTIME_DIR` set | `$XDG_RUNTIME_DIR/failproofai/` |
| Linux without it | `~/.failproofai/run/` |
| macOS | `~/.failproofai/run/` |

The fallback is not defensive boilerplate. `XDG_RUNTIME_DIR` is set by `pam_systemd` for a login session and is **absent over a plain `ssh` invocation on several distributions** — precisely the shape of a remotely driven agent run, which is a case this product is used in. A daemon that only knows the first row simply fails to start there.

On Linux a systemd user unit's `RuntimeDirectory=failproofai` creates the directory with the right owner and mode on every start and removes it on stop, which it must, because `$XDG_RUNTIME_DIR` is a tmpfs that does not survive a reboot. launchd has no equivalent, so on macOS the directory is created once and persists under the user's home. The daemon therefore asserts existence, ownership, and mode before binding on both platforms and creates the directory when it is missing, rather than assuming the service manager produced it — one check satisfied by a different mechanism on each side. [The service model](./04-service-and-updates.md#service-model) records the difference from the service manager's end.

A stale socket from a killed daemon is unlinked and rebound after the daemon confirms nothing is listening on it, and the client's owner check plus the version handshake mean a socket it cannot identify costs a fallback rather than a wrong answer.

### What the state directory is and is not

The state directory is the daemon's working memory: generations, activity, health, checkpoints, catalog state, and admitted artifacts. It is the user's, like everything else, and the design does not pretend otherwise — the sentence "protected artifacts live outside the user's home" has been removed from these documents rather than weakened, because in this release there are no protected artifacts.

What it still needs is **integrity against crashes**, which is a different problem and one that is entirely solvable here. Generations publish atomically; a failed candidate never partially replaces active state; catalog activation is crash-consistent in the ordering [04](./04-service-and-updates.md#catalog-update-transaction) specifies; the spool's state machine survives power loss. Configuration is schema-versioned and written transactionally. File notifications prompt reload, while periodic reconciliation is the correctness backstop. Project policy caches are bounded by memory and entry count and invalidated by resolved input changes.

## Failure isolation

| Failure | Required behavior |
|---|---|
| Policy worker crashes | Restart it, retain verified generation data, apply configured event failure behavior, keep collection running. |
| Policy hangs | Interrupt it out of band — the deadline is not self-enforcing — report the miss distinctly from an evaluation failure, trip its circuit breaker after repeated failures, and keep IPC responsive. |
| One source parser fails | Degrade that source without stopping other sources or enforcement. |
| Invalid configuration | Reject candidate and retain active generation. |
| Observability server unavailable | Continue enforcement and capture; spool delivery data and retry with bounded backoff. |
| Spool reaches quota | Report degradation and apply explicit queue policy; never wait on network in enforcement. |
| Daemon crashes | The service manager restarts it; persisted generations, checkpoints, and spool recover work. In-flight hooks fall back to in-process evaluation, so the crash costs latency rather than a decision. |
| No service manager present | Health reports `unsupervised`; the daemon runs until it exits and hooks fall back in process afterwards. |

## Health

Health is a structured, versioned snapshot covering IPC readiness, supervision state, enforcement latency and queue depth, local policy generation and reload state, source progress, spool age and size, delivery acknowledgements, quarantined data, resource pressure, and harness/schema compatibility state. Delivery health is `not_configured` when no destination is set. The snapshot is versioned so Phase 2 adds subsystems to it rather than reshaping it.

Health reports execution-tier counts as a description of where evaluation happens. It carries no field asserting tamper resistance or verdict integrity, and adding one would be a bug.

Logs are structured, correlated by request/batch/catalog-generation ID, rotated, and size-bounded. Sensitive hook payloads and transcript contents are excluded by default.
