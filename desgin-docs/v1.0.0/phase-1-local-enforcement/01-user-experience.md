# User experience

## Product promise

A user installs FailproofAI once on a machine. From then on:

- `failproofaid` starts automatically when the machine boots;
- supported agent harnesses send events to the local daemon;
- builtin and user-authored policies work locally with no account or network connection;
- session data is captured and delivered to the configured observability server when enabled, and is visible in local activity, audits, and the local dashboard;
- service, policy, capture, and delivery health are always visible locally;
- hook registrations automatically track supported harness schema changes without replacing the daemon binary.

The user should not need to understand hooks, service managers, sockets, transcript formats, collector processes, or service accounts.

Phase 1 is complete and shippable on its own: it is the product as it ships today, re-architected around the daemon. Nothing here needs a FailproofAI account or organization, and no policy decision depends on a network service. Where the current product already has credentials they are carried over unchanged, not reinvented — `failproofai auth login` keeps working as it does now, and capture delivers to the customer's own self-hosted observability server with the operator-issued `events:add` key it already uses.

Phase 2 is the genuinely new management plane — machine enrollment into Failproof Cloud, centrally assigned policy, targeting, fleet health, and staged rollout. It is described in [the Phase 2 documents](../phase-2-cloud/README.md) and absent from this one.

## Compatibility promise

Phase 1 is an architectural upgrade, not a rewrite. Everything a user can do with the current OSS release remains possible:

- enable and configure builtin policies;
- author JavaScript/TypeScript custom policies using the existing public API;
- load one or more explicit custom policy files;
- discover `*policies.{js,mjs,ts}` files from project and user `.failproofai/policies/` directories;
- use user, project, and local configuration scopes supported by each harness;
- install, list, enable, disable, and uninstall policies from the CLI;
- enforce across every currently supported agent harness with the same observable result contract;
- retain transitive local imports and supported package imports in custom policy files;
- inspect local activity, sessions, policy state, and the local dashboard;
- capture Codex, OpenClaw, Hermes, and Claude Code sessions and deliver them to a self-hosted observability server, with backfill, exactly-once delivery across restarts, and `health`;
- run local audits and use the product offline.

These behaviors need compatibility fixtures before the daemon becomes the default. A feature is not considered migrated merely because a different workflow reaches a similar result.

The promise covers capability, not the absence of elevation. Phase 1 installs a privileged service, so installation needs one-time administrator access even though no authoring, discovery, scope, CLI, or evaluation workflow does. A developer who cannot obtain it on a given machine keeps using the current release until the deferred unprivileged scope ships.

The standalone `agenteye-collector` converges into the daemon here rather than later, because it is shipped behavior and this promise covers it. [Collector integration](./05-collector-integration.md) describes the migration, which preserves pending and failed batches until `failproofaid` proves ownership and delivery health, and which is reversible for a defined window.

## Installation

### Primary path

The single supported installation entry point remains:

```sh
npx failproofai@latest setup
```

The npm package uses npm integrity and trusted-publishing provenance for bootstrap trust. It downloads and independently verifies the signed native release, installs `failproofai` and `failproofaid` into a stable versioned directory, and hands control to the native setup flow. It declares no install lifecycle script; all machine changes occur during explicit `setup`.

Homebrew, shell installers, direct-download installation, containers, mirrors, and offline bundles are outside distribution scope. Windows is also not a Phase 1 daemon target. The npm bootstrapper detects it before downloading or modifying anything and explains that support is planned for a later iteration.

The npm bootstrap and native artifact design is in [npm release and distribution](./07-release-and-packaging.md).

### One service scope

Phase 1 installs exactly one service scope, `managed`. The daemon runs as a dedicated `_failproofai` service account, and its configuration, policy store, and state live outside the agent user's authority. Root remains fully authoritative over all of it — the boundary this buys is against the enrolled user whose agent is being governed, not against an administrator. Installing, upgrading, repairing, or removing it requires `sudo` once; nothing runs as root afterwards.

