# Service and harness schema updates

## Service model

Phase 1 installs one scope, `user`. There is nothing to select:

| Scope | Linux | macOS | Runs as | Starts | Privilege to install or manage |
|---|---|---|---|---|---|
| `user` | systemd user service | LaunchAgent | the invoking user | user login | none |

One installation serves one user. Installing, upgrading, repairing, and removing it are ordinary file operations in that user's own tree, and the product contains no code path that invokes `sudo`.

On a machine several people share, each user who wants FailproofAI installs their own — one daemon, one socket, one state tree, one set of policies per user. Nothing is shared, so nothing needs to arbitrate between them; the socket's peer check exists to keep the daemons from answering each other's events, not to keep one user out of another's data, which the filesystem already does.

The two service managers are not symmetric, and the asymmetry reaches the on-disk layout rather than only the unit file. A systemd user unit's `RuntimeDirectory=failproofai` creates `$XDG_RUNTIME_DIR/failproofai` with the right owner and mode on every start and removes it on stop — it has to, because that directory is a tmpfs that does not survive a reboot. launchd has no equivalent, so on macOS the socket directory is created once and persists under `~/.failproofai/run/`. Describing it as one thing is how a macOS install ends up expecting a directory nobody created, so the daemon asserts existence, ownership, and mode before binding on both platforms and creates the directory when it is missing: the same check, satisfied by a different mechanism on each side. [Configuration and state](./03-daemon-architecture.md#configuration-and-state) gives the full table, including the `XDG_RUNTIME_DIR`-unset case that a plain `ssh` session produces on several distributions.

Lifetime differs from a system service in a way users will notice. A systemd user service starts at first login and stops when the last session ends; `loginctl enable-linger` is what keeps it running for a host driven over `ssh` or by cron, and setup says so rather than leaving the daemon inexplicably absent on the next unattended run. macOS LaunchAgents carry the equivalent constraint by construction.

