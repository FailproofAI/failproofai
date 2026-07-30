# Verification

Seven layers. The full-stack Docker gate is the primary acceptance evidence; everything above it exists to make failures cheap to localize when that gate goes red.

---

## L0 — Rust unit tests

`cargo test --workspace`, with `proptest` wherever the invariant is algebraic rather than exemplary:

- **Framing** (`fpai-ipc`) — length-prefix round-trip, truncation, oversize rejection, version-mismatch handshake.
- **Canonicalization** (`fpai-canon`) — every per-CLI event map is total over `HOOK_EVENT_TYPES`.
- **The combination lattice** (`fpai-policy`) — `deny` over `instruct` over `allow` is associative, commutative, and idempotent; the combined result equals the maximum under that ordering; and **adding any number of `user-context` results never lowers a `sealed` deny**. That last property is the formal statement of the entire two-tier security argument and deserves a property test rather than three examples.

## L1 — TypeScript unit tests

All 144 existing files stay green through Stage 5. The legacy evaluator is the reference implementation, so weakening its tests weakens the oracle. New additions: `check-versions.test.ts`; manifest verification (valid, one flipped byte, wrong key, rotated key inside and outside its validity window, replayed older release ID, `min_bootstrapper` too high, artifact digest mismatch); and platform detection (Windows yields the deferred message, musl is refused, unknown arch is refused, all four supported combinations produce the exact artifact name).

## L2 — the parity harness

This is the centerpiece, because `policy-evaluator.ts` encodes roughly a dozen mutually incompatible native response contracts: Cursor's flat `{permission, user_message, agent_message}` with `followup_message` on Stop only and a `{continue:false}` special case on `UserPromptSubmit`; Copilot, where exit 2 is never a deny channel and `agentStop` needs `{decision:"block"}`; Factory, which ignores JSON on tool events and requires exit 2 *except* on Stop; Antigravity's `{decision:"continue"}` on Stop; Goose, which honors deny on `PreToolUse` only. **Byte-exactness is the only assertion that catches a reimplementation that is "semantically equivalent" and silently allows.**

Mechanics: per fixture, run the TypeScript reference through the **existing** `__tests__/e2e/helpers/hook-runner.ts` — do not fork it, a forked helper is a second implementation of the oracle — then run the Rust client against a daemon on a temp root with identical policy configuration, and assert byte-exact `exitCode` and `stdout` plus normalized `stderr`. Normalization is an **allowlist** of JSON pointers (request and decision IDs, timings), so a *new* field is a failure rather than a pass.

Also assert that the `enforcement-capability.ts` labels match the Rust adapter descriptor per CLI per event. This is what prevents reporting a deny as enforced when the harness actually ignores that event.

## L3 — service lifecycle

`.github/workflows/service-lifecycle.yml`. Linux legs under `podman run --systemd=always` across `debian:12`, `ubuntu:24.04`, `fedora:41`, and `rockylinux:9` — podman's systemd support avoids `--privileged` and the cgroup-mount dance. macOS legs on `macos-15` and `macos-15-intel`, where the runner user has passwordless sudo and `launchctl bootstrap system` genuinely works.

Positive assertions: the service is active; the process owner is `_failproofai`; `stat` across every layout path matches a committed golden table; `RuntimeDirectory` is recreated across stop and start; setup run twice yields the same UID, one unit file, and zero duplicate hook entries.

Negative assertions — these *are* the acceptance criteria, and each maps to a sentence in the design docs:

```
sudo -u _failproofai test -w /opt/failproofai/current/bin/failproofaid   → fails
sudo -u _failproofai touch /var/lib/failproofai/policy-store/x           → fails
as $USER: mv /run/failproofai /run/x                                     → EACCES
as $USER: rm /run/failproofai/failproofaid.sock                          → EACCES
as $USER: bind an impostor socket at that path                           → fails
as $USER: failproofai policies disable <protected>                       → refused + audit record
daemon opening $HOME/.codex/sessions                                     → fails (ProtectHome=yes)
setup --service-scope system | user                                      → deferred-scope error, machine unchanged
```

Fault injection: `FAILPROOFAI_FAULT=step:<name>` forces a failure at each of the twelve journal steps. Take a `find`-based owner and mode manifest before setup and after rollback, and assert they are identical — bit-for-bit restoration, not "looks fine".

## L4 — spool and catalog fault injection

`crates/fpai-spool/tests/` behind a `fault-injection` feature, with an `Fs` trait so **every fsync, rename, and unlink call site is individually addressable by name**. For each fault point: kill there, restart, and assert no acknowledged record was lost, no duplicate backend event was created, replay reuses the same stable ID, and the recovered state is exactly the previous set or the candidate set, never a mixture.

Plus one test that is not a mock: run the daemon under `strace -f -e trace=fsync,fdatasync,rename,unlink` and **assert the syscall ordering** matches the documented sequence. This is cheap and it catches the single most common real bug in this class — the forgotten directory fsync, which no unit test with a mocked filesystem will ever notice. Apply the identical treatment to catalog activation.

