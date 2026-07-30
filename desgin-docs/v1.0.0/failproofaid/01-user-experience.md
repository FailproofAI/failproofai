# User experience

## Product promise

A user installs FailproofAI once on a machine. From then on:

- `failproofaid` starts automatically when the user logs in;
- supported agent harnesses send events to the local daemon;
- each policy can be configured for local, cloud, or hybrid evaluation, mediated by the daemon with an explicit deadline and fallback contract;
- AgentEye session data is captured and delivered when enabled;
- centrally assigned policies arrive automatically and keep working while offline;
- service and policy health are visible locally and in the cloud;
- stable releases update automatically with rollback on failure.

The user should not need to understand hooks, service managers, sockets, transcript formats, or collector processes.

## Installation

### Primary path

The primary interactive entry point remains:

```sh
npx failproofai@latest setup
```

The npm package acts as a portable bootstrapper during the v1 migration. It downloads the signed native release for the current operating system and architecture, verifies it, installs the user-facing `failproofai` CLI and `failproofaid` daemon, and then hands control to the native setup flow.

Additional distribution paths may include Homebrew, a shell installer, and a signed Windows installer. Every path installs the same signed release layout and invokes the same setup protocol; package-specific behavior must not create different daemon semantics.

The complete artifact, package-manager, and download design is in [Release and package distribution](./08-release-and-packaging.md).

The default installation is unprivileged and per-user. It must not require `sudo` to install a user service or write credentials. A separately designed system-wide installation may be offered for managed fleet images.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing AgentEye collector.
2. **Sign in** — authenticate the user and enroll this daemon installation into an organization. Browser-based sign-in is preferred; a device-code path supports headless machines.
3. **Name the machine** — propose the host name, let the user choose a recognizable display name, and create a stable machine identity.
4. **Choose integrations** — show detected harnesses and let the user enable enforcement for each one. Existing hooks are migrated rather than duplicated.
5. **Choose observability** — explain which local session sources can be captured and require explicit selection before transcript capture is enabled.
6. **Preview policy state** — show centrally assigned and local policies that will be active, including whether each starts in observe or enforce mode.
7. **Install the service** — write owner-only configuration and credentials, register the service, start it, and wait for IPC readiness.
8. **Verify end to end** — run a harmless synthetic hook request, confirm policy evaluation, verify enabled collectors, and confirm cloud acknowledgement when online.
9. **Report completion** — show machine identity, enabled harnesses and sources, active policy revision, service health, and the relevant dashboard link.

Setup is transactional. If a later step fails, it restores the previous harness configuration and service state. It never leaves half-installed hooks pointing at a missing daemon.

### Non-interactive and managed installation

Automation uses the same operation with structured inputs:

```sh
failproofai setup \
  --non-interactive \
  --enrollment-token "$TOKEN" \
  --machine-name build-runner-07 \
  --harness claude --harness codex \
  --capture codex
```

Secrets must not appear in generated service definitions or process arguments after enrollment. The one-time enrollment token is exchanged for a rotatable machine credential and then discarded.

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services, identities, or hooks.

## Normal use

Most users interact with the cloud dashboard, not the daemon:

1. inspect AgentEye sessions, findings, or analysis;
2. create or select a policy;
3. choose organization, environment, machine, agent, or session targets;
4. deploy in observe mode;
5. inspect matches and would-block decisions;
6. promote the same policy revision to enforce mode;
7. expand, pause, expire, or roll back the assignment.

The local daemon reconciles these changes automatically. A user does not run a sync command after a cloud change. Each assignment states whether evaluation happens locally, in the cloud, or in hybrid mode; the harness integration is identical in every case.

Local policy files and builtin policies remain usable for individual developers and offline projects. The CLI clearly labels policy source and authority:

```text
SOURCE       SCOPE             MODE       POLICY
Cloud        organization      enforce    block-secret-exfiltration
Cloud        agent:codex       observe    require-tests-before-stop
Local        user              enforce    block-sudo
Local        project           enforce    repository-boundary
```

## Local CLI

The CLI manages and diagnoses the product; it does not become a second implementation of daemon behavior.

```text
failproofai status                  # service-manager state and concise health
failproofai health [--json]         # detailed subsystem health
failproofai service start|stop|restart
failproofai service logs [--follow]
failproofai harness list
failproofai harness enable <name>
failproofai harness disable <name>
failproofai policies list
failproofai policies reload
failproofai policies explain --session <id>
failproofai collector status
failproofai collector flush
failproofai update --check
failproofai update --rollback
failproofai doctor
```

