# Integration suite

A daily **live-enforcement integration test** for failproofai. It answers one
question the unit/e2e suites can't: *does failproofai still enforce against every
supported agent CLI, at the versions users actually install today?*

Every day (`.github/workflows/integration-suite.yml`) it installs all 12 agent
CLIs **@latest** into an isolated Docker sandbox, drives each one against
failproofai's own policies (built from this repo's HEAD), and confirms the hook
log shows a **DENY**. A *silent-allow* — a blocked action that ran with no deny —
means enforcement broke against that CLI (e.g. a vendor changed their hook schema
out from under us). The test asserts the deny **positively**, so drift surfaces
as a red run + a Slack alert instead of going unnoticed until a user hits it.

## Why it's separate from `__tests__/`

It drives **real vendor CLIs against real gateway models** — it needs network,
Docker, credentials, and ~7-10 min, none of which belong in the fast in-process
vitest suites. So it's a scheduled workflow, not a PR gate.

## How a run works

The workflow is a thin trigger; `ci-entrypoint.sh` is the front door and does
everything below except the Actions cache restore/save.

1. Restore `integration-suite-state.json` from Actions cache (version-gate +
   broke/recovered diff) — *workflow*.
2. Build failproofai under test (`dist/index.js` + `dist/cli.mjs`) from this repo.
3. Decode the OAuth token secrets, build the sandbox image, create the per-run
   HOME volume, install all 12 CLIs (`install-clis.sh`), inject the credential
   files (`inject-tokens.sh`), assemble the gateway env-file.
4. `run.sh` probes each non-gated CLI (`probe-cli.sh`), builds the report
   (`report.js`), and POSTs it to Slack.
5. Cleanup (env-file + volume) runs via `trap`, so it happens on failure too.

Run it locally the same way CI does — every input is an env var:

```bash
CANARY_LLM_API_KEY=... CANARY_SKIP_BUILD=1 \
  bash integration-suite/ci-entrypoint.sh
```

**Version-gate:** a CLI is re-probed only when its binary version **or**
failproofai's HEAD changed since its last green run — unchanged ⇒ can't have
drifted ⇒ skip, protecting LLM/vendor quota. `FAIL`/`INCONCLUSIVE`/`ERROR` always
re-probe until they recover. Dispatch with **force** to probe everything.

## Auth & secrets (the `cli-integration` Environment)

> The GitHub **Environment** is still named `cli-integration` — it's configured in
> repo settings, not in this tree, so it was deliberately left alone when this
> directory was renamed. Renaming it there means renaming `environment:` in the
> workflow at the same time, or the job loses access to every secret.

Because this repo is public, all credentials live in a scoped **GitHub
Environment** (`cli-integration`) — only this workflow's job can read them — and
the workflow triggers on `schedule`/`workflow_dispatch` **only**, so fork PRs can
never reach them.

| Auth | CLIs | Secret(s) |
|------|------|-----------|
| Env-var (gateway) | claude, codex, goose, opencode, pi, hermes, openclaw, factory | `CANARY_LLM_API_KEY`, `CANARY_LLM_BASE_URL` |
| Env-var (PAT) | copilot | `COPILOT_GITHUB_TOKEN` |
| Injected token file | cursor, devin, antigravity | `CURSOR_/DEVIN_/ANTIGRAVITY_TOKEN_TGZ_B64` |
| Delivery | — | `SLACK_WEBHOOK_URL` |

The injected-token CLIs carry OAuth session tokens captured from a logged-in
machine (see `capture-tokens.sh`). They authenticate on a fresh runner, but may
eventually expire — when that happens the test reports `⚠️ ERROR` for that CLI;
re-login on the capture machine and refresh the secret.

> Note: env-var / secret names keep the historical `CANARY_` prefix internally —
> renaming them across the harness would be churn with no user-visible benefit.

## Files

```
ci-entrypoint.sh      CI front door: build -> sandbox -> install -> probe -> cleanup
Dockerfile            non-root sandbox base image
install-clis.sh       install/upgrade all 12 CLIs @latest (with retries)
inject-tokens.sh      write captured OAuth creds into the fresh volume
probe-cli.sh          live enforcement probe for ONE CLI (the oracle)
canary-policies.mjs   benign-marker custom policies the probe trips
run.sh                orchestrator (gate → probe → report → Slack)
report.js             build the Slack report + diff state (broke/recovered)
capture-tokens.sh     (run on a logged-in machine) refresh the OAuth token secrets
```
