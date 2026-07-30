# Phase 1 — local enforcement plane

Status: Draft

Target: failproofai v1.0.0

`failproofaid` is the Rust background service for FailproofAI. Phase 1 is **the product as it ships today, re-architected**: it preserves the complete standalone OSS policy experience, moves enforcement behind a boundary an agent cannot administer with its own user authority, absorbs the standalone `agenteye-collector` without losing any of its behavior, and keeps harness hooks compatible through a signed schema catalog.

**Phase 1 ships and is useful on its own.** No FailproofAI account or organization is required, and no policy decision depends on a network service. Credentials the current product already has are carried over rather than reinvented — `failproofai auth login` is unchanged, and capture delivers to the customer's **own self-hosted** observability server with the operator-issued `events:add` key it uses today.

Phase 2 is the genuinely new management plane: machine enrollment into Failproof Cloud, centrally assigned policy, targeting, fleet health, and staged rollout. See [Phase 2](../phase-2-cloud/README.md).

## Documents

1. [User experience](./01-user-experience.md) — how a user installs, configures, operates, and removes FailproofAI.
2. [Agent harness integration](./02-harness-integration.md) — how agent CLIs and runtimes send events and enforce daemon decisions.
3. [Daemon architecture](./03-daemon-architecture.md) — Rust process model, IPC, policy runtime, execution tiers, failure isolation, and local state.
4. [Service and harness schema updates](./04-service-and-updates.md) — the operating-system service, deferred scopes, and signed version-aware hook schema reconciliation without automatic binary replacement.
5. [Collector integration](./05-collector-integration.md) — session capture, durable spooling, delivery, and migration from the existing collector.
6. [Delivery plan](./06-delivery-plan.md) — stages, acceptance criteria, and unresolved decisions.
7. [npm release and distribution](./07-release-and-packaging.md) — the single npm bootstrap path, native artifact pipeline, signing, and channel promotion.

The [implementation plan](./implementation/) says how this gets built: the Rust/TypeScript boundary, six sequenced stages with entry and exit gates, the verification strategy including a full-stack Docker acceptance gate, and the record of six amendments since folded into these documents.

## Settled decisions

- `failproofaid` is implemented in Rust.
- **One service scope ships: `managed`.** The daemon runs as a dedicated `_failproofai` service account, so agents cannot administer it or modify protected policy revisions with their own user authority. There is no scope choice in setup, and every guarantee below is therefore stated unconditionally rather than qualified per scope.
- A root-owned `system` scope and an unprivileged cooperative `user` scope are designed and deliberately unshipped, recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes) so either can be added when a customer needs it. Neither is reachable as an automatic fallback.
- The cost of one scope is stated rather than hidden: installation requires one-time administrator access and a supported service manager. Preflight refuses a machine that has neither and never degrades to something weaker that looks identical in `status`.
- Protected artifacts never live inside a user's home. Rename and delete permission come from the parent directory, so ownership alone cannot protect a path under `~`.
- Within policy administration, only *removal* is privileged — installation and every mutation of the protected surface still require `sudo`. Because results combine `deny` over `instruct` over `allow`, a user-added policy can only tighten enforcement, so convention discovery and unprivileged authoring continue to work unchanged.
- The protected surface — executables, pinned runtime, policy store, schema catalog, machine configuration — is root-owned and read-only to the service account the daemon runs as. The daemon owns only mutable runtime state, so it cannot rewrite what it enforces.
- Policy evaluation is split into a `sealed` tier running as the service account with no filesystem, subprocess, or network access, and a `user-context` tier running as the requesting UID. The tier is derived at admission from the resolved import graph, never from the author's own declaration, and the `sealed` context is deny-by-default so an under-declared policy fails inside it rather than escaping it.
- The release ships a pinned policy runtime. The daemon never executes an interpreter or dependency resolved from a user-writable path, and constructs worker environments rather than inheriting them.
- Promotion into the protected store compiles a policy and its full import graph into one content-addressed artifact; authoring and dependency management stay unprivileged and unchanged.
- Enforcement performs no unbounded I/O. Policies needing remote state read a cache the collection lane refreshes on its own schedule.
- The local dashboard is spawned by the CLI as the invoking user and reads through the daemon's `Query` operations, so peer credentials scope it with no second identity mechanism. It is loopback-only, token-gated, TTL-bounded, and performs no privileged mutation — a protected policy change produces a `sudo` command to run rather than an applied change.
- Linux and macOS are supported; Windows service, packaging, and daemon support are deferred.
- All current builtin, custom, explicit-file, convention-file, scope, harness, activity, and local-dashboard behavior remains available.
- Agent hook decisions are synchronous and evaluated locally.
- Collection, delivery, and harness schema-catalog refresh are asynchronous.
- Enforcement is fully offline once installed; installation itself requires network access, since npm bootstrap is the only supported path and air-gapped distribution is deferred.
- The standalone `agenteye-collector` converges into the daemon here, because everything it ships is current behavior the compatibility promise covers. Capture is off until enabled, and its destination is the customer's own server, so delivery pulls no FailproofAI account into Phase 1.
- The observability delivery key is the only secret Phase 1 handles. It belongs to the machine's delivery lane, lives in privileged configuration readable by the service account and not by enrolled users, never appears in a service definition or process argument, and is erased unconditionally on uninstall.
- Contract shape keeps Phase 2 and a possible later off-machine evaluation open — canonical location-independent request/result, end-to-end deadlines, stable decision identity, bounded lanes, a versioned health snapshot — without adding a configuration key, client, or user-visible setting for either.
