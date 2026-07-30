# npm release and distribution

## Scope

v1.0.0 has one supported installation and distribution path:

```sh
npx failproofai@latest setup
```

The goal is to make the existing npm experience work end to end for Linux and macOS. Homebrew, shell installers, direct-download installation, containers, mirrored registries, and air-gapped bundles are explicitly deferred. Installation therefore requires network access to npm and the native release channel; the offline guarantee elsewhere in this design covers operation after installation, not installation itself. The release pipeline may use internal native archives, but they are implementation artifacts consumed by the npm bootstrapper rather than separate customer installation products.

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

There is no separate installer command or system package repository to discover. User scope requires no `sudo`; choosing managed or system scope explicitly requires it when setup applies the reviewed machine-wide changes, including creating the `_failproofai` service account.

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
- bundled baseline harness schema catalog and its trust root;
- the pinned policy runtime;
- service-manager metadata;
- schemas, license, notices, SBOM, provenance, and checksums.

All components are tested and published together. Internal protocol/schema versions remain separate so rolling compatibility is explicit.

### Pinned policy runtime

The `sealed` execution tier must not run an interpreter an enrolled user can write to, and a runtime resolved through `PATH` commonly lands in a version manager's directory under that user's home. The release therefore ships its own runtime, referenced by an absolute path recorded at install time rather than resolved at spawn.

Its protection is a property of the install layout, not of the artifact. In managed and system scope it installs root-owned and read-only to the service account, which is what lets the `sealed` tier claim verdict integrity. In user scope it installs inside the user's own `~/.local/share/failproofai/versions/<version>/` tree like every other component, so it gives determinism and reproducibility but no protection against the user who owns it — user scope therefore has no `sealed` tier, and the protected-runtime guarantee is scoped accordingly wherever it is stated.

Because promotion into the protected store compiles a policy and its import graph into one artifact, a runtime that is also a bundler removes a separate toolchain from the release. Shipping a runtime means owning its patch cadence: its version, digest, and upstream advisories are part of the release manifest and the SBOM, and a runtime-only security fix is a normal explicit upgrade through the same npm setup path.

## Target matrix

| OS | Architecture | Internal native artifact |
|---|---|---|
| Linux, glibc | x86_64 | `.tar.gz` |
| Linux, glibc | aarch64 | `.tar.gz` |
| macOS | x86_64 | `.tar.gz` |
| macOS | aarch64 | `.tar.gz` |

These artifacts have deterministic names and layouts. They are fetched only by the npm bootstrapper in v1.0.0.

## Installation layout and ownership

```text
~/.local/share/failproofai/
  install.json
  versions/
    1.0.0/
      bin/failproofai
      bin/failproofaid
      policy-runtime/
      harness-schemas/
      release.json
  current -> versions/1.0.0
```

macOS uses the platform-appropriate user data root with the same logical layout.

For `--service-scope managed` and `--service-scope system`, the same versioned layout installs root-owned under a platform system location (`/opt/failproofai/` on Linux). Machine configuration and the content-addressed policy store are root-owned under `/var/lib/failproofai/` (system scope additionally uses `/etc/failproofai`), while mutable runtime state, logs, and the socket directory (`/run/failproofai/`) belong to the service account. The bootstrap downloads and verifies without elevation where possible, then requests `sudo` only for the bounded phase that creates the service account, installs the release, and registers the service. It never copies unverified bytes into a privileged location.

Ownership within a privileged install is deliberately split by writer: everything a decision's integrity depends on — executables, the pinned runtime, the policy store, the schema catalog, machine configuration — is root-owned and read-only to the service account, written only by the privileged installer. The service account owns only what the daemon must write while running. The daemon can therefore read its policy store and write its state without being able to modify the binary it will be restarted from, the runtime it evaluates in, or the revision it evaluates. No path to any of it passes through a directory an enrolled user owns, because rename and delete permission come from the parent.

Ownership is intentionally split:

- npm owns only the bootstrap package used for that invocation;
- explicit npm setup/upgrade operations own the installed native release;
- the service always points at the stable native installation, never npm's global tree or npx cache.

Updating or removing a global npm package does not silently remove a running native service. `failproofai uninstall` removes the service/native installation explicitly; npm cache/global cleanup remains npm's responsibility.

## Release manifest

The signed canonical manifest includes:

- product version, release ID, source commit, and build timestamp;
- every target artifact's name, size, SHA-256 digest, and media type;
- component and IPC/state/policy-runtime compatibility ranges;
- minimum bootstrapper and schema-catalog format versions;
- SBOM and provenance references;
- release notes and required migration warnings;
- publisher key ID and signature metadata.

Clients ship the release trust root and support signed rotation. A modified artifact plus modified checksum is rejected because the attacker cannot produce the manifest signature.

## Release pipeline

### Build and test

- A release PR sets the version and dated changelog section.
- Build each Linux/macOS target from one source commit in pinned isolated workers.
- Build the policy worker from the same revision when required.
- Run unit, integration, harness-contract, collector-conformance, setup/upgrade, schema-catalog rollback, and uninstall tests.
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
- From clean Linux and macOS machines, run `npx failproofai@beta setup` and verify install, service start, policy evaluation, collector behavior, schema refresh/rollback, explicit binary upgrade, and uninstall.
- Run the same sequence end to end inside a clean container that mimics a real user install — native download and signature verification, `setup` in each service scope, service readiness, an enforced synthetic hook, and `uninstall` — so the gate exercises a machine with no developer toolchain, no prior FailproofAI state, and no repository checkout.

### Promote stable

Stable promotion does not rebuild native binaries. It verifies the tested beta manifest digest, promotes the exact native release, and moves npm's `latest` dist-tag to the already-published package version.

If npm requires a distinct stable version rather than moving a prerelease package, its package must embed/reference the exact promoted native manifest digest and contain no rebuilt product binary.

### Observe and revoke

Release health tracks bootstrap download/verification, setup completion, daemon readiness, schema rollback, crash, and protocol mismatch without collecting policy or transcript content.

A bad release is removed from `latest` and the native download channel. Immutable evidence remains. Existing installations are not changed automatically; affected users receive an explicit upgrade advisory.

## npm acceptance criteria

- `npx failproofai@latest setup` works in user scope and in explicitly elevated managed and system scope on clean supported Linux and macOS machines.
- A privileged install creates the service account idempotently, leaves the protected surface root-owned and read-only to that account, and places nothing enforcement depends on inside a user's home.
- The pinned runtime's version and digest appear in the release manifest and SBOM, and the daemon never executes an interpreter outside the installed release.
- The release gate includes a clean-container run covering download, verification, `setup`, service readiness, an enforced synthetic hook, and `uninstall`.
- No npm lifecycle script is required or declared.
- The npx cache can disappear immediately after setup without affecting the service.
- The bootstrapper never executes an unverified native artifact.
- The npm package provenance and packed-file allowlist map to the release source commit.
- beta-to-stable promotion does not rebuild native binaries.
- setup, explicit upgrade from the previous version, schema rollback, repair, and uninstall pass on every target.
- Windows and unsupported architectures fail before machine mutation.
