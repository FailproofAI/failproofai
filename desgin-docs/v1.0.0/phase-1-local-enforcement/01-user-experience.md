# User experience

## Product promise

A user installs FailproofAI once, as themselves, on a machine they may not administer. From then on:

- `failproofaid` starts when they log in;
- supported agent harnesses send events to the local daemon;
- builtin and user-authored policies work locally with no account and no network connection;
- session data is captured and delivered to the configured observability server when enabled, and is visible in local activity, audits, and the local dashboard;
- service, policy, capture, and delivery health are always visible locally;
- hook registrations automatically track supported harness schema changes without replacing the daemon binary.

The user should not need to understand hooks, service managers, sockets, transcript formats, or collector processes.

Phase 1 is complete and shippable on its own: it is the product as it ships today, re-architected around the daemon. Nothing here needs a FailproofAI account, an organization, or administrator access, and no policy decision depends on a network service. Where the current product already has credentials they are carried over unchanged, not reinvented — `failproofai auth login` keeps working as it does now, and capture delivers to the customer's own self-hosted observability server with the operator-issued `events:add` key it already uses.

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

The promise is unqualified this time. Installation needs no administrator access, no service account, and no elevation, so there is no machine on which the current release works and Phase 1 does not.

The standalone `agenteye-collector` moves into the daemon here rather than later, because it is shipped behavior and this promise covers it. [Collector integration](./05-collector-integration.md) describes the takeover, which preserves pending and failed batches in place until `failproofaid` proves ownership and delivery health, and which is reversible for a defined window.

## Two programs, and what runs when

The runtime surface is two programs, and it is worth stating as a checkable property rather than leaving it to be inferred:

| Program | Lifetime | Started by |
|---|---|---|
| `failproofaid` | resident, one per logged-in user | the user's own service manager at login, or `failproofai service start` |
| `failproofai` | transient | the user, and the harness once per hook event |

That is the whole accounting. There is no per-user agent, no collector process, no dashboard service, and no privileged helper.

The CLI wears three hats and stays one program in all of them. As `failproofai hook …` it is the harness-facing client: spawned by the *harness* per event, holding no state, exiting after one request. That per-event process is not a third program of ours — it is the harness invoking our CLI, exactly as it invokes `npx -y failproofai` today. As `failproofai dashboard start` it is the dashboard: the listener lives in that CLI invocation and dies with it. As everything else it is the ordinary command-line tool.

The one place a fourth process appears is inside a CLI invocation's own lifetime: serving the bundled dashboard, or evaluating a `user-context` policy, may run the shipped policy runtime as a child. Those children are owned by the invocation that spawned them, terminate with it, and are never registered with a service manager or restarted by anything. Nothing supervises them, so nothing has to be uninstalled when they are gone.

## Installation

### Primary path

The single supported installation entry point remains:

```sh
npx failproofai@latest setup
```

The npm package uses npm integrity and trusted-publishing provenance for bootstrap trust. It downloads and independently verifies the signed native release, installs `failproofai` and `failproofaid` into a stable versioned directory under the user's own tree, and hands control to the native setup flow. It declares no install lifecycle script; all machine changes occur during explicit `setup`.

Homebrew, shell installers, direct-download installation, containers, mirrors, and offline bundles are outside distribution scope. Windows is also not a Phase 1 daemon target. The npm bootstrapper detects it before downloading or modifying anything and explains that support is planned for a later iteration.

The npm bootstrap and native artifact design is in [npm release and distribution](./07-release-and-packaging.md).

### One scope, and it is the user's

Everything installs and runs as the invoking user. There is no scope question in setup, because there is nothing to choose between: the daemon is the user's, its configuration is `.failproofai` in user scope, its state is under `~/.failproofai/` and `~/.agenteye/`, and its service definition is a systemd user unit or a LaunchAgent. Setup never asks for elevation, never writes outside the user's tree, and works identically on a machine where the user has no administrator access at all.

A `managed` scope running as a dedicated service account and a root-owned `system` scope are designed and deliberately unshipped. Their layouts and the exact guarantee each one gains are recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes) so either can be added when a customer needs it. Neither is a fallback setup may select on its own, and neither is implied by anything in this release.

