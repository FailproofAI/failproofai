# Agent harness integration

## Definition

An agent harness is an agent CLI, IDE integration, gateway, or runtime whose lifecycle and tool-execution events can be observed or controlled. Examples include Claude Code, Codex, Cursor, Copilot CLI, OpenCode, Pi, Hermes, OpenClaw, Factory, Devin, Antigravity, and Goose.

Harnesses do not implement FailproofAI policies. They expose native events; a thin FailproofAI adapter converts those events into the stable local daemon protocol and converts the daemon's canonical result back into the harness's native allow/deny/instruction contract.

## Integration boundary

```text
harness native event
        |
        v
harness registration/configuration
        |
        v
native `failproofai hook` client
        |
        | versioned local IPC
        v
`failproofaid` canonicalization + policy evaluation
        |
        v
canonical allow / deny / instruct response
        |
        v
harness-specific stdout, exit code, callback, or plugin response
```

The harness-facing client must stay small and bounded. It reads one event, makes one local request, writes one response, and exits or returns control. It does not load policies, scan transcripts, contact any network service, check for updates, or start the dashboard.

## Harness adapter contract

Each harness adapter declares a versioned capability descriptor:

- harness ID and detected harness version;
- native event name to canonical event mapping;
- native tool name/input to canonical tool mapping;
- fields that provide session, agent, project, working-directory, transcript, permission-mode, and parent-session identity;
- events on which the harness can block, observe only, or add context;
- response encoding: stdout schema, callback object, exit code, or gateway result;
- maximum safe response time and timeout semantics;
- behavior of stop-class nonzero responses, including whether they retry;
- configuration scopes and files used to register the adapter.
- registration attachment level (`detectable` or `cooperative` in this release; `protected` only under a deferred scope), its bypass paths, and the evidence used to verify continued attachment.

Capability descriptors are code and test data, not prose-only documentation. `failproofaid` records the descriptor version used for every decision so FailproofAI can distinguish a policy allow from a harness that could not enforce the result.

## Registration strategies

Harnesses expose different extension surfaces. v1 supports three adapter shapes:

### Command hook

The harness invokes a command for an event and passes JSON or another documented payload on stdin. Setup writes the harness's supported configuration to call:

```sh
failproofai hook --harness <name> --event <native-event>
```

The native client reads stdin and returns the required stdout and exit status. This is preferred where the harness has a real blocking hook contract.

### In-process plugin shim

Some harnesses expose JavaScript/TypeScript, Python, or another plugin API rather than a command hook. A minimal versioned shim invokes the same native client or local IPC protocol and returns the harness callback result.

The shim contains only vendor adaptation. Policy evaluation remains in the daemon. A shim failure is visible and follows the integration's configured failure behavior.

### Gateway or wrapper adapter

Some runtimes expose events only inside a gateway process or require a wrapper around invocation. The adapter runs at that boundary and forwards events to the daemon. Setup must clearly disclose when enforcement depends on using the configured gateway/wrapper rather than every possible way of launching the agent.

## Attachment and repair

Enforcement depends on the harness continuing to call FailproofAI, and in this release every harness settings file involved belongs to the user whose agent is being governed. There is no registration an agent with that user's authority cannot edit, so **no adapter is labeled `protected`** — the strongest level reachable is `detectable`, and some are only `cooperative`.

What the daemon does with a user-writable registration is still worth doing. It fingerprints the expected registration, checks it when filesystem events arrive and through periodic reconciliation, records changes, and automatically restores missing or altered FailproofAI entries. That repairs the two failures that actually happen — a harness upgrade that rewrites its settings file and drops unrecognized hooks, and a hand edit that removes the wrong line — and it makes a deliberate removal *visible* in health rather than silent. It does not prevent removal, and describing repair as prevention is forbidden.

