# `failproofaid` design

Status: Draft

Target: failproofai v1.0.0

`failproofaid` is the Rust background service for FailproofAI. It is the local enforcement plane, incorporates AgentEye collector behavior, synchronizes centrally managed policy assignments, and updates safely through an external updater.

## Documents

1. [User experience](./01-user-experience.md) — how a user installs, configures, operates, and removes FailproofAI.
2. [Agent harness integration](./02-harness-integration.md) — how agent CLIs and runtimes send events and enforce daemon decisions.
3. [Daemon architecture](./03-daemon-architecture.md) — Rust process model, IPC, policy runtime, failure isolation, and local state.
4. [Cloud policy management](./04-cloud-policy-management.md) — centrally assigned policy state and the AgentEye-to-enforcement loop.
5. [Collector integration](./05-collector-integration.md) — session capture, durable spooling, delivery, and migration from AgentEye collector.
6. [Service and automatic updates](./06-service-and-updates.md) — operating-system services, signed releases, activation, health checks, and rollback.
7. [Delivery plan](./07-delivery-plan.md) — rollout phases, acceptance criteria, and unresolved decisions.
8. [Release and package distribution](./08-release-and-packaging.md) — build pipeline, signed artifacts, package managers, customer download paths, and channel promotion.

## Settled decisions

- `failproofaid` is implemented in Rust.
- It is a per-user operating-system service by default.
- Agent hook decisions are synchronous and local.
- Collection, delivery, cloud reconciliation, and update discovery are asynchronous.
- The FailproofAI cloud is the management plane; `failproofaid` is the local enforcement plane.
- Cloud policy can target organization, environment, machine, agent, and session scope.
- The running daemon never replaces or terminates itself to activate an update.