### Setup flow

`failproofai setup` performs these steps:

1. **Preflight** — detect the OS, architecture, service-manager availability, supported agent harnesses, existing FailproofAI hooks, and an existing `agenteye-collector` installation. Nothing here can refuse the install; a missing service manager is a reported degradation, not a stop.
2. **Choose integrations** — show detected harnesses and let the user enable enforcement for each one, reporting the attachment level each one can actually reach. Existing hooks are migrated rather than duplicated.
3. **Choose policies** — preserve current builtin selection and custom/convention policy discovery.
4. **Choose observability** — explain which session sources can be captured and exactly where their data goes: on-machine only, or also delivered to a self-hosted observability server the user names along with its `events:add` key. Require explicit selection before any transcript is read, and default to capturing nothing.
5. **Install the service** — write configuration and the delivery key under the user's tree, register the user service, start it, and wait for IPC readiness. An existing `agenteye-collector` is taken over rather than duplicated.
6. **Verify end to end** — run a harmless synthetic hook request and verify every enabled capability, including source progress and, when a destination is configured, a delivery round trip.
7. **Report completion** — show the service state, enabled harnesses, local policy state, capture sources, delivery health, and how to open the local dashboard.

Setup is transactional. If a later step fails, it restores the previous harness configuration, collector ownership, and service state. Re-running setup converges the same installation rather than creating a second service or a duplicate hook. It never leaves half-installed hooks pointing at a missing daemon, and never leaves two capture owners on one source.

### When there is no service manager

systemd and launchd are how the daemon starts at login and restarts after a crash, and one of them is present on essentially every developer machine. Where neither is — a bare container, a stripped image, an `ssh` session on a host with no user session bus — setup does not refuse. It completes, starts the daemon directly, and reports it as `unsupervised` in health, which means exactly what it says: the daemon is running, and nothing will restart it or bring it back at next login. `failproofai service start` is then the way to start it again.

That is a tolerable degradation rather than a hole, because an unreachable daemon is not lost enforcement. The hook client falls back to the in-process evaluator, which is the code path shipping today and carries the same authority as the daemon; the cost is the per-event process start and the sandbox, not the decision.

### CLI presentation

The new setup steps reuse the current polished `failproofai config` wizard rather than introducing a second installer UI:

- the existing FailproofAI logomark and pink/teal palette;
- keyboard navigation with a visible `❯` active row;
- descriptions aligned beside or beneath each choice;
- a persistent step spine and compact summaries for completed steps;
- terminal-width-aware wrapping and the existing ANSI fallback;
- a final review showing the exact service, harness files, policy configuration, capture sources, and delivery destination that will change;
- Enter to confirm and a clear cancellation path that writes nothing.

The final review should read approximately:

```text
◆ Review

  Service      systemd user service, starts when you log in
  Installs to  ~/.failproofai (binaries, policies, state)
               ~/.agenteye    (capture state, spool, delivery key)
  Harnesses    claude, codex — hooks added to your own settings files
  Policies     11 builtin, 1 custom (./company-policies.mjs)
  Capture      codex → https://agenteye.internal
  Privileges   none, now or ever

  ❯ Apply
    Cancel
```

Nothing in this flow requests elevation, and the review names every place it writes: the two directories, the harness settings files, and the service definition in the user's own service-manager directory.

### Non-interactive installation

Automation uses the same operation with structured inputs:

```sh
failproofai setup \
  --non-interactive \
  --harness claude --harness codex \
  --capture codex \
  --observability-url https://agenteye.internal \
  --observability-key "$EVENTS_ADD_KEY"
```

The command returns machine-readable failure codes and supports `--json`. Re-running it converges the installation to the requested state instead of creating duplicate services or hooks. The delivery key is read from the environment or a file, written to the user's own configuration, and never appears in the generated service definition or in process arguments.

