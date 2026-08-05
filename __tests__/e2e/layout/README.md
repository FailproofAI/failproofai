# Layout-2 end-to-end harnesses

Three shell harnesses that exercise the real thing rather than a mock. They are
not run by `bun run test:e2e` — each needs infrastructure the unit suite must
not depend on — so they are invoked deliberately.

| Script | Needs | Covers |
|---|---|---|
| `layout-reset.sh` | nothing | fresh/stale/future layout detection, reset semantics, OSS silence, hook warn-don't-delete-don't-deny |
| `cloud-collector.sh` | an AgentEye stack | real connect against a live server, daemon + collector writing layout-2 paths, decisions reaching ClickHouse, disconnect back to OSS |
| `systemd-service.sh` | Docker | REAL `systemctl enable --now` as root in a privileged container: service lifecycle, fail-closed, self-heal, reinstall |

`systemd-service.sh` exists because the service half cannot be tested on a
developer machine without a password prompt, and a container gives real systemd
and real root with neither.

Two things it caught that a mock could not:

- `Environment=` in a systemd unit **splits on whitespace unless quoted**. The
  product quotes it (`daemon-service.ts`); a hand-written unit in the harness
  did not, the worker never started, and every request silently fell through to
  the fail-closed path.
- The fail-closed denial and a real policy denial both contain
  `permissionDecision":"deny"`, so a check for that string passes when the
  daemon is completely unreachable. Assertions here match on the policy's own
  reason text instead.

## Running

```sh
bash __tests__/e2e/layout/layout-reset.sh
bash __tests__/e2e/layout/systemd-service.sh

# cloud-collector.sh expects the stack on the remapped ports (18080/18123) so it
# can run alongside an existing project rather than displacing it:
docker compose -p aefpai -f docker-compose.yml -f ports.yml up -d
bash __tests__/e2e/layout/cloud-collector.sh

# cloud-pairing.sh expects the stack on its STANDARD ports (8080/8123) and five
# API keys minted in the local database — see the header of the script.
bash __tests__/e2e/layout/cloud-pairing.sh
```

## cloud-pairing.sh

Pairs a machine with a live AgentEye deployment and walks the whole chain in one
pass: `/v1/auth/introspect` on five keys with different permission sets, the
enrolment each one is and is not allowed to write, publishing and deploying a
cloud-managed policy, the daemon pulling and hash-verifying it, that policy
denying a real hook call, the same policy redeployed as `observe` allowing the
same call while recording the verdict it discarded, and both records arriving in
ClickHouse.

It is the regression test for four daemon bugs that each looked like a working
system from one side: the daemon and the CLI binding different sockets under
`FAILPROOFAI_HOME` (a healthy daemon denying every call), pulled policies landing
in layout 1's `policies/cloud-managed` where the CLI never reads, and the daemon
looking for the enrolment in `cloud.json` after layout 2 moved it into
`credentials.toml`.
