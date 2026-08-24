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

## Triaging a failed scan

When the OSV-Scanner gate fails on a PR:

1. **Prefer fixing it.** Bump the affected dependency to a patched version. For a
   transitive dependency that a parent pins to a vulnerable version, add a minimal
   [`overrides`](package.json) entry (as we do for `postcss`) and let CI validate
   the build.
2. **Only if there is no fix**, add a justified, time-boxed entry to
   [`osv-scanner.toml`](osv-scanner.toml) (`id`, `reason`, `ignoreUntil`). Never
   blanket-ignore. Re-review entries when their `ignoreUntil` date passes.

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
