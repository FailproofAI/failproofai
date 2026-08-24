# FailproofAI Cloud CLI — full command reference

Flag-level detail for every group. Read the section you need; the SKILL.md body
already has the workflow and the contract. Remember: **globals before the
command**, **`--json` to parse**, **branch on exit codes**.

## Contents
- [Global options](#global-options)
- [Shared input conventions](#shared-input-conventions)
- [Identity: login / logout / whoami / orgs](#identity)
- [Observe: events / sessions / evals / errors / usage / list](#observe)
- [keys](#keys)
- [users](#users)
- [settings](#settings)
- [alerts](#alerts)
- [audits](#audits)
- [issues](#issues)
- [query](#query)
- [agent](#agent)

## Global options
Set on the CLI, **before** the subcommand. Precedence: flag > env var > config file (`~/.failproofai/fpcli/cli-auth.json`, mode 0600).

| Flag | Env var | Meaning |
|---|---|---|
| `--base-url <url>` | `FP_DASHBOARD_URL` | Dashboard URL. Defaults to `https://app.befailproof.ai` (the hosted product); override for self-hosted/dev. Must start with `http://`/`https://`. |
| `--org <slug>` | `FP_ORG` | Active org for this command (multi-tenant override). |
| `--token <t>` | `FP_TOKEN` | Session token (normally from config after `login`). |
| `--api-key <k>` | `FP_API_KEY` | Scoped API key — authenticate as a credential instead of as a signed-in user. Never saved to the config file. |
| `--json` | `FP_JSON` | Machine-readable JSON to stdout, nothing else. |
| `--insecure` / `--secure` | `FP_INSECURE` | Skip / require TLS verification (for self-signed dev certs; saved at login). |
| `--version` | | Print version (also `fp version`). |

Config dir resolves as `FP_HOME` > `$FAILPROOFAI_HOME/fpcli` > `~/.failproofai/fpcli`; `FP_HOME` is used as-is, `FAILPROOFAI_HOME` gets `fpcli/` appended. Telemetry is currently disabled globally while its send path is made fully non-blocking. `FP_ANALYTICS_DISABLED=1` and `DO_NOT_TRACK=1` remain supported opt-out controls for when telemetry is re-enabled.

### Session or API key
Exactly one credential is in play per invocation, chosen in this order:

| You supply | Result |
|---|---|
| `--api-key` **and** `--token` | usage error, exit 2 — it never guesses |
| `--api-key` | key mode |
| `--token` | session mode |
| `FP_API_KEY` | key mode — **wins over `FP_TOKEN`** |
| `FP_TOKEN` | session mode |
| a saved session (from `login`) | session mode |
| nothing | exit 4 |

- **The key is never persisted.** A session token is saved by `login` and expires on its own; an API key is valid until someone revokes it, so the CLI keeps it out of the config file entirely. Supply it per invocation, normally via `FP_API_KEY`.
- **`--api-key ""` means "no override", not "fall back".** Mode stays *key*, the credential is empty, and the command exits 4 — it will not quietly use a saved session. (Same rule as `--token ""`.) An empty *environment variable* is a different story: `FP_API_KEY=""` reads as unset and falls through to the next credential, so an unset CI variable can silently run as whichever human is logged in on that machine. Pass the flag if you need the strict behaviour.
- **A rejected key is exit 4**, same as an expired session. Report it; don't retry and don't switch credentials.
- **Session-only commands:** `login`, `logout`, `orgs *`, `agent *`, `keys update`, and all of `policies *`, `fleet *`, `guardrails *`. In key mode each exits **2** *before making any request* — there's no user to sign in or switch orgs for, no private assistant thread to own, and the enforcement write routes are root-only and deliberately absent from `/v1`. `keys update` is in this list and not a special case: it calls `deny_in_key_mode` as the FIRST statement of the command body, so it exits 2 with zero HTTP calls like the rest, because `keys:update` cannot be granted to any API key.
- **Name the org when using a key.** Key mode sends the org only when you supply it (`--org <slug>` / `FP_ORG`) — it never reuses the saved active org from `login`. A key bound to one organization only ever acts on that one; a key that is not bound to a single organization falls back to the deployment's default, and you get plausible-looking data from the wrong tenant with no error and no warning. Naming the key's own org is a no-op; naming a different one is rejected. Both beat guessing.

## Shared input conventions
- **`--json`** on any command → pure JSON on stdout (no Rich chrome). Mutations under `--json` auto-skip their confirm prompt.
- **`--yes` / `-y`** explicitly skips a confirm prompt. (Confirms are also auto-skipped on a non-TTY — i.e. whenever Claude runs it — so always confirm with the user yourself first.)
- **`--all` + `--limit`**: `--limit` (`-n`) defaults to **50**; `--all` auto-paginates (client chunks of 200) **up to `--limit`**, NOT without bound. So a bare `--all` still stops at 50 rows. For a full sweep on `events/sessions/evals/errors`, pass a high explicit cap: **`--all --limit 1000`** (or higher). To just get window totals, use `--aggregate` (covers the whole window regardless of row caps).
- **`--fields a,b,c`** projects only those keys (where supported: sessions/evals, keys, query list).
- **Policy source** (`policies publish` / `policies test`) comes from a path, `@path`, a pipe, `-`, or an interactive paste. A path that is not readable UTF-8 text — a binary file pointed at by mistake — is refused by name (**exit 2**), as is a missing path; neither reaches the server.
- **`--since <window>`** relative window — one of `15m`, `1h`, `6h`, `24h`, `7d`, `all` (any other value is a usage error, exit 2). `--from`/`--to` take ISO timestamps **with `T` and a timezone** (e.g. `2026-06-01T00:00:00Z`) — space-separated or tz-less is a usage error (exit 2).
- **`--file payload.json`** (or `--file -` for stdin) supplies a full JSON request body on `alerts`, `settings set`, and `users create/update` — mutually exclusive with the discrete flags. Saved-query SQL uses `--sql @file.sql`.
- **Multi-value filters** are CSV → `IN (...)` (union within a filter, AND across filters): `--event-type tool_use,tool_result`. `--search` is repeated/OR (matches ANY term), payload-only.

## Identity

### login / logout / whoami
- `fp login [--email you@x.com] [--org <slug>]` — emails a one-time code; on a real TTY it's a single interactive box, else a plain prompt. Saves the session to `~/.failproofai/fpcli/cli-auth.json` (was `~/.fp/cli.json`; a session at the old path is adopted automatically on the next command, so an upgrade signs nobody out). **You cannot complete this for the user** (it needs the emailed code). `--org` picks the tenant at login. **Session-only** — exit 2 under a key.
- `fp logout` — clears the saved session. **Session-only** — exit 2 under a key (a key cannot be "logged out"; revoke it instead).
- `fp whoami` — active org + your permissions. Run this first; exit 4 = no usable credential.
  **Under a key it answers a different question and still exits 0:** it reports that there is no signed-in user, names the auth mode, and gives the org it will act on. So branch on the auth mode, not on the absence of a user identity — and note that it does not prove the key is accepted or check any permission. Let the first real read do that.

### orgs
**Session-only, the whole group** — each exits 2 under a key, with no request made. Use `--org <slug>` per command instead.
- `orgs list` — your orgs + role in each (active marked).
- `orgs switch [<slug>]` — change the saved active org; omit slug to pick from a list (TTY only). **State change** (mild) — affects later commands.
- `orgs current` — identity card for the active org.
- `orgs perms` — your permissions in the active org, grouped by resource.

## Observe
All read-only; never need confirmation.

### events
`fp events [filters] [--all]` — event log, newest first. **Default is the light,
payload-free feed**: rows carry `summary, is_error, error_type, output_tokens,
context_window, context_fill` (a server-computed `summary`, no raw payload).
`--session-id`, `--all`, and structured filters stay on this fast path. `--search` is the
exception: responses remain payload-free, but the server must scan `payload` to match the
free-text term, so broad searches can still be expensive. To get the raw `payload`, opt
into the **full feed** with `--full` (or `--fields payload`) — that read is slow at scale,
so keep it bounded (pair `--full` with one `--session-id`).
e.g. `fp --json events --full --session-id run-1 --all | jq '.events[].payload'`.
Filters: `--session-id <id>` `--agent-id <id>` `--event-type <csv>` `--env <csv>` `--since <window>` / `--from`/`--to` `--search <term>` (repeatable, payload OR-match).

#### Getting the raw payload
The default `events`/`errors` reads are payload-free. Only `--full` (or `--fields payload`)
returns the raw `payload`, and that is the heavy feed — **always bound it** (pair with
`--session-id`); an unbounded `events --full` can time out or degrade the event store at
scale.
- **A whole session:** `fp --json events --full --session-id <SESSION_ID> --all --limit 1000 | jq '.events[].payload'`
- **A single event:** scope to its session, then pick by id — `fp --json events --full --session-id <SESSION_ID> --all | jq '.events[] | select(.id == <EVENT_ID>) | .payload'`
- **An error's payload:** two steps — `fp --json errors --error-type <T> --since 24h` (gives the error's `id` and `session_id`; `errors` is light-only, no payload), then `fp --json events --full --session-id <SESSION_ID> --all | jq '.events[] | select(.id == <ERROR_EVENT_ID>) | .payload'`
- **Precise / by id (avoids the heavy list query):** `fp --json query run --sql "SELECT id, event_type, payload FROM events WHERE session_id = '<SESSION_ID>' ORDER BY ts"` — or `WHERE id = <EVENT_ID>`. Reads `payload` directly via the read-only SQL runner; a bounded `WHERE` is fast.

### sessions
`fp sessions [filters] [--all]` — agent runs: time/env/agent/session/status (no scores). Filters: `--session-id --agent-id --env --status <error|...> --since`. JSON rows still carry `scores`.

### evals
`fp evals [filters] [--score key:min..max] [--scores-full] [--all]` — evaluation results + scores.
`fp evals --aggregate [--since 7d]` — rollup: `{total, status_counts, score_stats, timeline}` (status mix + per-metric score stats). `--score helpfulness:..0.5` = max 0.5; `helpfulness:0.8..` = min 0.8; `helpfulness:0.5..0.9` = range.

### errors
`fp errors [filters] [--all]` — errored events (time/event/env/agent/session/summary), from the light payload-free feed; the `summary` is the server-computed field, and `--json` rows carry no payload. For a run's raw payload use `fp events --full --session-id <id>`. Filters incl. `--error-type <csv>`.
`fp errors --aggregate [--since 7d]` — `{total, sessions, agents, last_ts, bins}`.

### usage
`fp usage` — the active org's current fixed 30-day metering window, grouped for human
reading. Needs `usage:read`. `fp --json usage` returns the dashboard contract unchanged:
`org_id`, `billing_anchor`, `window`, `usage`, `calculated_at`, and `stale_after`. It has no
filters or subcommands and is read-only; limits and enforcement are not part of this command.

### list
`fp list <kind>` — discover valid filter values. Kinds: `envs agents event_types score_filters models hooks tools error_types`. JSON `{kind, values}`. Run this before filtering by a value you're unsure of.

## keys
API keys; the secret is shown **once** on create/regenerate (capture it then). Referenced by **name**.
- `keys list [--show-id] [--fields ...]` — active keys first, then revoked.
- `keys show <name>`
- `keys create <name> [--permission-set <set>] [--add <tok>] [--remove <tok>]` — permissions work **exactly like `users create`**: optionally seed from a role with `--permission-set` (`read-only`/`standard`/`admin` or a custom org set), then fine-tune with `--add`/`--remove`. Effective grants = `(set ∪ added) − removed`. For a narrowly-scoped key (the common case) just use `--add` with no set: `keys create ci-pipeline --add events:add`. Secret → stdout when piped. (There is **no** positional `PERMISSIONS` arg and **no** `-p` flag — those forms error.)
- `keys update <name> [--permission-set <set>] [--add <tok>] [--remove <tok>]` — incremental on the key's CURRENT grants (merges --add/--remove), unless `--permission-set` is given (which reseeds, then applies --add/--remove). `--yes`/`-y` to skip confirm. **Needs a signed-in user** — under a key it exits **2** with no request made, because `keys:update` is never assignable to a key. Every other `keys` subcommand works under a key that holds the matching grant.
- `keys disable <name>` — revoke.
- `keys regenerate <name>` — rotate secret (old one dies).

Permission token format (for `--add`/`--remove`): `slug:action` flat, or `slug:action.action` to expand several actions on one resource (e.g. `events:read.add` → `events:read`, `events:add`). Several via comma, repeated flag, or a quoted group: `--add events:read,keys:read` · `--add a --add b` · `--add "a b"`. Human-only perms (`keys:update`) can't be granted to a key. Unknown/malformed → exit 2.

## users
Referenced by **email** (UUID id also accepted).
- `users list [--show-id] [--active-only]` — `[lock] email · access · perms · joined · status`.
- `users show <email>` — identity + all grants.
- `users create [EMAIL] [--permission-set <set>] [--add tok] [--remove tok]` — `--permission-set` one of the builtin sets (`admin`/`standard`/`read-only`) or a custom set name (client-validated; unknown → exit 2). `--add`/`--remove` take compact permission tokens.
- `users update <email>` — assign a set, or incrementally `--add`/`--remove`. Predicts the resulting grants and confirms.
- `users disable <email>` / `users enable <email>` — disable has protected/self guards.

**Multi-token `--add`:** Click options aren't variadic — `--add a b` breaks. Use `--add a,b` (comma), `--add a --add b` (repeat), or `--add "a b"` (quoted).

## settings
A fixed registry — you read/inspect/change existing keys, you cannot create new ones.
- `settings list` — `key · value · type · updated` (secrets masked).
- `settings schema` — `key · type · accepts · description` (what each key accepts).
- `settings set <key> (--value V | --json-value JSON | --file f)` — exactly one value source. Unknown key → exit 6. No-op if unchanged. Server validation errors surface as `✗ <message>` (e.g. range bounds). Some keys are sensitive (signing secrets, sign-in allowlist) — confirm carefully.
  - `allowed_sign_ins` restricts which of the organization's members may sign in; it does not grant access to anyone else. An **empty list means no restriction** (every member can sign in), so clearing it widens access rather than removing it. A non-empty list admits only matching addresses and locks out every other member. Entries are exact addresses or `*@domain.tld`; a bare `*` is rejected — use an empty list. Saving a list that does not include your own address is refused, because you could not sign in again.

## audits
Scheduled sweeps over agent activity, and the **findings** they produce. Audits are referenced by **name** (UUID id also accepted); findings by **id** (short ids shown in the table, `--show-id` for the full ones).
- `audits list [--enabled-only] [--show-id]` — `created · name · every · findings · status · last run`; disabled audits are dimmed and the footer carries the on/off split plus the open-finding total.
- `audits show <name>` — identity + `schedule` / `scope` / `analysis` / `channels` cards. The creator and the raw `scope`/`channels` blobs live here and in `--json`, not in the list.
- `audits create <name> [--file f] [--description ...] [--enabled|--disabled] [--schedule-interval-secs N] [--schedule-anchor ISO8601] [--window-mode fixed|since_last] [--lookback-window-secs N] [--scope JSON] [--ignore-error-type <csv>] [--llm|--no-llm] [--top-k N] [--sensitivity low|medium|high] [--channels JSON] [--text ... | --text-file f] [--url URL]…` — everything but the name has a server default. Name collision is pre-checked (exit 2). No confirm (creating isn't destructive). `--text`/`--text-file`/`--url` attach the reference context **in the same request**, and that is the only way to be sure the first run has it: a new enabled audit is due immediately, so context set afterwards can miss it. Same caps as `context-set` (8192 chars, 5 URLs, public `https://`); a URL the guard refuses fails the whole create, so no half-made audit is left behind. `--json` returns `{id, created_at, sources}`.
- `audits edit <name> [--name ...] [same flags as create] [--yes]` — the server replaces the whole definition, so a flag-only edit re-sends the current audit with your change applied (needs read **and** write). Rename onto an existing name → exit 2. Confirms first.
- `audits delete <name> [--yes]` — amber preview (naming the findings and run history that go with it) + confirm.
- `audits run <name>` — queue a run **now**, ahead of schedule. Success means queued, not finished; a disabled audit or one already mid-run is refused with the server's explanation (exit 1). JSON `{"queued": true}`.
- `audits context-show <name>` — the operator brief plus every reference URL with its fetch state (chars stored, whether truncated, how many secret-shaped values were masked, whether the page carries phrases that read as instructions to an AI).
- `audits context-set <name> [--text ... | --text-file f] [--url URL]… [--clear-urls]` — the brief and the URL list are independent, and **whatever you omit is left alone**: `--text` alone keeps the current URLs, `--url` alone keeps the current brief. `--url` replaces the whole list. Removal is always explicit — `--text ""` clears the brief, `--clear-urls` drops every URL and its stored snapshot; passing both `--url` and `--clear-urls` is a usage error (exit 2). At least one of the four is required. Max 8192 chars and 5 URLs, public `https://` only — private, loopback and cloud-metadata addresses are refused at save with the reason (exit 1). Pages are fetched in the background, so this returns before the snapshot exists.
- `audits context-refresh <name>` — re-fetch every non-blocked reference URL now. Snapshots refresh weekly on their own; URLs the guard refused are never retried, because nothing about them can change until the URL does.

Context is a **separate sub-resource on purpose**: `audits edit` read-merges the definition from a fixed field list, so a brief carried in that body would be silently wiped by an unrelated flag-only edit. Writing it through `context-set` makes that impossible. Creation is the one exception, and only because of a race: the audit's first run is queued the instant its row is written, so context that follows in a second request can arrive after that run started. `audits create` therefore sends it inline and the server commits both together — `audits edit` still refuses it (exit 1), which is what keeps the read-merge harmless. `--file` bodies are filtered before they are sent, so `audits show --json > f && audits edit <name> --file f` round-trips cleanly even though `show` emits server-owned fields; sending `additional_context` or `reference_urls` to the definition endpoint by hand is refused rather than ignored.
- `audits runs <name> [--limit N] [--show-id]` — run history, newest first: `started · status · trigger · findings · new · took`. A failed run's `error` and each run's `stats`/`report` are in `--json` only.
- `audits findings [--audit <name>] [--run-id <id>] [--status <csv>] [--limit N] [--offset N] [--show-id]` — the triage queue, highest priority first: `id · title · severity · status · kind · seen · last`. With no `--status` you get the live set (open + recurring); valid statuses are `open recurring resolved dismissed muted`. `--audit` takes an audit **name**.
- `audits finding <id>` — one finding in full: identity + `analysis` (what + likely cause) + `recommendation` (do / impact / effort) + `scope` + `evidence`. Empty sections are omitted.
- `audits ack <id> [--reason ...]` — seen, stays visible, ranked lower. No confirm.
- `audits mute <id> [--reason ...] [--yes]` — stop surfacing this pattern in future runs (durable). Confirms first.
- `audits dismiss <id> [--reason ...] [--yes]` — judged not worth acting on; suppressed like mute. Confirms first.
- `audits resolve <id> [--yes]` — you fixed it. Leaves **no** suppression, so a genuine recurrence is raised as new. Confirms first.
- `audits reopen <id>` — back to `open` **and** clears any mute/dismiss suppression. The undo for the three above.
- `audits assign <id> --to <email>` — set the owner; the status is untouched. `--to` is required (exit 2 without it).

The title column truncates to whatever width is left so the fixed columns always survive — read the full text with `audits finding <id>` or `--json`. A bad `--status`, `--window-mode`, `--sensitivity`, a non-ISO-8601 `--schedule-anchor`, or an out-of-range `--schedule-interval-secs`/`--lookback-window-secs` is rejected before any request (exit 2). `--schedule-anchor` pins the fixed UTC slot runs land on (`anchor + N * interval`), so a slow run or `audits run` can't drift the cadence; omit it on create and the server uses the next 09:00 UTC. An unknown audit name → exit 6; an unknown or malformed finding id → calm `✗ no finding …`, exit 6. Reads need `audits:read`, every mutation `audits:write`.

**`audits run` is async — it only queues.** Success is `{"queued": true}`, not a finished run; the analysis can take minutes. Poll `audits runs <name>` until the newest row is `succeeded`/`failed` before reading `audits findings`, rather than assuming results exist on the call that queued them.

**Findings and issues are one bucket.** Every finding graduates to an issue (`source: audit`) that stores the finding's full content, so the same problem appears under both `audits findings` and `issues list`. Triage is consistent in **both** directions and needs `audits:write` either way: `audits resolve|mute|dismiss|ack|reopen <finding-id>` mirrors onto the linked issue, and `issues resolve <issue-id>` on an audit issue mirrors back onto the finding — the two never disagree. **resolve** leaves no suppression (a genuine recurrence reopens as new); **mute/dismiss** suppress the pattern org-wide by fingerprint.

## issues
The single board for everything needing human attention — alert breaches (`source: alert`), hand-raised issues (`manual`), and audit findings (`audit`). Referenced by id (short ids accepted, `--show-id` shows them). This group was **renamed from `incidents`**; the old name no longer exists. Reads and ack/comment need `issues:read`; opening, assigning, and subscribing others need `issues:create`; resolving needs `issues:close`.
- `issues list [--state firing|acknowledged|resolved] [--alert-id <id>] [--limit N] [--show-id]` — there is **no** `--severity` filter on this command.
- `issues count`
- `issues show <id>` — identity + comments + subscribers + **activity log** (read this before acting). An audit-born issue (`source: audit`) carries the full finding it graduated from and back-links to the audit/run.
- `issues ack <id>` · `issues assign <id> --assignee <member>` (repeatable; omit to clear all assignees; each must be an operator) · `issues resolve <id>` (calm confirm). **On an audit issue these stay in sync with the finding** — resolving the issue resolves the underlying audit finding, so it can't reappear on the next run (equivalently, triage it with `audits resolve <finding-id>`; both surfaces agree).
- `issues open --summary <text> (--title <text> | --alert-id <id>) [--title ...] [--severity ...]` — `--title` is **required** for a standalone issue (nothing to borrow a name from); with `--alert-id` it is optional and defaults to the alert's name. Missing `--title` on the standalone path → exit 2.
- `issues comment-add <id> (--body <text> | --file <path>)` — `--file -` reads stdin; exactly one of the two · `comment-list <id>` · `comment-delete <id> <comment-id>`
- `issues subscribe <id> [--email <addr>]` · `unsubscribe <id> [--email <addr>]` · `subscribers <id>` — `--email` defaults to you; naming someone else needs `issues:create`

Malformed (non-UUID) id → calm `✗ no incident …` exit 6. Assign to a non-operator → clean 422 message.

## query
Saved ClickHouse SQL + ad-hoc runner. Saved queries referenced by **name**.
- `query list [--fields ...] [--show-id]` — `name · description · created by · created`.
- `query show <name>` — metadata + syntax-highlighted SQL.
- `query create <name> --sql "…"|@file.sql [--description ...]` — name-collision pre-checked (exit 2).
- `query update <name> [--name ...] [--sql ...] [--description ...] [--yes]` — partial update (≥1 field).
- `query delete <name>` — amber preview + confirm.
- `query run <name> | --sql "…" [--limit N] [--all] [--arg VALUE]…` — arguments are **positional**, bound to `$1..$N` in the order given (`--param` is an alias of `--arg`; there is no `k=v` form — `--param agent_id=x` binds the literal string `"agent_id=x"` to `$1`). Adaptive render: scalar / record / table. JSON = full QueryResult (never capped). Exec/permission errors → clean `✗ query failed` + exit code.
- `query schema [TABLE]` — column layout; JSON `{schema, columns:[{table,column,type,nullable}]}`.

## agent
**Session-only, the whole group** — each subcommand exits 2 under a key, with no request made: a chat is private to the person who owns it, and a key is not a person.

Built-in assistant. Chats referenced by a **short chat-id** (first 8 hex; prefix-resolved).
- `agent health` · `agent models` (available models for `--model`, default marked).
- `agent chats` — `chat-id · title · messages · updated`.
- `agent ask "MESSAGE" [--chat <short-id>] [--model <m>]` — starts a new chat (prints its short id) or continues `--chat`. On a TTY the answer renders as Markdown; piped/non-TTY prints the raw answer to stdout.
- `agent show <short-id>` — transcript. `agent rename <short-id> --title "…"` · `agent delete <short-id>`.
- Ambiguous prefix → exit 2; unknown chat → exit 6.

## policies · fleet · guardrails
**Session-only, all three groups** — every subcommand exits 2 under a key, with no request made. These routes are absent from the versioned API an API key authenticates against; they are an operator surface.

Cloud-managed enforcement, split the way the dashboard splits it: `policies` writes a version, `fleet` decides which machines run it, `guardrails` reports what it blocked. Needs `policies:read` to read, `policies:write` to change anything.

### policies
- `policies list` — one row per published VERSION (versions are immutable and all stay addressable), newest of each policy first; the title counts distinct policies and captions the version total. `state` is active / disabled / archived. JSON `{policies:[…]}` — also every version, so deduplicate on `id` for one row per policy.
- `policies show <id>` — the NEWEST version, including the full `source`.
- `policies publish <id> [SOURCE] [--description "…"] [--no-verify]` — mints a **new version**; never edits one. SOURCE is a path, `@path`, `-`, a pipe, or omitted to paste on a TTY (Ctrl-D ends). The source is **parse-checked with node** before it is sent; nothing downstream does this, and a broken policy otherwise fails on the machine at enforcement time. `--no-verify` skips it, and a host without node publishes with a warning rather than a block. **Publishing deploys nothing** — the version is unused until `fleet deploy` puts it on a machine.
- `policies enable <id>` · `policies disable <id> [-y]` — **disable REMOVES the policy from every deployment carrying it**, reissuing each affected machine at a new generation (visible in `fleet history`). `enable` is the exact inverse — it puts the policy back into every deployment it was removed from, reissuing those machines again. Nothing needs redeploying by hand, and `machinesUpdated` in the JSON reports the count for both directions.
- `policies test [SOURCE] [--tool Bash] [--command "…"] [--file PATH] [--event PreToolUse] [--expect allow|deny|instruct]` — run a policy LOCALLY and print what it decides. Executes the real file (bare `import { deny } from "failproofai"` and all) against a synthetic context; nothing is published, nothing installed. Needs `node`. `--expect` asserts the decision and exits 1 when it differs — a correct `deny` is a PASSING test, so the decision alone never sets the exit code. JSON `{ok, decision, policies:[{name,decision,reason}], expected, met}`; `decision` is the strictest any registered policy returned.
- `policies compose "<description>" [--out FILE] [--publish ID]` — the assistant drafts policy source from plain English. Prints it and stops by default: a generated policy that deploys itself is one nobody read. `--publish` still syntax-checks first. Needs `policies:write` for BOTH the draft and the publish — `POST /api/agent/compose-policy` is `withAuth("policies:write")`; `agent:use` gates the assistant's other routes and is not checked on this one. The composer has a **30s server-side limit** — a long or vague description simply does not finish, and raising `--timeout` does not help because the cut is not client-side. Retry with something shorter and more specific.
- `policies delete <id> [-y]` — archives. **A machine already carrying the policy keeps enforcing it** until redeployed; `disable` is what stops enforcement everywhere.

### fleet
- `fleet list` — `machine · label · pol · intended · applied · seen · events · state`. `intended` is the generation deployed, `applied` what the machine last collected (they differ until it polls), and `seen` how long since it last reported anything — a machine can be in sync and dead, or alive and behind, which are different problems. JSON `{machines, deployments}` with raw epoch-ms timestamps plus the computed `drifted`.
- `fleet show <machine>` — the set the machine is told to run, **and whether it has collected it**. Reads both the deployment and the machine record, so it reports `not yet collected` / `machine is on #N` / `collected` alongside who deployed it, when, and last-seen. A machine can be told to run a policy it has never picked up; the policy list alone cannot tell you which. JSON `{machine, deployment}` with raw timestamps and both label fields; `deployment: null` when nothing is deployed.
- `fleet deploy <machine> [--add REF]… [--remove ID]… [--set REF]… [--create] [-y]`

  **A deploy REPLACES the whole set.** The endpoint takes the full list and does not merge. `--add`/`--remove` are a read-modify-write: the CLI reads the current set, applies the delta, prints the complete result, writes that. `--set` replaces everything and is refused alongside `--add`/`--remove`.

  REF is `id`, `id@version`, `id:effect`, or `id@version:effect`. Effect is `enforce` (default) or `observe`. A bare `--add` of an already-deployed policy **keeps its pinned version** — pass `id@version` to move it.

  Deploying to an id that has never checked in is refused (a typo would mint a machine); `--create` allows it for pre-staging.

  **Races.** No server-side lock. The CLI records the generation it read and exits non-zero if the write does not land at exactly one higher — somebody else deployed, and a replace does not merge. Re-read with `fleet show` and retry.

  **Idempotent.** Re-running the same deploy is a no-op that exits 0 without writing — desired-state semantics, so a retrying harness succeeds rather than errors. `applied` in the JSON is the only way to tell "changed it" from "already matched"; the exit code is 0 for both. The no-op short-circuits before the write, so a reader without `policies:write` also gets 0 there — exit 0 from a no-op is not proof of write access.

  **Exit codes.** A malformed ref (`bad ref!!`, `id:banana`, empty), or `--set` combined with `--add`/`--remove`, is a usage error → **exit 2**, like every other bad flag value. A ref that parses but names something that does not exist (`--add ghost-policy`, an unpublished `@version`) is **exit 1**; an unknown machine is **exit 6**. Branch on these rather than on the message.

  JSON `{plan:{result,added,removed,changed,unchanged,noop}, deployment, applied}` — the plan is included so a harness does not recompute the diff.
- `fleet diff [machine]` — intent vs delivery per machine, with a `drifted` flag. A machine id nobody has reported under is refused (exit 6), not rendered as an empty fleet.
- `fleet history <machine>` · `fleet rollback <machine> <generation> [-y]` — rollback mints a NEW generation carrying the old set; history stays append-only. The `change` column uses the deploy plan's vocabulary: `+` added, `-` removed, `~` same policy at a different version or effect (an enforce → observe flip is a policy that stopped blocking, so it is never "no change").
- `fleet rename <machine> "<label>"` — a human label; the id never changes. The server stores it as an override beside the machine's self-asserted label. An empty label **clears** the override (the machine falls back to its own label, else its id) and the CLI says so rather than reporting a rename to nothing. A machine that has never checked in cannot be renamed → exit 6.

### guardrails
- `guardrails summary [--since 1h|6h|24h|7d] [--machine ID]` — coverage, blocked/evaluated totals, a deny sparkline, and the per-policy table. Bare `fp guardrails` prints help, like every other group; the flags live on the subcommands.
- `guardrails timeline [--since …] [--machine ID]` — one row per time bucket: a bar scaled to the busiest bucket with the blocked share in red, plus total / denied / instructed counts. Answers *when* enforcement bit, which the summary's sparkline only sketches.
- A `(no policy)` row is **normal**: most evaluations are allows nothing objected to, and the row keeps the denominator visible.
- Coverage comes from the control plane, decision counts from reported telemetry — a machine can be deployed-to and silent, or reporting and undeployed.
