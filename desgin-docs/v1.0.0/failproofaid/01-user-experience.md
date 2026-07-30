# User experience

## Product promise

A user installs FailproofAI once on a machine. From then on:

- `failproofaid` starts automatically when the user logs in;
- supported agent harnesses send events to the local daemon;
- builtin and user-authored policies work locally with no account or cloud connection;
- connected cloud-tier installations may additionally synchronize centrally assigned policies;
- AgentEye session data is captured and delivered when enabled;
- service and policy health are always visible locally and, when connected, in the cloud;
- stable releases update automatically with rollback on failure.

The user should not need to understand hooks, service managers, sockets, transcript formats, or collector processes.

## Compatibility promise

v1.0.0 is an architectural upgrade, not a cloud-only product rewrite. Everything a user can do with the current OSS release remains possible without signing in:

- enable and configure builtin policies;
- author JavaScript/TypeScript custom policies using the existing public API;
- load one or more explicit custom policy files;
- discover `*policies.{js,mjs,ts}` files from project and user `.failproofai/policies/` directories;
- use user, project, and local configuration scopes supported by each harness;
- install, list, enable, disable, and uninstall policies from the CLI;
- enforce across every currently supported agent harness with the same observable result contract;
- retain transitive local imports and supported package imports in custom policy files;
- inspect local activity, sessions, policy state, and the local dashboard;
- run local audits and use the product offline.

These behaviors need compatibility fixtures before the daemon becomes the default. A feature is not considered migrated merely because an equivalent cloud workflow exists.

The cloud tier is additive. It adds enrollment, centralized assignment, fleet health, AgentEye analysis, staged rollout, and organization audit. Connecting a machine does not disable local policy authoring.

## Installation

### Primary path

The primary interactive entry point remains:

```sh
npx failproofai@latest setup
```

The npm package acts as a portable bootstrapper during the v1 migration. It downloads the signed native release for the current operating system and architecture, verifies it, installs the user-facing `failproofai` CLI and `failproofaid` daemon, and then hands control to the native setup flow.

Additional v1.0.0 distribution paths may include Homebrew and a shell installer. Every path installs the same signed Linux/macOS release layout and invokes the same setup protocol; package-specific behavior must not create different daemon semantics.

Windows is not a v1.0.0 daemon target. The bootstrapper detects Windows before downloading or modifying anything, explains that Windows support is planned for the next iteration, and points users to the last compatible current-version workflow where applicable.

The complete artifact, package-manager, and download design is in [Release and package distribution](./08-release-and-packaging.md).

The default installation is unprivileged and per-user. It must not require `sudo` to install a user service or write credentials. A separately designed system-wide installation may be offered for managed fleet images.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing AgentEye collector.
2. **Choose Login or OSS** — show the two choices in the existing branded CLI selector. **Login** is selected by default, but the user can move to **OSS** before continuing.
3. **Optional sign-in** — only after choosing Login, authenticate and enroll the installation into an organization. Browser sign-in is preferred; device code supports headless machines.
4. **Optional machine identity** — only after choosing Login, propose a display name and create a stable cloud machine identity.
5. **Choose integrations** — show detected harnesses and let the user enable enforcement for each one. Existing hooks are migrated rather than duplicated.
6. **Choose policies** — preserve current builtin selection and custom/convention policy discovery. On a connected machine, show cloud assignments as an additional source.
7. **Choose observability** — explain which local session sources can be captured and where their data goes. Require explicit selection before transcript capture is enabled.
8. **Install the service** — write configuration and any optional credentials, register the service, start it, and wait for IPC readiness.
9. **Verify end to end** — run a harmless synthetic hook request and verify enabled local capabilities. Confirm cloud acknowledgement only when connected.
10. **Report completion** — show enabled harnesses, local policy state, service health, and local dashboard; add organization/machine/dashboard links only when connected.

Setup is transactional. If a later step fails, it restores the previous harness configuration and service state. It never leaves half-installed hooks pointing at a missing daemon.

The mode step should read approximately:

```text
◆ How do you want to use FailproofAI?

  ❯ Login   Local policies + AgentEye, centralized policy management,
            machine/agent/session targeting, fleet health, and cloud sync.

    OSS     No account or cloud required. Builtin and custom policies,
            convention discovery, local activity/dashboard, audits, and offline use.
```

The one-liners are product explanations, not license warnings. Login retains every OSS capability and adds connected functionality. OSS remains a complete supported path rather than a trial or degraded mode.

### CLI presentation

The new setup steps reuse the current polished `failproofai config` wizard rather than introducing a second installer UI:

