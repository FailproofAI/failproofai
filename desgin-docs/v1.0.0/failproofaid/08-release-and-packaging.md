# npm release and distribution

## Scope

v1.0.0 has one supported installation and distribution path:

```sh
npx failproofai@latest setup
```

The goal is to make the existing npm experience work end to end for Linux and macOS. Homebrew, shell installers, direct-download installation, containers, mirrored registries, and air-gapped bundles are explicitly deferred. The release pipeline may use internal native archives, but they are implementation artifacts consumed by the npm bootstrapper rather than separate customer installation products.

## Customer experience

The user needs Node/npm only for bootstrap. Running the command:

1. resolves the current `failproofai` package from npm;
2. starts the existing branded CLI;
3. detects Linux/macOS and architecture before modifying the machine;
4. downloads the matching signed native v1 release;
5. verifies the signed release manifest and artifact digest;
6. installs the native `failproofai` CLI and `failproofaid` service into a versioned location for the chosen service scope;
7. continues directly into the Login/OSS setup wizard;
8. verifies service readiness and reports completion.

There is no separate installer command or system package repository to discover. User scope requires no `sudo`; choosing system scope explicitly requires it when setup applies the reviewed machine-wide changes.

The bootstrapper rejects unsupported operating systems or architectures before downloading a native artifact or editing configuration. Windows receives a clear next-iteration message.

## npm package responsibilities

The public `failproofai` npm package is a small bootstrap and compatibility package, not the long-running daemon. It contains:

- the current JavaScript CLI needed to launch setup and support migration;
- platform detection and release-manifest verification;
- native download, versioned installation, and handoff logic;
- repair/uninstall discovery for native installations;
- the existing public JS/TS policy API needed by user-authored policies during compatibility migration;
- no daemon implementation and no bundled native artifact for every platform.

The npm package must have no install lifecycle script. npm 12, bun, pnpm, and modern Yarn may block lifecycle scripts, so downloading or starting the daemon from `postinstall` would silently produce incomplete installations. All state-changing work happens only after the user explicitly runs `setup`.

`npx` may use a temporary package cache. The native installation therefore must not point its service definition at the transient npx directory. Setup copies the verified native release to its stable versioned location before registering the service.

## Bootstrap trust

Initial bootstrap relies on npm's package-integrity and publisher-provenance trust model. The package is published through npm trusted publishing with provenance tied to the release workflow and source commit. Release automation verifies the packed tarball before publication and records its npm integrity digest in the release evidence.

After bootstrap starts, the npm package does not extend that trust transitively to native code. It verifies the independently signed FailproofAI release manifest and native artifact digest before execution or installation.

This design does not claim that native signature verification protects against a compromised bootstrap package; these are two trust layers:

1. npm registry integrity and package provenance authenticate the bootstrapper;
2. the FailproofAI signed manifest authenticates the native release.

The exact `@latest` command is the supported convenience interface. npm resolves it to an immutable package version and integrity digest for that execution. Setup records the resolved bootstrap version, integrity when exposed by npm, native manifest identity, and source revision for diagnostics.

## Native release contents

One FailproofAI version identifies a compatible release set:

- native `failproofai` CLI and hook client;
- Rust `failproofaid` daemon;
- external updater helper, unless implemented as a safe CLI mode;
- legacy policy worker/runtime if required;
- service-manager metadata;
- schemas, license, notices, SBOM, provenance, and checksums.

All components are tested and published together. Internal protocol/schema versions remain separate so rolling compatibility is explicit.

## Target matrix

| OS | Architecture | Internal native artifact |
|---|---|---|
| Linux, glibc | x86_64 | `.tar.gz` |
| Linux, glibc | aarch64 | `.tar.gz` |
| macOS | x86_64 | `.tar.gz` |
| macOS | aarch64 | `.tar.gz` |

These artifacts have deterministic names and layouts. They are fetched only by the npm bootstrapper/updater in v1.0.0.

