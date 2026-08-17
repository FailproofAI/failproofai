---
name: fp-cli
description: |-
  The way to answer "how are my production AI agents doing?" and to run the team's agent-observability deployment — reach for it even on casual phrasing that names no tool.

  Trigger when the user wants to:
  • inspect agent telemetry — did agents error/fail/go flaky; sessions, events, latency, token usage, slowest models; eval/quality scores and whether quality dropped;
  • operate the deployment — ack/assign/resolve/mute/dismiss issues (alerts, reports, and audit findings) with notes; run and triage audits; see who has access and change roles (e.g. read-only); create or scope API keys (e.g. a push-only CI key); change settings; run saved or ad-hoc ClickHouse queries.

  Served by the `fp` CLI against FailproofAI Cloud.

  NOT for writing or designing an evaluator service / scoring logic (that's `agenteye-evaluator`), adding SDK/instrumentation to your app (that's the `agenteye` Python SDK), debugging the collector/daemon, or unrelated dev work (why a build/CI run failed, rotating non-FailproofAI Cloud secrets).
---

# FailproofAI Cloud CLI

`fp` is a command-line client for a FailproofAI Cloud deployment. It authenticates
either as a signed-in **user** or with a scoped **API key** (§2), and every command
takes `--json`, so it's built to be driven by an agent.

## 1. Find how to invoke it

Resolve this once, then reuse it for every call:

1. If `fp` is on `PATH` (`command -v fp`) → use **`fp`** (it's
   installed via pipx / uv tool / pip). This is the normal case.
2. Else, if you're in (or under) a repo with a `cli/` directory containing the
   `fp_cli` package → run it from there with **`uv run fp`** (a local dev
   build). The first run after a code change prints `Building…`/`Installed…` on
   stderr — that's `uv`, not CLI output; ignore it.
3. Else the CLI isn't available here → tell the user to install it
   (`pipx install fp-cli` or `uv tool install fp-cli`) and stop. Don't try to
   reach the dashboard another way.

Don't go spelunking in the CLI source tree for flags — if you're unsure of one,
run `fp <group> <cmd> --help`. The source is not the documented contract
and reading it wastes effort.

Throughout this skill, `fp` means "whichever form you resolved."

## 2. The contract (the CLI enforces it, work with it, don't fight it)

- **Global options go BEFORE the command:** `fp --json events`, never
  `fp events --json`. Globals are `--base-url`, `--org`, `--token`,
  `--api-key`, `--json`, `--insecure`/`--secure`. After the command they're a
  usage error.
- **Two ways to authenticate, and they are not interchangeable:**

  | | How you supply it | What it is |
  |---|---|---|
  | **Session** | `fp login` (interactive; it emails a one-time code) | a signed-in **user**, carrying that person's org memberships and permissions |
  | **API key** | `--api-key <key>`, or `FP_API_KEY` in the environment | a scoped **credential**, carrying exactly the permissions it was granted |

  A key is what you want in CI or any other non-interactive context: no browser, no
  emailed code, nothing to expire mid-run. `FP_API_KEY` takes precedence
  over `FP_TOKEN`; supplying both `--api-key` and `--token` is a usage
  error (exit 2) rather than a silent guess about which you meant. **A key is never
  written to the CLI's saved config** — pass it every time, from the environment.
  `--api-key ""` means "no override" and does **not** fall back to a saved session.

- **Some commands need a signed-in user.** `login`, `logout`, `orgs *` and the
  whole `agent` group refuse a key with a usage error (**exit 2**) and make **no
  network call at all** — there is no user to sign in, no saved active org to
  switch, and no private assistant thread to own. `keys update` is the near miss
  with a different signature: it *does* reach the server and comes back **exit
  5**, because re-scoping a key needs a permission that can never be granted to a
  key. Either way the key is not the problem to fix — plan around them rather than
  retrying or hunting for a flag.
- **Default to `--json` and parse it.** It prints clean JSON to stdout and
  nothing else. The plain output is a boxed Rich UI meant for human eyes — it
  burns context with box-drawing characters and is awkward to parse. Use the
  rendered output only when the user explicitly wants to *look* at something.
- **Data → stdout, status/errors/prompts → stderr.** So a `--json` stdout
  capture is pure JSON even when a status line is shown.
