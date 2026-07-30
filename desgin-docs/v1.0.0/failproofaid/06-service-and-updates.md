# Service and harness schema updates

## Service model

Setup selects one explicit service scope:

| Scope | Linux | macOS | Runs as | Starts | Privilege to manage |
|---|---|---|---|---|---|
| `managed` (recommended) | systemd system service | LaunchDaemon | `_failproofai` | machine boot | `sudo` at install; none at runtime |
| `system` | systemd system service | LaunchDaemon | `root` | machine boot | `sudo`/root |
| `user` | systemd user service | LaunchAgent | the user | user login | none |

User scope owns only that user's configuration, credentials, policies, transcripts, activity, and socket. Managed and system scope support multiple explicitly enrolled users.

Ownership in a privileged install is split by **writer**, so the service account the daemon runs as is not the account that can modify what the daemon enforces:

| Artifact | Owner | Daemon's access | Written by |
|---|---|---|---|
| executables, pinned runtime | root | read + execute | privileged installer |
| protected policy store, active schema catalog | root | read | privileged installer |
| machine configuration, service definition | root | read | privileged installer |
| spool, checkpoints, activity, per-user state, health, logs, socket directory | `_failproofai` | read + write | the daemon |

Ownership alone would not have been enough: a store owned by the same account the daemon runs as is writable by any process holding that UID, including a compromised daemon, which would let it rewrite the sealed policies it is supposed to evaluate. Making the protected surface root-owned and read-only bounds a daemon compromise to corrupting its own telemetry. Every mutation of the protected surface goes through an elevated CLI operation and produces an audit record.

Managed scope is the recommended tamper-resistant option. Creating the `_failproofai` account and registering the service require `sudo` once; after that the daemon holds no root privilege, so a defect in it does not yield a root compromise. System scope is the same service running as root, retained for fleet-managed machines whose configuration management owns `/etc` and for serving agents that themselves run as root. Against an ordinary agent it is no more tamper-resistant than managed scope and has a larger blast radius, so managed is preferred wherever both apply.

User scope is convenient and complete, but an agent with the same OS permissions can stop it or modify user-owned configuration; it is cooperative enforcement. In managed and system scope, only root-authorized administrative requests may stop, reconfigure, replace, or remove the daemon, register protected policy, or mutate its active protected generation — the service account can run the daemon but cannot administer it. Enrolled clients can submit hook events and read their authorized status, but cannot call administrative operations.

Protected placement must survive the filesystem, not just the permission bits. Delete and rename permission derive from the parent directory, so protected artifacts cannot live inside a user's home at any mode — the owner of `~` can rename an unwritable subdirectory aside and substitute their own. Managed and system scope keep configuration, the policy store, per-user protected state, and the socket directory on paths whose every component is owned by the service account or root.

Protected policies are compiled into a root-owned immutable content-addressed store during an elevated install operation, with one digest covering the policy and every inlined dependency. The daemon evaluates a committed revision, not a mutable user source path. Changing, disabling, or deleting that revision requires an explicit privileged CLI operation and produces an audit record. Editable user/project policies remain available but are labeled `mutable` rather than tamper-resistant.

Within policy administration, **adding is unprivileged and removing is not**. Installation itself is a separate matter — creating the service account, installing the release, and registering the service all require `sudo`, as does every mutation of the protected surface above. What needs no elevation is a user adding a `mutable` policy of their own: results combine as `deny` over `instruct` over `allow` with no unauthorized suppression, so such a policy can only tighten enforcement and can never weaken, cancel, or shadow a protected one. Convention discovery therefore continues to work without elevation in every scope, while removing, disabling, or altering an *admitted* revision stays privileged.

Managed scope is a supervisor, not an execution context for user code, and it cannot `setuid` to an enrolled user. Unix-socket peer credentials select a per-UID policy/session context. Policies admitted to the `sealed` tier evaluate inside the daemon's pinned runtime as the service account in a context that exposes no filesystem, subprocess, or network bindings at all; policies whose resolved import graph needs any of those are admitted to the `user-context` tier and evaluate in a worker running as the requesting UID with that user's own authority, reduced groups and environment, resource limits, and platform sandboxing. Per-user queues, storage quotas, and authorization prevent cross-user reads or resource starvation. Only administrator-owned machine policy may be assigned machine-wide.

