# Evaluator v2 contract fixtures

`contract.json` is the Checkpoint 0 wire contract shared by the Rust server and
the zero-dependency Python SDK. The matching copy lives at
`server/tests/fixtures/evaluator_v2/contract.json` in the `agenteye` repository.
Change both copies together.

Contract rules:

- The only accepted protocol major is the exact string `"2"`. Unsupported
  majors return `426 unsupported_protocol_version`.
- Unknown JSON fields are ignored so either side may add optional fields within
  major version 2. Removing, renaming, or changing the meaning of a field needs
  a new major version.
- Worker payloads never carry authoritative tenant or evaluator-instance
  identity. The server derives those from the credential and leased record.
- `lease_generation` is the fencing token. `409 lease_lost` is terminal for the
  affected local execution; the SDK must stop heartbeating or submitting it.
- `submission_id` is an idempotency key. Replaying identical content succeeds;
  reusing it for different content returns `409 submission_conflict`.
- Transcript overflow is terminal in v2 (`413 transcript_too_large`); the server
  never silently truncates the evaluated input.
- Only errors marked `retryable` may be retried automatically. HTTP method alone
  is not enough to decide whether a protocol operation is safe to replay.

The timing and payload limits in the fixture are normative defaults. A register
response may lower the worker's effective concurrency, heartbeat interval, or
lease duration, but may not raise a client-side payload bound.
