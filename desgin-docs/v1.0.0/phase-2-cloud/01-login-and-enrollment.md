# Login, machine identity, and enrollment

Phase 1 needs no FailproofAI organization and no machine identity. This document adds both, and nothing here may change how a Phase 1 machine behaves until its owner deliberately enrolls it.

## What connecting adds

Enrolling adds centrally assigned policy, fleet health, analysis, staged rollout, and organization audit. It does not remove or subordinate anything: builtin policies, explicit custom files, convention discovery, local scopes, the local dashboard, local audits, and the machine's existing capture and delivery configuration all keep working exactly as they did, and a connected machine still evaluates every decision locally.

The connected workflow is:

1. inspect FailproofAI sessions, findings, or analysis;
2. create or select a policy;
3. choose organization, environment, machine, agent, or session targets;
4. deploy in observe mode;
5. inspect matches and would-block decisions;
6. promote the same policy revision to enforce mode;
7. expand, pause, expire, or roll back the assignment.

The daemon reconciles these changes automatically. A user does not run a sync command after a cloud change. Assignment semantics, precedence, and rollout controls are in [cloud policy management](./02-cloud-policy-management.md).

## Setup

Phase 2 inserts steps into the Phase 1 setup flow rather than replacing it. The Phase 1 steps — preflight, boundary disclosure, integrations, policies, observability, install, verify, report — stay in the same order and keep the same meaning.

The mode choice comes first, because it determines whether the enrollment steps run at all:

```text
◆ How do you want to use FailproofAI?

  ❯ Login   Local policies + Failproof Cloud, centralized policy management,
            machine/agent/session targeting, fleet health, and cloud sync.

    OSS     No organization or cloud required. Builtin and custom policies,
            convention discovery, session capture, local activity/dashboard,
            audits, and offline use.
```

**Login** is selected by default, but the user can move to **OSS** before continuing. The one-liners are product explanations, not license warnings. Login retains every OSS capability and adds connected functionality. OSS remains a complete supported path rather than a trial or degraded mode — it is exactly the Phase 1 product, capture and delivery included.

After the user selects a mode, the completed step stays visible as `Login · <organization>` or `OSS · local only`. Returning to the step and changing the choice updates the remaining flow before anything is applied.

Choosing Login adds four things:

- **Sign-in** — authenticate and create a time-bounded pending enrollment. Browser sign-in is preferred; device code supports headless machines.
- **Machine identity** — propose a display name and reserve a pending machine identity. It is not activated yet.
- **Assignment source** — cloud assignments appear in the policy step as an additional source alongside local policy.
- **Activation** — after local verification succeeds, exchange the pending enrollment for the machine credential, acknowledge the machine, and activate its identity.

Completion then reports organization, machine, and dashboard links, which a standalone install omits.

### The enrollment transaction

Setup is transactional across local *and* cloud effects, which is harder than the local-only case because a network call can succeed without the client learning that it did.

Enrollment, credential exchange, activation, status lookup, and deactivation all use one stable setup-transaction idempotency key. If a later step fails, setup restores the previous harness configuration and service state, revokes any issued machine credential, and idempotently cancels a pending identity or deactivates an already-activated one using that key.

An ambiguous activation response is resolved by querying activation status with the same key before retrying or compensating, so a retry can never create a second machine. Pending enrollments expire server-side if the client disappears before compensation, and activated-but-uncommitted identities are marked by the server for expiry unless setup durably commits. Re-running setup resumes or replaces the same transaction rather than creating duplicates.

Setup never leaves an apparently active cloud machine with no healthy local service.

### Non-interactive connected installation

Connected automation adds enrollment explicitly to the Phase 1 command:

```sh
sudo failproofai setup \
  --non-interactive \
  --mode login \
  --enrollment-token "$TOKEN" \
  --machine-name build-runner-07 \
  --harness claude --harness codex \
  --capture codex
```

