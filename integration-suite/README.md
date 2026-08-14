# integration-suite/

## What this is

The CLI product's cross-vendor canary — a Docker harness, not shipped code. It installs all 12
supported agent CLIs at the versions users get today, drives each one against failproofai's own
policies built from this repo's HEAD (`canary-policies.mjs`), and asserts the hook log shows a
**deny**. The probes are benign markers (`echo`-ing a `CANARY_PROBE` token, reading a plain file)
precisely because a model never refuses them, so a missing deny means enforcement broke — a vendor
changed their hook schema or payload keys out from under us — rather than the model self-censoring.

## Who consumes it

`.github/workflows/integration-suite.yml`, a thin trigger that runs on `schedule` (06:17 UTC) and
`workflow_dispatch` only — never `pull_request`, so fork PRs can never reach the credentials. The
front door is `ci-entrypoint.sh`; everything but the Actions cache restore/save lives there, and it
is runnable by hand (`CANARY_LLM_API_KEY=... CANARY_SKIP_BUILD=1 bash integration-suite/ci-entrypoint.sh`).
It calls `install-clis.sh`, `inject-tokens.sh`, then `run.sh` → `probe-cli.sh` → `report.js` → Slack.
Nothing in `src/`, `crates/`, or `app/` imports any of it.

| Piece | Role |
|-------|------|
| `Dockerfile` / `install-clis.sh` | non-root sandbox; installs the CLIs for `$CANARY_CHANNEL` with retries |
| `inject-tokens.sh` / `capture-tokens.sh` | write, and (on a logged-in machine) refresh, the OAuth creds for cursor, devin, antigravity |
| `probe-cli.sh` / `canary-policies.mjs` | the oracle: one live enforcement probe per CLI |
| `run.sh` / `report.js` | version-gate, then diff against `integration-suite-state.json` and POST broke/recovered to Slack |

Two matrix legs. `stable` is the contract test and a FAIL fails the job. `beta` installs each
vendor's public pre-release ref for the six CLIs that publish one (codex `alpha`, copilot
`prerelease`, openclaw `beta`, cursor `channel=lab`, goose `CANARY=true`, claude `latest`) and is
advisory — `run.sh` exits 0 regardless. **claude is inverted**: `latest` *is* the bleeding edge, so
the stable leg pins `bash -s stable` (~13 d behind) and `latest` becomes the early warning. **hermes
is inverted with no fix** — its installer clones `main`, which is what every hermes user already gets.
Escalate on `stable green + beta not-green` held two consecutive runs, and expect
`INCONCLUSIVE`/`ERROR` rather than `FAIL`, since a payload change stops the model before it calls a
tool. Each leg gets its own Docker volume and cache key so a pre-release install cannot overwrite the
stable binary or its gating record.

Gotchas: a CLI is re-probed only when its binary version or failproofai's HEAD changed since its last
green run (dispatch with **force** to override); the secrets live in a GitHub Environment still named
`cli-integration`, configured in repo settings, so renaming it there means editing `environment:` in
the workflow in the same change; env-var names keep the historical `CANARY_` prefix on purpose; and
the injected OAuth tokens eventually expire, surfacing as `ERROR` for that CLI until re-captured.

## Does it ship

No. `integration-suite/` is absent from package.json's `files` array, so it never reaches an npm
user — it exists only in the git tree and on CI runners. Moving or renaming it breaks nothing for an
installed user, but it would break the workflow's `bash integration-suite/ci-entrypoint.sh` path and
the tests below, and it does **not** rename the `cli-integration` GitHub Environment.

## Where its tests live

`__tests__/integration-suite/` — `channel-refs.test.ts`, `verdict-ordering.test.ts`, `is-error.test.ts`
guard the harness's own logic (they read these shell files; they do not run Docker). Run them with
`bun run test:run`. The suite itself has no test entry — it *is* the test, and only CI runs it.
