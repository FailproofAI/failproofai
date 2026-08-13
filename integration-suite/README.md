# Integration suite

A daily **live-enforcement integration test** for failproofai. It answers one
question the unit/e2e suites can't: *does failproofai still enforce against every
supported agent CLI, at the versions users actually install today?*

Every day (a cron-driven container on the canary box — see **Local runner**
below; `.github/workflows/integration-suite.yml` is the on-demand cloud
fallback) it
installs all 12 agent CLIs **@latest** into an isolated Docker sandbox, drives
each one against failproofai's own policies (built from the ref under test), and
confirms the hook log shows a **DENY**. A *silent-allow* — a blocked action that
ran with no deny — means enforcement broke against that CLI (e.g. a vendor
changed their hook schema out from under us). The test asserts the deny
**positively**, so drift surfaces as a red run + a Slack alert instead of going
unnoticed until a user hits it.

On the box, the stable leg also runs **daemon-configured** (`CANARY_DAEMON=1`):
hooks route CLI → `failproofaid` (Rust supervisor) → warm bun worker, fail-closed
— the configuration `failproofai config` gives users — so the canary tests the
transport users actually run, not just the in-process path. See the
`CANARY_DAEMON` block in `probe-cli.sh` for the mechanics (per-probe daemon
restarts, the `daemon.configured` marker, and why a dead daemon scores
INCONCLUSIVE rather than a false PASS).

## Why it's separate from `__tests__/`

It drives **real vendor CLIs against real gateway models** — it needs network,
Docker, credentials, and ~7-10 min, none of which belong in the fast in-process
vitest suites. So it's a scheduled run, not a PR gate.

## Local runner (the box)

Scheduled runs live on a **local box**, not GH Actions — runner minutes were
the entire cost of the old crons; the LLM spend is identical either way. The
box needs exactly **Docker + cron + one env file**; there is no host toolchain,
no installed scripts, no systemd. Everything else happens inside a
self-contained runner image that drives the host's Docker through the mounted
socket (sibling containers — the sandbox image, volumes and probe containers
are the exact ones CI runs).

**Two jobs share the box**, one image and one env file between them:

| `CANARY_JOB` | What it is | Default | First run | Steady state |
|---|---|---|---|---|
| `canary` | this integration suite | 11:00 local | ~1h (empty version gate) | minutes |
| `translate` | the nightly doc translation, replacing `translate-docs.yml`'s cron | 02:00 local | ~2h (empty cache) | minutes, often nothing |

They hold **separate locks** and are scheduled far apart, so neither can
swallow the other — a canary wedged on a vendor CLI must not silently cost a
night of translation, and a skipped run's `exit 0` reports nowhere.

Box setup is **one command**. Whoever holds the credentials fills in a
`secrets.env` and sends it; the person with the machine runs:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/FailproofAI/failproofai/main/integration-suite/local/install.sh) ~/secrets.env
```

That builds the runner image straight from the git URL (no clone on the box),
creates `~/fp-canary`, installs the env file at mode 600, and writes **one cron
line per job**. It is idempotent — re-running upgrades the image and *rewrites*
those lines rather than adding a second set, and each line carries its own
marker so installing one job never strips the other's.

Flags: `--jobs canary,translate` picks which to install (default both),
`--now <job>` runs one immediately in the foreground, `--dry-run` prints what it
would do, and `--at-canary "M H"` / `--at-translate "M H"` pick the hours. Cron
fires in the **host's** timezone; the installer prints which one it resolved.

**The installer exists because most of the manual steps fail silently for a
day.** A work dir mounted at a different path inside than out, a ref left at a
merged branch, and a filled-in env file with no Slack webhook all produce a job
that runs and reports nothing — which looks exactly like coverage. Each is
refused at install time, in front of a person, and the credential check is **per
job**, so installing only the canary never asks for a translation PAT. The
webhook is required for that reason and not because the runs need it.

<details>
<summary>The same thing by hand, if you would rather see every step</summary>

```bash
# 1. one-time: build the runner image (from a clone, or straight from GitHub)
docker build -t failproofai-canary-runner \
  -f integration-suite/local/Dockerfile.runner integration-suite/local/

# 2. one-time: work dir + secrets
mkdir -p ~/fp-canary
cp integration-suite/local/secrets.env.example ~/fp-canary/secrets.env
chmod 600 ~/fp-canary/secrets.env    # then fill it in