`--mode oss` is the Phase 1 behavior and needs no token. Omitting `--mode` in non-interactive mode is an error rather than a default, so automation never enrolls a machine by accident.

## The machine credential

The one-time enrollment token is exchanged for a rotatable machine credential and then discarded. Secrets must not appear in generated service definitions or process arguments after enrollment.

The credential belongs to the machine, not to the user who ran setup. It is stored where the daemon's service account can read it and enrolled users cannot — inside the privileged state tree, never under `~`. It uses the operating-system credential store where practical, with an owner-only file as the portability fallback.

This is the machine's third credential and it is deliberately distinct from the other two. It is not the user's `failproofai auth login` token, and not the collector's `events:add` key for a self-hosted observability server; the control plane, the user session, and event ingest are separately scoped, so compromising any one of them confers neither of the others. Enrolling does not replace or rotate the collector's key, and does not change where captured data goes.

## Health

Connected installations add cloud subsystems to the Phase 1 health snapshot. Because that snapshot is versioned, this is an extension rather than a reshape:

- cloud state as `not_configured`, `connected`, `stale`, `expired`, `rejected`, or `never_synced`;
- cloud assignment generation alongside the local policy generation.

Capture and delivery health are already in the Phase 1 snapshot and are not restated here. On a standalone installation every cloud check reports `not_configured` — not a warning and not a failure.

A process can be running while policy sync is unhealthy. The UI must never collapse these into one green status.

## Offline behavior

The daemon additionally loads the last verified cloud assignment generation and continues enforcing it while the cloud is unavailable. Hook decisions still make no network request.

Ordinary organization policy continues from last-known-good state by default rather than silently disappearing. Connected users see the age and expiry state of cloud policy. Local policies are unaffected by cloud expiry.

Errors name the affected capability and the current safety behavior:

```text
Enforcement: healthy — generation 184 active
Cloud sync:  degraded — offline for 18m; generation 184 remains enforced
```

## Source labelling

Local policy files, builtin policies, and convention discovery remain active on a connected machine. The CLI labels every source and scope so nobody has to guess which plane produced a rule:

```text
SOURCE           SCOPE          MODE       POLICY
Failproof Cloud  organization   enforce    block-secret-exfiltration
Failproof Cloud  agent:codex    observe    require-tests-before-stop
Local            user           enforce    block-sudo
Local            project        enforce    repository-boundary
```

`policies explain` reports assignment scope and revision alongside the Phase 1 fields, so a decision on a connected machine remains attributable to the exact rollout that produced it.

## Uninstall

Connected uninstall extends the Phase 1 sequence with credential handling:

1. revoke the machine credential, or record revocation for its next connection;
2. securely erase the local machine credential and any cached token, retaining only a non-secret revocation tombstone when revocation could not be delivered.

Credentials are never part of preserved state. An uninstall performed offline must leave nothing on disk that could still authenticate, which is why erasure is unconditional rather than a consequence of a successful revocation call.

Cloud data and organization policy are not deleted by uninstalling one machine.

## Acceptance criteria

- A standalone Phase 1 machine that never enrolls behaves identically before and after Phase 2 ships, including which sources it captures and where their data goes.
- Connecting Failproof Cloud does not disable or subordinate user-authored local policy, and local policy behavior is identical before, during, and after enrollment.
- Re-running connected setup is idempotent; activation retries cannot create a second machine.
- An ambiguous activation response is resolved by status lookup before any retry or compensation.
- Setup failure restores prior service and harness configuration and leaves no orphaned pending or activated machine identity.
- No credential appears in a service definition, process argument, or log.
- The machine credential is unreadable by enrolled users and never stored under a user's home.
- Uninstall leaves no credential on disk, including when performed offline.
- Cloud outage does not prevent policy decisions and is visible as management-state freshness degradation.
- On a standalone install, every cloud health check reports `not_configured` rather than a warning.
- A connected decision is attributable to an exact policy revision and assignment revision.
