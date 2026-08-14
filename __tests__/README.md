# `__tests__/`

The Vitest suite for every product in this repo except the Rust daemon: the CLI (`__tests__/hooks/`,
`__tests__/audit/`, `__tests__/scripts/`), the Next.js dashboard (`__tests__/app`-facing dirs
`actions/`, `api/`, `components/`, `contexts/`), and the shared `lib/`. 194 unit files and 16 e2e
files. The daemon's own tests live in Rust, under `crates/*/tests/`.

## What this is

Two suites with two configs. `vitest.config.mts` runs the unit half — jsdom, `__tests__/setup.ts`
loaded, everything except `__tests__/e2e/**`. `vitest.config.e2e.mts` runs `__tests__/e2e/**/*.e2e.test.ts`
in a node environment with `pool: "forks"` (the tests spawn real subprocesses) and a 20s timeout, and
it does **not** load `setup.ts`. That matters: `setup.ts` installs a fetch guard that fails any unit
test reaching a non-loopback host, naming the host so the missing stub is findable. E2E is exempt
because it is supposed to talk to real things.

## Who consumes it

CI only — `.github/workflows/ci.yml` runs the `test` job (`bun run test:run`, three env configs) and
the `test-e2e` job (`bun run test:e2e`). Nothing imports these files at runtime.

## Does it ship

No. `__tests__/` is absent from package.json's `files` array, so it never reaches an installed user.

## Where its tests live

| Suite | Command |
|---|---|
| unit (`__tests__/**`, minus e2e) | `bun run test:run` |
| e2e (`__tests__/e2e/**/*.e2e.test.ts`) | `bun run test:e2e` |
| daemon (`crates/*/tests/`) | `cargo test --workspace` |

Gotchas. `__tests__/hooks/` is 83 files and many are named after the **bug** they pin, not the module
they cover — `daemon-probe-race`, `fail-closed-force-decision`, `cloud-artifact-collision`,
`claude-prune-malformed-settings`. Grep for the behaviour, not the filename, or you will write a
second copy of a test that already exists. Four files are tripwires for hand-maintained artifacts that
nothing generates and whose drift is otherwise silent: `hooks/dogfood-configs.test.ts` (this repo's own
`.claude/`, `.codex/`, `.factory/`… configs), `network-guard.test.ts` (tests the `setup.ts` guard
itself), `dashboard-lockdown.test.ts` (the unauthenticated local dashboard's loopback/Origin checks,
written as real exploits), and `ci/release-pipeline.test.ts` + `ci/daemon-packages.test.ts` (publish
ordering and the four `@failproofai/failproofaid-<os>-<arch>` pins).
