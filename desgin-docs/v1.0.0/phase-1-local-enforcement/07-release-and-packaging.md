# npm release and distribution

## Scope

Phase 1 has one supported installation and distribution path:

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
6. installs the native `failproofai` CLI and `failproofaid` daemon into a versioned directory under `~/.failproofai/`;
7. continues directly into the setup wizard;
8. verifies service readiness and reports completion.

There is no separate installer command and no system package repository to discover, and there is no elevation step at any point. The whole sequence writes inside the user's own tree, so it works identically for a user with root and a user who has never had it. A missing service manager degrades the daemon to `unsupervised` rather than refusing the install.

The bootstrapper rejects unsupported operating systems or architectures before downloading a native artifact or editing configuration. Windows receives a clear next-iteration message.

## npm package responsibilities

The public `failproofai` npm package is a small bootstrap and compatibility package, not the long-running daemon. It contains:

- the current JavaScript CLI needed to launch setup and support migration, unchanged in its ability to enforce without the daemon;
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

Evaluation must not depend on whichever interpreter `PATH` happens to expose. A runtime resolved at spawn commonly lands in nvm's, fnm's, or volta's directory and changes when the user switches Node versions, which makes two machines with identical configuration produce different decisions for reasons nobody can see. The release therefore ships its own runtime, referenced by an absolute path recorded at install time.

