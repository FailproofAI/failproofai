---
name: policy-author
description: Triage `failproofai audit` findings and author failproofai policies that stop coding agents misbehaving. Use in four cases. (1) An audit just ran and its findings need turning into fixes. (2) The user describes something an agent keeps doing wrong and wants it prevented — "my agent keeps force-pushing", "it deleted my files again", "stop it committing straight to main", "how do I stop it doing X" — they are describing a problem, not asking for a policy, and may not know policies exist. (3) The user explicitly asks to write, create, or add a policy. (4) The user wants the rules in a CLAUDE.md, AGENTS.md, or system-prompt file actually enforced — "agents keep ignoring my CLAUDE.md", "make my rules file strict", "turn my instructions into enforcement". Covers enabling an existing builtin (usually the right answer) as well as writing new custom policy files.
---

# Authoring failproofai policies

Four ways you get here. All converge on the same authoring core (§2).

**1. Automatically, after an audit.** A `PostToolUse` policy fires when `failproofai audit`
runs and instructs the agent to come here. The findings are already sitting in the cache —
**start at §1** and triage them. This is the primary path: the audit knows what went wrong,
so it should not be on the user to notice and ask.

**2. The user describes a problem.** *"My agent keeps force-pushing."* *"It deleted my files
again."* *"How do I stop it committing to main?"* They are reporting a failure, not
requesting a policy — most users do not know policies exist. Translate the complaint into a
rule, then **go to §2**. Do not make them specify events or tools; infer from the behavior
and confirm at the end.

**3. The user asks for a policy outright.** *"Write a policy that blocks X."* Straight to §2.

**4. The user has a rules file agents keep ignoring.** *"Agents keep skipping what's in my
CLAUDE.md."* Prose rules are advisory — the agent reads them (maybe) and forgets them under
context pressure. Policies are enforcement. Extract the rules, classify what is enforceable,
and turn that subset into policies — **§3** has the procedure and the classification table.

For 2, 3 and 4, still check the audit cache if one exists — it often shows the behavior is
already happening and gives you real commands to use as test cases (§2.4).

The single most common mistake is writing a custom policy when a builtin already covers
the case and just needs enabling. Always check coverage before authoring.

---

## 1. Audit-driven triage

**One finding, or all of them?** If the user names a single finding — by its policy name
(`git-commit-no-verify`), by description ("the one about `--no-verify`"), or by pointing at
a row in the dashboard — do **not** run the full triage. Handle just that one:

1. Look it up in the cache by name, or by matching its `displayTitle` / `examples[]`
   against what they described.
2. Read its `examples[]`. These are **real commands from their machine** — the single most
   valuable thing the audit gives you. They become the should-fire cases in §2.4 (should-deny
   for a block-mode policy, should-instruct for oversight), which means the finished policy
   is proven against what actually happened rather than against invented input.
3. Pick the mode from the finding's severity class (§2's mode table): deny-class findings
   get `deny()`, warn-class get `instruct()` oversight. **State the choice in one line and
   offer the other mode** — "went with oversight since this has legitimate uses; say the
   word for a hard block." The user asked for enforcement; which flavor is their call.
4. Check whether a builtin covers it (§2.1). If yes and it is off, that is a config line,
   not a policy.
5. Otherwise author it (§2), test against those examples, report back.

Mention what else is unaddressed in one line at the end — do not expand into a full triage
they did not ask for.

Only run the full §1.1–1.4 sweep when they ask broadly: "what should I do about my audit",
"harden this repo", "fix these findings".

### 1.1 Read the findings

There is **no machine-readable output flag**. `RunAuditOptions` declares `--json`, `--since`,
`--cli`, `--project`, `--limit` and more, but `runAuditCli` parses only `--help` — every
other argument is rejected outright (`failproofai audit --json` errors). The one programmatic
path is the dashboard cache, which every audit run writes:

```bash
cat ~/.failproofai/audit-dashboard.json
```

**The cache is the only source, and it can be arbitrarily old.** Check `cachedAt` before
trusting anything in it:

