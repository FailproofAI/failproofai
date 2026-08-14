# examples/

## What this is

Sample custom policy files for **the CLI** — the enforcement half (`src/hooks/`). Each file
imports `customPolicies`, `allow`, `deny`, `instruct` from `failproofai` and registers policies
that the hook handler evaluates when an agent CLI fires an event. They are copy-paste starting
points for users, not code the product runs on its own.

| File | Demonstrates |
|------|--------------|
| `policies-basic.js` | Four starter policies: production-path writes, `git push --force`, `curl \| bash`, bare `npm install` |
| `policies-advanced/index.js` + `utils.js` | Transitive local import (the loader rewrites `./utils.js`), async `fn`, `ctx.session`, PostToolUse, Stop |
| `policies-stop.js` | A Stop gate that blocks finishing with uncommitted git changes |
| `policies-notification.js` | Notification + SessionEnd forwarded to a Slack webhook (`SLACK_WEBHOOK_URL`) |
| `convention-policies/*.mjs` | Auto-loaded form — copied into `.failproofai/policies/`, no flag needed |

## Who consumes it

End users, by path: `failproofai policies --install --custom ./examples/policies-basic.js`, or
`cp examples/convention-policies/*.mjs .failproofai/policies/`. `docs/custom-policies.mdx` names
all four of those paths in a table, `docs/examples.mdx` links the directory, and both have 14
machine translations that repeat the paths — so renaming a file here breaks 30+ docs pages.
`__tests__/e2e/hooks/custom-hooks.e2e.test.ts` also loads `policies-basic.js` and
`policies-advanced/index.js` as real fixtures via `customPoliciesPath`.

Gotcha: the header comment in every top-level file still says
`failproofai --install-hooks custom <file>`. That flag no longer exists anywhere in `src/`; the
current command is `failproofai policies --install --custom <file>`.

## Does it ship

No. `examples/` is not in package.json's `files` array, so it never reaches an installed user —
they get these files from GitHub or from the docs site. Nothing installed breaks if the directory
moves; the docs and the e2e fixtures break instead.

## Where its tests live

`__tests__/e2e/hooks/custom-hooks.e2e.test.ts` — run with `bun run test:e2e`.