- **Branch on exit codes — don't scrape error text:**

  | code | meaning | what to do |
  |---|---|---|
  | 0 | ok | parse stdout |
  | 1 | unexpected / server error | report it to the user |
  | 2 | usage error (bad flags/args) | fix the command and retry |
  | 3 | can't reach the dashboard | check base-url / connectivity |
  | 4 | no usable credential — not signed in, session expired, **or the API key was rejected** | session: user must run `fp login`. Key: it's missing, mistyped, disabled, or belongs to another deployment — don't retry, and don't fall back to a session |
  | 5 | authenticated but missing permission | message names the exact permission |
  | 6 | resource not found | the named resource doesn't exist |

## 3. First call: confirm you're connected

Before real work, run `fp --json whoami` and react to the exit code:

- **exit 4** → no usable credential. If the user is working from a session, tell
  them to run `fp login` (it emails a one-time code and prompts
  interactively — you can't complete it for them, and don't fabricate a token).
  If a key was supplied, the key itself was rejected — say so and stop; logging in
  is not the fix, and silently switching to a session would run the command as a
  different identity than the user asked for.
- **base-url** → the CLI defaults to the hosted product,
  `https://app.befailproof.ai`, so a plain `fp login` works out of the box.
  Only pass `--base-url <url>` (or set `FP_DASHBOARD_URL`) for a self-hosted
  or dev deployment — a local dev stack is usually `http://localhost:3000`. A
  scheme-less URL is rejected as a usage error (exit 2).
