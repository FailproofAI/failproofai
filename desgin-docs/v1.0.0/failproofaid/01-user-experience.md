# User experience

## Product promise

A user installs FailproofAI once on a machine. From then on:

- `failproofaid` starts automatically when the user logs in;
- supported agent harnesses send events to the local daemon;
- builtin and user-authored policies work locally with no account or cloud connection;
- installations connected to Failproof Cloud may additionally synchronize centrally assigned policies;
- FailproofAI session data is captured and delivered when enabled;
- service and policy health are always visible locally and, when connected, in the cloud;
- hook registrations automatically track supported harness schema changes without replacing the daemon binary.

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

Setup supports three service scopes. `managed` is recommended and preselected: its daemon runs as a dedicated `_failproofai` service account, and its configuration, policy store, and state live outside the agent user's authority. Root remains fully authoritative over all of it — the boundary this buys is against the enrolled user whose agent is being governed, not against an administrator. Installing or changing it requires `sudo` once; nothing runs as root afterwards. `system` remains available for fleet-managed machines that require root-owned `/etc` configuration or must serve agents running as root. `user` remains available without elevation, with an explicit cooperative-enforcement warning.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing FailproofAI collector.
2. **Choose service scope** — show **Managed** as the recommended, preselected tamper-resistant option, **System** as the root-owned fleet option, and **User** as the unprivileged cooperative option. Explain affected users, paths, hook protection, service manager, and required privileges before continuing.
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

  ❯ Managed  Recommended. The daemon runs as a dedicated service account,
             so policies stay outside your agent's reach. One sudo now;
             nothing runs as root afterwards. Starts at machine boot.

    System   Root-owned configuration in /etc for fleet-managed machines,
             or agents that themselves run as root. Requires sudo.

    User     No sudo required. Runs after login, but an agent with this
             user's permissions may be able to disable hooks or policy.
```

Selecting Managed or System triggers a second confirmation naming the service account, service, and state locations that will be created. Setup requests elevation only when ready to apply the reviewed plan; exploring or cancelling the wizard never invokes `sudo`.

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
  --service-scope managed \
  --mode login \
  --enrollment-token "$TOKEN" \
  --machine-name build-runner-07 \
  --harness claude --harness codex \
  --capture codex
```

Secrets must not appear in generated service definitions or process arguments after enrollment. The one-time enrollment token is exchanged for a rotatable machine credential and then discarded.

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services, identities, or hooks.

`--service-scope user|managed|system` is required in non-interactive mode so automation never crosses a privilege boundary accidentally. Interactive setup recommends and preselects `managed`, but requests elevation only after final confirmation. A `managed` or `system` run without sufficient privilege prints the exact `sudo` command to rerun; it never silently falls back to user scope.

### Service-scope behavior

User scope installs a systemd user service on Linux or a LaunchAgent on macOS. Its executable, configuration, credentials, logs, policy state, and socket are owned by that user. It manages only harness configuration selected by that user and normally starts at login.

Managed scope installs a systemd system service on Linux or a LaunchDaemon on macOS that runs as a dedicated `_failproofai` service account rather than as root. It starts at boot and serves explicitly enrolled local users. Creating the account, installing, explicitly upgrading, repairing, or uninstalling this scope requires `sudo` once; the running service never holds root, and normal hook evaluation requires no elevation.

Ownership inside a managed install is split so the daemon cannot rewrite what it is supposed to enforce. Executables, the pinned runtime, the protected policy store, and the active schema catalog are root-owned and read-only to the service account; only the privileged installer writes them, during an elevated operation. The service account owns just the mutable runtime surface — spool, caches, per-user state, health, logs, and the socket directory. A compromised daemon can therefore corrupt its own telemetry, but cannot replace the binary it restarts from or the policy revision it evaluates.

System scope is the same service running as root with configuration in root-owned `/etc`. It exists for fleet-managed machines whose configuration management owns `/etc`, and for serving agents that themselves run as root. It is not more tamper-resistant than managed scope against an ordinary agent, and it has a strictly larger blast radius if the daemon is compromised, so managed is preferred wherever both apply.

