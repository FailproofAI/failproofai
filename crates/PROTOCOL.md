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
{ "type": "ping", "protocolVersion": 1 }

// One hook evaluation request — one per `failproofai --hook <Event> --cli <cli>` invocation.
{
  "type": "hook",
  "protocolVersion": 1,
  "hookEvent": "PreToolUse",
  "cli": "claude",
  "stdin": "<raw stdin payload the calling agent CLI wrote to the one-shot failproofai process, forwarded verbatim>",
  "cwd": "/path/to/session/cwd" // optional; see the note below
}
```

`cwd` must be the *originating* CLI process's cwd, captured by the thin
client before dispatch — never the daemon's own cwd. The daemon is a single
long-lived process; its own `cwd` does not vary per request and must never be
used to resolve project config or custom policies (this is the "process.cwd()
hazard" the TS-side plan calls out explicitly).

### Daemon → client (`ServerMessage`)

```jsonc
{ "type": "pong", "protocolVersion": 1 }

{
  "type": "hookResult",
  "protocolVersion": 1,
  "exitCode": 0,
  "stdout": "...",
  "stderr": "..."
}

// The daemon accepted the connection and parsed the request, but could not
// produce a verdict (for example, the worker is down or hung). Distinct from
// hookResult so the client can
// tell "ran and decided" apart from "daemon couldn't evaluate at all" — the
// latter is what drives the client's fail-closed path.
{ "type": "error", "protocolVersion": 1, "message": "..." }
```

## Protocol versioning

`protocolVersion` is carried on every message in both directions. A mismatch
gets an explicit `error` response from the daemon. A daemon-configured client
fails closed on every missing or unusable verdict; it preserves the mismatch
category only to print the correct repair instructions. There is no protocol
negotiation: the CLI and daemon must agree exactly.

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
