# User experience

## Product promise

A user installs FailproofAI once on a machine. From then on:

- `failproofaid` starts automatically when the user logs in;
- supported agent harnesses send events to the local daemon;
- builtin and user-authored policies work locally with no account or cloud connection;
- installations connected to Failproof Cloud may additionally synchronize centrally assigned policies;
- FailproofAI session data is captured and delivered when enabled;
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

Failproof Cloud is additive. It adds enrollment, centralized assignment, fleet health, analysis, staged rollout, and organization audit. Connecting a machine does not disable local policy authoring.

## Installation

### Primary path

The single supported v1.0.0 installation entry point remains:

```sh
npx failproofai@latest setup
```

The npm package uses npm integrity and trusted-publishing provenance for bootstrap trust. It downloads and independently verifies the signed native release, installs `failproofai` and `failproofaid` into a stable directory for the selected service scope, and hands control to the native setup flow. It declares no install lifecycle script; all machine changes occur during explicit `setup`.

Homebrew, shell installers, direct-download installation, containers, mirrors, and offline bundles are outside v1.0.0 distribution scope. Windows is also not a v1.0.0 daemon target. The npm bootstrapper detects it before downloading or modifying anything and explains that support is planned for the next iteration.

The npm bootstrap and native artifact design is in [npm release and distribution](./08-release-and-packaging.md).

Setup supports both service scopes. `system` is recommended and preselected because its daemon, protected policies, and supported machine-level hooks live outside the agent user's authority; installing or changing it requires `sudo`. `user` remains available without elevation, with an explicit cooperative-enforcement warning.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing FailproofAI collector.
2. **Choose service scope** — show **System** as the recommended, preselected tamper-resistant option and **User** as the unprivileged cooperative option. Explain affected users, paths, hook protection, service manager, and required privileges before continuing.
3. **Choose Login or OSS** — show the two choices in the existing branded CLI selector. **Login** is selected by default, but the user can move to **OSS** before continuing.
4. **Optional sign-in** — only after choosing Login, authenticate and create a time-bounded pending enrollment. Browser sign-in is preferred; device code supports headless machines.
5. **Optional machine identity** — only after choosing Login, propose a display name and reserve a pending Failproof Cloud machine identity. It is not activated yet.
6. **Choose integrations** — show detected harnesses and let the user enable enforcement for each one. Existing hooks are migrated rather than duplicated.
7. **Choose policies** — preserve current builtin selection and custom/convention policy discovery. On a connected machine, show Failproof Cloud assignments as an additional source.
8. **Choose observability** — explain which local session sources can be captured and where their data goes. Require explicit selection before transcript capture is enabled.
9. **Install the service** — write configuration and any optional credentials, register the selected service scope, start it, and wait for IPC readiness.
10. **Verify end to end** — run a harmless synthetic hook request and verify enabled local capabilities. For Login, exchange the pending enrollment for the machine credential, acknowledge the machine, and activate its identity only after local verification succeeds. Enrollment, credential exchange, activation, status lookup, and deactivation all use one stable setup-transaction idempotency key.
11. **Report completion** — show service scope, enabled harnesses, local policy state, service health, and local dashboard; add organization/machine/dashboard links only after connected activation succeeds.

Setup is transactional across local and cloud effects. If a later step fails, it restores the previous harness configuration and service state, revokes any issued machine credential, and idempotently cancels a pending identity or deactivates an already-activated identity using the stable setup transaction key. An ambiguous activation response is resolved by querying activation status with that same key before retrying or compensating; activation retries cannot create a second machine. Pending enrollments expire server-side if the client disappears before compensation, and activated-but-uncommitted identities are marked by the server for expiry unless setup durably commits. Re-running setup resumes or replaces the same transaction rather than creating duplicates. It never leaves half-installed hooks pointing at a missing daemon or an apparently active cloud machine with no healthy service.

The mode step should read approximately:

```text
◆ How do you want to use FailproofAI?

  ❯ Login   Local policies + Failproof Cloud, centralized policy management,
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

The service-scope step should read approximately:

```text
◆ Where should FailproofAI run?

  ❯ System   Recommended. Keeps the daemon and protected policies outside
             the agent's authority. Requires sudo; starts at machine boot.

    User     No sudo required. Runs after login, but an agent with this
             user's permissions may be able to disable hooks or policy.
```

Selecting System triggers a second confirmation naming the root-owned service and state locations. Setup requests elevation only when ready to apply the reviewed plan; exploring or cancelling the wizard never invokes `sudo`.

### Non-interactive and managed installation

Standalone automation uses the same operation with structured inputs and no credential:

```sh
failproofai setup \
  --non-interactive \
  --service-scope user \
  --mode oss \
  --harness claude --harness codex
```

Connected automation adds enrollment explicitly:

```sh
sudo failproofai setup \
  --non-interactive \
  --service-scope system \
  --mode login \
  --enrollment-token "$TOKEN" \
  --machine-name build-runner-07 \
  --harness claude --harness codex \
  --capture codex
