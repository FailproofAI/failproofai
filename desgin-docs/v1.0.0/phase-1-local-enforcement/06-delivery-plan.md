# Delivery plan

Stages are numbered independently of the Phase 1 / Phase 2 product split. All five stages below are Phase 1; [Phase 2 has its own plan](../phase-2-cloud/03-delivery-plan.md).

## Stage 0: contracts and measurements

- Freeze golden fixtures for every supported harness event and response.
- Record current hook startup and decision latency distributions.
- Extract the existing collector's source and delivery conformance tests before touching its code.
- Define the IPC, decision-evidence, spool, state, and signed-release contracts.
- Establish the canonical request/result model, per-lane bounds, and versioned health snapshot that Phase 2 extends rather than reshapes.
- Resolve which runtime is pinned for the `user-context` tier (open decision #3). It is here rather than with the runtime work because the release manifest schema, the SBOM, and the macOS entitlements file are all downstream of it, and entitlements are an input to signing.
- Start the signing and notarization identities — release trust root, Developer ID certificate, and `notarytool` credentials. They gate release rather than development, which is exactly why they are begun in parallel with engineering instead of discovered at the release gate.

## Stage 1: daemon-assisted enforcement

- Ship the service and native hook client behind opt-in setup.
- Keep the current evaluator as a bounded migration fallback.
- Compare daemon and legacy decisions in shadow mode.
- Prove parity for all current OSS builtin, custom, convention, scope, harness, activity, dashboard, and audit workflows, including the dashboard's move from a fixed port to a CLI-spawned, token-gated, TTL-bounded listener.
- Prove the privileged install layout end to end: service-account creation, root-owned protected surface, the root-owned pinned enabled set, `sealed` and `user-context` routing derived from resolved import graphs, and preflight refusal on a machine that cannot host the boundary.
- Gate expansion on compatibility, deadline success, crash recovery, and resource use.

## Stage 2: collector convergence

- Move collector modules into the daemon with conformance behavior intact, behind explicit per-source consent.
- Align captured session identity with enforcement identity so a decision and a session from one harness run join on stable identifiers.
- Migrate pending state and checkpoints from the legacy collector state directory under an ownership lock.
- Prove single ownership, delivery health, and rollback before removing the old service.

## Stage 3: harness schema catalog

- Extract harness-version detection and declarative hook schemas into a signed data-only catalog.
- Ship a bundled offline baseline, then add automatic signed catalog refresh.
- Prove version selection, semantic hook migration, atomic activation, rejection, and catalog/schema rollback.
- Keep native binary upgrades explicit through the npm setup path.

## Stage 4: Phase 1 default

- Install `failproofaid` during setup and route harnesses to it by default.
- Retain legacy evaluator and collector rollback paths for a defined window.
- Remove old artifacts only after success thresholds and rollback windows are met.

## Product acceptance criteria

- One setup command reaches a healthy daemon and enforced synthetic event.
- Setup and every current policy workflow require no FailproofAI account, and no policy decision depends on a network service.
- Warm policy evaluation meets agreed p95/p99 latency under simultaneous capture, backfill, upload, and catalog-refresh load.
- Existing builtin and JS/TS local policies preserve behavior.
- Every harness produces the same canonical and native result for golden fixtures.
- Daemon restart preserves last known-good enforcement.
- Invalid or partial generations never activate.
- Each decision is attributable to an exact policy revision, generation, execution tier, and attestation, and a decision that read a client-asserted host field is never reported as fully attested.
- A pinned policy cannot be disabled or reparameterized without elevation, and a user's own configuration can still enable and parameterize policies of its own.
- Collector crash/replay tests prove durable, idempotent delivery, and replay creates no duplicate events.
- Every source resumes from a crash-safe checkpoint, and backfill cannot starve enforcement or recent delivery.
- Old and new collectors never own the same source concurrently; migration rollback restores a functional standalone collector with its undelivered state.
- Broken harness schemas roll back automatically on every supported platform without replacing the daemon.
- A machine without administrator access or a supported service manager is refused in preflight rather than partially installed.

## Open decisions

1. Enforcement p95/p99 targets and per-harness maximum deadlines.
2. Default behavior after migration when the daemon is unavailable.
3. Which runtime is pinned and shipped for the `user-context` tier, and its patch cadence. The `sealed` engine is settled and shipped — QuickJS-ng linked into the daemon with its bundle embedded at compile time — so what is open is the runtime that executes policies with real imports at the requesting UID. **This one sits on the release critical path, not the evaluation one**, earlier than its position in this list suggests: the runtime's version and digest are fields of the release manifest and entries in the SBOM, and whether it JITs determines the macOS entitlements file and whether the systemd unit can set `MemoryDenyWriteExecute=yes` — so the manifest schema, [signing, and notarization](./07-release-and-packaging.md#code-signing-and-notarization) all wait on it. It belongs with the Stage 0 contracts. A runtime that is also a bundler removes a separate toolchain from admission.
4. Collector sources required for release day, and which are enabled by default.
5. Default observability consent and capture choices.
6. Spool quotas, queue priority, and the shedding rule when a quota is reached.
7. Application-release signing and trust-root rotation, including custody of the Apple Developer ID identity and `notarytool` credentials that [code signing and notarization](./07-release-and-packaging.md#code-signing-and-notarization) requires. Enrollment and certificate issuance are long-lead non-code items that gate the macOS half of the target matrix.
8. Catalog refresh cadence, retention, and locally pinned catalog policy.
9. Retention window for the legacy evaluator, legacy collector state, and the previous release.
10. Which mechanism launches the `user-context` worker — a per-user service in that user's own service manager, a privileged spawn helper, or the hook client. All three end in a process the requesting user can already `ptrace`, so this is an operational choice about supervision and cold-start latency against the enforcement deadline, not a security one.
11. Credential model for protected policies that need remote state. A `sealed` policy cannot read the developer's `~/.config/gh` and needs its own machine credential or a brokered token.
12. Freshness bounds and staleness semantics for the collection-lane cache that policies read instead of performing their own I/O.
13. Capability vocabulary a policy declares at admission, and how an existing custom policy's requirements are inferred when it declares nothing.
14. Whether a dashboard toggle of a `mutable` policy writes the user's configuration file directly or goes through a daemon operation. The file is what happens today and needs no new protocol, but #623 already had dashboard toggle state diverge from the runtime project/local/user merge once, and a filesystem write path keeps that logic in two implementations.
15. Default dashboard TTL, and whether an administrator UI for protected revisions is ever warranted beyond the copyable `sudo` command — an ephemeral `--admin` instance and in-place elevation via polkit / Authorization Services are the two candidates if it is.
16. Whether the observability delivery key rotates in place, and how a key rejected mid-spool is surfaced without stalling capture.

## Resolved

**Which service scopes ship: one, `managed`.** A root-owned `system` scope and an unprivileged `user` scope are designed and deferred until a customer needs them, recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes). Shipping one removes a privilege decision from setup and lets every guarantee in these documents be stated unconditionally instead of qualified three ways. It costs the ability to install without administrator access, which preflight refuses explicitly rather than working around.
