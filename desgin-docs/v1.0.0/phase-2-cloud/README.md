# Phase 2 — account, cloud management, and delivery

Status: Draft

Target: after [Phase 1](../phase-1-local-enforcement/README.md) is the default

Phase 2 is the new management plane: machine enrollment into Failproof Cloud, centrally assigned policy, targeting, fleet health, and staged rollout, on top of the Phase 1 enforcement plane.

It is scoped to what does not exist today. Everything the current product already ships — enforcement, policy authoring, the local dashboard, and the whole `agenteye-collector` including delivery to a customer's self-hosted server — is [Phase 1](../phase-1-local-enforcement/README.md), because the compatibility promise covers it.

**Phase 2 is additive by construction.** A machine that never enrolls must behave exactly as it did under Phase 1 — same decisions, same latency, same local authoring, same capture and delivery, same offline behavior, no dormant client, no machine credential on disk. Every stage of the plan is gated on that.

## Documents

1. [Login, machine identity, and enrollment](./01-login-and-enrollment.md) — the Login/OSS setup choice, sign-in, the transactional enrollment sequence, the machine credential, connected health, and connected uninstall.
2. [Failproof Cloud policy management](./02-cloud-policy-management.md) — additive centralized assignments and the observability-to-enforcement loop, without replacing local policy authoring.
3. [Delivery plan](./03-delivery-plan.md) — stages, acceptance criteria, and unresolved decisions.

## Settled decisions

- Failproof Cloud adds centralized management and observability-driven workflows; it does not replace local policy authoring or enforcement.
- All policy evaluation stays local in Phase 2. Assignments and artifacts synchronize asynchronously; hook decisions still make no network request.
- Connected cloud policy can target organization, environment, machine, agent, and session scope. Project/workspace, canonical event, and tool are match dimensions rather than administrative parent scopes.
- The effective policy set is additive. A cloud `disabled` assignment can suppress a specifically inherited cloud assignment when authorized; it can never disable a user's local policy.
- Enrollment, credential exchange, activation, status lookup, and deactivation share one stable setup-transaction idempotency key, so a retry cannot create a second machine and an ambiguous response is resolved by status lookup.
- The machine credential lives with the installation it belongs to — in the user's own configuration, like the delivery key — never in a service definition or process argument, and erased unconditionally on uninstall, including offline. Phase 1 ships user scope, so a "machine" identity is per-installation; a fleet that needs one identity per host rather than one per user needs a [deferred scope](../phase-1-local-enforcement/04-service-and-updates.md#deferred-scopes) first.
- The machine control-plane credential is a **new and separate** credential. It is not the user's `failproofai auth login` token and not the collector's `events:add` key; compromising any one of them confers neither of the others.
- Cloud-created policy needs a deterministic, capability-limited representation. Phase 1's JavaScript worker exists for code the machine's own users authored; it is not authority to execute arbitrary remote JavaScript with that user's filesystem, environment, process, or network access.
- Phase 2 adds one execution lane, management, to the bounds Phase 1 already established. It reuses the existing spool and delivery machinery rather than introducing a second one.
- Moving evaluation off the machine remains a later, separate question. Phase 1's canonical location-independent request/result model keeps it open; nothing in Phase 2 commits to it.