Managed and system scope are the choices for tamper-resistant enforcement. Setup imports protected policies into a root-owned immutable content-addressed store and restricts daemon administration to root and `sudo`. User scope remains fully functional but is explicitly described as cooperative: an agent running with the user's authority may be able to change user-owned policy, hooks, or service state.

#### Protected state lives outside the user's home

Ownership alone does not protect a directory inside a user's home. Delete and rename permission come from the parent directory, so a user who owns `~` can rename `~/.failproofai` aside and create a replacement they own, regardless of who owned the original. A sticky bit on `~` does not help, because the user can remove it.

Managed and system scope therefore keep every protected artifact on a path whose components are all owned by root or the service account — configuration, the policy store, per-user protected state, the runtime socket directory, and any co-installed AgentEye state. Nothing enforcement depends on is reachable by a rename in the user's home. This also removes the substitution attack that user scope cannot close: with the socket directory owned by the service account, an agent can connect to the daemon but cannot unlink the socket and bind an impostor that answers `allow`.

User scope keeps its `~/.failproofai/` layout unchanged. It cannot make this guarantee and does not claim to.

#### Adding a policy is unprivileged; removing one is not

This is a statement about policy administration, not about installation — creating the service account, installing the release, and registering the service all require `sudo`.

Results combine as `deny` over `instruct` over `allow` with no suppression absent an authorized override, so a policy a user adds can only make enforcement stricter. It cannot weaken, cancel, or shadow a protected policy. Within policy administration, the privileged boundary therefore covers removing, disabling, or altering an *admitted* policy — a committed revision in the protected store — and not authoring or discovering a `mutable` one.

Convention discovery keeps working exactly as it does today in every scope. Files under project and user `.failproofai/policies/` remain user-owned, are labeled `mutable`, and take effect without elevation. Only promotion into the protected store requires `sudo`.

In managed and system scope these user-owned sources are **additive, non-authoritative inputs**. They never join the protected generation, always route to the `user-context` tier, and can only tighten a result. A user replacing the directory they live in therefore changes only their own additional restrictions; it cannot alter, disable, or weaken anything in the protected store.

#### Where policies execute

Neither managed nor system scope may turn user-authored JavaScript or TypeScript into service-account or root code, and a verdict computed in a process running as the requesting user cannot be trusted by the daemon — that user can `ptrace` it, preload into it, or replace the interpreter. Evaluation is therefore split into two tiers:

| Tier | Runs as | Filesystem, subprocess, network | Verdict | Available in |
|---|---|---|---|---|
| `sealed` | the service account, in the pinned runtime | unavailable | unforgeable | managed and system scope |
| `user-context` | the requesting UID | granted, bounded by that user's own authority | forgeable by that user | every scope |

Most policies never touch the filesystem. Tool name, command, file path, and old/new content already arrive in the hook payload, so builtins such as `block-sudo`, `block-env-files`, and `block-secrets-write` evaluate in the `sealed` tier and are genuinely tamper-proof. A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier instead — it keeps working, and because it can only tighten, a forged `allow` from it is worthless.

**A policy's own declaration is not the trust boundary.** An author controls what their policy declares, so under-declaring would otherwise be a way into the `sealed` tier. Two independent mechanisms prevent that. Admission derives the requirement itself, from the policy's resolved import graph rather than its manifest, and routes on what it finds. And the `sealed` runtime is deny-by-default at the boundary: the context exposes no filesystem, process, or network bindings at all, so a policy that under-declares does not escape the tier — it fails inside it, visibly, and trips the circuit breaker for its artifact. The declaration is a routing hint and a diagnostic, never a grant. Native addons are refused from `sealed` outright for the same reason: a pinned digest prevents substitution but does nothing to constrain what native code does once loaded.

`sealed` exists only where the runtime and policy store are outside the agent's authority, which means managed and system scope. In user scope every policy evaluates with the user's own authority, and no verdict-integrity claim is made or displayed.

Policy provenance, resolved capabilities, and execution tier are recorded with every decision, and `policies explain` reports the tier so nobody has to infer it.

#### Endpoint and attachment

Only one service endpoint handles a given user's harness hooks. Setup detects an existing installation in a different scope and offers an explicit transactional switch; it does not register duplicate hooks or let two daemons race. Installing a managed or system daemon does not automatically rewrite every user's harness configuration. Each user or an administrator-managed deployment explicitly enrolls the intended harnesses.

