# Delivery plan

Phase 2 starts after [Phase 1](../phase-1-local-enforcement/README.md) is the default and its rollback windows have closed. Every stage below must leave a machine that never signs in behaving exactly as it did.

## Stage 0: contracts

- Define machine identity, desired state, policy release, assignment, acknowledgement, spool, and delivery contracts.
- Extract the existing collector's source and delivery conformance tests before touching its code.
- Extend the Phase 1 health snapshot and `Query` operations with cloud and delivery subsystems, additively.

## Stage 1: login and enrollment

- Add the Login/OSS mode step, sign-in, pending machine identity, and the transactional enrollment/activation sequence keyed by one stable setup-transaction key.
- Prove compensation: failure at every step restores prior local state and leaves no orphaned pending or activated identity.
- Prove that an ambiguous activation response resolves by status lookup rather than by retry.
- Ship no assignment consumption yet — enrollment alone, so identity and credential handling are provable in isolation.

## Stage 2: collector convergence

- Move collector modules into the daemon with conformance behavior intact.
- Migrate pending state and checkpoints from the legacy collector state directory.
- Prove single ownership, delivery health, and rollback before removing the old service.
- Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## Stage 3: cloud-managed local enforcement

- Add signed immutable policy releases and atomic desired-state generations.
- Launch observe-only narrow cohorts first.
- Add approval, staged promotion, pause, expiry, rollback, and rollout-halting telemetry.
- Enable cloud-assigned, locally evaluated enforcement only after attribution and offline behavior pass end-to-end tests.
- Verify that connecting and disconnecting the tier does not alter local policy behavior.

## Acceptance criteria

- A machine that never signs in is unaffected by every stage above.
- Cloud targeting resolves deterministically without crossing organization/machine boundaries.
- Cloud outage and daemon restart preserve last known-good enforcement.
- Failproof Cloud attributes each decision to exact policy and assignment revisions.
- Collector crash/replay tests prove durable, idempotent delivery, and replay creates no duplicate backend events.
- Old and new collectors can never own the same source concurrently.
- Migration rollback restores a functional standalone collector with its undelivered state.
- Backfill load cannot starve enforcement or recent delivery.
- Uninstall leaves no credential on disk, including when performed offline, and never silently deletes undelivered data.

## Open decisions

1. Sandboxed or declarative format for cloud-created policy in the Rust plane. A legacy JavaScript worker exists for locally authored policy; it is not authority to execute arbitrary remote JavaScript with the user's filesystem, environment, process, or network access.
2. Collector sources required for release day.
3. Default delivery consent and capture choices.
4. Spool quotas and queue priority.
5. Policy release signing and trust-root rotation.
6. Retention window for legacy collector state.
7. Roles allowed to create, approve, assign, disable, and emergency-override policy.
8. Whether narrower scope may disable organization policy, and which controls are mandatory.
9. Propagation SLO and maximum policy staleness for ordinary and emergency changes.
10. Targeting attributes permitted to leave a machine.
11. Whether cloud-side evaluation is pursued at all after Phase 2, and if so, its latency, availability, privacy, residency, caching, and outage contract. Phase 1's canonical request/result model keeps the option open without committing to it.