```bash
bun -e 'const j = await Bun.file(process.env.HOME + "/.failproofai/audit-dashboard.json").json();
const age = (Date.now() - Date.parse(j.cachedAt)) / 86400000;
console.log(`cached ${j.cachedAt} (${age.toFixed(1)} days ago), ${j.result.results.length} findings`);'
```

More than a day or two old and the findings describe past behavior, not current — say so
rather than presenting it as the live picture.

**Refreshing it is awkward.** `failproofai audit` writes the cache and then starts a
dashboard server on port 8020 and opens a browser, so it never exits on its own. Prefer
asking the user to run it. If you must refresh unattended, the cache is written *before* the
server starts, so a timeout gets you fresh data without leaving a server running:

```bash
timeout 180 failproofai audit >/dev/null 2>&1 || true   # exits 124; cache is written
```

Do that only when the user has asked for fresh findings — it can take minutes on a large
history (423 transcripts took ~50s here) and it opens a browser tab.

If the file does not exist at all, the user has never run an audit. Ask them to, rather than
running it for them.

**The `AuditResult` is nested under a cache envelope.** The file is
`{schemaVersion, cachedAt, params, result}` — the findings are at **`.result.results[]`**,
not `.results[]`:

```bash
bun -e 'const j = await Bun.file(process.env.HOME + "/.failproofai/audit-dashboard.json").json();
for (const c of j.result.results.sort((a,b)=>b.hits-a.hits))
  console.log([c.name.replace("failproofai/",""), c.source, c.hits, c.projects, c.enabledInConfig].join(" | "));'
```

Each entry in `.result.results[]` is an `AuditCount`. The fields that matter for triage:

| Field | Use |
|---|---|
| `name` | Builtins are **canonical-prefixed** (`failproofai/block-rm-rf`); detectors are bare. Strip the prefix before matching against config |
| `source` | `"builtin"` = a real policy that *would have* fired; `"audit-detector"` = audit-only pattern |
| `hits`, `projects` | How much this actually happens — prioritize by this |
| `examples[]` | **Real payloads from this machine.** These become your test cases in §2.4 |
| `enabledInConfig` | **Do not trust this** — see below. Always `false` for detectors |

**`enabledInConfig` is a stale snapshot.** It records the merged config as it was *at audit
time*, and the cache persists indefinitely. Observed on this machine: the audit cached at
20:14 reported all 39 builtins enabled; the global config was emptied at 20:19, five minutes
later. Every finding still claims `enabledInConfig: true`.

Always re-read the current config before classifying:

```bash
cat .failproofai/policies-config.json 2>/dev/null          # project scope
cat ~/.failproofai/policies-config.json 2>/dev/null        # global scope
```

`enabledPolicies` is a **union** across project, local and global
(`hooks-config.ts`, grep `enabledSet`) — not precedence. A policy is on if *any* scope lists it.

**Scope matters more than it looks.** The audit spans every project on the machine, but a
project-scope config protects only one. If findings span many projects and enforcement lives
in a single project config, the honest conclusion is that most of those hits are still
unprotected — and the fix belongs in the **global** config, not a project one.

### 1.2 Sort every finding into one of three buckets

**Bucket A — a builtin covers it and is off.** Do not write code. Add the short name to
`enabledPolicies` in `.failproofai/policies-config.json`. This is the cheapest and most
maintainable fix, and it is the right answer for most `source: "builtin"` findings.

**Bucket B — a builtin covers it and is already on.** No action. Report it so the user knows
the finding is historical, not ongoing.

**Bucket C — nothing genuinely covers it.** Author a custom policy (§2).

### 1.3 Do not trust `DETECTOR_TO_POLICY`

`src/audit/findings.ts`, grep `DETECTOR_TO_POLICY` maps every audit-only detector to some builtin, and its own
header comment explains why: so that "every finding looks like it has a failproofai fix."
Several of those mappings do not actually prevent the behavior. Judge coverage yourself:

