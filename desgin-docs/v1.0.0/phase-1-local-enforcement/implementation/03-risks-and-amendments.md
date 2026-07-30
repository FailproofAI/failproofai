# Risks and design-doc amendments

## Amendments the design docs need

Six places where the design set is incomplete or states something that is not currently true. Fold these into the documents one directory up as Stage 0 lands, rather than discovering them during implementation.

**1. macOS codesigning and notarization are absent from all eight documents.** On macOS 15 an unsigned `failproofaid` registered as a LaunchDaemon is killed, and `codesign --verify` fails for any MDM-managed fleet. Required: Developer ID signing with `--options runtime` and `--timestamp` on both binaries *and* the vendored runtime; the `com.apple.security.cs.allow-jit` entitlement for the pinned runtime, which is also why the systemd unit must set `MemoryDenyWriteExecute=no`; `notarytool submit --wait` followed by `stapler staple`; and a defensive `xattr -dr com.apple.quarantine` on the extracted tree. **This blocks two of the four targets** and belongs on the critical path, not in a footnote.

**2. Protected enablement must come from root-owned `machine.json`.** Policy enablement currently lives in the user-writable merge of `.failproofai/policies-config.json`. If the sealed generation's enabled set comes from there, an agent with its user's authority deletes `block-sudo` from a JSON array and the unforgeable verdict simply never runs — so [01-user-experience.md](../01-user-experience.md)'s "genuinely tamper-proof" is not true as written. The user's configuration survives unchanged but becomes **additive-only**: it may enable additional policies and set parameters for policies it itself enabled, never for a pinned entry.

**3. `home` is daemon-derived; `cwd` and `project_dir` are client-asserted.** The docs treat request context as uniform. It is not: `home` must come from `getpwuid_r(peer_uid)` because a client-asserted home would *widen* the allow set in `isAgentInternalPath` and `block-read-outside-cwd`. `cwd` and `CLAUDE_PROJECT_DIR` genuinely cannot be derived, so decisions that read them are labeled `sealed_unattested` in evidence and by `policies explain`.

**4. The per-user agent's unit file necessarily lives in a user-writable home.** This is a documented exception to "nothing enforcement depends on lives under a user-owned root". It is safe — the agent can only tighten, and substituting its binary buys the user nothing — but the setup UI must state it rather than implying the agent is tamper-resistant.

**5. `/run/failproofai` is created by different mechanisms per platform.** systemd's `RuntimeDirectory=` recreates it on every boot because `/run` is tmpfs; launchd has no equivalent, so on macOS it is an installer-created persistent directory. The docs describe it as one thing.

**6. Open decision #3 — which runtime is pinned — gates the release manifest schema, the SBOM, and the entitlements file.** It sits on the critical path for the release pipeline, earlier than [06-delivery-plan.md](../06-delivery-plan.md) implies.

---

## Top risks

**Removing `prepare` publishes an empty package.** `.github/workflows/publish.yml` has no build step and depends entirely on the `prepare` lifecycle script to populate the gitignored `dist/` and `.next/standalone/`, both of which are in the `files` allowlist. The removal and the workflow's new build step must land in the same PR, verified by `npm pack --ignore-scripts`, unpack, and `failproofai --version` in a clean container.

**Warm-worker state leakage produces wrong verdicts, not crashes.** Every hook today runs in a fresh process, so the `globalThis` policy registry, the memoized policy index, the cwd-keyed git-branch cache, and every hoisted `/g` regex start clean. A resident sealed worker changes all of that at once. The Stage-1 soak test — the full corpus twice through one worker, then once in randomized order — is the entire mitigation, and it is cheap.

**"The daemon isn't faster" could kill the project mid-flight for the wrong reason.** Through Stage 3 the client is still `bin/failproofai.mjs` under Node or bun, so 40–80 ms of process startup dominates and masks the win. The real Stage 1–3 gain is removing the per-invocation config read and policy load — which today writes temp files next to the user's source on every tool call. State that explicitly, and gate the end-to-end latency target at Stage 4, when the native client lands, rather than at Stage 1.

**Skipping P1 yields an empty sealed tier.** All 39 builtins currently share a module that imports `child_process`, so import-graph tier derivation would route every one of them to `user-context`. The result is an architecture that looks implemented and delivers no verdict integrity at all. This is the least visible failure mode in the whole plan.

**Two writers to harness settings files.** A user running `failproofai policies --install` while the Rust reconciler repairs the same file will clobber one side. The single-writer invariant plus a per-adapter lockfile landed at Stage 4 — *before* the reconciler exists — plus a deliberate concurrency test under contention.

**Corpus determinism.** If the parity corpus is generated before P1 and P2 land, it bakes in machine-specific paths and becomes worthless. The generator must assert that no subprocess-spawning or filesystem-writing policy was reached.

**`agenteye-collector` is not in this repository** and blocks Stage 5. Vendoring its conformance corpus is a prerequisite, not a step.

**Signing key custody is the long-pole non-code item.** It gates release, not development, so start it during Stage 0 in parallel with engineering rather than discovering it at the release gate.
