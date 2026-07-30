# Stages

Six stages. Two invariants make every one of them independently revertable:

1. **The daemon path is dead code unless an environment variable is set.** No configuration default and no wizard default until Stage 5. A revert is one `git revert`; a *field* rollback is one environment variable.
2. **The legacy evaluator is not a copy — it is the untouched remainder of `handleHookEvent`.** There is no second artifact to keep in sync, which is what makes the "packaged compatibility evaluator" in [02-harness-integration.md](../02-harness-integration.md) cost nothing: it is the npm package as it ships today.

A third invariant governs the harness settings files: **exactly one implementation writes them at any time.** The TypeScript `integrations.ts` writes through Stage 3; the Rust reconciler becomes a writer only at Stage 4, and only after both sides honor a shared per-adapter lockfile.

---

## Stage 0 — contracts, refactors, CI hygiene

Pure TypeScript. No Rust, no behavior change, ships to `main` immediately. Every item is independently revertable and gated by the existing suite.

### Prerequisite refactors

Each is its own PR, behavior-preserving, gated by the tests that already exist.

**P1 — split the builtins by capability.** `src/hooks/builtin-policies.ts` becomes `src/hooks/builtin/payload-only.ts` (32 policies) and `src/hooks/builtin/host-access.ts` (7 — `warn-repeated-tool-calls`, `block-work-on-main`, and the five `require-*-before-stop`), with `builtin-policies.ts` re-exporting `BUILTIN_POLICIES` in the same order.

This is not cosmetic and it is not optional. Tier derivation reads the *resolved import graph*, and today all 39 policies live in one module that imports `child_process` — so the derivation would route every builtin to `user-context` and the sealed tier would be empty. The architecture would look implemented while every hook event still paid a worker spawn and every default-enabled policy still ran outside the interruptible engine, which is to say it would deliver none of what the tier is for.

Gate: a snapshot test on `BUILTIN_POLICIES.map(p => [p.name, p.category, p.defaultEnabled, p.beta])`, identical before and after.

**P2 — thread host context through `PolicyContext`.** Add `home` and `projectDir` to `SessionMetadata` and `PolicyContext`. Change `isAgentInternalPath`, `expandHomePrefix`, `extractAbsolutePaths`, and `blockReadOutsideCwd` to read them, falling back to `homedir()` and `process.env.CLAUDE_PROJECT_DIR` when absent. The fallback keeps all 632 lines of `block-read-outside-cwd.test.ts` green; the daemon path never reaches it.

**P3 — split `evaluatePolicies`.** Into `evaluateVerdicts()` (the loop and accumulation) and `encodeResponse(verdicts, eventType, session)` (everything else), with `evaluatePolicies = encodeResponse(evaluateVerdicts(...))`. The public signature is unchanged, so all 1,222 lines of `policy-evaluator.test.ts` keep passing. Required because the daemon must combine sealed and `user-context` results *before* encoding.

**P4 — move session-metadata resolution to the caller.** `resolveTranscriptPath`, `resolvePermissionMode`, and `resolveCwd` become envelope fields rather than daemon-side work. This closes a trap the design docs never named: `resolveCodexMode` line-scans an entire Codex transcript under `~/.codex/sessions` looking for `turn_context` — an unbounded read on the enforcement deadline path, which the daemon must not perform no matter whose files they are.

### Corpora and code generation

**`scripts/gen-parity-corpus.mjs`** → `__tests__/parity/fixtures/<harness>/<event>/<case>.json`. Every `INTEGRATION_TYPES` × `HOOK_EVENT_TYPES` × `{deny, instruct, allow-with-reason, allow-silent}` × `{tool present, absent}` × `{one policy, two policies}`, driven by synthetic policies so it is deterministic and independent of builtin logic. The technique already exists in `__tests__/hooks/inert-deny-shapes.test.ts` — register a policy that returns a fixed decision, call `evaluatePolicies`, inspect the bytes.

Derive every count from the constants, never hardcode. Adding a thirteenth CLI or a new event must fail loudly rather than silently under-test.

**`__tests__/parity/coverage.json`** marks each cell `reachable`, `not-registered`, or `observe-only`. A cell flipping from `reachable` to `not-registered` fails the build. This turns "we didn't test that combination" from an unknown into an asserted fact — the same tripwire philosophy as `dogfood-configs.test.ts`.

**`scripts/gen-canon-tables.ts`** → `crates/generated/canonicalization-tables.json` and `enforcement-capability.json`. Emit **JSON, not `.rs`**: `src/hooks/types.ts` stays the single source of truth, its "verified live against `<cli> vX.Y.Z`" annotations stay where reviewers already look, and there is no generated Rust to review. A CI drift gate re-runs the generator and fails on any diff.