| Detector | Maps to | Real coverage |
|---|---|---|
| `redundant-cd-cwd` | `warn-repeated-tool-calls` | **None** — unrelated heuristic. Bucket C |
| `prefer-edit-over-sed-awk` | `warn-repeated-tool-calls` | **None**. Bucket C |
| `prefer-edit-over-read-cat` | `block-read-outside-cwd` | **None** for in-cwd reads. Bucket C |
| `prefer-write-over-heredoc` | `block-env-files` | Only the `.env` subset. Bucket C for the rest |
| `find-from-root` | `block-read-outside-cwd` | Partial — that policy is about file reads, not `find` |
| `sleep-polling-loop` | `warn-background-process` | Partial |
| `git-commit-no-verify` | `warn-git-amend` | **None** — different command |
| `reread-after-edit` | `warn-repeated-tool-calls` | Partial — only if params are identical |

So most audit-only detectors are Bucket C. That is the gap this skill exists to fill.

### 1.4 Present the triage before acting

Show the user the three buckets with hit counts, then act. For Bucket A, propose the
config diff rather than silently editing — enabling enforcement changes what their agent is
allowed to do. For a single explicit request ("turn on block-rm-rf"), just edit it.

**Never widen scope on your own initiative.** These three are off-limits without the user
asking for them in the current request:

| Action | Why it needs asking |
|---|---|
| `failproofai policies --install` at **user scope** | Wires hooks into *every* project on the machine, not the one they are in |
| Editing `~/.failproofai/policies-config.json` | Global config; a deny there fires everywhere |
| Setting `customPoliciesPath` globally | Silently activates policy files across all projects |

A question — *"what should I do about my findings?"*, *"is this protected?"* — asks for an
answer, not a change. Recommend the machine-wide fix in words and let them decide. Being
right about what should happen is not authorization to make it happen.

Project-scope edits inside the repo the user is working in are fine when they asked for a
fix. The line is **scope**: their repo, yes; their machine, ask first.

---

## 2. The authoring core

**Arriving from a complaint?** Translate it into a concrete tool call first — a policy can
only match what actually crosses the wire. Common mappings:

| What the user says | What to match on |
|---|---|
| "keeps force-pushing" | `Bash`, `command` =~ `git push --force` / `-f` |
| "deleted my files" | `Bash`, `command` =~ `rm -rf` |
| "commits straight to main" | `Bash`, `git commit` + current branch check |
| "reads my secrets / .env" | `Read`/`Bash`, `file_path` or `command` =~ `.env` |
| "installs junk globally" | `Bash`, `command` =~ `npm i -g`, `pip install`, … |
| "edits generated files" | `Write`/`Edit`, `file_path` =~ lockfile / `dist/` |
| "leaks keys into chat" | `sanitize-api-keys` + `additionalPatterns` param first; else a `PostToolUse` sanitizer (blocks the output — `message` is inert, `traps.md` §9) |

If the mapping is not obvious, ask for the command they actually saw, or pull it from the
audit cache — `examples[]` holds real invocations and doubles as your test cases (§2.4).

Two judgment calls to make before writing, and to state back to the user at the end:

- **Which of the three modes?** failproofai does not only block. Match the builtins:

  | Mode | Helper | Name it | When |
  |---|---|---|---|
  | block | `deny()` | `block-*` | irreversible, no legitimate use |
  | **oversight** | `instruct()` | `warn-*` | risky but sometimes right — *"STOP: … Confirm with the user before executing."* |
  | sanitize | raw deny object (blocks output; `message` inert — traps.md §9) | `sanitize-*` | secrets in tool output |

  Default to **oversight** when the action has any legitimate use. Blocking those just gets
  the policy disabled. See `patterns.md` for the exact voice the builtins use — copy it.
- **Scope.** Project config protects one repo; user scope (`~/.failproofai/policies/`)
  applies everywhere. "My agent keeps doing X" usually means *everywhere*, not *here*.

### 2.1 Check the builtins first

Read `references/builtins.md`. All 39 builtins with their categories, default state, events
and parameters. If one matches, enabling it beats writing a new file every time.

Many builtins take `params` (allowlists, thresholds, protected branches) that go in the
`policyParams` map — a parameterized builtin often covers a case that looks custom.

Then check the project's **existing custom policies** — `ls .failproofai/policies/` and
read their `name`/`description` lines. Coverage is not only builtins: a hand-written policy
may already enforce exactly what you were about to author, and a duplicate means two
policies firing on every matching event.

