# `failproofaid` design

Status: Draft

Target: failproofai v1.0.0

`failproofaid` is the Rust background service for FailproofAI. It preserves the complete standalone OSS policy experience, incorporates AgentEye collector behavior, optionally synchronizes centrally managed policy assignments for the cloud tier, and updates safely through an external updater.

## Documents

1. [User experience](./01-user-experience.md) — how a user installs, configures, operates, and removes FailproofAI.
2. [Agent harness integration](./02-harness-integration.md) — how agent CLIs and runtimes send events and enforce daemon decisions.
3. [Daemon architecture](./03-daemon-architecture.md) — Rust process model, IPC, policy runtime, failure isolation, and local state.
4. [Optional cloud policy tier](./04-cloud-policy-management.md) — additive centralized assignments and the AgentEye-to-enforcement loop without replacing OSS policy authoring.
5. [Collector integration](./05-collector-integration.md) — session capture, durable spooling, delivery, and migration from AgentEye collector.
6. [Service and automatic updates](./06-service-and-updates.md) — operating-system services, signed releases, activation, health checks, and rollback.
7. [Delivery plan](./07-delivery-plan.md) — rollout phases, acceptance criteria, and unresolved decisions.
8. [Release and package distribution](./08-release-and-packaging.md) — build pipeline, signed artifacts, package managers, customer download paths, and channel promotion.

## Settled decisions

- `failproofaid` is implemented in Rust.
- It is a per-user operating-system service by default.
- v1.0.0 supports Linux and macOS; Windows service, packaging, and daemon support are deferred to the next iteration.
- The OSS product remains fully usable without an account, organization, AgentEye, or network connection.
- All current builtin, custom, explicit-file, convention-file, scope, harness, activity, and local-dashboard behavior remains available.
- Agent hook decisions are synchronous and evaluated locally in v1.0.0.
- Collection, delivery, optional cloud reconciliation, and update discovery are asynchronous.
- The cloud tier adds centralized management and AgentEye-driven workflows; it does not replace local policy authoring or enforcement.
- Connected cloud policy can target organization, environment, machine, agent, and session scope.
- A later version may move evaluation into the cloud without changing harness integrations.
- The running daemon never replaces or terminates itself to activate an update.