**`scripts/bench-hook.ts`** → a checked-in baseline of today's cold-start p50/p95/p99 per `(cli, event)`, split into `spawn / config+load / evaluate / encode`. The split matters: see the latency risk in [03-risks-and-amendments.md](./03-risks-and-amendments.md).

### CI and packaging fixes

All four of these are live bugs found while surveying, not new work invented by this plan.

- **Remove `"prepare": "bun run build"` from `package.json`, and add an explicit `bun run build` step to `.github/workflows/publish.yml` in the same PR.** The publish workflow has no build step and relies entirely on `prepare` to populate the gitignored `dist/` and `.next/standalone/`, both of which are in the `files` allowlist. Removing `prepare` alone publishes an empty package. Then switch to `npm publish --provenance --ignore-scripts`, so a re-added lifecycle script can never silently re-enter the publish path. This is the highest-risk edit in Stage 0.
- **`scripts/prune-standalone.mjs` prunes `"design-docs"`; the directory on disk is `desgin-docs`.** The whole design-doc tree may be shipping to npm today. Add both spellings, plus `crates` and `target`.
- **Every cache key in `ci.yml` and `publish.yml` is `hashFiles('bun.lockb')`.** The repo tracks `bun.lock`, so `hashFiles` returns the empty string and the key has been constant since the initial import — the bun cache has never invalidated on a lockfile change. Fix it before adding Rust caching, or the new job will look like it introduced a flake that was already there.
- **Replace the inline version-consistency shell with `scripts/check-versions.mjs`** plus `__tests__/scripts/check-versions.test.ts`, preserving current semantics and adding: `Cargo.toml`'s workspace version equals root `package.json`; every crate uses `version.workspace = true`; and no lifecycle scripts are declared at all.

Also: `scripts/check-pack-allowlist.mjs` comparing `npm pack --dry-run --json` against a committed `.github/expected-pack-files.txt`, so a new top-level directory can neither silently ship nor silently fail to ship. An empty Cargo workspace and a `rust-quality` CI job, so the plumbing exists before there is anything to break. And a correction to `CLAUDE.md`, which claims four CI jobs (there are five) and four `test` env-configs (there are three).

### The spike

Roughly 200 throwaway lines: load the 32 payload-only builtins into a QuickJS-ng context with no bindings registered, run 10,000 corpus rows, measure warm p99, and prove that `require("node:fs")` from inside a policy **throws** rather than succeeding. Decide from the measurement, not from the document.

If regex interruption turns out unreliable, the mitigation is admission-time linear-time regex analysis plus the killable worker — not a switch to V8.

**Exit:** corpus frozen and green; canon tables generated and drift-gated; the `BUILTIN_POLICIES` snapshot identical to pre-P1; all five CI jobs green; a publish dry-run byte-identical to today's tarball minus the docs typo.

---

## Stage 1 — walking skeleton

Claude Code only, off unless an environment variable is set.

**The insertion point matters more than anything else in this stage.** Do not ship a native hook client yet, and do not touch any of the twelve hook registrations. Add the daemon branch *inside* `src/hooks/handler.ts`, immediately after `parsed` is assigned and before the per-CLI payload normalizations:

- New `src/hooks/daemon-client.ts`, roughly 120 lines. `tryDaemonEvaluate(...)` returns an `EvaluationResult` or `null`. It connects to `$FAILPROOFAI_DAEMON_SOCKET`, verifies the socket's owner equals the `service_uid` recorded in `~/.failproofai/install.json`, sends one framed request carrying a monotonic deadline, and returns `null` on *any* failure. The owner check catches a stale or misdirected socket — a `FAILPROOFAI_DAEMON_SOCKET` left pointing at another user's endpoint answers with another user's policy set, and that is a wrong answer whether or not anyone meant it.
- Roughly 15 guarded lines in `handler.ts`. Everything from `readMergedHooksConfig` through `evaluatePolicies` **is** the legacy fallback — untouched.

Choosing `handler.ts` over `bin/failproofai.mjs` keeps stdin reading, the 1 MB cap, the parse-error telemetry, and the `finally { await flushHookTelemetry() }` shared, so the diff is minimal and the fallback is simply "keep executing the same function."

Crates: `fpai-ipc` (framing, envelope, peer credentials), `fpai-canon` (generated tables plus the failure-mode subset), `failproofaid` (listener, one enforcement lane, one warm sealed worker, `Ping` and `EvaluateHook`). Plus `src/policy-runtime/sealed-entry.ts` — the worker entry point that calls `registerBuiltinPolicies` and the `evaluateVerdicts`/`encodeResponse` pair from P3. It lives under `src/` so `tsc --noEmit` and eslint already cover it.

