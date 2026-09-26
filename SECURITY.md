# Security Policy

failproofai is an npm package that installs hooks into AI agent harnesses
(Claude Code, Codex, Cursor, the Hermes and OpenClaw gateways, and others) and
runs locally in the environment the agent runs in, observing and gating agent
actions. A compromised dependency would therefore run on our
users' machines and servers, inside their agent sessions — so we treat our supply chain as
part of our users' trust boundary. This document covers how to report a
vulnerability and how our dependency supply-chain scanning works.

## Reporting a Vulnerability

Please report security issues privately — do **not** open a public issue.

- Preferred: open a [private vulnerability report](https://github.com/FailproofAI/failproofai/security/advisories/new)
  via GitHub Security Advisories.
- Or email **failproofai@exosphere.host**.

We aim to acknowledge reports within 3 business days and will keep you updated as
we investigate and ship a fix. Please give us a reasonable window to remediate
before any public disclosure.

## Supply-chain scanning

Every pull request — including automated Dependabot dependency bumps — is scanned
for supply-chain threats before it can merge, via two complementary layers.

### 1. OSV-Scanner — the blocking CI gate

[`.github/workflows/osv-scanner.yml`](.github/workflows/osv-scanner.yml) runs
[OSV-Scanner](https://google.github.io/osv-scanner/) against the resolved
dependency tree (`bun.lock`). It checks every direct and transitive package
against [OSV.dev](https://osv.dev), which aggregates GitHub/npm security
advisories **and** the [OpenSSF malicious-packages feed](https://github.com/ossf/malicious-packages)
(confirmed malware: typosquats, account-takeover injections, and the like).

**Policy: block on any finding.** The gate fails on *any* known-vulnerable or
malicious package in the tree — not just newly introduced ones. It runs on every
PR, on pushes to `main`, and daily (to catch advisories disclosed after a
dependency was already merged). A daily run that fails on `main` — where there's
no PR author already looking at the check — also posts to Slack, via the
`SLACK_WEBHOOK_URL` repository secret.

### 2. Socket — behavioral early-warning

OSV-Scanner is advisory-based: it can only flag threats already cataloged. To
catch *novel* attacks (malicious install scripts, suspicious network/filesystem
access, obfuscation, sudden maintainer changes) before they reach any advisory
database, we use [Socket](https://socket.dev) via its GitHub App, which comments
on PRs that introduce risky dependency behavior. Socket is advisory (it
comments); the deterministic *blocking* gate is OSV-Scanner.

### 3. Dependabot alerts — the wider net

The gate above scans the lockfiles it is *given* (the `--lockfile` list in the
workflow). GitHub's dependency graph reads **every** lockfile in the repository, so
Dependabot alerts cover trees the gate does not — in particular the TypeScript SDK's
integration fixtures, `sdk/typescript/integration/fixtures/*/package-lock.json`.
Those are not in the scanner's list and are not a Dependabot *update* ecosystem in
[`.github/dependabot.yml`](.github/dependabot.yml) either, so an alert is the only
thing that will ever mention them. Treat the alert list as authoritative for those
paths, and see *Triaging a Dependabot alert in an integration fixture* below for how
to resolve one.

## Triaging a failed scan

When the OSV-Scanner gate fails on a PR:

1. **Prefer fixing it.** Bump the affected dependency to a patched version. For a
   transitive dependency that a parent pins to a vulnerable version, add a minimal
   [`overrides`](package.json) entry (as we do for `postcss`) and let CI validate
   the build.
2. **Only if there is no fix**, add a justified, time-boxed `[[IgnoredVulns]]`
   entry to [`osv-scanner.toml`](osv-scanner.toml) (`id`, `reason`,
   `ignoreUntil`). One advisory per entry, which is the point: any *other*
   advisory against the same package still blocks. The scanner resolves
   **aliases**, so one id covers every spelling of the *same* advisory — naming
   both a `PYSEC-` id and its `GHSA-` alias adds nothing and gets reported as an
   unused ignore. It does **not** cover a distinct advisory against that package,
   which still fails the gate until it gets its own entry. Re-review entries when
   their `ignoreUntil` date passes.
3. **Only for a package that keeps accruing unfixable advisories**, where an id
   list has become whack-a-mole — each new disclosure reddening the gate on an
   unrelated PR until someone appends another id — use `[[PackageOverrides]]`
   instead (`name`, `version`, `ecosystem`, `vulnerability.ignore`,
   `effectiveUntil`; note the different date key). This silences *every*
   advisory against that package, **including fixable ones**, so the `reason`
   must say why losing that signal is acceptable for this package specifically.
   Pin `version` to the locked version so a lockfile bump re-opens the gate, and
   never omit `effectiveUntil`.

## Triaging a Dependabot alert in an integration fixture

Each directory under `sdk/typescript/integration/fixtures/` is a real consumer
project with its own committed lockfile, and several pin a deliberately **old**
framework major — `ai@4.3.19`, `@langchain/core@0.3.80`, `@mastra/core@0.24.9`. That
is the point of those fixtures: an adapter has to keep working at the *floor* of
every range the SDK declares, and the failure they exist to catch is invisible from
the unit tests (see the harness docstring in `sdk/typescript/integration/harness.ts`).
The pinned framework is the **subject** of the test, not an incidental dependency.

That splits an alert in one of these lockfiles into two cases:

1. **The advisory is against a transitive dependency.** Fix it. Add a minimal
   `overrides` entry to *that fixture's* `package.json` naming the patched version,
   re-resolve with `npm install --package-lock-only --ignore-scripts`, and let the
   `failproofai-ts-sdk-integrations` CI job validate it — the same mechanism, and the
   same reasoning, as the root [`package.json`](package.json)'s `overrides`. An in-range
   `npm update` will almost never help: these frameworks pin their transitive deps
   **exactly** (`ai@4.3.19` requires `jsondiffpatch@0.6.0`, not `^0.6.0`), which is
   what makes the lockfiles reproducible and an override the only lever. **Never**
   resolve one of these by moving the pinned framework — that deletes the fixture's
   reason to exist and silently drops a supported release from the matrix.
2. **The advisory is against the pinned framework itself, or against a package whose
   only fix is a major that framework cannot take.** There is no fix that keeps the
   fixture, so record it in the table below rather than pretending it away. Unlike a
   failed gate there is nothing to write in [`osv-scanner.toml`](osv-scanner.toml):
   the scanner does not read these lockfiles, so an `[[IgnoredVulns]]` entry for one
   would filter nothing and be reported as an unused ignore.

### Accepted, with no fix available

| Advisory | Package | Fixtures | Why it stays |
|---|---|---|---|
| [GHSA-rwvc-j5jr-mgvh](https://github.com/advisories/GHSA-rwvc-j5jr-mgvh) (low, CVSS 3.7) | `ai@4.3.19` | `ai-4`, `mastra-0` | A filetype-whitelist bypass on **file upload**. Fixed in `ai@5.0.52` — the major the `ai-4` fixture exists to stay below, and one `@mastra/core@0.24.9` cannot take either (it requires `ai@^4`). Neither fixture uploads a file or exposes an upload surface; each runs one scripted agent against an in-process model. |
| [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) (low, CVSS 4.3) | `@ai-sdk/provider-utils@2.2.8` | `ai-4`, `mastra-0` | Unbounded response-body reads in `createJsonResponseHandler` and its siblings. Fixed in `3.0.28`; `2.2.8` ships *inside* `ai@4.3.19`, which uses the v2 API, so the fix is the same blocked major as the row above. Exploiting it needs a hostile **model-provider HTTP response**; these fixtures never call one. |

Both rows are bounded by the same facts: these are test fixtures — `"private": true`,
never published, installed with `--ignore-scripts`, and run only in CI against
scripted in-process models. Re-check them whenever the supported framework floor
moves; dropping `ai` 4.x from the matrix is what actually retires them.

## Maintainer setup (one-time)

These steps live outside the repo and require admin access:

1. **Install the [Socket GitHub App](https://github.com/apps/socket-security)** on
   the repository to enable behavioral PR comments.
2. **Make the OSV-Scanner check required**: in branch protection for `main`, add
   the OSV-Scanner job (shown as `OSV-Scanner`) as a required status check, so a
   red scan blocks merge.
3. *(Optional)* For a Socket CI gate in addition to the App, add a
   `SOCKET_SECURITY_API_KEY` repository secret and the Socket CI action — deferred
   until tuned, since behavioral findings can have false positives.
4. **Slack alert on a failed daily scan**: set the `SLACK_WEBHOOK_URL` repository
   secret to a Slack Incoming Webhook URL (the same secret `integration-suite`
   already posts to). Without it, the daily job still runs and still fails CI on a
   finding — it just skips the Slack POST and logs that the secret is unset.
