# FailproofAI Cloud CLI (`fp`)

A command-line client for the **FailproofAI Cloud** API. It lets a developer —
or the coding agent working alongside them — authenticate and query agent
sessions, event logs, and evaluations from the terminal, with a `--json` flag on
every command for scripting.

> **The package is `fp-cli`; the command is `fp`.** They differ because `fp` was
> already taken on PyPI. This is also distinct from `failproofai` on npm, which is
> the Enforcement CLI — that one runs inside the agent loop and decides what an
> agent may do; this one reads back what it did.

## Install

```bash
pipx install fp-cli      # recommended (isolated)
# or: uv tool install fp-cli  /  pip install fp-cli
```

Then the command is `fp`:

```bash
fp --version
fp help
```

For development in this repo:

```bash
cd fp-cli
uv sync --extra dev
uv run fp --help
```

## Authentication

The CLI talks to your dashboard (set `--base-url` or `FP_DASHBOARD_URL`) and logs in with
an emailed one-time code:

```bash
fp login --email you@example.com
# enter the 6-digit code; the session is stored in
# ~/.failproofai/fpcli/cli-auth.json (mode 0600)
fp whoami
fp logout
```

Sessions expire (24h by default); re-run `fp login` when prompted.

## Working across orgs (multi-tenant)

Your account can belong to more than one org. The active org is chosen **at login** and saved:

```bash
fp login --org acme              # pick the tenant at login (saved for later commands)
fp orgs list                     # your orgs + your role in each (active one marked)
fp orgs switch globex            # switch the active org (pass a slug…)
fp orgs switch                   # …or omit it to pick from a list (in a terminal)
fp orgs current                  # which org you're acting as right now (identity card)
fp orgs perms                    # your permissions in the active org (grouped by resource)
fp --org globex sessions         # override for a single command
```

If you belong to exactly one org it's selected automatically. If you belong to several, you
pick at login (or with `orgs switch`); pass `--org` to choose non-interactively. A slug you
can't access (non-existent, or not yours) is rejected rather than saved. The active org is
sent as the `X-AgentEye-Org` header on every request, and your permissions are resolved per
org. (All tenant commands live under one group: `orgs list` / `orgs switch` / `orgs current` /
`orgs perms`.)

## Commands

**Query & observability**

```text
fp sessions [--since 24h] [--status error] [--agent-id <id>] [--all]   # runs: time/env/agent/session/status
fp evals [--score helpfulness:..0.5] [--all]   # eval results + scores
fp evals --aggregate [--since 7d]              # rolled-up eval health (status mix + per-metric score stats)
fp events --session-id <id> [--event-type tool_use,tool_result] [--env prod] [--all]
fp errors [--since 24h] [--error-type TimeoutError] [--all]   # list errored events
fp errors --aggregate [--since 7d]            # error summary (count + sessions/agents/last seen)
fp list <thing>                   # discover dropdown values to filter on:
#   envs · agents · event_types · score_filters · models · hooks · tools · error_types
```

**Manage your org** (each gated by the matching permission)

```text
fp keys list|show|create|update|disable|regenerate     # API keys (secret shown once)
fp users list|show|create|update|disable|enable
fp settings list|schema|set
fp alerts list|show|create|update|delete|test
fp issues list|count|show|ack|assign|resolve|comment-add|comment-list|comment-delete|subscribe|subscribers|unsubscribe|open
fp audits list|show|create|edit|delete|run|runs|findings|finding    # scheduled audits
fp audits ack|assign|resolve|dismiss|mute|reopen                    # triage a finding
fp audits context-show|context-set|context-refresh                  # reference context
fp usage                                         # org usage for the metering window
```

**Analytics & assistant**

```text
fp query list|show|create|update|delete|run|schema   # saved SQL + ad-hoc runner
fp agent health|models|chats|show|rename|delete|ask
#   agent models                 → models available for --model (with the default marked)
#   agent ask "…"                → starts a NEW chat, answers + persists, prints the chat id
#   agent ask --chat <id> "…"    → continue that chat (shows in the dashboard; 1st Q auto-titles)
#   agent chats|show <id>|rename <id> --title …|delete <id>   → manage saved chats
fp version | help
```

**Mutations are non-interactive-safe.** Create/update/delete prompt for confirmation in a
terminal, but auto-skip the prompt under `--json` or when stdin isn't a TTY (so scripts/agents
never hang). Pass `--yes`/`-y` to skip it explicitly. Request bodies can be supplied with
`--file payload.json` (or `--file -` for stdin) on `alerts`, `settings`, and `users
create`/`update` — mutually exclusive with the discrete flags. (Saved-query SQL uses
`--sql @file.sql`.)

Every command and subcommand has `--help` / `-h`; `fp -h` documents auth, exit codes, and
the global options. **Global options go before the command** (`fp --json events`, not
`fp events --json`).

Add `--json` for machine-readable output, and `--fields` to project just the keys you need:

```bash
fp --json events --session-id run-001 --all | jq '.events[].payload'
fp --json sessions --since 7d --fields session_id,status,scores
```

### Cloud-managed policies

Three commands for the three jobs the dashboard splits across three pages —
`fp policies` writes a policy version, `fp fleet` decides which machines run it,
`fp guardrails summary` reports what it actually blocked.

```bash
fp policies publish no-force-push ./rule.mjs   # path, @path, a pipe, - or a paste
fp fleet deploy ci-runner-01 --add no-force-push
fp guardrails summary --since 24h
```