- **exit 0** → `whoami` returns the active org slug and your permissions; trust
  that for the org name and to know what you're allowed to do before attempting a
  gated command (don't assume a particular org slug — read it from `whoami`).
- **In key mode, `whoami` answers a different question.** It still exits 0 —
  `whoami` never errors — but it reports *how* you are authenticated rather than
  *who* you are: there is no signed-in user, so it says so and names the auth mode
  and the org it will act on. Read the auth mode; don't read "no user" as "not
  authenticated" and don't try to log in on the strength of it. Since it isn't a
  permission check either, let your first real read (`fp --json list envs`)
  be what confirms the key works.

**Multi-tenant:** a user can belong to several orgs; the active one is chosen at
login. Override for a single command with the global `--org <slug>`
(`fp --org acme sessions`); change the saved default with
`fp orgs switch <slug>`.

> ⚠️ **With a key, name the org explicitly.** A key bound to one organization only
> ever acts on that one. But a key that is **not** bound to a single organization
> has nothing to fall back on — key mode never reads a saved active org — so the
> deployment resolves it to its own default, and you get **that** org's data: no
> error, no warning, results that look perfectly valid. If you cannot tell which
> kind of key you hold, pass `--org <slug>` (or set `FP_ORG`) on every
> command. Naming the org the key already belongs to is a no-op, and naming the
> wrong one fails loudly instead of quietly — both better than guessing.

## 4. Mutations: confirm with the user FIRST

The CLI normally prompts "are you sure?" before a destructive action — **but it
auto-skips that prompt whenever it isn't attached to a terminal, which is
exactly how you run it. `--json` skips it too.** So the safety prompt will not
fire for you.

Therefore: **before running any command that changes state, tell the user
plainly what will change (which resource, what value) and get an explicit OK.**
Then run it. (When the user's request *is* the instruction to act — "create a
key called X" — state the exact command you'll run and proceed; when it's vague
or wide-blast — delete, disable a user, rotate a key, resolve an incident —
stop and confirm.)

If a create fails because the name already exists (exit 2), **report that and
ask** — don't rename-and-retry or rotate/regenerate the existing one. A
`keys regenerate` you didn't intend breaks whatever already uses that key.

State-changing commands: `keys create/update/disable/regenerate`,
`users create/update/disable/enable`, `settings set`,
`alerts create/update/delete/test`, the writing `issues` subcommands
(`ack/assign/resolve/comment-add/comment-delete/subscribe/unsubscribe/open`),
`audits create/edit/delete/run` and the finding-triage verbs
(`ack/mute/dismiss/resolve/reopen/assign`),
`query create/update/delete`, `agent rename/delete`, and `orgs switch`.
Read-only commands (§5 "Observe") never need this.

## 5. Command map

Pick the right group; full flags are in `references/commands.md` — read it when
you need a flag you don't already know.

**Observe (read-only):**
- `events` — event log (light/payload-free responses by default; `--search` still scans payload server-side; `--full` or `--fields payload` returns the raw payload — keep bounded to a `--session-id`). `--session-id --event-type --env --agent-id --since --search --full --all`
- `sessions` — agent runs (time/env/agent/session/status), no scores.
- `evals` — evaluation results + scores; `--aggregate` for a health rollup; `--score key:min..max`.
- `errors` — errored events; `--aggregate` for count / sessions / agents / last-seen.
- `usage` — current org usage for its fixed 30-day metering window; needs `usage:read`.
- `list <kind>` — **discover valid filter values first**: `envs agents event_types score_filters models hooks tools error_types`.

**Manage (permission-gated, mutations):**
- `keys list|show|create|update|disable|regenerate` — API keys; secret shown once.
- `users list|show|create|update|disable|enable` — referenced by **email**.
- `settings list|schema|set` — fixed registry; `schema` shows what each key accepts.
- `alerts list|show|create|update|delete|test` — referenced by **name**.
- `issues list|count|show|ack|assign|resolve|comment-add|comment-list|comment-delete|subscribe|subscribers|unsubscribe|open` — by id (short ids accepted). **One board for everything needing attention**: alert breaches, hand-raised issues, and audit findings, told apart by a `source` of `alert` / `manual` / `audit`. (This group was called `incidents` before; the old name is gone.)
- `audits list|show|create|edit|delete|run|runs` — scheduled sweeps, referenced by **name**; `audits findings|finding` + the triage verbs `ack|mute|dismiss|resolve|reopen|assign` act on a finding **id**. `audits run <name>` only *queues* a run (poll `audits runs <name>` for completion). See §8.

**Analytics & assistant:**
- `query list|show|create|update|delete|run|schema` — saved ClickHouse SQL + ad-hoc runner (`query run <name>` or `query run --sql "…"`); `query schema [table]` for table layout.
- `agent health|models|chats|ask|show|rename|delete` — built-in assistant; `agent ask "…"` starts a chat, `--chat <short-id>` continues one.

**Identity:** `login`, `logout`, `whoami`, `orgs {list,switch,current,perms}`, `version`, `help`.
All of `login` / `logout` / `orgs` — like the whole `agent` group — are **session-only**:
with a key they exit 2 without calling anything (§2). `keys update` needs a user too, but
fails as exit 5. `whoami`, `version` and `help` work either way.

## 6. Translating plain-English requests

Users speak in outcomes, not commands ("is anything broken?", "give CI a key",
"who has access?"). Map intent → command; when a value is fuzzy, run a discovery
command (`list <kind>`, `whoami`, a `list` subcommand) before committing.

| The user says… | Reach for |
|---|---|
| "is anything broken / failing today?", "any errors?" | `errors --since 24h --aggregate`, then `errors --since 24h --all --limit 1000` to break down |
| "why did that run fail?", "what happened in session X?" | `events --session-id X --all --limit 1000` (and `errors --session-id X`) |
| "how are my agents doing?", "show recent runs" | `sessions --since 24h` (add `--status error` for just failures) |
| "are the evals / quality scores ok?", "did quality drop?" | `evals --aggregate`; drill with `evals --score <key>:..0.5` |
| "how many events / how much traffic last week?" | `query schema` then `query run --sql "SELECT count() FROM events WHERE ts >= now() - INTERVAL 7 DAY"` |
| "what has this org used this metering window?" | `usage` (or `--json usage` for the complete response) |
| "is anything on fire?", "any alerts firing / open issues?" | `alerts list` + `issues list` (and `issues count`) |
| "ack / look at / resolve that issue" | `issues list` → `issues show <id>` → **confirm** → `issues ack`/`resolve <id>` |
| "run an audit", "what did the audit find?", "any findings to triage?" | `audits list` → `audits run <name>` (queues) → `audits runs <name>` (wait for `succeeded`) → `audits findings --audit <name>`; triage with `audits resolve/mute/dismiss <id>` — **confirm first** |
| "give CI / this service an API key" | `keys create <name> --add events:add` (scope to what they describe) — **state it, then create**; capture the one-time secret |
| "who has access?", "add / remove a teammate", "make them read-only" | `users list` / `users show <email>` / `users create`/`update`/`disable` |
| "change a setting", "what can I configure?" | `settings schema` (what's tunable) then `settings set <key> --value …` — **confirm first** |
| "what models can the assistant use?", "ask the assistant …" | `agent models`; `agent ask "…"` |
| "what can I query?", "run this SQL" | `query schema` / `query run --sql "…"` (or a saved `query run <name>`) |
| "what am I allowed to do?", "which org am I in?" | `whoami`, `orgs current`, `orgs perms` |

If the ask is ambiguous about scope (which org, which agent, read vs. change),
resolve it with a discovery command or a quick clarifying question rather than
guessing.

## 7. How to actually use it (recipes)

Discover → filter → read JSON → answer in prose:

```bash
fp --json list agents                                       # find valid agent ids
fp --json errors --since 24h --aggregate                    # how bad is it right now? (full-window totals)
fp --json errors --since 24h --all --limit 1000 | jq '.errors[] | {session_id, error_type}'
fp --json sessions --status error --since 7d --all --limit 1000   # which runs failed
fp --json events --session-id run-001 --all --limit 1000    # a run's timeline (light: summaries, no payload)
fp --json events --full --session-id run-001 --all | jq '.events[].payload'   # that run's RAW payloads (--full, bounded)
```

- **Raw `payload` is opt-in** — `events`/`errors` responses are payload-free by default; add
  `--full` (or `--fields payload`) to get it, and **always bound it to a `--session-id`**
  (the full feed is slow/OOM-prone at scale). For one event or a precise slice, read the
  column directly: `fp --json query run --sql "SELECT payload FROM events WHERE id = <id>"`
  (or `WHERE session_id = '<id>'`). See `references/commands.md` → "Getting the raw payload".

- **`list <kind>` before filtering** — don't guess an env or agent id; the
  discovery command tells you exactly what exists.
- **`--since`** takes `24h` / `7d` / etc.
- **`--all` is bounded by `--limit`, which defaults to 50.** So a bare
  `errors --since 24h --all` silently returns only the first 50 rows (with
  `next_cursor: null`, looking complete). For a real sweep pass a high explicit
  limit: **`--all --limit 1000`** (or higher). When you only need the totals, use
  `--aggregate` — it covers the whole window regardless of row caps, so it's the
  reliable cross-check that you pulled everything.
- **Triage flow:** `issues list` → `issues show <id>` (read the activity
  log) → confirm with the user → `issues ack <id>` or `resolve <id>`.
- **Investigate a regression:** `evals --aggregate` to see which score dropped →
  `evals --score helpfulness:..0.5` to list the bad runs → `events --session-id <id>`
  to see what happened inside one.

When you've pulled what you need, answer the user in prose or a small table —
don't paste raw JSON back unless they asked for it.

## 8. Audits — the async sweep, and how findings become issues

An **audit** is a scheduled sweep that analyses recent agent behaviour (errors,
runaway tool loops, leaked secrets, low eval scores, …) and emits **findings**.
Two things about the flow matter when driving it from the CLI:

- **`audits run <name>` is asynchronous — it only *queues*.** A `{"queued": true}`
  does NOT mean the run finished (the analysis can take minutes). Poll
  `audits runs <name>` until the newest row reads `succeeded` (or `failed`) before
  reading findings — don't assume results are ready on the call that queued them.
  A disabled audit, or one already mid-run, refuses to queue (exit 1).
- **Findings ARE issues — it's one bucket.** Every finding graduates to an issue
  (`source = audit`) and carries its full content there, so the same problem shows
  up under both `audits findings` and `issues list`. Triage is **globally
  consistent in both directions**: `audits resolve <finding-id>` closes the linked
  issue, and `issues resolve <issue-id>` on an audit issue resolves the finding —
  either surface works, they never disagree. Triage a finding with
  `audits ack|mute|dismiss|resolve|reopen <id>` (durable **mute/dismiss** suppress
  the pattern org-wide by fingerprint; **resolve** leaves no suppression, so a true
  recurrence reopens as new). Reads need `audits:read`, every mutation
  `audits:write` (note: triaging a finding needs `audits:write`, not an `issues:*`
  permission — the audit is the system of record and the issue follows it).

Typical end-to-end: `audits list` → `audits run <name>` → poll `audits runs <name>`
→ `audits findings --audit <name>` (highest priority first) → `audits finding <id>`
for the full write-up → **confirm with the user** → `audits resolve <id>`.
