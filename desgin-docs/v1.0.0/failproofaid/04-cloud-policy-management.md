# Cloud policy management and decision evolution

## Purpose

The FailproofAI cloud is the management plane for a fleet of local `failproofaid` enforcement planes. AgentEye data closes the loop between observing agent behavior and deploying a guardrail:

1. analysis identifies risky behavior or a failed outcome;
2. a user creates or accepts a policy draft from that evidence;
3. historical data estimates its match set where possible;
4. the policy is assigned in observe mode to a narrow cohort;
5. AgentEye reports matches, would-deny results, latency, and outcome changes;
6. an authorized user promotes the same immutable revision to enforce mode;
7. the assignment can expand, pause, expire, narrow, or roll back.

Cloud availability is not required for locally evaluated policy. Assignments configured for cloud or hybrid evaluation use the cloud as a synchronous decision plane through `failproofaid`.

## Configurable decision plane

The product supports three evaluation locations:

1. **Local** — the cloud may create, assign, and measure policy, while the daemon downloads verified state and evaluates it locally.
2. **Cloud** — the daemon sends a synchronous, bounded request to the decision service. This supports policy using current AgentEye analysis, organization-wide state, centrally operated models, or data not copied into every local artifact.
3. **Hybrid** — mandatory or latency-sensitive policy evaluates locally and is combined with a cloud decision under configured rules.

Cloud evaluation does not make harnesses cloud clients. Agent harnesses continue talking only to the local daemon, which owns authentication, canonicalization, privacy filtering, deadlines, fallback, and decision evidence.

The organization configures permitted locations and a default. Each assignment declares `evaluation_location: local | cloud | hybrid`; an omitted value uses that organization default. Only authorized roles can override it. A cloud assignment additionally declares:

- required canonical input fields and whether sensitive content can be sent;
- maximum decision budget within the harness deadline;
- unavailable-service and timeout behavior;
- whether any response is cacheable and its exact cache key/TTL contract;
- regional/data-residency endpoint requirements;
- the local fallback policy revision, when one exists.

The cloud decision request carries organization, machine, agent, session, event, policy/assignment revision, request ID, remaining deadline, and only the policy-declared event fields. Its authenticated response carries a stable decision ID, result, safe explanation, revision evidence, and service timing.

Hybrid mode supports local baseline enforcement plus cloud context. Combination rules are part of the immutable assignment; a late cloud response is discarded and cannot change an action already returned to the harness.

Changing location, timeout, disclosed fields, fallback, region, or cache policy creates a new assignment revision. The dashboard previews these settings and their operational/privacy consequences before activation.

## Identity and targeting

Each daemon installation has a stable non-secret machine ID and a rotatable credential bound to an organization. Effective targeting context may include:

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

## Precedence and decisions

Administrative authority is evaluated in this order:

1. product-mandatory policy;
2. cloud organization/environment/machine/agent/session assignments;
3. locally configured builtin policy;
4. local custom and convention policy.

All unsuppressed matching policies run. Result severity is `deny`, then `instruct`, then `allow`. Stable policy and assignment IDs prevent name collisions.

Every result records policy revision, assignment ID and scope, generation, target context and identity provenance, observe/enforce effect, policy result, effective harness action, and timing. This lets AgentEye attribute a decision to the exact rollout that produced it.

## Offline, timeout, and expiry

The daemon persists the last verified assignment generation. Local policy continues to evaluate from that state. Before assignment expiry it reports increasing management staleness; after expiry, each assignment declares whether to continue local enforcement, fall back to observe, or fail closed for a narrowly defined mandatory control.

Cloud/hybrid evaluation separately declares behavior when the synchronous decision service is slow or unreachable. Management-plane freshness and decision-plane availability are distinct health signals: a machine can have current assignments while its decision region is unavailable, or an available decision service while assignment reconciliation is stale.

Ordinary organization policy defaults to continuing last known-good enforcement rather than silently removing guardrails. A machine that has never synchronized uses local policy only.

Health distinguishes `connected`, `stale`, `expired`, `rejected`, and `never_synced`. Server time and bounded clock-skew evidence support expiry decisions.

## Rollout controls

Cloud deployment supports observe-before-enforce, staged cohorts, activation time, expiry, pause, rollback, and a strongly authorized emergency override with an audit reason.

Rollout telemetry includes acknowledgement and freshness, match/decision volume, evaluation errors, timeouts, latency, and effective harness action. Configured thresholds can automatically halt expansion when a revision behaves unexpectedly.

AI-generated policy never bypasses authorization. Organizations define who may create, approve, enforce, disable, and fleet-deploy policy.

## Security requirements

- Machine control-plane credentials are separate from event-ingest and update credentials.
- Policy releases and desired-state snapshots are signed, organization-bound, content-addressed, and replay-resistant.
- Cloud policy has declared limited capabilities and no ambient host authority.
- Targeting labels are minimized and treated as customer data.
- Prompt, transcript, and tool-result content is not required merely to resolve an assignment.
- Cloud decision requests disclose only policy-declared fields, honor regional routing, and produce auditable disclosure metadata.
- Credential rotation, machine revocation, publisher-key rotation, and emergency policy revocation have explicit protocols.
