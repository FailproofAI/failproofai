# Delivery plan

Stages are numbered independently of the Phase 1 / Phase 2 product split. All five stages below are Phase 1; [Phase 2 has its own plan](../phase-2-cloud/04-delivery-plan.md).

## Stage 0: contracts and measurements

- Freeze golden fixtures for every supported harness event and response.
- Record current hook startup and decision latency distributions.
- Define the IPC, decision-evidence, local-state, and signed-release contracts.
- Establish the canonical request/result model, per-lane bounds, and versioned health snapshot that Phase 2 extends rather than reshapes.

## Stage 1: daemon-assisted enforcement

- Ship the service and native hook client behind opt-in setup.
- Keep the current evaluator as a bounded migration fallback.
- Compare daemon and legacy decisions in shadow mode.
- Prove parity for all current OSS builtin, custom, convention, scope, harness, activity, dashboard, and audit workflows, including the dashboard's move from a fixed port to a CLI-spawned, token-gated, TTL-bounded listener.
- Prove the privileged install layout end to end: service-account creation, root-owned protected surface, `sealed` and `user-context` routing derived from resolved import graphs, and preflight refusal on a machine that cannot host the boundary.
- Gate expansion on compatibility, deadline success, crash recovery, and resource use.

## Stage 2: local session indexing

- Index the selected local session sources for activity, audits, and the dashboard, behind explicit per-source consent.
- Align indexed session identity with enforcement identity so a decision and a session from one harness run join on stable identifiers.
- Leave the existing standalone collector untouched and delivering; converging it belongs to Phase 2, together with the credential that authorizes its delivery.

## Stage 3: harness schema catalog

- Extract harness-version detection and declarative hook schemas into a signed data-only catalog.
- Ship a bundled offline baseline, then add automatic signed catalog refresh.
- Prove version selection, semantic hook migration, atomic activation, rejection, and catalog/schema rollback.
- Keep native binary upgrades explicit through the npm setup path.

## Stage 4: Phase 1 default

- Install `failproofaid` during setup and route harnesses to it by default.
- Retain the legacy evaluator rollback path for a defined window.
- Remove old artifacts only after success thresholds and rollback windows are met.

## Product acceptance criteria

- One setup command reaches a healthy daemon and enforced synthetic event.
- Setup and every current policy workflow require no account, and no shipped code path authenticates to a remote service.
- Warm policy evaluation meets agreed p95/p99 latency under simultaneous session-indexing and catalog-refresh load.
- Existing builtin and JS/TS local policies preserve behavior.
- Every harness produces the same canonical and native result for golden fixtures.
- Daemon restart preserves last known-good enforcement.
- Invalid or partial generations never activate.
- Each decision is attributable to an exact policy revision, generation, and execution tier.
- Broken harness schemas roll back automatically on every supported platform without replacing the daemon.
- A machine without administrator access or a supported service manager is refused in preflight rather than partially installed.

## Open decisions

1. Enforcement p95/p99 targets and per-harness maximum deadlines.
2. Default behavior after migration when the daemon is unavailable.
3. Which runtime is pinned and shipped for the `sealed` tier, and its patch cadence. A runtime that is also a bundler removes a separate toolchain from admission.
4. Which local session sources are indexed at release, and which are enabled by default.
5. Activity-store retention, quota, and shedding rule.
6. Application-release signing and trust-root rotation.
7. Catalog refresh cadence, retention, and locally pinned catalog policy.
8. Retention window for the legacy evaluator and the previous release.
9. Which mechanism launches the `user-context` worker — a per-user service in that user's own service manager, a privileged spawn helper, or the hook client. All three end in a process the requesting user can already `ptrace`, so this is an operational choice about supervision and cold-start latency against the enforcement deadline, not a security one.
10. Credential model for protected policies that need remote state. A `sealed` policy cannot read the developer's `~/.config/gh` and needs its own machine credential or a brokered token.
11. Freshness bounds and staleness semantics for the maintenance-lane cache that policies read instead of performing their own I/O.
12. Capability vocabulary a policy declares at admission, and how an existing custom policy's requirements are inferred when it declares nothing.
13. Whether a dashboard toggle of a `mutable` policy writes the user's configuration file directly or goes through a daemon operation. The file is what happens today and needs no new protocol, but #623 already had dashboard toggle state diverge from the runtime project/local/user merge once, and a filesystem write path keeps that logic in two implementations.
14. Default dashboard TTL, and whether an administrator UI for protected revisions is ever warranted beyond the copyable `sudo` command — an ephemeral `--admin` instance and in-place elevation via polkit / Authorization Services are the two candidates if it is.

## Resolved

**Which service scopes ship: one, `managed`.** A root-owned `system` scope and an unprivileged `user` scope are designed and deferred until a customer needs them, recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes). Shipping one removes a privilege decision from setup and lets every guarantee in these documents be stated unconditionally instead of qualified three ways. It costs the ability to install without administrator access, which preflight refuses explicitly rather than working around.