The final review reports each harness as `protected`, `detectable`, or `cooperative`. If the harness stores hooks in a user-writable file, setup explains that a privileged daemon cannot prevent removal of that hook; it continuously watches the settings file and automatically restores missing or altered FailproofAI entries, but does not mislabel repair as prevention. Full protection requires a machine hook owned by the service account or root, a mandatory plugin, a managed gateway, or an enforced launcher path.

## Standalone OSS use

Standalone users keep the current authoring workflow:

```sh
failproofai policies --install block-sudo --scope user
failproofai policies --install --custom ./company-policies.mjs
```

They may also place convention policies in `.failproofai/policies/` at project or user scope. The daemon watches and atomically reloads them, while invalid changes retain the last known-good generation and appear in local health.

Authoring is never privileged, and dependencies are the author's own. A policy is developed with the normal npm workflow and iterated in the `user-context` tier without elevation. Promoting it into the protected store is the only step that requires `sudo`, and that step compiles the policy and its entire import graph into a single content-addressed artifact — one digest covering the policy and every dependency, with nothing resolved from a mutable path at evaluation time:

```sh
npm install @octokit/rest                             # ordinary authoring, no elevation
failproofai policies --install ./gh-policy.mjs        # iterate; mutable, user-context
sudo failproofai policies --install ./gh-policy.mjs --protect   # compile, hash, seal
```

