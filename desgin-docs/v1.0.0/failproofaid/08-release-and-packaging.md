# Release and package distribution

## Goals

- Build one coherent FailproofAI release containing every component that must remain protocol-compatible.
- Give customers familiar installation choices without creating different product behavior per package manager.
- Make every downloaded byte attributable to a signed release and reproducible source revision.
- Promote the exact tested artifacts from beta to stable without rebuilding them.
- Define who owns future updates for every installation path.
- Support interactive developer installs, managed fleets, air-gapped environments, and containers.

## Release contents

One semantic FailproofAI version identifies the compatible release set:

- `failproofai` — native user CLI and thin hook client;
- `failproofaid` — Rust daemon;
- `failproofai-updater` — external activation helper, unless implemented as a safe mode of the native CLI;
- legacy JS/TS policy worker and its runtime, if required by the selected policy-runtime design;
- service-manager templates or installation metadata;
- schema and compatibility metadata;
- license, notices, SBOM, provenance, and checksums.

These components are tested and published together. They do not acquire independent user-facing versions in v1. Internal protocol versions remain separate so rolling update compatibility is explicit.

## Target matrix

Initial native artifacts should cover:

| OS | Architecture | Archive |
|---|---|---|
| Linux, glibc | x86_64 | `.tar.gz` |
| Linux, glibc | aarch64 | `.tar.gz` |
| macOS | x86_64 | `.tar.gz` |
| macOS | aarch64 | `.tar.gz` |

Linux musl and additional packaging formats are added only with CI and support ownership. Windows is deferred in full to the next iteration. An unsupported platform fails before modifying the machine and links to the supported matrix.

Archive names are deterministic:

```text
failproofai-v1.0.0-linux-x86_64.tar.gz
failproofai-v1.0.0-linux-aarch64.tar.gz
failproofai-v1.0.0-darwin-x86_64.tar.gz
failproofai-v1.0.0-darwin-aarch64.tar.gz
```

Each archive has the same logical layout so installation behavior does not depend on the download source.

## Customer installation paths

### npm bootstrapper

Primary Linux/macOS migration command:

```sh
npx failproofai@latest setup
```

The npm package is a small bootstrapper, not the long-running daemon implementation. It:

1. detects OS and architecture;
2. obtains the signed release manifest for its selected channel/version;
3. downloads the matching native archive;
4. verifies manifest signature and archive digest;
5. extracts to a versioned user directory;
6. executes the native `failproofai setup` from that release.

The npm package must not run a privileged install script. `npx` makes the installation action explicit and works with package managers that block lifecycle scripts.

The bootstrapper version maps to the native version it installs by default. A compatibility table permits a newer bootstrapper to install or repair older pinned native releases.

### Shell installer

For machines without Node:

```sh
curl -fsSL https://install.befailproof.ai | sh
```

The short script only detects platform, downloads a versioned bootstrap binary or archive plus signed manifest, verifies it, and runs native setup. The hosted script is public, minimal, versioned in source, and contains no secrets.

For stronger change control, documentation also provides a two-step download-and-inspect flow rather than requiring `curl | sh`.

### Homebrew

```sh
brew install failproofai/tap/failproofai
failproofai setup
```

The formula points at the same immutable macOS/Linux archives and hashes from the release manifest. Homebrew owns executable upgrades; by default the daemon updater reports availability but does not overwrite Homebrew-managed files. Setup records package ownership so this is unambiguous.

### Direct archive

Every native archive, signed manifest, signature, checksum, SBOM, and provenance file is available from the release page and stable download endpoint. This supports internal packaging and audit without using npm or a shell pipeline.

After extraction:

```sh
./failproofai setup
```

Direct archives default to standalone update ownership.

### Container

Published OCI images use immutable version and digest tags:

```text
ghcr.io/failproofai/failproofaid:1.0.0
ghcr.io/failproofai/failproofaid:1.0
ghcr.io/failproofai/failproofaid:stable
ghcr.io/failproofai/failproofaid@sha256:...
```

Production documentation recommends an immutable version or digest. Containers do not self-update; the orchestrator pulls and replaces the image. Image signatures, SBOM, and provenance are published alongside native artifacts.

### Managed and air-gapped fleets

Enterprises may mirror archives, manifests, signatures, and container images into an internal registry. The installer accepts an explicit trusted mirror and additional organization trust root without silently falling back to the public internet.

An offline bundle contains a complete release set for selected targets, signatures, trust metadata, and installation instructions. Enrollment and cloud policy synchronization remain separate concerns from binary installation.

## Installation layout and ownership

Standalone user installs use versioned, immutable directories:

```text
~/.local/share/failproofai/
  versions/
    1.0.0/
      bin/failproofai
      bin/failproofaid
      bin/failproofai-updater
      policy-runtime/
      release.json
  current -> versions/1.0.0
```

The platform-appropriate macOS equivalent uses the same logical layout. A small PATH entry or stable shim points to `current/bin/failproofai`. Service registration points through an activation-safe stable path or is updated atomically with the version switch.

Installation metadata records:

- installed release and source revision;
- package source (`npm-bootstrap`, `shell`, `homebrew`, `direct`, `container`, or managed);
- update owner (`standalone-updater`, package manager, orchestrator, or administrator);
- selected channel and version pin;
- manifest identity and trust root.

