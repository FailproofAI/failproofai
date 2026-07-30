# `failproofaid` design

Status: Draft

Target: failproofai v1.0.0

`failproofaid` is the Rust background service for FailproofAI. It preserves the complete standalone OSS policy experience, incorporates collector behavior, optionally synchronizes centrally managed policy assignments from Failproof Cloud, and keeps harness hooks compatible through a signed schema catalog.

## Documents

1. [User experience](./01-user-experience.md) — how a user installs, configures, operates, and removes FailproofAI.
2. [Agent harness integration](./02-harness-integration.md) — how agent CLIs and runtimes send events and enforce daemon decisions.
3. [Daemon architecture](./03-daemon-architecture.md) — Rust process model, IPC, policy runtime, failure isolation, and local state.
4. [Failproof Cloud policy management](./04-cloud-policy-management.md) — additive centralized assignments and the observability-to-enforcement loop without replacing OSS policy authoring.
5. [Collector integration](./05-collector-integration.md) — session capture, durable spooling, delivery, and migration from the existing collector.
6. [Service and harness schema updates](./06-service-and-updates.md) — operating-system services and signed, version-aware hook schema reconciliation without automatic binary replacement.
7. [Delivery plan](./07-delivery-plan.md) — rollout phases, acceptance criteria, and unresolved decisions.
8. [npm release and distribution](./08-release-and-packaging.md) — the single v1 npm bootstrap path, native artifact pipeline, signing, and channel promotion.

## Settled decisions

- `failproofaid` is implemented in Rust.
- Setup explicitly selects a `managed`, `system`, or `user` service scope; `managed` is recommended and preselected because it places enforcement outside the agent's authority without running anything as root.
- Managed scope is the tamper-resistant enforcement boundary: the daemon runs as a dedicated `_failproofai` service account, and agents cannot administer it or modify protected policy revisions with their own user authority. System scope is the same service running as root, retained for fleet-managed machines and root-owned agents.
- Protected artifacts never live inside a user's home. Rename and delete permission come from the parent directory, so ownership alone cannot protect a path under `~`.
- Within policy administration, only *removal* is privileged — installation and every mutation of the protected surface still require `sudo`. Because results combine `deny` over `instruct` over `allow`, a user-added policy can only tighten enforcement, so convention discovery and unprivileged authoring continue to work in every scope.
- In managed and system scope, the protected surface — executables, pinned runtime, policy store, schema catalog, machine configuration — is root-owned and read-only to the service account the daemon runs as. The daemon owns only mutable runtime state, so it cannot rewrite what it enforces.
- Policy evaluation is split into a `sealed` tier running as the service account with no filesystem, subprocess, or network access, and a `user-context` tier running as the requesting UID. The tier is derived at admission from the resolved import graph, never from the author's own declaration, and the `sealed` context is deny-by-default so an under-declared policy fails inside it rather than escaping it. `sealed` exists only in managed and system scope; user scope makes no verdict-integrity claim.
- The release ships a pinned policy runtime. The daemon never executes an interpreter or dependency resolved from a user-writable path, and constructs worker environments rather than inheriting them.
- Promotion into the protected store compiles a policy and its full import graph into one content-addressed artifact; authoring and dependency management stay unprivileged and unchanged.
- Enforcement performs no unbounded I/O. Policies needing remote state read a cache the collection lane refreshes on its own schedule.
- v1.0.0 supports Linux and macOS; Windows service, packaging, and daemon support are deferred to the next iteration.
- The OSS product remains fully usable without an account, organization, or Failproof Cloud. Operation is fully offline once installed; v1.0.0 installation itself requires network access, since npm bootstrap is the only supported path and air-gapped distribution is deferred.
- All current builtin, custom, explicit-file, convention-file, scope, harness, activity, and local-dashboard behavior remains available.
- Agent hook decisions are synchronous and evaluated locally in v1.0.0.
- Collection, delivery, optional cloud reconciliation, and harness schema-catalog refresh are asynchronous.
- Failproof Cloud adds centralized management and observability-driven workflows; it does not replace local policy authoring or enforcement.
- Connected cloud policy can target organization, environment, machine, agent, and session scope.
- A later version may move evaluation into the cloud without changing harness integrations.
- v1 does not automatically update native binaries; customers upgrade them explicitly through npm setup.