A root-owned `system` scope for fleet-managed machines whose configuration management owns `/etc`, and an unprivileged cooperative `user` scope for machines without administrator access, are both designed and deliberately unshipped. Their layouts and the exact guarantee each one gains or loses are recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes) so either can be added when a customer needs it. Until then, every guarantee in these documents is stated unconditionally instead of qualified per scope, and neither deferred scope is a fallback setup may select on its own.

Shipping one scope has an explicit cost: **Phase 1 cannot be installed without one-time administrator access and a supported service manager.** Preflight checks for `sudo`/root availability and a running systemd or launchd before touching anything, and stops with the specific missing prerequisite and the fact that the unprivileged scope is planned. It never degrades to an unsupervised process, a cooperative install, or a partial one — a machine that cannot host the boundary is told so rather than given something weaker that looks identical in `status`.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, administrator access, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing `agenteye-collector` installation. Missing administrator access or service manager stops here, before any machine change.
2. **Disclose the enforcement boundary** — explain the managed scope before requesting anything: which users it affects, which paths it creates, which single part of it stays under the user's own control, what hook protection it can and cannot promise for each detected harness, which service manager will own it, and that it needs `sudo` once and never at runtime. Nothing is selected here. The step exists so the privilege boundary is understood rather than discovered later, and it is where the two deferred scopes are named as planned rather than silently absent.
3. **Choose integrations** — show detected harnesses and let the user enable enforcement for each one. Existing hooks are migrated rather than duplicated.
4. **Choose policies** — preserve current builtin selection and custom/convention policy discovery.
5. **Choose observability** — explain which session sources can be captured and exactly where their data goes: on-machine only, or also delivered to a self-hosted observability server the user names along with its `events:add` key. Require explicit selection before any transcript is read, and default to capturing nothing.
6. **Install the service** — create the service account, write configuration and the delivery key, register the service, start it, and wait for IPC readiness. An existing `agenteye-collector` is migrated rather than duplicated.
7. **Verify end to end** — run a harmless synthetic hook request and verify every enabled capability, including source progress and, when a destination is configured, a delivery round trip.
8. **Report completion** — show the service account, enabled harnesses, local policy state, capture sources, delivery health, and how to open the local dashboard.

Setup is transactional. If a later step fails, it restores the previous harness configuration, collector ownership, and service state. Re-running setup converges the same installation rather than creating a second service, a duplicate hook, or a second service account. It never leaves half-installed hooks pointing at a missing daemon, and never leaves two collectors owning one source.

### CLI presentation

The new setup steps reuse the current polished `failproofai config` wizard rather than introducing a second installer UI:

- the existing FailproofAI logomark and pink/teal palette;
- keyboard navigation with a visible `❯` active row;
- descriptions aligned beside or beneath each choice;
- a persistent step spine and compact summaries for completed steps;
- terminal-width-aware wrapping and the existing ANSI fallback;
- a final review showing the exact service, harness files, policy configuration, capture sources, and delivery destination that will change;
- Enter to confirm and a clear cancellation path that writes nothing.

The boundary-disclosure step should read approximately:

```text
◆ FailproofAI installs a managed service

  The daemon runs as a dedicated _failproofai service account, so your
  policies and its state stay outside your agent's reach. Nothing runs
  as root after installation.

  Affects      you now; other local users only when you enroll them
  Creates      the _failproofai account, /opt/failproofai,
               /var/lib/failproofai, /run/failproofai
  Yours        the per-user agent's own service definition, in your
               home — you can edit or remove it; it can only tighten
  Hook safety  claude, codex protected · cursor detectable
  Service      systemd system service, starts at machine boot
  Privileges   sudo once, now — never while it runs

  ❯ Continue
    Cancel

  A root-owned fleet scope and an unprivileged scope for machines
  without sudo are planned; neither ships in this release.
```