---

## L5 — the full-stack acceptance gate

`integration-suite/full-stack/docker-compose.yml`, runnable identically on a laptop and in CI.

| Service | Contents |
|---|---|
| `agenteye-stub` | Contract-faithful `events:add` ingest: bearer authentication, `Idempotency-Key` deduplication, batch acknowledgements, injectable 4xx/5xx/timeout, and a `/_test/received` endpoint the assertions read. |
| `machine` | `debian:12` with **systemd as PID 1**, node and npm only — no bun, no Rust, no repository checkout, no prior FailproofAI state. Installs through the real `npx failproofai@<channel> setup`. An unprivileged `canary` user who is **not** in sudoers runs the agents. |

**The existing `integration-suite/` image must not be reused for this.** Its safety property is that `sudo whoami` deny-probes are inert *by construction* because the image has no sudo installed — which collides directly with a scope that requires root. Add `Dockerfile.daemon` alongside it, run `setup` once as root in the entrypoint, and keep every probe running as `canary`. The inertness property survives intact: the *installer* is privileged, the *agent under test* is not.

`probe-cli.sh` needs no change at all. Its assertion is "the hook log shows a DENY", and the hook log is written by whichever evaluator answered — which is precisely the comparison worth making.

### What `run-acceptance.sh` asserts, in order

1. **Install.** `setup --non-interactive --json` exits 0; the service is active; the process owner is `_failproofai`; `stat` across every layout path matches the golden table.
2. **Enforcement across twelve CLIs.** Reuse `probe-cli.sh`; every deny probe denies.
3. **Sealed tier.** `block-sudo` denies and `policies explain` reports `tier: sealed`; the service account cannot write the policy store.
4. **`user-context` tier.** A custom policy importing `node:fs` is admitted to `user-context`, runs in the agent, and tightens a result.
5. **No-agent path.** Stop the agent: sealed enforcement is unaffected, the mutable policy still runs via the one-shot, and the agent is restarted detached.
6. **Protected versus mutable.** `canary` cannot disable a `machine.json`-enforced policy and the refusal produces an audit record; a mutable policy toggles freely.
7. **Capture, spool, delivery.** Drive the CLIs, assert the stub received the sessions, and assert that enforcement decisions and captured sessions **join on stable identifiers** rather than by heuristic matching after the fact.
8. **Offline durability.** Stop the stub; watch the spool grow; `kill -9` the daemon mid-flight; restart; start the stub; assert zero loss, zero duplicates, and correct `strace`-observed fsync ordering.
9. **Dashboard.** `failproofai dashboard start` binds loopback on an ephemeral port, rejects a missing token and a mismatched `Origin`, shows only the caller's own data, and leaves no pidfile after TTL expiry.
10. **Schema catalog.** Serve a deliberately bad generation; assert rollback to the previous catalog *and* the previous registration, without restarting the daemon.
11. **Uninstall.** The unit is gone, the delivery key is erased — asserted offline too — and user policy files survive. `--purge` enumerates before deleting.
12. **npx cache.** `rm -rf ~/.npm/_npx`, re-run the synthetic hook, still denies.

### Two legs that must be asserted, never skipped

**No-init leg.** The same image with the default PID 1 and no systemd. `setup --non-interactive --json` must exit nonzero with `failure_code == "no_service_manager"`, name systemd in its message, and leave the machine unchanged — `getent passwd _failproofai` empty and a clean `find / -newer <stamp>` diff. This is the design's most easily-skipped requirement and therefore the one that most needs a positive test.

**Tamper leg.** With `FAILPROOFAI_RELEASE_BASE_URL` pointed at a stub: one flipped byte in the tarball, and a valid tarball whose manifest is signed by a different key. Both must refuse **before anything is written under `/opt`**, which is what proves the bootstrapper never executes an unverified native artifact.

### CI wiring

`.github/workflows/full-stack.yml` runs the install leg plus both negative legs on **every PR** — hermetic, no credentials, no forks blocked. The credentialed twelve-CLI leg joins the existing nightly `integration-suite.yml` matrix as a new `evaluator: [legacy, daemon]` dimension, advisory until Stage 4 and gating after, mirroring the graduated pattern the `beta` channel already uses.

`report.js` gains a state so that "denies under legacy, allows under daemon" is reported as a **parity regression**, distinct from a vendor break. That distinction is the strongest available evidence for authorizing the Stage 5 default flip.

## L6 — latency

`.github/workflows/bench.yml`, nightly, `hyperfine`, 500 iterations per CLI, comparing the legacy cold start against the warm daemon and reporting p50/p95/p99 to the job summary. Soft gate: Rust p99 at or below legacy p50. This converts open decision #1 from a guess into a measurement before anyone has to commit to a number.
