# AGENTS.md — Codex / agent guidance for this repo

This file is read by AI coding agents (Codex, Claude Code, etc.). It duplicates the most
critical rules from CLAUDE.md in a format optimised for agent consumption.

## Non-negotiable rules

1. **Branch must contain all commits from main.** Before every push, run:
   ```bash
   git fetch origin && git log --oneline origin/main ^HEAD
   ```
   If that prints anything, rebase first: `git rebase origin/main`. Never push a branch
   that is missing commits from `main`.

3. **One PR per branch.** Check `gh pr list --head <current-branch>` before creating a PR.
   Push to the existing PR if one already exists.

4. **CI must be green before you stop.** After every push, poll `gh run list --limit 3`
   until all checks complete. Fix failures before proceeding or declaring done.

5. **Never edit a test to make it pass.** Fix the code. Tests may only be changed when the
   test itself is wrong or when the feature under test was intentionally changed.

6. **Always add unit tests for new behaviour.** Place tests in `__tests__/`. Unit tests live
   in `__tests__/hooks/`, e2e tests in `__tests__/e2e/hooks/`.

7. **Docker is available.** Use `oven/bun:latest` with `--network=host` to do clean-install
   end-to-end testing after every non-trivial implementation. See CLAUDE.md for the exact
   Docker test recipe.

## Test commands

```bash
bun run test:run     # unit tests (fast, run first)
bun run test:e2e     # end-to-end hook tests (slower, run before push)
bun run lint         # eslint
bunx tsc --noEmit    # type check
```

## Docker smoke test (run after every change to src/hooks/ or package.json)

```bash
npm pack --ignore-scripts
docker run --rm --network=host \
  -v $(pwd)/failproofai-*.tgz:/pkg.tgz \
  oven/bun:latest bash -c "
    apt-get update -qq && apt-get install -y -qq nodejs npm 2>&1 | tail -2
    npm install -g /pkg.tgz --ignore-scripts 2>&1 | tail -3
    cat > /tmp/tp.mjs << 'EOF'
import { customPolicies, allow } from 'failproofai';
customPolicies.add({ name: 't', description: 't', match: { events: ['PreToolUse'] }, fn: async () => allow() });
EOF
    failproofai p -i -c /tmp/tp.mjs
  "
rm failproofai-*.tgz
```

Expected: `Validated 1 custom hook(s): t`, exit 0.

## Regression checklist

Run through this mentally after any change to `src/hooks/` or `dist/` build:

- [ ] ESM import (`from 'failproofai'`) in custom policy resolves
- [ ] CJS require (`require('failproofai')`) in custom policy resolves  
- [ ] Transitive local imports inside custom policy file work
- [ ] Builtin policies run when no custom file is configured
- [ ] `failproofai p -i -c <nonexistent>` fails gracefully (no crash)
- [ ] `bun run test:run` — all unit tests pass
- [ ] `bun run test:e2e` — all e2e tests pass
- [ ] CI is green

## Key files

| File | Purpose |
|------|---------|
| `src/hooks/loader-utils.ts` | `findDistIndex()`, ESM shim, import rewriting |
| `src/hooks/custom-hooks-loader.ts` | Top-level custom hook loading orchestrator |
| `src/index.ts` | Public API → `dist/index.js` bundle entry |
| `package.json` | `files` must include `dist/`; `build` must build `dist/index.js` |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