Because there is one scope, this is a disclosure with a confirmation rather than a choice, and it is the only place `sudo` is explained. Setup requests elevation only when it is ready to apply the reviewed plan; exploring or cancelling the wizard never invokes it.

### Non-interactive installation

Automation uses the same operation with structured inputs:

```sh
sudo failproofai setup \
  --non-interactive \
  --harness claude --harness codex \
  --capture codex \
  --observability-url https://agenteye.internal \
  --observability-key "$EVENTS_ADD_KEY"
```

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services, hooks, or collectors. The delivery key is read from the environment or a file, written to privileged configuration, and never appears in the generated service definition or in process arguments.

`--service-scope` remains accepted and optional, with `managed` as its only valid value. It exists so automation written now keeps working unchanged when a deferred scope ships, and so a script that states its intent explicitly is not silently reinterpreted later. Passing `system` or `user` is a hard error naming them as deferred, never a downgrade. Insufficient privilege prints the exact `sudo` command to rerun; setup never falls back to an unprivileged install.

### The managed service

The service is a systemd system service on Linux or a LaunchDaemon on macOS, running as `_failproofai` rather than as root. It starts at boot and serves explicitly enrolled local users. Creating the account, installing, explicitly upgrading, repairing, or uninstalling requires `sudo` once; the running service never holds root, and normal hook evaluation requires no elevation.

Ownership is split so the daemon cannot rewrite what it is supposed to enforce. Executables, the pinned runtime, the protected policy store, and the active schema catalog are root-owned and read-only to the service account; only the privileged installer writes them, during an elevated operation. The service account owns just the mutable runtime surface — caches, per-user state, activity, health, logs, and the socket directory. A compromised daemon can therefore corrupt its own telemetry, but cannot replace the binary it restarts from or the policy revision it evaluates.

Setup imports protected policies into a root-owned immutable content-addressed store and restricts daemon administration to root and `sudo`.

#### Protected state lives outside the user's home

Ownership alone does not protect a directory inside a user's home. Delete and rename permission come from the parent directory, so a user who owns `~` can rename `~/.failproofai` aside and create a replacement they own, regardless of who owned the original. A sticky bit on `~` does not help, because the user can remove it.

Every protected artifact therefore lives on a path whose components are all owned by root or the service account — configuration, the policy store, per-user protected state, the runtime socket directory, and any co-installed AgentEye state. Nothing enforcement depends on is reachable by a rename in the user's home. This also closes the endpoint-substitution attack: with the socket directory owned by the service account, an agent can connect to the daemon but cannot unlink the socket and bind an impostor that answers `allow`.

