# failproofai v1.0.0 design documents

This directory contains checked-in design documents for the next major version of failproofai.

The work is split into two phases. Phase 1 is a complete, shippable product on its own; Phase 2 is everything that requires an account.

## Documents

- [Phase 1 — local enforcement plane](./phase-1-local-enforcement/) — the `failproofaid` daemon, harness integration, execution tiers, service and schema updates, the local dashboard, delivery plan, and npm distribution. No account, no sign-in, no network service in the decision path.
- [Phase 2 — account, cloud management, and delivery](./phase-2-cloud/) — login and machine enrollment, centrally assigned policy, fleet health, and collector convergence with event delivery.

## Why the split

Phase 1 answers "can an agent be prevented from doing this on my machine, and can it undo the prevention?" That question is answerable with nothing but the machine, and shipping it alone gets the enforcement boundary in front of users without an account, an organization, or a backend on the critical path.

Phase 2 answers "can one team manage that across a fleet?" It is additive by construction: a machine that never signs in must behave exactly as it did under Phase 1. Phase 1 therefore leaves contract-shaped room — a canonical location-independent request/result model, end-to-end deadlines, stable decision identity, bounded lanes, a versioned health snapshot — and adds no configuration key, client, or user-visible setting for the phase that follows it.