One user is bound to one endpoint. Setup detects conflicts between scopes and transactionally switches hook registrations; two services may exist only when their enrolled user sets do not overlap. A managed or system installation does not rewrite all users' harness files implicitly.

Harness attachment is reported as `protected`, `detectable`, or `cooperative`. Setup uses the strongest available registration and never reports tamper resistance unless both the daemon/policy plane and harness invocation boundary are protected. Missing or altered registrations are automatically repaired while enabled. Missing expected heartbeats or repeated repair raises a local and, when connected, Failproof Cloud alert.

Windows is outside the v1.0.0 service scope. Its service model, named-pipe transport, and packaging belong to the next iteration.

Service configuration contains executable and state paths but no secrets, and sets a fixed `PATH` so nothing the daemon spawns resolves through a user-controlled search path. User-scope operations never request elevation. Managed- and system-scope mutations require `sudo`; no sudo password is stored.

## No automatic binary replacement

v1.0.0 does not download, replace, or restart `failproofai` or `failproofaid` automatically. There is no updater helper, version-pointer activation protocol, or background native release channel. Native upgrades are explicit customer actions through the npm setup path.

This keeps the privileged service stable while solving the faster-moving compatibility problem independently: agent harnesses auto-update and frequently change their hook configuration schemas.

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

The catalog is maintained in the FailproofAI repository, reviewed like code, built reproducibly, and published as an immutable signed artifact. The daemon ships a baseline catalog so fresh installation and offline operation work without a network connection. Standalone OSS users may also pin or provide a locally verified catalog without Failproof Cloud.

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

The daemon persists the candidate and previous catalog, fsyncs them, atomically changes the active catalog pointer, and reconciles affected harnesses. If parsing, registration validation, or a synthetic adapter check fails, it restores the previous catalog and previous hook registration. A rejected generation is suppressed until a newer generation or explicit administrator retry.

Activation is crash-consistent, not merely atomic. Ordering is explicit: catalog contents are written and fsynced, their directory is fsynced, the pointer is replaced by same-directory temporary file plus rename, and the containing directory is fsynced again before reconciliation begins — so a crash at any point leaves the pointer referring to a complete, signed, verified generation. Because reconciliation follows activation, the crash window between them can leave the active catalog ahead of the hook registrations it implies. Activation therefore records transaction metadata naming the intended generation and its reconciliation state, and startup recovery reads that record, re-verifies the referenced generation, and re-runs reconciliation for any harness not yet confirmed rather than assuming the on-disk registration matches. An unreadable or incomplete transaction record selects the previous generation. Fault-injection tests interrupt at each of these points and assert that startup restores a complete catalog/registration pair.

Catalog updates do not restart the daemon or interrupt enforcement. If a schema needs behavior unavailable in the installed daemon/hook client, it is not activated and status reports `binary_update_required`. The user then explicitly reruns the supported npm setup command; the catalog never attempts that upgrade itself.

## Acceptance criteria

- Managed, system, and user services pass lifecycle tests on systemd and launchd.
- Managed and system scope prove peer isolation, per-UID context selection, and privileged-only administration.
- A managed-scope daemon holds no root capability at runtime, and no protected artifact is reachable by renaming a directory an enrolled user owns.
- An enrolled user cannot substitute the daemon endpoint, the pinned runtime, or an admitted policy artifact.
- The daemon's own UID cannot write its executables, pinned runtime, protected policy store, active schema catalog, or machine configuration.
- A policy needing filesystem, subprocess, or network access is admitted to the `user-context` tier; a forged verdict from that tier cannot relax a `sealed` result, and a policy that under-declares fails inside `sealed` rather than escaping it.
- A catalog whose version-detection rule falls outside the execution grammar is rejected rather than warned about, and a detection failure yields "version unknown" instead of an alternate command.
- Interrupting catalog activation at any step leaves the pointer on a complete signed generation, and startup recovery re-reconciles any harness whose registration is unconfirmed.
- A harness version change selects the correct exact/range schema and repairs its hook registration.
- Ambiguous, unsupported, tampered, replayed, executable, or capability-incompatible catalog data is rejected.
- Power loss during catalog persistence leaves either the previous or candidate complete signed generation active.
- A bad schema restores both the previous catalog and valid hook registration without restarting the daemon.
- Offline installs use the bundled baseline catalog.
- No background path downloads or activates a native executable.
