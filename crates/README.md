# crates/

## What this is

The daemon — product 3 of the five in this repo, and the only Rust. A Cargo workspace (`resolver =
"3"`, members `crates/*`) of three crates: `failproofaid` (the binary: Unix-socket server, singleton
flock, warm-worker supervision, plus the cloud-policy, telemetry, collector and scheduled-audit
lanes started in `failproofaid/src/main.rs`), `fpai-collect` (session capture), and `fpai-ipc` (the
wire protocol — length-prefixed JSON framing, a `protocolVersion` envelope, `SO_PEERCRED`/
`getpeereid` peer checks). It holds **zero policy logic**: `server.rs` answers `ping` itself and
relays every `hook` request to a warm Node/Bun worker running the TypeScript evaluator. The contract
that makes this load-bearing is **fail-closed** — on a machine where setup completed, failproofaid is
the *only* evaluator, and an unreachable socket or a `PROTOCOL_VERSION` mismatch **denies**. Read
`PROTOCOL.md` before touching the wire and `CLOUD_POLICIES.md` before touching policy sync.

`fpai-collect/src/sources/<cli>/` is the per-CLI vertical slice the TypeScript side has no equivalent
of: one module per agent's on-disk format (`mod.rs` + `transform.rs`). Twelve CLI sources — claude,
codex, copilot, cursor, openclaw, pi, factory, antigravity as file tailers; goose, opencode, hermes,
devin as SQLite pollers — plus `sources/hooks`, the CLI-agnostic hook stream.

## Who consumes it

The installed service unit (`failproofaid@<user>.service`, or a `/Library/LaunchDaemons` plist on
macOS) runs the binary; every hook invocation reaches it over the socket through
`src/hooks/daemon-client.ts` (`tryDaemonHook`: ~150 ms to connect, 30 s for the response). The daemon
in turn spawns `dist/worker.mjs` via `bin/failproofai-worker.mjs` on a second socket. Changes under
`crates/**` also trigger `.github/workflows/build-daemon.yml`, which cross-compiles the four release
binaries.

## Does it ship

Not as source — `crates/` is absent from package.json's `files`, so no Rust reaches an installed
user, and all three crates set `publish = false` (nothing goes to crates.io). The **compiled** binary
reaches users by two other channels: the `@failproofai/failproofaid-<os>-<arch>` optional dependency
packages, and the GitHub Release assets fetched by `src/hooks/daemon-download.ts`; both land at
`~/.failproofai/bin/failproofaid-<version>`. The version in the root `Cargo.toml`'s
`[workspace.package]` is checked against root `package.json` by CI's version-consistency job.

## Where its tests live

`crates/failproofaid/tests/` (`daemon_e2e.rs`, `audit_lane_e2e.rs`, `collector_reload_e2e.rs`,
`telemetry_e2e.rs`) and `crates/fpai-collect/tests/` (one per source, plus `supervisor.rs`,
`uploader.rs`, `delivery.rs`), alongside in-module `#[cfg(test)]` units. Run `cargo test --workspace`;
CI's `rust-quality` job adds `cargo fmt --check` and `cargo clippy`. Some tests spawn the real thing —
`daemon_e2e.rs` runs the compiled binary over a real socket, and `worker.rs`'s tests launch a real
`bun bin/failproofai-worker.mjs`, so **bun must be on PATH**.
