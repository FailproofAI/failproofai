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
- Prove parity for all current OSS builtin, custom, convention, scope, harness, activity, dashboard, and audit workflows without authentication.
- Gate expansion on compatibility, deadline success, crash recovery, and resource use.

## Phase 2: collector convergence

- Move collector modules into the daemon with conformance behavior intact.
- Migrate pending state and checkpoints from the legacy collector state directory.
- Prove single ownership, delivery health, and rollback before removing the old service.

## Phase 3: cloud-managed local enforcement

- Add signed immutable policy releases and atomic desired-state generations.
- Launch observe-only narrow cohorts first.
- Add approval, staged promotion, pause, expiry, rollback, and rollout-halting telemetry.
- Enable cloud-assigned, locally evaluated enforcement only after attribution and offline behavior pass end-to-end tests.
- Verify connecting and disconnecting the tier does not alter local policy behavior.

## Phase 4: harness schema catalog

- Extract harness-version detection and declarative hook schemas into a signed data-only catalog.
- Ship a bundled offline baseline, then add automatic signed catalog refresh.
- Prove version selection, semantic hook migration, atomic activation, rejection, and catalog/schema rollback.
- Keep native binary upgrades explicit through the npm setup path.

## Phase 5: v1 default

- Install `failproofaid` during setup and route harnesses to it by default.
- Retain legacy evaluator and collector rollback paths for a defined window.
- Remove old artifacts only after success thresholds and rollback windows are met.

## Product acceptance criteria

- One setup command reaches a healthy daemon and enforced synthetic event.
- Standalone setup and every current policy workflow require no account or cloud connection.
- Warm policy evaluation meets agreed p95/p99 latency under simultaneous capture, backfill, upload, and sync load.
- Existing builtin and JS/TS local policies preserve behavior.
- Every harness produces the same canonical and native result for golden fixtures.
- Cloud targeting resolves deterministically without crossing organization/machine boundaries.
- Cloud outage and daemon restart preserve last known-good enforcement.
- Local policy behavior is identical before, during, and after optional cloud enrollment.
- Invalid or partial generations never activate.
- Failproof Cloud attributes each decision to exact policy and assignment revisions.
- Collector crash/replay tests prove durable, idempotent delivery.
- Broken harness schemas roll back automatically on every supported platform without replacing the daemon.

## Open decisions

1. Enforcement p95/p99 targets and per-harness maximum deadlines.
2. Default behavior after migration when the daemon is unavailable.
3. Which runtime is pinned and shipped for the `sealed` tier, and its patch cadence. A runtime that is also a bundler removes a separate toolchain from admission.
4. Sandboxed/declarative format for cloud-created policy in the Rust plane.
5. Collector sources required for v1 release day.
6. Default observability consent and capture choices.
7. Spool quotas and queue priority.
8. Policy release and application release signing/trust-root rotation.
9. Catalog refresh cadence, retention, and locally pinned catalog policy.
10. Retention window for legacy evaluator, collector state, and previous release.
11. Roles allowed to create, approve, assign, disable, and emergency-override policy.
12. Whether narrower scope may disable organization policy and which controls are mandatory.
13. Propagation SLO and maximum policy staleness for ordinary/emergency changes.
14. Targeting attributes permitted to leave a machine.
15. Which mechanism launches the `user-context` worker — a per-user service in that user's own service manager, a privileged spawn helper, or the hook client. All three end in a process the requesting user can already `ptrace`, so this is an operational choice about supervision and cold-start latency against the enforcement deadline, not a security one.
16. Whether `managed` scope supersedes `system` scope entirely. System scope currently earns its place only through root-owned `/etc` configuration for fleet tooling and serving agents that run as root; if neither materializes with customers, the third option should be removed rather than maintained.
17. Credential model for protected policies that need remote state. A `sealed` policy cannot read the developer's `~/.config/gh` and needs its own machine credential or a brokered token.
18. Freshness bounds and staleness semantics for the collection-lane cache that policies read instead of performing their own I/O.
19. Capability vocabulary a policy declares at admission, and how an existing custom policy's requirements are inferred when it declares nothing.