`policies explain` is an important trust feature. It shows the effective policies for a target, their source and assignment scope, the precedence calculation, active revision, and why an expected policy did or did not apply.

`doctor` performs read-only checks by default: executable layout, service registration, endpoint ownership, protocol compatibility, policy generation, source permissions, spool health, cloud freshness, and update state. Any repair that changes harness configuration or deletes data requires an explicit flag or confirmation.

## Status and health

`status` answers whether the service manager believes the daemon is installed and running. `health` answers whether the product is working.

The default health view reports independently:

- daemon and IPC readiness;
- active local and cloud policy generations;
- cloud state as `connected`, `stale`, `expired`, `rejected`, or `never_synced`;
- enabled harnesses and their last event;
- enabled capture sources and checkpoint progress;
- pending, retrying, and quarantined delivery data;
- disk or memory pressure;
- installed, available, staged, or rolled-back update versions.

A process can be running while policy sync or event delivery is unhealthy. The UI must never collapse these into one green status.

## Decision location and offline behavior

The health and policy views identify where each policy is evaluated:

- `local` — the daemon evaluates a verified local artifact;
- `cloud` — the daemon sends a bounded decision request to the FailproofAI cloud;
- `hybrid` — mandatory/local policy runs first and cloud policy contributes when reachable.

The organization administrator chooses the allowed default, and an authorized policy assignment can select `local`, `cloud`, or `hybrid`. A machine user can choose only within organization policy and cannot move a centrally mandated cloud or local control to another location. The CLI shows the effective configured location and its source.

Example assignment configuration:

```json
{
  "evaluation_location": "cloud",
  "decision_timeout_ms": 1200,
  "on_unavailable": {
    "action": "local_fallback",
    "policy_revision": "pol_123:17"
  }
}
```

For cloud/hybrid policy, the assignment states what happens when the decision service is unavailable or misses its deadline: use a permitted last-known/cached decision, fall back to a named local policy, fail open, or fail closed. The user sees this behavior before deployment; it is never an implicit network-error default.

The daemon loads the last verified local policy generation before accepting events and continues enforcing it while the management plane is unavailable. This remains the offline behavior for local policy even after cloud evaluation exists.

The user sees the age and expiry state of cloud policy. Ordinary organization policy continues from last known-good state by default rather than silently disappearing. Policies with different post-expiry behavior must show that behavior before deployment.

Collection continues into a bounded durable spool while offline. Delivery resumes automatically. Enforcement never waits for the spool or backend.

## Updates

Stable standalone installations check for updates automatically with jitter. Downloads and verification happen in the background. Activation occurs in an idle window through the external updater and service manager, not by the running daemon replacing itself.

The user can choose:

- automatic stable activation;
- download automatically but ask before activation;
- notify only;
- a pinned version for managed environments.

The status view reports what will happen before an update. A failed health check rolls back automatically and suppresses the failed release. Container and package-manager-owned installations follow their owning update mechanism unless explicitly converted to standalone management.

## Failure experience

Errors should name the affected capability and current safety behavior:

```text
Enforcement: healthy — generation 184 active
Cloud sync: degraded — offline for 18m; generation 184 remains enforced
Codex capture: degraded — transcript path is not readable
Delivery: retrying — 23 batches pending; oldest 4m
Update: rolled back — 1.0.3 failed readiness; running 1.0.2
```

The daemon-unavailable behavior is explicit. During migration the hook client may use the legacy evaluator. Later releases apply the configured per-integration failure mode and explain whether the event was allowed, blocked, or not enforceable. Stop-class integrations receive special handling to prevent retry loops.

## Uninstall and data ownership

`failproofai uninstall`:

1. disables installed harness integrations;
2. stops and removes the user service;
3. revokes the machine credential when online or records revocation for the next connection;
4. removes installed executables and update state;
5. preserves local policy files, logs, pending events, and configuration by default.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted. Cloud data and organization policy are not deleted by uninstalling one machine.

Migration from the standalone AgentEye collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A new user can reach a healthy daemon and one enforced synthetic hook through one setup command.
- Re-running setup is idempotent.
- Setup failure restores prior service and harness configuration.
- No default per-user installation requires elevation.
- Users can identify the exact policy revision and assignment responsible for a decision.
- Cloud outage does not prevent local-policy decisions and is visible as freshness or decision-service degradation.
- Every assignment displays its configured evaluation location; cloud/hybrid assignments also display decision deadline, data disclosure, and unavailable-service behavior before activation.
- Collection consent names each enabled source and can be revoked independently.
- Update failure returns to the previous healthy release without manual repair.
- Uninstall never silently deletes undelivered or user-authored data.