Native `.node` addons cannot be inlined; admission either refuses them or copies them alongside the artifact with their digests pinned.

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
failproofai harness schemas status
failproofai harness schemas refresh
failproofai doctor
```

`policies explain` is an important trust feature. It shows the effective policies for a target, their source and assignment scope, the precedence calculation, active revision, declared capabilities, execution tier, and why an expected policy did or did not apply. A policy that landed in the `user-context` tier says which declared capability put it there, so an administrator expecting a tamper-proof verdict finds out at install time rather than after an incident.

`doctor` performs read-only checks by default: executable layout, service registration, endpoint ownership, protocol compatibility, policy generation, source permissions, spool health, cloud freshness, and harness/schema compatibility. Any repair beyond automatic restoration of enabled FailproofAI hook entries requires an explicit flag or confirmation.

On a standalone installation cloud checks report `not_configured`, not a warning or failure.

## Status and health

`status` answers whether the service manager believes the daemon is installed and running. `health` answers whether the product is working.

The default health view reports independently:

- daemon and IPC readiness, including the account the service runs as;
- active local policy generation and, when configured, cloud assignment generation;
- policy counts by execution tier, so a protected install can see how much of its enforcement is unforgeable;
- cloud state as `not_configured`, `connected`, `stale`, `expired`, `rejected`, or `never_synced`;
- enabled harnesses and their last event;
- hook registration state, last verification/repair, and persistent tamper alerts;
- enabled capture sources and checkpoint progress;
- pending, retrying, and quarantined delivery data;
- disk or memory pressure;
- detected harness versions, active schema generation, and unsupported or binary-update-required adapters.

A process can be running while policy sync or event delivery is unhealthy. The UI must never collapse these into one green status.

## Offline behavior

The daemon loads verified local policy before accepting events. Standalone operation has no management-plane dependency. On a connected machine it additionally loads the last verified cloud assignment generation and continues enforcing it while the cloud is unavailable. Hook decisions do not make a network request in v1.0.0.

Policy status shows the active revision, its last successful synchronization time, and whether cloud management state is current, stale, expired, rejected, or never synchronized.

Connected users see the age and expiry state of cloud policy. Ordinary organization policy continues from last-known-good state by default rather than silently disappearing. Local policies are unaffected by cloud expiry.

Collection continues into a bounded durable spool while offline. Delivery resumes automatically. Enforcement never waits for the spool or backend.

## Harness compatibility updates

The daemon refreshes a signed declarative harness schema catalog with jitter. It detects each installed harness version, selects the most specific compatible hook schema, and automatically reconciles the settings file. A bad catalog generation or failed hook validation restores the previous schema and registration.

The catalog cannot contain executable code or replace native binaries. When a schema requires capabilities missing from the installed daemon or hook client, health reports `binary_update_required`; the user explicitly reruns `npx failproofai@latest setup`. Offline installations continue using their bundled or pinned catalog.

## Failure experience

Errors should name the affected capability and current safety behavior:

```text
Enforcement: healthy — generation 184 active
Cloud sync: degraded — offline for 18m; generation 184 remains enforced
Codex capture: degraded — transcript path is not readable
Delivery: retrying — 23 batches pending; oldest 4m
Codex hooks: repaired — schema codex/1.4 for harness 1.2.3
```

The daemon-unavailable behavior is explicit. During migration the hook client may use the legacy evaluator. Later releases apply the configured per-integration failure mode and explain whether the event was allowed, blocked, or not enforceable. Stop-class integrations receive special handling to prevent retry loops.

## Uninstall and data ownership

`failproofai uninstall --service-scope user`, or `sudo failproofai uninstall --service-scope managed|system`:

1. disables installed harness integrations;
2. stops and removes the selected service scope;
3. revokes the machine credential when the installation is connected, or records revocation for its next connection;
4. removes installed executables, the pinned policy runtime, and harness schema-catalog state;
5. securely erases the local machine credential and any cached token, retaining only a non-secret revocation tombstone when revocation could not be delivered;
6. preserves local policy files, logs, pending events, and non-secret configuration by default.

Credentials are never part of preserved state. An uninstall performed offline must leave nothing on disk that could still authenticate, which is why step 5 is unconditional rather than a consequence of a successful revocation call.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted. Cloud data and organization policy are not deleted by uninstalling one machine.

Managed- and system-scope uninstall removes the privileged service and machine installation but preserves per-user policy and undelivered state by default. It does not delete another user's files. Removing the `_failproofai` service account is a separate, explicitly confirmed step, because orphaned state on disk still belongs to that UID. Purging shared or per-user state requires explicit administrator selection of each target.

Migration from the standalone FailproofAI collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A standalone user can reach a healthy daemon and one enforced synthetic hook through one setup command without an account, and can then operate entirely offline. Installation itself requires network access in v1.0.0, since npm bootstrap is the only supported distribution path.
- Every current OSS policy authoring, discovery, scope, CLI, harness, activity, dashboard, and audit behavior has a compatibility test and remains available.
- Connecting Failproof Cloud does not disable or subordinate user-authored local policy.
- Re-running setup is idempotent.
- Setup failure restores prior service and harness configuration.
- Interactive setup recommends and preselects managed scope; choosing user scope requires acknowledging its weaker protection.
- Users can identify the exact policy revision, assignment, declared capabilities, and execution tier responsible for a decision.
- Managed and system scope prevent unprivileged daemon/policy administration and report the true attachment protection level for every harness.
- No protected artifact in managed or system scope is reachable by renaming a directory the user owns.
- A managed-scope daemon holds no root privilege at runtime, never executes an interpreter or dependency from a user-writable path, and cannot write its own executables, pinned runtime, protected policy store, or schema catalog.
- A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier and labeled as such. Tier is derived from the resolved import graph, not from the policy's own declaration, and a policy that under-declares fails inside `sealed` rather than escaping it.
- The `sealed` tier is offered only in managed and system scope; user scope makes no verdict-integrity claim.
- Native addons are refused from the `sealed` tier.
- User-owned convention policies are additive and non-authoritative in managed and system scope, and replacing the directory containing them cannot weaken a protected policy.
- Uninstall leaves no credential on disk, including when performed offline.
- A user-added policy can tighten enforcement and can never weaken, cancel, or shadow a protected one.
- Promotion into the protected store yields one digest covering the policy and every dependency, and evaluation resolves nothing from a mutable path.
- Removing or altering an enabled FailproofAI hook is detected and semantically repaired without overwriting unrelated harness settings; explicit disable/uninstall is not repaired.
- Cloud outage does not prevent policy decisions and is visible as management-state freshness degradation.
- Collection consent names each enabled source and can be revoked independently.
- A bad harness schema returns to the previous valid schema and registration without replacing or restarting the daemon.
- Uninstall never silently deletes undelivered or user-authored data.
- Linux and macOS pass the complete setup, service lifecycle, enforcement, schema refresh/rollback, and uninstall acceptance suite; Windows is not represented as a v1.0.0 supported target.
