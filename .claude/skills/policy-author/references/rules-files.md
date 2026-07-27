# Turning a rules file into enforcement

The full classification guide for SKILL.md §3. The governing idea: **a policy can only
match a tool call.** Every rule must first be translated into "which tool, carrying what
input, in what state" — a rule that cannot be phrased that way cannot be a policy, no
matter how important it is.

## Classification by language cue

| The file says | Class | Enforcement | Mode |
|---|---|---|---|
| "never run X", "do not use X" | hard rule | builtin if one matches, else `block-*` | `deny()` |
| "only use X (not Y)" | hard rule, param-shaped | usually a **parameterized builtin** — check before authoring | `deny()` via builtin |
| "always do X before Y" | workflow gate | PreToolUse on **Y**, checking X happened | `deny()` with instructions |
| "X must accompany Y" (changelog with PR) | workflow gate | PreToolUse on Y's command | `deny()` with instructions |
| "prefer X over Y", "avoid Y" | preference | `warn-*` nudge | `instruct()` |
| "confirm with me before X" | oversight | `warn-*`, STOP voice (`patterns.md`) | `instruct()` |
| "file/config must contain Z" | repo invariant | **a test in the test suite** | not a policy |
| "write clear code", tone, style | judgment | stays prose | not enforceable |

## Worked examples

**"Use bun. Do not use npm/yarn to install deps."** Param-shaped hard rule — the first
candidate is `prefer-package-manager` with params:

```json
{
  "enabledPolicies": ["prefer-package-manager"],
  "policyParams": {
    "prefer-package-manager": { "allowed": ["bun"], "blocked": ["npm", "yarn"] }
  }
}
```

(Remember: params for a policy absent from `enabledPolicies` do nothing — `traps.md` §7.)

**But check the builtin's matching breadth before enabling it.** A builtin can be broader
than the rule. `prefer-package-manager`'s npm matcher is a bare `\bnpm\b`, so with
`blocked: ["npm"]` it also denies `npm pack`, `npm view`, `npm ls` — and if the repo's own
docs mandate one of those (this repo's testing protocol requires `npm pack
--ignore-scripts`), the builtin over-blocks a documented workflow. The test is cheap: run
the repo's own legitimate commands through the hook with the builtin enabled in a sandbox.
If a legitimate use gets denied and no param can carve it out, a scoped custom policy
(match the install-family subcommands only) is the right call — say why in the report,
since it is an exception to builtin-first, not the norm.

**"Every PR must include a CHANGELOG.md update."** Workflow gate. Enforce at the action it
gates — `gh pr create` — not at Stop:

```js
// derived-from: CLAUDE.md § "Changelog" — "Every PR must include an update to
// CHANGELOG.md" (extracted 2026-07-24)
customPolicies.add({
  name: "require-changelog-in-pr",
  description: "gh pr create must not run unless the branch touches CHANGELOG.md",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const command = String(ctx.toolInput?.command ?? "");
    if (!/\bgh\s+pr\s+create\b/.test(command)) return allow();
    const cwd = ctx.session?.cwd;
    if (!cwd) return allow();
    try {
      const changed = execSync("git diff --name-only origin/main...HEAD", {
        cwd, encoding: "utf8", timeout: 5000,
      });
      if (changed.includes("CHANGELOG.md")) return allow();
      return deny("This PR has no CHANGELOG.md entry. Add one under the current version heading, commit it, then create the PR.");
    } catch {
      return allow(); // can't tell -> fail open, never trap the agent
    }
  },
});
```

Why PreToolUse-on-the-action beats a Stop gate for these: the denial lands at the exact
moment of the violation with a precise fix, and there is no retry-loop risk when the
condition is unsatisfiable (`traps.md` §6).

**"Configs must use the launcher form / `$CLAUDE_PROJECT_DIR` paths."** Repo invariant —
it describes file *contents*, not agent *behavior*. A policy would have to intercept every
Write and re-parse the config; a unit test reads the file directly and fails CI. Recommend
the test. (This repo's `dogfood-configs.test.ts` is exactly that solution.)

## Extraction discipline

- Quote each rule **verbatim** and keep its section heading — paraphrases drift, and the
  provenance comment needs the exact source.
- One rule can produce two enforcements (a deny AND a nudge for the softer half). One
  enforcement can cover several rules. Do not force 1:1.
- Rules about *people* ("ask the team lead before…") are out of scope — policies gate
  agents, not humans.

## Provenance and drift

Every generated file carries, per rule:

```js
// derived-from: <file> § "<heading>" — "<verbatim quote>" (extracted <date>)
```

When the rules file changes, the comments say which policies to revisit. There is no
automatic sync — say so in the report rather than implying the enforcement tracks the file.

## The honest split

The report ends with four lists — enforced / already covered / nudged / left as prose.
Typical real-world files convert well under half their rules. If your extraction claims
everything became enforceable, the invariants and judgment calls were misclassified, and
the user now believes prose is protection.
