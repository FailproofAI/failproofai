# failproofaid wire protocol

The contract between the `failproofai` CLI (thin client) and the `failproofaid`
daemon over a Unix domain socket. This is the same contract every hook
invocation already has today — see `src/hooks/handler.ts`'s
`handleHookEvent`: `(argv --hook <Event> --cli <cli>, stdin JSON payload) ->
(stdout, stderr, exitCode)`. The daemon adds nothing to that contract; it only
relays it over a socket instead of a fresh process's argv/stdin/stdout.

Implemented in `crates/fpai-ipc` (framing + envelope + peer verification) and
`crates/failproofaid` (the socket server and worker supervisor). The daemon
answers `ping` directly and relays `hook` requests to its warm Node/Bun worker.

## Transport

One Unix domain socket, one connection per request. The daemon reads exactly
one frame, dispatches it, writes exactly one frame back, and lets the
connection close — there is no request-ID multiplexing because there is never
more than one logical request in flight per connection.

Default path: `~/.failproofai/run/failproofaid.sock`. Overridable via the
`FAILPROOFAI_DAEMON_SOCKET` env var (used by local dev and tests — never point
this at a directory failproofaid doesn't own itself; see
`crates/failproofaid/src/paths.rs`'s `ensure_run_dir`, which refuses to modify
permissions on a pre-existing directory it didn't create).

Permissions: the run directory is `0700` and the socket file `0600`. Although
the service definition is installed system-wide, the daemon process runs as
the configured OS user. `crates/fpai-ipc/src/peer.rs`'s `SO_PEERCRED` (Linux) /
`getpeereid` (macOS) check is defense-in-depth on top of that, not a stronger
boundary — same-user access can always reach this daemon regardless.

## Framing

Every message, in both directions, is:

```
+----------------------------+------------------------------+
| length (4 bytes, big-endian u32) | UTF-8 JSON body (length bytes) |
+----------------------------+------------------------------+
```

A declared length over `MAX_FRAME_LEN` (16 MiB) is rejected without
allocating a body buffer for it — a hook payload is at most 1 MiB (see
`handler.ts`'s own stdin cap), so 16 MiB is headroom, not an expected size.

## Envelope

Tagged JSON, `"type"` as the discriminant, camelCase field names.

### Client → daemon (`ClientMessage`)

```jsonc
// Liveness/handshake check.
{ "type": "ping", "protocolVersion": 2 }

// One hook evaluation request — one per `failproofai --hook <Event> --cli <cli>` invocation.
{
  "type": "hook",
  "protocolVersion": 2,
  "hookEvent": "PreToolUse",
  "cli": "claude",
  "stdin": "<raw stdin payload the calling agent CLI wrote to the one-shot failproofai process, forwarded verbatim>",
  "cwd": "/path/to/session/cwd", // optional; see the note below
  "agentSettingsPath": "/path/to/the/agent/settings" // optional; empty means unresolved
}
```

`cwd` must be the *originating* CLI process's cwd, captured by the thin
client before dispatch — never the daemon's own cwd. The daemon is a single
long-lived process; its own `cwd` does not vary per request and must never be
used to resolve project config or custom policies (this is the "process.cwd()
hazard" the TS-side plan calls out explicitly).

Protocol v2 carries the originating agent's settings path for both `hook` and
native `policyEvaluation` requests. A missing path is unresolved, never
inferred from the long-lived daemon's environment. A v1 daemon cannot be
trusted with a v2 scoped request: it may discard this field and evaluate for
the wrong profile. So a v2 client never uses a v1 daemon's answer to a v2
request; it asks again in v1, without the field (see "Protocol versioning"),
except where the machine's Cloud deployment targets policies at agents, which
an unnamed agent would escape: there it fails closed.

### Daemon → client (`ServerMessage`)

```jsonc
{ "type": "pong", "protocolVersion": 2 }

{
  "type": "hookResult",
  "protocolVersion": 2,
  "exitCode": 0,
  "stdout": "...",
  "stderr": "..."
}

// The daemon accepted the connection and parsed the request, but could not
// produce a verdict (for example, the worker is down or hung). Distinct from
// hookResult so the client can
// tell "ran and decided" apart from "daemon couldn't evaluate at all" — the
// latter is what drives the client's fail-closed path.
{ "type": "error", "protocolVersion": 2, "message": "..." }
```

## Protocol versioning

`protocolVersion` is carried on every message in both directions. The daemon
answers every version from `MIN_PROTOCOL_VERSION` (1) to `PROTOCOL_VERSION` (2)
and stamps its reply with the version the client sent. A request older than the
field it carries is read without it: a v1 request's `agentSettingsPath` is
dropped, so its profile is unknown, never trusted.

A client that gets a reply stamped with an older version still inside that range
asks once more in that version, without the fields that version predates. The
answer to the original request is never used. Anything outside the range gets an
explicit `error`, and a daemon-configured client fails closed on it.

Neither fallback runs where the active Cloud deployment targets policies at
agents (`active.json` schema 3), or cannot be read: an older request names no
agent, and a targeted policy does not apply to an unknown one. There the daemon
refuses a v1 request (stamped v1, so the old client's own fail-closed path
blocks it) and a current client does not re-ask an older daemon.

This exists because a long-lived host (a Hermes or OpenClaw gateway) keeps the
plugin it loaded at start: after an upgrade it speaks the previous version until
it restarts, and refusing it denied every call it made. Versions only add
optional fields; raise `MIN_PROTOCOL_VERSION` only when an older request can no
longer be answered safely.

## Peer verification

Every connection is checked with `SO_PEERCRED`/`getpeereid` before a single
byte of the request is read. A peer running as a different OS user gets the
connection dropped with **no response at all** — not even an `error` frame —
so a connection from the wrong user can't even confirm a daemon is listening
there.

## Malformed input handling

- A frame whose declared length exceeds `MAX_FRAME_LEN`: connection closed,
  no response, no allocation attempted for the declared size.
- A syntactically invalid or truncated frame: connection closed, no response.
- A well-formed frame with an unrecognized `"type"`: fails to deserialize,
  same as above.

None of these crash the daemon or the connection-handling thread — a bad
frame from one connection has no effect on any other connection.

## Machine logs (HTTP, not this socket)

Not part of the socket protocol: the daemon's cloud maintenance lane sends its
own log to FailproofAI Cloud, only when something is wrong
(`crates/failproofaid/src/logship.rs`). `POST /enforcement/v1/machine-logs`,
bearer = the machine key, body ≤ 256 KiB:

```json
{ "machineId": "…", "daemonVersion": "1.0.16-beta.0",
  "kind": "errors | incident | requested",
  "trigger": "incident only, ≤ 200 chars", "requestId": "requested only",
  "entries": [{ "ts": "…", "level": "ERROR|WARN|INFO|DEBUG", "target": "…",
                "message": "≤ 2 KiB", "count": 1, "lastTs": "errors only" }] }
```

- `errors`: distinct warnings/errors (digits folded), counted; ≤ every 5 min, only when there is one.
- `incident`: the last 5 min of INFO-and-up lines around an ERROR, or the previous run's log tail when it ended without a clean shutdown (`logs/daemon.running` still present at start); ≤ 1 per 15 min (stamped in `logs/.incident-sent`, so a crash loop does not resend), ≤ 10 per day.
- `requested`: the `daemon.log` tail, answering `logRequest: {id}` on the desired-state response.
- One body per poll. `2xx` stored; `404` → no uploads for 24 h; `429` → wait `Retry-After`; other `4xx` → dropped; network/`5xx` → kept for the next poll.
- Home directory → `~`, machine token → `[redacted]`. `FAILPROOFAI_NO_LOG_UPLOAD=1` turns uploads off.