- the existing FailproofAI logomark and pink/teal palette;
- keyboard navigation with a visible `❯` active row;
- descriptions aligned beside or beneath each choice;
- a persistent step spine and compact summaries for completed steps;
- terminal-width-aware wrapping and the existing ANSI fallback;
- a final review showing the exact service, harness files, policy configuration, capture sources, and optional cloud enrollment that will change;
- Enter to confirm and a clear cancellation path that writes nothing.

After the user selects a mode, the completed step stays visible as `Login · <organization>` or `OSS · local only`. Returning to the step and changing the choice updates the remaining flow before anything is applied.

### Non-interactive and managed installation

Standalone automation uses the same operation with structured inputs and no credential:

```sh
failproofai setup \
  --non-interactive \
  --mode oss \
  --harness claude --harness codex
```

Connected automation adds enrollment explicitly:

```sh
failproofai setup \
  --non-interactive \
  --mode login \
  --enrollment-token "$TOKEN" \
  --machine-name build-runner-07 \
  --harness claude --harness codex \
  --capture codex
```

Secrets must not appear in generated service definitions or process arguments after enrollment. The one-time enrollment token is exchanged for a rotatable machine credential and then discarded.

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services, identities, or hooks.

## Standalone OSS use

Standalone users keep the current authoring workflow:

```sh
failproofai policies --install block-sudo --scope user
failproofai policies --install --custom ./company-policies.mjs
```

They may also place convention policies in `.failproofai/policies/` at project or user scope. The daemon watches and atomically reloads them, while invalid changes retain the last known-good generation and appear in local health.

No account, API key, machine enrollment, or AgentEye backend is required. Policy source code, configuration, activity, and local dashboard data remain on the machine unless the user deliberately connects an external destination.

## Connected cloud-tier use

Connected users gain an additional cloud workflow:

1. inspect AgentEye sessions, findings, or analysis;
2. create or select a policy;
3. choose organization, environment, machine, agent, or session targets;
4. deploy in observe mode;
5. inspect matches and would-block decisions;
6. promote the same policy revision to enforce mode;
7. expand, pause, expire, or roll back the assignment.

The local daemon reconciles these changes automatically. A user does not run a sync command after a cloud change. All v1.0.0 policy evaluation happens locally after the assignment and policy artifact have synchronized.

Local policy files, builtin policies, and convention discovery remain active on a connected machine. The CLI labels every source and scope:

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

On a standalone installation cloud checks report `not_configured`, not a warning or failure.

## Status and health

`status` answers whether the service manager believes the daemon is installed and running. `health` answers whether the product is working.

The default health view reports independently:

- daemon and IPC readiness;
- active local policy generation and, when configured, cloud assignment generation;
- cloud state as `not_configured`, `connected`, `stale`, `expired`, `rejected`, or `never_synced`;
- enabled harnesses and their last event;
- enabled capture sources and checkpoint progress;
- pending, retrying, and quarantined delivery data;
- disk or memory pressure;
- installed, available, staged, or rolled-back update versions.

A process can be running while policy sync or event delivery is unhealthy. The UI must never collapse these into one green status.

## Offline behavior

The daemon loads verified local policy before accepting events. Standalone operation has no management-plane dependency. On a connected machine it additionally loads the last verified cloud assignment generation and continues enforcing it while the cloud is unavailable. Hook decisions do not make a network request in v1.0.0.

Policy status shows the active revision, its last successful synchronization time, and whether cloud management state is current, stale, expired, rejected, or never synchronized.

Connected users see the age and expiry state of cloud policy. Ordinary organization policy continues from last-known-good state by default rather than silently disappearing. Local policies are unaffected by cloud expiry.

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
3. revokes the machine credential when the installation is connected, or records revocation for its next connection;
4. removes installed executables and update state;
5. preserves local policy files, logs, pending events, and configuration by default.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted. Cloud data and organization policy are not deleted by uninstalling one machine.

Migration from the standalone AgentEye collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A standalone user can reach a healthy daemon and one enforced synthetic hook through one setup command without an account or network connection.
- Every current OSS policy authoring, discovery, scope, CLI, harness, activity, dashboard, and audit behavior has a compatibility test and remains available.
- Connecting the cloud tier does not disable or subordinate user-authored local policy.
- Re-running setup is idempotent.
- Setup failure restores prior service and harness configuration.
- No default per-user installation requires elevation.
- Users can identify the exact policy revision and assignment responsible for a decision.
- Cloud outage does not prevent policy decisions and is visible as management-state freshness degradation.
- Collection consent names each enabled source and can be revoked independently.
- Update failure returns to the previous healthy release without manual repair.
- Uninstall never silently deletes undelivered or user-authored data.
- Linux and macOS pass the complete setup, service lifecycle, enforcement, update, rollback, and uninstall acceptance suite; Windows is not represented as a v1.0.0 supported target.
