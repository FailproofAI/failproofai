# Phase 1 implementation plan

Status: Approved

Scope: [Phase 1 — local enforcement plane](../README.md)

The design documents one directory up say *what* Phase 1 is and *why*. These say how it gets built, in what order, and how each step is proven before the next one starts.

## Documents

1. [Stages](./01-stages.md) — the six stages, each with entry and exit gates.
2. [Verification](./02-verification.md) — the test strategy per layer, and the full-stack Docker acceptance gate.
3. [Risks and design-doc amendments](./03-risks-and-amendments.md) — what can go wrong, and six places the design docs are incomplete or wrong.

## What problem the sequencing solves

Today every agent hook event spawns a fresh Node/bun process that re-reads configuration, dynamically imports user policy files — writing `.__failproofai_tmp__.mjs` temp files next to the user's source on *every tool call*, via `src/hooks/loader-utils.ts` — evaluates, and exits.

That is slow and it litters user directories, but the real problem is that it is **cooperative**: the agent being governed runs with the same authority as the thing governing it, so it can edit the policy configuration, remove the hook, or replace the evaluator.

Phase 1 moves enforcement behind a boundary the agent cannot administer. The risk is that "rewrite the enforcement plane" is exactly the kind of project that produces a silent-allow regression across twelve vendor CLIs, each with its own incompatible response contract. So the plan is built around one idea: **the existing TypeScript implementation is not replaced, it is promoted to oracle.** It stays in the tree, keeps its tests, answers when the daemon cannot, and is the thing every new implementation is diffed against byte-for-byte.

## Settled decisions

| Decision | Choice | Why |
|---|---|---|
| Sealed JS engine | **QuickJS-ng via `rquickjs`**, gated by a Stage-0 spike | ~1 MB against V8's +30–45 MB on each of four tarballs `npx` downloads. Deny-by-default is structural rather than a syscall filter, and a fresh context per evaluation costs microseconds, so no state crosses evaluations. |
| Builtins ported to Rust? | **No.** All 39 stay JavaScript, inside the sealed engine | The boundary is the process, UID, and absent bindings — not the language. Porting buys no security, does nothing for user-authored policies (the actual compatibility promise), and the `regex` crate cannot express the lookbehind in `extractAbsolutePaths`. |
| Protected policy enablement | **Root-owned `machine.json`** | Enablement currently lives in a user-writable file, so an agent deletes `block-sudo` from a JSON array and the unforgeable verdict never runs. Disabling a pinned policy now needs `sudo`. |
| Distribution | **npm bootstrapper + independently-signed tarballs** | `optionalDependencies` platform packages collapse the two trust layers into one, move a ~40 MB download from `setup` to dependency resolution, and reproduce the esbuild silent-missing-binary failure under `--omit=optional`. `packages/` is never created. |
| Native response rendering | JS in the sealed worker first; catalog data at Stage 4 | Same endpoint, sequenced by risk. `policy-evaluator.ts` is preserved byte-for-byte until parity is proven. |
| Rust location | This repo, Cargo workspace at the root | Both implementations must consume the same fixture bytes. A second repository makes that a permanent submodule-sync problem. |
| Full-stack delivery target | Contract-faithful **stub ingest server** | Hermetic, no credentials, gates every PR. A real-server leg is added when an image is available. |

## The Rust / TypeScript boundary

**Rust owns ordering, privilege, durability, and deadlines. JavaScript owns matching a vendor's or a user's semantics.**

Stays TypeScript — and is deliberately *not* forked, because it doubles as the parity oracle and the daemon-unavailable fallback:

| Area | Why it must not be ported |
|---|---|
| `src/hooks/builtin-policies.ts` | 39 policies whose exact semantics are encoded in 4,006 lines of tests. |
| `src/hooks/policy-evaluator.ts` | The per-CLI native response matrix — twelve mutually incompatible contracts, each annotated with the vendor version it was verified against. A "semantically equivalent" reimplementation is a silent-allow generator. |
| `src/index.ts`, `custom-hooks-registry.ts`, `policy-helpers.ts` | The six-symbol public API *is* the user contract. |
| `src/audit/**` | `replay.ts` imports `evaluatePolicies` directly; removing the JS evaluator breaks `failproofai audit` outright. |
| `manager.ts`, `configure-wizard.ts`, `tui.ts`, `install-prompt.ts` | [01-user-experience.md](../01-user-experience.md) requires reusing this wizard rather than building a second installer UI. |
| `integrations.ts` write paths, `lib/*-sessions.ts` | Comment-preserving YAML, twelve settings-file transforms, twelve transcript parsers. Reused inside the agent's JS worker. |

Is Rust: framing, IPC, peer credentials, lanes, deadlines, and per-UID quotas; canonicalization, code-generated from `types.ts`; generation lifecycle, admission, import-graph resolution, and content addressing; worker supervision; the spool state machine; watchers and reconciliation; the installer and service registration; and a **minimal failure-mode encoder subset** — one row per `(cli, event)`, used only when the sealed worker is circuit-broken. That subset is the only response logic that exists twice, and it is generated from the same corpus as everything else.
