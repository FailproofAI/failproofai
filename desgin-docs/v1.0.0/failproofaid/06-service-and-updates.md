# Service and automatic updates

## Service model

The default is one service per OS user because agent configuration, transcript stores, policy files, and credentials belong to that user.

- Linux: systemd user service.
- macOS: launchd LaunchAgent.

Windows is explicitly outside the v1.0.0 service and updater scope. Its service model, named-pipe transport, executable activation, packaging, and rollback design belong to the next iteration.

Service configuration contains executable and state paths but no secrets. Installation, status, restart, and uninstall use native service-manager APIs or carefully bounded commands.

## Update ownership

The running daemon may discover, download, verify, and stage a release. It must not replace its own executable and invoke the restart that kills it mid-operation.

Activation belongs to a separately invoked updater controlled by the service manager. Its lifetime and result do not depend on the old daemon remaining alive.

## Release layout

A release is a signed manifest plus versioned platform artifacts. The manifest covers the daemon, native CLI/hook client, any policy worker, schemas, and compatibility metadata.

An update must be authentic, complete, compatible, atomic, recoverable, externally activated, and observable. A SHA-256 list served beside an artifact detects corruption but is insufficient publisher authentication; the manifest itself is signed by a trusted release key.

Native installations use versioned directories and an atomic `current` pointer or service-path switch. The previous complete release remains available for rollback.

### Crash-consistent activation

Activation is an on-disk transaction owned by the external updater:

1. fully extract into a new version directory that is not reachable through `current`;
2. verify every file, write a signed-manifest identity and `complete` marker, then `fsync` files and the version directory;
3. write and `fsync` an activation journal containing transaction ID, previous release, candidate release, and phase;
4. stop the daemon only after the candidate and journal are durable;
5. create a temporary pointer to the complete candidate, `fsync` it where applicable, atomically rename it over `current`, and `fsync` the parent directory;
6. update and `fsync` the journal phase, start the daemon, and perform readiness/health probes;
7. on success mark the transaction committed durably; on failure perform the same pointer-switch sequence back to the previous complete release.

Neither `current` nor the journal may reference a release lacking its verified `complete` marker. The updater/service startup recovery path runs before daemon launch: it validates `current`, journal, candidate, and previous release; completes an unambiguous durable switch or restores the last complete release; then starts the daemon. Corrupt or incomplete candidates are quarantined rather than selected.

## Update flow

1. Check the selected stable/beta channel on a jittered interval.
2. Download into a versioned staging directory with size and time bounds.
3. Verify manifest signature, artifact hashes, OS/architecture, compatibility, updater version, and disk space.
4. Smoke-test staged executables using side-effect-free version/protocol commands.
5. Ask the external updater to activate in an idle window.
6. Stop the daemon and atomically switch the complete release.
7. Start it and probe IPC readiness and deeper subsystem health.
8. On failure restore the prior release, restart it, record evidence, and suppress the bad version.

Activation is serialized by a lock. It may defer while enforcement requests are active, up to a maximum deferral. Hook clients use their documented daemon-unavailable behavior during the short restart window.

## State compatibility

Every release declares readable/writable state schema ranges and IPC protocol ranges. State migration is copy-on-write or backward-readable by the retained release.

An irreversible migration cannot be activated unattended because rollback would restore an executable unable to read its state.

Old/new hook clients and daemons must interoperate during rolling activation. An incompatible staged release is rejected before the active pointer changes.

## Platform policy

- Standalone Linux/macOS installations can auto-activate signed releases.
- npm owns the bootstrap package only; the standalone updater owns the stable native installation created by setup.

## Update acceptance criteria

- Tampered manifest or artifact is rejected without changing the active release.
- Wrong architecture and incompatible protocol/state versions are rejected before activation.
- Power loss during staging or pointer switch leaves one complete bootable release.
- Fault-injection tests cut power after every file write, marker/journal fsync, daemon stop, pointer creation/rename, directory fsync, start, probe, commit, and rollback step; startup always selects a verified complete release.
- Failed readiness or health automatically restores the prior healthy release.
- A suppressed failed version is not retried until manual action or a newer release.
- The installed service reports active, staged, available, previous, and rolled-back versions.
- The full acceptance suite passes independently for systemd user services and launchd LaunchAgents.
