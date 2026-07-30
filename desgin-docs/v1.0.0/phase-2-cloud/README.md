# Phase 2 — account, cloud management, and delivery

Status: Draft

Target: after [Phase 1](../phase-1-local-enforcement/README.md) is the default

Phase 2 is everything that needs an account. It adds login, machine enrollment, centrally assigned policy, fleet health, and event delivery on top of the Phase 1 local enforcement plane, and it converges the standalone collector into the daemon.

**Phase 2 is additive by construction.** A machine that never signs in must behave exactly as it did under Phase 1 — same decisions, same latency, same local authoring, same offline behavior, no dormant client, no credential on disk. Every stage of the plan is gated on that.

## Documents

1. [Login, machine identity, and enrollment](./01-login-and-enrollment.md) — the Login/OSS choice, sign-in, the transactional enrollment sequence, the machine credential, connected health, and connected uninstall.
2. [Failproof Cloud policy management](./02-cloud-policy-management.md) — additive centralized assignments and the observability-to-enforcement loop, without replacing local policy authoring.
3. [Collector convergence and delivery](./03-collector-and-delivery.md) — session capture, durable spooling, delivery, and migration from the existing collector.
4. [Delivery plan](./04-delivery-plan.md) — stages, acceptance criteria, and unresolved decisions.

## Settled decisions

- Failproof Cloud adds centralized management and observability-driven workflows; it does not replace local policy authoring or enforcement.
- All policy evaluation stays local in Phase 2. Assignments and artifacts synchronize asynchronously; hook decisions still make no network request.
- Connected cloud policy can target organization, environment, machine, agent, and session scope. Project/workspace, canonical event, and tool are match dimensions rather than administrative parent scopes.
- The effective policy set is additive. A cloud `disabled` assignment can suppress a specifically inherited cloud assignment when authorized; it can never disable a user's local policy.
- Enrollment, credential exchange, activation, status lookup, and deactivation share one stable setup-transaction idempotency key, so a retry cannot create a second machine and an ambiguous response is resolved by status lookup.
- The machine credential belongs to the machine, is readable by the daemon's service account and not by enrolled users, never lives under a user's home, and is erased unconditionally on uninstall — including offline.
- Machine control-plane credentials are separate from event-ingest and catalog-retrieval credentials.
- Cloud-created policy needs a deterministic, capability-limited representation. Phase 1's JavaScript worker exists for code the machine's own users authored; it is not authority to execute arbitrary remote JavaScript with that user's filesystem, environment, process, or network access.
- Collector convergence lands here rather than in Phase 1, because taking over delivery requires the credential that authorizes it. Until then the standalone collector is left running and untouched.
- Delivery is crash-durable and idempotent: a record is acknowledged locally by fsynced state transition before its payload is removed, and replay of the same stable ID yields the same acknowledgement.
- Moving evaluation off the machine remains a later, separate question. Phase 1's canonical location-independent request/result model keeps it open; nothing in Phase 2 commits to it.
