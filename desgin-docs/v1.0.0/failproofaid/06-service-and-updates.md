# Service and harness schema updates

## Service model

Setup selects one explicit service scope:

| Scope | Linux | macOS | Starts | Privilege to manage |
|---|---|---|---|---|
| `system` (recommended) | systemd system service | LaunchDaemon | machine boot | `sudo`/root |
| `user` | systemd user service | LaunchAgent | user login | none |

User scope owns only that user's configuration, credentials, policies, transcripts, activity, and socket. System scope supports system agents and multiple explicitly enrolled users. Its service files, machine credentials, shared state, executable, and schema-catalog state are root-owned.

User scope is convenient and complete, but an agent with the same OS permissions can stop it or modify user-owned configuration; it is cooperative enforcement. System scope is the tamper-resistant option. Only root-authorized administrative requests may stop, reconfigure, replace, or remove the daemon, register protected policy, or mutate its active protected generation. Non-root clients can submit hook events and read their authorized status, but cannot call administrative operations.

Protected policies are copied or compiled into an immutable root-owned content-addressed store during an elevated install operation. The daemon evaluates a committed revision, not a mutable user source path. Changing, disabling, or deleting that revision requires an explicit privileged CLI operation and produces an audit record. Editable user/project policies remain available but are labeled `mutable` rather than tamper-resistant.

System scope is a privileged supervisor, not a blanket root execution context. Unix-socket peer credentials select a per-UID policy/session context. User-authored policy workers run with that user's UID/GID, reduced groups and environment, resource limits, and platform sandboxing. Per-user queues, storage quotas, and authorization prevent cross-user reads or resource starvation. Only administrator-owned machine policy may be assigned machine-wide.

One user is bound to one endpoint. Setup detects user/system conflicts and transactionally switches hook registrations; both services may exist only when their enrolled user sets do not overlap. A system installation does not rewrite all users' harness files implicitly.

Harness attachment is reported as `protected`, `detectable`, or `cooperative`. Setup uses the strongest available registration and never reports tamper resistance unless both the daemon/policy plane and harness invocation boundary are protected. Missing or altered registrations are automatically repaired while enabled. Missing expected heartbeats or repeated repair raises a local and, when connected, Failproof Cloud alert.

Windows is outside the v1.0.0 service scope. Its service model, named-pipe transport, and packaging belong to the next iteration.

Service configuration contains executable and state paths but no secrets. User-scope operations never request elevation. System-scope mutations require `sudo`; no sudo password is stored.

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

Catalog updates do not restart the daemon or interrupt enforcement. If a schema needs behavior unavailable in the installed daemon/hook client, it is not activated and status reports `binary_update_required`. The user then explicitly reruns the supported npm setup command; the catalog never attempts that upgrade itself.

## Acceptance criteria

- System and user services pass lifecycle tests on systemd and launchd.
- System scope proves peer isolation, privilege dropping, and root-only administration.
- A harness version change selects the correct exact/range schema and repairs its hook registration.
- Ambiguous, unsupported, tampered, replayed, executable, or capability-incompatible catalog data is rejected.
- Power loss during catalog persistence leaves either the previous or candidate complete signed generation active.
- A bad schema restores both the previous catalog and valid hook registration without restarting the daemon.
- Offline installs use the bundled baseline catalog.
- No background path downloads or activates a native executable.