The `sealed` tier does not need that file at all: its engine is QuickJS-ng linked into the `failproofaid` binary, evaluating a bundle embedded at compile time, so the evaluator is part of the signed artifact rather than something read back from a state directory that a crash could leave half-written. The runtime shipped on disk is what the `user-context` tier runs, where real imports are the point. Everything below therefore describes that one, and it is the subject of [open decision #3](./06-delivery-plan.md#open-decisions).

What shipping it buys is determinism, reproducibility, and an answer to "which runtime decided this" — not protection. It installs into the user's own tree like everything else, and the user who owns it can replace it. That is a property of the scope this version ships, and [deferred scopes](./04-service-and-updates.md#deferred-scopes) is where the layout that would change it is recorded.

Because admission compiles a policy and its import graph into one artifact, a runtime that is also a bundler removes a separate toolchain from the release. Shipping a runtime means owning its patch cadence: its version, digest, and upstream advisories are part of the release manifest and the SBOM, and a runtime-only security fix is a normal explicit upgrade through the same npm setup path.

## Target matrix

| OS | Architecture | Internal native artifact |
|---|---|---|
| Linux, glibc | x86_64 | `.tar.gz` |
| Linux, glibc | aarch64 | `.tar.gz` |
| macOS | x86_64 | `.tar.gz` |
| macOS | aarch64 | `.tar.gz` |

These artifacts have deterministic names and layouts. They are fetched only by the npm bootstrapper.

## Code signing and notarization

Two of the four rows above are unshippable without this, so it is a release requirement on the critical path rather than a finishing touch. Running as a LaunchAgent rather than a LaunchDaemon does not relax it. `codesign --verify` fails on any MDM-managed fleet whose configuration profile requires a Developer ID identity, Gatekeeper assesses a downloaded binary on first launch regardless of how it is registered, and an unstapled ticket makes that assessment a network call on a machine this design promises can be offline. The MDM failure is the quietest and worst of the three, because it appears on a customer's machine rather than in the release pipeline. (The sharper failure — macOS 15 terminating an unsigned `failproofaid` outright — belongs to the LaunchDaemon a [deferred scope](./04-service-and-updates.md#deferred-scopes) would register, which is where this requirement was first found.)

Every Mach-O in a macOS artifact is signed with the release Developer ID identity — not only the two executables FailproofAI writes. The `failproofai` CLI, the `failproofaid` daemon, **and the vendored policy runtime**, including any dynamic library it ships, are each signed with `--options runtime` and `--timestamp`, inner binaries before the enclosing archive. The hardened runtime is what notarization requires. The secure timestamp is what keeps an already-shipped signature valid after the signing certificate expires, which matters here more than it does for most products: Phase 1 never replaces a binary automatically, so an installation is expected to keep starting its daemon for years after the release that produced it.

The hardened runtime is also where the pinned runtime's execution model becomes a packaging decision rather than an implementation detail. A runtime that JITs — anything V8-based — needs `com.apple.security.cs.allow-jit` in its entitlements file, because the hardened runtime otherwise refuses the writable-executable mapping the JIT depends on; the identical constraint on Linux is why the systemd unit cannot set `MemoryDenyWriteExecute=yes`, which every hardening guide recommends and which kills such a runtime at its first compile. A bytecode interpreter needs neither. The `sealed` engine already shipped is one — QuickJS-ng, linked into the daemon binary rather than spawned — so the question is entirely about the runtime pinned for the `user-context` tier, and it is why [open decision #3](./06-delivery-plan.md#open-decisions) gates the entitlements file. Entitlements are an input to signing, signing is an input to notarization, and notarization gates the macOS half of the target matrix.

Notarization is a separate step from signing, and the release is not shippable until it completes: `notarytool submit --wait` on the signed archive, then `stapler staple` on the artifact. Stapling is not optional here. Without a stapled ticket Gatekeeper resolves the notarization online at first launch, and a machine that installs FailproofAI and then goes offline — the exact operating profile the rest of this design promises — gets an assessment failure instead of a running daemon. Stapling also rewrites the artifact, so its digest must be computed *after* the ticket is attached; a manifest recording the pre-staple digest fails verification on every customer machine while passing every check in the pipeline that produced it.

The installer then strips the quarantine attribute from the extracted tree with `xattr -dr com.apple.quarantine`, defensively. The bootstrapper fetches over its own HTTP client, which does not set the attribute, so this is not the normal path; it exists because an archive that reaches the machine any other way — a proxy that re-archives, a user who downloads the tarball and hands it to setup — carries it, and the resulting failure is a LaunchAgent that never starts with nothing in the diagnostic pointing at an extended attribute.

Custody of the signing identity follows the same rule as the release signing key: build jobs never hold it, and signing and notarization run as separate protected jobs over already-built artifacts. It is also a long-lead non-code item — an Apple Developer Program enrollment, a Developer ID certificate, and an App Store Connect API key for `notarytool` — so it is started alongside engineering rather than discovered at the release gate.

## Installation layout

```text
~/.failproofai/
  versions/
    1.0.0/
      bin/failproofai
      bin/failproofaid
      policy-runtime/
      harness-schemas/
      release.json
  current -> versions/1.0.0
  install.json
  artifacts/
  state/
  logs/
  run/
```

The same layout on both platforms. Capture state — checkpoints, the spool, the delivery key, and the observability destination — stays in `~/.agenteye/`, where the collector already writes it; see [collector integration](./05-collector-integration.md#state-stays-where-it-already-is).

`install.json` records what a particular `setup` run did on this machine, including the UID a client checks the socket's owner against before speaking to it. It sits beside `versions/` rather than inside one, because the two have different writers: a version directory is written once per release, while `install.json` is written once per installation, and putting a per-installation record inside a per-release directory means an upgrade either loses it or has to copy it forward.

`current` is a symlink so activating a new release is one atomic rename. A partially downloaded or unverified release never becomes `current`, and rolling back to the previous version is repointing the symlink at a directory that was never removed.

Nothing is written under `/opt`, `/var/lib`, `/etc`, or `/Library`, and the release gate asserts that with a filesystem diff rather than trusting the installer's own report. The bootstrap downloads and verifies before it writes anything into `versions/`, so an unverified artifact never gets a directory of its own to be found in later.

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
- Sign every Mach-O in each macOS artifact with the Developer ID identity, hardened runtime, and secure timestamp, inner binaries before the enclosing archive; then `notarytool submit --wait` and `stapler staple`.
- Assemble and sign the native release manifest with protected release identity, over the digests of the **stapled** macOS artifacts.
- Build `npm pack --ignore-scripts` from the same version/source revision.
- Inspect the tarball allowlist, unpack and execute its CLI in a clean npm environment, and prove it downloads/verifies the staged native release.
- Attach npm trusted-publishing provenance to publication.

Build jobs do not receive long-lived signing or npm credentials. Signing and publishing are separate protected jobs over already-built digests.

### Publish beta

- Publish immutable native prerelease artifacts and signed manifest.
- Publish the npm package under the `beta` dist-tag.
- From clean Linux and macOS machines, run `npx failproofai@beta setup` and verify install, service start, policy evaluation, collector behavior, schema refresh/rollback, explicit binary upgrade, and uninstall.
- Run the same sequence end to end inside a clean container that mimics a real user install — native download and signature verification, `setup`, service readiness, an enforced synthetic hook, and `uninstall` — so the gate exercises a machine with no developer toolchain, no prior FailproofAI state, and no repository checkout. The container runs as an ordinary unprivileged user with no `sudo` installed, which is the strongest available proof that nothing in the install path needs it.
- Run one leg with a systemd user session so the unit file, `RuntimeDirectory=`, and restart behavior are exercised, and one leg with no service manager at all, asserting that setup still completes, the daemon runs, health reports `unsupervised`, and killing the daemon degrades to in-process evaluation rather than losing the deny.

### Promote stable

Stable promotion does not rebuild native binaries. It verifies the tested beta manifest digest, promotes the exact native release, and moves npm's `latest` dist-tag to the already-published package version.

If npm requires a distinct stable version rather than moving a prerelease package, its package must embed/reference the exact promoted native manifest digest and contain no rebuilt product binary.

### Observe and revoke

Release health tracks bootstrap download/verification, setup completion, daemon readiness, schema rollback, crash, and protocol mismatch without collecting policy or transcript content.

A bad release is removed from `latest` and the native download channel. Immutable evidence remains. Existing installations are not changed automatically; affected users receive an explicit upgrade advisory.

## npm acceptance criteria

- `npx failproofai@latest setup` works on clean supported Linux and macOS machines as an unprivileged user, on an image with no `sudo` installed.
- The install writes only under `~/.failproofai/`, `~/.agenteye/`, the user's service-manager directory, and the harness settings files it was asked to change, asserted by a before/after filesystem diff that includes the absence of anything under `/opt`, `/var/lib`, `/etc`, and `/Library`.
- Activating a release is an atomic `current` symlink move, and an interrupted install leaves the previous `current` intact.
- The pinned runtime's version and digest appear in the release manifest and SBOM, and the daemon never executes an interpreter outside the installed release.
- Every Mach-O in a macOS artifact, the vendored policy runtime included, is Developer ID signed with the hardened runtime and a secure timestamp; `codesign --verify --deep --strict` and a Gatekeeper assessment both pass on a clean machine.
- Each macOS artifact is notarized and stapled, its manifest digest is computed after stapling, and its LaunchAgent starts on a machine that has had no network access since installation.
- The entitlements file matches what the pinned runtime actually requires, and the Linux unit's `MemoryDenyWriteExecute` setting agrees with it.
- The release gate includes a clean-container run covering download, verification, `setup`, service readiness, an enforced synthetic hook, and `uninstall`.
- No npm lifecycle script is required or declared.
- The npx cache can disappear immediately after setup without affecting the service.
- The bootstrapper never executes an unverified native artifact.
- The npm package provenance and packed-file allowlist map to the release source commit.
- beta-to-stable promotion does not rebuild native binaries.
- setup, explicit upgrade from the previous version, schema rollback, repair, and uninstall pass on every target.
- Windows and unsupported architectures fail before machine mutation.