`--service-scope` remains accepted and optional, with `user` as its only valid value. It exists so automation written now keeps working unchanged when a deferred scope ships, and so a script that states its intent explicitly is not silently reinterpreted later. Passing `managed` or `system` is a hard error naming them as deferred, never a silent substitution.

### The user service

The service is a systemd user service on Linux or a LaunchAgent on macOS, running as the user who installed it. It starts at login rather than at boot, and it serves exactly one user: its owner.

On a shared machine that means one daemon per user who installed one, each with its own socket, its own state, and its own policies. The socket is peer-credentialed and refuses any peer that is not its owner — not as a privilege boundary, since the owner is the only one who could gain anything by connecting, but because two users' daemons must never answer for each other's events.

A systemd user service stops when the user's last session ends and starts again at the next login. For an interactive machine that is the correct behavior. For a host where agents run without an interactive session — a build box driven over `ssh`, a cron-driven agent — the user enables `loginctl enable-linger` once, and setup says so rather than leaving the daemon mysteriously absent. macOS LaunchAgents have the equivalent constraint by construction: they run in the user's GUI/login session.

Nothing about this installation is protected from the user who owns it, and nothing in the product says otherwise. The daemon runs as them, its binaries sit in a directory they own, and its configuration is a file they can edit. That is the deliberate shape of this release, and [where policies execute](#where-policies-execute) states exactly what the architecture buys instead.

#### Adding, removing, and enabling a policy are all unprivileged

There is no privileged policy administration, because there is no privileged surface. A user installs, enables, disables, parameterizes, and removes any policy — builtin, explicit, or convention-discovered — with no elevation and no audit gate.

What survives from the previous design is the *semantics*, which were always independent of privilege: results combine as `deny` over `instruct` over `allow` with no suppression, so adding a policy can only make enforcement stricter, and the merge across project, local, and user configuration works exactly as it does today. Convention discovery under `.failproofai/policies/` is unchanged.

Enablement is likewise ordinary configuration: `.failproofai/policies-config.json` merged across project, local, and user scope, which is what the product reads today and what the daemon evaluates. It is authoritative, and it is the user's.

#### Where policies execute

Evaluation is split into two tiers by what a policy's resolved imports need:

| Tier | Runs in | Filesystem, subprocess, network |
|---|---|---|
| `sealed` | the daemon's own embedded engine | absent — no bindings are registered at all |
| `user-context` | a worker the daemon spawns | granted, with the user's own authority |

The names describe capability, not identity: both run as the same user, and the daemon does not need to `setuid` to anything. Resolved against the real import graph, 32 of the 39 builtins are `sealed` — `block-sudo`, `block-env-files`, and `block-secrets-write` among them — because tool name, command, file path, and old/new content already arrive in the hook payload. The seven that are not are `warn-repeated-tool-calls`, `block-work-on-main`, and the five `require-*-before-stop` policies, each of which reads the repository or runs `git`.

**The split is not a verdict-integrity mechanism, and this release does not have one.** The agent being governed runs as the same user as the daemon evaluating its events. It can `ptrace` that daemon, `LD_PRELOAD` into it, replace the binary on disk, edit `policies-config.json`, or stop the service. No arrangement of processes owned by one user protects that user's processes from each other, and nothing in the product — health output, `policies explain`, the dashboard, the documentation — may say or imply that it does.

Four things the tier does buy, all of them real and none of them adversarial:

- **A warm evaluator.** Today every tool call spawns a fresh Node or bun process that re-reads configuration and re-imports every policy file. The sealed engine is already loaded when the event arrives.
- **No temp files beside the user's source.** The current dynamic-import path writes a `.__failproofai_tmp__.mjs` next to the policy file on *every tool call*. The sealed tier resolves from a compiled module map and writes nothing.
- **A deadline that is actually enforced.** A synchronous policy body cannot be interrupted by checking a clock between microtasks; it needs an out-of-band watchdog. There is one, it is armed before the runtime is entered, and it exists because a default-enabled policy's backtracking regex wedged the enforcement lane for 30 seconds against a 200 ms deadline before it was added.
- **A blast radius for mistakes.** The sealed context registers no filesystem, process, or network bindings, so a policy that reaches for one gets a `ReferenceError` — a visible evaluation failure that trips a circuit breaker — instead of quietly doing something its author did not intend on a developer's machine. That contains a buggy or over-reaching policy. It does not contain a hostile one, because a hostile author would simply write a `user-context` policy instead.

The distinction between those two sentences is the whole point. Containing mistakes is worth building; claiming it contains adversaries would be false. A [deferred scope](./04-service-and-updates.md#deferred-scopes) is what would make the stronger claim true, and adding one is the only thing that would.

**A policy's own declaration is still not the routing input.** Admission derives the requirement from the resolved import graph rather than a manifest, and the `sealed` context is deny-by-default, so a policy that under-declares fails inside the tier rather than escaping it. That matters for a plain engineering reason now: an author who believes their policy is payload-only and is wrong should find out at admission, not by watching enforcement behave differently in production. Native addons cannot be inlined into the compiled artifact and are therefore always `user-context`.

Policy provenance, resolved capabilities, and execution tier are recorded with every decision, and `policies explain` reports the tier so nobody has to infer it.

#### Endpoint and attachment

Only one endpoint handles a given user's harness hooks. Setup detects an existing FailproofAI installation — a legacy hook-only install pointing at `npx failproofai`, or a previous daemon — and offers an explicit transactional switch; it does not register duplicate hooks or let two evaluators race.

The final review reports each harness as `detectable` or `cooperative`. **`protected` is not reachable in this release and the label is not used.** Every harness settings file this installation writes is a file the governed user owns, so the daemon can watch it, notice a removed or altered FailproofAI entry, and restore it — which genuinely repairs a harness upgrade that dropped a hook, or an accidental edit — but cannot prevent the removal. Reporting repair as prevention is forbidden. A registration the governed user cannot write requires a machine-level hook, a mandatory plugin, or an enforced launcher path, all of which need a [deferred scope](./04-service-and-updates.md#deferred-scopes).

## Policy authoring

Users keep the current authoring workflow:

```sh
failproofai policies --install block-sudo --scope user
failproofai policies --install --custom ./company-policies.mjs
```

They may also place convention policies in `.failproofai/policies/` at project or user scope. The daemon watches and atomically reloads them, while invalid changes retain the last known-good generation and appear in local health.

Authoring is unprivileged, and dependencies are the author's own. A policy is developed with the normal npm workflow:

```sh
npm install @octokit/rest
failproofai policies --install ./gh-policy.mjs
```

Installing a policy admits it: admission resolves its full import graph and compiles it into a single content-addressed artifact under the user's state directory, so one digest covers the policy and every dependency, evaluation resolves nothing from a mutable path, and the decision record names exactly what ran. That is a determinism and evidence mechanism rather than a protection one — it is what lets `policies explain` say which bytes produced a verdict, and what lets the sealed loader be a map lookup that cannot reach a filesystem it has no binding for.

Native `.node` addons cannot be inlined; admission copies them alongside the artifact with their digests pinned and routes the policy to `user-context`.

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

`policies explain` shows the effective policies for a target, their source and scope, the precedence calculation, active revision, resolved capabilities, execution tier, and why an expected policy did or did not apply. A policy that landed in the `user-context` tier says which resolved import put it there, so an author who expected it to run in the sandbox finds out at install time rather than after a slow hook.

It also reports the decision's attestation, which is not the same thing as its tier. A policy that ran `sealed` but read the working directory, the project directory, or an environment fact took a value the daemon cannot derive and the client asserts, so its decision is reported `sealed_unattested` rather than `sealed`. In this release that is provenance rather than an integrity claim — it says what the decision depended on, which is what makes a surprising verdict diagnosable. [Derived and asserted context](./03-daemon-architecture.md#derived-and-asserted-context) explains which fields those are.

`doctor` performs read-only checks by default: executable layout, service registration, endpoint ownership, protocol compatibility, policy generation, source permissions, spool health, and harness/schema compatibility. Any repair beyond automatic restoration of enabled FailproofAI hook entries requires an explicit flag or confirmation.

## Local dashboard

The local dashboard survives unchanged as a product surface, but it needs an explicit access model, because a browser cannot speak the daemon's Unix socket and a TCP listener carries no peer credentials.

**The dashboard is the CLI in dashboard mode, not a service.** `failproofai dashboard start` binds the listener inside that CLI invocation and holds it for its TTL; the daemon is only a data source reached over the existing socket, and has no dashboard concept at all. Peer credentials then scope every read with no new mechanism: the daemon cannot tell a dashboard request from any other client, and does not need to.

A pidfile in the user's runtime directory records the running instance, its port, and its expiry, which is what `stop` and `status` read and what makes a second `start` reattach instead of binding a second server.

### Listener

The listener binds loopback only, on an ephemeral port rather than a fixed one — a fixed port collides the moment two users are logged into the same machine. `start` prints the URL and opens it.

Access requires a capability token minted at launch, carried in a request header or a `SameSite=Strict` cookie rather than the query string, where it would leak through `Referer`. Requests are rejected unless `Origin` and `Host` match the bound listener, and no endpoint changes state on `GET`. Both rules exist because any page the user visits can issue requests to a localhost port; neither the token nor loopback binding is sufficient alone. They defend against a *web page the user happens to open*, which is a different party from the user's own agent, and that is why they are still worth having.

An agent running as the user can read that token. It already holds that user's authority, so this changes nothing.

### Lifetime

The dashboard is on-demand — a UI people open occasionally should not be an idle listener, and making it a service would add a third program to a release whose whole shape is two. It stops on `failproofai dashboard stop`, when its terminal exits, and when its TTL expires, default 30 minutes and overridable with `--ttl`. Expiry closes the listener and invalidates the token; the pidfile is removed on every path, including expiry, so `status` never reports a server that is gone.

### Reads and writes

Reads use the daemon's `Query` operations and return the caller's activity, sessions, transcripts, and policy state.

Writes are ordinary. Toggles and parameters change the user's own configuration directly, with no elevation and no second class of policy, because there is no privileged policy surface for the dashboard to gate. Whether a toggle writes the configuration file directly or goes through a daemon operation is [open decision #13](./06-delivery-plan.md#open-decisions) — a correctness question about keeping one merge implementation, not a permission question.

## Status and health

`status` answers whether the service manager believes the daemon is installed and running. `health` answers whether the product is working.

The default health view reports independently:

- daemon and IPC readiness, and whether the daemon is supervised by a service manager or running unsupervised;
- active local policy generation and last reload result;
- policy counts by execution tier;
- enabled harnesses and their last event;
- hook registration state, last verification/repair, and persistent alteration alerts;
- enabled capture sources and checkpoint progress;
- pending, retrying, and quarantined delivery data, and the age of the oldest unacknowledged batch;
- disk or memory pressure;
- detected harness versions, active schema generation, and unsupported or binary-update-required adapters.

A process can be running while policy reload, capture, or delivery is unhealthy. The UI must never collapse these into one green status. Delivery reports `not_configured` when no destination is set, which is a state rather than a warning.

Health reports tier counts as a description of where evaluation happens, never as a security score. No health field, badge, or summary line asserts tamper resistance, and none may be added.

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

The daemon-unavailable behavior is explicit and mild: the hook client evaluates in process, exactly as the current release does, and records the degradation. Later releases may apply a configured per-integration failure mode, but the default is not a gap — it is the evaluator this product ships today. Stop-class integrations receive special handling to prevent retry loops.

## Uninstall and data ownership

`failproofai uninstall`:

1. disables installed harness integrations;
2. stops and removes the user service;
3. removes installed executables, the pinned policy runtime, and harness schema-catalog state;
4. securely erases the configured delivery key;
5. preserves local policy files, logs, activity, pending events, and non-secret configuration by default.

Step 4 is unconditional and separate from step 5, because a delivery key is a credential rather than configuration: an uninstall performed offline must leave nothing on disk that could still authenticate to the observability server.

Uninstall touches only the invoking user's tree. On a shared machine another user's installation is untouched, and there is no shared state and no account to remove.

`--purge` additionally removes retained local state after showing exactly which directories and undelivered records will be deleted.

Taking over from the standalone collector preserves pending and failed batches until `failproofaid` proves ownership and delivery health. Uninstall during the rollback window must be able to restore the old collector rather than strand its data.

## UX acceptance criteria

- A user with no administrator access, on a machine where `sudo` is absent, reaches a healthy daemon and one enforced synthetic hook through one setup command without a FailproofAI account, and can then enforce entirely offline. Installation itself requires network access, since npm bootstrap is the only supported distribution path.
- Setup writes nothing outside `~/.failproofai/`, `~/.agenteye/`, the user's service-manager directory, and the harness settings files it was asked to change — asserted by a filesystem diff, including the absence of anything under `/opt`, `/var/lib`, `/etc`, and `/Library`.
- Setup never invokes `sudo`, and the shipped release contains no code path that does.
- No policy decision depends on a network service, and a machine with no observability destination configured spools nothing and delivers nowhere.
- Every capability the standalone `agenteye-collector` ships today — capture across its supported sources, one-time backfill, exactly-once delivery across restarts, quarantine, and `health` — is available from the daemon and covered by the collector's own conformance tests, reading and writing the same `~/.agenteye/` state.
- Every current OSS policy authoring, discovery, scope, CLI, harness, activity, dashboard, and audit behavior has a compatibility test and remains available.
- Re-running setup is idempotent.
- Setup failure restores prior service and harness configuration.
- A machine with no systemd and no launchd completes setup, runs the daemon, and reports it as `unsupervised`; killing the daemon there degrades to in-process evaluation rather than losing enforcement.
- `--service-scope managed` and `--service-scope system` fail with a deferred-scope error rather than installing something different from what was asked for.
- Two users on one machine run independent daemons; each socket refuses the other's peer, and neither user's `Query` results contain the other's data.
- Users can identify the exact policy revision, resolved capabilities, and execution tier responsible for a decision.
- No product surface — health, `policies explain`, the dashboard, setup output, or documentation — claims tamper resistance, verdict unforgeability, or protection from the user's own agent. A grep-level test over shipped user-visible strings enforces this.
- Harness attachment is reported as `detectable` or `cooperative`; the string `protected` does not appear as an attachment level.
- A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier and labeled as such. Tier is derived from the resolved import graph, not from the policy's own declaration, and a policy that under-declares fails inside `sealed` rather than escaping it.
- A policy whose body loops or backtracks past its deadline is interrupted out of band, reported as a deadline miss distinctly from an evaluation failure, and does not wedge the enforcement lane.
- Evaluation writes no temp file next to a user's policy source, on any path.
- Admission yields one digest covering the policy and every dependency, and evaluation resolves nothing from a mutable path.
- A decision whose deciding policy read a client-asserted working directory, project directory, or environment fact is reported `sealed_unattested` rather than `sealed`, and a request that asserts a home directory is rejected rather than silently corrected.
- The dashboard runs as the invoking user, is reachable only on loopback with a capability token and matching `Origin`, and is not registered with any service manager.
- A dashboard stops on explicit `stop`, terminal exit, and TTL expiry, and leaves no pidfile claiming a server that is gone.
- Two users can run dashboards simultaneously without a port conflict.
- Removing or altering an enabled FailproofAI hook is detected and semantically repaired without overwriting unrelated harness settings; explicit disable/uninstall is not repaired.
- Collection consent names each enabled source and its destination, and can be revoked independently.
- A bad harness schema returns to the previous valid schema and registration without replacing or restarting the daemon.
- The old collector and the daemon never own the same source concurrently, and rollback restores a functional standalone collector with its undelivered state.
- Uninstall erases the delivery key even when performed offline, and never silently deletes undelivered or user-authored data.
- A macOS installation runs a Developer ID signed, notarized, and stapled release, and its LaunchAgent starts on a machine that has been offline since installation.
- Linux and macOS pass the complete setup, service lifecycle, enforcement, schema refresh/rollback, and uninstall acceptance suite; Windows is not represented as a Phase 1 supported target.
