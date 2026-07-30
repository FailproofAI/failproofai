# failproofai v1.0.0 design documents

This directory contains checked-in design documents for the next major version of failproofai.

The work is split into two phases along one line: **Phase 1 is the product as it ships today, re-architected. Phase 2 is what does not exist yet.**

## Documents

- [Phase 1 — local enforcement plane](./phase-1-local-enforcement/) — the `failproofaid` daemon, harness integration, execution tiers, service and schema updates, the local dashboard, the full `agenteye-collector` including delivery, delivery plan, and npm distribution.
- [Phase 2 — cloud management plane](./phase-2-cloud/) — machine enrollment into Failproof Cloud, centrally assigned policy, targeting, fleet health, and staged rollout.

## Why the split

Phase 1 answers "can an agent be prevented from doing this on my machine, can it undo the prevention, and can I see what it did?" All of that is answerable with the machine and the customer's own infrastructure. Everything currently shipped belongs here — including capture and delivery, which needs no FailproofAI account because it targets a self-hosted server with an operator-issued key.

Phase 2 answers "can one team manage that across a fleet?" That needs a machine identity in Failproof Cloud, which is genuinely new. It is additive by construction: a machine that never enrolls must behave exactly as it did under Phase 1, capture and delivery included. Phase 1 therefore leaves contract-shaped room — a canonical location-independent request/result model, end-to-end deadlines, stable decision identity, bounded lanes, a versioned health snapshot, one spool — and adds no configuration key, client, or user-visible setting for the phase that follows it.

The test for which phase something belongs to is whether a customer can already do it today. If yes, it is Phase 1 regardless of whether it touches a network or a credential.
