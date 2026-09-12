# Sourcing policy work from AgentEye

[AgentEye](https://app.befailproof.ai) is the observability side of the same story: failproofai
enforces inside the agent loop, AgentEye records what happened across the fleet. Where the
local `failproofai audit` reads one machine's transcripts, AgentEye holds every session from
every agent in an org — so it sees things a local audit structurally cannot.

Everything here was verified against a live deployment (org `demo`, `agenteye` 0.1.13).

## Preflight

```bash
agenteye whoami            # exit 4 = not logged in; you cannot fix this — see below
```

If not logged in, **stop and ask the user to run `agenteye login --email <them>`** — it needs
a one-time code emailed to them, so you cannot complete it. Note the permissions `whoami`
prints; they decide what you may do at the end (see "Closing the loop").

Add `--json` to **every** command — it prints machine-readable output and nothing else.

## Four sources of policy work

AgentEye answers four different questions. Check all four; they produce different work — and
two of them produce no policy at all, which is a result worth reporting rather than a dead end.

### 1. Findings already classified as policy-shaped

AgentEye tags each finding with a `kind`. **`kind: policy` means it is enforceable** —
`improvement` and `failure` are code or instrumentation work and are not yours.

```bash
agenteye --json audits findings --limit 100 --show-id \
  | jq '.findings[] | select(.kind == "policy") | {id, title, severity, status}'
```

`--show-id` is not optional: `audits finding <id>` **requires the full UUID**. The short id
in the table looks usable and is rejected with `no finding <id>`, exit 6 — the CLI reference
says short ids are accepted, and for this subcommand they are not.

Then read one in full:

```bash
agenteye --json audits finding <FULL-UUID>
```

The fields that matter:

| Field | Use |
|---|---|
| `description` / `root_cause_hypothesis` | what happened and why — the policy's rationale |
| `recommendation` | AgentEye's own fix. Often names the mechanism ("add a pre-tool-use hook that rejects…") |
| `evidence.queries` | **runnable SQL, often containing the exact regex** |
| `evidence.policy_id` | AgentEye's internal rule id, e.g. `secret.credential_in_tool_args` |
| `scope` | narrows it — e.g. `{"tool": "db.query"}` |
| `occurrences`, `evidence.matched_sessions` | how much this actually happens |

A real one, verbatim: *"Credential-shaped strings passed to db.query in production"*, whose
evidence query carries `match(payload, '(AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})')`.
That regex is the pattern to enforce — but **run it through §2.1 builtin-first anyway**:
`sanitize-api-keys` and `sanitize-bearer-tokens` already cover those two shapes, so the
answer is mostly config, and a custom policy only covers what the builtins miss.

### 2. Hook failures — policies that are silently enforcing nothing

**The one thing a local audit can never tell you.** failproofai fails open (`traps.md` §3):
a policy that throws or times out returns allow, and nothing surfaces. Locally that is
invisible. AgentEye records every hook outcome, so the gap is a query:

```bash
agenteye --json query run --sql "
  SELECT JSONExtractString(payload,'hook_name') AS hook,
         JSONExtractString(payload,'outcome')   AS outcome,
         count() AS c
  FROM events
  WHERE event_type = 'hook_completed'
    AND JSONExtractString(payload,'outcome') NOT IN ('ok','approved')
  GROUP BY hook, outcome ORDER BY c DESC LIMIT 20"
```

Live demo output included `pre_tool_use failed 877` and `pii_redactor failed 702`. Every one
of those is an action that ran **unguarded** while the dashboard showed a hook installed.

This is not a policy to author — it is a **broken policy to report**. Tell the user which
hook is failing and how often, and treat fixing it as higher priority than any new policy:
a policy that fails 877 times is worth less than nothing, because it looks like protection.

### 3. Denial patterns — policies that are too strict

A high denial count means one of two very different things, and **the raw count cannot tell
you which** — you must measure the *distribution across sessions* before drawing any
conclusion. AgentEye's own finding text says denials mean an agent is "burning a turn each
time", which presumes a retry loop; that is one of the two cases, not the default.

| Shape | Meaning | Fix |
|---|---|---|
| Denials **concentrated** — few sessions, many denials each | an agent stuck retrying something it will never be allowed | the rule is right; the agent needs to be *told* what to do instead → `instruct` |
| Denials **spread** — many sessions, ~1 denial each | the rule is contested broadly, i.e. **mis-scoped** | narrow the rule, or downgrade to oversight |

Measure it rather than assuming — this query gives the distribution, not just the total:

```bash
agenteye --json query run --sql "
  SELECT denials_per_session, count() AS sessions FROM (
    SELECT session_id, count() AS denials_per_session
    FROM events
    WHERE event_type = 'hook_completed'
      AND JSONExtractString(payload,'outcome') IN ('denied','blocked')
    GROUP BY session_id)
  GROUP BY denials_per_session ORDER BY denials_per_session"
```

Live result from the demo org: **76.3% of affected sessions had exactly one denial**, 21.6%
had two, and the maximum was four. That is the *spread* shape — a mis-scoped rule — and a
report calling it a retry loop would be wrong on the mechanism even while landing on the
right fix. A blind agent made exactly that error against this data, so state the distribution
in your report, not just the total.

One caveat before recommending any change: a human-approval gate (`approval.tool_use`) is
*supposed* to deny sometimes. A non-zero denial rate there is the control working, not a
defect. Ask whether the denials cluster on a handful of tool/argument shapes before
proposing anything.

### 4. The issues board — read it, but classify before believing it

Issues are AgentEye's **human attention queue**, not a behaviour log. Three sources feed it,
and only one reliably contains policy work:

```bash
agenteye --json issues list --limit 100 --show-id
```

| `source` | What it is | Policy material? |
|---|---|---|
| `audit` | a finding that graduated — same content, back-linked | **Yes** — follow `source_finding_id` and treat it as §1 |
| `alert` | a configured metric crossed a threshold | **Almost never** — see below |
| `manual` | a person opened it, free text | **Sometimes** — depends entirely on what they wrote |

**Why alert-born issues are usually not yours.** An alert fires on a *number*: p95 latency,
error rate, eval score, token burn. A policy gates a *tool call before it runs*. Those are
different axes, and no policy can move a latency percentile. Measured on a live deployment:
**0 of 11 issues were policy-actionable** — every one was a metric breach whose resolution
comments read "revert the prompt", "tune down retries", "fix the downstream service".

Check `trigger_kind` and `breach_summary` before spending any effort: `eval_compound`,
`error_rate`, `latency_p95`, `token_burn` are all metric triggers and none of them describes
an action a hook could have stopped.

**Manual issues are free text**, so treat them exactly like the complaint path — does the
text describe a *behaviour* ("the agent keeps writing to prod config") or a *measurement*
("checkout latency is up")? Behaviour goes through the §3 rules-file classification; a
measurement does not become a policy no matter how it is phrased.

**Audit-born issues are the ones worth chasing**, because they are findings in a different
wrapper:

```bash
agenteye --json issues list --limit 100 --show-id \
  | jq '.issues[] | select(.source == "audit") | {id, title, source_finding_id}'
```

Then `agenteye --json audits finding <source_finding_id>` and you are back in §1.

**A caveat worth checking in the target org.** The CLI reference states every finding
graduates to an issue, but on the live deployment tested here **no issue carried a
`source_finding_id` and no `kind: policy` finding carried an `issue_id`** — the two surfaces
were entirely disconnected. If the same is true wherever you are running, do not conclude
there is no policy work because the issues board looks operational; go to `audits findings`
directly. Say so in the report, because a disconnect there means audit findings are never
reaching the board the team actually watches.

## Getting the actual commands

A policy must match real input, and its tests need real payloads (§2.4). Two routes:

```bash
# a) the finding's own evidence query, bounded
agenteye --json query run --sql "<evidence.queries[0]> LIMIT 20"

# b) raw payloads for a cited session
agenteye --json events --full --session-id <SESSION_ID> --all --limit 1000 \
  | jq '.events[].payload'
```

**`--full` is the only way to get `payload`** and it hits a heavy endpoint — always bound it
to a session, never sweep unbounded.

**An evidence query returning zero rows does not mean the finding is wrong.** Verified live:
the credential finding cites 1424 matched events, yet its evidence query returns nothing,
because the demo's seeded findings and seeded events were generated separately. When that
happens, fall back to the patterns named in the finding text itself, and say in your report
that the policy was built from the finding's description rather than from observed payloads —
that is a real difference in confidence.

## Then: author it and plug it in

From here it is §2 unchanged — **check builtins and their params first**, pick a mode, name
the file `*policies.mjs`, test both directions with `scripts/test-policy.mjs`. AgentEye
changes where the work comes from, not how a policy gets written.

"Plugging it in" is two concrete edits in the target project, and neither touches AgentEye:

```
.failproofai/policies/<name>-policies.mjs     the custom policy (filename convention — traps.md §1)
.failproofai/policies-config.json             `enabledPolicies` for any builtin that covers a finding
```

Nothing about this needs an AgentEye permission — a failproofai policy is a local file plus a
config entry. Then prove both took effect, because neither is self-evident:

```bash
# the custom file actually loads (fail-open hides a file that never loaded — traps.md §3)
node "$SKILL_DIR/scripts/test-policy.mjs" --policy .failproofai/policies/<name>-policies.mjs \
  --cwd . --event PreToolUse --tool Bash --input '{"command":"<should-deny case>"}' --expect deny

# an enabled builtin fires against the REAL project config (omit --policy)
node "$SKILL_DIR/scripts/test-policy.mjs" --cwd . \
  --event PreToolUse --tool Bash --input '{"command":"sudo ls"}' --expect deny
```

Record which AgentEye finding each policy came from, in the file itself, so the two systems
stay traceable to each other:

```js
// derived-from: AgentEye finding a41243c4-01fe-4f88-871e-a41bc148906d
// "Credential-shaped strings passed to db.query in production" (org demo, 2026-07-27)
```

One extra step worth taking: AgentEye knows which tools actually exist in the fleet.

```bash
agenteye --json list tools      # also: agents, envs, event_types, hooks, error_types
```

A policy matching a tool name no tool ever emits is dead on arrival, and this is the cheapest
way to catch that before shipping it.

## Closing the loop

After a policy is installed and tested, the finding should not sit open forever. But:

**Do not run the triage commands yourself.** Two independent reasons:

1. `agenteye`'s confirm prompts **auto-skip on a non-TTY — which is exactly how you run it**.
   `audits resolve <id>` executes immediately, with no chance to catch a wrong id, on a board
   the user's whole team shares.
2. Triage needs `audits:write`, which a read-only account does not have (the live demo
   account has `audits:read` only — check `whoami` before assuming).

So **print the commands and let the user run them**:

```bash
agenteye issues comment-add <ISSUE_ID> --body "Enforced by failproofai policy \`<name>\` in .failproofai/policies/<file> — denies <what>, verified with N cases."
agenteye audits resolve <FULL-FINDING-UUID>
```

`resolve` leaves no suppression, so a genuine recurrence reopens as new — the right verb once
enforcement exists. `mute`/`dismiss` suppress the pattern permanently and are the wrong choice
here. Every finding carries an `issue_id` linking to its issue; triage on either surface
mirrors onto the other.

## What to report

Same honest split as everywhere else, plus one AgentEye-specific line:

- **enforced now** — new policies + builtins enabled, with the finding each came from
- **already covered** — findings a builtin already handles
- **broken enforcement** — hooks failing (source 2). Call these out first; they are live gaps.
  Give the **fleet-wide aggregate** (`failed / total = N%`) alongside per-hook counts — raw
  counts alone undersell the systemic scale (live: 10,736 of 202,645 = 5.3%)
- **too strict** — deny-mode policies that should be oversight (source 3)
- **not policy work** — `kind: improvement` / `failure` findings, and alert/metric issues.
  Name them and say why, so the user can see they were read rather than skipped
- **to close** — the exact `comment-add` / `resolve` commands, for the user to run