# 3. cron, one line per job (overlapping fires of the SAME job share a lock
#    and no-op; different jobs have different locks and may overlap)
0 11 * * * docker run --rm -e CANARY_JOB=canary    -v /var/run/docker.sock:/var/run/docker.sock -v "$HOME/fp-canary:$HOME/fp-canary" --env-file "$HOME/fp-canary/secrets.env" failproofai-canary-runner >/dev/null 2>&1
0  2 * * * docker run --rm -e CANARY_JOB=translate -v /var/run/docker.sock:/var/run/docker.sock -v "$HOME/fp-canary:$HOME/fp-canary" --env-file "$HOME/fp-canary/secrets.env" failproofai-canary-runner >/dev/null 2>&1
```

</details>

The work dir is mounted at an **identical path** inside and out — that is
load-bearing, not style: paths under it are used both for in-container file
ops and as sibling-container `-v` sources, which the host daemon resolves
against the host filesystem. The entrypoint auto-detects it (and says exactly
what to mount if it can't).

At each run the image's baked entrypoint (`runner-entrypoint.sh` — thin on
purpose) locks *that job*, clones/fetches `<JOB>_REF` into
`~/fp-canary/clone-<job>`, and hands off to `jobs/<job>.sh` **from that
checkout** — so harness changes, and whole new jobs, reach the box through git,
and the image only needs a rebuild when the entrypoint itself changes. The
canary job runs the stable leg (daemon-configured) then the beta leg
(in-process), exactly like the old GHA matrix; the translate job runs the whole
14-language corpus in one process and opens or updates the auto-translation PR.

Everything lands under the work dir: version-gate state in `state/` (instead
of the Actions cache — the gate logic is unchanged), the translation cache in
`translate/` (a 13 KB file, symlinked into the checkout), per-job logs in
`logs/` (pruned after 14 days), the per-job clones, and the daemon build's
cargo cache.
All of it except `secrets.env` is written by the container **as root**, so
reading a log or clearing the clone from the host needs `sudo`. Harmless — the
next run is root too — but it is the first thing that surprises anyone poking
at the box by hand.
Verdict reports POST to Slack exactly as before; a leg that dies *before*
reporting gets a distinct crash-note with the log tail (that's the replacement
for GHA's red-job email — cron's own output can go to `/dev/null`). The
translate job reports the same way, **including on nights it changes nothing**,
so silence means the box did not run rather than that all was well. Token
tarballs still come from `capture-tokens.sh` on a logged-in machine.

One thing to know before touching the translation cache: on Actions it was
being evicted between runs, and that eviction was accidentally load-bearing. A
"translated once" entry whose output only exists on an unmerged PR branch makes
`--update-nav` emit nav entries for files that are not there and `mintlify
validate` fail, while the cache hit means nothing is regenerated — non-convergent
until an eviction forced a full miss. Nothing evicts the box's cache, so the
`existsSync` guard in `cli.ts` / `mdx-translator.ts` / `readme-translator.ts` is
now the only thing keeping the job convergent.

## How a run works

The trigger (box: `local/jobs/canary.sh`; cloud: the workflow) is thin;
`ci-entrypoint.sh` is the front door and does everything below except state
restore/save.

1. Point `CANARY_STATE` at `integration-suite-state.json` (version-gate +
   broke/recovered diff) — box state dir, or Actions cache on a dispatch.
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
the workflow triggers on `workflow_dispatch` **only**, so fork PRs can never
reach them. (The box keeps its own copy of the same variables in `~/fp-canary/secrets.env`,
chmod 600 — updating one does not update the other.)

| Auth | CLIs | Secret(s) |
|------|------|-----------|
| Env-var (gateway) | claude, codex, goose, opencode, pi, hermes, openclaw, factory | `CANARY_LLM_API_KEY`, `CANARY_LLM_BASE_URL` |
| Env-var (PAT) | copilot | `COPILOT_GITHUB_TOKEN` |
| Injected token file | cursor, devin, antigravity | `CURSOR_/DEVIN_/ANTIGRAVITY_TOKEN_TGZ_B64` |
| Delivery | — | `SLACK_WEBHOOK_URL` |

The **translate** job on the box needs three more, which the workflow got from
repo secrets and from Actions itself:

| Purpose | Box variable | Where it came from on Actions |
|---|---|---|
| Gateway key | `TRANSLATE_LLM_API_KEY` | secret `ANTHROPIC_AUTH_TOKEN` |
| Gateway URL | `TRANSLATE_LLM_BASE_URL` | secret `ANTHROPIC_BASE_URL` |
| Push + open the PR | `TRANSLATE_GITHUB_TOKEN` | `secrets.GITHUB_TOKEN`, free and job-scoped |

That last one is the only genuinely new credential in the move. Actions minted
a repo-scoped token that died with the job; a box needs a **fine-grained PAT**
on `FailproofAI/failproofai` with *Contents: read+write* and *Pull requests:
read+write* — long-lived, on someone's machine, which is why `secrets.env` is
chmod 600 and why the job puts it in a credential helper rather than in the
remote URL (git echoes the remote back on a push error, and the Slack crash-note
carries the log tail).

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
local/                the box: runner image, installer, and one script per job
  Dockerfile.runner   the runner image, shared by every job
  install.sh          one-command setup: image + work dir + env file + cron
  runner-entrypoint.sh  baked, thin: lock -> checkout -> exec jobs/$CANARY_JOB.sh
  secrets.env.example   every variable both jobs read
  jobs/canary.sh      the integration suite (stable + beta legs)
  jobs/translate.sh   the nightly doc translation
```