### The envelope closes the trap classes

`home` is **daemon-derived via `getpwuid_r(peer_uid)`**, and any client-supplied home is a protocol error. This is not pedantry: `isAgentInternalPath` and `block-read-outside-cwd` both *widen* the allow set, so a wrong home does not fail — it quietly permits more. The daemon can compute the field correctly from the connection itself, so accepting it from the client adds a way to be wrong and no way to be right, and rejecting rather than overwriting is what makes a client that sends one get fixed.

`cwd`, `project_dir`, and `env_facts` genuinely cannot be derived — `/proc/<pid>/cwd` is TOCTOU-prone and unavailable on macOS to a non-matching UID — so they ride as `ClientAsserted` with explicit provenance. Any decision whose deciding policy read one is recorded `sealed_unattested` and reported by `policies explain`. In this release that is provenance rather than an integrity claim: it is what tells an author their payload-only policy is quietly depending on an asserted `cwd`, and it is the field that becomes an integrity claim unchanged if a [deferred scope](../04-service-and-updates.md#deferred-scopes) is ever added.

**Exit:** one Claude `PreToolUse` deny byte-identical to legacy; Rust passes the Claude slice of the corpus; the **worker soak test** passes — the whole corpus twice through one warm worker, then once in randomized order, with identical output both times. That last one is the important gate: every hook today is a fresh process, so the `globalThis` policy registry, the index cache, the cwd-keyed git-branch cache, and every hoisted `/g` regex start clean. A resident worker changes that, and the failure mode is a *wrong verdict*, not a crash. Finally, `FAILPROOFAI_DAEMON_MODE=off` and an unset socket must both produce output identical to `main` across the entire e2e suite.

---

## Stage 2 — full matrix parity across twelve CLIs

The sealed worker handles every event for all twelve CLIs; Rust canonicalization passes the whole corpus; the Rust failure-mode encoder subset is implemented and corpus-tested.

**Shadow mode** lands here: `src/hooks/shadow-diff.ts`, reusing the page-and-lock pattern from `hook-activity-store.ts`. `FAILPROOFAI_DAEMON_MODE=shadow` runs legacy, then the daemon, **returns legacy**, and records the diff. `=enforce` returns the daemon's answer and records legacy as the shadow. `=off` is honored at the top of `tryDaemonEvaluate`, so an incident is resolved with an environment variable rather than a release.

One hazard to design around: running both paths would execute `warn-repeated-tool-calls` twice, doubling its sidecar counter, and fire the five `require-*-before-stop` policies' `git` and `gh` subprocesses twice. So the shadow request carries `shadow: true`, the daemon evaluates **sealed-only**, and the differ compares only when every legacy-matched policy was sealed-eligible. Under default configuration that is 100% of `PreToolUse` and `PostToolUse` — near-total coverage at zero side-effect risk.

Where to run it, for free: `integration-suite/` already installs twelve *real* vendor CLIs in Docker daily and asserts DENY. Enable shadow mode in its entrypoint and add "zero mismatches" as a reported state. This repo's own dogfood configs are a second source — every agent working in this repo generates traffic.

**Exit:** 100% corpus pass, byte-exact; at least seven consecutive green integration-suite runs with zero shadow mismatches.

---

## Stage 3 — the user service install

Behind `--experimental-daemon`. Still the TypeScript hook client, so **zero hook registrations change**. This deliberately decouples "the daemon installs, starts, and survives a reboot" from "a new binary is invoked correctly by twelve harnesses" — two failure domains that are miserable to debug together.

`crates/fpai-service` owns: the `~/.failproofai/` layout with its `versions/<v>` directories and `current` symlink; the socket directory, `$XDG_RUNTIME_DIR/failproofai/` when that variable is set and `~/.failproofai/run/` when it is not; the systemd user unit and the LaunchAgent; and a **journal-backed transactional setup** in which each step records its inverse before performing it. A crash mid-apply leaves a journal that the next `setup` or `doctor` offers to roll back or resume — the same recovery idiom as the catalog activation transaction, so the product has one, not two. There is no account to create, no ownership split to apply, and no elevation to acquire, so the journal is short; it exists for the harness settings files and the service registration, which are the steps that can leave a machine half-configured.

Three unit settings do real work rather than decoration. `RuntimeDirectory=failproofai` recreates the socket directory with the correct owner on every start, since `$XDG_RUNTIME_DIR` is tmpfs. `Type=notify` makes `systemctl --user start` block until the socket is bound *and* the last-known-good generation is loaded, so setup's readiness check is a second independent verification rather than the only one. And `ProtectHome=` is **explicitly left unset**, which is worth stating because every systemd hardening guide recommends `yes` and it would break the product outright: capture reads `~/.codex/sessions` and the other five source roots, and `user-context` policies read the user's repository.

The `XDG_RUNTIME_DIR` fallback is a required path, not a defensive one. `pam_systemd` sets the variable for a login session and a plain `ssh` invocation on several distributions does not, which is exactly the shape of a remotely driven agent run.

**Exit** — each of these is a test, not a review item: setup completes on an image with no `sudo` installed; a before/after `find` diff shows nothing written outside `~/.failproofai/`, `~/.agenteye/`, the service-manager directory, and the harness settings files, and specifically nothing under `/opt`, `/var/lib`, `/etc`, or `/Library`; the daemon binds and serves with `XDG_RUNTIME_DIR` unset; a peer that is not the socket's owner is refused; setup run twice yields one unit file and zero duplicate hook entries; a machine with no service manager completes setup and reports `unsupervised`; and a forced failure at each journal step restores the prior state bit-for-bit, verified by a `find`-based owner and mode manifest taken before and after.

---

## Stage 4 — native client and catalog

The native hook client (`crates/failproofai-cli`) ships; `integrations.ts` learns a second command form alongside `npx -y failproofai --hook …`; the per-adapter lockfile lands *before* the Rust reconciler exists, so the single-writer invariant is never violated even briefly.

**The `user-context` worker.** The daemon spawns it directly, because the daemon is already the user — the same fact that deleted the per-user agent from this plan. Worker lifetime is [open decision #10](../06-delivery-plan.md#open-decisions): a resident worker pays no cold start but inherits the state-leakage hazard the Stage-1 soak test exists for, and a per-event worker inverts both. Whichever wins, the enforcement path must not depend on a worker being up — a policy that fails to evaluate because its worker was not running is enforcement disappearing silently, which is the failure this product exists to prevent. The daemon starts one on demand within the remaining deadline and returns the client to in-process evaluation if it cannot.

**Capture needs nothing extra.** The daemon opens `~/.codex/sessions` and the other five roots directly, `inotify`s them, and attaches to the SQLite-backed ones in WAL mode. Checkpoints live in the collector's existing `~/.agenteye/` layout, adopted in place.

**Admission** runs in the CLI, as the user, with no elevation. `oxc_resolver`, `oxc_parser`, and `oxc_transformer` walk the import graph, derive the tier from what they find, and emit a **module map, not a bundle** — the sealed loader becomes a `HashMap` lookup with no filesystem reachable from it at all. That avoids bundler edge cases around circular imports and live bindings, and it deletes `loader-utils.ts` and its per-tool-call temp file from the daemon path entirely.

The signed schema catalog lands here too, and the native response matrix moves out of JavaScript into catalog `response_encodings` data with a closed substitution set, pinned byte-for-byte by the parity fixtures. Only now — with parity proven — is that safe.

**Exit:** end-to-end p95 beats the Stage-0 baseline on every CLI; a `user-context` result can tighten a `sealed` deny and never relax it, property-tested rather than exampled; a policy that under-declares fails *inside* sealed and trips its circuit breaker; native addons route to `user-context`; evaluation writes no file next to any policy source, asserted by watching the directory during a full corpus run; and `policies explain` names the resolved import that caused a `user-context` routing.

---

## Stage 5 — the daemon does capture

**Blocked on an external dependency.** `agenteye-collector` is a separate repository, not present here. [06-delivery-plan.md](../06-delivery-plan.md) requires extracting its conformance tests *before* touching its code, which is work in a repo this plan cannot reach. Vendoring that conformance corpus into `__tests__/fixtures/collector/` is an explicit prerequisite, and so is confirming its **on-disk `~/.agenteye/` layout**, because the daemon adopts that tree in place rather than defining one of its own. Phase 1 cannot be declared complete without both.

Rust owns the spool, checkpoints, delivery, quotas, and quarantine; the daemon's JavaScript worker reuses `lib/*-sessions.ts` verbatim rather than porting twelve transcript parsers. In Rust the daemon uses `rusqlite` in WAL read mode at the user's own UID — which it simply has, running as the user — removing `sqlite-reader.ts`'s two-tier fallback and the checkpoint lag along with it; today, on Node below 22.5, Hermes/Devin/Goose/Antigravity data is stale by up to one WAL checkpoint.

The durability unit is the **batch**, not the record; a per-record fsync is unaffordable at capture rates. Ordering: write `.tmp`, `fsync` the file, rename, `fsync` the directory; send with an `Idempotency-Key`; write the tombstone, `fsync` it, `fsync` its directory; **then** unlink the payload and `fsync` again. Compact tombstones only past a monotonic watermark plus a retention window. No transition depends on atomic rename alone for power-loss durability.
