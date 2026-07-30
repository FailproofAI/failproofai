# `failproofaid` local IPC — protocol v1 (Stage 1)

Status: **Stage 1 walking skeleton.** Only `Ping` and `EvaluateHook` are
implemented. `Status`, `Reload`, `Flush`, and the `Query` set are named in
[03-daemon-architecture.md](../desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md)
and land later; the framing and envelope below are shaped so adding them is a
new `op` variant rather than a wire change.

This file is the single source of truth shared by `fpai-ipc` (Rust),
`failproofaid` (Rust), and `src/hooks/daemon-client.ts` (TypeScript). All three
are written against it independently, so anything ambiguous here becomes a
silent interop bug.

---

## Transport

A Unix domain stream socket at `$FAILPROOFAI_DAEMON_SOCKET`, or, in order:

| Preference | Path |
|---|---|
| 1 | `$XDG_RUNTIME_DIR/failproofai/failproofaid.sock` |
| 2 | `~/.failproofai/run/failproofaid.sock` |

The fallback is not defensive padding. `XDG_RUNTIME_DIR` is unset over a plain
`ssh` session on several distributions and on macOS generally, which is exactly
the environment an agent CLI runs in.

No TCP, including loopback.

**v1.0.0 runs entirely in user scope**, so the socket lives in the user's own
runtime directory and is owned by that user. It is created `0600`: on a shared
machine several users may each run their own daemon, and a socket another user
could connect to would let them submit events into — and read verdicts from —
someone else's evaluator.

