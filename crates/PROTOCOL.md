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

A Unix domain stream socket at `$FAILPROOFAI_DAEMON_SOCKET`, or
`/run/failproofai/failproofaid.sock` by default.

No TCP, including loopback. The parent directory is owned by the service
account or root so no enrolled user can unlink the socket and bind a
substitute.

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
  overwritten. This is not pedantry: `isAgentInternalPath` and
  `block-read-outside-cwd` both *widen* the allow set, so a client asserting
  `home: "/"` would make every path "agent internal" and relax a sealed
  verdict. Silently overwriting would make the attack a no-op but leave the
  protocol looking like it accepts the field; rejecting makes a client that
  tries it fail loudly and visibly.
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
  applied. `fpai-canon` re-derives and asserts equality rather than trusting
  this; a mismatch is a `canonicalization_mismatch` protocol error. Stage 2
  moves canonicalization fully daemon-side.
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

`needs_user_context` lists policy names that matched but could not be evaluated
because no per-user agent was attached. **Stage 1 always returns it empty** and
the daemon evaluates sealed-only; the one-shot continuation path lands at
Stage 4. Until then a client seeing a non-empty list must fall back to legacy,
because otherwise upgrading would silently drop enforcement for a user's
mutable policies — precisely the failure this product exists to prevent.

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

## `install.json`

The client verifies the socket's owner before speaking to it. `service_uid` is
read from a root-owned `install.json`, and a missing or unreadable file means
the client falls back to legacy rather than proceeding unverified.

| Source | Path |
|---|---|
| `$FAILPROOFAI_INSTALL_JSON` | wins over everything; used by tests and non-standard installs |
| Linux | `/var/lib/failproofai/install.json` |
| macOS | `/Library/Application Support/failproofai/install.json` |

It lives with **mutable machine state**, not with the executables under
`/opt/failproofai/`, because the two have different writers: `/opt` is written
once per release, while `install.json` records what a particular `setup` run
did on this machine. `07-release-and-packaging.md` places it under `/opt`; that
document predates the ownership split in
[03-daemon-architecture.md](../desgin-docs/v1.0.0/phase-1-local-enforcement/03-daemon-architecture.md#configuration-and-state)
and is the one that needs amending. Either way the file is root-owned and
read-only to the service account — a `service_uid` an enrolled user could
rewrite would defeat the check entirely.

**Node cannot read peer credentials of a Unix socket**, so the TypeScript
client compares `stat(socket).uid` against `service_uid` instead. That is
strictly weaker than `SO_PEERCRED` and is honest about what it defends: a stray
or impostor socket, not a local attacker who already has root. The daemon's own
side of the check — which is the one that matters — uses real peer credentials.

## Peer credentials

Mandatory, and read from the kernel — never from a field the caller supplies.

| Platform | Mechanism |
|---|---|
| Linux | `getsockopt(SOL_SOCKET, SO_PEERCRED)` → `struct ucred { pid, uid, gid }` |
| macOS | `getpeereid(2)` → `(uid, gid)` |

The UID is the authorization context for the request and the key for per-UID
policy, quota, and (later) spool state. `home` is resolved from it with
`getpwuid_r`. A `getpwuid_r` miss is an `internal` error, not a fallback to a
default home.

## Client-side kill switch

`FAILPROOFAI_DAEMON_MODE`:

| Value | Behaviour |
|---|---|
| unset, or `off` | **default.** The daemon path is dead code. `tryDaemonEvaluate` returns `null` before opening a socket. |
| `enforce` | return the daemon's answer; fall back to legacy on any failure |
| `shadow` | run legacy, then the daemon with `shadow: true`, return **legacy**, record the diff (Stage 2) |

Checked at the top of `tryDaemonEvaluate`, so an incident is resolved with an
environment variable rather than a release.