`protected` becomes reachable only with a registration the governed user cannot write: a machine-level hook or mandatory plugin owned by another account, or a gateway or wrapper backed by OS or fleet controls that prevent direct launch of the agent binary. All of those require a [deferred scope](./04-service-and-updates.md#deferred-scopes), so the label is unused in this release rather than aspirational.

The daemon also detects missing event heartbeats relative to known sessions where the harness provides enough evidence, which catches an agent launched by a path that bypasses the registration entirely.

### Hook settings reconciliation

Every enabled adapter stores a desired registration in the daemon's own state, which is what reconciliation compares against rather than the harness file's previous contents. `failproofaid` watches the harness settings file and its parent directory so atomic replacement, rename, deletion, and recreation are all observed. Filesystem notification is an optimization; a bounded periodic scan is the correctness backstop after daemon downtime, queue overflow, or missed events.

Reconciliation parses the harness's native configuration and compares normalized FailproofAI entries rather than raw file bytes. If an entry is missing or changed, the daemon performs an adapter-aware merge that restores only FailproofAI-owned keys and preserves unrelated hooks, ordering where meaningful, comments where the format supports them, permissions, and ownership. It validates file type, owner, parent path, and symlink policy before writing, takes an adapter-specific lock, re-reads after acquiring it, writes a same-directory temporary file, fsyncs it, atomically renames it, fsyncs the directory, and verifies the resulting registration. Compare-and-swap metadata or bounded retry prevents overwriting a concurrent legitimate edit.

The daemon suppresses its own watcher event, debounces editor write bursts, and rate-limits repeated repair loops. Each repair records old/new registration identities, user, harness, reason, and result without logging unrelated settings or secrets. Persistent tampering degrades health and raises a local alert. Repair remains enabled by default while the integration is enabled; `harness disable` first removes the desired registration so intentional uninstall is not repaired.

The daemon authorizes every request from operating-system peer credentials rather than a bearer token exposed to the agent environment, and it serves exactly one UID: its owner. A peer that is not the owner is refused. On a shared machine several users may each be running their own daemon, and this is what keeps one user's socket from answering another user's events — a routing and isolation rule between users, not a privilege boundary within one.

The client applies the mirror-image check. It confirms the socket it connected to is owned by the identity recorded at install time and refuses to translate a response from anything else. A verdict from an unverified peer is treated as daemon-unavailable, not as `allow` — so a stray or stale socket costs a fallback to in-process evaluation rather than a silent allow.

## Request envelope

The client sends a length-prefixed request over a Unix domain socket. The implemented wire contract — framing, version handshake, field-by-field encoding rules, and the error enum — is [`crates/PROTOCOL.md`](../../../crates/PROTOCOL.md); what follows is its conceptual shape:

```json
{
  "protocol_version": 1,
  "operation": "evaluate_hook",
  "request_id": "018f...",
  "deadline_monotonic_ms": 8421931,
  "client": {
    "version": "1.0.0",
    "harness": "codex",
    "harness_version": "...",
    "adapter_version": 3
  },
  "host": {
    "home": null,
    "cwd": "/home/u/project",
    "project_dir": null,
    "env_facts": { "CLAUDE_PROJECT_DIR": null }
  },
  "event": {
    "native_name": "...",
    "payload": {}
  }
}
```

`host.home` is `null` on the wire and always will be: the daemon derives the home from the peer credential, and a client that asserts one is rejected as a protocol error rather than corrected. The daemon can get this field right on its own and the client cannot be relied on to, and a wrong home *widens* what path policies allow — a silently wrong verdict rather than a visible failure. `cwd`, the project directory, and a closed set of environment facts cannot be derived and therefore ride as client-asserted, which is what makes some decisions `sealed_unattested` — [derived and asserted context](./03-daemon-architecture.md#derived-and-asserted-context) has the argument.

Native payload at the wire boundary is the intended end state, so adapter fixes can be made centrally in the daemon without requiring every hook registration to change. The shipped envelope has not reached it. While the hook client is still the TypeScript one, the payload it sends is **already canonicalized** — tool names and tool-input keys mapped, per-CLI normalizations applied — and the daemon trusts it rather than re-deriving it. Re-derivation is not implementable from that envelope, because it needs the raw vendor payload and only the canonical one is sent. What that costs is a *correctness* check rather than a trust boundary: both ends run as the same user, so the value of re-deriving canonicalization is catching a client that got a vendor's payload shape wrong, which is exactly the class of bug the twelve adapters produce. It closes when canonicalization moves daemon-side with the native client, and until then the parity corpus is what catches the same class. The client still enforces a fixed input-size limit before allocating or sending data, matched by the daemon's own frame cap so a payload the legacy path would have discarded cannot become a daemon-path exhaustion instead.

The client supplies an absolute monotonic deadline. The daemon never invents a longer one. Time reserved for response translation and process exit is excluded before the request is sent. This deadline covers local queueing and policy evaluation.

## Canonical event model

The daemon canonicalizes the request into a common event containing:

- canonical lifecycle event;
- harness and native event identity;
- machine, agent, project, session, and parent-session identity with provenance;
- canonical tool name and normalized input where applicable;
- working directory, transcript reference, and permission mode when exposed;
- raw payload retained only for policy fields that require it and within size limits;
- enforcement capability for this event/harness version.

Canonicalization must preserve evidence about absent or uncertain fields. An inferred session ID is not represented as vendor-provided. A session-scoped match never broadens when session identity is unavailable.

Provenance is part of that evidence, not a separate concern. The working directory, project directory, and environment facts are recorded as asserted by the client, because the daemon has no way to check them; the home directory is derived from the peer credential and never accepted from the client at all. A decision inherits the weakest provenance any deciding policy read, which is what the response's attestation reports — evidence about what a verdict depended on, so a surprising decision can be traced to the input that produced it.

## Session lifecycle

Harness adapters should report explicit session start, resume, compact, subagent start, and end events where available. The daemon uses them to maintain a local session registry that maps native IDs to the stable targeting identity used by policy matching, captured sessions, and decision evidence.

When explicit lifecycle events do not exist, the daemon derives a session boundary from documented identifiers and activity. The adapter descriptor records this identity quality. Session-scoped enforcement is enabled only when the identity is strong enough to avoid applying a policy to the wrong run.

Agent and session identity must align with collector output. An enforcement decision and a captured session from the same harness run must join on stable identifiers, so neither the local dashboard nor the observability server has to reconstruct the join heuristically after the fact.

## Response model

The daemon returns a canonical response:

```json
{
  "request_id": "018f...",
  "generation": 184,
  "decision": "deny",
  "message": "Policy explanation safe to show to the agent",
  "context": null,
  "decision_id": "018f...",
  "attestation": "sealed",
  "deadline_status": "within_budget"
}
```

`attestation` is `sealed`, `sealed_unattested`, or `user_context`. The adapter does not translate it — it is evidence rather than a harness-visible result — but it is what the decision record and `policies explain` report. It records where a decision was computed and whether it depended on a value the client asserted. In this release that is diagnostic provenance; under a [deferred scope](./04-service-and-updates.md#deferred-scopes) the same field becomes an integrity claim, which is why it is carried now.

The harness adapter translates it according to declared capability:

| Canonical result | Blocking event | Observe-only event | Context-capable event |
|---|---|---|---|
| `allow` | allow | continue | continue |
| `deny` | block using native contract | continue and record unenforced deny | block if supported, otherwise observe |
| `instruct` | allow with native message where supported | record only | add context/instruction |

The daemon records both the policy result and effective harness action. Reporting a deny as enforced when the harness ignores that event is forbidden.

## Deadlines and unavailable daemon

Every adapter has a tested total time budget. Connection, daemon admission, policy evaluation, and response translation each consume that one budget.

The client evaluates in process whenever the daemon endpoint is absent or protocol-incompatible. As it is actually built, that evaluator is not a package the client invokes but the untouched remainder of the code path the client is already executing, which is why it costs nothing to keep: there is no second artifact to hold in sync. Every daemon-side outcome other than a verdict — an unreachable socket, a version-handshake mismatch, a rejected envelope, a missed deadline — returns the client to it, and none of them fails the hook.

Because the daemon and the in-process evaluator run as the same user with the same authority over the same configuration, this is not a degraded security posture — it is the same decision computed more slowly, without the sandbox and without the enforced deadline. That is what makes it a reasonable permanent default rather than a migration crutch, and it is why an unsupervised or crashed daemon is a health degradation rather than an enforcement gap.

A later release may make unavailable-daemon behavior explicit per integration and policy class:

- fail open and record degradation;
- fail closed using the native blocking contract;
- use a locally cached emergency decision for narrowly defined mandatory policies.

Stop-class hooks require an adapter-specific response because some harnesses interpret a nonzero exit as “retry” and can loop forever. No generic failure exit is applied across harnesses.

## Configuration ownership

`failproofai setup` owns only marked FailproofAI entries in harness configuration. It must:

- merge without deleting unrelated user hooks or plugins;
- detect and upgrade older FailproofAI commands in place;
- avoid registering the same event twice;
- preserve the original file format and permissions where practical;
- use atomic writes and retain a rollback copy until verification succeeds;
- remove only owned entries during disable or uninstall.

Project-scoped integrations remain possible, but they still connect to the user's daemon. Setup displays whether an integration is user-, project-, or local-scoped and which projects it covers.

## Version negotiation

The client and daemon negotiate a protocol version before evaluation or use a cached compatible version after a recent successful handshake. Releases declare:

- supported IPC protocol range;
- harness adapter descriptor revisions;
- policy runtime/API range;
- minimum compatible client and daemon versions.

Explicit binary upgrades must tolerate the old client talking to the new daemon and the new client talking briefly to the old daemon during setup. Incompatible versions fail with an actionable diagnostic and use the documented migration fallback where available.

## Adding a harness

A new harness integration is complete only when it provides:

1. detection and version probing;
2. an adapter capability descriptor;
3. install, upgrade, disable, and uninstall configuration transforms;
4. fixture-backed canonicalization tests for every supported native event;
5. response-contract tests proving allow, deny, instruct, timeout, and daemon-unavailable behavior;
6. session/agent identity tests aligned with its collector source;
7. enforcement-capability evidence traced to the harness call site or vendor contract;
8. an end-to-end test against the real harness or a version-pinned conformance probe;
9. health and diagnostics output;
10. user documentation stating what is enforceable and what is observation-only.

## Harness acceptance criteria

- The thin client makes no network request and performs no policy-loading work.
- Golden fixtures preserve current canonical decisions and native response contracts.
- Every event is labeled block, observe, or context-capable from verified evidence.
- A harness upgrade that changes payload or response behavior fails conformance visibly rather than silently allowing.
- Hook installation is idempotent and uninstall preserves unrelated configuration.
- Enforcement and collector records for one session share stable identity.
- Missing session identity never broadens a session-scoped match.
- Timeout and daemon-unavailable behavior is tested separately for every harness, especially stop-class events.

The envelope and framing remain transport-neutral so a later Windows implementation can add a named-pipe transport without changing harness semantics.
