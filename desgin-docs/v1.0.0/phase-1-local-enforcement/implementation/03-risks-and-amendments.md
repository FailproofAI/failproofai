# Risks and design-doc amendments

## Amendments folded into the design set

Six places where the design set was incomplete or stated something that was not true. **All six are now folded into the documents one directory up**, which is what this section was for. It is kept rather than deleted because the corrections read as ordinary design once they are in place, and the reason each one exists — the specific failure it prevents — is the part that does not survive being merged into surrounding prose. What follows records what was wrong, what replaced it, and where.

**1. macOS codesigning and notarization were absent from all eight documents.** On macOS 15 an unsigned `failproofaid` registered as a LaunchDaemon is killed, and `codesign --verify` fails for any MDM-managed fleet — so this blocked two of the four release targets while appearing nowhere in the plan.

*Folded into* [07-release-and-packaging.md](../07-release-and-packaging.md#code-signing-and-notarization) as its own section: Developer ID signing with `--options runtime` and `--timestamp` on both binaries *and* the vendored runtime, inner Mach-O before archive; `com.apple.security.cs.allow-jit` for a JIT-based pinned runtime, tied to the same constraint that decides the systemd unit's `MemoryDenyWriteExecute`; `notarytool submit --wait` then `stapler staple`, with the manifest digest computed after stapling; and a defensive `xattr -dr com.apple.quarantine` on the extracted tree. The signing steps are in the pipeline's assemble-and-sign list, four acceptance criteria cover them, and [04-service-and-updates.md](../04-service-and-updates.md#service-model) points at the section from the LaunchDaemon row, since that row does not work without it.

**2. Protected enablement must come from root-owned `machine.json`.** Enablement lived — and still lives — in the user-writable merge of `.failproofai/policies-config.json`. If the protected generation takes its enabled set from there, an agent with its user's authority deletes `block-sudo` from a JSON array and the unforgeable verdict simply never runs. Nothing is forged; the policy is not reached. That made [01-user-experience.md](../01-user-experience.md)'s "genuinely tamper-proof" false as written.

*Folded into* [03-daemon-architecture.md](../03-daemon-architecture.md#protected-enablement) as a new **Protected enablement** subsection — the root-owned file, the additive-only user configuration that may enable and parameterize its own policies but never a pinned entry, and an explicit statement that **this does not ship yet**: the daemon evaluates the client's resolved enabled set, which is client-asserted and carries exactly the trust the file the legacy path already reads carries. The false sentence in 01 is gone, replaced by the tier's honest scope (evaluation, not yet selection); [04-service-and-updates.md](../04-service-and-updates.md) puts enablement on the privileged side of its add/remove line and adds it to the ownership table; 01 and 06 gained acceptance criteria.

**3. `home` is daemon-derived; `cwd` and `project_dir` are client-asserted.** The docs treated request context as uniform. `home` must come from `getpwuid_r(peer_uid)`, because `isAgentInternalPath` and `block-read-outside-cwd` both *widen* the allow set — a client asserting `home: "/"` makes every path agent-internal, which is a forged input relaxing a sealed verdict.

*Folded into* [03-daemon-architecture.md](../03-daemon-architecture.md#derived-and-asserted-context) as **Derived and asserted context**, including the three-value attestation and the maximum rule that keeps a combined result from being reported as more attested than its weakest input. [02-harness-integration.md](../02-harness-integration.md) carries `host` in the envelope, provenance in the canonical event model, and `attestation` in the response; 01 reports it from `policies explain`. This one is **implemented and enforced** — a client-asserted `home` is a protocol error, not a correction — so the documents say so, and point at [`crates/PROTOCOL.md`](../../../../crates/PROTOCOL.md) as the wire contract of record.

**4. The per-user agent's unit file necessarily lives in a user-writable home.** A systemd user service is read from `~/.config/systemd/user/` and a LaunchAgent from `~/Library/LaunchAgents/`; being user-writable is what makes them user service managers. This is a documented exception to "nothing enforcement depends on lives under a user-owned root", and it is safe — the agent can only tighten, holds no credential, and substituting its binary buys the user nothing — but stating it is the whole point.

*Folded into* [03-daemon-architecture.md](../03-daemon-architecture.md#the-per-user-agent) as the exception, with why it is safe and why setup must drop privileges to write the file. [01-user-experience.md](../01-user-experience.md) states it where the "outside the user's home" guarantee is made, adds a line to the boundary-disclosure screen so the setup UI says it rather than implying the agent is tamper-resistant, and reports a missing agent in health.

**5. `/run/failproofai` is created by different mechanisms per platform.** systemd's `RuntimeDirectory=` recreates it on every boot because `/run` is tmpfs; launchd has no equivalent, so on macOS it is an installer-created persistent directory. Describing it as one thing is how a macOS install ends up expecting a directory nobody created.

*Folded into* [04-service-and-updates.md](../04-service-and-updates.md#service-model), where the two service managers are compared, with the daemon asserting the directory's owner and mode before binding on both platforms rather than trusting either mechanism. [03-daemon-architecture.md](../03-daemon-architecture.md#configuration-and-state) and [07-release-and-packaging.md](../07-release-and-packaging.md#installation-layout-and-ownership) name the difference where they give the layout, and 04 gained an acceptance criterion.

**6. Open decision #3 gates the release manifest schema, the SBOM, and the entitlements file.** It sat on the release critical path, earlier than [06-delivery-plan.md](../06-delivery-plan.md) implied.

*Folded into* 06: #3 is now scoped to the `user-context` runtime (the sealed engine being settled and shipped), states the three artifacts downstream of it, and is listed as a Stage 0 item; #7 names the Developer ID and `notarytool` custody as the long-lead item it is. [07-release-and-packaging.md](../07-release-and-packaging.md#code-signing-and-notarization) and [04-service-and-updates.md](../04-service-and-updates.md) both point back at #3 from the entitlements and `MemoryDenyWriteExecute` decisions that wait on it.

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