### 2.2 Choose the event and tool

Read `references/api.md` for `PolicyContext`, the decision helpers, and the full event list.

Rules of thumb:
- Blocking an action before it happens → `PreToolUse`
- Redacting or reacting to output → `PostToolUse`
- Gating the end of a turn → `Stop` (but see `references/traps.md` §6 — unsatisfiable Stop gates — before using this in
  this repo)

### 2.3 Write the file

Location: `.failproofai/policies/` in the project.

**The filename must end in `policies.js`, `policies.mjs`, or `policies.ts`.** A file named
`block-foo.mjs` is silently skipped and enforces nothing. Name it `block-foo-policies.mjs`.
This is the highest-frequency failure in the whole system — see `references/traps.md` §1.

See `references/patterns.md` for worked examples per event type.

### 2.4 Verify it actually fires

Loading and execution are both fail-open — a broken policy is indistinguishable from a
working one unless you test it. Never report a policy as done without this step.

Use the bundled runner:

```bash
node .claude/skills/policy-author/scripts/test-policy.mjs \
  --policy .failproofai/policies/my-policies.mjs \
  --event PreToolUse --tool Bash \
  --input '{"command":"sudo rm -rf /tmp/x"}' --expect deny
```

Or a batch, which is what you want once there is more than one rule — `{{cwd}}` in an input
expands to the sandbox path:

```json
[{ "name": "blocks sudo", "event": "PreToolUse", "tool": "Bash",
   "input": {"command":"sudo ls"}, "expect": "deny" },
 { "name": "allows plain ls", "event": "PreToolUse", "tool": "Bash",
   "input": {"command":"ls"}, "expect": "allow" }]
```

```bash
node .claude/skills/policy-author/scripts/test-policy.mjs --policy <file> --cases cases.json
```

With `--policy`, the file is copied into a throwaway directory that acts as both project and
HOME — so `customPoliciesEnabled: false`, the real project config, and user-scope policies
cannot affect the result. It also **renames the file if it violates the loader convention**
(§2.3) and says so. Omit `--policy` to test the current directory's real config instead.

Exit code is 1 if any `--expect` fails, so it drops straight into a script.

Underneath it is just the documented stdin protocol, if you need it by hand:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo rm -rf /tmp/x"},"session_id":"test","transcript_path":"/dev/null","cwd":"'"$PWD"'"}' \
  | node scripts/dev-hook.mjs --hook PreToolUse