What this does *not* do is defend against the user who owns it. That user can
unlink the socket, bind a substitute, `ptrace` the daemon, or replace its
binary, because it is their process running under their UID. See
[what the sealed tier does and does not claim](#what-the-sealed-tier-claims).

## Framing

Every message, in both directions:

```
+--------+--------------------+
| u32 BE | body (UTF-8 JSON)  |
+--------+--------------------+
  length      length bytes
```

- `length` counts the body only.
- **Maximum body: 1 MiB (1_048_576).** This matches the existing 1 MB stdin cap
  in `handleHookEvent`, so a payload that the legacy path would have discarded
  cannot become a daemon-path OOM instead.
- A declared length above the maximum is a framing error: the daemon replies
  with `frame_too_large` if it can and closes the connection. It must not
  allocate the declared size before validating it. (`fpai-ipc` asserts this
  with a counting global allocator: a `u32::MAX` prefix that allocated would
  fail the test rather than exhaust the machine.)
- A short read (EOF mid-frame) is a framing error, never a zero-filled frame.
- Length-prefixed, not newline-delimited, because payloads carry arbitrary tool
  input including newlines.

## Handshake

The first frame in each direction is the version handshake. It is a separate
frame rather than a field on every request so a version mismatch is diagnosed
once, at connect, instead of per event.

Client → daemon:

```json
{ "hello": { "protocol_version": 1, "client": "failproofai-hook", "client_version": "0.0.16-beta.0" } }
```

Daemon → client, on success:

```json
{ "hello_ack": { "protocol_version": 1, "daemon_version": "0.0.16-beta.0", "generation_id": "gen-<hex>" } }
```

Daemon → client, on mismatch — then close:

```json
{ "version_mismatch": { "supported": [1], "received": 2 } }
```

**A client that receives anything other than `hello_ack` must fall back to the
legacy in-process evaluator.** It must never guess, retry with a different
version, or fail the hook.

## Encoding rules

These are the questions two independent implementations of this document
actually disagreed on. Each is settled here rather than left to the reader,
because every one of them is a silent interop bug rather than a loud one.

1. **Absent key and explicit `null` are equivalent on read; writers always emit
   the key.** A reader must accept `{"host": {"cwd": "/x"}}` and
   `{"host": {"cwd": "/x", "project_dir": null}}` identically. A writer emits
   every field of every object it sends, `null` where it has no value. Readers
   being lenient and writers being strict means a lagging writer interoperates
   while the wire stays self-describing.
2. **A zero-length body is `malformed_frame`,** not an empty message. There is
   no message in this protocol whose encoding is zero bytes, so a zero length
   is always a bug on the sender's side.
3. **`payload` must be a JSON object.** An array or scalar is
   `malformed_frame`.
4. **Every `session` field is optional.** No harness supplies all four.
5. **`shadow` defaults to `false` when absent.**
6. **Unknown keys are rejected, everywhere.** Not ignored. A field this version
   does not know is either a client bug or a version skew the handshake should
   have caught; dropping it silently would make both look like success. The one
   deliberate exception is `env_facts`, whose unknown keys are rejected with a
   *specific* error naming the key — see `unknown_env_fact` — because "you sent
   something I do not accept" is only actionable if it says what.
7. **Attestations combine as a maximum under `sealed < sealed_unattested <
   user_context`** — least attested wins. A combined result can never be
   reported as more attested than its weakest input; the inverse would let a
   `user_context` contribution be laundered into a `sealed` claim, which is the
   exact property the two-tier split exists to provide.

The examples below abbreviate: an `op` or `result` block is shown without its
enclosing `{"request_id": …}` frame. Every real request and response frame
carries `request_id`.

## Operations

After a successful handshake, request frames are:

```json
{ "request_id": "<uuid-v4>", "op": { … } }
```

and response frames are:

```json
{ "request_id": "<uuid-v4>", "result": { … } }
```

`request_id` is echoed verbatim. Stage 1 is strictly request/response over one
connection with no pipelining, so a mismatched `request_id` is a protocol
error — but it is carried now because decision evidence must be correlatable
once lanes are concurrent.

### `Ping`

```json
{ "op": { "ping": {} } }
→ { "result": { "pong": { "daemon_version": "0.0.16-beta.0", "uptime_ms": 12345 } } }
```

Exists so a client can prove liveness without submitting an event, and so the
service manager's readiness check is independent of policy state.

### `EvaluateHook`

```json
{
  "op": {
    "evaluate_hook": {
      "cli": "claude",
      "event_type": "PreToolUse",
      "raw_event_type": "PreToolUse",
      "payload": { "tool_name": "Bash", "tool_input": { "command": "sudo rm -rf /" } },
      "session": {
        "session_id": "sess-1",
        "transcript_path": "/home/u/.claude/projects/x/sess-1.jsonl",
        "permission_mode": "default",
        "hook_event_name": "PreToolUse"
      },
      "host": {
        "home": null,
        "cwd": "/home/u/project",
        "project_dir": null,
        "env_facts": { "CLAUDE_PROJECT_DIR": null }
      },
      "enabled_policies": ["block-sudo", "block-env-files"],
      "deadline_ms": 800,
      "shadow": false
    }
  }
}
```

Field notes, in decreasing order of how badly getting them wrong would hurt:

- **`host.home` MUST be `null`.** The daemon derives it from
  `getpwuid_r(peer_uid)`. A non-null `home` is a **protocol error**
  (`client_asserted_home`) and the request is rejected — not ignored, not
  overwritten.

  The reason is correctness rather than defence, and saying so keeps the rule
  from looking like theatre now that the client and the daemon are the same
  user. `isAgentInternalPath` and `block-read-outside-cwd` both *widen* the
  allow set: a `home` of `/` makes every path on the machine "agent internal",
  so of every host field this is the one where a wrong value silently permits
  instead of silently denying. The daemon is also resident and answers for
  sessions it did not start, so a per-request `home` is the only one that can
  be right at all. Deriving it removes a field that can be wrong; the threat
  being defended against is a buggy client, and a buggy client is the one that
  actually happens.

  Rejecting rather than overwriting is deliberate. Overwriting makes a
  wrong value harmless but leaves the protocol *looking* like it accepts the
  field, so the next client implementation sets it and the next reviewer
  believes it means something.
- **`host.cwd`, `host.project_dir`, `host.env_facts` are client-asserted** and
  cannot be derived. `/proc/<pid>/cwd` is TOCTOU-prone and, on macOS,
  unreadable for a non-matching UID. Any decision whose deciding policy read
  one of these is recorded `sealed_unattested`. That is the honest version of
  "unforgeable" and is better than a claim that quietly is not true.
- `env_facts` is a **closed set** — currently `CLAUDE_PROJECT_DIR` only. The
  daemon rejects unknown keys rather than passing them through, so the hook
  client's environment (which originates in the agent's process, and therefore
  under the agent's control) cannot become an injection channel.
- `payload` is **already canonicalized by the client** for Stage 1: tool names
  and tool-input keys have been mapped, and the per-CLI payload normalizations
  applied. **The daemon trusts this at Stage 1 and does not re-derive it.**

  An earlier revision of this document claimed `fpai-canon` re-derived
  canonicalization and rejected a mismatch as `canonicalization_mismatch`. That
  was never true, and it is not implementable from this envelope: re-deriving
  requires the *raw* vendor payload, and only the canonicalized one is sent.
  Believing the claim would have been worse than not making it — it describes a
  check a reviewer would reasonably assume was catching a hostile or buggy
  client, and nothing was.

  What it costs today is bounded. The client runs as the user whose events
  these are, and every field it can distort is one it could equally distort
  before canonicalization; the fields that *would* be dangerous to accept —
  `home` above all — are the ones the daemon derives itself. So this is a
  missing defence-in-depth layer, not an open door. `canonicalization_mismatch`
  stays in the error enum because Stage 2 moves canonicalization fully
  daemon-side, which is where the check becomes both possible and meaningful.

- `enabled_policies` is the client's **resolved** enabled set, from its merged
  project/local/user configuration. The daemon evaluates *this*, never a set of
  its own.

  This is load-bearing and was learned the hard way. When the daemon supplied
  its own default list, a user with 30 policies enabled got the 11 builtin
  defaults — 19 builtins plus every custom and convention policy silently
  stopped enforcing the moment the daemon answered. It also made
  `needs_user_context` unreachable, because the sealed worker computes that list
  by partitioning the set it was handed, and a daemon-supplied set is
  all-sealed by construction.

  An empty list is a **protocol error**, not "evaluate nothing" and not "use
  the defaults". The first turns a client bug into a silent allow; the second
  reinstates the defect.

  It stays client-asserted, and in user scope that is not a compromise awaiting
  a fix: the daemon and the client are the same user, so a set resolved by the
  client carries exactly the authority a set resolved by the daemon would. The
  root-owned `machine.json` that would make it unforgeable belongs to the
  deferred `managed` scope, along with the reason anyone would want it.
- `deadline_ms` is the **remaining** end-to-end budget, not a per-hop timeout.
  The daemon converts it to a monotonic instant on receipt. If it cannot answer
  within it, it returns `deadline_exceeded` and the client falls back to legacy
  rather than the hook hanging.
- `shadow: true` means "evaluate sealed-only, do not run anything with side
  effects, the caller is discarding your answer". It exists because running
  both paths would execute `warn-repeated-tool-calls` twice (doubling its
  sidecar counter) and fire the five `require-*-before-stop` policies' `git`
  and `gh` subprocesses twice.

Success result:

```json
{
  "result": {
    "evaluated": {
      "decision_id": "dec-<hex>",
      "generation_id": "gen-<hex>",
      "exit_code": 0,
      "stdout": "{\"hookSpecificOutput\":{…}}",
      "stderr": "",
      "decision": "deny",
      "policy_name": "failproofai/block-sudo",
      "policy_names": null,
      "reason": "sudo commands are blocked",
      "attestation": "sealed",
      "matched_policies": ["failproofai/block-sudo"],
      "needs_user_context": []
    }
  }
}
```

`exit_code` / `stdout` / `stderr` / `decision` / `policy_name` / `policy_names`
/ `reason` are **byte-for-byte the fields `EvaluationResult` already has** in
`src/hooks/policy-evaluator.ts`. The client writes them out unchanged. That is
what makes byte-exact parity against the TypeScript oracle a meaningful
assertion rather than a shape check.

`attestation` is one of:

| Value | Meaning |
|---|---|
| `sealed` | every deciding policy ran in the sealed tier and read no client-asserted host field |
| `sealed_unattested` | ran sealed, but a deciding policy read `cwd`, `project_dir`, or an env fact |
| `user_context` | a `user-context` policy contributed to the decision |

`needs_user_context` lists policy names that matched but that the sealed worker
cannot run — the seven host-access builtins that spawn `git` or `gh`, and every
custom or convention policy. **Stage 1 evaluates sealed-only**, so a non-empty
list means the daemon could not answer the whole question.

A client seeing a non-empty list **must fall back to legacy**, and this is the
single most important client obligation in the document. Enforcing the subset
the daemon *could* evaluate would silently drop every policy it could not —
which is not a degraded answer, it is a wrong one, and it is exactly the
failure this product exists to prevent. The field was briefly unable to be
non-empty (the daemon partitioned a list it had supplied itself, which was
all-sealed by construction) and that made this obligation unreachable; it is
reachable now because the list comes from the client.

The field's meaning changed with the scope decision and is worth stating
precisely. It once meant "no per-user agent was attached", because a
service-account daemon could not reach a user's files and needed a second
resident process to do it. There is no per-user agent: the daemon runs as the
user and can spawn `git` itself. Running these policies in the daemon rather
than returning them is a later stage's work, not a missing process.

### Errors

```json
{ "request_id": "…", "result": { "error": { "code": "client_asserted_home", "message": "…" } } }
```

| `code` | Cause |
|---|---|
| `client_asserted_home` | `host.home` was non-null |
| `unknown_env_fact` | `host.env_facts` carried a key outside the closed set |
| `canonicalization_mismatch` | daemon-side canonicalization disagreed with the client's |
| `frame_too_large` | declared body length above 1 MiB |
| `malformed_frame` | short read, or a body that is not the expected JSON shape |
| `deadline_exceeded` | could not answer within `deadline_ms` |
| `unsupported_op` | a known-shaped op this build does not implement |
| `internal` | anything else; the daemon logs detail and returns a generic message |

**Every error is a client fallback to legacy, never a failed hook.** The
governing rule for the whole Stage-1 client is in
[01-stages.md](../desgin-docs/v1.0.0/phase-1-local-enforcement/implementation/01-stages.md):
`tryDaemonEvaluate` returns `null` on *any* failure, and the caller keeps
executing the same function it executes today.

## What the sealed tier claims

v1.0.0 ships **user scope only**: the daemon runs as the invoking user, its
state lives under `~/.failproofai/` and `~/.agenteye/`, and nothing is
installed with elevated privilege. That is a deliberate simplification for this
version, and it changes what the sealed tier is allowed to claim.

**It does not make a verdict unforgeable.** That argument required the daemon
to run as a UID the governed agent could not administer. Here they are the same
user, so an agent with its own authority can `ptrace` the daemon, preload into
it, replace its binary, edit `~/.failproofai`, or simply stop it. Any statement
that a verdict cannot be forged, or that the tier is tamper-resistant, is false
in this version and must not be made.

What the tier does buy is worth having and is not the same thing:

- **A warm resident evaluator** instead of a fresh interpreter per hook event.
- **No temp files next to the user's source.** The legacy loader writes
  `.__failproofai_tmp__.mjs` beside the policy on every tool call; measured at
  3.49 ms of added `config+load` per event.
- **A bounded deadline that is actually enforced** — a watchdog thread
  interrupts a runaway policy. Before it existed, a default-enabled policy's
  backtracking regex ran 30 s against a 200 ms budget.
- **Deny-by-default capabilities.** No `require`, no filesystem, no network in
  the sealed context. This contains a policy that is *buggy or over-reaching*.
  It does not contain an adversary who is already this user.

The distinction between "protects against mistakes" and "protects against an
adversary" is the whole of it, and collapsing the two is how a security claim
becomes marketing. The managed and system scopes that would restore the
integrity claim are designed and deliberately deferred.

## `install.json`

The client verifies the socket's owner before speaking to it. A missing or
unreadable file means the client falls back to legacy rather than proceeding
unverified.

| Source | Path |
|---|---|
| `$FAILPROOFAI_INSTALL_JSON` | wins over everything; used by tests |
| default | `~/.failproofai/install.json` |

It records what a particular `setup` run did on this machine, so it sits beside
the rest of that user's state rather than anywhere privileged. `service_uid` is
the UID the daemon runs as, which in user scope is the user's own.

**Node cannot read peer credentials of a Unix socket**, so the TypeScript
client compares `stat(socket).uid` against `service_uid` instead. Be precise
about what that is worth in this version: it catches a stray socket, a leftover
from another user on a shared machine, or a misconfigured path. It is not a
defence against the owning user, who can write both the socket and the file.
The daemon's own `SO_PEERCRED` check is the stronger of the two and is what
keeps *other* users out.

## Peer credentials

Mandatory, and read from the kernel — never from a field the caller supplies.

| Platform | Mechanism |
|---|---|
| Linux | `getsockopt(SOL_SOCKET, SO_PEERCRED)` → `struct ucred { pid, uid, gid }` |
| macOS | `getpeereid(2)` → `(uid, gid)` |

The UID is the authorization context for the request. `home` is resolved from
it with `getpwuid_r`; a miss is an `internal` error, never a fallback to a
default home.

**Both survive the move to user scope, for a narrower reason than before.** The
daemon serves exactly one user, so peer credentials are no longer a privilege
boundary — they are a "this connection is mine" check. That still matters on a
shared machine, where several users may each run their own daemon and a
misrouted or leftover socket path would otherwise let one user's events reach
another's evaluator. The daemon refuses any peer whose UID is not its own.

Deriving `home` rather than accepting it likewise stays, and is not merely
inertia. `isAgentInternalPath` and `block-read-outside-cwd` both *widen* the
allow set, so `home` is the one host field where a wrong value quietly relaxes
a verdict instead of tightening it. Deriving it costs one `getpwuid_r` and
removes a field that could be wrong, which is worth keeping even when the
client and the daemon are the same user — a bug in the client is now the threat
model, and a bug is exactly what this catches.

## Client-side kill switch

`FAILPROOFAI_DAEMON_MODE`:

| Value | Behaviour |
|---|---|
| unset, or `off` | **default.** The daemon path is dead code. `tryDaemonEvaluate` returns `null` before opening a socket. |
| `enforce` | return the daemon's answer; fall back to legacy on any failure |
| `shadow` | run legacy, then the daemon with `shadow: true`, return **legacy**, record the diff (Stage 2) |

Checked at the top of `tryDaemonEvaluate`, so an incident is resolved with an
environment variable rather than a release.
