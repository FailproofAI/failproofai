# Delivery plan

## Phase 0: contracts and measurements

- Freeze golden fixtures for every supported harness event and response.
- Record current hook startup and decision latency distributions.
- Extract collector source and delivery conformance tests.
- Define IPC, machine identity, desired state, policy release, assignment, acknowledgement, decision evidence, spool, state, and signed-release contracts.

## Phase 1: daemon-assisted enforcement

- Ship service and native hook client behind opt-in setup.
- Keep the current evaluator as a bounded migration fallback.
- Compare daemon and legacy decisions in shadow mode.
- Reconcile cloud assignments in observe mode and test organization/machine/agent/session targeting.
- Gate expansion on parity, deadline success, crash recovery, and resource use.

## Phase 2: collector convergence

- Move collector modules into the daemon with conformance behavior intact.
- Migrate pending state and checkpoints from `~/.agenteye/`.
- Prove single ownership, delivery health, and rollback before removing the old service.

## Phase 3: cloud enforcement

- Add signed immutable policy releases and atomic desired-state generations.
- Launch observe-only narrow cohorts first.
- Add approval, staged promotion, pause, expiry, rollback, and rollout-halting telemetry.
- Enable enforcement only after attribution and offline behavior pass end-to-end tests.

## Phase 4: managed updates

- Begin with manual check and explicit activation.
- Add automatic staging, then opt-in automatic activation.
- Default stable standalone installs to automatic activation only after rollback drills pass on every supported platform.

## Phase 5: v1 default

- Install `failproofaid` during setup and route harnesses to it by default.
- Retain legacy evaluator and collector rollback paths for a defined window.
- Remove old artifacts only after success thresholds and rollback windows are met.

## Product acceptance criteria

- One setup command reaches a healthy daemon and enforced synthetic event.
- Warm policy evaluation meets agreed p95/p99 latency under simultaneous capture, backfill, upload, and sync load.
- Existing builtin and JS/TS local policies preserve behavior.
- Every harness produces the same canonical and native result for golden fixtures.
- Cloud targeting resolves deterministically without crossing organization/machine boundaries.
- Cloud outage and daemon restart preserve last known-good enforcement.
- Invalid or partial generations never activate.
- AgentEye attributes each decision to exact policy and assignment revisions.
- Collector crash/replay tests prove durable, idempotent delivery.
- Broken updates roll back automatically on every supported platform.

## Open decisions

1. Enforcement p95/p99 targets and per-harness maximum deadlines.
2. Default behavior after migration when the daemon is unavailable.
3. Runtime used for legacy local JavaScript/TypeScript policy.
4. Sandboxed/declarative format for cloud-created policy in the Rust plane.
5. Collector sources required for v1 release day.
6. Default observability consent and capture choices.
7. Spool quotas and queue priority.
8. Policy release and application release signing/trust-root rotation.
9. Automatic activation idle window and maximum deferral.
10. Retention window for legacy evaluator, collector state, and previous release.
11. Native Windows service versus scheduled task for initial v1.
12. Roles allowed to create, approve, assign, disable, and emergency-override policy.
13. Whether narrower scope may disable organization policy and which controls are mandatory.
14. Propagation SLO and maximum policy staleness for ordinary/emergency changes.
15. Targeting attributes permitted to leave a machine.