**A deploy REPLACES a machine's whole policy set.** The server takes the full
list and does not merge, so `fleet deploy` reads what the machine currently runs,
applies your `--add`/`--remove`, prints the complete resulting set, and writes
that. Use `--set` only when you mean "exactly these, drop the rest".

```bash
fp fleet deploy ci-runner-01 \
    --add no-force-push \            # keeps its pinned version if already deployed
    --add prod-guard@1:observe \     # id@version:effect
    --remove old-rule
```

Three things worth knowing before you script it:

* A bare `--add` of a policy the machine already runs keeps its **pinned
  version**. Pass `id@version` to move it — a pin is usually deliberate.
* The endpoint has no lock. The CLI records the deployment generation it read and
  **refuses** if the write does not land at exactly one higher, because that means
  somebody deployed in between and a replace does not merge.
* The exit code separates your mistake from the server's answer. A malformed ref,
  `--set` alongside `--add`/`--remove`, or no flags at all is **2**; a ref that
  parses but names a policy that does not exist is **1**; an unknown machine is
  **6**. Branch on those rather than on the message.

`fp fleet diff` shows intent versus delivery: a machine can be deployed-to and
still enforcing an older set until it next polls. It refuses a machine id nobody
has reported under rather than rendering it as an empty fleet.

These commands are **session-only** (`fp login`). They are absent from the
versioned API an API key authenticates against, so `--api-key` exits 2 with the
reason rather than failing at the request.

## Configuration

| Setting | Flag | Env var | Default |
|---|---|---|---|
| Dashboard URL | `--base-url` | `FP_DASHBOARD_URL` | `https://app.befailproof.ai` |
| Active org/tenant | `--org` | `FP_ORG` | chosen at login; saved in `~/.failproofai/fpcli/cli-auth.json` |
| Session token | `--token` | `FP_TOKEN` | from `~/.failproofai/fpcli/cli-auth.json` |
| API key (CI) | `--api-key` | `FP_API_KEY` | none; never written to disk |
| JSON output | `--json` | `FP_JSON` | off |
| Skip TLS verification | `--insecure` / `--secure` | `FP_INSECURE` | off (saved at login) |
| Disable usage telemetry | _(none)_ | `FP_ANALYTICS_DISABLED` (or `DO_NOT_TRACK`) | telemetry on |

Precedence is **flag > environment variable > config file > built-in default**. A fresh
install points at the hosted product with no configuration; set `--base-url` or
`FP_DASHBOARD_URL` for a self-hosted or dev instance and it is saved after `login`.

The session lives at `~/.failproofai/fpcli/cli-auth.json` (mode `0600`). The directory
is resolved as `FP_HOME` > `$FAILPROOFAI_HOME/fpcli` > `~/.failproofai/fpcli` — `FP_HOME`
names the CLI's own directory and is used as-is, so an existing export keeps addressing
the same place; `FAILPROOFAI_HOME` names the shared home root, so `fpcli/` is appended.

The CLI only ever creates. It will bring `~/.failproofai` into existence on a machine
that has never run the Enforcement CLI, and leaves a populated one exactly as it found
it — nothing here removes or rewrites a path it does not own. The file is registered in
that home's layout (`src/hooks/fp-home.ts`) and classified `user-typed`, which is what
keeps a layout migration from dropping it.

The Python SDK and the collector keep their own spool under `~/.agenteye`. That one is a
wire contract with the collector rather than a preference, so it did not move.

> **Upgrading from a version that used `~/.fp/cli.json`?** Nothing to do — the old
> session is adopted on your next command, so you are not signed out. It is copied, not
> moved, so rolling back to an older `fp` still works; remove `~/.fp/` yourself once you
> are happy.

For a dashboard with a self-signed or internal TLS certificate, add `--insecure` to skip
certificate verification (saved at login, so you set it once). This disables protection
against man-in-the-middle attacks — prefer a valid certificate outside internal/testing use.

## Telemetry

**Telemetry is currently disabled and this build sends nothing.**
`TELEMETRY_DISABLED` is `True` in `fp_cli/analytics_config.py`: when the analytics
host is unreachable the send path stalls every command for ~5s — the shutdown flush
is bounded, but the client build and first connect attempt are not — so it stays off
until that path is fully non-blocking. Nothing was removed; re-enabling is one
constant.

The rest of this section describes what it collects **if** it is re-enabled, so you
can review it in advance rather than discover it in a release note:

- which command ran (including its subcommand, e.g. `keys create`), success/exit
  status and duration, the **names** of flags used, and a per-action event for
  mutations (e.g. `api_key_created`, `query_run`) carrying only static names/enums
  and coarse counts;
- **no data, URLs, tokens, emails, ids, SQL, key secrets, or query values are ever
  sent**, and operators are identified only by an opaque id.

`FP_ANALYTICS_DISABLED=1` (or the cross-tool `DO_NOT_TRACK=1`) opts out, and keeps
working as an opt-out if it is ever switched back on. See
<https://docs.befailproof.ai/agenteye/cli> for the full privacy details.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error (e.g. an unhandled server status) |
| 2 | Usage error (bad arguments) |
| 3 | Cannot reach the dashboard |
| 4 | Not logged in / session expired |
| 5 | Authenticated but missing permission |
| 6 | Resource not found |

## Tests

```bash
cd fp-cli
uv run --extra dev pytest
```

