# Worked patterns

All examples go in `.failproofai/policies/<something>-policies.mjs` — the filename **must**
end in `policies.mjs`. See `traps.md` §1.

Multiple `customPolicies.add()` calls per file are fine and are the normal way to group
related rules.

---

## Block a Bash command pattern

The workhorse. Seven of the eight audit detectors are Bash-command patterns, so this shape
covers most Bucket C findings.

```js
import { customPolicies, allow, deny } from "failproofai";

const NO_VERIFY_RE = /\bgit\s+commit\b[^\n]*\s(--no-verify|-n)\b/;

customPolicies.add({
  name: "block-commit-no-verify",
  description: "Block git commit --no-verify, which skips pre-commit hooks",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const command = String(ctx.toolInput?.command ?? "");
    if (!NO_VERIFY_RE.test(command)) return allow();
    return deny(
      "git commit --no-verify skips the pre-commit hooks. Run the checks, or commit without the flag.",
    );
  },
});
```

Points that matter:
- Return `allow()` early for tools you do not handle. A policy that only cares about Bash
  still runs on every `PreToolUse`.
- Coerce with `String(... ?? "")`. `toolInput` is `Record<string, unknown>`.
- Write the `reason` as an instruction to the agent, not just a complaint. It is what the
  agent reads next, so tell it what to do instead.

## Block by file path

```js
import { customPolicies, allow, deny } from "failproofai";

customPolicies.add({
  name: "block-lockfile-edits",
  description: "Lockfiles are generated — block hand-edits",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = String(ctx.toolInput?.file_path ?? "");
    if (!/\b(bun\.lock|package-lock\.json|yarn\.lock)$/.test(path)) return allow();
    return deny("Lockfiles are generated. Run the package manager instead of editing by hand.");
  },
});
```

`file_path` is canonical across all 11 CLIs — the per-CLI input maps normalize Copilot's
`path`, Hermes's `path`, etc. before your policy sees it.

## Three modes — pick one deliberately

failproofai is not only a blocker. The builtins split three ways, and the name prefix
signals which:

| Prefix | Helper | Effect | Use when |
|---|---|---|---|
| `block-*` (17) | `deny()` | action never runs | irreversible or unsafe, no legitimate case |
| `warn-*` (10) | `instruct()` | action runs; agent told to check with the human first | risky but sometimes correct — needs a human, not a wall |
| `sanitize-*` (5) | raw deny object | output **blocked** before the model sees it (`message` is inert — traps.md §9) | secrets in tool output |

Name your policy with the matching prefix. A reader should know the mode from the name.

Most requests that sound like "block X" are really `warn-*`. Blocking something with a
legitimate use just teaches people to disable the policy.

## Oversight — stop and confirm with the human

The `warn-*` builtins share one voice, and it is worth copying exactly. They do **not** nudge
toward a better tool — they halt the agent and hand the decision back to the person:

> **STOP:** This command permanently deletes stashed changes (git stash drop/clear). Stash
> entries cannot be recovered after deletion. Confirm with the user before executing.

Three parts: **STOP:** + what the command actually does + *Confirm with the user before
executing.* The middle part explains why it matters, so the human can decide in one read.

```js
import { customPolicies, allow, instruct } from "failproofai";

const PROD_DEPLOY_RE = /\b(kubectl\s+apply|helm\s+upgrade|serverless\s+deploy)\b[^\n]*\bprod/;

customPolicies.add({
  name: "warn-prod-deploy",
  description: "Require human confirmation before a production deploy",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const command = String(ctx.toolInput?.command ?? "");
    if (!PROD_DEPLOY_RE.test(command)) return allow();
    return instruct(
      "STOP: This command deploys to production. It affects live traffic and is not " +
        "trivially reversible. Confirm with the user before executing.",
    );
  },
});
```

This is the mode to reach for when the answer to "should this ever be allowed?" is
"sometimes, and a human should decide."