## Installation layout and ownership

```text
~/.local/share/failproofai/
  install.json
  versions/
    1.0.0/
      bin/failproofai
      bin/failproofaid
      bin/failproofai-updater
      policy-runtime/
      release.json
  current -> versions/1.0.0
```

macOS uses the platform-appropriate user data root with the same logical layout.

For `--service-scope system`, the same versioned layout lives in a root-owned platform system data root. Configuration, state, logs, runtime sockets, and service definitions use platform system locations. The bootstrap downloads and verifies without elevation where possible, then requests `sudo` only for the bounded install and registration phase. It never copies unverified bytes into a privileged location.

Ownership is intentionally split:

- npm owns only the bootstrap package used for that invocation;
- FailproofAI's standalone updater owns the installed native release;
- the service always points at the stable native installation, never npm's global tree or npx cache.

Updating or removing a global npm package does not silently remove a running native service. `failproofai uninstall` removes the service/native installation explicitly; npm cache/global cleanup remains npm's responsibility.

## Release manifest

The signed canonical manifest includes:

- product version, release ID, source commit, and build timestamp;
- every target artifact's name, size, SHA-256 digest, and media type;
- component and IPC/state/policy-runtime compatibility ranges;
- minimum bootstrapper/updater versions;
- SBOM and provenance references;
- release notes and required migration warnings;
- publisher key ID and signature metadata.

Clients ship the release trust root and support signed rotation. A modified artifact plus modified checksum is rejected because the attacker cannot produce the manifest signature.

## Release pipeline

### Build and test

- A release PR sets the version and dated changelog section.
- Build each Linux/macOS target from one source commit in pinned isolated workers.
- Build the policy worker from the same revision when required.
- Run unit, integration, harness-contract, collector-conformance, setup, update, and rollback tests.
- Smoke-test each executable's side-effect-free version/protocol command on its target OS.
- Generate SBOMs and provenance and scan source, dependencies, archives, and package contents.

### Assemble and sign

- Stage native artifacts immutably.
- Assemble and sign the native release manifest with protected release identity.
- Build `npm pack --ignore-scripts` from the same version/source revision.
- Inspect the tarball allowlist, unpack and execute its CLI in a clean npm environment, and prove it downloads/verifies the staged native release.
- Attach npm trusted-publishing provenance to publication.

Build jobs do not receive long-lived signing or npm credentials. Signing and publishing are separate protected jobs over already-built digests.

### Publish beta

- Publish immutable native prerelease artifacts and signed manifest.
- Publish the npm package under the `beta` dist-tag.
- From clean Linux and macOS machines, run `npx failproofai@beta setup` and verify install, service start, policy evaluation, collector behavior, update, rollback, and uninstall.

### Promote stable

Stable promotion does not rebuild native binaries. It verifies the tested beta manifest digest, promotes the exact native release, and moves npm's `latest` dist-tag to the already-published package version.

If npm requires a distinct stable version rather than moving a prerelease package, its package must embed/reference the exact promoted native manifest digest and contain no rebuilt product binary.

### Observe and revoke

Release health tracks bootstrap download/verification, setup completion, daemon readiness, update rollback, crash, and protocol mismatch without collecting policy or transcript content.

A bad release is removed from `latest` and the native stable channel. Immutable evidence remains. A signed revocation prevents new activation and directs installed updaters to a known-good release.

## npm acceptance criteria

- `npx failproofai@latest setup` works in both user and explicitly elevated system scope on clean supported Linux and macOS machines.
- No npm lifecycle script is required or declared.
- The npx cache can disappear immediately after setup without affecting the service.
- The bootstrapper never executes an unverified native artifact.
- The npm package provenance and packed-file allowlist map to the release source commit.
- beta-to-stable promotion does not rebuild native binaries.
- setup, update from the previous version, forced rollback, repair, and uninstall pass on every target.
- Windows and unsupported architectures fail before machine mutation.
