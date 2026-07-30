# Verification

Seven layers. The full-stack Docker gate is the primary acceptance evidence; everything above it exists to make failures cheap to localize when that gate goes red.

---

## L0 — Rust unit tests

`cargo test --workspace`, with `proptest` wherever the invariant is algebraic rather than exemplary:

- **Framing** (`fpai-ipc`) — length-prefix round-trip, truncation, oversize rejection, version-mismatch handshake.
- **Canonicalization** (`fpai-canon`) — every per-CLI event map is total over `HOOK_EVENT_TYPES`.
- **The combination lattice** (`fpai-policy`) — `deny` over `instruct` over `allow` is associative, commutative, and idempotent; the combined result equals the maximum under that ordering; and **adding any number of `user-context` results never lowers a `sealed` deny**. That last property is the formal statement of the product's decision semantics — adding a policy can only tighten — and it deserves a property test rather than three examples. Attestation combines the same way, as a maximum under `sealed < sealed_unattested < user_context`, so a decision is never reported as depending on less than it did.
- **The watchdog** (`fpai-policy`) — a policy body that loops or backtracks past its deadline is interrupted, reported as a deadline miss, and distinguishable from a policy that threw. `block-curl-pipe-sh` against 80 KB of repeated `curl ` prefix is the fixture, because it is real, default-enabled, and took 30 seconds against a 200 ms deadline before the watchdog existed.

## L1 — TypeScript unit tests

All 144 existing files stay green through Stage 5. The legacy evaluator is the reference implementation, so weakening its tests weakens the oracle. New additions: `check-versions.test.ts`; manifest verification (valid, one flipped byte, wrong key, rotated key inside and outside its validity window, replayed older release ID, `min_bootstrapper` too high, artifact digest mismatch); and platform detection (Windows yields the deferred message, musl is refused, unknown arch is refused, all four supported combinations produce the exact artifact name).

## L2 — the parity harness

This is the centerpiece, because `policy-evaluator.ts` encodes roughly a dozen mutually incompatible native response contracts: Cursor's flat `{permission, user_message, agent_message}` with `followup_message` on Stop only and a `{continue:false}` special case on `UserPromptSubmit`; Copilot, where exit 2 is never a deny channel and `agentStop` needs `{decision:"block"}`; Factory, which ignores JSON on tool events and requires exit 2 *except* on Stop; Antigravity's `{decision:"continue"}` on Stop; Goose, which honors deny on `PreToolUse` only. **Byte-exactness is the only assertion that catches a reimplementation that is "semantically equivalent" and silently allows.**

Mechanics: per fixture, run the TypeScript reference through the **existing** `__tests__/e2e/helpers/hook-runner.ts` — do not fork it, a forked helper is a second implementation of the oracle — then run the Rust client against a daemon on a temp root with identical policy configuration, and assert byte-exact `exitCode` and `stdout` plus normalized `stderr`. Normalization is an **allowlist** of JSON pointers (request and decision IDs, timings), so a *new* field is a failure rather than a pass.

Also assert that the `enforcement-capability.ts` labels match the Rust adapter descriptor per CLI per event. This is what prevents reporting a deny as enforced when the harness actually ignores that event.

## L3 — service lifecycle

`.github/workflows/service-lifecycle.yml`. Linux legs under `podman run --systemd=always` across `debian:12`, `ubuntu:24.04`, `fedora:41`, and `rockylinux:9` — podman's systemd support avoids `--privileged` and the cgroup-mount dance, and the leg then drives `systemctl --user` inside a real user session. macOS legs on `macos-15` and `macos-15-intel`, where `launchctl bootexec gui/$UID` genuinely works.

Because the install is unprivileged, this layer asserts a different class of thing than it used to. There is no ownership split to prove and no boundary to probe; what can go wrong now is the install writing somewhere it should not, the socket landing somewhere the daemon cannot bind, or the service failing to come back.

Positive assertions: the service is active and its process owner is the invoking user; the unit file is at `~/.config/systemd/user/failproofaid.service` (or `~/Library/LaunchAgents/`) and nowhere else; the socket directory is recreated by `RuntimeDirectory=` across stop and start; the daemon binds under `~/.failproofai/run/` in an environment with `XDG_RUNTIME_DIR` unset; setup run twice yields one unit file and zero duplicate hook entries; and the service returns after a simulated logout/login, with and without `loginctl enable-linger`, the linger-off case asserting the *documented* behavior rather than a surprise.

Negative assertions — each maps to a sentence in the design docs:

```
image has no sudo installed; setup --non-interactive        → exits 0
find / -newer <stamp>, excluding $HOME and /tmp             → empty
  (specifically: no /opt/failproofai, /var/lib/failproofai,
   /etc/failproofai, /Library/*/failproofai)
grep -R 'sudo' over the shipped release tree                → no invocation
a second unprivileged user connects to the first's socket   → refused
setup --service-scope managed | system                      → deferred-scope error, machine unchanged
uninstall, then find under $HOME                            → delivery key gone, policies kept
a running daemon killed with -9 mid-hook                    → the hook still denies, via in-process fallback
```

The `find` assertion is the one that replaces the whole old ownership golden table, and it is stronger than what it replaces: the previous version asserted that specific paths had specific owners, and this one asserts that no path outside the user's tree was created at all.

Fault injection: `FAILPROOFAI_FAULT=step:<name>` forces a failure at each journal step. Take a `find`-based owner and mode manifest before setup and after rollback, and assert they are identical — bit-for-bit restoration, not "looks fine".

## L4 — spool and catalog fault injection

`crates/fpai-spool/tests/` behind a `fault-injection` feature, with an `Fs` trait so **every fsync, rename, and unlink call site is individually addressable by name**. For each fault point: kill there, restart, and assert no acknowledged record was lost, no duplicate backend event was created, replay reuses the same stable ID, and the recovered state is exactly the previous set or the candidate set, never a mixture.

