# Failproof Cloud policy management

## Purpose

FailproofAI OSS remains a complete standalone policy system. Users author and run builtin or custom policy locally without an account, machine enrollment, organization, or cloud service.

Failproof Cloud adds centralized management for fleets of `failproofaid` enforcement planes. It does not replace, gate, or remove local policy authoring. FailproofAI observability data closes the loop between observing agent behavior and deploying an additional centrally managed guardrail:

1. analysis identifies risky behavior or a failed outcome;
2. a user creates or accepts a policy draft from that evidence;
3. historical data estimates its match set where possible;
4. the policy is assigned in observe mode to a narrow cohort;
5. Failproof Cloud reports matches, would-deny results, latency, and outcome changes;
6. an authorized user promotes the same immutable revision to enforce mode;
7. the assignment can expand, pause, expire, narrow, or roll back.

Cloud availability is not required for standalone operation or an individual v1.0.0 hook decision because policy is evaluated locally.

## Future direction: cloud evaluation

Moving synchronous policy evaluation into the cloud is a planned later iteration, not part of the v1.0.0 implementation or user experience.

The v1.0.0 boundary is chosen so harnesses will not need reintegration: they always call the local daemon using a canonical request and receive a canonical result. A future design must separately specify cloud latency, availability, privacy, data residency, caching, and outage behavior before implementation. Those controls are deliberately absent from the current configuration schema.

## Identity and targeting

Only a connected daemon installation has a cloud machine ID and rotatable credential bound to an organization. A standalone installation creates neither. Connected targeting context may include:

```text
organization -> environment -> machine -> agent -> session
```

Project/workspace, canonical event, and tool are additional match dimensions rather than administrative parent scopes.

Assignments have one effect:

- `enforce` — apply the policy result;
- `observe` — evaluate and record without changing harness behavior;
- `disabled` — suppress a named inherited assignment when the actor has authority.

Narrow scope does not automatically erase broader safety policy. Missing session identity never broadens a session assignment to an agent or machine.

## Policy releases and assignments

A policy release is immutable and content-addressed. It includes policy ID and revision, artifact, required runtime/API version, declared events and capabilities, resource limits, human description and provenance, digest, and publisher signature.

An assignment references a release and supplies target, effect, priority, rollout cohort, activation/expiry, emergency status, and assignment revision. Rollback changes desired assignment state; it never mutates a release.

The server returns explicit assignment IDs and precedence metadata. The daemon validates organization and machine binding rather than reproducing a changing cloud query language.

## Reconciliation

The management lane:

1. authenticates with the machine credential;
2. sends capabilities, current revision, runtime version, and minimized targeting labels;
3. receives a snapshot/delta and missing immutable artifacts;
4. verifies target binding, signatures, hashes, compatibility, validity, and resource limits;
5. constructs a complete candidate generation;
6. atomically activates it;
7. acknowledges the active revision or reports structured rejection.

Polling with jitter is the baseline. A push notification may prompt an immediate authenticated fetch but never carries trusted executable state itself.

Partial activation is forbidden. Missing, invalid, incompatible, replayed, or tampered state leaves the last known-good generation active.

## Coexistence with local policy

The effective policy set on a connected machine is additive:

1. locally configured builtin policy;
2. local explicit custom policy;
3. local project/user convention policy;
4. cloud organization/environment/machine/agent/session assignments.

All matching policies run. Result severity is `deny`, then `instruct`, then `allow`. Stable source-qualified policy and assignment IDs prevent name collisions. A cloud `disabled` assignment can suppress a specifically inherited cloud assignment when authorized; it cannot disable a user's local policy. Local policy can be disabled only through the existing local configuration and file workflows.

Every result records policy revision, assignment ID and scope, generation, target context and identity provenance, observe/enforce effect, policy result, effective harness action, and timing. This lets Failproof Cloud attribute a decision to the exact rollout that produced it.

## Offline and expiry

The daemon persists the last verified assignment generation. Policy continues to evaluate locally from that state. Before assignment expiry it reports increasing management staleness; after expiry, each assignment declares whether to continue local enforcement, fall back to observe, or fail closed for a narrowly defined mandatory control.

Ordinary organization policy defaults to continuing last-known-good enforcement rather than silently removing guardrails. Local policy continues independently. A standalone machine has no cloud synchronization state at all.

Health distinguishes `connected`, `stale`, `expired`, `rejected`, and `never_synced`. Server time and bounded clock-skew evidence support expiry decisions.

## Rollout controls

Cloud deployment supports observe-before-enforce, staged cohorts, activation time, expiry, pause, rollback, and a strongly authorized emergency override with an audit reason.

Rollout telemetry includes acknowledgement and freshness, match/decision volume, evaluation errors, timeouts, latency, and effective harness action. Configured thresholds can automatically halt expansion when a revision behaves unexpectedly.

AI-generated policy never bypasses authorization. Organizations define who may create, approve, enforce, disable, and fleet-deploy policy.

## Security requirements

- Machine control-plane credentials are separate from event-ingest and harness-catalog retrieval credentials.
- Policy releases and desired-state snapshots are signed, organization-bound, content-addressed, and replay-resistant.
- Cloud policy has declared limited capabilities and no ambient host authority.
- Targeting labels are minimized and treated as customer data.
- Standalone operation creates no cloud machine identity and sends no policy, configuration, activity, or targeting data to FailproofAI.
- Prompt, transcript, and tool-result content is not required merely to resolve an assignment.
- Credential rotation, machine revocation, publisher-key rotation, and emergency policy revocation have explicit protocols.