No updater guesses ownership from paths alone.

## Signed release manifest

The release manifest is canonical JSON or another deterministic encoding and includes:

- product version, release ID, source commit, build timestamp, and channel eligibility;
- every artifact name, target, size, SHA-256 digest, and media type;
- component and IPC/state/policy-runtime compatibility ranges;
- minimum installer/updater versions;
- SBOM and provenance artifact references;
- release notes and required manual migration warnings;
- publisher key ID and signature metadata.

The manifest is signed separately from hosting. Clients ship a trust root and support signed key rotation. Serving a modified artifact and modified checksum from the same compromised host is insufficient because the attacker cannot create a valid manifest signature.

## Release pipeline

### 1. Prepare

- A release PR sets the version and dated changelog section.
- CI verifies workspace version consistency, protocol compatibility declarations, clean generated artifacts, and release notes.
- The source commit is tagged only after required review and CI pass.

### 2. Build

- Build each target in pinned, isolated workers.
- Compile Rust with locked dependencies.
- Build/package the policy worker from the same source revision if required.
- Strip nondeterministic metadata where possible.
- Run unit, integration, harness-contract, collector-conformance, and update tests.
- Execute each native artifact's side-effect-free `--version` and protocol probe on its target OS.

Artifacts are uploaded to an immutable pipeline staging area. A target build cannot publish directly to a customer channel.

### 3. Analyze

- Generate per-artifact and aggregate SBOMs.
- Scan source, dependencies, archives, and container layers.
- Generate SLSA-style provenance linking artifact digest to source commit and build workflow identity.
- Verify license/notice completeness.
- Reject unexpected files, secrets, debug credentials, dynamic-library dependencies, or size regressions beyond policy.

### 4. Assemble and sign

- Assemble the release manifest from staged artifact digests.
- Sign provenance and artifacts where platform conventions require it.
- Sign the canonical release manifest using the protected release identity.
- Verify the complete release from a clean consumer environment using only public/mirrored artifacts and trust roots.

Signing occurs after build and analysis. Build jobs receive no long-lived signing credential.

### 5. Publish beta

- Create an immutable prerelease and upload all artifacts.
- Publish the matching npm prerelease tag and package-manager candidate metadata.
- Publish container images by immutable version/digest.
- Move the signed `beta` channel pointer to the release manifest.
- Exercise install, service start, policy evaluation, collection, update-from-previous, and rollback on clean target machines.

### 6. Promote stable

Stable promotion does not rebuild. It:

- verifies the beta release digest and promotion requirements;
- marks the existing release stable;
- updates signed stable channel metadata;
- promotes npm/package-manager/container aliases to the same artifact digests;
- records approver, source beta, and promotion time.

If any ecosystem cannot promote without rebuilding, it must package the already-built signed payload and prove its embedded digest rather than recompiling product binaries.

### 7. Observe and revoke

The release system monitors download/install success, service readiness, automatic rollback, crash, protocol mismatch, and update suppression rates without collecting sensitive payload data.

A bad release is removed from moving channel pointers but immutable evidence remains. A signed revocation can prevent new activation and direct installed updaters to a known-good release. Revocation authority is separated from ordinary publishing where practical.

## Repository and workspace structure

The Rust daemon and native CLI should live in one Cargo workspace so shared protocol, identity, manifest, and state types do not drift:

```text
crates/
  failproofai-cli/
  failproofaid/
  failproofai-protocol/
  failproofai-policy/
  failproofai-collector/
  failproofai-update/
```

The existing AgentEye collector code is imported with history or otherwise preserved in a reviewable migration. Collector public installer assets are retired or redirected only after the unified package reaches parity and existing installations have a supported migration path.

The npm bootstrapper remains in the JavaScript workspace but contains no independent policy or collector implementation.

## Channels and versioning

- `stable` is the default for normal setup and automatic updates.
- `beta` is explicit and may contain prerelease versions.
- exact version pins bypass moving channel pointers but still require valid signatures.
- internal/managed channels use separate signed metadata and explicit trust configuration.

Channel pointers only move forward under normal automation. Downgrade requires an exact version or signed rollback/revocation instruction. Release version, manifest revision, channel revision, IPC version, and state schema version are distinct fields.

## Package-manager rules

- One installation has exactly one update owner.
- The native updater never overwrites package-manager-owned executables by default.
- Package recipes reference immutable URLs and hashes.
- npm lifecycle scripts do not install or start the daemon.
- Package publication happens only after native release verification.
- Unpublishing an ecosystem package does not invalidate already-signed native artifacts.
- Package metadata exposes the same license, source repository, version, and release notes.

## Release acceptance criteria

- Every supported target installs and reaches daemon readiness from a clean machine.
- npm, shell, Homebrew, direct, and container paths resolve to the same native Linux/macOS product release.
- A customer can verify manifest signature, digest, SBOM, provenance, and source revision offline.
- Beta-to-stable promotion changes pointers/metadata without rebuilding binaries.
- Package-manager installations are never silently overwritten by the standalone updater.
- Previous-version upgrade and forced-failure rollback pass on every target.
- A tampered archive, manifest, package payload, or container is rejected.
- Air-gapped installation works from a complete mirrored bundle without public-network fallback.
- Windows artifacts, package metadata, and support claims are absent from v1.0.0 release channels rather than published as experimental placeholders.