There is exactly one exception, and it is stated rather than smoothed over. The per-user agent that evaluates `user-context` policies and reads that user's transcripts is started by the user's *own* service manager, so its service definition necessarily lives under `~/.config/systemd/user/` or `~/Library/LaunchAgents/` — user-writable by construction, because that is what a user service manager is. The user can edit it, point it elsewhere, or delete it. That is safe for the same reason the agent itself is: its verdicts can only tighten, it holds no credential, and substituting its binary buys the user nothing they could not already do with their own authority. What would not be safe is implying otherwise, so setup discloses it and health reports a missing agent as a degradation rather than letting `user-context` enforcement disappear quietly. [The per-user agent](./03-daemon-architecture.md#the-per-user-agent) has the full argument.

#### Adding a policy is unprivileged; removing one is not

This is a statement about policy administration, not about installation — creating the service account, installing the release, and registering the service all require `sudo`.

Results combine as `deny` over `instruct` over `allow` with no suppression absent an authorized override, so a policy a user adds can only make enforcement stricter. It cannot weaken, cancel, or shadow a protected policy. Within policy administration, the privileged boundary therefore covers removing, disabling, or altering an *admitted* policy — a committed revision in the protected store — and not authoring or discovering a `mutable` one.

Convention discovery keeps working exactly as it does today. Files under project and user `.failproofai/policies/` remain user-owned, are labeled `mutable`, and take effect without elevation. Only promotion into the protected store requires `sudo`.

These user-owned sources are **additive, non-authoritative inputs**. They never join the protected generation, always route to the `user-context` tier, and can only tighten a result. A user replacing the directory they live in therefore changes only their own additional restrictions; it cannot alter, disable, or weaken anything in the protected store.

Enablement follows the same split, and it has to: a protected policy a user can switch off is not protected. Which policies are on comes from a root-owned `machine.json` alongside machine configuration, so disabling a pinned policy or changing its parameters is a privileged operation that produces an audit record, exactly like removing an admitted revision. The user's own `.failproofai/policies-config.json` keeps working with no elevation but becomes **additive-only** — it may enable policies the machine set does not name and parameterize the ones it enabled itself, and it may not disable, weaken, or reparameterize a pinned entry. [Protected enablement](./03-daemon-architecture.md#protected-enablement) records why, and that it does not ship yet.

#### Where policies execute

The daemon may not turn user-authored JavaScript or TypeScript into service-account code, and a verdict computed in a process running as the requesting user cannot be trusted by the daemon — that user can `ptrace` it, preload into it, or replace the interpreter. Evaluation is therefore split into two tiers:

| Tier | Runs as | Filesystem, subprocess, network | Verdict |
|---|---|---|---|
| `sealed` | the service account, in the daemon's own sealed runtime | unavailable | unforgeable |
| `user-context` | the requesting UID | granted, bounded by that user's own authority | forgeable by that user |

Most policies never touch the filesystem. Tool name, command, file path, and old/new content already arrive in the hook payload, so 32 of the 39 builtins — `block-sudo`, `block-env-files`, and `block-secrets-write` among them — evaluate in the `sealed` tier, where an agent holding its own user's full authority cannot forge the verdict. The seven that cannot are `warn-repeated-tool-calls`, `block-work-on-main`, and the five `require-*-before-stop` policies, each of which reads the repository or runs `git`. A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier instead — it keeps working, and because it can only tighten, a forged `allow` from it is worthless.

An unforgeable verdict is only as strong as the decision to compute it at all, and that decision does not live in the tier. Which policies are enabled comes from `.failproofai/policies-config.json`, which the user — and therefore the user's agent — can write, so an agent that cannot forge a `sealed` deny can still delete the policy's name from a JSON array and the deny is never reached. A root-owned pinned enabled set is what closes that, and it does not ship yet; see [protected enablement](./03-daemon-architecture.md#protected-enablement). Until it does, the `sealed` tier's guarantee is about evaluation and not yet about selection, and nothing in the product may describe it as tamper-proof.

**A policy's own declaration is not the trust boundary.** An author controls what their policy declares, so under-declaring would otherwise be a way into the `sealed` tier. Two independent mechanisms prevent that. Admission derives the requirement itself, from the policy's resolved import graph rather than its manifest, and routes on what it finds. And the `sealed` runtime is deny-by-default at the boundary: the context exposes no filesystem, process, or network bindings at all, so a policy that under-declares does not escape the tier — it fails inside it, visibly, and trips the circuit breaker for its artifact. The declaration is a routing hint and a diagnostic, never a grant. Native addons are refused from `sealed` outright for the same reason: a pinned digest prevents substitution but does nothing to constrain what native code does once loaded.

The `sealed` tier exists because the runtime and policy store sit outside the agent's authority, which is a property of the privileged install layout rather than of the daemon. It is unconditional in Phase 1, and the deferred unprivileged scope would be the one place the tier and its verdict-integrity claim disappear.

Policy provenance, resolved capabilities, and execution tier are recorded with every decision, and `policies explain` reports the tier so nobody has to infer it.

#### Endpoint and attachment

Only one service endpoint handles a given user's harness hooks. Setup detects an existing FailproofAI installation — a legacy hook-only install pointing at `npx failproofai`, or a previous daemon — and offers an explicit transactional switch; it does not register duplicate hooks or let two evaluators race. Installing the daemon does not automatically rewrite every user's harness configuration. Each user, or an administrator-managed deployment, explicitly enrolls the intended harnesses.

The final review reports each harness as `protected`, `detectable`, or `cooperative`. If the harness stores hooks in a user-writable file, setup explains that a privileged daemon cannot prevent removal of that hook; it continuously watches the settings file and automatically restores missing or altered FailproofAI entries, but does not mislabel repair as prevention. Full protection requires a machine hook owned by the service account or root, a mandatory plugin, a managed gateway, or an enforced launcher path.

## Policy authoring

Users keep the current authoring workflow:

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

No account, API key, or network connection is required. Policy source code, configuration, activity, and local dashboard data remain on the machine.

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
failproofai dashboard start [--ttl <duration>]
failproofai dashboard stop
failproofai dashboard status
failproofai doctor
```

`policies explain` is an important trust feature. It shows the effective policies for a target, their source and scope, the precedence calculation, active revision, declared capabilities, execution tier, and why an expected policy did or did not apply. A policy that landed in the `user-context` tier says which resolved import put it there, so an administrator expecting an unforgeable verdict finds out at install time rather than after an incident.

It also reports the decision's attestation, which is not the same thing as its tier. A policy that ran `sealed` but read the working directory, the project directory, or an environment fact took a value the daemon cannot derive and the client asserts, so its decision is reported `sealed_unattested` rather than `sealed`. [Derived and asserted context](./03-daemon-architecture.md#derived-and-asserted-context) explains which fields those are and why the distinction is not cosmetic.

`doctor` performs read-only checks by default: executable layout, service registration, endpoint ownership, protocol compatibility, policy generation, source permissions, spool health, and harness/schema compatibility. Any repair beyond automatic restoration of enabled FailproofAI hook entries requires an explicit flag or confirmation.

## Local dashboard

The local dashboard survives unchanged as a product surface, but it needs an explicit access model, because a browser cannot speak the daemon's Unix socket and a TCP listener carries no peer credentials.

**The CLI spawns it, not the daemon.** `failproofai dashboard start` already runs as the invoking user, so it starts the bundled web server as that user and the daemon is only a data source reached over the existing socket. Peer credentials then scope every read to the caller with no new mechanism: the daemon cannot tell a dashboard request from any other client, and does not need to. This also keeps the web stack out of the privileged process and avoids inventing a spawn path the daemon could not use anyway — the daemon runs as `_failproofai` and cannot `setuid` to the requesting user, exactly as with policy workers.

The daemon therefore has no dashboard concept at all. A pidfile in the user's runtime directory records the running instance, its port, and its expiry, which is what `stop` and `status` read and what makes a second `start` reattach instead of binding a second server.

### Listener

The listener binds loopback only, on an ephemeral port rather than a fixed one — a fixed port collides the moment two enrolled users are logged into the same machine. `start` prints the URL and opens it.

Access requires a capability token minted at launch, carried in a request header or a `SameSite=Strict` cookie rather than the query string, where it would leak through `Referer`. Requests are rejected unless `Origin` and `Host` match the bound listener, and no endpoint changes state on `GET`. Both rules exist because any page the user visits can issue requests to a localhost port; neither the token nor loopback binding is sufficient alone.

An agent running as the user can read that token, and this is acceptable: it already holds that user's authority, and the daemon refuses protected mutations to a non-root peer regardless of what the dashboard asks.

### Lifetime

The dashboard is on-demand, not a supervised service — a UI people open occasionally should not be an idle listener. It stops on `failproofai dashboard stop`, when its terminal exits, and when its TTL expires, default 30 minutes and overridable with `--ttl`. Expiry closes the listener and invalidates the token; the pidfile is removed on every path, including expiry, so `status` never reports a server that is gone.

### Reads and writes

Reads use the daemon's `Query` operations and return only the caller's own activity, sessions, transcripts, and policy state.

Writes split by tier, so the dashboard gates exactly what matters and leaves the common case alone:

| Policy | Dashboard behavior |
|---|---|
| `mutable` (the user's own explicit and convention policies) | Toggles and parameters change directly, no elevation — these are additive-only and cannot weaken a protected policy. |
| Protected revisions | Display-only, showing source, tier, and revision. The UI composes a copyable `sudo failproofai policies disable <name> --revision <digest>` for the user to run. |

The dashboard never performs a privileged mutation itself. Protected policy changes stay on the elevated CLI path that already produces an audit record, which removes any need for the dashboard to hold, request, or broker elevation.

## Status and health

`status` answers whether the service manager believes the daemon is installed and running. `health` answers whether the product is working.

The default health view reports independently:

- daemon and IPC readiness, including the account the service runs as;
- active local policy generation and last reload result;
- policy counts by execution tier, and how many of those are pinned by machine configuration rather than selected by a user-writable file, so an installation can see how much of its enforcement is genuinely unforgeable rather than merely evaluated in the `sealed` tier;
- whether each enrolled user's per-user agent is attached, since `user-context` enforcement and capture both depend on it;
- enabled harnesses and their last event;
- hook registration state, last verification/repair, and persistent tamper alerts;
- enabled capture sources and checkpoint progress;
- pending, retrying, and quarantined delivery data, and the age of the oldest unacknowledged batch;
- disk or memory pressure;
- detected harness versions, active schema generation, and unsupported or binary-update-required adapters.

A process can be running while policy reload, capture, or delivery is unhealthy. The UI must never collapse these into one green status. Delivery reports `not_configured` when no destination is set, which is a state rather than a warning.

## Offline behavior

The daemon loads verified local policy before accepting events, and hook decisions make no network request. Once installed, the product has no management-plane dependency and enforces indefinitely offline. The only network activity is the periodic signed harness schema-catalog refresh, whose failure degrades nothing but catalog freshness, and delivery to the configured observability server when one is set.

Policy status shows the active revision and its last successful reload.

Capture continues into a bounded durable spool while the destination is unreachable. Delivery resumes automatically, and enforcement never waits for the spool or the server.

## Harness compatibility updates

The daemon refreshes a signed declarative harness schema catalog with jitter. It detects each installed harness version, selects the most specific compatible hook schema, and automatically reconciles the settings file. A bad catalog generation or failed hook validation restores the previous schema and registration.

The catalog cannot contain executable code or replace native binaries. When a schema requires capabilities missing from the installed daemon or hook client, health reports `binary_update_required`; the user explicitly reruns `npx failproofai@latest setup`. Offline installations continue using their bundled or pinned catalog.

## Failure experience

Errors should name the affected capability and current safety behavior:

```text
Enforcement:    healthy — generation 184 active
Policy reload:  failed — company-policies.mjs:12; generation 184 remains enforced
Codex capture:  degraded — transcript path is not readable
Delivery:       retrying — 23 batches pending; oldest 4m
Codex hooks:    repaired — schema codex/1.4 for harness 1.2.3
```

The daemon-unavailable behavior is explicit. During migration the hook client may use the legacy evaluator. Later releases apply the configured per-integration failure mode and explain whether the event was allowed, blocked, or not enforceable. Stop-class integrations receive special handling to prevent retry loops.

## Uninstall and data ownership

`sudo failproofai uninstall`:

1. disables installed harness integrations;
2. stops and removes the service;
3. removes installed executables, the pinned policy runtime, and harness schema-catalog state;
4. securely erases the configured delivery key;
5. preserves local policy files, logs, activity, pending events, and non-secret configuration by default.

Step 4 is unconditional and separate from step 5, because a delivery key is a credential rather than configuration: an uninstall performed offline must leave nothing on disk that could still authenticate to the observability server.

Removing the `_failproofai` service account is a separate, explicitly confirmed step, because orphaned state on disk still belongs to that UID. Uninstall does not delete another user's files.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted. Purging shared or per-user state requires explicit administrator selection of each target.

Migration from the standalone collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A user can reach a healthy daemon and one enforced synthetic hook through one setup command without a FailproofAI account, and can then enforce entirely offline. Installation itself requires network access, since npm bootstrap is the only supported distribution path.
- No policy decision depends on a network service, and a machine with no observability destination configured spools nothing and delivers nowhere.
- Every capability the standalone `agenteye-collector` ships today — capture across its supported sources, one-time backfill, exactly-once delivery across restarts, quarantine, and `health` — is available from the daemon and covered by the collector's own conformance tests.
- Every current OSS policy authoring, discovery, scope, CLI, harness, activity, dashboard, and audit behavior has a compatibility test and remains available.
- Re-running setup is idempotent, including service-account creation.
- Setup failure restores prior service and harness configuration.
- Setup on a machine without administrator access or a supported service manager stops in preflight, naming the missing prerequisite, and changes nothing.
- `--service-scope system` and `--service-scope user` fail with a deferred-scope error rather than installing something weaker.
- Users can identify the exact policy revision, declared capabilities, and execution tier responsible for a decision.
- The installation prevents unprivileged daemon/policy administration and reports the true attachment protection level for every harness.
- No protected artifact is reachable by renaming a directory the user owns.
- The daemon holds no root privilege at runtime, never executes an interpreter or dependency from a user-writable path, and cannot write its own executables, pinned runtime, protected policy store, or schema catalog.
- A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier and labeled as such. Tier is derived from the resolved import graph, not from the policy's own declaration, and a policy that under-declares fails inside `sealed` rather than escaping it.
- Native addons are refused from the `sealed` tier.
- User-owned convention policies are additive and non-authoritative, and replacing the directory containing them cannot weaken a protected policy.
- A user-added policy can tighten enforcement and can never weaken, cancel, or shadow a protected one.
- The pinned enabled set is root-owned: a user's own configuration can enable additional policies and parameterize the ones it enabled itself, and cannot disable, weaken, or reparameterize a pinned entry.
- A decision whose deciding policy read a client-asserted working directory, project directory, or environment fact is reported `sealed_unattested` rather than `sealed`, and a request that asserts a home directory is rejected rather than silently corrected.
- Setup discloses that the per-user agent's service definition lives in the user's home and is user-writable, and health reports a missing agent instead of silently dropping `user-context` enforcement.
- Promotion into the protected store yields one digest covering the policy and every dependency, and evaluation resolves nothing from a mutable path.
- The dashboard runs as the invoking user, is reachable only on loopback with a capability token and matching `Origin`, and shows one user only their own data on a multi-user machine.
- The dashboard performs no privileged mutation; a protected policy change produces a command to run, not an applied change.
- A dashboard stops on explicit `stop`, terminal exit, and TTL expiry, and leaves no pidfile claiming a server that is gone.
- Two enrolled users can run dashboards simultaneously without a port conflict.
- Removing or altering an enabled FailproofAI hook is detected and semantically repaired without overwriting unrelated harness settings; explicit disable/uninstall is not repaired.
- Collection consent names each enabled source and its destination, and can be revoked independently.
- A bad harness schema returns to the previous valid schema and registration without replacing or restarting the daemon.
- Old and new collectors never own the same source concurrently, and migration rollback restores a functional standalone collector with its undelivered state.
- Uninstall erases the delivery key even when performed offline, and never silently deletes undelivered or user-authored data.
- A macOS installation runs a Developer ID signed, notarized, and stapled release, and its LaunchDaemon starts on a machine that has been offline since installation.
- Linux and macOS pass the complete setup, service lifecycle, enforcement, schema refresh/rollback, and uninstall acceptance suite; Windows is not represented as a Phase 1 supported target.
