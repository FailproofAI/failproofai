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

## Two channels: `stable` and `beta`

The workflow runs as a **matrix over `CANARY_CHANNEL`**, in two concurrent legs
answering different questions:

| Leg | Installs | Question | On failure |
|-----|----------|----------|------------|
| `stable` | what users get, all 12 CLIs | *is enforcement broken now?* | **fails the job** + Slack |
| `beta` | each vendor's public pre-release ref, 6 CLIs | *is it about to break?* | **advisory only** — never fails |

Only six vendors publish something usable ahead of their release, so the beta leg
skips the rest rather than re-installing a stable build and reporting it as
pre-release coverage:

| CLI | Pre-release ref | Typical lead |
|-----|-----------------|--------------|
| codex | npm `alpha` | up to ~12 d (minor bumps only — patches ship blind) |
| copilot | npm `prerelease` | 0.6–5.8 d |
| openclaw | npm `beta` | 0.3–11.4 d |
| cursor | `install?channel=lab` | 2–4 d |
| goose | `CANARY=true` (rolling tag) | ~1 release cycle |
| claude | `latest` — **inverted**, see below | ~13 d |

**claude runs backwards.** Nothing ships ahead of `latest`, which *is* the
bleeding edge (~1 release/day); what exists is `stable`, ~13 days behind. So the
stable leg pins `bash -s stable` — testing what conservative users run, and
stopping a same-day Anthropic release from red-lighting an unrelated PR — and
`latest` becomes the early-warning ref. **hermes** is inverted too but has no fix:
its installer git-clones `main`, which is also what every hermes user gets, so
there is nothing ahead of us to probe.

**Escalation is a cross-leg comparison, not a beta failure.** A CLI red on both
legs is already broken and belongs to the stable leg's alarm. The early warning is
`stable green + beta not-green`, held for **two consecutive runs** so a broken
alpha that gets reverted before release doesn't burn attention. Note the signal is
usually `INCONCLUSIVE`/`ERROR`, not `FAIL` — a vendor payload change stops the
model before it ever calls a tool — so a FAIL-only rule would miss it entirely.

Each leg has its own Docker volume and Actions cache key: a pre-release install
overwrites the stable binary in a shared `$HOME`, and a beta result must never be
able to overwrite the stable leg's gating record.

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
install-clis.sh       install/upgrade the CLIs for $CANARY_CHANNEL (with retries)
inject-tokens.sh      write captured OAuth creds into the fresh volume
probe-cli.sh          live enforcement probe for ONE CLI (the oracle)
canary-policies.mjs   benign-marker custom policies the probe trips
run.sh                orchestrator (gate → probe → report → Slack)
report.js             build the Slack report + diff state (broke/recovered)
capture-tokens.sh     (run on a logged-in machine) refresh the OAuth token secrets
```