**Caveat:** `instruct` reaches the model properly on Claude Code, Devin and Antigravity. On
Hermes, Goose, OpenClaw and Pi it degrades to a stderr note the agent never sees — so on
those, oversight silently becomes no oversight. If the policy must hold everywhere, use
`deny()` with a reason explaining how to proceed.

## Nudge toward a better tool

The other use of `instruct()` — the action is not dangerous, just wasteful. No "STOP", no
human needed, just a better way to do it.

```js
import { customPolicies, allow, instruct } from "failproofai";

customPolicies.add({
  name: "prefer-read-over-cat",
  description: "Nudge toward the Read tool instead of shelling out to cat",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const command = String(ctx.toolInput?.command ?? "").trim();
    if (!/^(cat|head|tail|less|more)\s+\S+$/.test(command)) return allow();
    return instruct("Use the Read tool for single files — it is cheaper and gives line numbers.");
  },
});
```

Caveat: `instruct` only injects properly on Claude Code, Devin and Antigravity. On Hermes,
Goose, OpenClaw and Pi it degrades to a stderr note. Fine for a local skill.

## Sanitize tool output

**Check the builtin param first:** `sanitize-api-keys` takes `additionalPatterns`
(`[{regex, label}]`), which covers most "scrub token X from output" requests with a config
edit and no code. Author a custom sanitizer only when that param can't express the need.

**Know what sanitize actually does today:** the evaluator never consumes
`PolicyResult.message` (`traps.md` §9), so a sanitize deny **blocks the whole output** —
the model sees the block reason, not a redacted version. The secret stays protected; the
rest of that output is lost with it. Setting `message` anyway is harmless future-proofing,
and requires the raw object literal — the `deny()` helper cannot set it.

```js
import { customPolicies, allow } from "failproofai";

const INTERNAL_URL_RE = /https:\/\/[a-z0-9-]+\.internal\.example\.com\/\S*/gi;

customPolicies.add({
  name: "sanitize-internal-urls",
  description: "Strip internal hostnames from tool output",
  match: { events: ["PostToolUse"] },
  fn: async (ctx) => {
    if (!INTERNAL_URL_RE.test(JSON.stringify(ctx.payload))) return allow();
    return {
      decision: "deny",
      reason: "Internal URL detected in tool output",
      message: "[REDACTED: internal URL removed by failproofai]",
    };
  },
});
```

Note `INTERNAL_URL_RE` has the `g` flag, which makes `.test()` stateful via `lastIndex`.
Either drop `g` or reset `lastIndex` between calls — a classic source of every-other-call
misses.

## Gate the end of a turn

```js
import { customPolicies, allow, deny } from "failproofai";
import { execSync } from "node:child_process";

customPolicies.add({
  name: "require-changelog-entry",
  description: "Every change must touch CHANGELOG.md before the turn ends",
  match: { events: ["Stop"] },
  fn: async (ctx) => {
    const cwd = ctx.session?.cwd;
    if (!cwd) return allow();
    try {
      const changed = execSync("git diff --name-only HEAD", { cwd, encoding: "utf8" });
      if (!changed.trim()) return allow();
      if (changed.includes("CHANGELOG.md")) return allow();
      return deny("Add a CHANGELOG.md entry under the current version heading before finishing.");
    } catch {
      return allow();
    }
  },
});
```

**Stop policies are the dangerous kind.** A deny forces the agent to take another turn. If
the condition can never be satisfied in the current environment, it loops. Always:

- wrap external calls in `try/catch` and `return allow()` on failure (fail-open)
- return `allow()` when there is nothing to check
- confirm the condition is actually reachable — this is exactly how the
  `require-push-before-stop` loop happened in this repo (`traps.md` §6)

Also mind the **10-second timeout**. A `Stop` policy shelling out to `gh` or the network can
blow it, and a timeout silently becomes `allow()`.

## Configuration values

`ctx.params` is always `{}` for custom policies (`traps.md` §8). Use module constants:

```js
const PROTECTED = ["main", "master", "release"];
```

Or read your own file inside `fn` if the values need to change without a code edit.