Plus one test that is not a mock: run the daemon under `strace -f -e trace=fsync,fdatasync,rename,unlink` and **assert the syscall ordering** matches the documented sequence. This is cheap and it catches the single most common real bug in this class — the forgotten directory fsync, which no unit test with a mocked filesystem will ever notice. Apply the identical treatment to catalog activation.

---

## L5 — the full-stack acceptance gate

`integration-suite/full-stack/docker-compose.yml`, runnable identically on a laptop and in CI.

| Service | Contents |
|---|---|
| `agenteye-stub` | Contract-faithful `events:add` ingest: bearer authentication, `Idempotency-Key` deduplication, batch acknowledgements, injectable 4xx/5xx/timeout, and a `/_test/received` endpoint the assertions read. |
| `machine` | `debian:12` with systemd available so a user session and `systemctl --user` exist, node and npm only — no bun, no Rust, no repository checkout, no prior FailproofAI state, **and no `sudo` installed at all**. A single unprivileged `canary` user runs both the install and the agents. |

**The existing `integration-suite/` image can be reused here, and that is now a feature.** Its safety property is that `sudo whoami` deny-probes are inert *by construction* because the image has no sudo installed — which used to collide with a scope requiring root, and now agrees with it perfectly. The same image proves the deny-probes are inert and that the installer never needed elevation.

`probe-cli.sh` needs no change at all. Its assertion is "the hook log shows a DENY", and the hook log is written by whichever evaluator answered — which is precisely the comparison worth making.

### What `run-acceptance.sh` asserts, in order

1. **Install.** `setup --non-interactive --json` exits 0 as `canary` on an image with no `sudo`; the service is active; the process owner is `canary`; a before/after `find` diff shows nothing written outside `~/.failproofai/`, `~/.agenteye/`, `~/.config/systemd/user/`, and the harness settings files.
2. **Enforcement across twelve CLIs.** Reuse `probe-cli.sh`; every deny probe denies.
3. **Sealed tier.** `block-sudo` denies and `policies explain` reports `tier: sealed`; a full corpus run writes no `.__failproofai_tmp__.mjs` anywhere under the policy directories, asserted by watching them for the duration.
4. **`user-context` tier.** A custom policy importing `node:fs` is admitted to `user-context`, runs, and tightens a result.
5. **Deadline.** A policy crafted to run past its deadline is interrupted, reported as a deadline miss rather than an evaluation failure, and the next event on the same lane is served normally.
6. **Fallback.** `kill -9` the daemon and re-run the deny probes: every one still denies, through in-process evaluation, and health reports the daemon down. This is the assertion that the daemon is an optimization and not a single point of enforcement failure.
7. **Capture, spool, delivery.** Drive the CLIs, assert the stub received the sessions, assert the state was read and written under `~/.agenteye/` in its existing layout, and assert that enforcement decisions and captured sessions **join on stable identifiers** rather than by heuristic matching after the fact.
8. **Offline durability.** Stop the stub; watch the spool grow; `kill -9` the daemon mid-flight; restart; start the stub; assert zero loss, zero duplicates, and correct `strace`-observed fsync ordering.
9. **Dashboard.** `failproofai dashboard start` binds loopback on an ephemeral port, rejects a missing token and a mismatched `Origin`, leaves no pidfile after TTL expiry, and appears in no service manager.
10. **Schema catalog.** Serve a deliberately bad generation; assert rollback to the previous catalog *and* the previous registration, without restarting the daemon.
11. **Uninstall.** The unit is gone, the delivery key is erased — asserted offline too — and user policy files survive. `--purge` enumerates before deleting.
12. **npx cache.** `rm -rf ~/.npm/_npx`, re-run the synthetic hook, still denies.
13. **Two users.** A second unprivileged user installs their own daemon: each socket refuses the other's peer, each `Query` returns only its owner's data, and neither dashboard collides on a port.

### Two legs that must be asserted, never skipped

**No-service-manager leg.** The same image with the default PID 1 and no systemd. `setup --non-interactive --json` must exit **0**, start the daemon directly, and report `supervision: unsupervised` in `health --json`; the deny probes must still deny, and must still deny after the daemon is killed. This is the design's most easily-skipped requirement and therefore the one that most needs a positive test — the previous plan asserted a refusal here, and asserting the opposite outcome is exactly how a stale expectation gets caught.

**Tamper leg.** With `FAILPROOFAI_RELEASE_BASE_URL` pointed at a stub: one flipped byte in the tarball, and a valid tarball whose manifest is signed by a different key. Both must refuse **before anything is written into `~/.failproofai/versions/`**, and `current` must still point at the previous release, which is what proves the bootstrapper never executes or activates an unverified native artifact.

### CI wiring

`.github/workflows/full-stack.yml` runs the install leg plus both negative legs on **every PR** — hermetic, no credentials, no forks blocked. The credentialed twelve-CLI leg joins the existing nightly `integration-suite.yml` matrix as a new `evaluator: [legacy, daemon]` dimension, advisory until Stage 4 and gating after, mirroring the graduated pattern the `beta` channel already uses.

`report.js` gains a state so that "denies under legacy, allows under daemon" is reported as a **parity regression**, distinct from a vendor break. That distinction is the strongest available evidence for authorizing the Stage 5 default flip.

## L6 — latency

`.github/workflows/bench.yml`, nightly, `hyperfine`, 500 iterations per CLI, comparing the legacy cold start against the warm daemon and reporting p50/p95/p99 to the job summary. Soft gate: Rust p99 at or below legacy p50. This converts open decision #1 from a guess into a measurement before anyone has to commit to a number.
