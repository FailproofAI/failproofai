# Phase 1 — local enforcement plane

Status: Draft

Target: failproofai v1.0.0

`failproofaid` is the Rust background service for FailproofAI. Phase 1 is **the product as it ships today, re-architected**: it preserves the complete standalone OSS policy experience, moves evaluation into a warm resident sandbox with a deadline that is actually enforced, absorbs the standalone `agenteye-collector` without losing any of its behavior, and keeps harness hooks compatible through a signed schema catalog.

**Phase 1 ships and is useful on its own.** No FailproofAI account or organization is required, no administrator access is required, and no policy decision depends on a network service. Credentials the current product already has are carried over rather than reinvented — `failproofai auth login` is unchanged, and capture delivers to the customer's **own self-hosted** observability server with the operator-issued `events:add` key it uses today.

Phase 2 is the genuinely new management plane: machine enrollment into Failproof Cloud, centrally assigned policy, targeting, fleet health, and staged rollout. See [Phase 2](../phase-2-cloud/README.md).

## Documents

1. [User experience](./01-user-experience.md) — how a user installs, configures, operates, and removes FailproofAI.
2. [Agent harness integration](./02-harness-integration.md) — how agent CLIs and runtimes send events and enforce daemon decisions.
3. [Daemon architecture](./03-daemon-architecture.md) — Rust process model, IPC, policy runtime, execution tiers, failure isolation, and local state.
4. [Service and harness schema updates](./04-service-and-updates.md) — the user service, deferred scopes, and signed version-aware hook schema reconciliation without automatic binary replacement.
5. [Collector integration](./05-collector-integration.md) — session capture, durable spooling, delivery, and adoption of the existing collector's state.
6. [Delivery plan](./06-delivery-plan.md) — stages, acceptance criteria, and unresolved decisions.
7. [npm release and distribution](./07-release-and-packaging.md) — the single npm bootstrap path, native artifact pipeline, signing, and channel promotion.

The [implementation plan](./implementation/) says how this gets built: the Rust/TypeScript boundary, six sequenced stages with entry and exit gates, the verification strategy including a full-stack Docker acceptance gate, and the record of amendments since folded into these documents.

## Settled decisions

- `failproofaid` is implemented in Rust.
- **One scope ships: `user`.** The daemon, the CLI, configuration, policies, state, and the socket all belong to the invoking user. There is no service account, no root-owned surface, no privileged installer, and no `sudo` anywhere in the product. Setup is an ordinary user-scope install, and every guarantee below is stated for that one scope rather than qualified per scope.
- **Exactly two programs ship**: the `failproofaid` daemon and the `failproofai` CLI. The CLI is also the hook client the harness invokes per event and the process that serves the local dashboard; there is no per-user agent, no collector process, and no dashboard service. [Two programs, and what runs when](./01-user-experience.md#two-programs-and-what-runs-when) is the exact accounting.
- Configuration is read from `.failproofai` in user scope, exactly as it is today, and capture state stays in `~/.agenteye/` where the collector already writes it. Nothing moves to `/opt`, `/var/lib`, `/etc`, or `/Library`, and nothing is migrated out from under the user.
- **The `sealed` tier makes no verdict-integrity claim in this release, and nothing in the product may imply one.** The governed agent runs as the same user as the daemon: it can `ptrace` the daemon, preload into it, replace the binary, or edit the configuration. What the tier does buy is stated positively in [where policies execute](./01-user-experience.md#where-policies-execute) — a warm evaluator instead of a process per hook event, no temp files written beside the user's source, a deadline made real by an out-of-band watchdog, and a deny-by-default sandbox that contains a buggy or over-reaching policy.
- A `managed` scope running as a dedicated service account and a root-owned `system` scope are designed and deliberately unshipped, recorded in [deferred scopes](./04-service-and-updates.md#deferred-scopes). The verdict-integrity claim belongs to those, and adding one is what would buy it. Neither is reachable as an automatic fallback.
- Execution tier is derived at admission from the resolved import graph, never from the author's own declaration, and the `sealed` context is deny-by-default so an under-declared policy fails inside it rather than escaping it. The derivation decides whether a policy *can* run in the resident sandbox at all, which is why it is structural rather than advisory.
- The socket is peer-credentialed. The daemon serves exactly one UID — its owner — and refuses every other peer, because a shared machine can have several users each running their own daemon. `home` is derived from `getpwuid_r(peer_uid)` rather than accepted from the client.
- The release ships a pinned policy runtime, so the daemon evaluates against a known version rather than whichever Node a version manager happens to expose, and constructs worker environments rather than inheriting them.
- Admission compiles a policy and its full import graph into one content-addressed artifact, so evaluation resolves nothing from a mutable path and every decision names an exact digest. It needs no elevation, because nothing in this product does.
- Enforcement performs no unbounded I/O. Policies needing remote state read a cache the collection lane refreshes on its own schedule.
- The local dashboard is the CLI running in dashboard mode: loopback-only, token-gated, TTL-bounded, reading through the daemon's `Query` operations.
- Linux and macOS are supported; Windows service, packaging, and daemon support are deferred.
- All current builtin, custom, explicit-file, convention-file, scope, harness, activity, and local-dashboard behavior remains available.
- Agent hook decisions are synchronous and evaluated locally.
- Collection, delivery, and harness schema-catalog refresh are asynchronous.
- Enforcement is fully offline once installed; installation itself requires network access, since npm bootstrap is the only supported path and air-gapped distribution is deferred.
- **An unreachable daemon costs latency and the sandbox, not enforcement.** The in-process evaluator that ships today answers whenever the daemon does not, and in user scope it carries exactly the same authority the daemon does, so falling back to it loses no property this release claims.
- The standalone `agenteye-collector` moves into the daemon here, because everything it ships is current behavior the compatibility promise covers. Capture is off until enabled, and its destination is the customer's own server, so delivery pulls no FailproofAI account into Phase 1.
- The observability delivery key is the only secret Phase 1 handles. It lives in the user's own configuration alongside the rest of the collector's settings, readable by that user and therefore by that user's agent, never in a service definition or process argument, and erased unconditionally on uninstall. It grants `events:add` on the customer's own server and nothing else; per-machine issuance and rotation are the operator-side answer.
- Contract shape keeps Phase 2 and a possible later off-machine evaluation open — canonical location-independent request/result, end-to-end deadlines, stable decision identity, bounded lanes, a versioned health snapshot — without adding a configuration key, client, or user-visible setting for either.