macOS adds an obligation the service model cannot satisfy on its own: on an MDM-managed fleet whose configuration profile requires a Developer ID identity, `codesign --verify` fails for an unsigned binary, and without a stapled notarization ticket Gatekeeper resolves the assessment online at first launch — which fails on a machine that installed FailproofAI and then went offline. So the LaunchAgent leg of this table depends on the release being signed, notarized, and stapled. That is a release-pipeline obligation, specified in [code signing and notarization](./07-release-and-packaging.md#code-signing-and-notarization).

Everything the installation writes is owned by the user, and the design does not pretend that any part of it is out of that user's reach. There is no ownership split, no read-only surface, and no administrative operation that a different identity authorizes. What the layout is still responsible for is being *unambiguous and recoverable*: one versioned release directory with a `current` symlink so an upgrade is an atomic pointer move, an installation record that says which release this installation actually uses, and state directories whose writes are transactional so a crash cannot activate a half-written generation.

Policy administration is entirely unprivileged. A user installs, enables, disables, parameterizes, and removes any policy — builtin, explicit, or convention-discovered — with no elevation and no second class of policy. Admission still compiles each policy and its import graph into one content-addressed artifact, because that is what makes a decision name a digest rather than a path and what lets the sealed loader avoid a filesystem it has no binding for; it is a determinism mechanism, not a permission gate. Results combine as `deny` over `instruct` over `allow`, so adding a policy can only tighten enforcement — decision semantics that hold regardless of who owns what.

The daemon evaluates `sealed` policies inside its own embedded engine, in a context that registers no filesystem, subprocess, or network bindings, and routes policies whose resolved import graph needs any of those to a `user-context` worker it spawns. Both run as the user; the daemon never changes UID, and there is nothing for it to change UID to. The worker still gets a constructed environment, resource limits, and platform sandboxing — not to contain the user, but to keep a runaway policy from taking the machine down with it.

One user is bound to one endpoint. The case setup must handle is a *previous* evaluator rather than a competing scope: it detects an existing installation or a legacy hook-only one and transactionally switches its registrations rather than letting both answer.

Harness attachment is reported as `detectable` or `cooperative`. **`protected` is not reachable in this release**, because every harness settings file involved belongs to the governed user; setup reports repair capability honestly and never presents restoration as prevention. Missing or altered registrations are automatically repaired while enabled, and missing expected heartbeats or repeated alteration degrades local health and raises a local alert.

Windows is outside Phase 1. Its service model, named-pipe transport, and packaging belong to a later iteration.

The service definition contains executable and state paths but no secrets — the observability delivery key lives with the collector's configuration under `~/.agenteye/`, never in the unit file or a process argument — and sets a fixed `PATH`, so the daemon's children resolve the same way whether the daemon was started at login or from a shell with an unusual environment.

Its hardening is chosen against what the pinned runtime needs rather than copied off a checklist, and two entries on every such checklist are actively wrong here. `ProtectHome=yes` would make the daemon **unable to do its job**: capture reads `~/.codex/sessions`, `~/.factory`, `~/.openclaw`, `~/.gemini/antigravity-cli`, and `~/.local/share/{devin,goose}`, and `user-context` policies read the user's repository. `MemoryDenyWriteExecute=yes` refuses the writable-executable mapping a JIT depends on, so a V8-based policy runtime dies at its first compile under it — the same constraint that makes `com.apple.security.cs.allow-jit` a macOS signing requirement for the identical artifact. A bytecode interpreter needs neither relaxation, so which way that one goes follows from [open decision #3](./06-delivery-plan.md#open-decisions) and is recorded with it, not decided per platform.

### Deferred scopes

Two further scopes are designed and deliberately unshipped. Recording them here is what makes adding one later a packaging and service-registration change rather than a redesign, and it keeps the rest of these documents free of per-scope qualification.

| Scope | Linux | macOS | Runs as | Starts | Privilege to install or manage |
|---|---|---|---|---|---|
| `managed` | systemd system service | LaunchDaemon | a dedicated `_failproofai` account | machine boot | `sudo` at install; none at runtime |
| `system` | systemd system service | LaunchDaemon | `root` | machine boot | `sudo`/root |

**`managed`** is the design this version deliberately does not ship, and it is the only thing that would buy the claim this version deliberately does not make. It installs executables, the pinned runtime, an immutable content-addressed policy store, the active schema catalog, machine configuration, and a pinned enabled set root-owned and read-only to a dedicated `_failproofai` service account, under `/opt/failproofai/` and `/var/lib/failproofai/` on Linux and platform-appropriate `/Library` locations on macOS, with the socket directory under `/run/failproofai/`. The service account owns only mutable runtime state, so a compromised daemon can corrupt its own telemetry and nothing above it. Its layout has one hard constraint worth preserving: nothing enforcement depends on may live inside a user's home at any mode, because delete and rename permission come from the parent directory, so the owner of `~` can rename an unwritable subdirectory aside and substitute their own.

What it gains is a real boundary between the governed agent and the thing governing it:

- the `sealed` tier's verdict becomes **unforgeable by the governed user** — the runtime, the policy store, and the daemon process all sit outside their authority, so the attestation this version records as provenance becomes an integrity claim with no protocol change;
- the enabled set can be pinned in a root-owned `machine.json`, so a policy an agent may not switch off is possible at all — without which an unforgeable verdict is worth little, since deleting a name from a JSON array never reaches the evaluation the tier protects;
- the socket directory is owned by the service account, so no governed user can unlink the socket and bind an impostor that answers `allow`;
- a machine-level harness registration becomes possible, which is what makes an attachment genuinely `protected` rather than merely `detectable`.

What it costs is what this version chose not to pay: one-time administrator access, a supported service manager, a service account to create and remove, an ownership split to get right on two platforms, a privileged installer to make transactional, and per-scope qualification on every claim in these documents. It should be added when a customer needs enforcement their own developers cannot switch off — which is a real requirement, and a different product decision from the one this release makes.

**`system`** is `managed` running as root, with machine configuration under root-owned `/etc/failproofai`. It exists for fleet-managed machines whose configuration management owns `/etc`, and for serving agents that themselves run as root. Against an ordinary agent it is no more tamper-resistant than `managed` and has a strictly larger blast radius if the daemon is compromised, so it should be added when a customer's configuration management requires `/etc`, or when agents genuinely run as root, and not otherwise.

Adding either one reintroduces per-scope qualification wherever a verdict-integrity or protected-placement claim appears, and its UI must state which guarantee applies rather than presenting the scopes as interchangeable. Neither may ever be reachable as an automatic escalation from a `user` install: a product that quietly acquires a privileged service is a worse failure than one that asks.

## No automatic binary replacement

Phase 1 does not download, replace, or restart `failproofai` or `failproofaid` automatically. There is no updater helper, version-pointer activation protocol, or background native release channel. Native upgrades are explicit customer actions through the npm setup path.

This keeps the installed binaries stable while solving the faster-moving compatibility problem independently: agent harnesses auto-update and frequently change their hook configuration schemas, at a cadence no binary-replacement mechanism should be asked to track.

## Signed harness schema catalog

FailproofAI publishes a signed, versioned catalog containing declarative adapter data:

- harness identity and executable/version detection rules;
- supported exact versions or version ranges;
- settings locations and configuration scope;
- hook event names, matcher structure, command representation, and response capabilities;
- semantic merge and validation rules;
- registration protection and known bypass limitations;
- minimum catalog format and daemon/client capability versions.

The catalog contains data only—no executable code, scripts, dynamic library, policy, or unrestricted template language. Schema validation rejects unknown operations, paths outside the adapter's declared settings locations, commands other than the installed FailproofAI hook client, and catalog entries requiring unsupported daemon capabilities.

### Version-detection execution grammar

Version detection is the one place a catalog causes a process to run, and catalogs refresh remotely and activate automatically — so "side-effect-free" needs a closed grammar rather than an adjective.

A detection rule names an executable by one of a fixed set of resolution strategies (an absolute path, or a name resolved against an adapter-declared directory allowlist) and a fixed argument vector drawn from a per-adapter allowlist. Arguments are literals; there is no interpolation of catalog data into them. Execution is direct, never through a shell, so no expansion, globbing, redirection, or command substitution is reachable. The child gets a constructed environment, closed file descriptors apart from captured stdout/stderr, no stdin, no network namespace access where the platform can express it, a byte cap on captured output, a wall-clock timeout, and no ability to spawn further processes.

Anything a catalog asks for outside this grammar is a validation failure that rejects the generation, not a warning. A detection rule that times out, exceeds its output cap, or exits nonzero yields "version unknown" and the compatibility path for that harness — it never falls back to executing something else.

The catalog is maintained in the FailproofAI repository, reviewed like code, built reproducibly, and published as an immutable signed artifact. The daemon ships a baseline catalog so fresh installation and offline operation work without a network connection. Refresh is an unauthenticated fetch of a signed artifact and needs no account; a user may also pin the bundled catalog or supply a locally verified one instead.

## Version selection and reconciliation

For each enabled harness, the daemon:

1. detects the installed executable and obtains its version using a bounded side-effect-free adapter rule;
2. selects the most specific compatible schema: exact version before the narrowest matching range;
3. rejects ambiguous matches and never guesses across an unsupported major version;
4. compares the desired registration with the parsed settings file;
5. atomically merges and verifies the FailproofAI-owned entries;
6. records harness version, schema ID, catalog generation, and resulting registration identity.

Harness executable/version changes, settings-file changes, and a periodic scan all trigger reconciliation. If the detected version has no compatible schema, the daemon retains the last known registration only when its compatibility rule permits it; otherwise health becomes `unsupported_harness_version` and the user is told enforcement coverage is not assured.

## Catalog update transaction

Catalog refresh runs with jitter and can also be requested manually. It downloads a size-bounded candidate, verifies the publisher signature and content digest, checks monotonic generation/replay rules and format compatibility, then fully validates every applicable adapter away from active state.

The daemon persists the candidate and previous catalog, fsyncs them, atomically changes the active catalog pointer, and reconciles affected harnesses. If parsing, registration validation, or a synthetic adapter check fails, it restores the previous catalog and previous hook registration. A rejected generation is suppressed until a newer generation arrives or the user explicitly retries.

Activation is crash-consistent, not merely atomic. Ordering is explicit: catalog contents are written and fsynced, their directory is fsynced, the pointer is replaced by same-directory temporary file plus rename, and the containing directory is fsynced again before reconciliation begins — so a crash at any point leaves the pointer referring to a complete, signed, verified generation. Because reconciliation follows activation, the crash window between them can leave the active catalog ahead of the hook registrations it implies. Activation therefore records transaction metadata naming the intended generation and its reconciliation state, and startup recovery reads that record, re-verifies the referenced generation, and re-runs reconciliation for any harness not yet confirmed rather than assuming the on-disk registration matches. An unreadable or incomplete transaction record selects the previous generation. Fault-injection tests interrupt at each of these points and assert that startup restores a complete catalog/registration pair.

Catalog updates do not restart the daemon or interrupt enforcement. If a schema needs behavior unavailable in the installed daemon/hook client, it is not activated and status reports `binary_update_required`. The user then explicitly reruns the supported npm setup command; the catalog never attempts that upgrade itself.

## Acceptance criteria

- The user service passes lifecycle tests on systemd and launchd, including stop/start across a logout with and without `loginctl enable-linger`.
- Installation completes with no elevation on a machine where `sudo` is not installed, and a filesystem diff shows nothing written outside the user's tree, the service-manager directory, and the harness settings files.
- A peer that is not the socket's owner is refused, and two users' daemons on one machine never answer each other's events.
- The socket directory has the expected owner and mode after a reboot on both platforms — recreated by `RuntimeDirectory=` on systemd, persisted under the user's home on launchd — and the daemon refuses to bind rather than proceeding when it does not.
- The daemon starts in a session where `XDG_RUNTIME_DIR` is unset, binding under `~/.failproofai/run/`.
- The macOS service starts from a signed, notarized, and stapled release on a machine that has been offline since installation.
- A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier; a `user-context` result can tighten a `sealed` one and never relax it, and a policy that under-declares fails inside `sealed` rather than escaping it.
- No lifecycle, health, or diagnostic output claims tamper resistance or verdict integrity.
- A catalog whose version-detection rule falls outside the execution grammar is rejected rather than warned about, and a detection failure yields "version unknown" instead of an alternate command.
- Interrupting catalog activation at any step leaves the pointer on a complete signed generation, and startup recovery re-reconciles any harness whose registration is unconfirmed.
- A harness version change selects the correct exact/range schema and repairs its hook registration.
- Ambiguous, unsupported, tampered, replayed, executable, or capability-incompatible catalog data is rejected.
- Power loss during catalog persistence leaves either the previous or candidate complete signed generation active.
- A bad schema restores both the previous catalog and valid hook registration without restarting the daemon.
- Offline installs use the bundled baseline catalog.
- No background path downloads or activates a native executable.