```

Secrets must not appear in generated service definitions or process arguments after enrollment. The one-time enrollment token is exchanged for a rotatable machine credential and then discarded.

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services, identities, or hooks.

`--service-scope user|system` is required in non-interactive mode so automation never crosses a privilege boundary accidentally. Interactive setup recommends and preselects `system`, but requests elevation only after final confirmation. A system-scoped run without sufficient privilege prints the exact `sudo` command to rerun; it never silently falls back to user scope.

### Service-scope behavior

User scope installs a systemd user service on Linux or a LaunchAgent on macOS. Its executable, configuration, credentials, logs, policy state, and socket are owned by that user. It manages only harness configuration selected by that user and normally starts at login.

System scope installs a systemd system service on Linux or a LaunchDaemon on macOS. Its executable, service definition, machine configuration, credentials, update state, and shared data are root-owned. It can start at boot and serve system agents and explicitly enrolled local users. Installing, updating, repairing, or uninstalling this scope requires `sudo`; normal hook evaluation does not.

System scope is the choice for tamper-resistant enforcement. Setup imports protected policies into a root-owned immutable store and makes daemon administration root-only. User scope remains fully functional but is explicitly described as cooperative: an agent running with the user's authority may be able to change user-owned policy, hooks, or service state.

A system daemon authenticates every Unix-socket client using operating-system peer credentials and maintains separate per-user policy generations, session indexes, spools, quotas, and access control. A user can inspect only their own data unless an explicit administrator operation is used. Root-owned machine policies may apply to every user; user and project policies remain owned and scoped to their user.

System scope must never turn user-authored JavaScript or TypeScript policy into root code. The daemon launches the legacy policy worker with the requesting user's UID/GID, restricted groups, environment and filesystem access, resource limits, and platform sandbox controls. Root-owned machine policies use the constrained native policy representation or an equivalently restricted worker. Policy provenance and execution identity are recorded with every decision.

Only one service endpoint handles a given user's harness hooks. Setup detects an existing opposite-scope installation and offers an explicit transactional switch; it does not register duplicate hooks or let user and system daemons race. Installing the system daemon does not automatically rewrite every user's harness configuration. Each user or an administrator-managed deployment explicitly enrolls the intended harnesses.

The final review reports each harness as `protected`, `detectable`, or `cooperative`. If the harness stores hooks in a user-writable file, setup explains that a privileged daemon cannot prevent removal of that hook; it enables monitoring and optional repair but does not claim prevention. Full protection requires a root-owned machine hook, mandatory plugin, managed gateway, or enforced launcher path.

## Standalone OSS use

Standalone users keep the current authoring workflow:

```sh
failproofai policies --install block-sudo --scope user
failproofai policies --install --custom ./company-policies.mjs
```

They may also place convention policies in `.failproofai/policies/` at project or user scope. The daemon watches and atomically reloads them, while invalid changes retain the last known-good generation and appear in local health.

No account, API key, machine enrollment, or Failproof Cloud connection is required. Policy source code, configuration, activity, and local dashboard data remain on the machine unless the user deliberately connects an external destination.

## Failproof Cloud use

Connected users gain an additional cloud workflow:

1. inspect FailproofAI sessions, findings, or analysis;
2. create or select a policy;
3. choose organization, environment, machine, agent, or session targets;
4. deploy in observe mode;
5. inspect matches and would-block decisions;
6. promote the same policy revision to enforce mode;
7. expand, pause, expire, or roll back the assignment.

The local daemon reconciles these changes automatically. A user does not run a sync command after a cloud change. All v1.0.0 policy evaluation happens locally after the assignment and policy artifact have synchronized.

Local policy files, builtin policies, and convention discovery remain active on a connected machine. The CLI labels every source and scope:

```text
SOURCE           SCOPE          MODE       POLICY
Failproof Cloud  organization   enforce    block-secret-exfiltration
Failproof Cloud  agent:codex    observe    require-tests-before-stop
Local            user           enforce    block-sudo
Local            project        enforce    repository-boundary
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

The status view reports what will happen before an update. A failed health check rolls back automatically and suppresses the failed release. npm owns only the bootstrap invocation; FailproofAI's updater owns the installed native release.

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

`failproofai uninstall --service-scope user` or `sudo failproofai uninstall --service-scope system`:

1. disables installed harness integrations;
2. stops and removes the selected service scope;
3. revokes the machine credential when the installation is connected, or records revocation for its next connection;
4. removes installed executables and update state;
5. preserves local policy files, logs, pending events, and configuration by default.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted. Cloud data and organization policy are not deleted by uninstalling one machine.

System-scope uninstall removes the root-owned service and machine installation but preserves per-user policy and undelivered state by default. It does not delete another user's files. Purging shared or per-user state requires explicit administrator selection of each target.

Migration from the standalone FailproofAI collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A standalone user can reach a healthy daemon and one enforced synthetic hook through one setup command without an account or network connection.
- Every current OSS policy authoring, discovery, scope, CLI, harness, activity, dashboard, and audit behavior has a compatibility test and remains available.
- Connecting Failproof Cloud does not disable or subordinate user-authored local policy.
- Re-running setup is idempotent.
- Setup failure restores prior service and harness configuration.
- Interactive setup recommends and preselects system scope; choosing user scope requires acknowledging its weaker protection.
- Users can identify the exact policy revision and assignment responsible for a decision.
- System scope prevents non-root daemon/policy administration and reports the true attachment protection level for every harness.
- Cloud outage does not prevent policy decisions and is visible as management-state freshness degradation.
- Collection consent names each enabled source and can be revoked independently.
- Update failure returns to the previous healthy release without manual repair.
- Uninstall never silently deletes undelivered or user-authored data.
- Linux and macOS pass the complete setup, service lifecycle, enforcement, update, rollback, and uninstall acceptance suite; Windows is not represented as a v1.0.0 supported target.