```

**Read stdout, not the exit code.** Both outcomes exit 0:

| Outcome | stdout |
|---|---|
| Denied (`PreToolUse`) | `{"hookSpecificOutput":{…,"permissionDecision":"deny","permissionDecisionReason":"…"}}` |
| Denied (`PermissionRequest`) | `{"hookSpecificOutput":{…,"decision":{"behavior":"deny","message":"…"}}}` |
| Instructed | `{"hookSpecificOutput":{…,"additionalContext":"Instruction from failproofai: …"}}` |
| Allowed | *(empty)* |

**Deny is not one shape.** `PreToolUse` uses `permissionDecision`; `PermissionRequest` uses
`decision.behavior`; `instruct` uses `additionalContext`; the non-Claude CLIs use flat
`{decision:"block"}` or `{permission:"deny"}`, and Factory signals deny by exit code 2 with
the reason on stderr. Grepping for a single key will under-report blocks — this exact
mistake produced a false FAIL during testing. `test-policy.mjs` handles all of them.

To test without touching the project's own config, build a throwaway project directory with
its own `.failproofai/policies/` and `policies-config.json`, and point the payload's `cwd`
at it. Project-scope discovery keys off that `cwd`, so the policy loads in isolation.

Test both directions: a payload that **should** be denied, and a near-miss that **should**
be allowed. A policy that denies everything passes the first test.

Two ways this test can lie to you:

- **Empty output proves nothing on its own.** It is the same result whether your policy
  allowed correctly, threw, timed out, or was never loaded. Always pair it with a
  should-deny case that actually produces output.
- **A deny does not prove *your* policy denied.** Every enabled policy sees the event, so
  another one may have fired — a rule matching nothing can hide behind a green suite. Assert
  on text unique to your policy's reason, or test with `enabledPolicies: []`. See
  `traps.md` §4; this happens more often than it sounds.

Use the `examples[]` from the audit finding as your should-deny cases — they are real
commands from this machine, so they prove the policy catches what actually happened.

### 2.5 Confirm the policy is actually live

Do **not** rely on `customPoliciesEnabled` in `.failproofai/policies-config.json` — that flag
is a no-op and disables nothing (`traps.md` §2). The only reliable check is the one you
already did in §2.4: run the hook and look at stdout.

What genuinely stops a policy from running: the filename convention (§2.3), a load-time
throw, or hooks not being installed for the CLI at all. Verify with:

```bash
failproofai policies --list
```

---

## 3. Enforcing a rules file (CLAUDE.md / AGENTS.md / system prompts)

Prose rules are advisory: the agent reads them at session start and drops them under
context pressure. Policies fire on every tool call regardless of what the model remembers.
This path converts the enforceable subset of a rules file into policies — and is honest
about the rest.

### 3.1 Extract

Read the file. Pull out every rule stated as *behavior* — quote each verbatim and note its
section heading. Skip background prose, architecture notes, and anything descriptive.

### 3.2 Classify

Sort each rule using the table in `references/rules-files.md`. The short version:

| Rule language | Class | Becomes |
|---|---|---|
| "never X" / "do not X" — tool-shaped | hard rule | `block-*` deny, or a builtin |
| "always X before Y" — ordering | workflow gate | PreToolUse check **on Y** (prefer over Stop gates) |
| "prefer X over Y" / "avoid Y" | preference | `warn-*` `instruct()` nudge |
| "file/config must contain Z" | repo invariant | a **test in the test suite** — not a policy |
| style, judgment, tone | unenforceable | stays prose; say so |

Two classes here are easy to get wrong. Repo invariants ("configs must use the launcher
form") are about file *states*, and policies see tool *calls* — recommend a test, don't
force a policy. And workflow rules enforce best at the **action they gate** (`gh pr create`,
`git commit`), not as Stop gates — tighter feedback, no loop risk (`traps.md` §6).

### 3.3 Check coverage — builtins AND existing custom policies

Rules files are exactly where hand-written policies come from, so the rule you are about to
enforce may already be enforced. Check `references/builtins.md` (with params — §2.1), then
read the project's existing custom policies:

```bash
ls .failproofai/policies/ && grep -h "name:\|description:" .failproofai/policies/*policies.mjs
```

A rule already covered goes in the report as covered — writing a duplicate policy means two
policies fire on every matching event forever.

### 3.4 Present the extraction before enforcing

Show the table — rule → class → action — before writing a batch. Turning a page of prose
into enforcement changes what the user's agents are allowed to do everywhere in the
project; that is a decision they confirm, not a side effect (§1.4 discipline).

The table is **not optional and not summarizable into prose**: even when the user
explicitly asked you to enforce the file, your report opens with the table. It is the one
artifact that lets them audit your classification at a glance — prose bullets hide a
misclassified rule; a table row does not.

### 3.5 Author and verify

Route the uncovered enforceable subset through §2. In each generated file, cite provenance
so the policy can be traced back and re-synced when the md changes:

```js
// derived-from: CLAUDE.md § "Workflow rules" — "Never push a branch that is
// missing commits from main" (extracted 2026-07-24)
```

### 3.6 Report the honest split

End with four lists: **enforced now** (new policies + enabled builtins), **already
covered** (by what), **nudged** (instruct-only), **left as prose** (and why). A rules file
never converts 100%. Claiming it does means something above was misclassified.

---

## 4. Reference files

| File | Read it when |
|---|---|
| `references/api.md` | Writing any policy — types, helpers, context, events |
| `references/builtins.md` | Triaging coverage, or before authoring anything |
| `references/traps.md` | **Always.** Nine documented silent failures |
| `references/patterns.md` | Worked examples per event type |
| `references/rules-files.md` | Enforcing a CLAUDE.md / AGENTS.md (§3) — classification and worked examples |
