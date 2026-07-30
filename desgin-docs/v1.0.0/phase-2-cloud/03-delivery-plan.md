# Delivery plan

Phase 2 starts after [Phase 1](../phase-1-local-enforcement/README.md) is the default and its rollback windows have closed. Every stage below must leave a machine that never signs in behaving exactly as it did.

## Stage 0: contracts

- Define machine identity, desired state, policy release, assignment, and acknowledgement contracts.
- Extend the Phase 1 health snapshot and `Query` operations with cloud subsystems, additively.
- Reuse Phase 1's spool and delivery machinery rather than adding a second path.

## Stage 1: login and enrollment

- Add the Login/OSS mode step, sign-in, pending machine identity, and the transactional enrollment/activation sequence keyed by one stable setup-transaction key.
- Prove compensation: failure at every step restores prior local state and leaves no orphaned pending or activated identity.
- Prove that an ambiguous activation response resolves by status lookup rather than by retry.
- Ship no assignment consumption yet — enrollment alone, so identity and credential handling are provable in isolation.

## Stage 2: cloud-managed local enforcement

- Add signed immutable policy releases and atomic desired-state generations.
- Launch observe-only narrow cohorts first.
- Add approval, staged promotion, pause, expiry, rollback, and rollout-halting telemetry.
- Enable cloud-assigned, locally evaluated enforcement only after attribution and offline behavior pass end-to-end tests.
- Verify that connecting and disconnecting the tier does not alter local policy behavior.

## Acceptance criteria

- A machine that never enrolls is unaffected by every stage above, including its capture and delivery behavior.
- Cloud targeting resolves deterministically without crossing organization/machine boundaries.
- Cloud outage and daemon restart preserve last known-good enforcement.
- Failproof Cloud attributes each decision to exact policy and assignment revisions.
- Enrolling does not change which sources are captured or where their data is delivered.
- Uninstall leaves no machine credential on disk, including when performed offline.

## Open decisions

1. Sandboxed or declarative format for cloud-created policy in the Rust plane. A legacy JavaScript worker exists for locally authored policy; it is not authority to execute arbitrary remote JavaScript with the user's filesystem, environment, process, or network access.
2. Policy release signing and trust-root rotation.
3. Roles allowed to create, approve, assign, disable, and emergency-override policy.
4. Whether narrower scope may disable organization policy, and which controls are mandatory.
5. Propagation SLO and maximum policy staleness for ordinary and emergency changes.
6. Targeting attributes permitted to leave a machine.
7. Whether a machine enrolled in Failproof Cloud may also be pointed at a self-hosted observability server, and whether the two destinations share one spool or two.
8. Whether cloud-side evaluation is pursued at all after Phase 2, and if so, its latency, availability, privacy, residency, caching, and outage contract. Phase 1's canonical request/result model keeps the option open without committing to it.
